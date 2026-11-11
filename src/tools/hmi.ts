import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  assertAllowedLocalRoot, getAllowedProjectRoots, isAllowedProjectPath, isInside, normalizePath,
  normalizeTiaProjectPath, resolveOpennessApiDll, serverRoot, workspaceRoot
} from "../core/local-paths.js";
import { runPowerShell } from "../core/process.js";
import { jsonResult, type JsonValue } from "../core/results.js";
import { type EngineeringRecord } from "../engineering-diagnostics.js";
import {
  atomicWriteJsonFile, ensureExecutionModel, loadExportIndex, readExportProjectIdentity
} from "../export-index.js";
import { extractSymbolsFromIndex, itemMatchesSymbolScope } from "../export-query.js";
import { type AlarmWorkbook, analyzeHmiAlarms, type PlcDefinition, readAlarmRows } from "../hmi-alarm-analysis.js";
import { registerHmiAuthoringTools } from "../hmi-authoring-tools.js";
import {
  createHmiSnapshot, hmiExportKey, type HmiObservation, type HmiSnapshot, parseHmiSnapshot
} from "../hmi-export.js";
import { assertLiveCoreSession, liveCoreOptions, resolvePreparedLiveQuerySession } from "../live-session.js";
import { queryTiaLiveCore } from "../tia-live-core.js";
import { requireCapability } from "../tia-version.js";

// HMI tools: authoring registration, alarm workbook reading and live HMI export.

