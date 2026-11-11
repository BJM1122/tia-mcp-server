import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  assertAllowedLocalRoot, getAllowedProjectRoots, isAllowedProjectPath, normalizePath, resolveOpennessApiDll,
  sameCanonicalPath
} from "./core/local-paths.js";
import { type JsonValue, objectRecord, truncate } from "./core/results.js";
import { validateConfig, validateSnapshotAdapter } from "./environment.js";
import {
  ensureExecutionModel, executionModelFullyUnderstood, executionModelPath, type ExportIndex
} from "./export-index.js";
import { ensureReferenceIndex } from "./export-query.js";
import { canonicalProjectPathForComparison, remainingTimeMs, resolveWorkflowSession } from "./live-session.js";
import { verifiedProvider } from "./native-capabilities.js";
import {
  finalizeSnapshotCurrentPointer, persistSnapshotExportIndex, runSnapshotExport as runOfficialSnapshotExport,
  type SnapshotExportResult, SnapshotFinalizeConflictError, snapshotPathLabel
} from "./project-snapshot.js";
import { portalVersion as portalVersionProfile, readOnlyProjectVersion } from "./tia-version.js";

// Project snapshot export workflow (live attach, official export, index and analysis).

import type { ExecutionModelIndex } from "./execution-model.js";

export function compactCoverage(coverage: ExecutionModelIndex["coverage"]) {
  const { level, exactSites, conservativeSites, unsupportedSites, issues } = coverage;
  return { level, exactSites, conservativeSites, unsupportedSites, issueCount: issues.length };
}

export function snapshotAnalysisResult(model: ExecutionModelIndex, detail: "summary" | "full" = "summary"): Record<string, JsonValue> {
  if (detail === "full") return {
    unresolvedCalls: model.unresolvedCalls, coverage: model.coverage, incremental: model.incremental
  } as unknown as Record<string, JsonValue>;
  const { changedBlockKeys, addedBlockKeys, removedBlockKeys, reusableBlockKeys, pendingBlockKeys } = model.incremental;
  return {
    coverage: { ...compactCoverage(model.coverage), issuesSample: model.coverage.issues.slice(0, 10) },
    unresolvedCallCount: model.unresolvedCalls.length,
    unresolvedCallsSample: model.unresolvedCalls.slice(0, 5),
    incremental: {
      changed: changedBlockKeys.length, added: addedBlockKeys.length, removed: removedBlockKeys.length,
      reusable: reusableBlockKeys.length, pending: pendingBlockKeys.length,
      ...(changedBlockKeys.length <= 20 ? { changedBlockKeys } : {}),
      ...(addedBlockKeys.length <= 20 ? { addedBlockKeys } : {}),
      ...(pendingBlockKeys.length ? { pendingBlockKeys } : {})
    }
  };
}

type ProjectSnapshotWorkflowArgs = {
  processId?: number;
  projectPath?: string;
  outputRoot: string;
  timeoutMs: number;
  confirmPortalAuthorizationReady: boolean;
  reuseUnchanged?: boolean;
  detail?: "summary" | "full";
};

