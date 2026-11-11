import { residentSignatures, SignatureMismatchError } from "./resident-signatures.js";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sameCanonicalPath } from "./core/local-paths.js";
import { runProcess } from "./core/process.js";
import { parseImporterReport } from "./core/importer-output.js";

type Target = { xml: string; sha256: string; kind: string; number: string; name: string };
type Session = { processId: number; processStartTimeUtc: string; projectPath: string };

// The native helper returns results in import order. Match by identity rather than
// position so the token remains bound to the caller's original block order.
export async function captureImportBaselines(exe: string, api: string, session: Session, items: Target[], timeoutMs: number) {
  const started = performance.now();
  let baselineFallbackReason = "Not a V20 project.";
  try {
    const resident = await residentSignatures(exe, session, items, timeoutMs);
    if (resident) return { signatures: resident.signatures, elapsedMs: Math.round(performance.now() - started), baselineSource: "resident_core", baselineFallbackReason: "" };
  } catch (error) {
    if (error instanceof SignatureMismatchError) throw error;
    baselineFallbackReason = error instanceof Error ? error.message : String(error);
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "tia-plan-baseline-"));
  try {
    const manifest = path.join(directory, "targets.json");
    const contents = JSON.stringify({ items });
    await writeFile(manifest, contents, { flag: "wx" });
    const result = await runProcess(exe, [
      "--baseline-only", "--verify-only", "--changeset", manifest,
      "--changeset-sha256", createHash("sha256").update(contents).digest("hex"),
      "--api", api, "--project", session.projectPath, "--process-id", String(session.processId),
      "--process-start-time-utc", session.processStartTimeUtc, "--out", path.join(directory, "readback"),
      "--timeout-ms", String(timeoutMs)
    ], timeoutMs + 1000, "tree-force");
    const report = parseImporterReport(result, "Baseline capture") as Record<string, any>;
    if (result.exitCode !== 0 || report.ok !== true || report.status !== "baseline_captured" ||
        report.processId !== session.processId || report.processStartTimeUtc !== session.processStartTimeUtc ||
        typeof report.projectPath !== "string" || !sameCanonicalPath(report.projectPath, session.projectPath) ||
        !Array.isArray(report.items) || report.items.length !== items.length) {
      throw new Error(report.error || "Target baseline capture failed or session identity changed.");
    }
    const signatures = items.map(target => {
      const matches = report.items.filter((row: Target) => row.kind === target.kind &&
        row.name === target.name && row.number === target.number);
      const hash = matches[0]?.targetContentSha256;
      if (matches.length !== 1 || typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) {
        throw new Error("Missing target baseline for " + target.name);
      }
      return hash;
    });
    return { signatures, elapsedMs: Math.round(performance.now() - started), baselineSource: "importer_attach", baselineFallbackReason };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
