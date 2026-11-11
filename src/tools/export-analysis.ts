import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { op } from "../core/tool-op.js";
import { z } from "zod";
import { assertAllowedLocalRoot, normalizePath, paths } from "../core/local-paths.js";
import { DEFAULT_TIMEOUT_MS } from "../core/process.js";
import { readFile, realpath, stat } from "node:fs/promises";
import { formatRenderedBlock, renderBlockXml } from "../block-render.js";
import { jsonResult, objectRecord, type JsonValue, textResult, truncate } from "../core/results.js";
import { flattenInterfaceMembers } from "../core/simatic-objects.js";
import { parseSimaticXmlText } from "../core/simatic-xml.js";
import {
  currentContextSearchRoots, ensureExecutionModel, executionModelDescriptorsCurrent, executionModelFullyUnderstood,
  executionModelPath, type ExportIndexItem, findExportIndexes, findExportProjectIdentities, loadExecutionModel,
  loadExportIndex, matchPreferredDiscoveredProjectIdentity, MAX_XML_SEARCH_BYTES, readExportProjectIdentity,
  readIndexedXml, readStoredExecutionModel, summarizeIndex
} from "../export-index.js";
import {
  blockDisplay, boundedExecutionSymbolQuery, buildCallGraph, buildFastLookupResult, ensureReferenceIndex,
  extractSymbolsFromIndex, findCalls, findItems, findKnowledgeDefinitions, getBlockRelations, selectBlock
} from "../export-query.js";
import {
  computeSourceSignature, detectProjectProfile, loadReferenceIndex, queryAnalysisNotes, queryReferenceIndex,
  saveAnalysisNote, traceDataFlow
} from "../knowledge.js";
import { readCurrentTiaUiContext } from "../live-session.js";
import { reanalyzeSnapshot } from "../reanalyze-snapshot.js";
import { executeProjectSnapshot } from "../snapshot-workflow.js";
import {
  type ExportProjectIdentity, matchProjectIdentity, resolveBlockMatch, selectCurrentBlock
} from "../tia-ui-context.js";
import { projectExtensions, supportedVersionIds } from "../tia-version.js";

// Export index and analysis tools: current block context, search, symbols, tracing and notes.

