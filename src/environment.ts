import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { paths, resolveOpennessApiDll, serverRoot } from "./core/local-paths.js";
import { runPowerShell, runProcess } from "./core/process.js";
import { type JsonValue, objectRecord } from "./core/results.js";
import { buildTiaCapabilityReport, type TiaCapabilityKey, type TiaCapabilityReport } from "./tia-capabilities.js";
import { apiAssemblyMatches, componentExe, componentExeName, componentSources, type PortalVersionId } from "./tia-version.js";
import { nativeCommonMtimeMs, portalVersionReport, summarizePortalReadiness } from "./native-capabilities.js";
import { verifyImporterOffline } from "./plc-importer.js";

// Environment and capability checks shared by the doctor, validate and import tools.

export const SERVER_VERSION = "0.29.1";

// Versions served by the snapshot adapter family (no resident core): the snapshot
// companion built for that exact version must be present, current and pass its self-test.
export async function validateSnapshotAdapter(version: PortalVersionId): Promise<Record<string, JsonValue>> {
  const api = resolveOpennessApiDll(version);
  const coreExe = componentExe("v15-snapshot", version, serverRoot);
  const exeName = componentExeName("v15-snapshot", version);
  const missing: string[] = [];
  if (!api) missing.push(`TIA Portal ${version} Openness core API (Siemens.Engineering.dll)`);
  if (!existsSync(coreExe)) missing.push(`${exeName}; run npm run build:native -- -Component v15-snapshot -Version ${version}`);
  const sources = componentSources("v15-snapshot", serverRoot).filter(file => existsSync(file));
  if (existsSync(coreExe)) {
    const sourceTimes = await Promise.all(sources.map(async file => (await stat(file)).mtimeMs));
    if (Math.max(await nativeCommonMtimeMs(), ...sourceTimes) > (await stat(coreExe)).mtimeMs) {
      missing.push(`${version} snapshot companion is stale; rebuild it`);
    }
  }
  let selfTest: JsonValue = null;
  if (!missing.length && api) {
    const result = await runProcess(coreExe, ["--api", api.dllPath, "--self-test"], 10_000);
    try { selfTest = JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim()) as JsonValue; } catch { /* invalid output is unavailable */ }
    const tested = objectRecord(selfTest);
    if (result.exitCode !== 0 || tested?.ok !== true || tested.status !== "self_test_passed" || !apiAssemblyMatches(version, String(tested.apiAssemblyVersion ?? ""))) {
      missing.push(`${version} public API offline self-test failed`);
    }
  }
  return {
    ok: missing.length === 0, ready: missing.length === 0,
    status: missing.length ? "capability_unavailable" : "ready",
    serverVersion: SERVER_VERSION, portalVersion: version, readOnly: true,
    projectExportReady: missing.length === 0, projectImportReady: false,
    liveQueryReady: false, hmiAuthoringReady: false, plcDownloadEnabled: false,
    apiDllPath: api?.dllPath ?? "", apiDllSource: api?.source ?? "", coreExe,
    missingComponents: missing, selfTest, projectModified: false, plcAccessed: false
  };
}

function resolveOpennessApiXml(): { xmlPath: string; source: string } | null {
  const selectedDll = resolveOpennessApiDll();
  const besideSelectedDll = selectedDll
    ? path.join(path.dirname(selectedDll.dllPath), "Siemens.Engineering.xml")
    : "";
  const candidates = [
    { xmlPath: process.env.TIA_MCP_OPENNESS_API_XML?.trim() ?? "", source: "TIA_MCP_OPENNESS_API_XML" },
    { xmlPath: besideSelectedDll, source: "beside_selected_dll" },
    { xmlPath: paths.opennessApiXml, source: "configured_v20_install" },
    {
      xmlPath: "C:\\Program Files\\Siemens\\Automation\\Portal V20\\PublicAPI\\V20\\Siemens.Engineering.xml",
      source: "standard_program_files"
    }
  ];
  for (const candidate of candidates) {
    if (candidate.xmlPath && existsSync(candidate.xmlPath)) return candidate;
  }
  return null;
}

