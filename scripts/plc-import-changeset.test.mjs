import { measure } from "./output-budget-utils.mjs";
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

// A fake importer stands in for TIA: it never attaches to a project. It checks that the changeset file
// it is given matches the SHA-256 it is told, and reports every block verified.
test('import changesets bind every block to one token and run one importer session', {
  skip: process.platform !== 'win32', timeout: 120_000
}, async t => {
  const tempRoot = await realpath(os.tmpdir());
  const temp = await mkdtemp(path.join(tempRoot, 'tia-changeset-'));
  const pkg = path.join(temp, 'pkg');
  const projects = path.join(temp, 'projects');
  const exports = path.join(temp, 'exports');
  const oldEnv = { ...process.env };
  t.after(async () => {
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
    assert.equal(path.dirname(temp), tempRoot);
    await rm(path.join(pkg, 'node_modules'), { force: true, recursive: true });
    await rm(temp, { force: true, recursive: true });
  });
  await mkdir(pkg);
  await mkdir(projects);
  await mkdir(exports);
  await cp(path.resolve('dist'), path.join(pkg, 'dist'), { recursive: true });
  await writeFile(path.join(pkg, 'package.json'), '{"type":"module"}');
  await symlink(path.resolve('node_modules'), path.join(pkg, 'node_modules'), 'junction');
  const table = JSON.parse(await readFile('portal-versions.json', 'utf8'));
  await writeFile(path.join(pkg, 'portal-versions.json'), JSON.stringify(table));
  const profile = table.versions.find(v => v.id === 'V20');
  const log = path.join(temp, 'importer.log');
  Object.assign(process.env, {
    TIA_MCP_ALLOWED_PROJECT_ROOTS: projects,
    TIA_MCP_ALLOWED_EXPORT_ROOTS: exports,
    TIA_FAKE_IMPORTER_LOG: log
  });
  const apiDir = path.join(temp, 'api');
  await mkdir(apiDir);
  const api = path.join(apiDir, 'Siemens.Engineering.dll');
  await writeFile(api, 'isolated fake API');
  process.env[profile.apiDllEnv] = api;
  await mkdir(path.join(pkg, 'tools'));
  const exe = path.join(pkg, 'tools', 'TiaOpennessImportBlock.exe');
  const source = `using System; using System.IO; using System.Linq; using System.Security.Cryptography; using System.Text; using System.Web.Script.Serialization;
class Fixture {
  static string Arg(string[] a, string k) { int i = Array.IndexOf(a, k); return i < 0 ? null : a[i + 1]; }
  static int Main(string[] args) {
    Console.OutputEncoding = new UTF8Encoding(false);
    var json = new JavaScriptSerializer();
    if (Array.IndexOf(args, "--self-test") >= 0) {
      string[] checks = Environment.GetEnvironmentVariable("TIA_FAKE_NO_CHANGESET") == "1"
        ? new[] { "api_identity" } : new[] { "api_identity", "changeset_ordering", "target_baseline" };
      Console.WriteLine(json.Serialize(new { ok = true, status = "self_test_passed", protocolVersion = 1, apiPath = Arg(args, "--api"),
        apiAssemblyVersion = "${profile.apiAssembly.major}.${profile.apiAssembly.minor}.0.0", checks = checks,
        target = new { portalVersion = "V20", apiAssembly = "${profile.apiAssembly.major}.${profile.apiAssembly.minor}", projectExtension = "${profile.projectExtension}",
          apiFeatures = new string[] { ${profile.apiFeatures.map(f => JSON.stringify(f)).join(',')} } },
        capabilities = new[] { "block_import" },
        safety = new { selfTestOnly = true, projectOpened = false, projectModified = false, plcAccessed = false, import = false, download = false } }));
      return 0;
    }
    bool verify = Array.IndexOf(args, "--verify-only") >= 0;
    string changeset = Arg(args, "--changeset");
    byte[] bytes = File.ReadAllBytes(changeset);
    string sha; using (var h = SHA256.Create()) sha = BitConverter.ToString(h.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
    if (sha != Arg(args, "--changeset-sha256")) return 3;
    var items = ((object[])((System.Collections.Generic.Dictionary<string, object>)json.DeserializeObject(Encoding.UTF8.GetString(bytes)))["items"])
      .Cast<System.Collections.Generic.Dictionary<string, object>>().ToArray();
    var orderedItems = items.Reverse().Select(i => new { name=i["name"], kind=i["kind"], number=i["number"],
      targetContentSha256 = new string((string)i["kind"] == "FC" ? 'a' : 'b', 64) }).ToArray();
    if (Array.IndexOf(args, "--baseline-only") >= 0) {
      Console.WriteLine(json.Serialize(new { ok=true, status="baseline_captured", processId=123,
        processStartTimeUtc=Arg(args,"--process-start-time-utc"), projectPath=Arg(args,"--project"), items=orderedItems }));
      return 0;
    }
    if (items.Any(i => (string)i["targetContentSha256"] != new string((string)i["kind"] == "FC" ? 'a' : 'b', 64))) return 4;
    if (!verify && Environment.GetEnvironmentVariable("TIA_FAKE_CHANGED_TARGET") == "Collect") {
      string dir=Arg(args,"--out"); Directory.CreateDirectory(dir);
      File.WriteAllText(Path.Combine(dir,"import-changeset.json"),json.Serialize(new {status="refused_target_changed",
        changedTargets=new[]{"GlobalDB120 Collect"},importStarted=false,errors=new[]{"stale"}})); return 1;
    }
    File.AppendAllText(Environment.GetEnvironmentVariable("TIA_FAKE_IMPORTER_LOG"),
      (verify ? "verify" : "import") + " scope=" + Arg(args, "--compile-scope") + " items=" + string.Join(",", items.Select(i => (string)i["name"])) + "\\n");
    string output = Arg(args, "--out"); Directory.CreateDirectory(output);
    if (verify) {
      Console.WriteLine(json.Serialize(new { ok = true, programContentMatches = true, processId = 123, processStartTimeUtc = "2026-11-05T00:00:00.000Z",
        projectPath = Arg(args, "--project"), projectModified = false, plcAccessed = false, download = false }));
    } else {
      File.WriteAllText(Path.Combine(output, "import-changeset.json"), json.Serialize(new { errors = new string[0], projectSaved = false,
        rollbackAttempted = false, items = items.Select(i => new { name = i["name"], number = i["number"], kind = i["kind"], programContentMatches = true }).ToArray() }));
    }
    return 0;
  }
}`;
  const cs = path.join(temp, 'Importer.cs');
  await writeFile(cs, source);
  const compiler = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  execFileSync(compiler, ['/nologo', '/target:exe', '/platform:x64', `/out:${exe}`, '/reference:System.Web.Extensions.dll', '/reference:System.Core.dll', cs]);
  const project = path.join(projects, `Test${profile.projectExtension}`);
  await writeFile(project, 'fake project; never open');
  const write = async (name, xml) => { const file = path.join(exports, name); await writeFile(file, xml); return file; };
  const fc = await write('fc3.xml', '<Document><SW.Blocks.FC ID="0"><AttributeList><Name>FC3</Name><Number>3</Number><ProgrammingLanguage>LAD</ProgrammingLanguage></AttributeList><ObjectList /></SW.Blocks.FC></Document>');
  const db = await write('db120.xml', '<Document><SW.Blocks.GlobalDB ID="0"><AttributeList><Interface><Sections><Section Name="Static"><Member Name="count" Datatype="UDInt" /></Section></Sections></Interface><Name>Collect</Name><Number>120</Number></AttributeList></SW.Blocks.GlobalDB></Document>');

  const { registerPlcImportTools } = await import(pathToFileURL(path.join(pkg, 'dist/tools/plc-import.js')).href);
  const handlers = new Map();
  let refreshCalls = 0;
  registerPlcImportTools({ registerTool(name, _schema, handler) { handlers.set(name, handler); } }, {
    async resolveExactLiveSession() { return { ok: true, processId: 123, processStartTimeUtc: '2026-11-05T00:00:00.000Z', projectPath: project }; },
    async refreshPreparedLiveInventory() { refreshCalls++; return { attempted: true, ok: true }; }
  });
  const blocks = [{ xmlPath: fc, targetName: 'FC3', targetNumber: '3' }, { xmlPath: db, targetName: 'Collect', targetNumber: '120' }];
  const plan = async (b = blocks) => (await handlers.get('tia_create_import_plan')({ projectPath: project, blocks: b, saveProject: false, includeReview: true, timeoutMs: 10_000 })).structuredContent;
  const apply = async (token, b = blocks) => {
    const response = await handlers.get('tia_apply_import')({ projectPath: project, blocks: b, timeoutMs: 60_000, confirmToken: token });
    if (response.structuredContent.ok) measure('tia_apply_import', response);
    return response.structuredContent;
  };

  await t.test('a plan lists the data-block-first order, a review of every block and one token', async () => {
    const p = await plan();
    assert.equal(p.ok, true, JSON.stringify(p));
    assert.deepEqual(p.importOrder, ['GlobalDB120 "Collect"', 'FC3 "FC3"']);
    assert.equal(p.compileScope, 'software');
    assert.match(p.blocks[1].review, /count : UDInt/);
    assert.match(p.writeStatus.confirmToken, /^TIA_CHANGESET_/);
  });
  await t.test('the same block twice is refused without a token', async () => {
    const p = await plan([blocks[0], blocks[0]]);
    assert.equal(p.ok, false);
    assert.equal(p.writeStatus.confirmToken, '');
    assert.ok(p.checks.duplicateTargets.length > 0);
  });
  await t.test('apply refuses a different block list or a changed file before launching the importer', async () => {
    const p = await plan();
    assert.equal((await apply(p.writeStatus.confirmToken, [blocks[1], blocks[0]])).status, 'plan_binding_mismatch');
    const original = await readFile(fc, 'utf8');
    await writeFile(fc, original.replace('<ObjectList />', '<ObjectList></ObjectList>'));
    try { assert.equal((await apply(p.writeStatus.confirmToken)).status, 'plan_binding_mismatch'); }
    finally { await writeFile(fc, original); }
    assert.equal(existsSync(log), false);
  });
  await t.test('a changed second target refuses the whole approved batch and consumes the token', async () => {
    const p = await plan();
    assert.deepEqual(p.blocks.map(b => b.targetContentSha256), ['a'.repeat(64), 'b'.repeat(64)]);
    process.env.TIA_FAKE_CHANGED_TARGET = 'Collect';
    try {
      const result = await apply(p.writeStatus.confirmToken);
      assert.equal(result.status, 'refused_target_changed');
      assert.equal(result.importStarted, false);
      assert.deepEqual(result.summary.changedTargets, ['GlobalDB120 Collect']);
      assert.equal(existsSync(log), false);
      assert.equal((await apply(p.writeStatus.confirmToken)).status, 'confirmation_invalid_or_expired');
    } finally { delete process.env.TIA_FAKE_CHANGED_TARGET; }
  });
  await t.test('apply runs one import session with a software compile, then one readback, and the token is spent', async () => {
    const p = await plan();
    refreshCalls = 0;
    const result = await apply(p.writeStatus.confirmToken);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.status, 'changeset_imported_compiled_verified_unsaved');
    assert.equal(result.independentReadbackVerified, true);
    // The inventory is project-wide: one forced rebuild serves the whole batch.
    assert.equal(refreshCalls, 1);
    assert.equal(result.liveInventoryRefresh.targetCount, 2);
    assert.equal(await readFile(log, 'utf8'), 'import scope=software items=FC3,Collect\nverify scope=software items=FC3,Collect\n');
    assert.equal((await apply(p.writeStatus.confirmToken)).status, 'confirmation_invalid_or_expired');
  });
  await t.test('an importer without changeset support cannot issue a plan', async () => {
    process.env.TIA_FAKE_NO_CHANGESET = '1';
    // The self-test result is cached by importer identity; a rebuilt importer is a new identity.
    await writeFile(exe, Buffer.concat([await readFile(exe), Buffer.from([0])]));
    try {
      const p = await plan();
      assert.equal(p.ok, false);
      assert.equal(p.reason.code, 'ImporterWithoutChangeset');
    } finally { delete process.env.TIA_FAKE_NO_CHANGESET; }
  });
});