export function registerExportAnalysisTools(server: McpServer, ops: { currentBlockLive: (raw: unknown) => Promise<CallToolResult> }) {
  server.registerTool(
    "tia_get_current_ui_context",
    {
      title: "Get Current TIA UI Context",
      description: "Perform one bounded passive observation of the selected TIA Portal version (V20 by default; other supported versions explicitly selectable), exact project and visible editor evidence. Does not attach, click, focus, poll, capture the screen or access a PLC.",
      inputSchema: {
        portalVersion: z.enum(supportedVersionIds()).default("V20"),
        processId: z.number().int().positive().optional().describe("Optional exact TIA process ID. Required when multiple sessions are visible and none is the foreground TIA window."),
        roots: z.array(z.string()).max(20).optional().describe("Optional bounded export roots used only to find exact project-path matches."),
        includeExportMatches: z.boolean().default(true),
        maxExportMatches: z.number().int().min(1).max(100).default(50),
        timeoutMs: z.number().int().min(2_000).max(30_000).default(10_000),
        maxNodes: z.number().int().min(50).max(2_000).default(800),
        maxDepth: z.number().int().min(2).max(12).default(8)
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async ({ portalVersion, processId, roots, includeExportMatches, maxExportMatches, timeoutMs, maxNodes, maxDepth }) => {
      try {
        const observed = await readCurrentTiaUiContext({ portalVersion, processId, timeoutMs, maxNodes, maxDepth });
        const selectedProcess = observed.context.processes.find((candidate) => candidate.processId === observed.context.selectedProcessId) ?? null;
        let exportResolution: JsonValue = {
          status: "not_requested",
          match: null,
          matches: [],
          nameOnlyCandidates: []
        };
        if (includeExportMatches && selectedProcess?.projectPath) {
          const searchRoots = currentContextSearchRoots(roots);
          const identities = await findExportProjectIdentities(searchRoots, maxExportMatches);
          const matched = matchPreferredDiscoveredProjectIdentity({
            projectPath: selectedProcess.projectPath,
            projectName: selectedProcess.projectName
          }, identities);
          exportResolution = {
            ...matched,
            candidatesScanned: identities.length,
            searchLimitReached: identities.length >= maxExportMatches,
            roots: searchRoots
          } as unknown as JsonValue;
        } else if (includeExportMatches) {
          exportResolution = {
            status: "unavailable_without_exact_live_project_path",
            match: null,
            matches: [],
            nameOnlyCandidates: []
          };
        }
        const currentBlock = selectCurrentBlock(observed.context);
        return jsonResult({
          ok: observed.context.status === "selected",
          readOnly: true,
          observedAt: observed.context.observedAt,
          context: observed.context as unknown as JsonValue,
          currentBlock: currentBlock as unknown as JsonValue,
          exportResolution,
          companion: observed.companion as JsonValue,
          guarantees: {
            onDemandOnly: true,
            polling: false,
            screenshotOrVideoCapture: false,
            tiaAttach: false,
            tiaCommandsInvoked: false,
            hoverIdentification: false
          }
        });
      } catch (error) {
        return jsonResult({
          ok: false,
          readOnly: true,
          status: "probe_error",
          error: error instanceof Error ? error.message : String(error),
          currentBlock: { status: "none", source: null, block: null, conflict: false },
          exportResolution: { status: "unavailable", match: null, matches: [], nameOnlyCandidates: [] },
          guarantees: {
            onDemandOnly: true,
            polling: false,
            screenshotOrVideoCapture: false,
            tiaAttach: false,
            tiaCommandsInvoked: false,
            hoverIdentification: false
          }
        });
      }
    }
  );
  const currentBlockExport = op({
        processId: z.number().int().positive().optional(),
        exportDir: z.string().optional().describe("Optional existing export to disambiguate multiple exact snapshots. Its recorded project path must still match the live project."),
        roots: z.array(z.string()).max(20).optional(),
        maxExportMatches: z.number().int().min(1).max(100).default(50),
        timeoutMs: z.number().int().min(2_000).max(30_000).default(10_000),
        maxNodes: z.number().int().min(50).max(2_000).default(800),
        maxDepth: z.number().int().min(2).max(12).default(8),
        includeInterface: z.boolean().default(true),
        includeExistingReferences: z.boolean().default(true),
        limit: z.number().int().min(1).max(300).default(100),
        interfaceLimit: z.number().int().min(1).max(2_000).default(500)
      },
    async ({
      processId,
      exportDir,
      roots,
      maxExportMatches,
      timeoutMs,
      maxNodes,
      maxDepth,
      includeInterface,
      includeExistingReferences,
      limit,
      interfaceLimit
    }) => {
      try {
        const observed = await readCurrentTiaUiContext({ processId, timeoutMs, maxNodes, maxDepth });
        const selectedProcess = observed.context.processes.find((candidate) => candidate.processId === observed.context.selectedProcessId) ?? null;
        const currentBlock = selectCurrentBlock(observed.context);
        if (observed.context.status !== "selected" || !selectedProcess?.projectPath) {
          return jsonResult({
            ok: false,
            readOnly: true,
            status: "live_project_unavailable",
            context: observed.context as unknown as JsonValue,
            currentBlock: currentBlock as unknown as JsonValue,
            reason: "Exactly one current TIA session with an official diagnostic project path is required.",
            guarantees: {
              exportCreatedOrRefreshed: false,
              referenceIndexCreatedOrRefreshed: false,
              projectOrPlcChanged: false,
              hoverIdentification: false
            }
          });
        }
        if (currentBlock.status !== "resolved" || !currentBlock.block) {
          return jsonResult({
            ok: false,
            readOnly: true,
            status: currentBlock.status === "ambiguous" ? "current_block_ambiguous" : "current_block_unavailable",
            context: observed.context as unknown as JsonValue,
            currentBlock: currentBlock as unknown as JsonValue,
            reason: currentBlock.status === "ambiguous"
              ? "The UI surface exposed multiple block candidates; no candidate was selected automatically."
              : "Neither a parseable Project tree selection nor a parseable visible block editor was exposed.",
            guarantees: {
              exportCreatedOrRefreshed: false,
              referenceIndexCreatedOrRefreshed: false,
              projectOrPlcChanged: false,
              hoverIdentification: false
            }
          });
        }

        let identities: ExportProjectIdentity[];
        if (exportDir) {
          const loaded = await loadExportIndex(exportDir);
          identities = [await readExportProjectIdentity(
            loaded.exportDir,
            loaded.indexPath,
            String(loaded.index.generatedAt ?? "")
          )];
        } else {
          identities = await findExportProjectIdentities(currentContextSearchRoots(roots), maxExportMatches);
        }
        const identityResolution = exportDir
          ? matchProjectIdentity({
              projectPath: selectedProcess.projectPath,
              projectName: selectedProcess.projectName
            }, identities)
          : matchPreferredDiscoveredProjectIdentity({
            projectPath: selectedProcess.projectPath,
            projectName: selectedProcess.projectName
          }, identities);
        if (identityResolution.status !== "matched" || !identityResolution.match) {
          return jsonResult({
            ok: false,
            readOnly: true,
            status: `export_${identityResolution.status}`,
            context: observed.context as unknown as JsonValue,
            currentBlock: currentBlock as unknown as JsonValue,
            exportResolution: {
              ...identityResolution,
              candidatesScanned: identities.length,
              searchLimitReached: !exportDir && identities.length >= maxExportMatches
            } as unknown as JsonValue,
            reason: "Rich details require one existing export whose recorded canonical .ap20 path exactly matches the live project. Project name alone is never accepted.",
            guarantees: {
              exportCreatedOrRefreshed: false,
              referenceIndexCreatedOrRefreshed: false,
              projectOrPlcChanged: false,
              hoverIdentification: false
            }
          });
        }

        const loaded = await loadExportIndex(identityResolution.match.exportDir);
        const blockResolution = resolveBlockMatch(currentBlock.block, loaded.index.items ?? []);
        if (blockResolution.status !== "resolved" || !blockResolution.item) {
          return jsonResult({
            ok: false,
            readOnly: true,
            status: `block_${blockResolution.status}`,
            context: observed.context as unknown as JsonValue,
            currentBlock: currentBlock as unknown as JsonValue,
            exportResolution: identityResolution as unknown as JsonValue,
            blockResolution: blockResolution as unknown as JsonValue,
            reason: "The selected/open UI identity did not resolve to exactly one indexed block; no first match was chosen.",
            guarantees: {
              exportCreatedOrRefreshed: false,
              referenceIndexCreatedOrRefreshed: false,
              projectOrPlcChanged: false,
              hoverIdentification: false
            }
          });
        }

        const item = blockResolution.item as ExportIndexItem;
        const relations = getBlockRelations(loaded.index, item);
        let interfaceResult: JsonValue = null;
        if (includeInterface) {
          try {
            const xmlFile = await readIndexedXml(loaded.exportDir, item);
            interfaceResult = {
              ok: true,
              fullPath: xmlFile.fullPath,
              bytes: xmlFile.bytes,
              value: flattenInterfaceMembers(parseSimaticXmlText(xmlFile.text), interfaceLimit)
            } as unknown as JsonValue;
          } catch (error) {
            interfaceResult = {
              ok: false,
              error: error instanceof Error ? error.message : String(error)
            };
          }
        }

        const sourceSignature = computeSourceSignature(loaded.index);
        const existingReferenceIndex = includeExistingReferences
          ? await loadReferenceIndex(loaded.exportDir)
          : null;
        const existingExecutionModel = includeExistingReferences
          ? await loadExecutionModel(loaded.exportDir)
          : null;
        const referenceIndexCurrent = Boolean(existingReferenceIndex && existingReferenceIndex.sourceSignature === sourceSignature);
        const executionDescriptorsCurrent = executionModelDescriptorsCurrent(
          loaded.index,
          existingExecutionModel
        );
        const query = item.kind && item.number ? `${item.kind}${item.number}` : item.name ?? "";
        const existingLookup = includeExistingReferences
          ? await buildFastLookupResult(
              loaded.exportDir,
              loaded.index,
              referenceIndexCurrent ? existingReferenceIndex : null,
              executionDescriptorsCurrent ? existingExecutionModel : null,
              sourceSignature,
              query,
              limit
            )
          : null;

        return jsonResult({
          ok: true,
          readOnly: true,
          status: "resolved",
          context: observed.context as unknown as JsonValue,
          currentBlock: currentBlock as unknown as JsonValue,
          exportResolution: identityResolution as unknown as JsonValue,
          blockResolution: blockResolution as unknown as JsonValue,
          snapshot: {
            exportDir: loaded.exportDir,
            indexPath: loaded.indexPath,
            generatedAt: loaded.index.generatedAt ?? "",
            sourceSignature,
            exactProjectPathMatch: true,
            freshnessAgainstUnsavedTiaEdits: "unverified",
            proofOfPlcRuntimeState: false
          },
          details: {
            item: blockDisplay(item),
            outgoingCalls: relations.outgoingCalls.slice(0, limit),
            incomingCalls: relations.incomingCalls.slice(0, limit),
            sameNumberItems: relations.sameNumberItems.slice(0, limit),
            counts: {
              outgoingCalls: relations.outgoingCalls.length,
              incomingCalls: relations.incomingCalls.length,
              sameNumberItems: relations.sameNumberItems.length
            },
            interface: interfaceResult,
            existingReferenceIndex: {
              requested: includeExistingReferences,
              found: Boolean(existingReferenceIndex),
              current: referenceIndexCurrent,
              rebuilt: false
            },
            existingExecutionModel: {
              requested: includeExistingReferences,
              found: Boolean(existingExecutionModel),
              descriptorsCurrent: executionDescriptorsCurrent,
              reused: executionDescriptorsCurrent
            },
            lookup: existingLookup
          } as unknown as JsonValue,
          guarantees: {
            exportCreatedOrRefreshed: false,
            referenceIndexCreatedOrRefreshed: false,
            projectOrPlcChanged: false,
            hoverIdentification: false
          }
        });
      } catch (error) {
        return jsonResult({
          ok: false,
          readOnly: true,
          status: "details_error",
          error: error instanceof Error ? error.message : String(error),
          guarantees: {
            exportCreatedOrRefreshed: false,
            referenceIndexCreatedOrRefreshed: false,
            projectOrPlcChanged: false,
            hoverIdentification: false
          }
        });
      }
    }
  );
  server.registerTool("tia_reanalyze_snapshot", {
    description: "Verify all current snapshot XML against the manifest, rebuild the execution model offline and publish its analysis under the current-pointer lock.",
    inputSchema: { projectScopeDir: z.string().optional(), exportDir: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, async (args) => jsonResult(await reanalyzeSnapshot(args)));
  server.registerTool(
    "tia_list_export_indexes",
    {
      title: "List TIA Export Indexes",
      description: "List compact export summaries under bounded roots. By default each project scope returns its valid current snapshot, or its latest indexed snapshot with the current-pointer failure reason; historyCount counts all snapshot directories. includeHistory shows all snapshots. Child directories starting with '_' are tool test directories: skipped by default and always excluded from automatic matching; the search root itself is exempt. _codex_index is always skipped. omitted counts collapsed history snapshots, skipped test directories, project-filtered entries, and matching entries beyond maxResults; project filters run before maxResults. Explicit listing never makes an invalid or historical snapshot eligible for automatic matching.",
      inputSchema: {
        roots: z.array(z.string()).optional(),
        includeHistory: z.boolean().default(false),
        includeTestSnapshots: z.boolean().default(false),
        projectName: z.string().optional().describe("Case-insensitive substring of summary.projectName."),
        projectPath: z.string().optional().describe("Exact summary.projectPath after path normalization (case-insensitive on this Windows server)."),
        maxResults: z.number().int().min(1).max(100).default(25)
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async ({ roots, maxResults, includeHistory, includeTestSnapshots, projectName, projectPath }) => {
      const searchRoots = currentContextSearchRoots(roots);
      const result = await findExportIndexes(searchRoots, maxResults, { includeHistory, includeTestSnapshots, projectName, projectPath });
      return jsonResult({ roots: searchRoots as JsonValue, ...result });
    }
  );
  server.registerTool(
    "tia_export_project_index",
    {
      title: "Export TIA Project Index",
      description: "Create one exact-session snapshot of every PLC block, PLC type/UDT, and complete tag table with the official TIA Openness export APIs, then build the existing offline index and execution model. Hardware/network/HMI objects are outside this program-source snapshot. It never modifies, saves, compiles, or downloads the project.",
      inputSchema: {
        projectPath: z.string().describe(`Required exact project path (${projectExtensions("snapshot_export").join(", ")}). Selects the matching API without fallback.`),
        processId: z.number().int().positive().optional().describe("Optional exact running Portal PID. Required when more than one Portal process is visible."),
        outputRoot: z.string().default(paths.defaultOutputRoot),
        maxLockRetries: z.number().int().min(0).max(3).default(0).describe("Legacy compatibility field; ignored by the exact-session snapshot backend."),
        timeoutMs: z.number().int().min(60_000).max(1_800_000).default(DEFAULT_TIMEOUT_MS),
        detail: z.enum(["summary", "full"]).default("summary").describe("Summary returns coverage and call samples and incremental counts. Full includes all execution-model lists."),
        confirmExport: z.literal("EXPORT_TIA_XML_INDEX"),
        confirmPortalAuthorizationReady: z.boolean().default(false),
        reuseUnchanged: z.boolean().default(true).describe("V20: copy objects whose modified state is unchanged from the previous complete snapshot of this project, when no interface, DB, UDT or tag table changed; each copy is SHA-256 checked. false exports everything again.")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    },
    async ({ projectPath, processId, outputRoot, maxLockRetries: _maxLockRetries, timeoutMs, confirmPortalAuthorizationReady, reuseUnchanged, detail }) => {
      return jsonResult(await executeProjectSnapshot({
        processId,
        projectPath,
        outputRoot,
        timeoutMs,
        confirmPortalAuthorizationReady,
        reuseUnchanged, detail
      }));
    }
  );
  server.registerTool(
    "tia_read_export_index",
    {
      title: "Read TIA Export Index",
      description: "Read compact summary metadata from an existing _codex_index/tia-export-index.json. Coverage includes issueCount; includeCoverageIssues explicitly returns the full summary.analysis.coverage.issues array. includeProfile adds the detected PLC family (S7-1200, S7-1500 or unknown) from project evidence.",
      inputSchema: {
        exportDir: z.string(),
        includeItems: z.boolean().default(false),
        includeCalls: z.boolean().default(false),
        includeCoverageIssues: z.boolean().default(false),
        includeProfile: z.boolean().default(false),
        limit: z.number().int().min(1).max(500).default(100)
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async ({ exportDir, includeItems, includeCalls, includeCoverageIssues, includeProfile, limit }) => {
      const loaded = await loadExportIndex(exportDir);
      const summary = summarizeIndex(loaded.index, includeCoverageIssues);
      if (includeCoverageIssues && summary.analysis && !Array.isArray(objectRecord(loaded.index.analysis?.coverage)?.issues)) {
        const model = await readStoredExecutionModel(loaded.exportDir);
        if (!model || model.analyzerVersion !== loaded.index.analysis?.executionAnalyzerVersion ||
            model.coverage.issues.length !== summary.analysis.coverage.issueCount) throw new Error("Matching coverage details unavailable");
        summary.analysis.coverage.issues = model.coverage.issues;
      }
      const response: Record<string, JsonValue> = {
        indexPath: loaded.indexPath,
        summary: summary as JsonValue
      };
      if (includeItems) response.items = (loaded.index.items ?? []).slice(0, limit) as JsonValue;
      if (includeCalls) response.calls = (loaded.index.calls ?? []).slice(0, limit) as JsonValue;
      if (includeProfile) response.profile = await detectProjectProfile(loaded.exportDir, loaded.index) as unknown as JsonValue;
      return jsonResult(response);
    }
  );
  const searchInventory = op({
        exportDir: z.string(),
        query: z.string().default(""),
        limit: z.number().int().min(1).max(200).default(50)
      },
    async ({ exportDir, query, limit }) => {
      const { indexPath, index } = await loadExportIndex(exportDir);
      return jsonResult({
        indexPath,
        query,
        items: findItems(index, query, limit) as JsonValue,
        calls: findCalls(index, query, limit) as JsonValue
      });
    }
  );
  const readBlockXml = op({
        exportDir: z.string(),
        name: z.string().optional(),
        number: z.string().optional(),
        relativePath: z.string().optional(),
        maxChars: z.number().int().min(1000).max(250000).default(60000)
      },
    async ({ exportDir, name, number, relativePath, maxChars }) => {
      const { exportDir: resolvedExportDir, index } = await loadExportIndex(exportDir);
      const item = selectBlock(index, { name, number, relativePath });
      if (!item) {
        return jsonResult({ ok: false, error: "Block not found", name: name ?? "", number: number ?? "", relativePath: relativePath ?? "" });
      }

      const xmlFile = await readIndexedXml(resolvedExportDir, item, Math.max(maxChars * 2, MAX_XML_SEARCH_BYTES));
      const clipped = truncate(xmlFile.text, maxChars);
      return jsonResult({
        ok: true,
        item: item as JsonValue,
        fullPath: xmlFile.fullPath,
        bytes: xmlFile.bytes,
        truncated: clipped.truncated,
        xml: clipped.text
      });
    }
  );
  const readBlockText = op({
        exportDir: z.string().optional(),
        name: z.string().optional(),
        number: z.string().optional(),
        relativePath: z.string().optional(),
        xmlPath: z.string().optional().describe("A single Simatic ML file to read instead of an indexed block."),
        networks: z.array(z.number().int().min(1)).max(200).optional().describe("Only these network numbers."),
        includeInterface: z.boolean().default(true),
        includeComments: z.boolean().default(true),
        maxChars: z.number().int().min(1000).max(250000).default(40000)
      },
    async ({ exportDir, name, number, relativePath, xmlPath, networks, includeInterface, includeComments, maxChars }) => {
      let xmlText: string;
      let source: string;
      if (xmlPath) {
        if (!/\.xml$/i.test(xmlPath)) return jsonResult({ ok: false, error: "xmlPath must be a .xml file" });
        assertAllowedLocalRoot(normalizePath(xmlPath), "Block XML path");
        const full = await realpath(xmlPath);
        assertAllowedLocalRoot(full, "Block XML path");
        const info = await stat(full);
        if (!info.isFile() || info.size > MAX_XML_SEARCH_BYTES) return jsonResult({ ok: false, error: "xmlPath is not a readable XML file within the size limit", xmlPath: full });
        xmlText = await readFile(full, "utf8");
        source = full;
      } else {
        if (!exportDir) return jsonResult({ ok: false, error: "Give exportDir with name/number/relativePath, or xmlPath" });
        const { exportDir: resolvedExportDir, index } = await loadExportIndex(exportDir);
        const item = selectBlock(index, { name, number, relativePath });
        if (!item) return jsonResult({ ok: false, error: "Block not found", name: name ?? "", number: number ?? "", relativePath: relativePath ?? "" });
        const xmlFile = await readIndexedXml(resolvedExportDir, item);
        xmlText = xmlFile.text;
        source = xmlFile.fullPath;
      }
      let rendered;
      try {
        rendered = renderBlockXml(xmlText);
      } catch (error) {
        return jsonResult({ ok: false, error: error instanceof Error ? error.message : String(error), source });
      }
      const text = formatRenderedBlock(rendered, { networks, includeInterface, includeComments });
      const clipped = truncate(text, maxChars);
      const notRendered = rendered.networks.filter((n) => !n.supported).map((n) => ({ network: n.network, language: n.language, xmlLine: n.xmlLine }));
      const footer = clipped.truncated ? `\n… truncated at ${maxChars} chars; ask for fewer networks.` : "";
      // Clients that show structuredContent instead of the text block (Claude Code does)
      // must still get the rendering, so it is part of the structured result too.
      return textResult(`${clipped.text}${footer}\n\n(source: ${source})`, {
        ok: true,
        text: `${clipped.text}${footer}`,
        source,
        objectType: rendered.objectType,
        name: rendered.name,
        number: rendered.number,
        networkCount: rendered.networks.length,
        notRendered: notRendered as JsonValue,
        xmlChars: xmlText.length,
        textChars: clipped.text.length,
        truncated: clipped.truncated
      });
    }
  );
  const readBlockContext = op({
        exportDir: z.string(),
        name: z.string().optional(),
        number: z.string().optional(),
        relativePath: z.string().optional(),
        limit: z.number().int().min(1).max(300).default(100)
      },
    async ({ exportDir, name, number, relativePath, limit }) => {
      const { indexPath, index } = await loadExportIndex(exportDir);
      const item = selectBlock(index, { name, number, relativePath });
      if (!item) {
        return jsonResult({ ok: false, error: "Block not found", name: name ?? "", number: number ?? "", relativePath: relativePath ?? "" });
      }
      const relations = getBlockRelations(index, item);
      return jsonResult({
        ok: true,
        indexPath,
        item: blockDisplay(item) as JsonValue,
        outgoingCalls: relations.outgoingCalls.slice(0, limit) as JsonValue,
        incomingCalls: relations.incomingCalls.slice(0, limit) as JsonValue,
        sameNumberItems: relations.sameNumberItems.slice(0, limit) as JsonValue,
        counts: {
          outgoingCalls: relations.outgoingCalls.length,
          incomingCalls: relations.incomingCalls.length,
          sameNumberItems: relations.sameNumberItems.length
        }
      });
    }
  );
  const callGraph = op({
        exportDir: z.string(),
        name: z.string().optional(),
        number: z.string().optional(),
        relativePath: z.string().optional(),
        direction: z.enum(["downstream", "upstream", "both"]).default("downstream"),
        maxDepth: z.number().int().min(1).max(8).default(2),
        maxEdges: z.number().int().min(1).max(1000).default(250)
      },
    async ({ exportDir, name, number, relativePath, direction, maxDepth, maxEdges }) => {
      const { indexPath, index } = await loadExportIndex(exportDir);
      const item = selectBlock(index, { name, number, relativePath });
      if (!item) {
        return jsonResult({ ok: false, error: "Block not found", name: name ?? "", number: number ?? "", relativePath: relativePath ?? "" });
      }
      return jsonResult({
        ok: true,
        indexPath,
        graph: buildCallGraph(index, item, direction, maxDepth, maxEdges) as JsonValue
      });
    }
  );
  const entryPoints = op({
        exportDir: z.string(),
        limitPerEntry: z.number().int().min(1).max(200).default(100)
      },
    async ({ exportDir, limitPerEntry }) => {
      const { indexPath, index } = await loadExportIndex(exportDir);
      const entryItems = (index.items ?? []).filter((item) => item.kind === "OB");
      const entries = entryItems.map((item) => {
        const relations = getBlockRelations(index, item);
        return {
          item: blockDisplay(item),
          directCalls: relations.outgoingCalls.slice(0, limitPerEntry),
          directCallCount: relations.outgoingCalls.length
        };
      });
      return jsonResult({
        ok: true,
        indexPath,
        entryCount: entries.length,
        entries: entries as JsonValue
      });
    }
  );
  const readBlockInterface = op({
        exportDir: z.string(),
        name: z.string().optional(),
        number: z.string().optional(),
        relativePath: z.string().optional(),
        limit: z.number().int().min(1).max(2000).default(500)
      },
    async ({ exportDir, name, number, relativePath, limit }) => {
      const { exportDir: resolvedExportDir, indexPath, index } = await loadExportIndex(exportDir);
      const item = selectBlock(index, { name, number, relativePath });
      if (!item) {
        return jsonResult({ ok: false, error: "Block not found", name: name ?? "", number: number ?? "", relativePath: relativePath ?? "" });
      }
      const xmlFile = await readIndexedXml(resolvedExportDir, item);
      const parsed = parseSimaticXmlText(xmlFile.text);
      const iface = flattenInterfaceMembers(parsed, limit);
      return jsonResult({
        ok: true,
        indexPath,
        item: blockDisplay(item) as JsonValue,
        fullPath: xmlFile.fullPath,
        bytes: xmlFile.bytes,
        interface: iface as JsonValue
      });
    }
  );
  const searchSymbols = op({
        exportDir: z.string(),
        scope: z.enum(["all", "blocks", "db", "types", "tags"]).default("all"),
        query: z.string().optional(),
        limit: z.number().int().min(1).max(5000).default(1000),
        maxFiles: z.number().int().min(1).max(300).default(200)
      },
    async ({ exportDir, scope, query, limit, maxFiles }) => {
      const { exportDir: resolvedExportDir, indexPath, index } = await loadExportIndex(exportDir);
      const extracted = await extractSymbolsFromIndex(resolvedExportDir, index, { scope, query, limit, maxFiles });
      return jsonResult({
        ok: true,
        indexPath,
        scope,
        query: query ?? "",
        ...extracted,
        symbols: extracted.symbols as JsonValue
      });
    }
  );
  const searchReferences = op({
        exportDir: z.string(),
        query: z.string().min(1),
        kind: z.enum(["any", "block", "symbol", "tag"]).default("any"),
        includeTextMatches: z.boolean().default(true),
        maxFiles: z.number().int().min(1).max(300).default(150),
        maxMatches: z.number().int().min(1).max(2000).default(500),
        contextChars: z.number().int().min(0).max(300).default(80)
      },
    async ({ exportDir, query, kind, includeTextMatches, maxFiles, maxMatches, contextChars }) => {
      const { exportDir: resolvedExportDir, indexPath, index } = await loadExportIndex(exportDir);
      const matches: Array<Record<string, JsonValue>> = [];
      const lowerQuery = query.toLowerCase();

      if (kind === "any" || kind === "block") {
        for (const call of index.calls ?? []) {
          if (matches.length >= maxMatches) break;
          const haystack = [call.source, call.sourceNumber, call.sourceKind, call.target, call.targetBlockType, call.file].join(" ").toLowerCase();
          if (!haystack.includes(lowerQuery)) continue;
          matches.push({
            matchKind: "callEdge",
            source: call.source ?? "",
            sourceNumber: call.sourceNumber ?? "",
            sourceKind: call.sourceKind ?? "",
            sourceLanguage: call.sourceLanguage ?? "",
            target: call.target ?? "",
            targetBlockType: call.targetBlockType ?? "",
            file: call.file ?? ""
          });
        }
      }

      if ((kind === "any" || kind === "symbol" || kind === "tag") && matches.length < maxMatches) {
        const symbolScope = kind === "tag" ? "tags" : "all";
        const extracted = await extractSymbolsFromIndex(resolvedExportDir, index, {
          scope: symbolScope,
          query,
          limit: maxMatches - matches.length,
          maxFiles
        });
        for (const symbol of extracted.symbols) {
          matches.push({
            matchKind: "symbolDefinition",
            ...symbol
          });
        }
      }

      let filesScannedForText = 0;
      let skippedLargeFiles = 0;
      if (includeTextMatches && kind !== "block" && matches.length < maxMatches) {
        for (const item of index.items ?? []) {
          if (filesScannedForText >= maxFiles || matches.length >= maxMatches) break;
          let xmlFile;
          try {
            xmlFile = await readIndexedXml(resolvedExportDir, item);
          } catch (error) {
            if (String(error).includes("too large")) skippedLargeFiles += 1;
            continue;
          }
          filesScannedForText += 1;
          const haystack = xmlFile.text.toLowerCase();
          let fromIndex = 0;
          while (matches.length < maxMatches) {
            const foundAt = haystack.indexOf(lowerQuery, fromIndex);
            if (foundAt < 0) break;
            const lineNumber = xmlFile.text.slice(0, foundAt).split(/\r?\n/).length;
            const start = Math.max(0, foundAt - contextChars);
            const end = Math.min(xmlFile.text.length, foundAt + query.length + contextChars);
            matches.push({
              matchKind: "xmlText",
              item: blockDisplay(item) as JsonValue,
              fullPath: xmlFile.fullPath,
              lineNumber,
              snippet: xmlFile.text.slice(start, end).replace(/\s+/g, " ").trim()
            });
            fromIndex = foundAt + Math.max(query.length, 1);
          }
        }
      }

      return jsonResult({
        ok: true,
        indexPath,
        query,
        kind,
        includeTextMatches,
        matchCount: matches.length,
        filesScannedForText,
        skippedLargeFiles,
        truncated: matches.length >= maxMatches || filesScannedForText >= maxFiles,
        matches: matches as JsonValue
      });
    }
  );
  server.registerTool(
    "tia_build_reference_index",
    {
      title: "Build TIA Reference Index",
      description: "Build or refresh a persistent project-neutral symbol definition, read/write reference, and data-flow cache from an existing Simatic ML export. It writes only under the export's _codex_index folder and never changes the TIA project or PLC.",
      inputSchema: {
        exportDir: z.string(),
        forceRebuild: z.boolean().default(false)
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    async ({ exportDir, forceRebuild }) => {
      const { exportDir: resolvedExportDir, indexPath, index } = await loadExportIndex(exportDir);
      const built = await ensureReferenceIndex(resolvedExportDir, index, { autoBuild: true, forceRebuild });
      const executionBuilt = await ensureExecutionModel(resolvedExportDir, index, {
        autoBuild: true,
        forceRebuild
      });
      const executionComplete = Boolean(
        executionBuilt.executionModel
        && executionBuilt.executionModel.incremental.pendingBlockKeys.length === 0
        && executionBuilt.xmlReadErrors.length === 0
        && !executionBuilt.xmlByteLimitExceeded
      );
      return jsonResult({
        ok: Boolean(built.referenceIndex && executionComplete),
        status: executionBuilt.xmlByteLimitExceeded
          ? "execution_analysis_incomplete_xml_byte_limit"
          : executionComplete
            ? "complete"
            : "execution_analysis_incomplete",
        indexPath,
        rebuilt: built.rebuilt,
        schemaVersion: built.referenceIndex?.schemaVersion ?? 0,
        analyzerVersion: built.referenceIndex?.analyzerVersion ?? "",
        sourceSignature: built.referenceIndex?.sourceSignature ?? "",
        projectProfile: (built.referenceIndex?.projectProfile ?? null) as unknown as JsonValue,
        counts: (built.referenceIndex?.counts ?? null) as unknown as JsonValue,
        filesIndexed: built.referenceIndex?.filesIndexed ?? 0,
        filesSkipped: built.referenceIndex?.filesSkipped ?? 0,
        parseErrors: (built.referenceIndex?.parseErrors ?? []) as unknown as JsonValue,
        executionModel: executionBuilt.executionModel
          ? {
              path: executionModelPath(resolvedExportDir),
              rebuilt: executionBuilt.rebuilt,
              analyzerVersion: executionBuilt.executionModel.analyzerVersion,
              sourceSignature: executionBuilt.executionModel.sourceSignature,
              blockCount: Object.keys(executionBuilt.executionModel.blocks).length,
              writeSiteCount: executionBuilt.executionModel.writeSites.length,
              callSiteCount: executionBuilt.executionModel.callSites.length,
              coverage: executionBuilt.executionModel.coverage,
              incremental: executionBuilt.executionModel.incremental,
              unresolvedCalls: executionBuilt.executionModel.unresolvedCalls,
              xmlReadErrors: executionBuilt.xmlReadErrors,
              xmlBytesRead: executionBuilt.xmlBytesRead,
              xmlByteLimit: executionBuilt.xmlByteLimit,
              xmlByteLimitExceeded: executionBuilt.xmlByteLimitExceeded,
              fullyUnderstood: executionModelFullyUnderstood(executionBuilt.executionModel)
            } as unknown as JsonValue
          : null
      });
    }
  );
  server.registerTool(
    "tia_trace_symbol",
    {
      title: "Trace TIA Symbol",
      description: "Find symbol definitions, writers, readers, and direct upstream/downstream flows across SCL, LAD/FBD calls, and GRAPH actions. The cache is rebuilt automatically when the export signature changes.",
      inputSchema: {
        exportDir: z.string(),
        query: z.string().min(1),
        match: z.enum(["exact", "suffix", "contains"]).default("suffix"),
        autoBuild: z.boolean().default(true),
        limit: z.number().int().min(1).max(500).default(100)
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    async ({ exportDir, query, match, autoBuild, limit }) => {
      const { exportDir: resolvedExportDir, indexPath, index } = await loadExportIndex(exportDir);
      const ensured = await ensureReferenceIndex(resolvedExportDir, index, { autoBuild });
      const executionEnsured = await ensureExecutionModel(resolvedExportDir, index, { autoBuild });
      if (!ensured.referenceIndex && !executionEnsured.executionModel) {
        return jsonResult({ ok: false, indexPath, error: "Program analysis indexes not found and autoBuild is disabled", stale: ensured.stale });
      }
      const traced = ensured.referenceIndex
        ? queryReferenceIndex(ensured.referenceIndex, query, match, limit)
        : null;
      const definitions = findKnowledgeDefinitions(ensured.referenceIndex, query, limit);
      const execution = executionEnsured.executionModel
        ? boundedExecutionSymbolQuery(executionEnsured.executionModel, query, match, limit)
        : null;
      return jsonResult({
        ok: true,
        indexPath,
        rebuilt: ensured.rebuilt,
        executionRebuilt: executionEnsured.rebuilt,
        stale: ensured.stale,
        projectProfile: (ensured.referenceIndex?.projectProfile ?? await detectProjectProfile(resolvedExportDir, index)) as unknown as JsonValue,
        definitions: definitions as unknown as JsonValue,
        trace: traced as unknown as JsonValue,
        preferredResult: execution ? "execution" : "legacy",
        execution: execution as unknown as JsonValue,
        executionCoverage: (executionEnsured.executionModel?.coverage ?? null) as unknown as JsonValue
      });
    }
  );
  server.registerTool(
    "tia_trace_data_flow",
    {
      title: "Trace TIA Data Flow",
      description: "Recursively trace where a value comes from or where it is used, using evidence-backed SCL assignments, GRAPH actions, and LAD/FBD network flows from a cached S7-1200/S7-1500 export.",
      inputSchema: {
        exportDir: z.string(),
        query: z.string().min(1),
        direction: z.enum(["upstream", "downstream", "both"]).default("upstream"),
        match: z.enum(["exact", "suffix", "contains"]).default("suffix"),
        maxDepth: z.number().int().min(1).max(10).default(4),
        maxNodes: z.number().int().min(2).max(500).default(100),
        autoBuild: z.boolean().default(true)
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    async ({ exportDir, query, direction, match, maxDepth, maxNodes, autoBuild }) => {
      const { exportDir: resolvedExportDir, indexPath, index } = await loadExportIndex(exportDir);
      const ensured = await ensureReferenceIndex(resolvedExportDir, index, { autoBuild });
      const executionEnsured = await ensureExecutionModel(resolvedExportDir, index, { autoBuild });
      if (!ensured.referenceIndex && !executionEnsured.executionModel) {
        return jsonResult({ ok: false, indexPath, error: "Program analysis indexes not found and autoBuild is disabled", stale: ensured.stale });
      }
      const executionQuery = executionEnsured.executionModel
        ? boundedExecutionSymbolQuery(executionEnsured.executionModel, query, match, maxNodes)
        : null;
      const orderedWriteSites = [...(executionQuery?.writes ?? [])]
        .sort((left, right) =>
          left.blockKey.localeCompare(right.blockKey)
          || left.network - right.network
          || left.statementOrder - right.statementOrder
        );
      return jsonResult({
        ok: true,
        indexPath,
        rebuilt: ensured.rebuilt,
        executionRebuilt: executionEnsured.rebuilt,
        stale: ensured.stale,
        projectProfile: (ensured.referenceIndex?.projectProfile ?? await detectProjectProfile(resolvedExportDir, index)) as unknown as JsonValue,
        flow: ensured.referenceIndex
          ? traceDataFlow(ensured.referenceIndex, query, direction, match, maxDepth, maxNodes) as unknown as JsonValue
          : null,
        preferredResult: executionQuery ? "execution" : "legacy",
        execution: executionEnsured.executionModel
          ? {
              query: executionQuery,
              orderedWriteSites,
              guards: orderedWriteSites.map((site) => ({
                siteId: site.siteId,
                guard: site.guard
              })),
              effects: orderedWriteSites.map((site) => ({
                siteId: site.siteId,
                effect: site.effect
              })),
              executionContexts: orderedWriteSites.map((site) => ({
                siteId: site.siteId,
                taskOB: site.taskOB ?? "",
                callPath: site.callPath,
                instancePath: site.instancePath,
                contexts: site.executionContexts
              })),
              unresolvedCalls: executionEnsured.executionModel.unresolvedCalls.slice(0, maxNodes),
              unresolvedCallsTotal: executionEnsured.executionModel.unresolvedCalls.length,
              unresolvedCallsTruncated: executionEnsured.executionModel.unresolvedCalls.length > maxNodes,
              coverage: executionEnsured.executionModel.coverage,
              fullyUnderstood: executionModelFullyUnderstood(executionEnsured.executionModel)
            } as unknown as JsonValue
          : null
      });
    }
  );
  const lookupOne = op({
        exportDir: z.string(),
        query: z.string().min(1),
        autoBuild: z.boolean().default(true),
        limit: z.number().int().min(1).max(200).default(50)
      },
    async ({ exportDir, query, autoBuild, limit }) => {
      const { exportDir: resolvedExportDir, indexPath, index } = await loadExportIndex(exportDir);
      const ensured = await ensureReferenceIndex(resolvedExportDir, index, { autoBuild });
      const executionEnsured = await ensureExecutionModel(resolvedExportDir, index, { autoBuild });
      const sourceSignature = computeSourceSignature(index);
      const lookup = await buildFastLookupResult(
        resolvedExportDir,
        index,
        ensured.referenceIndex,
        executionEnsured.executionModel,
        sourceSignature,
        query,
        limit
      );
      return jsonResult({
        ok: true,
        indexPath,
        rebuilt: ensured.rebuilt,
        executionRebuilt: executionEnsured.rebuilt,
        projectProfile: (ensured.referenceIndex?.projectProfile ?? await detectProjectProfile(resolvedExportDir, index)) as unknown as JsonValue,
        ...lookup
      });
    }
  );
  const lookupMany = op({
        exportDir: z.string(),
        queries: z.array(z.string().min(1)).min(1).max(50),
        autoBuild: z.boolean().default(true),
        limitPerQuery: z.number().int().min(1).max(100).default(20)
      },
    async ({ exportDir, queries, autoBuild, limitPerQuery }) => {
      const { exportDir: resolvedExportDir, indexPath, index } = await loadExportIndex(exportDir);
      const ensured = await ensureReferenceIndex(resolvedExportDir, index, { autoBuild });
      const executionEnsured = await ensureExecutionModel(resolvedExportDir, index, { autoBuild });
      const sourceSignature = computeSourceSignature(index);
      const uniqueQueries = [...new Set(queries.map((query) => query.trim()).filter(Boolean))];
      const results = await Promise.all(uniqueQueries.map((query) => buildFastLookupResult(
        resolvedExportDir,
        index,
        ensured.referenceIndex,
        executionEnsured.executionModel,
        sourceSignature,
        query,
        limitPerQuery
      )));
      return jsonResult({
        ok: true,
        indexPath,
        rebuilt: ensured.rebuilt,
        executionRebuilt: executionEnsured.rebuilt,
        queryCount: uniqueQueries.length,
        projectProfile: (ensured.referenceIndex?.projectProfile ?? await detectProjectProfile(resolvedExportDir, index)) as unknown as JsonValue,
        results: results as unknown as JsonValue
      });
    }
  );
  server.registerTool(
    "tia_save_analysis_note",
    {
      title: "Save TIA Analysis Note",
      description: "Persist an evidence-backed engineering explanation under the export cache so a stronger model can analyze once and later models can reuse it. The note is bound to the current export signature and marked stale after program changes.",
      inputSchema: {
        exportDir: z.string(),
        subject: z.string().min(1).max(300),
        summary: z.string().min(1).max(10_000),
        facts: z.array(z.string().min(1).max(2000)).max(200).default([]),
        evidence: z.array(z.string().min(1).max(2000)).min(1).max(200),
        confidence: z.enum(["verified", "mixed", "inference"]).default("verified")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    async ({ exportDir, subject, summary, facts, evidence, confidence }) => {
      const { exportDir: resolvedExportDir, indexPath, index } = await loadExportIndex(exportDir);
      const saved = await saveAnalysisNote(resolvedExportDir, computeSourceSignature(index), { subject, summary, facts, evidence, confidence });
      return jsonResult({ ok: true, indexPath, note: saved as unknown as JsonValue });
    }
  );
  server.registerTool(
    "tia_search_analysis_notes",
    {
      title: "Search TIA Analysis Notes",
      description: "Search persisted model-authored engineering notes and report whether each note still matches the current export signature.",
      inputSchema: {
        exportDir: z.string(),
        query: z.string().default(""),
        limit: z.number().int().min(1).max(200).default(50)
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async ({ exportDir, query, limit }) => {
      const { exportDir: resolvedExportDir, indexPath, index } = await loadExportIndex(exportDir);
      const notes = await queryAnalysisNotes(resolvedExportDir, computeSourceSignature(index), query, limit);
      return jsonResult({ ok: true, indexPath, ...notes, notes: notes.notes as unknown as JsonValue });
    }
  );
  const searchText = op({
        exportDir: z.string(),
        query: z.string().min(1),
        caseSensitive: z.boolean().default(false),
        maxFiles: z.number().int().min(1).max(200).default(100),
        maxMatches: z.number().int().min(1).max(1000).default(100),
        contextChars: z.number().int().min(0).max(300).default(80)
      },
    async ({ exportDir, query, caseSensitive, maxFiles, maxMatches, contextChars }) => {
      const { exportDir: resolvedExportDir, indexPath, index } = await loadExportIndex(exportDir);
      const needle = caseSensitive ? query : query.toLowerCase();
      const matches: Array<Record<string, JsonValue>> = [];
      let filesScanned = 0;
      let skippedLargeFiles = 0;

      for (const item of index.items ?? []) {
        if (filesScanned >= maxFiles || matches.length >= maxMatches) break;
        let xmlFile;
        try {
          xmlFile = await readIndexedXml(resolvedExportDir, item);
        } catch (error) {
          if (String(error).includes("too large")) skippedLargeFiles += 1;
          continue;
        }
        filesScanned += 1;
        const haystack = caseSensitive ? xmlFile.text : xmlFile.text.toLowerCase();
        let fromIndex = 0;
        while (matches.length < maxMatches) {
          const foundAt = haystack.indexOf(needle, fromIndex);
          if (foundAt < 0) break;
          const lineNumber = xmlFile.text.slice(0, foundAt).split(/\r?\n/).length;
          const start = Math.max(0, foundAt - contextChars);
          const end = Math.min(xmlFile.text.length, foundAt + query.length + contextChars);
          matches.push({
            item: blockDisplay(item) as JsonValue,
            fullPath: xmlFile.fullPath,
            lineNumber,
            snippet: xmlFile.text.slice(start, end).replace(/\s+/g, " ").trim()
          });
          fromIndex = foundAt + Math.max(needle.length, 1);
        }
      }

      return jsonResult({
        ok: true,
        indexPath,
        query,
        caseSensitive,
        filesScanned,
        skippedLargeFiles,
        matchCount: matches.length,
        truncated: filesScanned >= maxFiles || matches.length >= maxMatches,
        matches: matches as JsonValue
      });
    }
  );
  server.registerTool(
    "tia_get_current_block",
    {
      title: "Get Current TIA Block",
      description: "Details of the block currently selected/open in TIA Portal. source=live (default) reads it from the exact running V20 project: official attributes, cross references and, from one temporary block export, interface and program body; nothing is persisted. source=export resolves it through an exactly matching existing export instead: offline metadata, call relations, interface members and existing non-stale reference results; never creates or refreshes an export.",
      inputSchema: {
        source: z.enum(["live", "export"]).default("live"),
        processId: z.number().int().positive().optional(),
        includeInterface: z.boolean().optional().describe("Default true."),
        includeCrossReferences: z.boolean().optional().describe("live only; default true."),
        includeProgramBody: z.boolean().optional().describe("live only; default true."),
        includeRawXml: z.boolean().optional().describe("live only; needs includeProgramBody."),
        maxResults: z.number().int().min(1).max(5_000).optional().describe("live only: cross references returned, default 500."),
        bodyEvidenceLimit: z.number().int().min(1).max(5_000).optional().describe("live only; default 1000."),
        interfaceLimit: z.number().int().min(1).max(5_000).optional().describe("Interface members returned; default 1000 (live) or 500 (export, at most 2000)."),
        exportDir: z.string().optional().describe("export only: disambiguates several exact snapshots."),
        roots: z.array(z.string()).max(20).optional().describe("export only: bounded export roots to search."),
        includeExistingReferences: z.boolean().optional().describe("export only; default true."),
        limit: z.number().int().min(1).max(300).optional().describe("export only: call relations returned, default 100."),
        timeoutMs: z.number().int().min(3_000).max(60_000).optional().describe("Default 20000 (live) or 10000 (export, at most 30000).")
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async (args) => args.source === "export" ? currentBlockExport(args) : ops.currentBlockLive(args)
  );
  server.registerTool(
    "tia_read_block",
    {
      title: "Read TIA Block",
      description: "Read one exported block, DB, UDT or tag table. Give exportDir with name/number/relativePath; view=text also accepts xmlPath for a single Simatic ML file such as an import candidate. Views: text (default) is compact text, the interface then one line per coil, assignment, instruction box or block call in each network (LAD/FBD), or the SCL source, with every instruction box shown including GET/PUT/MOVE; xml is the raw exported XML, only needed to prepare an import; interface is the flattened interface/member table; context is the metadata, direct callers, direct callees and same-number companion objects.",
      inputSchema: {
        exportDir: z.string().optional(),
        name: z.string().optional(),
        number: z.string().optional(),
        relativePath: z.string().optional(),
        xmlPath: z.string().optional().describe("view=text only: a single Simatic ML file instead of an indexed block."),
        view: z.enum(["text", "xml", "interface", "context"]).default("text"),
        networks: z.array(z.number().int().min(1)).max(200).optional().describe("text: only these network numbers."),
        includeInterface: z.boolean().optional().describe("text; default true."),
        includeComments: z.boolean().optional().describe("text; default true."),
        maxChars: z.number().int().min(1000).max(250000).optional().describe("Default 40000 (text) or 60000 (xml)."),
        limit: z.number().int().min(1).max(2000).optional().describe("interface members (default 500) or context relations (default 100, at most 300).")
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async (args) => args.view === "xml" ? readBlockXml(args)
      : args.view === "interface" ? readBlockInterface(args)
      : args.view === "context" ? readBlockContext(args)
      : readBlockText(args)
  );
  server.registerTool(
    "tia_search_export",
    {
      title: "Search TIA Export",
      description: "Search one export index; bounded and read-only. in=text (default): plain-text search across the indexed XML files. in=inventory: block/type/tag names and call edges. in=symbols: symbol table from block interfaces, DB members and PLC tag tables, filtered by scope and query. in=references: call edges, symbol/tag definitions and XML text matches for the query together, filtered by kind.",
      inputSchema: {
        exportDir: z.string(),
        query: z.string().default("").describe("Required for text and references; empty lists everything for inventory and symbols."),
        in: z.enum(["text", "inventory", "symbols", "references"]).default("text"),
        caseSensitive: z.boolean().optional().describe("text; default false."),
        scope: z.enum(["all", "blocks", "db", "types", "tags"]).optional().describe("symbols; default all."),
        kind: z.enum(["any", "block", "symbol", "tag"]).optional().describe("references; default any."),
        includeTextMatches: z.boolean().optional().describe("references; default true."),
        limit: z.number().int().min(1).max(5000).optional().describe("Matches returned. Default 100 text (at most 1000), 50 inventory (200), 1000 symbols (5000), 500 references (2000)."),
        maxFiles: z.number().int().min(1).max(300).optional().describe("XML files scanned; default 100 text (at most 200), 200 symbols, 150 references."),
        contextChars: z.number().int().min(0).max(300).optional().describe("text and references; default 80.")
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async (args) => args.in === "inventory" ? searchInventory(args)
      : args.in === "symbols" ? searchSymbols({ ...args, query: args.query || undefined })
      : args.in === "references" ? searchReferences({ ...args, maxMatches: args.limit })
      : searchText({ ...args, maxMatches: args.limit })
  );
  server.registerTool(
    "tia_trace_call_graph",
    {
      title: "Trace TIA Call Graph",
      description: "Walk downstream, upstream or both directions through indexed call edges from one block. Without name/number/relativePath it lists the OB entry blocks and their direct calls instead.",
      inputSchema: {
        exportDir: z.string(),
        name: z.string().optional(),
        number: z.string().optional(),
        relativePath: z.string().optional(),
        direction: z.enum(["downstream", "upstream", "both"]).optional().describe("Default downstream."),
        maxDepth: z.number().int().min(1).max(8).optional().describe("Default 2."),
        maxEdges: z.number().int().min(1).max(1000).optional().describe("Default 250; for the entry list, direct calls per OB (default 100, at most 200).")
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async (args) => args.name || args.number || args.relativePath ? callGraph(args) : entryPoints({ exportDir: args.exportDir, limitPerEntry: args.maxEdges })
  );
  server.registerTool(
    "tia_fast_lookup",
    {
      title: "Fast TIA Program Lookup",
      description: "One-call lookup across block inventory, call edges, persistent symbol definitions, read/write references, data flows and saved engineering notes for an indexed S7-1200/S7-1500 export. query is one string, or up to 50 strings (block aliases, symbols, addresses) resolved together in a single cached call.",
      inputSchema: {
        exportDir: z.string(),
        query: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(50)]),
        autoBuild: z.boolean().optional().describe("Default true."),
        limit: z.number().int().min(1).max(200).optional().describe("Per query. Default 50 for one query, 20 for several (at most 100).")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    async (args) => Array.isArray(args.query)
      ? lookupMany({ ...args, queries: args.query, limitPerQuery: args.limit })
      : lookupOne(args)
  );
}
