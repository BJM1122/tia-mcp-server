import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import { copyFile, cp, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
const execFileAsync = promisify(execFile);
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { evaluateSelfTest, providerOrder, summarizePortalReadiness } from "../dist/native-capabilities.js";
import {
  componentAllowed, componentExe, componentSources, componentExeName, componentHomeVersion, componentsForVersion, NATIVE_COMPONENTS, parsePortalVersions,
  portalVersion
} from "../dist/tia-version.js";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const line = value => JSON.stringify(value);
const target = (version, apiAssembly, apiFeatures = [...portalVersion(version).apiFeatures]) =>
  ({ portalVersion: version, apiAssembly, projectExtension: ".apX", apiFeatures });

test("the component table is shared, validated and names executables like the build", () => {
  const text = readFileSync(path.join(serverRoot, "portal-versions.json"), "utf8");
  const mutate = change => { const data = JSON.parse(text); change(data); return JSON.stringify(data); };
  assert.throws(() => parsePortalVersions(mutate(d => { d.components[0].selfTestArgs = ["--self-test"]; })), /component 0 has an invalid selfTestArgs/);
  assert.throws(() => parsePortalVersions(mutate(d => { d.components[1].outputDir = "C:\\elsewhere"; })), /invalid outputDir/);
  assert.throws(() => parsePortalVersions(mutate(d => { d.components[1].baseName = d.components[0].baseName; })), /duplicate component baseName/);
  assert.throws(() => parsePortalVersions(mutate(d => { delete d.components; })), /expected components/);
  assert.throws(() => parsePortalVersions(mutate(d => { d.components[0].adapters = []; })), /component 0 has an invalid adapters/);
  assert.throws(() => parsePortalVersions(mutate(d => { d.components[0].adapters = ["live-core", "live-core"]; })), /invalid adapters/);
  assert.throws(() => parsePortalVersions(mutate(d => { d.components[0].adapters = ["plcsim"]; })), /invalid adapters/);
  // API features: a declared vocabulary, so a typo cannot silently compile a fallback.
  assert.throws(() => parsePortalVersions(mutate(d => { d.versions[0].apiFeatures.push("cross_refrence"); })), /version 0 has an invalid apiFeatures/);
  assert.throws(() => parsePortalVersions(mutate(d => { d.versions[0].apiFeatures.push(d.versions[0].apiFeatures[0]); })), /invalid apiFeatures/);
  assert.throws(() => parsePortalVersions(mutate(d => { delete d.versions[1].apiFeatures; })), /version 1 has an invalid apiFeatures/);
  assert.throws(() => parsePortalVersions(mutate(d => { d.apiFeatureNames.push("Cross-Reference"); })), /apiFeatureNames/);
  assert.deepEqual(portalVersion("V15.1").apiFeatures, []);
  assert.ok(portalVersion("V20").apiFeatures.length === parsePortalVersions(text).apiFeatureNames.length, "V20 has every feature");

  // The importer serves both families, but a version gets it only once its row allows block_import.
  const rows = table => Object.fromEntries(table.versions.map(v => [v.id, v]));
  const parts = table => Object.fromEntries(table.components.map(c => [c.id, c]));
  const today = parsePortalVersions(text);
  assert.equal(componentAllowed(parts(today).importer, rows(today)["V15.1"]), true);
  assert.equal(componentAllowed(parts(today).importer, rows(today).V20), true);
  const withoutImport = parsePortalVersions(mutate(d => {
    const profile = d.versions.find(v => v.id === "V15.1");
    profile.capabilities = profile.capabilities.filter(c => c !== "block_import");
  }));
  assert.equal(componentAllowed(parts(withoutImport).importer, rows(withoutImport)["V15.1"]), false);
  assert.equal(componentAllowed(parts(today).hmi, rows(today)["V15.1"]), false);
  assert.equal(componentAllowed(parts(today).importer, rows(today).V16), false);

  // Once V15.1 also allows live_query (P4b), snapshots still go to the dedicated
  // v15-snapshot companion first; the live core only follows as a fallback.
  const withLive = parsePortalVersions(mutate(d => { d.versions.find(v => v.id === "V15.1").capabilities.push("live_query"); }));
  const v15Components = withLive.components.filter(c => componentAllowed(c, rows(withLive)["V15.1"]));
  assert.deepEqual(v15Components.map(c => c.id), ["live-core", "importer", "v15-snapshot"]);
  assert.deepEqual(providerOrder(v15Components, "snapshot_export").map(c => c.id), ["v15-snapshot", "live-core", "importer"]);
  assert.deepEqual(providerOrder(v15Components, "live_query").map(c => c.id), ["live-core", "importer", "v15-snapshot"]);
  assert.deepEqual(providerOrder(componentsForVersion("V20"), "snapshot_export").map(c => c.id), ["live-core", "importer", "hmi"]);

  assert.deepEqual(NATIVE_COMPONENTS.map(c => c.id), ["live-core", "importer", "hmi", "v15-snapshot"]);
  assert.deepEqual(componentsForVersion("V20").map(c => c.id), ["live-core", "importer", "hmi"]);
  assert.deepEqual(componentsForVersion("V15.1").map(c => c.id), ["importer", "v15-snapshot"]);
  assert.deepEqual(componentsForVersion("V16"), []);
  assert.equal(componentHomeVersion("live-core"), "V20");
  assert.equal(componentHomeVersion("v15-snapshot"), "V15.1");
  assert.equal(componentExeName("live-core", "V20"), "TiaLiveReadCore.exe");
  assert.equal(componentExeName("live-core", "V16"), "TiaLiveReadCore.v16.exe");
  assert.equal(componentExeName("v15-snapshot", "V15.1"), "TiaV15Snapshot.exe");
  assert.equal(componentExeName("importer", "V15.1"), "TiaOpennessImportBlock.v15_1.exe");
  assert.equal(componentExe("importer", "V20", "D:\\pkg", {}), path.join("D:\\pkg", "tools", "TiaOpennessImportBlock.exe"));
  // The env override applies to the home version only, never to another version's build.
  assert.equal(componentExe("live-core", "V20", "D:\\pkg", { TIA_MCP_LIVE_CORE_EXE: "E:\\core.exe" }), "E:\\core.exe");
  assert.equal(componentExe("live-core", "V16", "D:\\pkg", { TIA_MCP_LIVE_CORE_EXE: "E:\\core.exe" }), path.join("D:\\pkg", "tools", "TiaLiveReadCore.v16.exe"));
});

test("a self-test counts only for the exact version and API it was built for", () => {
  const passing = { ok: true, status: "self_test_passed", target: target("V20", "20.0"), capabilities: ["live_query", "live_query", "navigation"] };
  assert.deepEqual(evaluateSelfTest("V20", 0, `log line\n${line(passing)}\n`), { ok: true, capabilities: ["live_query", "navigation"] });
  // HMI-style result without a status field.
  assert.equal(evaluateSelfTest("V20", 0, line({ ok: true, target: target("V20", "20.0"), capabilities: ["hmi_export"] })).ok, true);
  const rejected = [
    ["V15.1", 0, passing, /targets V20, not V15\.1/],
    ["V20", 0, { ...passing, target: target("V20", "19.0") }, /API assembly 19\.0/],
    ["V20", 0, { ...passing, target: undefined }, /targets no version/],
    ["V20", 1, passing, /exit 1/],
    ["V20", 0, { ...passing, ok: false }, /Self-test failed/],
    ["V20", 0, { ...passing, status: "self_test_failed" }, /Unexpected self-test status/],
    ["V20", 0, { ...passing, capabilities: [] }, /no capabilities/],
    ["V20", 0, { ...passing, capabilities: ["download"] }, /unknown/],
    // A V20 build that silently compiled a fallback (missing feature) is not V20's build.
    ["V20", 0, { ...passing, target: target("V20", "20.0", ["object_identifier"]) }, /built with API features \[object_identifier\]/],
    ["V20", 0, { ...passing, target: { ...target("V20", "20.0"), apiFeatures: undefined } }, /API features \[unknown\]/],
    ["V15.1", 0, { ...passing, target: target("V15.1", "15.1", ["cross_reference"]) }, /V15\.1 lists \[\]/]
  ];
  for (const [version, exit, value, reason] of rejected) {
    const judged = evaluateSelfTest(version, exit, line(value));
    assert.equal(judged.ok, false, JSON.stringify(value));
    assert.match(judged.reason, reason);
  }
  assert.match(evaluateSelfTest("V20", 0, "not json").reason, /not a JSON object/);
});

const built = ["TiaLiveReadCore.exe", "TiaHmiNative.exe", "TiaV15Snapshot.exe"].every(name => existsSync(path.join(serverRoot, "tools", name)))
  && existsSync(path.join(serverRoot, "tools", "TiaOpennessImportBlock.exe"));

test("validate_environment reports declared and self-test-verified capabilities per version", {
  skip: built ? false : "Native companions are not built (npm run build:production)."
}, async t => {
  const client = new Client({ name: "native-capabilities-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(serverRoot, "dist", "index.js")], cwd: serverRoot }));
  try {
    const result = await client.callTool({ name: "tia_doctor", arguments: { portalVersion: "V20" } });
    const versions = Object.fromEntries(result.structuredContent.environment.portalVersions.map(v => [v.id, v]));
    // Sources edited since the last native build: the report is correct, but not this test's subject.
    const stale = Object.values(versions).flatMap(v => v.components).filter(c => c.status === "stale");
    if (stale.length) { t.skip(`Rebuild native companions first (npm run build:production): ${stale.map(c => c.component).join(", ")} stale.`); return; }
    for (const id of ["V20", "V15.1"]) {
      const version = versions[id];
      if (!version.apiDll) continue; // Openness for this version is not installed here.
      assert.deepEqual([...version.capabilities].sort(), [...version.declaredCapabilities].sort(), JSON.stringify(version, null, 2));
      assert.ok(version.components.length > 0 && version.components.every(c => c.status === "verified"));
      assert.deepEqual(version.undeclaredReported, []);
    }
    assert.deepEqual(versions.V16.capabilities, []);
    assert.deepEqual(versions.V16.components, []);
  } finally {
    await client.close();
  }
});

test("doctor ignores absent API versions but reports unavailable capabilities of installed versions", () => {
  const version = { id: "V15.1", apiDll: "D:/api.dll", adapter: "v15-snapshot",
    unverifiedCapabilities: [{ capability: "block_import", reason: "importer: older than its sources" }] };
  assert.deepEqual(summarizePortalReadiness([version]), {
    status: "degraded", unavailableCapabilities: [{ portalVersion: "V15.1", ...version.unverifiedCapabilities[0] }]
  });
  for (const status of ["stale", "missing", "self_test_failed"]) {
    const broken = { ...version, unverifiedCapabilities: [{ capability: "snapshot_export", reason: "v15-snapshot: " + status }] };
    assert.equal(summarizePortalReadiness([broken]).status, "degraded");
  }
  const missingApi = { ...version, apiDll: null };
  assert.equal(summarizePortalReadiness([missingApi]).status, "unavailable");
  assert.deepEqual(summarizePortalReadiness([{ ...version, unverifiedCapabilities: [] }, missingApi]),
    { status: "ready", unavailableCapabilities: [] });
});

// Production companions (npm run build:production) are copied or executed by the next two tests.
const productionBuilt = ["V20", "V15.1"].every(version => componentsForVersion(version)
  .every(component => existsSync(componentExe(component.id, version, serverRoot, {}))));

test("CLI and MCP doctor name an isolated component older than shared inputs and report degraded", {
  skip: process.platform !== "win32" ? true : productionBuilt ? false : "Native companions are not built (npm run build:production).", timeout: 60000
}, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "tia-doctor-stale-"));
  const root = path.join(temp, "package");
  t.after(() => rm(temp, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  await cp(path.join(serverRoot, "dist"), path.join(root, "dist"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"type":"module"}');
  await symlink(path.join(serverRoot, "node_modules"), path.join(root, "node_modules"), "junction");
  const old = new Date("2021-01-01"), commonTime = new Date("2022-01-01"), fresh = new Date("2023-01-01");
  const copy = async (from, to, time) => {
    await mkdir(path.dirname(to), { recursive: true }); await copyFile(from, to); await utimes(to, time, time);
  };
  for (const relative of ["portal-versions.json", "live-core/Common/TiaNativeTarget.cs", "tools/Build-TiaNative.ps1"]) {
    await copy(path.join(serverRoot, relative), path.join(root, relative), commonTime);
  }
  await copy(path.join(serverRoot, "tools/Get-TiaPortalUiContext.ps1"), path.join(root, "tools/Get-TiaPortalUiContext.ps1"), old);
  for (const component of NATIVE_COMPONENTS) {
    const from = componentSources(component.id, serverRoot), to = componentSources(component.id, root);
    for (let i = 0; i < from.length; i++) await copy(from[i], to[i], old);
  }
  for (const version of ["V20", "V15.1"]) for (const component of componentsForVersion(version)) {
    await copy(componentExe(component.id, version, serverRoot, {}),
      componentExe(component.id, version, root, {}), component.id === "hmi" ? old : fresh);
  }
  const env = { ...process.env, TIA_MCP_LIVE_CORE_EXE: componentExe("live-core", "V20", root, {}),
    TIA_MCP_V15_1_SNAPSHOT_EXE: componentExe("v15-snapshot", "V15.1", root, {}),
    TIA_MCP_UI_CONTEXT_SCRIPT: path.join(root, "tools/Get-TiaPortalUiContext.ps1") };
  const check = report => {
    assert.equal(report.ok, false); assert.equal(report.status, "degraded");
    assert.equal(report.checks.ready, false); assert.equal(report.capabilityReport.status, "degraded");
    const v20 = report.portalVersions.find(v => v.id === "V20");
    assert.equal(v20.components.find(c => c.component === "hmi").status, "stale");
    assert.ok(report.unavailableCapabilities.some(c => c.portalVersion === "V20" && c.capability === "hmi_authoring" && /hmi:.*older than its sources/.test(c.reason)));
    assert.deepEqual(report.guarantees, { tiaAttached: false, residentWorkerStarted: false, projectModified: false, plcAccessed: false });
  };
  await assert.rejects(execFileAsync(process.execPath, [path.join(root, "dist/index.js"), "--doctor"],
    { env, windowsHide: true }), error => { assert.equal(error.code, 2); check(JSON.parse(error.stdout)); return true; });
  const client = new Client({ name: "isolated-doctor-test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist/index.js")], env, cwd: root }));
  try { check((await client.callTool({ name: "tia_doctor", arguments: {} })).structuredContent); }
  finally { await client.close(); }
});

test("V15.1 and V20 share the offline signature implementation without attaching to TIA", {
  skip: process.platform !== "win32" ? true : productionBuilt ? false : "Native companions are not built (npm run build:production)."
}, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "tia-signature-versions-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const xml = path.join(temp, "block.xml");
  await writeFile(xml, '<Document><SW.Blocks.FC ID="0"><AttributeList><Name>Offline</Name><Number>1</Number><ProgrammingLanguage>LAD</ProgrammingLanguage></AttributeList><ObjectList /></SW.Blocks.FC></Document>');
  const results = await Promise.all(["V15.1", "V20"].map(async version => {
    const output = await execFileAsync(componentExe("importer", version, serverRoot, {}),
      ["--signature-only", "--files", JSON.stringify([xml])], { windowsHide: true, timeout: 10000 });
    const report = JSON.parse(output.stdout.replace(/^\uFEFF/, "").trim());
    assert.equal(report.ok, true); assert.equal(report.status, "offline_signatures");
    assert.match(report.items[0].targetSignature, /^[a-f0-9]{64}$/);
    assert.match(report.items[0].programSignature, /^[a-f0-9]{64}$/);
    return report.items;
  }));
  assert.deepEqual(results[0], results[1]);
});
