export type TiaCapabilityState =
  | "ready"
  | "disabled_by_policy"
  | "unavailable_missing_component"
  | "installed_but_stale"
  | "unverified"
  | "not_implemented";

export type TiaCapabilityKey =
  | "environment"
  | "currentUiContext"
  | "residentLiveRead"
  | "offlineIndexRead"
  | "offlineBatchLookup"
  | "projectExport"
  | "singleBlockImport"
  | "liveBatchQuery"
  | "hardwareAndNetworkEngineering"
  | "engineeringDiagnostics"
  | "projectLifecycle"
  | "networkProbe"
  | "plcDownload"
  | "liveValueWrite";

export interface TiaCapability {
  state: TiaCapabilityState;
  available: boolean;
  verified: boolean;
  summary: string;
  reasonCode: string;
  missingComponents: string[];
  warnings: string[];
}

export interface TiaCapabilityFacts {
  opennessApiDllFound: boolean;
  opennessApiDllPath: string;
  opennessApiXmlFound: boolean;
  opennessApiXmlPath: string;
  uiContextScript: boolean;
  uiContextScriptPath: string;
  liveCoreExe: boolean;
  liveCoreExePath: string;
  liveCoreSource: boolean;
  liveCoreSourcePath: string;
  liveCoreBuildScript: boolean;
  liveCoreBuildScriptPath: string;
  liveCoreStale: boolean;
  exportScript: boolean;
  exportScriptPath: string;
  readerScript: boolean;
  readerScriptPath: string;
  exporterExe: boolean;
  exporterExePath: string;
  importerSource: boolean;
  importerSourcePath: string;
  importerExe: boolean;
  importerExePath: string;
  importerStale: boolean;
  importerSelfTestPassed: boolean;
  importerSelfTestStatus: string;
  importerSelfTestError: string;
  importerBuildScript: boolean;
  importerBuildScriptPath: string;
  networkProbeEnabled: boolean;
}

export interface TiaCapabilityReport {
  schemaVersion: "1.0";
  status: "ready" | "degraded" | "unavailable";
  readiness: {
    coreReadReady: boolean;
    projectExportReady: boolean;
    projectImportReady: boolean;
    networkProbeReady: boolean;
  };
  capabilities: Record<TiaCapabilityKey, TiaCapability>;
  blockers: Array<{
    capability: TiaCapabilityKey;
    reasonCode: string;
    missingComponents: string[];
    summary: string;
  }>;
  recommendations: string[];
}

function capability(
  state: TiaCapabilityState,
  summary: string,
  reasonCode: string,
  options: {
    available?: boolean;
    verified?: boolean;
    missingComponents?: string[];
    warnings?: string[];
  } = {}
): TiaCapability {
  return {
    state,
    available: options.available ?? state === "ready",
    verified: options.verified ?? state === "ready",
    summary,
    reasonCode,
    missingComponents: options.missingComponents ?? [],
    warnings: options.warnings ?? []
  };
}

function missingPath(present: boolean, filePath: string): string[] {
  return present ? [] : [filePath];
}

function missingPaths(...groups: string[][]): string[] {
  return groups.flat().filter((value, index, all) => value && all.indexOf(value) === index);
}