export async function oldResidentProcesses(): Promise<JsonValue[]> {
  try {
    const marker = path.join(path.dirname(paths.liveCoreExe), "stale-live-core-processes.json");
    const rows = JSON.parse((await readFile(marker, "utf8")).replace(/^\uFEFF/, ""));
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const ids = rows.map(row => row.processId).filter(id => Number.isSafeInteger(id) && id > 0);
    if (!ids.length) return [];
    const result = await runPowerShell(["-NonInteractive", "-Command",
      "$ErrorActionPreference='SilentlyContinue'; ConvertTo-Json -Depth 3 -Compress -InputObject ([object[]]@(Get-Process -Id " + ids.join(",") +
      " | ForEach-Object { [pscustomobject]@{ processId=$_.Id; processStartTimeUtc=$_.StartTime.ToUniversalTime().ToString('o') } }))"], 5000);
    const parsed = JSON.parse(result.stdout.replace(/^\uFEFF/, ""));
    const live = Array.isArray(parsed) ? parsed : [parsed];
    return rows.filter(row => live.some(item => item.processId === row.processId &&
      Date.parse(item.processStartTimeUtc) === Date.parse(row.processStartTimeUtc)))
      .map(row => ({ processId: row.processId, message: "An old live-core process from a replaced build is still running." }));
  } catch { return []; }
}

export async function validateConfig() {
  const opennessApi = resolveOpennessApiDll();
  const opennessApiXml = resolveOpennessApiXml();
  const exportScriptExists = existsSync(paths.exportScript);
  const readerScriptExists = existsSync(paths.readerScript);
  const exporterExeExists = existsSync(paths.exporterExe);
  const importerSourceExists = existsSync(paths.importerSource);
  const importerExeExists = existsSync(paths.importerExe);
  const importerBuildScriptExists = existsSync(paths.importerBuildScript);
  const uiContextScriptExists = existsSync(paths.uiContextScript);
  const liveCoreSourceExists = existsSync(paths.liveCoreSource);
  const liveCoreBuildScriptExists = existsSync(paths.liveCoreBuildScript);
  const liveCoreExeExists = existsSync(paths.liveCoreExe);
  let liveCoreStale = false;
  if (liveCoreSourceExists && liveCoreExeExists) {
    try {
      // Every source of the component (the core and its API compatibility layer).
      const sources = componentSources("live-core", serverRoot).filter(file => existsSync(file));
      const [sourceStats, executableStat] = await Promise.all([
        Promise.all(sources.map(file => stat(file))),
        stat(paths.liveCoreExe)
      ]);
      liveCoreStale = executableStat.mtimeMs < Math.max(...sourceStats.map(s => s.mtimeMs), await nativeCommonMtimeMs());
    } catch {
      liveCoreStale = true;
    }
  }
  let importerStale = false;
  if (importerSourceExists && importerExeExists) {
    try {
      const [sourceStat, executableStat] = await Promise.all([
        stat(paths.importerSource),
        stat(paths.importerExe)
      ]);
      importerStale = executableStat.mtimeMs < Math.max(sourceStat.mtimeMs, await nativeCommonMtimeMs());
    } catch {
      importerStale = true;
    }
  }
  const importerSelfTest = importerExeExists && opennessApi && !importerStale
    ? await verifyImporterOffline(paths.importerExe, opennessApi.dllPath)
    : {
        passed: false,
        status: importerStale ? "not_run_stale_binary" : "not_run_missing_dependency",
        error: ""
      };
  const networkProbeEnabled = process.env.TIA_MCP_ENABLE_NETWORK_PROBE === "1";
  const capabilityReport = buildTiaCapabilityReport({
    opennessApiDllFound: Boolean(opennessApi),
    opennessApiDllPath: opennessApi?.dllPath ?? paths.opennessApiDll,
    opennessApiXmlFound: Boolean(opennessApiXml),
    opennessApiXmlPath: opennessApiXml?.xmlPath ?? paths.opennessApiXml,
    uiContextScript: uiContextScriptExists,
    uiContextScriptPath: paths.uiContextScript,
    liveCoreExe: liveCoreExeExists,
    liveCoreExePath: paths.liveCoreExe,
    liveCoreSource: liveCoreSourceExists,
    liveCoreSourcePath: paths.liveCoreSource,
    liveCoreBuildScript: liveCoreBuildScriptExists,
    liveCoreBuildScriptPath: paths.liveCoreBuildScript,
    liveCoreStale,
    exportScript: exportScriptExists,
    exportScriptPath: paths.exportScript,
    readerScript: readerScriptExists,
    readerScriptPath: paths.readerScript,
    exporterExe: exporterExeExists,
    exporterExePath: paths.exporterExe,
    importerSource: importerSourceExists,
    importerSourcePath: paths.importerSource,
    importerExe: importerExeExists,
    importerExePath: paths.importerExe,
    importerStale,
    importerSelfTestPassed: importerSelfTest.passed,
    importerSelfTestStatus: importerSelfTest.status,
    importerSelfTestError: importerSelfTest.error,
    importerBuildScript: importerBuildScriptExists,
    importerBuildScriptPath: paths.importerBuildScript,
    networkProbeEnabled
  });
  const checks = {
    serverVersion: SERVER_VERSION,
    status: capabilityReport.status,
    ready: capabilityReport.status === "ready",
    workspaceRoot: paths.workspaceRoot,
    exportScript: exportScriptExists,
    readerScript: readerScriptExists,
    exporterExe: exporterExeExists,
    importerSource: importerSourceExists,
    importerExe: importerExeExists,
    importerStale,
    importerSelfTest,
    importerBuildScript: importerBuildScriptExists,
    uiContextScript: uiContextScriptExists,
    liveCoreSource: liveCoreSourceExists,
    liveCoreBuildScript: liveCoreBuildScriptExists,
    liveCoreExe: liveCoreExeExists,
    liveCoreStale,
    oldResidentProcesses: await oldResidentProcesses(),
    accessibleNavigationScript: existsSync(paths.accessibleNavigationScript),
    opennessApiDll: opennessApi?.dllPath ?? "",
    opennessApiDllFound: Boolean(opennessApi),
    opennessApiXml: opennessApiXml?.xmlPath ?? "",
    opennessApiXmlFound: Boolean(opennessApiXml),
    currentUiContextReadOnly: true,
    currentUiContextPollingEnabled: false,
    liveQueriesRequireExactPidProjectPathAndProcessStart: true,
    liveCoreAttachedSessionOnly: true,
    navigationRequiresExplicitConfirmation: true,
    accessibilityNavigationEnabledByDefault: false,
    projectWriteToolEnabled: capabilityReport.readiness.projectImportReady,
    importerBuildReady: importerSourceExists && importerBuildScriptExists && Boolean(opennessApi),
    importRequiresExactLiveIdentityAndOneTimePlan: true,
    plcDownloadEnabled: false,
    networkProbeEnabled,
    capabilityReport
  };
  return checks;
}

