import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
const exec = promisify(execFile);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const sample = '<Document><DocumentInfo><Created>today</Created></DocumentInfo><SW.Blocks.FC ID="0"><AttributeList><Name>Test</Name><Number>1</Number><ProgrammingLanguage>LAD</ProgrammingLanguage></AttributeList><ObjectList /></SW.Blocks.FC></Document>';


test("offline signature drift fails the native self-test and cannot authorize a plan", { skip: process.platform !== "win32" }, async t => {
  const { resolveApiDll, portalVersion } = await import("../dist/tia-version.js");
  const api = resolveApiDll("V20");
  if (!api) return t.skip("V20 API required for offline native self-test");
  const temp = await mkdtemp(path.join(os.tmpdir(), "tia-signature-drift-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const source = await readFile(path.resolve("live-core", "TiaOpennessImportBlock.cs"), "utf8");
  const needle = '{ "targetSignature", TargetSignature(candidate) }';
  assert.ok(source.includes(needle));
  const mutant = path.join(temp, "mutant.cs"), exe = path.join(temp, "mutant.exe"), target = path.join(temp, "target.cs");
  await writeFile(mutant, source.replace(needle, '{ "targetSignature", new String(\'0\', 64) }'));
  const profile = portalVersion("V20");
  await writeFile(target, "internal static class TiaBuildTarget { public const string PortalVersion=\"V20\"; public const int ApiMajor=20; public const int ApiMinor=0; public const string ProjectExtension=\".ap20\"; public static readonly string[] ApiFeatures = { " + profile.apiFeatures.map(v => JSON.stringify(v)).join(",") + " }; }");
  await exec(path.join(process.env.WINDIR, "Microsoft.NET/Framework64/v4.0.30319/csc.exe"), [
    "/nologo", "/target:exe", "/platform:x64", "/reference:" + api.dllPath,
    "/reference:System.Web.Extensions.dll", "/reference:System.Xml.Linq.dll", "/out:" + exe,
    mutant, target, path.resolve("live-core/Common/TiaNativeTarget.cs")
  ], { windowsHide: true });
  await assert.rejects(exec(exe, ["--self-test", "--api", api.dllPath], { windowsHide: true }), error => {
    const report = JSON.parse(error.stdout.replace(/^\uFEFF/, "").trim());
    assert.equal(report.ok, false); assert.match(report.error, /signature/i); return true;
  });
});

test("resident signatures: exact identity, independent readback and safe legacy fallback (no TIA)", { skip: process.platform !== "win32", timeout: 60000 }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "tia-resident-test-"));
  const oldEnv = { ...process.env };
  const core = path.join(temp, "core.exe"), api = path.join(temp, "api.dll");
  const source = path.join(temp, "candidate.xml");
  await Promise.all([writeFile(core, ""), writeFile(api, ""), writeFile(source, sample)]);
  Object.assign(process.env, { TIA_MCP_LIVE_CORE_EXE: core, TIA_MCP_API_DLL_V20: api, TIA_MCP_OPENNESS_API_DLL: api,
    TIA_MCP_UI_CONTEXT_SCRIPT: path.resolve("scripts/fixtures/Get-FakeTiaPortalUiContext.ps1"),
    TIA_MCP_TEST_UI_CONTEXT_FILE: path.join(temp, "ui.json") });
  const { liveCorePipeName, liveCorePipePath } = await import("../dist/tia-live-core.js");
  const { residentSignatures, tryResidentReadback, SignatureMismatchError } = await import("../dist/resident-signatures.js");
  const { captureImportBaselines } = await import("../dist/import-baseline.js");
  const { resolveWorkflowSession } = await import("../dist/live-session.js");
  const session = { processId: 777, processStartTimeUtc: "2026-11-01T12:00:00.0000000Z", projectPath: "D:/A.ap20" };
  const target = { xml: source, sha256: hash(sample), kind: "FC", name: "Test", number: "1" };
  const native = process.env.TIA_TEST_SIGNATURE_EXE || path.resolve("tools", "TiaOpennessImportBlock.exe");
  const fixture = path.join(temp, "fixture.exe");
  const fixtureSource = path.join(temp, "fixture.cs");
  // An isolated fallback importer; deliberately wrong offline signatures must fail closed.
  await writeFile(fixtureSource, "using System; using System.IO; using System.Linq; using System.Collections.Generic; using System.Web.Script.Serialization;\nclass Fixture {\n  static string Arg(string[] a, string k) { return a[Array.IndexOf(a,k)+1]; }\n  static void Main(string[] a) {\n    var json = new JavaScriptSerializer();\n    if (a.Contains(\"--signature-only\")) {\n      var files=json.Deserialize<string[]>(Arg(a,\"--files\"));\n      Console.WriteLine(json.Serialize(new { ok=true,status=\"offline_signatures\",items=files.Select(f=>new { path=f,sha256=new string('0',64),kind=\"FC\",name=\"Test\",number=\"1\",targetSignature=new string('a',64),programSignature=new string('b',64) }).ToArray() })); return;\n    }\n    var content=(Dictionary<string,object>)json.DeserializeObject(File.ReadAllText(Arg(a,\"--changeset\")));\n    var targets=(object[])content[\"items\"];\n    Console.WriteLine(json.Serialize(new { ok=true,status=\"baseline_captured\",processId=int.Parse(Arg(a,\"--process-id\")),processStartTimeUtc=Arg(a,\"--process-start-time-utc\"),projectPath=Arg(a,\"--project\"),items=targets.Cast<Dictionary<string,object>>().Select(v=>new { kind=v[\"kind\"],name=v[\"name\"],number=v[\"number\"],targetContentSha256=new string('a',64) }).ToArray() }));\n  }\n}");
  await exec(path.join(process.env.WINDIR, "Microsoft.NET/Framework64/v4.0.30319/csc.exe"), ["/nologo", "/reference:System.Web.Extensions.dll", "/out:" + fixture, fixtureSource], { windowsHide: true });
  let mode = "normal", requests = [], owned = [];
  const errors = [], sockets = new Set();
  const responseSession = patch => ({ ...session, canonicalProjectPath: session.projectPath, ...patch });
  const server = net.createServer(socket => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    let input = "";
    socket.on("data", async chunk => {
      input += chunk;
      if (!input.includes("\n")) return;
      try {
        const request = JSON.parse(input.trim()); requests.push(request);
        let response;
        if (request.operation === "ping") response = { ok: true, session: responseSession() };
        else if (request.operation === "verify_session") {
          response = mode === "stale" || mode === "unsupported" ? { ok: false, status: "session_not_prepared" }
            : { ok: true, session: responseSession(mode === "other" ? { canonicalProjectPath: "D:/B.ap20" }
              : mode === "restarted" ? { processStartTimeUtc: "2026-11-02T12:00:00Z" }
              : mode === "pid" ? { processId: 778 } : {}) };
        } else if (request.operation === "export_blocks_for_signature") {
          if (mode === "ambiguous") response = { ok: false, status: "target_ambiguous_or_missing" };
          else {
            const id = randomUUID().replaceAll("-", "");
            let directory = mode === "outside" ? path.join(temp, id) : path.join(os.tmpdir(), "TiaLiveReadCore-v1", id);
            owned.push(directory); await mkdir(directory, { recursive: true });
            // The real core reports the long path even when os.tmpdir() is an 8.3 short path.
            if (mode === "longpath") directory = await realpath(directory);
            const xml = path.join(directory, "0.xml"); await writeFile(xml, sample);
            response = { ok: true, session: responseSession(mode === "race" ? { canonicalProjectPath: "D:/B.ap20" } : {}),
              directory, items: [{ ...target, path: xml, softwarePath: "PLC_1", groupPath: "Blocks" }] };
          }
        } else throw Error("Unexpected operation: " + request.operation);
        socket.end(JSON.stringify({ protocolVersion: request.protocolVersion, requestId: request.requestId, status: "ready", ...response }) + "\n");
      } catch (e) { errors.push(e); socket.destroy(); }
    });
  });
  await new Promise(resolve => server.listen(liveCorePipePath(liveCorePipeName(core, api)), resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
    for (const directory of owned) await rm(directory, { recursive: true, force: true });
    await rm(temp, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  const nativeSkip = existsSync(native) ? false : "Build the importer first (npm run build:production) or set TIA_TEST_SIGNATURE_EXE.";
  await t.test("offline native mode needs no API and computes both original signatures", { skip: nativeSkip }, async () => {
    const output = await exec(native, ["--signature-only", "--files", JSON.stringify([source, source])], { windowsHide: true });
    const parsed = JSON.parse(output.stdout.replace(/^\uFEFF/, "").trim());
    assert.equal(parsed.status, "offline_signatures"); assert.deepEqual(parsed.items[0], parsed.items[1]);
    assert.equal(parsed.items[0].sha256, target.sha256);
    assert.match(parsed.items[0].targetSignature, /^[a-f0-9]{64}$/);
  });
  await t.test("prepared core supplies baseline and independent program readback; temporary XML is removed", { skip: nativeSkip }, async () => {
    assert.ok(await residentSignatures(native, session, [target], 3000));
    const baseline = await captureImportBaselines(native, api, session, [target], 3000);
    assert.equal(baseline.baselineSource, "resident_core");
    assert.match(baseline.signatures[0], /^[a-f0-9]{64}$/);
    assert.equal(baseline.baselineFallbackReason, "");
    const { report, fallbackReason } = await tryResidentReadback(native, session, [target], 3000);
    assert.equal(fallbackReason, "");
    assert.equal(report.readbackSource, "resident_core"); assert.equal(report.programContentMatches, true);
    assert.ok(owned.every(dir => !existsSync(dir)));
  });
  await t.test("the core's long temp path is accepted when os.tmpdir() is a short path", { skip: nativeSkip }, async () => {
    mode = "longpath";
    const baseline = await captureImportBaselines(native, api, session, [target], 3000);
    assert.equal(baseline.baselineSource, "resident_core", baseline.baselineFallbackReason);
    const { report, fallbackReason } = await tryResidentReadback(native, session, [target], 3000);
    assert.equal(fallbackReason, ""); assert.equal(report.readbackSource, "resident_core");
    assert.ok(owned.every(dir => !existsSync(dir)));
    // A whole plan passed as the session must not be copied into the readback report.
    const planLike = await tryResidentReadback(native, { ...session, xmlPath: "D:/big.xml", importerExeSha256: "x" }, [target], 3000);
    assert.deepEqual(Object.keys(planLike.report).sort(), ["attempted", "ok", "processId", "processStartTimeUtc", "programContentMatches", "projectPath", "readbackSource"]);
  });
  await t.test("a directory outside the core temp root is refused with a recorded reason", async () => {
    mode = "outside";
    const baseline = await captureImportBaselines(fixture, api, session, [target], 3000);
    assert.equal(baseline.baselineSource, "importer_attach");
    assert.match(baseline.baselineFallbackReason, /outside the core temporary root/);
    const { report, fallbackReason } = await tryResidentReadback(fixture, session, [target], 3000);
    assert.equal(report, null); assert.match(fallbackReason, /outside the core temporary root/);
    // A refused directory is never deleted by the client; it is not inside the root the core owns.
    const outside = owned.filter(dir => !dir.includes("TiaLiveReadCore-v1"));
    assert.equal(outside.length, 2); assert.ok(outside.every(dir => existsSync(dir)));
    for (const dir of outside) await rm(dir, { recursive: true, force: true });
    owned = owned.filter(dir => !outside.includes(dir));
  });
  for (const scenario of [
    ["other", "another client or TIA window selected another project"],
    ["restarted", "same PID restarted with a different start time"],
    ["pid", "TIA restarted with a new PID"],
    ["stale", "same window closed A and opened B"],
    ["unsupported", "old core has no verify_session"],
    ["race", "another client changed the core between verify and export"],
    ["ambiguous", "duplicate target blocks across PLCs are refused"]
  ]) await t.test(scenario[1] + " falls back without attaching the core", async () => {
    mode = scenario[0]; requests = [];
    const baseline = await captureImportBaselines(fixture, api, session, [target], 3000);
    assert.equal(baseline.baselineSource, "importer_attach");
    assert.deepEqual(baseline.signatures, ["a".repeat(64)]);
    assert.notEqual(baseline.baselineFallbackReason, "");
    const readback = await tryResidentReadback(fixture, session, [target], 3000);
    assert.equal(readback.report, null); assert.notEqual(readback.fallbackReason, "");
    assert.ok(requests.every(r => ["verify_session", "export_blocks_for_signature"].includes(r.operation)));
    if (!["race", "ambiguous"].includes(mode)) assert.ok(requests.every(r => r.operation === "verify_session"));
    assert.ok(owned.every(dir => !existsSync(dir)));
  });
  await t.test("inconsistent offline signatures fail the plan instead of fallback", async () => {
    mode = "normal";
    await assert.rejects(captureImportBaselines(fixture, api, session, [target], 3000), SignatureMismatchError);
  });
  await t.test("requested project guard refuses cached A and reads UI for B", async () => {
    mode = "normal"; requests = [];
    const projectPath = "D:/B.ap20";
    const context = { schemaVersion: "1.0", observedAt: "2026-11-01T12:00:00Z", status: "selected", selectedProcessId: 777,
      processes: [{ ...session, projectPath, projectName: "B", isMinimized: false }],
      selectedObject: { status: "unavailable" }, activeEditor: { status: "unavailable" }, networkOrSection: { status: "unavailable" }, limitations: [] };
    await writeFile(process.env.TIA_MCP_TEST_UI_CONTEXT_FILE, JSON.stringify(context));
    const result = await resolveWorkflowSession({ processId: 777, projectPath, timeoutMs: 5000, maxNodes: 30, maxDepth: 2 });
    assert.equal(result.identitySource, "current_ui_context"); assert.equal(result.projectPath, projectPath);
    assert.deepEqual(requests.map(r => r.operation), ["verify_session"]);
    mode = "stale"; requests = [];
    const stale = await resolveWorkflowSession({ processId: 777, projectPath: session.projectPath, timeoutMs: 5000, maxNodes: 30, maxDepth: 2 });
    assert.equal(stale.identitySource, "current_ui_context"); assert.equal(stale.projectPath, projectPath);
    assert.deepEqual(requests.map(r => r.operation), ["verify_session"]);
  });
  await t.test("V15.1 stays on importer_attach and never probes resident core", async () => {
    requests = [];
    const baseline = await captureImportBaselines(fixture, api, { ...session, projectPath: "D:/A.ap15_1" }, [target], 3000);
    assert.equal(baseline.baselineSource, "importer_attach"); assert.deepEqual(requests, []);
  });
  await t.test("doctor reports only a surviving retired PID with matching process start", async () => {
    const { oldResidentProcesses } = await import("../dist/environment.js");
    const start = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "(Get-Process -Id " + process.pid + ").StartTime.ToUniversalTime().ToString('o')"], { windowsHide: true });
    const marker = path.join(temp, "stale-live-core-processes.json");
    await writeFile(marker, JSON.stringify([
      { processId: process.pid, processStartTimeUtc: start.stdout.trim() },
      { processId: process.pid, processStartTimeUtc: "2000-01-01T00:00:00Z" },
      { processId: 2147483646, processStartTimeUtc: start.stdout.trim() }
    ]));
    const found = await oldResidentProcesses();
    assert.deepEqual(found, [{ processId: process.pid, message: "An old live-core process from a replaced build is still running." }]);
  });
  await t.test("missing core falls back to the existing importer path without starting a core", async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    const baseline = await captureImportBaselines(fixture, api, session, [target], 3000);
    assert.equal(baseline.baselineSource, "importer_attach");
  });
});
