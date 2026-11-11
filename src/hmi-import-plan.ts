import { digest } from "./hmi-authoring.js";
import { PlanStore } from "./plan-store.js";
import { nativeIdentity, nativeReferences, nativeDeviceFields } from "./hmi-design.js";

export type HmiImportInput = {
  processId: number; processStartTimeUtc: string; projectPath: string; targetPath: string;
  kind: "screen" | "template"; objectPath: string; candidateXml: string; saveProject: boolean;
};
type HmiImportPayload = HmiImportInput & { originalXml: string; baselineComparisonSha256: string; candidateSha256: string; baselineSha256: string; runtimeSha256: string };
export class HmiImportPlans {
  private plans: PlanStore<HmiImportPayload>;
  constructor(now: () => number = Date.now) { this.plans = new PlanStore({ label: "HMI", ttlMs: 10 * 60_000, maxPending: 20, now }); }
  create(input: HmiImportInput, originalXml: string, comparisonSha256: string, runtimeSha256: string) {
    const original = nativeIdentity(originalXml), candidate = nativeIdentity(input.candidateXml);
    if (candidate.kind !== input.kind || original.kind !== input.kind || candidate.name !== original.name || candidate.name !== input.objectPath.split("/").at(-1))
      throw new Error("Native candidate identity must match the existing target exactly.");
    if (JSON.stringify(nativeDeviceFields(originalXml)) !== JSON.stringify(nativeDeviceFields(input.candidateXml)))
      throw new Error("Screen number and device dimensions must remain unchanged.");
    if (JSON.stringify(nativeReferences(originalXml)) !== JSON.stringify(nativeReferences(input.candidateXml)))
      throw new Error("External references changed. Dependency-changing imports are not enabled.");
    if (!/^[a-f0-9]{64}$/.test(comparisonSha256) || !/^[a-f0-9]{64}$/.test(runtimeSha256)) throw new Error("Missing native baseline/runtime fingerprint.");
    if (originalXml === input.candidateXml) throw new Error("No changes to plan.");
    const payload: HmiImportPayload = { ...input, originalXml, baselineComparisonSha256: comparisonSha256,
      candidateSha256: digest(input.candidateXml), baselineSha256: digest(originalXml), runtimeSha256 };
    const { confirmToken, planSha256, expiresAt } = this.plans.issue(payload);
    let start = 0, endBefore = originalXml.length, endAfter = input.candidateXml.length;
    while (start < endBefore && start < endAfter && originalXml[start] === input.candidateXml[start]) start++;
    while (endBefore > start && endAfter > start && originalXml[endBefore - 1] === input.candidateXml[endAfter - 1]) { endBefore--; endAfter--; }
    return { confirmToken, planSha256, expiresAt,
      identity: { processId: input.processId, processStartTimeUtc: input.processStartTimeUtc, projectPath: input.projectPath, targetPath: input.targetPath, kind: input.kind, objectPath: input.objectPath },
      baselineSha256: payload.baselineSha256, candidateSha256: payload.candidateSha256,
      diff: { start, endBefore, endAfter, before: originalXml.slice(start, endBefore), after: input.candidateXml.slice(start, endAfter) },
      operation: "replace_existing", compileScope: "hmi_software", saveProject: input.saveProject,
      saveScope: input.saveProject ? "Entire attached project, including other existing unsaved changes." : "Do not save the project.",
      backup: "Original native object saved before import; not a whole-project backup.",
      rollback: "No automatic rollback. Failure requires readback and a new plan.",
      approvalRequired: true, liveWritePerformed: false };
  }
  consume(token: string, planSha256: string) {
    return this.plans.consume(token, planSha256);
  }
}