export function buildTiaCapabilityReport(facts: TiaCapabilityFacts): TiaCapabilityReport {
  const environment = facts.opennessApiDllFound
    ? capability(
        "ready",
        "The Siemens TIA Portal V20 Openness API assembly is available.",
        "EnvironmentReady",
        {
          warnings: facts.opennessApiXmlFound
            ? []
            : [`Optional Openness API XML documentation was not found: ${facts.opennessApiXmlPath}`]
        }
      )
    : capability(
        "unavailable_missing_component",
        "The Siemens TIA Portal V20 Openness API assembly is unavailable.",
        "OpennessApiUnavailable",
        { missingComponents: [facts.opennessApiDllPath] }
      );

  const uiMissing = missingPaths(
    missingPath(facts.opennessApiDllFound, facts.opennessApiDllPath),
    missingPath(facts.uiContextScript, facts.uiContextScriptPath)
  );
  const currentUiContext = uiMissing.length === 0
    ? capability(
        "ready",
        "Bounded current-project and UI-context observation is available.",
        "CurrentUiContextReady"
      )
    : capability(
        "unavailable_missing_component",
        "Current TIA project/UI-context observation is unavailable.",
        "CurrentUiContextUnavailable",
        { missingComponents: uiMissing }
      );

  const liveReadMissing = missingPaths(
    missingPath(facts.opennessApiDllFound, facts.opennessApiDllPath),
    missingPath(facts.uiContextScript, facts.uiContextScriptPath),
    missingPath(facts.liveCoreExe, facts.liveCoreExePath)
  );
  let residentLiveRead: TiaCapability;
  if (liveReadMissing.length > 0) {
    residentLiveRead = capability(
      "unavailable_missing_component",
      "The exact-identity resident live-read path is unavailable.",
      "ResidentLiveReadUnavailable",
      { missingComponents: liveReadMissing }
    );
  } else if (facts.liveCoreStale) {
    residentLiveRead = capability(
      "installed_but_stale",
      "The resident live-read executable exists but is older than its source.",
      "ResidentLiveReadStale",
      {
        available: true,
        verified: false,
        warnings: [
          `Rebuild ${facts.liveCoreExePath} from ${facts.liveCoreSourcePath} before treating the binary as current.`
        ]
      }
    );
  } else {
    residentLiveRead = capability(
      "ready",
      "The exact PID, process-start, and canonical-project resident live-read path is available.",
      "ResidentLiveReadReady"
    );
  }

  const projectExportMissing = missingPaths(
    missingPath(facts.opennessApiDllFound, facts.opennessApiDllPath),
    missingPath(facts.uiContextScript, facts.uiContextScriptPath),
    missingPath(facts.liveCoreExe, facts.liveCoreExePath)
  );
  let projectExport: TiaCapability;
  if (projectExportMissing.length > 0) {
    projectExport = capability(
      "unavailable_missing_component",
      "Complete PLC program-source snapshot export is unavailable because the official Openness path is incomplete.",
      "ProjectExportUnavailable",
      { missingComponents: projectExportMissing }
    );
  } else if (facts.liveCoreStale) {
    projectExport = capability(
      "installed_but_stale",
      "Complete PLC program-source snapshot export is blocked until the native Core is rebuilt from its current source.",
      "ProjectExportCoreStale",
      {
        available: false,
        verified: false,
        warnings: [`Rebuild ${facts.liveCoreExePath} from ${facts.liveCoreSourcePath}.`]
      }
    );
  } else {
    projectExport = capability(
      "ready",
      "Exact-session snapshots of all PLC blocks, PLC types, and complete tag tables are available through the official TIA Openness export APIs.",
      "ProjectExportReady"
    );
  }

  const projectImportMissing = missingPaths(
    missingPath(facts.opennessApiDllFound, facts.opennessApiDllPath),
    missingPath(facts.uiContextScript, facts.uiContextScriptPath),
    missingPath(facts.importerExe, facts.importerExePath)
  );
  let singleBlockImport: TiaCapability;
  if (projectImportMissing.length > 0) {
    singleBlockImport = capability(
        "unavailable_missing_component",
        "Single-block project import is unavailable.",
        "ImporterUnavailable",
        { missingComponents: projectImportMissing }
      );
  } else if (facts.importerStale) {
    singleBlockImport = capability(
      "installed_but_stale",
      "The single-block importer exists but is older than its audited source.",
      "ImporterStale",
      {
        available: false,
        verified: false,
        warnings: [
          `Rebuild ${facts.importerExePath} from ${facts.importerSourcePath}, then rerun the doctor.`
        ]
      }
    );
  } else if (!facts.importerSelfTestPassed) {
    const detail = facts.importerSelfTestError || facts.importerSelfTestStatus || "not_run";
    singleBlockImport = capability(
      "unverified",
      "The single-block importer is installed but its offline protocol and safety self-test has not passed.",
      "ImporterSelfTestRequired",
      {
        available: false,
        verified: false,
        warnings: [`Importer self-test result: ${detail}`]
      }
    );
  } else {
    singleBlockImport = capability(
      "ready",
      "The offline-self-tested exact-session, plan-gated single-block importer is available.",
      "SingleBlockImportReady"
    );
  }

  const networkProbe = facts.networkProbeEnabled
    ? capability(
        "ready",
        "Bounded TCP port probing is enabled for explicitly allowlisted hosts and ports.",
        "NetworkProbeReady"
      )
    : capability(
        "disabled_by_policy",
        "Bounded TCP port probing is installed but disabled by default policy.",
        "NetworkProbeDisabled",
        { available: false, verified: true }
      );

  const capabilities: Record<TiaCapabilityKey, TiaCapability> = {
    environment,
    currentUiContext,
    residentLiveRead,
    offlineIndexRead: capability(
      "ready",
      "Existing bounded export indexes can be read without starting TIA Portal.",
      "OfflineIndexReadReady"
    ),
    offlineBatchLookup: capability(
      "ready",
      "Up to 50 cached offline queries can be resolved in one MCP call.",
      "OfflineBatchLookupReady"
    ),
    projectExport,
    singleBlockImport,
    liveBatchQuery: residentLiveRead.available
      ? capability(
          "ready",
          "Up to 50 exact live objects can be queried through one prepared resident identity; an explicit PID skips the slow UI observation.",
          "LiveBatchQueryReady"
        )
      : capability(
          "unavailable_missing_component",
          "Live batch queries require the resident exact-identity read path.",
          "LiveBatchQueryUnavailable",
          { missingComponents: residentLiveRead.missingComponents }
        ),
    hardwareAndNetworkEngineering: capability(
      "not_implemented",
      "Generic hardware, GSD, and network changesets are not implemented yet.",
      "HardwareEngineeringNotImplemented",
      { available: false, verified: true }
    ),
    engineeringDiagnostics: facts.liveCoreStale
      ? capability("installed_but_stale", "Rebuild the native core before using the new engineering reader.", "EngineeringDiagnosticsStale", { available: false, verified: false })
      : residentLiveRead.available
      ? capability("ready", "Bounded read-only hardware, network, HMI and PLC-tag observations with configuration diagnostics. Classic HMI alarms and runtime state are not covered.", "EngineeringDiagnosticsReady")
      : capability("unavailable_missing_component", "Engineering diagnostics require the current resident read core.", "EngineeringDiagnosticsUnavailable", { missingComponents: residentLiveRead.missingComponents }),
    projectLifecycle: capability(
      "not_implemented",
      "Project create/open/save-as/archive operations are not implemented yet.",
      "ProjectLifecycleNotImplemented",
      { available: false, verified: true }
    ),
    networkProbe,
    plcDownload: capability(
      "not_implemented",
      "PLC download is intentionally outside the current engineering tool boundary.",
      "PlcDownloadNotImplemented",
      { available: false, verified: true }
    ),
    liveValueWrite: capability(
      "not_implemented",
      "Live PLC value writes and force operations are intentionally not implemented.",
      "LiveValueWriteNotImplemented",
      { available: false, verified: true }
    )
  };

  const readiness = {
    coreReadReady: currentUiContext.available && residentLiveRead.available,
    projectExportReady: projectExport.available,
    projectImportReady: singleBlockImport.available,
    networkProbeReady: networkProbe.available
  };

  const currentComponentKeys: TiaCapabilityKey[] = [
    "environment",
    "currentUiContext",
    "residentLiveRead",
    "projectExport",
    "singleBlockImport"
  ];
  const blockers = currentComponentKeys
    .filter((key) => !capabilities[key].available)
    .map((key) => ({
      capability: key,
      reasonCode: capabilities[key].reasonCode,
      missingComponents: capabilities[key].missingComponents,
      summary: capabilities[key].summary
    }));

  const degraded = (
    residentLiveRead.state === "installed_but_stale"
    || !readiness.projectExportReady
    || !readiness.projectImportReady
  );
  const status = readiness.coreReadReady
    ? (degraded ? "degraded" : "ready")
    : "unavailable";

  const recommendations: string[] = [];
  if (residentLiveRead.state === "installed_but_stale") {
    recommendations.push("Run npm run build:live-core, then rerun the doctor.");
  }
  if (!facts.importerExe && facts.importerSource && facts.importerBuildScript && facts.opennessApiDllFound) {
    recommendations.push("Run npm run build:import-helper, then rerun the doctor.");
  } else if (!facts.importerExe && !facts.importerSource) {
    recommendations.push(`Restore the audited importer source before enabling project writes: ${facts.importerSourcePath}`);
  } else if (facts.importerStale) {
    recommendations.push("Rebuild the single-block importer, then rerun its offline self-test.");
  } else if (facts.importerExe && !facts.importerSelfTestPassed) {
    recommendations.push("Keep project writes disabled until the importer returns a valid offline --self-test result.");
  }
  if (projectExport.state === "installed_but_stale") {
    recommendations.push("Run npm run build:live-core before using tia_export_project_index.");
  } else if (!readiness.projectExportReady) {
    recommendations.push("Restore the official Openness API, UI-context reader, and native Core before using tia_export_project_index.");
  }
  if (!facts.opennessApiXmlFound) {
    recommendations.push("Install or point TIA_MCP_OPENNESS_API_XML to the matching V20 API XML when local API evidence is required.");
  }

  return {
    schemaVersion: "1.0",
    status,
    readiness,
    capabilities,
    blockers,
    recommendations
  };
}