export function splitValidatedConfig(config: Awaited<ReturnType<typeof validateConfig>>) {
  const { capabilityReport, ...checks } = config;
  return { checks, capabilityReport };
}

// Doctor covers every installed API version; hot workflow checks remain scoped to their own version.
export async function collectDoctorReport() {
  const [config, portalVersions] = await Promise.all([validateConfig(), portalVersionReport()]);
  const { checks, capabilityReport } = splitValidatedConfig(config);
  const { status, unavailableCapabilities } = summarizePortalReadiness(portalVersions);
  return {
    status, portalVersions, unavailableCapabilities,
    checks: { ...checks, status, ready: status === "ready" },
    capabilityReport: { ...capabilityReport, status }
  };
}

export type DoctorRequirement = "core-read" | "project-export" | "project-import" | "network-probe";

export function requiredCapability(
  report: TiaCapabilityReport,
  requirement?: DoctorRequirement
): TiaCapabilityReport["capabilities"][TiaCapabilityKey] | null {
  if (!requirement) return null;
  const keyByRequirement: Record<DoctorRequirement, TiaCapabilityKey> = {
    "core-read": "residentLiveRead",
    "project-export": "projectExport",
    "project-import": "singleBlockImport",
    "network-probe": "networkProbe"
  };
  return report.capabilities[keyByRequirement[requirement]];
}

export async function collectApiEvidence() {
  const apiXml = resolveOpennessApiXml();
  if (!apiXml) return [];
  const text = await readFile(apiXml.xmlPath, "utf8");
  const needles = [
    "T:Siemens.Engineering.Online.OnlineProvider",
    "M:Siemens.Engineering.Online.OnlineProvider.GoOnline",
    "P:Siemens.Engineering.Online.OnlineProvider.State",
    "T:Siemens.Engineering.Download.DownloadProvider",
    "M:Siemens.Engineering.Download.DownloadProvider.Download",
    "T:Siemens.Engineering.SW.WatchAndForceTables.PlcWatchTable",
    "P:Siemens.Engineering.SW.WatchAndForceTables.PlcWatchTableEntry.ModifyValue",
    "P:Siemens.Engineering.SW.WatchAndForceTables.PlcWatchTableEntry.MonitorTrigger"
  ];
  const lines = text.split(/\r?\n/);
  return needles.map((needle) => {
    const index = lines.findIndex((line) => line.includes(needle));
    return {
      needle,
      lineNumber: index >= 0 ? index + 1 : 0,
      found: index >= 0
    };
  });
}
