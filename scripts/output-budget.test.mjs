import assert from "node:assert/strict";
import { measure } from "./output-budget-utils.mjs";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { assembleSnapshotResult } from "../dist/snapshot-workflow.js";
import { assembledImportResult, jsonResult } from "../dist/core/results.js";
import { EXECUTION_ANALYZER_VERSION } from "../dist/execution-model.js";
import { reanalyzeSnapshot } from "../dist/reanalyze-snapshot.js";
import { findExportProjectIdentities } from "../dist/export-index.js";

const cwd = path.resolve(import.meta.dirname, "..");
const projectPath = "D:\\Projects\\Line.ap20";
const sequence = (count, fn) => Array.from({ length: count }, (_, i) => fn(i));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const keys = sequence(300, i => "CPU_1\\PLC_1::FC:" + i);
const issues = sequence(400, i => "Network " + i + ": ENO execution requires conservative analysis");
const model = {
  schemaVersion: 1, analyzerVersion: EXECUTION_ANALYZER_VERSION, sourceSignature: "signature",
  blocks: Object.fromEntries(keys.map(key => [key, {}])), callSites: [], writeSites: [], roots: ["Main"],
  unresolvedCalls: sequence(20, i => ({ callerBlockKey: keys[i], calleeName: "External" + i, callId: "call" + i })),
  coverage: { level: "conservative", exactSites: 1206, conservativeSites: 400, unsupportedSites: 0, issues },
  incremental: { changedBlockKeys: [], addedBlockKeys: [], removedBlockKeys: [], reusableBlockKeys: keys, pendingBlockKeys: [] }
};

async function fixture(t) {
  const parent = path.resolve(process.env.TIA_MCP_WORKSPACE_ROOT?.trim() || cwd, "tia-exports");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "_budget-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scope = path.join(root, "Line");
  const dir = path.join(scope, "snapshots", "latest");
  const cache = path.join(dir, "_codex_index");
  await fs.mkdir(cache, { recursive: true });
  const objects = await Promise.all(keys.map(async (_, i) => {
    const name = "MotorValve" + i, relativePath = name + ".xml";
    const xml = '<Document><SW.Blocks.FC><AttributeList><Name>' + name + '</Name></AttributeList></SW.Blocks.FC></Document>';
    await fs.writeFile(path.join(dir, relativePath), xml);
    return { resourceKind: "block", blockKind: "FC", kind: "FC", number: String(i), softwarePath: "PLC_1",
      name, relativePath, programmingLanguage: "LAD", sha256: digest(xml), bytes: xml.length, status: "exported" };
  }));
  const inventory = { plcSoftwareCount: 1, traversalErrorCount: 0 };
  const manifest = JSON.stringify({ schemaVersion: "1.0", snapshotKind: "tia_openness_full_plc_snapshot",
    createdAtUtc: "2026-11-05T00:00:00.000Z", snapshotId: "latest", status: "consistent_complete", complete: true, publicationState: "candidate_not_current",
    project: { canonicalProjectPath: projectPath, name: "Line" }, objects, inventory: { before: inventory, after: inventory },
    consistency: { consistent: true, publishAllowed: true, plcSoftwareIdentityMatches: true, inventoryTraversalComplete: true },
    summary: { exportableCount: 300, exportedCount: 300, exportErrorCount: 0 },
    safety: { projectMutation: false, plcAccessed: false }, openness: { attachCount: 1 } });
  await fs.writeFile(path.join(dir, "manifest.json"), manifest);
  const pointer = { schemaVersion: "1.0", snapshotId: "latest", snapshotRelativePath: "snapshots/latest",
    manifestRelativePath: "snapshots/latest/manifest.json", manifestSha256: digest(manifest),
    complete: true, status: "snapshot_analyzed_with_coverage_gaps", analysis: {
      executionAnalyzerVersion: model.analyzerVersion, fullyUnderstood: false, sourceSignature: model.sourceSignature } };
  const current = path.join(scope, "current.json");
  await fs.writeFile(current, JSON.stringify(pointer));
  const index = { projectName: "Line", projectPath, exportDir: dir, source: "official_openness_snapshot",
    snapshotId: "latest", snapshotComplete: true, snapshotManifestSha256: digest(manifest), items: objects,
    calls: sequence(20, i => ({ source: "MotorValve125", target: "MotorValve" + i, sourceKind: "FC" })),
    analysis: { ...pointer.analysis, executionModelPath: "_codex_index/tia-execution-model.json", coverage: model.coverage } };
  const indexPath = path.join(cache, "tia-export-index.json"), modelPath = path.join(cache, "tia-execution-model.json");
  await fs.writeFile(indexPath, JSON.stringify(index));
  await fs.writeFile(modelPath, JSON.stringify(model));
  return { root, scope, dir, indexPath, modelPath, pointer, current, index, objects };
}

