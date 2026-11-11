import path from "node:path";
import os from "node:os";
import { lstat, realpath, rm } from "node:fs/promises";
import { sameCanonicalPath, sha256File } from "./core/local-paths.js";
import { objectRecord, type JsonValue } from "./core/results.js";
import { runProcess } from "./core/process.js";
import { parseImporterReport } from "./core/importer-output.js";
import { liveCoreOptions, liveCoreSessionMatches } from "./live-session.js";
import { queryTiaLiveCore } from "./tia-live-core.js";

export type SignatureTarget = { xml: string; sha256: string; kind: string; number: string; name: string };
export type SignatureSession = { processId: number; processStartTimeUtc: string; projectPath: string };
export class SignatureMismatchError extends Error {}

export async function residentSignatures(exe: string, session: SignatureSession, targets: SignatureTarget[], timeoutMs: number, compare = false) {
  if (!/\.ap20$/i.test(session.projectPath)) return null;
  const options = { ...liveCoreOptions(Math.min(timeoutMs, 60_000)), existingOnly: true };
  const verified = await queryTiaLiveCore({ operation: "verify_session", ...session }, options);
  if (!verified.ok || !liveCoreSessionMatches(verified, session.processId, session.projectPath, session.processStartTimeUtc)) {
    throw new Error("Resident session not verified: " + String(verified.error ?? verified.status ?? "identity mismatch"));
  }
  const exported = await queryTiaLiveCore({ operation: "export_blocks_for_signature", ...session,
    targets: targets.map(({ kind, name, number }) => ({ kind, name, number })) }, options);
  const directory = typeof exported.directory === "string" ? exported.directory : "";
  // The core owns only UUID children of this fixed temporary root. Compare real paths:
  // os.tmpdir() can be an 8.3 short path (for example ...\LONGNA~1\...) while the core reports the long one.
  const root = path.join(os.tmpdir(), "TiaLiveReadCore-v1");
  if (!directory || !path.isAbsolute(directory) || !/^[0-9a-f]{32}$/i.test(path.basename(directory))) {
    throw new Error("Invalid signature-export temporary directory: " + (directory || "<missing>"));
  }
  if ((await lstat(root)).isSymbolicLink() || (await lstat(directory)).isSymbolicLink()) {
    throw new Error("Redirected signature-export directory.");
  }
  const canonicalDirectory = await realpath(directory);
  if (path.basename(canonicalDirectory).toLowerCase() !== path.basename(directory).toLowerCase() ||
      !sameCanonicalPath(path.dirname(canonicalDirectory), await realpath(root))) {
    throw new Error("Signature-export directory is outside the core temporary root: " + canonicalDirectory);
  }
  try {
    if (!exported.ok || !liveCoreSessionMatches(exported, session.processId, session.projectPath, session.processStartTimeUtc) ||
        !Array.isArray(exported.items) || exported.items.length !== targets.length) throw new Error("Export session or target count changed.");
    const files: string[] = [];
    const exportedItems = exported.items;
    const rows = targets.map(target => {
      const matches = exportedItems.filter((raw: unknown) => {
        const row = objectRecord(raw);
        return row?.kind === target.kind && row.name === target.name && row.number === target.number;
      });
      if (matches.length !== 1) throw new Error("Missing or ambiguous signature target.");
      return objectRecord(matches[0])!;
    });
    for (const row of rows) {
      const file = String(row.path);
      if (!sameCanonicalPath(path.dirname(await realpath(file)), canonicalDirectory) || !sameCanonicalPath(await realpath(file), path.join(canonicalDirectory, path.basename(file))) ||
          (await lstat(file)).isSymbolicLink() || await sha256File(file) !== row.sha256) throw new Error("Exported XML integrity failed.");
      files.push(await realpath(file));
    }
    if (compare) files.push(...await Promise.all(targets.map(target => realpath(target.xml))));
    const result = await runProcess(exe, ["--signature-only", "--files", JSON.stringify(files)], timeoutMs, "tree-force");
    const report = parseImporterReport(result, "Offline signature");
    if (result.exitCode !== 0 || report?.ok !== true || report.status !== "offline_signatures" ||
        !Array.isArray(report.items) || report.items.length !== files.length) throw new Error("Offline signature operation unavailable.");
    const signatures = report.items.map((raw, i) => {
      const row = objectRecord(raw);
      const target = targets[i % targets.length];
      const expectedHash = i < targets.length ? rows[i].sha256 : target.sha256;
      if (!row || row.kind !== target.kind || row.name !== target.name || row.number !== target.number ||
          !sameCanonicalPath(String(row.path), files[i]) || row.sha256 !== expectedHash ||
          !/^[a-f0-9]{64}$/.test(String(row.targetSignature)) || !/^[a-f0-9]{64}$/.test(String(row.programSignature))) {
        throw new SignatureMismatchError("Offline signature result differs from verified XML identity.");
      }
      return row;
    });
    if (compare && signatures.slice(0, targets.length).some((row, i) => row.programSignature !== signatures[i + targets.length].programSignature)) {
      throw new Error("Resident readback program signature differs; require independent importer readback.");
    }
    return {
      signatures: signatures.slice(0, targets.length).map(row => String(row.targetSignature)),
      // Only the identity: callers may pass a whole plan as the session.
      report: { processId: session.processId, processStartTimeUtc: session.processStartTimeUtc, projectPath: session.projectPath,
        attempted: true, ok: true, programContentMatches: true, readbackSource: "resident_core" } as Record<string, JsonValue>
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Never throws: a failed resident readback falls back to the importer, with the reason recorded.
export async function tryResidentReadback(exe: string, session: SignatureSession, targets: SignatureTarget[], timeoutMs: number):
  Promise<{ report: Record<string, JsonValue> | null; fallbackReason: string }> {
  try {
    const result = await residentSignatures(exe, session, targets, timeoutMs, true);
    return result ? { report: result.report, fallbackReason: "" } : { report: null, fallbackReason: "Not a V20 project." };
  } catch (error) {
    return { report: null, fallbackReason: error instanceof Error ? error.message : String(error) };
  }
}
