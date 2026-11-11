// Contract between the TypeScript tools and the C# importer, checked without TIA Portal.
// The 0.27.3 import failure came from TS allowing timeoutMs 900000 while the importer
// refused anything above 600000; these tests read the importer source so that drift fails here.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  IMPORTER_MAX_TIMEOUT_MS,
  IMPORTER_WATCHDOG_EXIT,
  classifyImporterFailure,
  parseImporterReport
} from "../dist/core/importer-output.js";
import { MAX_APPLY_TIMEOUT_MS } from "../dist/tools/plc-import.js";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const importerSource = path.join(serverRoot, "live-core", "TiaOpennessImportBlock.cs");

test("the importer's MaxTimeoutMs equals the TypeScript bound", async () => {
  const source = await readFile(importerSource, "utf8");
  const match = /const int MaxTimeoutMs = (\d+);/.exec(source);
  assert.ok(match, "MaxTimeoutMs not found in TiaOpennessImportBlock.cs");
  assert.equal(Number(match[1]), IMPORTER_MAX_TIMEOUT_MS);
  assert.equal(MAX_APPLY_TIMEOUT_MS, IMPORTER_MAX_TIMEOUT_MS);
});

test("every importer mode checks timeout-ms through CheckBounds, with no literal bound", async () => {
  const source = await readFile(importerSource, "utf8");
  assert.doesNotMatch(source, /timeout\s*>\s*\d{4,}/, "a literal timeout bound bypasses MaxTimeoutMs");
  const parses = source.match(/int timeout = Int32\.Parse\(Required\(options, "timeout-ms"\)/g) ?? [];
  const checks = source.match(/^\s*CheckBounds\(pid, timeout\);/gm) ?? [];
  assert.ok(parses.length >= 4, `expected the four import/verify modes, found ${parses.length}`);
  assert.equal(checks.length, parses.length, "each timeout-ms parse must be followed by CheckBounds");
});

test("both import paths roll back through the one budget-checked RollbackCompile", async () => {
  const source = await readFile(importerSource, "utf8");
  const calls = source.match(/RollbackCompile\(software, summary, errors,/g) ?? [];
  assert.equal(calls.length, 2, "single-block and changeset rollbacks must both use RollbackCompile");
  assert.equal((source.match(/skipped_time_budget/g) ?? []).length, 1, "the skip rule lives only in RollbackCompile");
});

test("both apply tools run through runImporterApply", async () => {
  for (const file of ["src/tools/plc-import.ts", "src/tools/plc-import-changeset.ts"]) {
    const source = await readFile(path.join(serverRoot, file), "utf8");
    assert.match(source, /return runImporterApply\(\{/, `${file} must use the shared apply flow`);
    assert.doesNotMatch(source, /runProcess\(/, `${file} must not run the importer itself`);
  }
});

test("the TypeScript apply schemas use the shared bound", async () => {
  for (const file of ["src/tools/plc-import.ts", "src/tools/plc-import-changeset.ts"]) {
    const source = await readFile(path.join(serverRoot, file), "utf8");
    assert.doesNotMatch(source, /\.max\(600_?000\)/, `${file} hard-codes the importer bound`);
  }
});

const out = (exitCode, stdout = "", stderr = "") => ({ exitCode, stdout, stderr });

test("parseImporterReport names the watchdog, empty output and non-JSON output", () => {
  assert.throws(() => parseImporterReport(out(IMPORTER_WATCHDOG_EXIT), "Baseline"), /deadline exceeded \(exit 124\).*Openness access prompt/);
  assert.throws(() => parseImporterReport(out(1, "", "boom"), "Baseline"), /produced no output \(exit 1\).*boom/);
  assert.throws(() => parseImporterReport(out(1, "not json"), "Baseline"), /not JSON/);
  assert.deepEqual(parseImporterReport(out(0, "﻿noise\n{\"ok\":true}\n"), "Baseline"), { ok: true });
});

test("a missing summary means the importer stopped before attaching", () => {
  const rejected = classifyImporterFailure(
    out(1, JSON.stringify({ ok: false, status: "failed", error: "timeout-ms must be between 1000 and 600000 (got 900000)." })),
    null,
    false
  );
  assert.equal(rejected.status, "importer_rejected_before_attach");
  assert.equal(rejected.projectTouched, false);
  assert.match(rejected.importerError, /got 900000/);
});

test("failure statuses after the summary exists", () => {
  assert.equal(classifyImporterFailure(out(1), { status: "refused_new_reason", sourceImportStarted: false }, true).status, "refused_new_reason");
  assert.equal(classifyImporterFailure(out(1), { status: "refused_new_reason", sourceImportStarted: false }, true).projectTouched, false);
  const timedOut = classifyImporterFailure(out(IMPORTER_WATCHDOG_EXIT), { status: "importing", sourceImportStarted: true }, true);
  assert.equal(timedOut.status, "timed_out_indeterminate");
  assert.equal(timedOut.projectTouched, null);
  assert.equal(classifyImporterFailure(out(1), { status: "failed", rollbackAttempted: true, rollbackSucceeded: true }, true).status, "failed_rolled_back");
  assert.equal(classifyImporterFailure(out(1), { status: "failed", rollbackAttempted: true, rollbackSucceeded: false }, true).status, "failed_or_indeterminate");
});
