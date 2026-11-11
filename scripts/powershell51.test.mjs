// Windows PowerShell 5.1 rules (docs/powershell-5.1.md), checked with the real powershell.exe.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const pkg = path.resolve(".");
const toolsDir = path.join(pkg, "tools");
const installScript = path.join(toolsDir, "TiaNativeInstall.ps1");

async function ps51(script, env = {}) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    { windowsHide: true, env: { ...process.env, ...env }, maxBuffer: 4 * 1024 * 1024 });
  return stdout.replace(/^﻿/, "").trim();
}

async function psFiles() {
  return (await readdir(toolsDir)).filter((name) => name.toLowerCase().endsWith(".ps1")).map((name) => path.join(toolsDir, name));
}

async function tsFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await tsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

test("every tools/*.ps1 parses under Windows PowerShell 5.1", async () => {
  const files = await psFiles();
  assert.ok(files.length >= 5);
  const report = await ps51([
    "$ErrorActionPreference = 'Stop'",
    "$version = $PSVersionTable.PSVersion.Major",
    "$rows = foreach ($file in ($env:TIA_PS_FILES | ConvertFrom-Json)) {",
    "  $tokens = $null; $errors = $null",
    "  [void][System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)",
    "  foreach ($e in $errors) { [pscustomobject]@{ file = $file; line = $e.Extent.StartLineNumber; message = $e.Message } }",
    "}",
    "ConvertTo-Json -Depth 3 -Compress -InputObject ([pscustomobject]@{ version = $version; errors = [object[]]@($rows) })"
  ].join("\n"), { TIA_PS_FILES: JSON.stringify(files) });
  const parsed = JSON.parse(report);
  assert.equal(parsed.version, 5, "powershell.exe must be Windows PowerShell 5.1");
  assert.deepEqual(parsed.errors, []);
});

test("PowerShell code follows the 5.1 JSON, encoding and syntax rules", async () => {
  const problems = [];
  const forbidden = /\s-(AsArray|Parallel|AsHashtable)\b/;
  for (const file of await psFiles()) {
    const lines = (await readFile(file, "utf8")).split(/\r?\n/);
    lines.forEach((line, i) => {
      const code = line.replace(/^\s*#.*$/, "");
      const where = `${path.basename(file)}:${i + 1}`;
      if (/ConvertTo-Json/.test(code) && !/-Depth\s+\d+/.test(code)) problems.push(`${where} ConvertTo-Json without -Depth`);
      if (/\b(Set-Content|Out-File|Add-Content)\b/.test(code) && !/-Encoding\s+\w+/.test(code)) problems.push(`${where} file write without -Encoding`);
      if (forbidden.test(code)) problems.push(`${where} PowerShell 7-only parameter`);
    });
  }
  for (const file of await tsFiles(path.join(pkg, "src"))) {
    const lines = (await readFile(file, "utf8")).split(/\r?\n/);
    lines.forEach((line, i) => {
      const where = `${path.relative(pkg, file)}:${i + 1}`;
      if (/ConvertTo-Json/.test(line) && !/-Depth\s+\d+/.test(line)) problems.push(`${where} inline ConvertTo-Json without -Depth`);
      if (/(ConvertTo-Json|ConvertFrom-Json|ForEach-Object)/.test(line) && forbidden.test(line)) problems.push(`${where} PowerShell 7-only parameter`);
    });
  }
  assert.deepEqual(problems, []);
});

test("the old-core marker written by TiaNativeInstall.ps1 stays a flat array of running processes", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "tia-ps51-marker-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const marker = path.join(temp, "stale-live-core-processes.json");
  const run = async (body) => ps51([
    "$ErrorActionPreference = 'Stop'",
    `. '${installScript.replace(/'/g, "''")}'`,
    "$m = $env:TIA_MARKER",
    "$alive = [pscustomobject]@{ processId = [int]$env:TIA_ALIVE_PID; processStartTimeUtc = (Get-Process -Id ([int]$env:TIA_ALIVE_PID)).StartTime.ToUniversalTime().ToString('o') }",
    "$dead = [pscustomobject]@{ processId = 2147483646; processStartTimeUtc = $alive.processStartTimeUtc }",
    "$restarted = [pscustomobject]@{ processId = $alive.processId; processStartTimeUtc = '2000-01-01T00:00:00.0000000Z' }",
    body,
    "[IO.File]::ReadAllText($m)"
  ].join("\n"), { TIA_MARKER: marker, TIA_ALIVE_PID: String(process.pid) });
  const flat = (text) => {
    const value = JSON.parse(text);
    assert.ok(Array.isArray(value), text);
    for (const row of value) assert.deepEqual(Object.keys(row).sort(), ["processId", "processStartTimeUtc"], text);
    return value;
  };
  const pids = (text) => flat(text).map((row) => row.processId);

  assert.deepEqual(pids(await run("Write-StaleCoreMarker $m @()")), []);
  assert.deepEqual(pids(await run("Write-StaleCoreMarker $m @($alive)")), [process.pid]);
  assert.deepEqual(pids(await run("Write-StaleCoreMarker $m @($alive, $alive, $dead, $restarted)")), [process.pid]);

  await writeFile(marker, "﻿[{\"value\":[{\"value\":\"\",\"Count\":1}],\"Count\":1}]");
  assert.deepEqual(pids(await run("Update-StaleCoreMarker $m @()")), [], "legacy wrapper without rows");
  const legacy = await run([
    "$wrapped = '[{\"value\":[{\"processId\":' + $alive.processId + ',\"processStartTimeUtc\":\"' + $alive.processStartTimeUtc + '\"}],\"Count\":1}]'",
    "[IO.File]::WriteAllText($m, $wrapped)",
    "Update-StaleCoreMarker $m @()"
  ].join("\n"));
  assert.deepEqual(pids(legacy), [process.pid], "legacy wrapper with a running process");

  const outputs = [];
  for (let i = 0; i < 3; i++) outputs.push(await run("Update-StaleCoreMarker $m @($alive)"));
  assert.equal(new Set(outputs).size, 1, "repeated builds must not nest or grow the marker");
  assert.deepEqual(pids(outputs[0]), [process.pid]);

  await writeFile(marker, "not json");
  assert.deepEqual(pids(await run("Update-StaleCoreMarker $m @() 3>$null")), []);
  assert.equal((await readFile(marker))[0] === 0xef, false, "marker is UTF-8 without BOM");
});

