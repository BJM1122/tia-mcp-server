import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
const exec = promisify(execFile);
const targets = ["tools/TiaOpennessImportBlock.exe", "tools/TiaLiveReadCore.exe", "tools/TiaV15Snapshot.exe",
  "tools/TiaOpennessImportBlock.v15_1.exe", "tools/TiaHmiNative.exe"];
const versions = ["V20", "V20", "V15.1", "V15.1", "V20"];
const mock = "\nparam($Component, $Version, $OutputPath, $InstallFrom, [switch]$RequireSelfTest)\n$ErrorActionPreference = 'Stop'\nif (-not $RequireSelfTest) { throw 'Every production component requires its offline self-test.' }\n$step = if ($InstallFrom) { 'install' } else { 'stage' }\nAdd-Content -LiteralPath $env:TIA_BUILD_TEST_LOG -Value \"$step|$Component|$Version\"\nif ($step -eq 'stage' -and $env:TIA_BUILD_TEST_FAIL -eq \"$Component|$Version|stage\") { throw 'Synthetic compile/self-test failure' }\n[IO.File]::WriteAllText($OutputPath, \"new:$Component|$Version\")\nif ($step -eq 'install' -and $env:TIA_BUILD_TEST_FAIL -eq \"$Component|$Version|install\") { throw 'Synthetic post-replacement failure' }\n";
test("production stages all five versioned components before installation and rolls back every failed batch", {
  skip: process.platform !== "win32"
}, async t => {
  for (const scenario of [
    { fail: "hmi|V20|stage" },
    { fail: "hmi|V20|install" },
    { fail: "v15-snapshot|V15.1|install", missing: 0 },
    { fail: "" }
  ]) await t.test(scenario.fail || "success", async t => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "tia-production-"));
    t.after(() => rm(temp, { recursive: true, force: true }));
    const root = path.join(temp, "package");
    await mkdir(path.join(root, "tools"), { recursive: true });
    await writeFile(path.join(root, "tools/Build-TiaProduction.ps1"), await readFile("tools/Build-TiaProduction.ps1"));
    await writeFile(path.join(root, "tools/Build-TiaNative.ps1"), mock);
    const files = targets.map(name => path.resolve(root, name));
    const oldTime = new Date("2025-01-01T12:34:56Z");
    for (const [i, file] of files.entries()) if (i !== scenario.missing) {
      await writeFile(file, "old:" + i); await utimes(file, oldTime, oldTime);
    }
    const log = path.join(temp, "calls");
    const run = exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", path.join(root, "tools/Build-TiaProduction.ps1")], {
      windowsHide: true, env: { ...process.env, TIA_BUILD_TEST_LOG: log, TIA_BUILD_TEST_FAIL: scenario.fail }
    });
    if (scenario.fail) await assert.rejects(run, error => {
      assert.match(error.message, /Synthetic/);
      assert.doesNotMatch(error.message, /Rollback incomplete/);
      return true;
    });
    else await run;
    const calls = (await readFile(log, "utf8")).trim().split(/\r?\n/);
    assert.deepEqual(calls.slice(0, 5), ["stage|importer|V20", "stage|live-core|V20", "stage|v15-snapshot|V15.1", "stage|importer|V15.1", "stage|hmi|V20"]);
    if (scenario.fail.endsWith("|stage")) assert.equal(calls.length, 5);
    for (const [i, file] of files.entries()) {
      if (scenario.fail) {
        if (i === scenario.missing) await assert.rejects(stat(file), { code: "ENOENT" });
        else {
          assert.equal(await readFile(file, "utf8"), "old:" + i);
          assert.equal((await stat(file)).mtimeMs, oldTime.getTime());
        }
      } else {
        assert.ok((await readFile(file, "utf8")).endsWith("|" + versions[i]));
      }
    }
    assert.deepEqual(await readdir(path.join(root, "live-core/bin")), []);
  });
});
