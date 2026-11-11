import { measure } from "./output-budget-utils.mjs";
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

test('version-selected import plans fail closed before launching a changed or wrong-version importer', {
  skip: process.platform !== 'win32', timeout: 120_000
}, async t => {
  const tempRoot = await realpath(os.tmpdir());
  const temp = await mkdtemp(path.join(tempRoot, 'tia-import-version-'));
  const pkg = path.join(temp, 'pkg');
  const projects = path.join(temp, 'projects');
  const exports = path.join(temp, 'exports');
  const oldEnv = { ...process.env };
  t.after(async () => {
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
    assert.equal(path.dirname(temp), tempRoot);
    // Remove the dependency junction explicitly before recursively cleaning this owned fixture.
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
  // Keep the isolated fixture explicit; it never attaches to a real Portal project.
  const profiles = [table.versions.find(v => v.id === 'V20'), table.versions.find(v => v.id === 'V15.1')];
  if (!profiles[1].capabilities.includes('block_import')) profiles[1].capabilities.push('block_import');
  await writeFile(path.join(pkg, 'portal-versions.json'), JSON.stringify(table));
  Object.assign(process.env, {
    TIA_MCP_ALLOWED_PROJECT_ROOTS: projects,
    TIA_MCP_ALLOWED_EXPORT_ROOTS: exports,
    TIA_MCP_IMPORT_FIXTURE_LOG: path.join(temp, 'unexpected-import.log')
  });
  const compiler = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  await mkdir(path.join(pkg, 'tools'));
  const executables = [];
  const apis = [];
  for (const profile of profiles) {
    const suffix = profile.id === table.defaultVersion ? '' : `.${profile.id.toLowerCase().replaceAll('.', '_')}`;
    const exe = path.join(pkg, 'tools', `TiaOpennessImportBlock${suffix}.exe`);
    const apiDir = path.join(temp, `api-${profile.id}`);
    await mkdir(apiDir);
    const api = path.join(apiDir, 'Siemens.Engineering.dll');
    await writeFile(api, `isolated fake API ${profile.id}`);
    process.env[profile.apiDllEnv] = api;
    const cs = path.join(temp, `Importer-${profile.id}.cs`);
    const source = `using System; using System.IO; using System.Text; using System.Web.Script.Serialization;
class Fixture {
  static int Main(string[] args) {
    Console.OutputEncoding = new UTF8Encoding(false);
    if (Array.IndexOf(args, "--self-test") < 0) {
      if (Array.IndexOf(args, "--baseline-only") >= 0) {
        Console.WriteLine(new JavaScriptSerializer().Serialize(new {
          ok = true, status = "baseline_captured", processId = Environment.GetEnvironmentVariable("TIA_BAD_CAPTURE") == "1" ? 999 : 123,
          processStartTimeUtc = args[Array.IndexOf(args, "--process-start-time-utc") + 1],
          projectPath = args[Array.IndexOf(args, "--project") + 1],
          items = new[] { new { name = "Test", number = "1", kind = "FC", targetContentSha256 = new string('a', 64) } }
        })); return 0;
      }
      if (Array.IndexOf(args, "--baseline-sha256") < 0 || args[Array.IndexOf(args,"--baseline-sha256")+1] != new string('a',64)) return 3;
      if (Environment.GetEnvironmentVariable("TIA_CHANGED_SINGLE") == "1") {
        string dir=args[Array.IndexOf(args, "--out")+1];Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir,"import-block.json"),new JavaScriptSerializer().Serialize(new {
          status="refused_target_changed", sourceImportStarted=false, changedTargets=new[]{"FC1 Test"},errors=new[]{"stale"} }));
        return 1;
      }
      bool verify = Array.IndexOf(args, "--verify-only") >= 0;
      File.AppendAllText(Environment.GetEnvironmentVariable("TIA_MCP_IMPORT_FIXTURE_LOG"), verify ? "verify\\n" : "import\\n");
      string output = args[Array.IndexOf(args, "--out") + 1]; Directory.CreateDirectory(output);
      string xml = Path.Combine(output, "verification.xml"); File.Copy(args[Array.IndexOf(args, "--xml") + 1], xml);
      if (verify) {
        string mode = Environment.GetEnvironmentVariable("TIA_MCP_IMPORT_FIXTURE_VERIFY");
        Console.WriteLine(new JavaScriptSerializer().Serialize(new {
          ok = true, programContentMatches = mode != "mismatch", projectModified = false, plcAccessed = false, download = false,
          processId = mode == "wrong-identity" ? 999 : 123, processStartTimeUtc = "2026-11-03T00:00:00.000Z",
          projectPath = args[Array.IndexOf(args, "--project") + 1], verificationExport = xml
        }));
      } else {
        File.WriteAllText(Path.Combine(output, "import-block.json"), new JavaScriptSerializer().Serialize(new {
          errors = new string[0], verificationExport = xml, programContentMatches = true, projectSaved = false,
          compileScope = args[Array.IndexOf(args, "--compile-scope") + 1], compileScopeUsed = "software", softwareCompileFallback = true
        }));
      }
      return 0;
    }
    string api = args[Array.IndexOf(args, "--api") + 1];
    Console.WriteLine(new JavaScriptSerializer().Serialize(new {
      ok=true, status="self_test_passed", protocolVersion=1, apiPath=api,
      apiAssemblyVersion="${profile.apiAssembly.major}.${profile.apiAssembly.minor}.0.0",
      target=new { portalVersion="${profile.id}", apiAssembly="${profile.apiAssembly.major}.${profile.apiAssembly.minor}", projectExtension="${profile.projectExtension}",
        apiFeatures=new string[]{${profile.apiFeatures.map(f => JSON.stringify(f)).join(",")}} },
      checks=new[]{"target_baseline", "software_compile_fallback"}, capabilities=new[]{"block_import"},
      safety=new { selfTestOnly=true, projectOpened=false, projectModified=false, plcAccessed=false, import=false, download=false }
    })); return 0;
  }
}`;
    await writeFile(cs, source);
    execFileSync(compiler, ['/nologo', '/target:exe', '/platform:x64', `/out:${exe}`, '/reference:System.Web.Extensions.dll', cs]);
    if (profile.id === 'V15.1') {
      // An importer built before the software-scope compile and rollback existed.
      const legacyCs = path.join(temp, 'Importer-legacy.cs');
      await writeFile(legacyCs, source.replace(', "software_compile_fallback"', ''));
      execFileSync(compiler, ['/nologo', '/target:exe', '/platform:x64', `/out:${path.join(temp, 'legacy.exe')}`, '/reference:System.Web.Extensions.dll', legacyCs]);
    }
    executables.push(exe);
    apis.push(api);
    await writeFile(path.join(projects, `Test${profile.projectExtension}`), 'fake project; never open');
  }
  const xml = path.join(exports, 'candidate.xml');
  await writeFile(xml, '<Document><SW.Blocks.FC ID="0"><AttributeList><Name>Test</Name><Number>1</Number><ProgrammingLanguage>LAD</ProgrammingLanguage></AttributeList><ObjectList /></SW.Blocks.FC></Document>');
  const { registerPlcImportTools } = await import(pathToFileURL(path.join(pkg, 'dist/tools/plc-import.js')).href);
  const handlers = new Map();
  const schemas = new Map();
  const observations = [];
  registerPlcImportTools({ registerTool(name, schema, handler) { handlers.set(name, handler); schemas.set(name, schema); } }, {
    async resolveExactLiveSession(args) {
      observations.push(args.portalVersion);
      const profile = profiles.find(p => p.id === args.portalVersion);
      return { ok: true, processId: 123, processStartTimeUtc: '2026-11-03T00:00:00.000Z', projectPath: path.join(projects, `Test${profile.projectExtension}`) };
    },
    async refreshPreparedLiveInventory() { throw new Error('A snapshot-only version must not start a resident refresh.'); }
  });
  const argsFor = profile => ({ processId: 123, projectPath: path.join(projects, `Test${profile.projectExtension}`), blocks: [{ xmlPath: xml, targetName: 'Test', targetNumber: '1' }],
    compileScope: 'block', saveProject: false, timeoutMs: 10_000 });
  const plan = async profile => (await handlers.get('tia_create_import_plan')(argsFor(profile))).structuredContent;
  const original = await readFile(executables[1]);
  await t.test('both versions select their own executable, DLL and passive session identity', async () => {
    for (let i = 0; i < profiles.length; i++) {
      const p = await plan(profiles[i]);
      assert.equal(p.ok, true, JSON.stringify(p));
      assert.equal(p.checks.importerExePath.toLowerCase(), executables[i].toLowerCase());
      assert.equal(p.checks.opennessApiDllPath.toLowerCase(), apis[i].toLowerCase());
      assert.match(p.writeStatus.confirmToken, /^TIA_IMPORT_/);
    }
    assert.deepEqual(observations, profiles.map(p => p.id));
  });
  await t.test('apply refuses a timeout the importer would reject', () => {
    const timeout = schemas.get('tia_apply_import').inputSchema.timeoutMs;
    assert.equal(timeout.safeParse(600_000).success, true);
    // 900000 reached the importer on 2026-11-08 and failed as "Invalid import bounds or compile scope".
    assert.equal(timeout.safeParse(900_000).success, false);
  });
  await t.test('plans state the compile and rollback scopes', async () => {
    const block = await plan(profiles[1]);
    assert.equal(block.writeGate.blockCompileFallsBackToSoftware, true);
    assert.equal(block.writeGate.rollbackCompileScope, 'software');
    assert.equal(block.writeGate.applyTimeoutMsMax, 600_000);
    const software = (await handlers.get('tia_create_import_plan')({ ...argsFor(profiles[1]), compileScope: 'software' })).structuredContent;
    assert.equal(software.ok, true, JSON.stringify(software));
    assert.equal(software.writeGate.softwareCompileBeforeImport, true);
    assert.equal(software.writeGate.blockCompileFallsBackToSoftware, false);
  });
  await t.test('an importer without software-scope compile refuses a token', async () => {
    await writeFile(executables[1], await readFile(path.join(temp, 'legacy.exe')));
    try {
      const p = await plan(profiles[1]);
      assert.equal(p.ok, false);
      assert.equal(p.reason.code, 'ImporterWithoutSoftwareCompile');
      assert.equal(p.writeStatus.confirmToken, '');
    } finally { await writeFile(executables[1], original); }
  });
  await t.test('wrong baseline session refuses a token', async () => {
    process.env.TIA_BAD_CAPTURE = '1';
    try {
      const result = await plan(profiles[1]);
      assert.equal(result.status, 'baseline_capture_failed');
      assert.equal(result.writeStatus.confirmToken, '');
    } finally { delete process.env.TIA_BAD_CAPTURE; }
  });
  await t.test('single-block drift refuses import before mutation', async () => {
    const p = await plan(profiles[1]);
    assert.equal(p.targetContentSha256, 'a'.repeat(64));
    process.env.TIA_CHANGED_SINGLE = '1';
    try {
      const result = (await handlers.get('tia_apply_import')({ ...argsFor(profiles[1]), timeoutMs: 60_000, confirmToken: p.writeStatus.confirmToken })).structuredContent;
      assert.equal(result.status, 'refused_target_changed');
      assert.equal(result.summary.sourceImportStarted, false);
      assert.deepEqual(result.summary.changedTargets, ['FC1 Test']);
      assert.equal(existsSync(process.env.TIA_MCP_IMPORT_FIXTURE_LOG), false);
    } finally { delete process.env.TIA_CHANGED_SINGLE; }
  });
  await t.test('a missing or stale V15.1 importer prevents plan issuance', async () => {
    const retired = executables[1] + '.retired';
    await rename(executables[1], retired);
    try {
      const p = await plan(profiles[1]);
      assert.equal(p.ok, false);
      assert.equal(p.reason.code, 'ImporterUnavailable');
      assert.equal(p.writeStatus.confirmToken, '');
    } finally { await rename(retired, executables[1]); }
    const source = path.join(pkg, 'tools', 'Build-TiaNative.ps1');
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, 'fixture source changed after build');
    const future = new Date(Date.now() + 5000);
    await utimes(source, future, future);
    try { assert.equal((await plan(profiles[1])).reason.code, 'ImporterStale'); }
    finally { await rm(source); }
  });
  await t.test('a V20 self-test cannot authorize a V15.1 plan', async () => {
    await writeFile(executables[1], await readFile(executables[0]));
    try {
      const p = await plan(profiles[1]);
      assert.equal(p.ok, false);
      assert.equal(p.reason.code, 'ImporterSelfTestFailed');
      assert.equal(p.writeStatus.confirmToken, '');
    } finally { await writeFile(executables[1], original); }
  });
  await t.test('replacement between plan and apply is rejected before any importer operation', async () => {
    const p = await plan(profiles[1]);
    assert.equal(p.ok, true, JSON.stringify(p));
    await writeFile(executables[1], await readFile(executables[0]));
    try {
      const result = (await handlers.get('tia_apply_import')({ ...argsFor(profiles[1]), timeoutMs: 60_000, confirmToken: p.writeStatus.confirmToken })).structuredContent;
      assert.equal(result.blocked, true);
      assert.equal(result.status, 'importer_identity_changed');
      assert.equal(existsSync(process.env.TIA_MCP_IMPORT_FIXTURE_LOG), false);
    } finally { await writeFile(executables[1], original); }
  });
  for (const mode of ['match', 'mismatch', 'wrong-identity']) {
    // The block is already imported and verified in session; the readback only adds a record or a warning.
    await t.test(`fresh-process readback ${mode} is reported without overturning the import`, async () => {
      process.env.TIA_MCP_IMPORT_FIXTURE_VERIFY = mode;
      const p = await plan(profiles[1]);
      assert.equal(p.ok, true, JSON.stringify(p));
      const args = { ...argsFor(profiles[1]), timeoutMs: 60_000, confirmToken: p.writeStatus.confirmToken };
      const response = await handlers.get('tia_apply_import')(args);
      measure('tia_apply_import', response);
      const result = response.structuredContent;
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.status, 'imported_compiled_verified_unsaved');
      assert.equal(result.compileScope, 'block');
      assert.equal(result.compileScopeUsed, 'software');
      assert.equal(result.softwareCompileFallback, true);
      assert.equal(result.summary.compileScope, 'block');
      assert.equal(result.independentReadback.ok, mode === 'match');
      assert.equal(result.independentReadbackVerified, mode === 'match');
      if (mode === 'mismatch') assert.match(result.warnings[0], /different program content/);
      assert.equal(result.verificationMode, mode === 'match' ? 'independent-session' : 'same-session');
      assert.equal(result.warnings.length, mode === 'match' ? 0 : 1);
      assert.equal(result.liveInventoryRefresh.status, 'not_needed_no_resident_capability');
      assert.equal((await handlers.get('tia_apply_import')(args)).structuredContent.status, 'confirmation_invalid_or_expired');
    });
  }
  assert.equal(await readFile(process.env.TIA_MCP_IMPORT_FIXTURE_LOG, 'utf8'), 'import\nverify\n'.repeat(3));
});