test("doctor reports the running process from a marker written by the 5.1 helper", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "tia-ps51-doctor-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const marker = path.join(temp, "stale-live-core-processes.json");
  await ps51([
    "$ErrorActionPreference = 'Stop'",
    `. '${installScript.replace(/'/g, "''")}'`,
    "$alive = [pscustomobject]@{ processId = [int]$env:TIA_ALIVE_PID; processStartTimeUtc = (Get-Process -Id ([int]$env:TIA_ALIVE_PID)).StartTime.ToUniversalTime().ToString('o') }",
    "Write-StaleCoreMarker $env:TIA_MARKER @($alive)"
  ].join("\n"), { TIA_MARKER: marker, TIA_ALIVE_PID: String(process.pid) });
  process.env.TIA_MCP_LIVE_CORE_EXE = path.join(temp, "TiaLiveReadCore.exe");
  const { oldResidentProcesses } = await import("../dist/environment.js");
  assert.deepEqual(await oldResidentProcesses(), [{ processId: process.pid, message: "An old live-core process from a replaced build is still running." }]);
  await writeFile(marker, "[{\"processId\":2147483646,\"processStartTimeUtc\":\"2000-01-01T00:00:00Z\"}]");
  assert.deepEqual(await oldResidentProcesses(), []);
});

test("TiaNativeInstall.ps1 is not a native staleness input", async (t) => {
  const { nativeCommonMtimeMs } = await import("../dist/native-capabilities.js");
  const { componentSources } = await import("../dist/tia-version.js");
  const portal = JSON.parse(await readFile(path.join(pkg, "portal-versions.json"), "utf8"));
  for (const component of portal.components) {
    for (const source of componentSources(component.id, pkg)) assert.notEqual(path.basename(source), "TiaNativeInstall.ps1", component.id);
  }
  for (const file of ["dist/hmi-authoring-tools.js", "dist/native-capabilities.js", "dist/environment.js"]) {
    assert.doesNotMatch(await readFile(path.join(pkg, file), "utf8"), /TiaNativeInstall/, file);
  }
  const before = await nativeCommonMtimeMs();
  const original = await stat(installScript);
  t.after(() => utimes(installScript, original.atime, original.mtime));
  const future = new Date(Date.now() + 60_000);
  await utimes(installScript, future, future);
  assert.equal(await nativeCommonMtimeMs(), before);
});
