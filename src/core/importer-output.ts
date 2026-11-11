import { objectRecord } from "./results.js";

// The importer's hard upper bound for --timeout-ms. TiaOpennessImportBlock.cs declares the
// same value as MaxTimeoutMs; scripts/importer-contract.test.mjs fails if they differ.
export const IMPORTER_MAX_TIMEOUT_MS = 600_000;

// The importer's watchdog exit code (Environment.Exit(124)).
export const IMPORTER_WATCHDOG_EXIT = 124;

type ProcessOutput = { exitCode: number | null; stdout: string; stderr: string };

function stderrTail(result: ProcessOutput) {
  const text = result.stderr.trim();
  return text ? ` stderr: ${text.slice(-400)}` : "";
}

/**
 * Parse the importer's last stdout line as JSON. Instead of a bare
 * "Unexpected end of JSON input", say what actually happened: the watchdog
 * fired (often TIA Portal waiting on the Openness access prompt after an
 * importer rebuild), the importer printed nothing, or it printed non-JSON.
 */
export function parseImporterReport(result: ProcessOutput, label: string): Record<string, unknown> {
  if (result.exitCode === IMPORTER_WATCHDOG_EXIT) {
    throw new Error(`${label}: importer deadline exceeded (exit 124). If the importer was just rebuilt, TIA Portal may be waiting for the Openness access prompt.${stderrTail(result)}`);
  }
  const last = result.stdout.replace(/^﻿/, "").trim().split(/\r?\n/).at(-1) ?? "";
  if (!last) throw new Error(`${label}: importer produced no output (exit ${result.exitCode ?? "none"}).${stderrTail(result)}`);
  let parsed: unknown;
  try { parsed = JSON.parse(last); }
  catch { throw new Error(`${label}: importer output is not JSON (exit ${result.exitCode ?? "none"}): ${last.slice(0, 200)}${stderrTail(result)}`); }
  const record = objectRecord(parsed);
  if (!record) throw new Error(`${label}: importer output is not a JSON object.`);
  return record;
}

/** Last-line importer report without throwing; null when absent or unparsable. */
export function tryImporterReport(result: ProcessOutput): Record<string, unknown> | null {
  try { return parseImporterReport(result, "importer"); } catch { return null; }
}

/**
 * Status for an apply that did not verify. Shared by the single-block and changeset tools.
 *
 * The importer writes its summary file before it attaches to TIA Portal, so a missing summary
 * means it stopped while checking arguments: the project was not touched and the token can
 * simply be re-planned. Distinguish that from a watchdog exit and from real indeterminate states.
 */
export function classifyImporterFailure(
  result: ProcessOutput,
  summary: Record<string, unknown> | null,
  summaryFileExists: boolean
): { status: string; importerError: string; projectTouched: boolean | null } {
  const report = tryImporterReport(result);
  const importerError = typeof report?.error === "string" ? report.error : "";
  if (!summaryFileExists) {
    if (result.exitCode === IMPORTER_WATCHDOG_EXIT) {
      return { status: "importer_timed_out_before_attach", importerError: importerError || "Importer deadline exceeded before it wrote a summary.", projectTouched: false };
    }
    return {
      status: "importer_rejected_before_attach",
      importerError: importerError || `Importer exited ${result.exitCode ?? "without a code"} before writing a summary.${stderrTail(result)}`,
      projectTouched: false
    };
  }
  const summaryStatus = typeof summary?.status === "string" ? summary.status : "";
  const importNotStarted = summary?.sourceImportStarted === false || summary?.importStarted === false;
  if (summaryStatus.startsWith("refused_")) return { status: summaryStatus, importerError, projectTouched: importNotStarted ? false : null };
  if (result.exitCode === IMPORTER_WATCHDOG_EXIT) {
    return { status: "timed_out_indeterminate", importerError: importerError || "Importer deadline exceeded; the project state may be indeterminate. Inspect the block in TIA Portal before retrying.", projectTouched: null };
  }
  if (summary?.rollbackAttempted === true && summary?.rollbackSucceeded === true) {
    return { status: "failed_rolled_back", importerError, projectTouched: true };
  }
  return { status: "failed_or_indeterminate", importerError, projectTouched: null };
}