export async function executeProjectSnapshot(args: ProjectSnapshotWorkflowArgs): Promise<Record<string, JsonValue>> {
  const startedAt = Date.now();
  const deadline = startedAt + args.timeoutMs;
  const portalVersion = args.projectPath ? readOnlyProjectVersion(args.projectPath) : "V20";
  const adapter = portalVersionProfile(portalVersion).adapter;
  if (adapter === "v15-snapshot") {
    const validated = await validateSnapshotAdapter(portalVersion);
    if (validated.ok !== true) return { ...validated, requestedActionCompleted: false };
  } else {
    const environment = await validateConfig();
    const exportCapability = environment.capabilityReport.capabilities.projectExport;
    if (!exportCapability.available) {
      return {
        ok: false,
        status: "capability_unavailable",
        requestedActionCompleted: false,
        reason: {
          code: exportCapability.reasonCode,
          message: exportCapability.summary,
          missingComponents: exportCapability.missingComponents
        },
        projectModified: false,
        plcAccessed: false
      };
    }
  }

  assertAllowedLocalRoot(args.outputRoot, "Output root");
  const outputRoot = normalizePath(args.outputRoot);
  const live = await resolveWorkflowSession({
    portalVersion,
    processId: args.processId,
    projectPath: args.projectPath,
    timeoutMs: remainingTimeMs(deadline, "current UI-context read", 1_000),
    maxNodes: 800,
    maxDepth: 8
  }, true);
  if (!live.ok) {
    return {
      ok: false,
      status: live.status,
      requestedActionCompleted: false,
      reason: live.reason,
      context: live.observed.context as unknown as JsonValue
    };
  }

  if (args.projectPath?.trim()) {
    let requestedProjectPath: string;
    try {
      requestedProjectPath = await realpath(normalizePath(args.projectPath));
      if (readOnlyProjectVersion(requestedProjectPath) !== portalVersion) throw new Error("Canonical project version mismatch.");
      if (process.env.TIA_MCP_ALLOW_ANY_PROJECT_PATH !== "1" && !isAllowedProjectPath(requestedProjectPath)) {
        throw new Error(`TIA project path must be under one of: ${getAllowedProjectRoots().join("; ")}.`);
      }
    } catch (error) {
      return {
        ok: false,
        status: "project_path_invalid",
        requestedActionCompleted: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
    if (!sameCanonicalPath(requestedProjectPath, live.projectPath)) {
      return {
        ok: false,
        status: "project_mismatch",
        requestedActionCompleted: false,
        reason: "The requested project path does not match the exact project open in the selected Portal process.",
        requestedProjectPath,
        exactLiveIdentity: {
          processId: live.processId,
          processStartTimeUtc: live.processStartTimeUtc,
          projectPath: live.projectPath
        }
      };
    }
  }

  const exactLiveIdentity = {
    identitySource: live.identitySource,
    processId: live.processId,
    processStartTimeUtc: live.processStartTimeUtc,
    projectPath: live.projectPath
  };
  const projectScopeName = snapshotPathLabel(
    path.basename(live.projectPath, path.extname(live.projectPath))
  );
  const projectScopeHash = createHash("sha256")
    .update(canonicalProjectPathForComparison(live.projectPath))
    .digest("hex")
    .slice(0, 12);
  const projectOutputRoot = path.join(outputRoot, `${projectScopeName}-${projectScopeHash}`);
  assertAllowedLocalRoot(projectOutputRoot, "Project snapshot root");
  const portalMinimized = live.selectedProcess?.isMinimized === true;
  if (!args.confirmPortalAuthorizationReady) {
    return {
      ok: false,
      status: "portal_authorization_check_required",
      requestedActionCompleted: false,
      requiresUserAction: true,
      reason: "Bring TIA Portal to the foreground. The confirmed snapshot call starts one exact-session Openness attach and may show the Siemens authorization prompt.",
      exactLiveIdentity,
      portalMinimized,
      attachAttempted: false
    };
  }
  if (live.selectedProcess?.isMinimized == null) {
    return { ok: false, status: "portal_window_state_unavailable", requestedActionCompleted: false, exactLiveIdentity, attachAttempted: false };
  }
  if (portalMinimized) {
    return {
      ok: false,
      status: "portal_must_be_visible_for_authorization",
      requestedActionCompleted: false,
      requiresUserAction: true,
      reason: "Restore TIA Portal before the one-shot Openness snapshot so an authorization prompt cannot be hidden.",
      exactLiveIdentity,
      attachAttempted: false
    };
  }

  await mkdir(projectOutputRoot, { recursive: true });
  const realOutputRoot = await realpath(projectOutputRoot);
  assertAllowedLocalRoot(realOutputRoot, "Resolved output root");

  const api = resolveOpennessApiDll(portalVersion);
  if (!api) {
    return {
      ok: false,
      status: "capability_unavailable",
      requestedActionCompleted: false,
      reason: "Siemens.Engineering.dll was not found."
    };
  }
  // The exporting companion is the one whose self-test verified snapshot_export
  // for this exact version; nothing else is ever launched against the project.
  const provider = await verifiedProvider(portalVersion, "snapshot_export");
  if (!provider.ok) {
    return {
      ok: false,
      status: "capability_unavailable",
      requestedActionCompleted: false,
      reason: provider.reason,
      components: provider.components as unknown as JsonValue
    };
  }

  let snapshotResult: SnapshotExportResult;
  try {
    snapshotResult = await runOfficialSnapshotExport({
      coreExe: provider.exe,
      apiDll: api.dllPath,
      processId: live.processId,
      processStartTimeUtc: live.processStartTimeUtc,
      projectPath: live.projectPath,
      outputRoot: realOutputRoot,
      timeoutMs: remainingTimeMs(deadline, "official complete PLC program-source snapshot", 30_000),
      // The snapshot-adapter component always exports everything and does not know the flag.
      reuseUnchanged: adapter === "v15-snapshot" ? undefined : args.reuseUnchanged
    });
  } catch (error) {
    return {
      ok: false,
      status: "snapshot_export_error",
      requestedActionCompleted: false,
      error: error instanceof Error ? error.message : String(error),
      exactLiveIdentity,
      safety: {
        projectModified: false,
        projectSavedOrCompiled: false,
        plcAccessed: false,
        plcScanAffected: false
      }
    };
  }
  if (!snapshotResult.core.ok || !snapshotResult.index || !snapshotResult.publishedPath) {
    return {
      ok: false,
      status: snapshotResult.core.status,
      requestedActionCompleted: false,
      error: snapshotResult.core.error ?? "",
      exactLiveIdentity,
      nativeSnapshot: snapshotResult.core as unknown as JsonValue,
      stderrTail: truncate(snapshotResult.stderr, 2_000).text
    };
  }

  const previousPublishedPath = String(snapshotResult.core.snapshot?.previousPublishedPath ?? "");
  let executionBuild: Awaited<ReturnType<typeof ensureExecutionModel>>;
  let referenceBuild: Awaited<ReturnType<typeof ensureReferenceIndex>> | null = null;
  let legacyReferenceError = "";
  try {
    const compatibleIndex = snapshotResult.index as unknown as ExportIndex;
    executionBuild = await ensureExecutionModel(
      snapshotResult.publishedPath,
      compatibleIndex,
      {
        autoBuild: true,
        forceRebuild: false,
        previousExportDir: previousPublishedPath || undefined
      }
    );
    if (!executionBuild.executionModel) {
      throw new Error("Execution model was not created.");
    }
    const executionModel = executionBuild.executionModel;
    snapshotResult.index.calls = executionModel.callSites.map((call) => ({
      source: call.blockName,
      sourceNumber: call.blockNumber,
      sourceKind: call.blockKind,
      sourceLanguage: call.language,
      target: call.calleeName,
      targetBlockType: call.calleeKind,
      file: call.relativePath
    }));
    snapshotResult.index.callCount = snapshotResult.index.calls.length;
    snapshotResult.index.analysis = {
      executionAnalyzerVersion: executionModel.analyzerVersion,
      executionModelPath: path.relative(
        snapshotResult.publishedPath,
        executionModelPath(snapshotResult.publishedPath)
      ),
      fullyUnderstood: executionModelFullyUnderstood(executionModel),
      coverage: compactCoverage(executionModel.coverage)
    };
    if (snapshotResult.indexPath) {
      await persistSnapshotExportIndex(
        snapshotResult.indexPath,
        snapshotResult.index,
        snapshotResult.publishedPath
      );
    }
    try {
      referenceBuild = await ensureReferenceIndex(
        snapshotResult.publishedPath,
        snapshotResult.index as unknown as ExportIndex,
        { autoBuild: false, forceRebuild: false }
      );
    } catch (error) {
      legacyReferenceError = error instanceof Error ? error.message : String(error);
    }
  } catch (error) {
    return {
      ok: false,
      status: "snapshot_complete_analysis_error",
      requestedActionCompleted: false,
      error: error instanceof Error ? error.message : String(error),
      exactLiveIdentity,
      snapshot: {
        publishedPath: snapshotResult.publishedPath,
        manifestPath: snapshotResult.manifestPath ?? "",
        snapshotId: String(snapshotResult.core.snapshot?.snapshotId ?? ""),
        manifestSha256: snapshotResult.manifestSha256 ?? "",
        complete: snapshotResult.manifest?.complete === true,
        previousPublishedPath
      },
      offlineIndex: {
        indexPath: snapshotResult.indexPath ?? "",
        itemCount: snapshotResult.index.itemCount
      },
      safety: {
        projectModifiedByCodex: false,
        projectSavedOrCompiled: false,
        plcAccessed: false,
        plcScanAffected: false
      }
    };
  }

  const executionModel = executionBuild.executionModel!;
  const fullyUnderstood = executionModelFullyUnderstood(executionModel);
  const executionComplete = (
    executionModel.incremental.pendingBlockKeys.length === 0
    && executionBuild.xmlReadErrors.length === 0
    && !executionBuild.xmlByteLimitExceeded
  );
  const analyzedStatus = executionComplete
    ? (fullyUnderstood ? "snapshot_analyzed_exact" : "snapshot_analyzed_with_coverage_gaps")
    : executionBuild.xmlByteLimitExceeded
      ? "snapshot_analysis_incomplete_xml_byte_limit"
      : "snapshot_analysis_incomplete";
  let currentPointerPath = "";
  if (executionComplete) {
    try {
      currentPointerPath = await finalizeSnapshotCurrentPointer({
        outputRoot: realOutputRoot,
        publishedPath: snapshotResult.publishedPath,
        manifestPath: snapshotResult.manifestPath ?? "",
        manifestSha256: snapshotResult.manifestSha256 ?? "",
        snapshotId: String(snapshotResult.core.snapshot?.snapshotId ?? ""),
        expectedCurrentPointerPath: String(snapshotResult.core.snapshot?.currentPointerPath ?? ""),
        previousCurrentExists: snapshotResult.core.snapshot?.previousCurrentExists === true,
        previousCurrentSnapshotId: String(
          snapshotResult.core.snapshot?.previousCurrentSnapshotId ?? ""
        ),
        previousCurrentManifestSha256: String(
          snapshotResult.core.snapshot?.previousCurrentManifestSha256 ?? ""
        ),
        status: analyzedStatus,
        analysis: {
          executionAnalyzerVersion: executionModel.analyzerVersion,
          sourceSignature: executionModel.sourceSignature,
          fullyUnderstood,
          coverageLevel: executionModel.coverage.level
        }
      });
    } catch (error) {
      return {
        ok: false,
        status: error instanceof SnapshotFinalizeConflictError
          ? "snapshot_finalize_conflict"
          : "snapshot_analysis_finalize_error",
        requestedActionCompleted: false,
        error: error instanceof Error ? error.message : String(error),
        exactLiveIdentity,
        snapshot: {
          publishedPath: snapshotResult.publishedPath,
          manifestPath: snapshotResult.manifestPath ?? "",
          snapshotId: String(snapshotResult.core.snapshot?.snapshotId ?? ""),
          manifestSha256: snapshotResult.manifestSha256 ?? "",
          complete: snapshotResult.manifest?.complete === true,
          previousPublishedPath,
          currentPointerUpdated: false
        },
        safety: {
          projectModifiedByCodex: false,
          projectSavedOrCompiled: false,
          plcAccessed: false,
          plcScanAffected: false,
          previousCurrentPreserved: true
        }
      };
    }
  }
  return assembleSnapshotResult({ executionBuild, snapshotResult, fullyUnderstood, executionComplete, analyzedStatus,
    elapsedMs: Date.now() - startedAt, exactLiveIdentity, previousPublishedPath, currentPointerPath, referenceBuild,
    legacyReferenceError, detail: args.detail });
}

export function assembleSnapshotResult({ executionBuild, snapshotResult, fullyUnderstood, executionComplete, analyzedStatus,
  elapsedMs, exactLiveIdentity, previousPublishedPath, currentPointerPath, referenceBuild, legacyReferenceError, detail }: {
  executionBuild: Awaited<ReturnType<typeof ensureExecutionModel>>;
  snapshotResult: SnapshotExportResult;
  fullyUnderstood: boolean; executionComplete: boolean; analyzedStatus: string; elapsedMs: number;
  exactLiveIdentity: { identitySource: string; processId: number; processStartTimeUtc: string; projectPath: string };
  previousPublishedPath: string; currentPointerPath: string;
  referenceBuild: Awaited<ReturnType<typeof ensureReferenceIndex>> | null;
  legacyReferenceError: string; detail?: "summary" | "full";
}): Record<string, JsonValue> {
  const executionModel = executionBuild.executionModel!;
  if (!snapshotResult.index || !snapshotResult.publishedPath) throw new Error("Missing analyzed snapshot");
  return {
    ok: executionComplete,
    status: analyzedStatus,
    requestedActionCompleted: executionComplete,
    elapsedMs,
    identitySource: exactLiveIdentity.identitySource,
    dependencyStampMode: (objectRecord(snapshotResult.manifest?.reuse)?.dependencyStampMode ?? "legacy") as JsonValue,
    exactLiveIdentity,
    snapshot: {
      publishedPath: snapshotResult.publishedPath,
      manifestPath: snapshotResult.manifestPath ?? "",
      snapshotId: String(snapshotResult.core.snapshot?.snapshotId ?? ""),
      manifestSha256: snapshotResult.manifestSha256 ?? "",
      complete: snapshotResult.manifest?.complete === true,
      previousPublishedPath,
      currentPointerPath,
      currentPointerUpdated: executionComplete,
      reuse: (snapshotResult.manifest?.reuse ?? null) as JsonValue
    },
    offlineIndex: {
      indexPath: snapshotResult.indexPath ?? "",
      reused: snapshotResult.indexReused === true,
      itemCount: snapshotResult.index.itemCount,
      callCount: snapshotResult.index.calls.length,
      errorCount: snapshotResult.index.errorCount
    },
    executionModel: {
      path: executionModelPath(snapshotResult.publishedPath),
      analyzerVersion: executionModel.analyzerVersion,
      sourceSignature: executionModel.sourceSignature,
      blockCount: Object.keys(executionModel.blocks).length,
      writeSiteCount: executionModel.writeSites.length,
      callSiteCount: executionModel.callSites.length,
      roots: executionModel.roots as unknown as JsonValue,
      ...snapshotAnalysisResult(executionModel, detail),
      previousSnapshotReused: executionBuild.previousSnapshotReused,
      xmlReadErrors: executionBuild.xmlReadErrors as unknown as JsonValue,
      xmlBytesRead: executionBuild.xmlBytesRead,
      xmlByteLimit: executionBuild.xmlByteLimit,
      xmlByteLimitExceeded: executionBuild.xmlByteLimitExceeded,
      fullyUnderstood
    },
    legacyReferenceIndex: {
      built: Boolean(referenceBuild?.referenceIndex),
      rebuilt: referenceBuild?.rebuilt ?? false,
      deferred: !referenceBuild?.referenceIndex,
      buildMode: "on_demand",
      error: legacyReferenceError
    },
    nativeConsistency: (snapshotResult.core.consistency ?? {}) as JsonValue,
    safety: {
      ...(snapshotResult.core.safety ?? {}),
      projectModifiedByCodex: false,
      projectSavedOrCompiled: false,
      plcAccessed: false,
      plcScanAffected: false
    },
    completeness: {
      snapshotComplete: snapshotResult.manifest?.complete === true,
      identityConsistent: snapshotResult.manifest?.consistency !== undefined,
      executionModelBuilt: true,
      executionModelComplete: executionComplete,
      coverageLevel: executionModel.coverage.level,
      exactSites: executionModel.coverage.exactSites,
      conservativeSites: executionModel.coverage.conservativeSites,
      unsupportedSites: executionModel.coverage.unsupportedSites,
      unresolvedCallCount: executionModel.unresolvedCalls.length,
      pendingBlockCount: executionModel.incremental.pendingBlockKeys.length,
      xmlByteLimitExceeded: executionBuild.xmlByteLimitExceeded,
      fullyUnderstood
    }
  };
}
