import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { assembledImportResult, jsonResult, objectRecord, type JsonValue } from "../core/results.js";
import {
  assertAllowedLocalRoot, normalizePath, resolveOpennessApiDll, sameCanonicalPath, sha256File, serverRoot, workspaceRoot
} from "../core/local-paths.js";
import { classifyImporterFailure, parseImporterReport } from "../core/importer-output.js";
import { runProcess } from "../core/process.js";
import type { PlanStore } from "../plan-store.js";
import { tryResidentReadback } from "../resident-signatures.js";
import type { TiaLiveObjectIdentity } from "../tia-live-core.js";
import { componentExe, hasCapability, profileForProject, type PortalVersionId } from "../tia-version.js";

// The apply half of tia_apply_import, shared by its one-block and its 2..20-block (changeset)
// operation. Each operation checks that the request names exactly what its plan bound; everything after
// that — live identity, output directory, runtime identity, consuming the token, running the
// importer, reading its summary, refreshing the live inventory, the independent readback and the
// result status — runs here once, so the two paths cannot drift apart again.

// Live-session and environment services, injected by index.ts.
export interface PlcImportServices {
  resolveExactLiveSession: (args: { portalVersion?: PortalVersionId; processId?: number; projectPath?: string; timeoutMs: number; maxNodes: number; maxDepth: number }) => Promise<
    | { ok: true; identitySource: string; processId: number; processStartTimeUtc: string; projectPath: string }
    | { ok: false; reason: string }
  >;
  refreshPreparedLiveInventory: (args: {
    processId: number; processStartTimeUtc: string; projectPath: string; identity: TiaLiveObjectIdentity;
  }) => Promise<Record<string, JsonValue>>;
}

/** What both plan kinds bind besides their targets. */
export type ApplyPlanCore = {
  baselineSource: string;
  portalVersion: PortalVersionId;
  processId: number;
  processStartTimeUtc: string;
  projectPath: string;
  importerExePath: string;
  importerExeSha256: string;
  opennessApiDllPath: string;
  opennessApiDllSha256: string;
  saveProject: boolean;
};

export type ApplyTarget = { xmlPath: string; xmlSha256: string; targetKind: string; targetName: string; targetNumber: string };