test("default MCP text budgets on a 300-block snapshot and 20 archived indexes", async t => {
  const { root, scope, dir, index } = await fixture(t);
  for (const folder of [...sequence(20, i => path.join(scope,"snapshots","history" + i)), path.join(root,"_test","Line")]) {
    await fs.mkdir(path.join(folder,"_codex_index"), { recursive: true });
    await fs.writeFile(path.join(folder,"_codex_index","tia-export-index.json"), JSON.stringify(index));
  }
  const client = new Client({ name: "output-budget", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], cwd, stderr: "pipe" }));
  t.after(() => client.close());
  for (const [name, args] of [
    ["tia_list_export_indexes", { roots: [root] }], ["tia_read_export_index", { exportDir: dir }],
    ["tia_search_export", { exportDir: dir, query: "MotorValve125", in: "inventory" }],
    ["tia_search_export", { exportDir: dir, query: "MotorValve125", in: "references" }],
    ["tia_trace_call_graph", { exportDir: dir, name: "MotorValve125" }],
    ["tia_read_block", { exportDir: dir, name: "MotorValve125", view: "context" }],
    ["tia_hmi_authoring_capabilities", {}]
  ]) {
    const result = await client.callTool({ name, arguments: args });
    measure(name, result, !name.includes("_hmi_"));
    if (name === "tia_list_export_indexes") assert.deepEqual(result.structuredContent.omitted,
      { historySnapshots: 20, filteredOut: 0, beyondMaxResults: 0, testDirectories: 1 });
  }
});

test("export and import result assemblers stay within the default text budget", () => {
  const args = { executionBuild: { executionModel: model, xmlReadErrors: [], previousSnapshotReused: true },
    snapshotResult: { core: {}, publishedPath: "snapshot", index: { items: keys, itemCount: 300, calls: [], errorCount: 0 } },
    fullyUnderstood: false, executionComplete: true, analyzedStatus: "snapshot_analyzed_with_coverage_gaps",
    exactLiveIdentity: { identitySource: "current_ui_context", processId: 1, projectPath }, referenceBuild: null };
  const summary = assembleSnapshotResult(args);
  measure("tia_export_project_index", jsonResult(summary));
  assert.equal(summary.executionModel.coverage.issuesSample.length, 10);
  assert.equal(summary.executionModel.unresolvedCallsSample.length, 5);
  assert.equal(summary.executionModel.incremental.reusable, 300);
  assert.deepEqual(assembleSnapshotResult({ ...args, detail: "full" }).executionModel.coverage, model.coverage);
  const pendingBlockKeys = keys.slice(0, 25);
  const incremental = { ...model.incremental, changedBlockKeys: keys.slice(0, 20), addedBlockKeys: keys.slice(0, 21), pendingBlockKeys };
  const partial = assembleSnapshotResult({ ...args, executionBuild: { ...args.executionBuild, executionModel: { ...model, incremental } } });
  assert.deepEqual(partial.executionModel.incremental.changedBlockKeys, keys.slice(0, 20));
  assert.equal(partial.executionModel.incremental.addedBlockKeys, undefined);
  assert.deepEqual(partial.executionModel.incremental.pendingBlockKeys, pendingBlockKeys);
  for (const name of ["tia_apply_import"]) {
    const process = { exitCode: 0, stdout: "x".repeat(20000), stderr: "diagnostic" };
    const result = assembledImportResult(process, { summary: { changedTargets: keys.slice(0, 5) }, independentReadback: { ok: true } });
    measure(name, result);
    assert.equal(result.structuredContent.stdout, undefined);
    assert.equal(result.structuredContent.stderr, "diagnostic");
    for (const [code, summary] of [[1, {}], [0, null]]) {
      assert.equal(assembledImportResult({ ...process, exitCode: code }, { summary }).structuredContent.stdout.length, 4000);
    }
  }
});

test("offline reanalysis refuses tampering and concurrent publication, then restores automatic discovery", async t => {
  const { scope, dir, indexPath, modelPath, current, pointer, objects } = await fixture(t);
  await fs.writeFile(modelPath, JSON.stringify({ ...model, analyzerVersion: "0.4.0" }));
  assert.equal((await findExportProjectIdentities([scope], 10)).length, 0);
  const xml = path.join(dir, objects[0].relativePath), original = await fs.readFile(xml);
  const files = [current, indexPath, modelPath, path.join(dir,"manifest.json"), ...objects.map(o => path.join(dir,o.relativePath))];
  const hashes = () => Promise.all(files.map(async file => digest(await fs.readFile(file))));
  await fs.writeFile(xml, Buffer.alloc(original.length, 32));
  const before = await hashes();
  const refused = await reanalyzeSnapshot({ exportDir: dir });
  assert.match(refused.error, /SHA-256/);
  assert.deepEqual(await hashes(), before);
  await fs.writeFile(xml, original);
  const previous = await hashes();
  // Replace current immediately after the reanalyzer reads its baseline bytes.
  const read = fs.readFile;
  let switched = false;
  fs.readFile = async (file, ...rest) => {
    const bytes = await read(file, ...rest);
    if (file === current && !switched) { switched = true; await fs.writeFile(current, JSON.stringify({ ...pointer, snapshotId: "new" })); }
    return bytes;
  };
  syncBuiltinESMExports();
  try { assert.equal((await reanalyzeSnapshot({ projectScopeDir: scope })).status, "snapshot_finalize_conflict"); }
  finally { fs.readFile = read; syncBuiltinESMExports(); }
  assert.equal(JSON.parse(await read(current)).snapshotId, "new");
  assert.deepEqual((await hashes()).slice(1), previous.slice(1));
  await fs.writeFile(current, JSON.stringify(pointer));
  const success = await reanalyzeSnapshot({ exportDir: dir });
  assert.equal(success.ok, true, JSON.stringify(success));
  assert.equal(success.verifiedObjects, 300);
  assert.equal((await findExportProjectIdentities([scope], 10))[0].publication.state, "current");
  assert.deepEqual((await hashes()).slice(3), previous.slice(3));
});