export function registerHmiTools(server: McpServer) {
  registerHmiAuthoringTools(server, serverRoot, (value, capability = "hmi_authoring") => normalizeTiaProjectPath(value, capability), async value => {
    const parent = await realpath(normalizePath(value));
    if (!(await stat(parent)).isDirectory()) throw new Error("New project parent must be an existing directory.");
    if (process.env.TIA_MCP_ALLOW_ANY_PROJECT_PATH !== "1" && !isAllowedProjectPath(parent)) throw new Error("New project parent must be under an allowed project root.");
    return parent;
  }, () => resolveOpennessApiDll()?.dllPath);
  const readAlarmWorkbook = async (file: string) => {
    assertAllowedLocalRoot(path.resolve(file), "HMI alarm workbook");
    const canonical = await realpath(file);
    assertAllowedLocalRoot(canonical, "Resolved HMI alarm workbook");
    const info = await stat(canonical);
    if (!info.isFile() || info.size > 20000000 || path.extname(canonical).toLowerCase() !== ".xlsx")
      throw new Error("Expected an alarm .xlsx file of at most 20 MB.");
    const result = await runPowerShell(["-File", path.join(serverRoot, "tools", "Read-HmiAlarmWorkbook.ps1"), "-Path", canonical], 30000);
    if (result.exitCode !== 0) throw new Error(result.stderr || "Alarm workbook read failed.");
    return { file: canonical, ...readAlarmRows(JSON.parse(result.stdout.replace(/^\uFEFF/, "")) as AlarmWorkbook) };
  };
  server.registerTool("tia_read_hmi_alarm_export", {
    title: "Read exported HMI alarms",
    description: "Read an existing official WinCC alarm XLSX export, including classic HMI alarms unavailable through Openness. Preserves multilingual text, trigger and acknowledgement columns with worksheet/row evidence. Does not launch Excel, evaluate formulas, attach to TIA or import anything. Workbook project identity is not independently verifiable.",
    inputSchema: { file: z.string().min(1), query: z.string().optional(), limit: z.number().int().min(1).max(100).default(20) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, async ({ file, query, limit }) => {
    try {
      const result = await readAlarmWorkbook(file);
      const matches = result.records.filter(r => !query || JSON.stringify(r.attributes).toLowerCase().includes(query.toLowerCase()));
      const records = matches.slice(0, limit);
      const response = { ok: true, status: result.issues.length ? "partial" : "read", file: result.file,
        sha256: result.sha256, records: records as unknown as JsonValue,
        sources: Object.fromEntries(records.map(r => [r.id, result.sources[r.id]])) as JsonValue,
        matchedCount: matches.length, truncated: matches.length > records.length, issues: result.issues as JsonValue,
        identityEvidence: "The workbook does not establish project or HMI identity. Select it only for the exact intended HMI." };
      if (Buffer.byteLength(JSON.stringify(response)) > 2000000) throw new Error("Alarm output exceeds 2 MB. Narrow query or limit.");
      return jsonResult(response);
    } catch (error) { return jsonResult({ ok: false, status: "alarm_export_read_error", error: String(error) }); }
  });
  server.registerTool("tia_analyze_hmi_alarms", {
    title: "Link HMI alarms to PLC source",
    description: "Analyze a saved exact HMI observation and existing PLC export without TIA. Link trigger/acknowledgement tags and optional reset tags to exact PLC tag or DB definitions, writers, clear candidates, guards and screen references. Explicit connection-to-software-path bindings prevent cross-PLC guesses. Optional official alarm XLSX supplements classic HMI evidence; its HMI ownership is caller-selected, not verified. Does not execute scripts or inspect runtime.",
    inputSchema: {
      projectPath: z.string().min(1), hmiName: z.string().min(1), hmiPath: z.string().min(1), exportDir: z.string().min(1),
      connectionBindings: z.array(z.object({ connectionName: z.string().min(1), softwarePath: z.string().min(1) })).max(20),
      alarmWorkbook: z.string().optional(), query: z.string().optional(), resetTagNames: z.array(z.string().min(1)).max(10).default([]),
      limit: z.number().int().min(1).max(20).default(5)
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  }, async ({ projectPath, hmiName, hmiPath, exportDir, connectionBindings, alarmWorkbook, query, resetTagNames, limit }) => {
    try {
      const project = path.resolve(projectPath);
      requireCapability(project, "hmi_export");
      if (!isAllowedProjectPath(project)) throw new Error("Project must be under an allowed project root.");
      const identity = { projectPath: normalizePath(project).toLowerCase(), hmiName, hmiPath };
      const file = path.join(workspaceRoot, "tia-exports", "hmi", `${hmiExportKey(identity)}.json`);
      assertAllowedLocalRoot(await realpath(file), "Saved HMI observation");
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 40000000) throw new Error("Invalid saved HMI observation.");
      const snapshot = parseHmiSnapshot(await readFile(file, "utf8"), identity);
      const records = snapshot.observation.hmi.records as EngineeringRecord[];
      if (records.length > 20000 || records.some(r => !r || typeof r.id !== "string" || typeof r.type !== "string" || !r.attributes))
        throw new Error("Invalid HMI engineering records.");
      const loaded = await loadExportIndex(exportDir);
      const provenance = await readExportProjectIdentity(loaded.exportDir, loaded.indexPath, loaded.index.generatedAt ?? "");
      const paths = [...(provenance.projectPaths ?? []), ...(loaded.index.projectPath ? [loaded.index.projectPath] : [])];
      if (!paths.length || paths.some(p => normalizePath(p).toLowerCase() !== identity.projectPath))
        throw new Error("PLC export project identity is absent, conflicting or different from the HMI project. No name-based merge is allowed.");
      const scopes = new Set(connectionBindings.map(b => b.softwarePath));
      if (new Set(connectionBindings.map(b => b.connectionName)).size !== connectionBindings.length)
        throw new Error("Each HMI connection must have one explicit PLC binding.");
      for (const scope of scopes) if (!loaded.index.items?.some(i => i.softwarePath === scope))
        throw new Error(`PLC software path not found in export: ${scope}`);
      const selectedIndex = { ...loaded.index, items: loaded.index.items?.filter(i => i.softwarePath && scopes.has(i.softwarePath) && (itemMatchesSymbolScope(i, "db") || itemMatchesSymbolScope(i, "tags"))) };
      const extracted = await extractSymbolsFromIndex(loaded.exportDir, selectedIndex, { scope: "all", limit: 20000, maxFiles: 500 });
      const definitions: PlcDefinition[] = extracted.symbols.map(s => {
        const owner = s.owner as Record<string, JsonValue>;
        const item = selectedIndex.items?.find(i => i.relativePath === owner.relativePath);
        const tag = s.symbolKind === "plcTag";
        const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
        const memberPath = tag ? "" : (s.pathComponents as string[]).map(quote).join(".");
        return { symbol: tag ? quote(String(s.path)) : `${quote(String(owner.name))}.${memberPath}`,
          aliases: tag ? (s.address ? [String(s.address)] : []) : (owner.number ? [`DB${owner.number}.${memberPath}`] : []),
          datatype: String(s.datatype), softwarePath: item?.softwarePath ?? "", source: s };
      });
      const execution = await ensureExecutionModel(loaded.exportDir, loaded.index, { autoBuild: true });
      if (!execution.executionModel) throw new Error("A current PLC execution index is required.");
      const workbook = alarmWorkbook ? await readAlarmWorkbook(alarmWorkbook) : null;
      const analysis = analyzeHmiAlarms({ records, alarms: workbook?.records, definitions, bindings: connectionBindings,
        writes: execution.executionModel.writeSites, query, resetTagNames, limit });
      const result = { ok: true, status: "source_evidence", identity, hmiFile: file, hmiSha256: snapshot.sha256, hmiFileModifiedAt: info.mtime.toISOString(),
        exportDir: loaded.exportDir, plcExportTime: loaded.index.generatedAt ?? null,
        hmiCoverage: snapshot.observation.hmi.coverage, hmiIssues: snapshot.observation.hmi.issues,
        hmiPartial: !snapshot.usable, definitionCoverage: { counts: extracted.counts, truncated: extracted.truncated },
        executionCoverage: execution.executionModel.coverage, executionReadErrors: execution.xmlReadErrors,
        workbook: workbook ? { file: workbook.file, sha256: workbook.sha256, issues: workbook.issues,
          identityEvidence: "caller_selected_for_this_hmi", sources: Object.fromEntries(analysis.alarms.map(a => [a.id, workbook.sources[a.id]])) } : null,
        ...analysis };
      if (Buffer.byteLength(JSON.stringify(result)) > 2000000) throw new Error("Alarm analysis exceeds 2 MB. Narrow query, reset tags or limit.");
      return jsonResult(result as unknown as Record<string, JsonValue>);
    } catch (error) { return jsonResult({ ok: false, status: "alarm_analysis_error", error: String(error) }); }
  });
  server.registerTool("tia_list_hmi_targets", {
    title: "List HMI targets",
    description: "List exact HMI software names, hardware paths and API types in a prepared project without reading PLC programs or exporting configuration.",
    inputSchema: { processId: z.number().int().positive(), timeoutMs: z.number().int().min(3000).max(60000).default(30000) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, async ({ processId, timeoutMs }) => {
    try {
      const live = await resolvePreparedLiveQuerySession({ processId, timeoutMs, maxNodes: 800, maxDepth: 8 });
      if (!live.ok) return jsonResult({ ok: false, status: live.status, reason: live.reason });
      const core = await queryTiaLiveCore({ operation: "list_hmi_targets", processId: live.processId,
        processStartTimeUtc: live.processStartTimeUtc, projectPath: live.projectPath, timeoutMs }, liveCoreOptions(timeoutMs));
      if (core.ok) assertLiveCoreSession(core, live.processId, live.projectPath, live.processStartTimeUtc);
      return jsonResult(core as unknown as Record<string, JsonValue>);
    } catch (error) { return jsonResult({ ok: false, status: "hmi_read_error", error: String(error) }); }
  });
  server.registerTool("tia_export_hmi_configuration", {
    title: "Export HMI configuration for analysis",
    description: "Reuse one canonical JSON observation per exact project and HMI, or read alarms, tags, connections, screens and scripts through public Openness APIs. Set refresh only after a project change. Does not execute scripts, modify the project, export PLC blocks, or produce an importable WinCC backup. Partial reads never replace a usable observation.",
    inputSchema: {
      projectPath: z.string().min(1), hmiName: z.string().min(1), hmiPath: z.string().min(1),
      processId: z.number().int().positive().optional(), refresh: z.boolean().default(false),
      maxObjects: z.number().int().min(1).max(20000).default(20000),
      timeoutMs: z.number().int().min(3000).max(60000).default(60000)
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  }, async ({ projectPath, hmiName, hmiPath, processId, refresh, maxObjects, timeoutMs }) => {
    try {
      const project = path.resolve(projectPath);
      requireCapability(project, "hmi_export");
      if (!getAllowedProjectRoots().some(root => isInside(root, project)))
        throw new Error("Project must be under an allowed project root.");
      const identity = { projectPath: normalizePath(project).toLowerCase(), hmiName, hmiPath };
      const key = hmiExportKey(identity);
      const root = path.join(workspaceRoot, "tia-exports", "hmi");
      assertAllowedLocalRoot(root, "HMI export root");
      await mkdir(root, { recursive: true });
      assertAllowedLocalRoot(await realpath(root), "Resolved HMI export root");
      const file = path.join(root, `${key}.json`);
      let previous: HmiSnapshot | null = null;
      try {
        const info = await lstat(file);
        if (info.isSymbolicLink() || !info.isFile() || info.size > 40000000) throw new Error("Invalid HMI export file.");
        previous = parseHmiSnapshot(await readFile(file, "utf8"), identity);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (previous?.usable && !refresh) return jsonResult({ ok: true, status: "reused", file,
        identity, target: previous.observation.target, coverage: previous.observation.hmi.coverage as JsonValue,
        freshness: "Saved configuration reused; current project changes have not been checked." });
      const live = await resolvePreparedLiveQuerySession({ processId, timeoutMs, maxNodes: 800, maxDepth: 8 });
      if (!live.ok) return jsonResult({ ok: false, status: live.status, reason: live.reason });
      if (normalizePath(await normalizeTiaProjectPath(project, "hmi_export")).toLowerCase() !== normalizePath(live.projectPath).toLowerCase())
        throw new Error("Prepared session belongs to a different project.");
      const core = await queryTiaLiveCore({ operation: "read_hmi", processId: live.processId,
        processStartTimeUtc: live.processStartTimeUtc, projectPath: live.projectPath,
        hmiName, hmiPath, maxObjects, timeoutMs }, liveCoreOptions(timeoutMs));
      if (!core.ok) return jsonResult(core as unknown as Record<string, JsonValue>);
      assertLiveCoreSession(core, live.processId, live.projectPath, live.processStartTimeUtc);
      const observation = { target: core.target, hmi: core.hmi } as HmiObservation;
      const snapshot = createHmiSnapshot(identity, observation);
      const { usable } = snapshot;
      const hmi = observation.hmi;
      if (!usable && previous?.usable) return jsonResult({ ok: false, status: "partial_previous_preserved", file,
        coverage: hmi.coverage as JsonValue, issues: hmi.issues as JsonValue, truncated: hmi.truncated });
      await atomicWriteJsonFile(file, snapshot);
      return jsonResult({ ok: usable, status: usable ? "exported" : "partial_export", file,
        identity, target: core.target as JsonValue, records: hmi.records.length, coverage: hmi.coverage as JsonValue,
        issues: hmi.issues as JsonValue, truncated: hmi.truncated });
    } catch (error) { return jsonResult({ ok: false, status: "hmi_export_error", error: String(error) }); }
  });
}