// The plan bound a self-tested importer and API by path and SHA-256, so one
// check just before the point of no return proves the same pair will run.
// The importer itself rechecks the XML digest and process start on launch.
export async function plannedRuntimeChange(
  plan: Pick<ApplyPlanCore, "portalVersion" | "importerExePath" | "importerExeSha256" | "opennessApiDllPath" | "opennessApiDllSha256">
): Promise<Record<string, JsonValue> | null> {
  try {
    const api = resolveOpennessApiDll(plan.portalVersion);
    if (!api) return { status: "openness_api_unavailable", reason: "The planned TIA Openness API is no longer available. Create a new plan." };
    const importerExePath = await realpath(componentExe("importer", plan.portalVersion, serverRoot));
    const [importerSha256, apiSha256] = await Promise.all([sha256File(importerExePath), sha256File(api.dllPath)]);
    if (!sameCanonicalPath(importerExePath, plan.importerExePath) || importerSha256 !== plan.importerExeSha256) {
      return { status: "importer_identity_changed", reason: "The version-selected importer changed after planning. Review it and create a new plan.",
        plannedSha256: plan.importerExeSha256, currentSha256: importerSha256 };
    }
    if (!sameCanonicalPath(api.dllPath, plan.opennessApiDllPath) || apiSha256 !== plan.opennessApiDllSha256) {
      return { status: "openness_api_identity_changed", reason: "The TIA Openness API path or binary changed after planning. Create a new plan.",
        plannedPath: plan.opennessApiDllPath, currentPath: normalizePath(api.dllPath), plannedSha256: plan.opennessApiDllSha256, currentSha256: apiSha256 };
    }
    return null;
  } catch (error) {
    return { status: "write_runtime_identity_unavailable", error: error instanceof Error ? error.message : String(error) };
  }
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const blocked = (fields: Record<string, JsonValue>) => jsonResult({ ok: false, blocked: true, ...fields, downloadsToPlc: false });

/**
 * Refresh the prepared live inventory once after an import. The inventory covers the whole
 * project, so one forced rebuild (looked up through the first replaced block) serves every target;
 * rebuilding it per block cost a full project walk each time.
 */
async function refreshTargets(services: PlcImportServices, plan: ApplyPlanCore, targets: ApplyTarget[]): Promise<JsonValue> {
  if (!hasCapability(profileForProject(plan.projectPath), "live_query")) return { attempted: false, status: "not_needed_no_resident_capability" };
  const first = targets[0];
  let result: Record<string, JsonValue>;
  try {
    result = await services.refreshPreparedLiveInventory({
      processId: plan.processId, processStartTimeUtc: plan.processStartTimeUtc, projectPath: plan.projectPath,
      identity: { resourceKind: "block", name: first.targetName, blockKind: first.targetKind, number: first.targetNumber }
    });
  } catch (error) {
    result = { attempted: true, status: "failed", error: errorText(error) };
  }
  return targets.length === 1 ? result : { ...result, scope: "project_inventory", targetCount: targets.length };
}

export type PrepareResult = { args: string[]; abandon?: () => Promise<unknown> } | { blocked: Record<string, JsonValue> };

export type ApplyRequest<P extends ApplyPlanCore> = {
  plan: P;
  confirmToken: string;
  store: PlanStore<P>;
  services: PlcImportServices;
  targets: ApplyTarget[];
  outDir: string | undefined;
  timeoutMs: number;
  /** Inserted into the default output directory name, e.g. "-changeset". */
  outDirTag: string;
  summaryFileName: string;
  /** "import" or "changeset": used in warnings. */
  noun: string;
  okStatus: { saved: string; unsaved: string };
  /**
   * Work that must happen before the token is consumed (a failure keeps the approval usable),
   * returning the importer arguments that differ between the two modes.
   */
  /** Mode-specific checks of the output location, run before the runtime identity check (no writes). */
  precheck?: (resolvedOutDir: string) => Record<string, JsonValue> | null;
  prepare: (resolvedOutDir: string) => Promise<PrepareResult>;
  /** Mode-specific proof that the summary verified every target. */
  verifySummary: (summary: Record<string, JsonValue>) => Promise<{ verified: boolean; fields: Record<string, JsonValue> }>;
  /** Mode-specific result fields taken from the summary. */
  summaryFields: (summary: Record<string, JsonValue> | null, projectTouched: boolean | null) => Record<string, JsonValue>;
};

export async function runImporterApply<P extends ApplyPlanCore>(request: ApplyRequest<P>) {
  const { plan, confirmToken, store, services, targets, timeoutMs } = request;

  let live: Awaited<ReturnType<PlcImportServices["resolveExactLiveSession"]>>;
  try {
    live = await services.resolveExactLiveSession({
      portalVersion: plan.portalVersion, processId: plan.processId, projectPath: plan.projectPath,
      timeoutMs: Math.min(timeoutMs, 60_000), maxNodes: 2_000, maxDepth: 12
    });
  } catch (error) {
    return blocked({ status: "live_identity_revalidation_failed", error: errorText(error) });
  }
  if (!live.ok || live.processId !== plan.processId || live.processStartTimeUtc !== plan.processStartTimeUtc
      || !sameCanonicalPath(live.projectPath, plan.projectPath)) {
    return blocked({ status: "live_identity_changed" });
  }

  const resolvedOutDir = request.outDir
    ? normalizePath(request.outDir)
    : path.join(workspaceRoot, "tia-openness-import", `${new Date().toISOString().replace(/[:.]/g, "-")}${request.outDirTag}-${randomUUID()}`);
  assertAllowedLocalRoot(resolvedOutDir, "Import output directory");
  if (existsSync(resolvedOutDir)) return blocked({ status: "output_directory_already_exists", outDir: resolvedOutDir });
  const precheckFailure = request.precheck?.(resolvedOutDir);
  if (precheckFailure) return blocked(precheckFailure);

  const runtimeChange = await plannedRuntimeChange(plan);
  if (runtimeChange) {
    store.discard(confirmToken);
    return blocked(runtimeChange);
  }

  const prepared = await request.prepare(resolvedOutDir);
  if ("blocked" in prepared) return blocked(prepared.blocked);

  // Point of no return. consume fails if the plan expired during preflight
  // or a concurrent apply already took the token.
  try {
    store.consume(confirmToken);
  } catch {
    await prepared.abandon?.();
    return blocked({ status: "confirmation_invalid_or_expired" });
  }

  const commandArgs = [
    "--api", plan.opennessApiDllPath,
    "--project", plan.projectPath,
    ...prepared.args,
    "--process-id", String(plan.processId),
    "--process-start-time-utc", plan.processStartTimeUtc,
    "--out", resolvedOutDir,
    "--timeout-ms", String(timeoutMs)
  ];
  if (!plan.saveProject) commandArgs.push("--no-save");

  let processResult: Awaited<ReturnType<typeof runProcess>>;
  try {
    processResult = await runProcess(plan.importerExePath, commandArgs, timeoutMs + 15_000, "tree-force");
  } catch (error) {
    return jsonResult({
      ok: false,
      status: "indeterminate_timeout_or_launch_failure",
      blocked: false,
      error: errorText(error),
      outDir: resolvedOutDir,
      liveInventoryRefresh: await refreshTargets(services, plan, targets),
      warning: "The importer may have been interrupted after project mutation began; inspect TIA and the output directory before retrying.",
      downloadsToPlc: false
    });
  }

  const summaryPath = path.join(resolvedOutDir, request.summaryFileName);
  let summary: Record<string, JsonValue> | null = null;
  let summaryError = "";
  try {
    summary = objectRecord(JSON.parse(await readFile(summaryPath, "utf8"))) as Record<string, JsonValue> | null;
  } catch (error) {
    summaryError = errorText(error);
  }

  const proof = summary ? await request.verifySummary(summary) : { verified: false, fields: {} };
  const summaryErrors = Array.isArray(summary?.errors) ? summary.errors : [];
  const savedAsRequested = plan.saveProject ? summary?.projectSaved === true : summary?.projectSaved === false;
  const ok = processResult.exitCode === 0 && summary !== null && summaryErrors.length === 0 && proof.verified && savedAsRequested;

  // Read back through an independent connection (prepared core, otherwise a new importer)
  // after refreshing the replaced objects. A failed readback remains a warning: mutation and
  // in-session verification have completed, so reporting failure could invite a duplicate import.
  const liveInventoryRefresh = await refreshTargets(services, plan, targets);

  let independentReadback: Record<string, JsonValue> = { attempted: false };
  if (ok) {
    try {
      const resident = await tryResidentReadback(plan.importerExePath, plan,
        targets.map(t => ({ xml: t.xmlPath, sha256: t.xmlSha256, kind: t.targetKind, name: t.targetName, number: t.targetNumber })), timeoutMs);
      if (resident.report) independentReadback = resident.report;
      else {
        // Verification never saves, so --no-save has no meaning there.
        const verifyArgs = [...commandArgs.filter((arg) => arg !== "--no-save"), "--verify-only"];
        verifyArgs[verifyArgs.indexOf("--out") + 1] = path.join(resolvedOutDir, "independent-readback");
        const verified = await runProcess(plan.importerExePath, verifyArgs, timeoutMs + 15_000, "tree-force");
        const report = parseImporterReport(verified, "Independent readback");
        const matches = verified.exitCode === 0 && report.ok === true && report.programContentMatches === true
          && report.processId === plan.processId && report.processStartTimeUtc === plan.processStartTimeUtc
          && typeof report.projectPath === "string" && sameCanonicalPath(report.projectPath, plan.projectPath);
        independentReadback = { ...(report as Record<string, JsonValue>), attempted: true, ok: matches, residentFallbackReason: resident.fallbackReason };
      }
    } catch (error) {
      independentReadback = { attempted: true, ok: false, error: errorText(error) };
    }
  }
  const readbackMismatch = independentReadback.attempted === true && independentReadback.programContentMatches === false;
  const warnings = independentReadback.attempted && independentReadback.ok !== true
    ? [readbackMismatch
        ? `The ${request.noun} passed in-session verification, but the independent readback exported different program content. The blocks may have been changed since; check them in TIA Portal before re-importing.`
        : `The ${request.noun} passed in-session verification, but the independent read-only readback did not confirm it. Check the blocks in TIA Portal before re-importing.`]
    : [];

  const failure = ok ? null : classifyImporterFailure(processResult, summary, existsSync(summaryPath));
  return assembledImportResult(processResult, {
    ok,
    status: ok ? (plan.saveProject ? request.okStatus.saved : request.okStatus.unsaved) : failure!.status,
    ...(failure ? { importerError: failure.importerError, projectTouched: failure.projectTouched } : {}),
    exitCode: processResult.exitCode ?? -1,
    summaryPath,
    summaryError,
    summary,
    ...request.summaryFields(summary, failure?.projectTouched ?? null),
    changedTargets: summary?.changedTargets ?? [],
    baselineCheckMs: summary?.baselineCheckMs ?? null,
    ...proof.fields,
    verificationMode: independentReadback.ok === true ? "independent-session" : "same-session",
    independentReadbackVerified: independentReadback.ok === true,
    independentReadback,
    warnings,
    liveInventoryRefresh,
    identitySource: live.identitySource,
    baselineSource: plan.baselineSource,
    readbackSource: independentReadback.readbackSource ?? (independentReadback.attempted ? "importer_attach" : "not_attempted"),
    downloadsToPlc: false
  });
}
