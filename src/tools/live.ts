import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonResult, type JsonValue, objectRecord } from "../core/results.js";
import { op } from "../core/tool-op.js";
import { extractSimaticObject } from "../core/simatic-objects.js";
import { parseSimaticXmlText, scalarString } from "../core/simatic-xml.js";
import { type EngineeringObservation, inspectEngineering } from "../engineering-diagnostics.js";
import {
  assertLiveCoreSession, attachExactLiveSession, type LiveBatchQueryItem, liveBlockXmlText, liveCoreOptions,
  liveStructuredResult, liveToolOutputSchema, mergeLiveCompleteness, parseLiveBlockXml, programAnalysisCache,
  queryExactLiveBatch, queryExactLiveObject, readPreparedLiveSession, remainingTimeMs, resolveExactLiveSession,
  resolvePreparedLiveQuerySession, runAccessibleNetworkNavigation, withoutBlockXmlPayload
} from "../live-session.js";
import { graphContext } from "../program-evidence.js";
import { queryTiaLiveCore, type TiaLiveObjectIdentity, type TiaLiveResourceKind } from "../tia-live-core.js";
import { selectCurrentBlock } from "../tia-ui-context.js";

// Live-session tools: prepare, query, batch, graph context and navigation.

export function registerLiveTools(server: McpServer) {
  server.registerTool(
    "tia_inspect_engineering",
    {
      title: "Inspect TIA Hardware, Network and HMI",
      description: "Read a bounded hardware/network/HMI/PLC-tag observation from an already prepared exact V20 session and report evidence-backed configuration diagnostics. Includes exposed HMI tags, connections and Unified alarms; classic HMI alarms are explicitly unsupported when not exposed. Never compiles, exports files, changes a project or contacts a PLC.",
      inputSchema: {
        processId: z.number().int().positive(),
        includeScreens: z.boolean().default(false),
        maxObjects: z.number().int().min(1).max(20_000).default(5_000),
        timeoutMs: z.number().int().min(3_000).max(60_000).default(30_000)
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async ({ processId, includeScreens, maxObjects, timeoutMs }) => {
      try {
        const deadline = Date.now() + timeoutMs;
        const live = await resolvePreparedLiveQuerySession({ processId, timeoutMs, maxNodes: 800, maxDepth: 8 });
        if (!live.ok) return jsonResult({ ok: false, readOnly: true, status: live.status, reason: live.reason });
        const observationTimeoutMs = remainingTimeMs(deadline, "engineering observation", 1_000);
        const core = await queryTiaLiveCore({
          operation: "read_engineering", processId: live.processId,
          processStartTimeUtc: live.processStartTimeUtc, projectPath: live.projectPath,
          includeScreens, maxObjects,
          timeoutMs: observationTimeoutMs
        }, liveCoreOptions(observationTimeoutMs));
        if (!core.ok) return jsonResult(core as unknown as Record<string, JsonValue>);
        assertLiveCoreSession(core, live.processId, live.projectPath, live.processStartTimeUtc);
        const observation = core.engineering as EngineeringObservation;
        if (!observation || !Array.isArray(observation.records) || !Array.isArray(observation.issues))
          throw new Error("The native reader returned an invalid engineering observation.");
        return jsonResult({
          ok: true, readOnly: true, status: core.status,
          exactLiveIdentity: { processId: live.processId, projectPath: live.projectPath, processStartTimeUtc: live.processStartTimeUtc },
          engineering: core.engineering as JsonValue,
          diagnostics: inspectEngineering(observation) as unknown as JsonValue
        });
      } catch (error) {
        return jsonResult({ ok: false, readOnly: true, status: "engineering_read_error", error: error instanceof Error ? error.message : String(error) });
      }
    }
  );
  server.registerTool(
    "tia_prepare_live_session",
    {
      title: "Prepare Exact TIA Live Session",
      description: "Prepare one exact resident read-only Openness session without enumerating project objects. A cold session first returns an explicit Portal-authorization check; call again only after the user has Portal visible and is ready to approve the Siemens access prompt.",
      inputSchema: {
        processId: z.number().int().positive().optional(),
        confirmPortalAuthorizationReady: z.boolean().default(false),
        timeoutMs: z.number().int().min(3_000).max(60_000).default(20_000),
        maxNodes: z.number().int().min(50).max(2_000).default(800),
        maxDepth: z.number().int().min(2).max(12).default(8)
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async ({ processId, confirmPortalAuthorizationReady, timeoutMs, maxNodes, maxDepth }) => {
      let portalMinimized = false;
      try {
        const deadline = Date.now() + timeoutMs;
        const live = await resolveExactLiveSession({
          processId,
          timeoutMs: remainingTimeMs(deadline, "current UI-context read", 1_000),
          maxNodes,
          maxDepth
        });
        portalMinimized = live.selectedProcess?.isMinimized === true;
        if (!live.ok) {
          return jsonResult({
            ok: false,
            readOnly: true,
            status: live.status,
            reason: live.reason,
            context: live.observed.context as unknown as JsonValue
          });
        }
        const prepared = await readPreparedLiveSession({
          processId: live.processId,
          timeoutMs: Math.min(remainingTimeMs(deadline, "resident session status", 1_000), 5_000),
          expectedProjectPath: live.projectPath,
          expectedProcessStartTimeUtc: live.processStartTimeUtc
        });
        if (!prepared.ok && !confirmPortalAuthorizationReady) {
          return jsonResult({
            ok: false,
            readOnly: true,
            status: "portal_authorization_check_required",
            requiresUserAction: true,
            reason: "Bring TIA Portal to the foreground. The next confirmed call may show a Siemens Openness access prompt; approve it in Portal.",
            exactLiveIdentity: {
              processId: live.processId,
              processStartTimeUtc: live.processStartTimeUtc,
              projectPath: live.projectPath
            },
            portalMinimized,
            attachAttempted: false,
            nextCall: {
              tool: "tia_prepare_live_session",
              confirmPortalAuthorizationReady: true
            },
            guarantees: {
              projectModified: false,
              plcAccessed: false
            }
          });
        }
        if (!prepared.ok && portalMinimized) {
          return jsonResult({
            ok: false,
            readOnly: true,
            status: "portal_must_be_visible_for_authorization",
            requiresUserAction: true,
            reason: "Restore TIA Portal before starting a cold Openness attach so the Siemens authorization prompt cannot be hidden.",
            attachAttempted: false,
            guarantees: {
              projectModified: false,
              plcAccessed: false
            }
          });
        }
        const core = await attachExactLiveSession({
          processId: live.processId,
          processStartTimeUtc: live.processStartTimeUtc,
          projectPath: live.projectPath,
          timeoutMs: remainingTimeMs(deadline, "Openness attach", 1_000)
        });
        return jsonResult({
          ...core,
          readOnly: true,
          exactLiveIdentity: {
            processId: live.processId,
            processStartTimeUtc: live.processStartTimeUtc,
            projectPath: live.projectPath
          },
          portalMinimized,
          inventoryEnumerated: false,
          guarantees: {
            exactPidProcessStartAndCanonicalProjectPathRequired: true,
            projectOpenedClosedSavedOrCompiled: false,
            projectModified: false,
            plcAccessed: false
          }
        } as Record<string, JsonValue>);
      } catch (error) {
        return jsonResult({
          ok: false,
          readOnly: true,
          status: "live_session_attach_error",
          error: error instanceof Error ? error.message : String(error),
          portalMinimized,
          likelyAction: portalMinimized
            ? "Restore TIA Portal and respond to any Siemens Openness authorization dialog, then retry this same bounded attach."
            : "Check Siemens TIA Openness authorization/group membership, then retry the exact bounded attach.",
          guarantees: {
            projectModified: false,
            plcAccessed: false
          }
        });
      }
    }
  );
  const currentBlockLive = op({
        processId: z.number().int().positive().optional(),
        timeoutMs: z.number().int().min(3_000).max(60_000).default(20_000),
        maxNodes: z.number().int().min(50).max(2_000).default(800),
        maxDepth: z.number().int().min(2).max(12).default(8),
        includeCrossReferences: z.boolean().default(true),
        includeInterface: z.boolean().default(true),
        includeProgramBody: z.boolean().default(true),
        includeRawXml: z.boolean().default(false),
        maxResults: z.number().int().min(1).max(5_000).default(500),
        interfaceLimit: z.number().int().min(1).max(5_000).default(1_000),
        bodyEvidenceLimit: z.number().int().min(1).max(5_000).default(1_000),
        maxXmlBytes: z.number().int().min(100_000).max(25_000_000).default(15_000_000)
      },
    async ({
      processId,
      timeoutMs,
      maxNodes,
      maxDepth,
      includeCrossReferences,
      includeInterface,
      includeProgramBody,
      includeRawXml,
      maxResults,
      interfaceLimit,
      bodyEvidenceLimit,
      maxXmlBytes
    }) => {
      try {
        if (includeRawXml && !includeProgramBody) {
          return jsonResult({
            ok: false,
            readOnly: true,
            status: "invalid_request",
            reason: "includeRawXml requires includeProgramBody=true because the raw single-block XML contains the program body."
          });
        }
        const deadline = Date.now() + timeoutMs;
        const live = await resolveExactLiveSession({
          processId,
          timeoutMs: remainingTimeMs(deadline, "current UI-context read", 1_000),
          maxNodes,
          maxDepth
        });
        const currentBlock = selectCurrentBlock(live.observed.context);
        if (!live.ok) {
          return jsonResult({
            ok: false,
            readOnly: true,
            status: live.status,
            reason: live.reason,
            context: live.observed.context as unknown as JsonValue,
            currentBlock: currentBlock as unknown as JsonValue
          });
        }
        if (currentBlock.status !== "resolved" || !currentBlock.block) {
          return jsonResult({
            ok: false,
            readOnly: true,
            status: currentBlock.status === "ambiguous" ? "current_block_ambiguous" : "current_block_unavailable",
            reason: "The bounded UI observation did not expose exactly one selected/open PLC block.",
            context: live.observed.context as unknown as JsonValue,
            currentBlock: currentBlock as unknown as JsonValue
          });
        }
        const identity: TiaLiveObjectIdentity = {
          resourceKind: "block",
          name: currentBlock.block.name ?? "",
          blockKind: currentBlock.block.kind,
          number: currentBlock.block.number
        };
        const core = await queryExactLiveObject({
          processId: live.processId,
          processStartTimeUtc: live.processStartTimeUtc,
          projectPath: live.projectPath,
          identity,
          timeoutMs: remainingTimeMs(deadline, "official live block query", 1_000),
          portalMinimized: live.selectedProcess?.isMinimized === true,
          includeCrossReferences,
          includeBlockXml: includeProgramBody,
          includeProgramBody,
          includeInterface,
          maxResults,
          maxXmlBytes
        });
        let temporaryBlockEvidence: JsonValue = null;
        if (core.ok && (includeProgramBody || includeInterface)) {
          try {
            temporaryBlockEvidence = parseLiveBlockXml(
              core,
              maxXmlBytes,
              interfaceLimit,
              bodyEvidenceLimit,
              includeInterface,
              includeProgramBody,
              includeRawXml
            ) as unknown as JsonValue;
          } catch (error) {
            temporaryBlockEvidence = {
              ok: false,
              status: "temporary_block_xml_parse_error",
              error: error instanceof Error ? error.message : String(error)
            };
          }
        }
        const completeness = mergeLiveCompleteness(core, {
          temporaryBlockEvidence,
          includeInterface,
          includeProgramBody
        });
        const requestedActionCompleted = core.ok && completeness.requestedActionCompleted === true;
        const combinedStatus = core.ok && !requestedActionCompleted ? "partial" : core.status;
        return liveStructuredResult({
          ok: core.ok,
          readOnly: true,
          status: combinedStatus,
          requestedActionCompleted,
          completeness,
          context: live.observed.context as unknown as JsonValue,
          currentBlock: currentBlock as unknown as JsonValue,
          exactLiveIdentity: {
            processId: live.processId,
            projectPath: live.projectPath,
            object: identity as unknown as JsonValue
          },
          directLive: withoutBlockXmlPayload(core) as unknown as JsonValue,
          temporaryBlockEvidence,
          provenance: {
            sessionIdentity: "tia_ui_context_official_process_diagnostics",
            objectMetadata: "official_openness_direct_properties",
            crossReferences: includeCrossReferences ? "official_step7_cross_reference_service" : "not_requested",
            interface: includeInterface ? "direct_when_publicly_exposed_else_temporary_block_xml" : "not_requested",
            programBody: includeProgramBody ? "temporary_single_block_simatic_ml" : "not_requested",
            offlineExportOrIndex: "not_used"
          },
          guarantees: {
            exactPidAndCanonicalProjectPathRequired: true,
            attachedSessionOnly: true,
            projectOpenedClosedSavedOrCompiled: false,
            plcOnlineReadOrWrite: false,
            persistentExportOrIndexCreated: false,
            wholeProjectExported: false
          }
        });
      } catch (error) {
        return jsonResult({
          ok: false,
          readOnly: true,
          status: "live_details_error",
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  );
  const queryLiveOne = op({
        processId: z.number().int().positive().optional(),
        resourceKind: z.enum(["block", "plc_type", "tag_table", "plc_tag"]),
        name: z.string().min(1).max(500),
        blockKind: z.string().max(50).optional(),
        number: z.string().max(50).optional(),
        tagTableName: z.string().max(500).optional(),
        namespace: z.string().max(500).optional(),
        softwarePath: z.string().max(2_000).optional(),
        officialIdentifier: z.string().max(2_000).optional(),
        includeCrossReferences: z.boolean().default(true),
        includeInterface: z.boolean().default(true),
        includeProgramBody: z.boolean().default(false),
        includeRawXml: z.boolean().default(false),
        refreshInventory: z.boolean().default(false),
        timeoutMs: z.number().int().min(3_000).max(60_000).default(20_000),
        maxNodes: z.number().int().min(50).max(2_000).default(800),
        maxDepth: z.number().int().min(2).max(12).default(8),
        maxResults: z.number().int().min(1).max(5_000).default(500),
        interfaceLimit: z.number().int().min(1).max(5_000).default(1_000),
        bodyEvidenceLimit: z.number().int().min(1).max(5_000).default(1_000),
        maxXmlBytes: z.number().int().min(100_000).max(25_000_000).default(15_000_000)
      },
    async ({
      processId,
      resourceKind,
      name,
      blockKind,
      number,
      tagTableName,
      namespace,
      softwarePath,
      officialIdentifier,
      includeCrossReferences,
      includeInterface,
      includeProgramBody,
      includeRawXml,
      refreshInventory,
      timeoutMs,
      maxNodes,
      maxDepth,
      maxResults,
      interfaceLimit,
      bodyEvidenceLimit,
      maxXmlBytes
    }) => {
      try {
        if (includeRawXml && !includeProgramBody) {
          return jsonResult({
            ok: false,
            readOnly: true,
            status: "invalid_request",
            reason: "includeRawXml requires includeProgramBody=true because the raw single-block XML contains the program body."
          });
        }
        if (includeProgramBody && resourceKind !== "block") {
          return jsonResult({
            ok: false,
            readOnly: true,
            status: "unsupported",
            reason: "Program-body export is available only for PLC blocks. PLC types and tag tables expose typed metadata and may be exported separately in a future explicit mode."
          });
        }
        const deadline = Date.now() + timeoutMs;
        const live = await resolvePreparedLiveQuerySession({
          processId,
          timeoutMs: remainingTimeMs(deadline, "prepared live-session identity", 1_000),
          maxNodes,
          maxDepth
        });
        if (!live.ok) {
          return jsonResult({
            ok: false,
            readOnly: true,
            status: live.status,
            reason: live.reason,
            context: live.context as unknown as JsonValue
          });
        }
        const identity: TiaLiveObjectIdentity = {
          resourceKind: resourceKind as TiaLiveResourceKind,
          name,
          blockKind,
          number,
          tagTableName,
          namespace,
          softwarePath,
          officialIdentifier
        };
        const core = await queryExactLiveObject({
          processId: live.processId,
          processStartTimeUtc: live.processStartTimeUtc,
          projectPath: live.projectPath,
          identity,
          timeoutMs: remainingTimeMs(deadline, "official live project query", 1_000),
          includeCrossReferences,
          includeBlockXml: resourceKind === "block" && includeProgramBody,
          includeProgramBody,
          includeInterface,
          maxResults,
          maxXmlBytes,
          preparedSessionChecked: true,
          refreshInventory
        });
        let temporaryBlockEvidence: JsonValue = null;
        if (core.ok && resourceKind === "block" && (includeProgramBody || includeInterface)) {
          try {
            temporaryBlockEvidence = parseLiveBlockXml(
              core,
              maxXmlBytes,
              interfaceLimit,
              bodyEvidenceLimit,
              includeInterface,
              includeProgramBody,
              includeRawXml
            ) as unknown as JsonValue;
          } catch (error) {
            temporaryBlockEvidence = {
              ok: false,
              status: "temporary_block_xml_parse_error",
              error: error instanceof Error ? error.message : String(error)
            };
          }
        }
        const completeness = mergeLiveCompleteness(core, {
          temporaryBlockEvidence,
          includeInterface,
          includeProgramBody
        });
        const requestedActionCompleted = core.ok && completeness.requestedActionCompleted === true;
        const combinedStatus = core.ok && !requestedActionCompleted ? "partial" : core.status;
        return liveStructuredResult({
          ok: core.ok,
          readOnly: true,
          status: combinedStatus,
          requestedActionCompleted,
          completeness,
          exactLiveIdentity: {
            processId: live.processId,
            projectPath: live.projectPath,
            object: identity as unknown as JsonValue
          },
          directLive: withoutBlockXmlPayload(core) as unknown as JsonValue,
          temporaryBlockEvidence,
          provenance: {
            sessionIdentity: live.identitySource,
            directObject: "official_openness_typed_object_model",
            crossReferences: includeCrossReferences ? "official_step7_cross_reference_service_when_supported" : "not_requested",
            temporaryXml: resourceKind === "block" && (includeProgramBody || includeInterface)
              ? "official_single_object_export_then_immediate_cleanup"
              : "not_used",
            persistentOfflineIndex: "not_used"
          }
        });
      } catch (error) {
        return jsonResult({
          ok: false,
          readOnly: true,
          status: "live_query_error",
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  );
  server.registerTool(
    "tia_get_graph_context",
    {
      title: "Read GRAPH Step or Transition Context",
      description: "Read one exact live GRAPH block and return a step's exits or a transition's predecessor/successor steps, actions, interlocks and Boolean guards. Sequence numbers disambiguate reused step numbers. No UI navigation, project write, scheduler simulation or PLC runtime monitoring.",
      inputSchema: {
        processId: z.number().int().positive(), name: z.string().min(1).max(500),
        number: z.string().regex(/^\d+$/).optional(), softwarePath: z.string().max(2_000).optional(),
        sequence: z.number().int().positive().optional(), step: z.string().regex(/^\d+$/).optional(),
        transition: z.string().regex(/^\d+$/).optional(),
        limit: z.number().int().min(1).max(200).default(50),
        timeoutMs: z.number().int().min(3_000).max(60_000).default(20_000)
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async (args) => {
      try {
        const deadline = Date.now() + args.timeoutMs;
        const live = await resolvePreparedLiveQuerySession({ processId: args.processId, timeoutMs: args.timeoutMs, maxNodes: 800, maxDepth: 8 });
        if (!live.ok) return jsonResult({ ok: false, status: live.status, reason: live.reason });
        const identity: TiaLiveObjectIdentity = { resourceKind: "block", name: args.name, number: args.number, softwarePath: args.softwarePath };
        const core = await queryExactLiveObject({ processId: args.processId, processStartTimeUtc: live.processStartTimeUtc,
          projectPath: live.projectPath, identity, timeoutMs: remainingTimeMs(deadline, "GRAPH block read", 1_000),
          includeCrossReferences: false, includeBlockXml: true, includeProgramBody: true, includeInterface: false,
          maxResults: 1, maxXmlBytes: 5_000_000, preparedSessionChecked: true });
        if (!core.ok) return jsonResult(withoutBlockXmlPayload(core) as unknown as Record<string, JsonValue>);
        const xml = liveBlockXmlText(core, 5_000_000);
        if (!xml) return jsonResult({ ok: false, status: "program_body_unavailable" });
        const exported = extractSimaticObject(parseSimaticXmlText(xml.text));
        const attributes = exported.value.AttributeList as Record<string, unknown> | undefined;
        const resolvedIdentity = objectRecord(objectRecord(core.object)?.identity);
        const analyzed = programAnalysisCache.analyze({ xml: xml.text,
          name: scalarString(attributes?.Name), number: scalarString(attributes?.Number),
          softwarePath: scalarString(resolvedIdentity?.softwarePath),
          kind: exported.key.split(".").at(-1) ?? exported.key,
          language: scalarString(attributes?.ProgrammingLanguage) });
        const context = graphContext(analyzed.result, args, args.limit);
        return jsonResult({ ok: context.status === "resolved", ...context,
          exactLiveIdentity: { processId: args.processId, processStartTimeUtc: live.processStartTimeUtc, projectPath: live.projectPath, object: resolvedIdentity ?? identity },
          sha256: analyzed.result.sha256, cacheHit: analyzed.cacheHit, timings: core.timings,
          requestedActionCompleted: context.status === "resolved" && !context.truncated,
          coverage: analyzed.result.coverage,
          navigation: { performed: false }, xmlEvidence: xml.metadata } as unknown as Record<string, JsonValue>);
      } catch (error) {
        return jsonResult({ ok: false, status: "graph_context_error", error: error instanceof Error ? error.message : String(error) });
      }
    }
  );
  server.registerTool(
    "tia_search_live_objects",
    {
      title: "Search Current TIA Project Objects",
      description: "Search prepared live inventory by partial name/group path or exact block kind/number. Returns exact identities for subsequent reads. No whole-project XML export, program-body scan, navigation or PLC access. Pagination requires an unchanged project inventory.",
      inputSchema: {
        processId: z.number().int().positive(),
        resourceKind: z.enum(["block", "plc_type", "tag_table", "plc_tag"]).default("block"),
        query: z.string().max(500).default(""),
        softwarePath: z.string().max(2_000).optional(),
        blockKind: z.string().max(50).optional(),
        number: z.string().regex(/^\d+$/).optional(),
        offset: z.number().int().min(0).max(1_000_000).default(0),
        maxResults: z.number().int().min(1).max(200).default(50),
        refreshInventory: z.boolean().default(false),
        timeoutMs: z.number().int().min(3_000).max(60_000).default(20_000)
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async (args) => {
      try {
        const started = Date.now();
        const live = await resolvePreparedLiveQuerySession({ processId: args.processId, timeoutMs: args.timeoutMs, maxNodes: 800, maxDepth: 8 });
        if (!live.ok) return jsonResult({ ok: false, status: live.status, reason: live.reason });
        const remaining = remainingTimeMs(started + args.timeoutMs, "live inventory search", 1_000);
        const result = await queryTiaLiveCore({ ...args, operation: "search_objects", timeoutMs: remaining,
          processStartTimeUtc: live.processStartTimeUtc, projectPath: live.projectPath }, liveCoreOptions(remaining));
        assertLiveCoreSession(result, args.processId, live.projectPath, live.processStartTimeUtc);
        return jsonResult(result as unknown as Record<string, JsonValue>);
      } catch (error) {
        return jsonResult({ ok: false, status: "live_search_error", error: error instanceof Error ? error.message : String(error) });
      }
    }
  );
  const queryLiveBatch = op({
        processId: z.number().int().positive().optional(),
        queries: z.array(z.object({
          operationId: z.string().min(1).max(200),
          resourceKind: z.enum(["block", "plc_type", "tag_table", "plc_tag"]),
          name: z.string().min(1).max(500),
          blockKind: z.string().max(50).optional(),
          number: z.string().max(50).optional(),
          tagTableName: z.string().max(500).optional(),
          namespace: z.string().max(500).optional(),
          softwarePath: z.string().max(2_000).optional(),
          officialIdentifier: z.string().max(2_000).optional()
        })).min(1).max(50),
        includeCrossReferences: z.boolean().default(false),
        includeProgramBody: z.boolean().default(false),
        bodyEvidenceLimit: z.number().int().min(1).max(1_000).default(200),
        maxXmlBytes: z.number().int().min(100_000).max(5_000_000).default(2_000_000),
        refreshInventory: z.boolean().default(false),
        timeoutMs: z.number().int().min(3_000).max(120_000).default(30_000),
        maxNodes: z.number().int().min(50).max(2_000).default(800),
        maxDepth: z.number().int().min(2).max(12).default(8),
        maxResultsPerQuery: z.number().int().min(1).max(1_000).default(200)
      },
    async ({
      processId,
      queries,
      includeCrossReferences,
      includeProgramBody,
      bodyEvidenceLimit,
      maxXmlBytes,
      refreshInventory,
      timeoutMs,
      maxNodes,
      maxDepth,
      maxResultsPerQuery
    }) => {
      try {
        const operationIds = new Set<string>();
        for (const query of queries) {
          if (operationIds.has(query.operationId)) {
            return jsonResult({
              ok: false,
              readOnly: true,
              status: "invalid_request",
              reason: `Duplicate operationId: ${query.operationId}`
            });
          }
          operationIds.add(query.operationId);
        }
        return liveStructuredResult(await queryExactLiveBatch({
          processId,
          queries: queries as LiveBatchQueryItem[],
          timeoutMs,
          maxNodes,
          maxDepth,
          includeCrossReferences,
          includeProgramBody,
          bodyEvidenceLimit,
          maxXmlBytes,
          maxResultsPerQuery,
          refreshInventory
        }));
      } catch (error) {
        return jsonResult({
          ok: false,
          readOnly: true,
          status: "live_batch_query_error",
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  );
  server.registerTool(
    "tia_navigate_live_object",
    {
      title: "Navigate TIA Portal to Object",
      description: "Explicit UI navigation action. Resolves one object in the exact current PID/project and invokes only the official ShowInEditor API for PlcBlock, PlcType, or PlcTagTable. Exact network/line navigation is never claimed from ReferenceLocation metadata.",
      inputSchema: {
        processId: z.number().int().positive().optional(),
        resourceKind: z.enum(["block", "plc_type", "tag_table", "plc_tag"]),
        name: z.string().min(1).max(500),
        blockKind: z.string().max(50).optional(),
        number: z.string().max(50).optional(),
        tagTableName: z.string().max(500).optional(),
        namespace: z.string().max(500).optional(),
        softwarePath: z.string().max(2_000).optional(),
        officialIdentifier: z.string().max(2_000).optional(),
        referenceLocation: z.string().min(1).max(2_000).optional(),
        networkLabel: z.string().min(1).max(500).optional(),
        allowUiAutomationNetworkFallback: z.boolean().default(false),
        confirmNavigation: z.literal(true),
        timeoutMs: z.number().int().min(3_000).max(60_000).default(20_000),
        maxNodes: z.number().int().min(50).max(2_000).default(800),
        maxDepth: z.number().int().min(2).max(12).default(8)
      },
      outputSchema: liveToolOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    },
    async ({
      processId,
      resourceKind,
      name,
      blockKind,
      number,
      tagTableName,
      namespace,
      softwarePath,
      officialIdentifier,
      referenceLocation,
      networkLabel,
      allowUiAutomationNetworkFallback,
      confirmNavigation,
      timeoutMs,
      maxNodes,
      maxDepth
    }) => {
      try {
        const deadline = Date.now() + timeoutMs;
        const live = await resolveExactLiveSession({
          processId,
          timeoutMs: remainingTimeMs(deadline, "current UI-context read", 1_000),
          maxNodes,
          maxDepth
        });
        if (!live.ok) {
          return jsonResult({
            ok: false,
            status: live.status,
            reason: live.reason,
            navigation: { openedObject: false, locatedNetwork: false }
          });
        }
        const prepared = await readPreparedLiveSession({
          processId: live.processId,
          timeoutMs: Math.min(remainingTimeMs(deadline, "resident session status", 1_000), 5_000),
          expectedProjectPath: live.projectPath,
          expectedProcessStartTimeUtc: live.processStartTimeUtc
        });
        if (!prepared.ok) {
          return jsonResult({
            ok: false,
            status: "portal_authorization_check_required",
            reason: "Prepare the exact live session and approve the Siemens Openness prompt before navigation.",
            navigation: { openedObject: false, locatedNetwork: false }
          });
        }
        const identity: TiaLiveObjectIdentity = {
          resourceKind: resourceKind as TiaLiveResourceKind,
          name,
          blockKind,
          number,
          tagTableName,
          namespace,
          softwarePath,
          officialIdentifier
        };
        const navigationTimeoutMs = remainingTimeMs(deadline, "official ShowInEditor navigation", 1_000);
        const navigationCoreOptions = liveCoreOptions(navigationTimeoutMs);
        const core = await queryTiaLiveCore({
          operation: "navigate_object",
          timeoutMs: navigationTimeoutMs,
          processId: live.processId,
          processStartTimeUtc: live.processStartTimeUtc,
          projectPath: live.projectPath,
          identity,
          confirmNavigation
        }, navigationCoreOptions);
        assertLiveCoreSession(core, live.processId, live.projectPath, live.processStartTimeUtc);
        const officialNavigation = objectRecord(core.navigation);
        const openedObject = officialNavigation?.openedObject === true;
        const openedRequestedObject = officialNavigation?.openedRequestedObject === true;
        const exactObjectOpened = core.status === "opened_object" && openedObject && openedRequestedObject;
        const locationRequested = Boolean(referenceLocation || networkLabel);
        let fallback: Record<string, JsonValue>;
        if (!locationRequested) {
          fallback = {
            requested: false,
            allowed: false,
            attempted: false,
            status: "not_needed",
            reason: ""
          };
        } else if (!allowUiAutomationNetworkFallback) {
          fallback = {
            requested: true,
            allowed: false,
            attempted: false,
            status: "not_requested",
            reason: "V20 ShowInEditor opens the object only. Set allowUiAutomationNetworkFallback=true and supply an exact networkLabel for one bounded accessibility attempt."
          };
        } else if (!core.ok || !exactObjectOpened) {
          fallback = {
            requested: true,
            allowed: true,
            attempted: false,
            status: "not_attempted",
            reason: "The official navigation did not prove that the exact requested object was opened, so accessibility navigation was not attempted."
          };
        } else if (officialNavigation?.programmingLanguage === "GRAPH") {
          fallback = {
            requested: true, allowed: true, attempted: false, status: "unsupported_graph_location",
            reason: "The current GRAPH editor adapter has no verified exact step/transition selection. Use tia_get_graph_context for exact source location and conditions; the block is open in TIA."
          };
        } else if (!networkLabel) {
          fallback = {
            requested: true,
            allowed: true,
            attempted: false,
            status: "unsupported",
            reason: "ReferenceLocation metadata is evidence only. A separate exact networkLabel is required for the controlled accessibility fallback."
          };
        } else {
          fallback = await runAccessibleNetworkNavigation({
            processId: live.processId,
            processStartTimeUtc: live.processStartTimeUtc,
            projectPath: live.projectPath,
            apiDll: navigationCoreOptions.apiDll,
            exactLabel: networkLabel,
            timeoutMs: remainingTimeMs(deadline, "controlled accessibility location", 1_500),
            maxNodes,
            maxDepth
          });
          fallback.requested = true;
          fallback.allowed = true;
        }
        const locatedNetwork = exactObjectOpened && fallback.ok === true && fallback.status === "located_network";
        const status = !core.ok
          ? core.status
          : !locationRequested
            ? core.status
            : locatedNetwork
              ? "located_network"
              : fallback.status === "ambiguous"
                ? "ambiguous"
                : "partial";
        const requestedActionCompleted = locationRequested ? locatedNetwork : exactObjectOpened;
        return liveStructuredResult({
          ok: core.ok,
          status,
          requestedActionCompleted,
          completeness: {
            requestedActionCompleted,
            officialObjectNavigation: exactObjectOpened ? "complete" : (openedObject ? "partial" : "failed"),
            requestedLocation: !locationRequested ? "not_requested" : (locatedNetwork ? "complete" : String(fallback.status))
          },
          exactLiveIdentity: {
            processId: live.processId,
            projectPath: live.projectPath,
            object: identity as unknown as JsonValue
          },
          officialNavigation: core as unknown as JsonValue,
          requestedLocation: {
            referenceLocation: referenceLocation ?? "",
            networkLabel: networkLabel ?? ""
          },
          uiAutomationFallback: fallback,
          navigation: {
            openedObject,
            openedRequestedObject,
            actualOpenedResourceKind: typeof officialNavigation?.actualOpenedResourceKind === "string"
              ? officialNavigation.actualOpenedResourceKind
              : "",
            locatedNetwork,
            locationApplied: locatedNetwork
          },
          guarantees: {
            projectContentModified: false,
            projectSavedOrCompiled: false,
            plcAccessed: false,
            arbitraryCoordinatesClicked: false,
            referenceLocationTreatedAsOpaqueEvidence: true
          }
        });
      } catch (error) {
        return jsonResult({
          ok: false,
          status: "navigation_error",
          error: error instanceof Error ? error.message : String(error),
          navigation: { openedObject: false, locatedNetwork: false }
        });
      }
    }
  );
  server.registerTool(
    "tia_query_live_project",
    {
      title: "Query Current TIA Project Objects",
      description: "Resolve blocks, PLC data types/UDTs, tag tables or PLC tags in the exact running TIA V20 project through the resident session (attached automatically when Portal is visible). One object: give resourceKind and name; returns direct official attributes, optional CrossReferenceService evidence and, for a block, interface and program body from one temporary XML. Several objects: give queries (up to 50) for a shallower result per object in one call; cross references default off there.",
      inputSchema: {
        processId: z.number().int().positive().optional().describe("Exact Portal PID; skips the UI observation."),
        resourceKind: z.enum(["block", "plc_type", "tag_table", "plc_tag"]).optional(),
        name: z.string().min(1).max(500).optional(),
        blockKind: z.string().max(50).optional(),
        number: z.string().max(50).optional(),
        tagTableName: z.string().max(500).optional(),
        namespace: z.string().max(500).optional(),
        softwarePath: z.string().max(2_000).optional(),
        officialIdentifier: z.string().max(2_000).optional(),
        queries: z.array(z.object({
          operationId: z.string().min(1).max(200),
          resourceKind: z.enum(["block", "plc_type", "tag_table", "plc_tag"]),
          name: z.string().min(1).max(500),
          blockKind: z.string().max(50).optional(),
          number: z.string().max(50).optional(),
          tagTableName: z.string().max(500).optional(),
          namespace: z.string().max(500).optional(),
          softwarePath: z.string().max(2_000).optional(),
          officialIdentifier: z.string().max(2_000).optional()
        })).min(1).max(50).optional().describe("Batch form; replaces the single-object fields."),
        includeCrossReferences: z.boolean().optional().describe("Default true for one object, false for queries."),
        includeInterface: z.boolean().optional().describe("One object only; default true."),
        includeProgramBody: z.boolean().optional().describe("Default false."),
        includeRawXml: z.boolean().optional().describe("One block only; needs includeProgramBody."),
        refreshInventory: z.boolean().optional(),
        maxResults: z.number().int().min(1).max(5_000).optional().describe("Per object. Default 500 (one object) or 200 (queries, at most 1000)."),
        interfaceLimit: z.number().int().min(1).max(5_000).optional().describe("One object: interface members returned, default 1000."),
        bodyEvidenceLimit: z.number().int().min(1).max(5_000).optional().describe("Program-body evidence rows, default 1000 (queries: 200, at most 1000)."),
        maxXmlBytes: z.number().int().min(100_000).max(25_000_000).optional(),
        timeoutMs: z.number().int().min(3_000).max(120_000).optional().describe("Default 20000 for one object (at most 60000), 30000 for queries.")
      },
      outputSchema: liveToolOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async (args) => {
      if (args.queries) return queryLiveBatch({ ...args, maxResultsPerQuery: args.maxResults });
      if (!args.resourceKind || !args.name) {
        return jsonResult({ ok: false, readOnly: true, status: "invalid_request", reason: "Give resourceKind and name, or queries." });
      }
      return queryLiveOne(args);
    }
  );
  return { currentBlockLive };
}
