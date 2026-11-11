import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readOnlyProjectVersion } from "../dist/tia-version.js";
import { matchProjectIdentity } from "../dist/tia-ui-context.js";
import { runSnapshotExport } from "../dist/project-snapshot.js";

test("read-only project version accepts only exact supported extensions", () => {
  assert.equal(readOnlyProjectVersion("D:\\Press.ap15_1"), "V15.1");
  assert.equal(readOnlyProjectVersion("D:\\Press.AP20"), "V20");
  for (const candidate of ["D:\\Press.ap15", "D:\\Press.ap15_1.backup", ""]) {
    assert.throws(() => readOnlyProjectVersion(candidate), /Not a recognized TIA Portal project/);
  }
  // Recognized versions without a built adapter never fall through to another version.
  assert.throws(() => readOnlyProjectVersion("D:\\Press.ap16"), /V16 projects are recognized, but no V16 adapter/);
});

test("identical project names across versions cannot match", () => {
  const candidates = [{ exportDir: "v20", projectNames: ["Press"], projectPaths: ["D:\\Press.ap20"] }];
  assert.equal(matchProjectIdentity({ projectPath: "D:\\Press.ap15_1", projectName: "Press" }, candidates).status, "name_only");
  assert.equal(matchProjectIdentity({ projectPath: "D:\\Press.ap15_1" }, [
    { exportDir: "v15", projectPaths: ["d:\\press.ap15_1"] }
  ]).status, "matched");
});

test("V15 companion exports and rejects incomplete evidence using an isolated API", { skip: process.platform !== "win32", timeout: 60_000 }, async t => {
  const tempRoot = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(tempRoot, "tia-v15-fixture-"));
  t.after(async () => {
    assert.ok(root.startsWith(path.join(tempRoot, "tia-v15-fixture-")));
    await rm(root, { recursive: true, force: true });
  });
  const framework = path.join(process.env.WINDIR, "Microsoft.NET", "Framework64", "v4.0.30319");
  const compiler = path.join(framework, "csc.exe");
  const apiDll = path.join(root, "Siemens.Engineering.dll");
  const coreExe = path.join(root, "TiaV15Snapshot.exe");
  const lockerExe = path.join(root, "ProjectLocker.exe");
  execFileSync(compiler, ["/nologo", "/target:library", "/platform:x64", `/out:${apiDll}`, path.resolve("scripts/fixtures/TiaV15Api.cs")]);
  // Build through the shared native build so the V15.1 identity comes from portal-versions.json.
  execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.resolve("tools/Build-TiaNative.ps1"),
    "-Component", "v15-snapshot", "-OutputPath", coreExe], { stdio: ["ignore", "pipe", "pipe"] });
  execFileSync(compiler, ["/nologo", "/target:exe", "/platform:x64", `/out:${lockerExe}`, path.resolve("scripts/fixtures/TiaV15Api.cs")]);
  const projectPath = path.join(root, "Press.ap15_1");
  await writeFile(projectPath, "fixture only");
  const processStartTimeUtc = execFileSync("powershell.exe", ["-NoProfile", "-Command",
    `(Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().ToString('o')`], { encoding: "utf8" }).trim();
  const env = { ...process.env, TIA_FIXTURE_PROJECT: projectPath, TIA_FIXTURE_PID: String(process.pid) };
  function run(behavior, outputRoot, extra = []) {
    const result = spawnSync(coreExe, ["--api", apiDll, "--export-snapshot-candidate-v1", "--process-id", String(process.pid),
      "--process-start-time-utc", processStartTimeUtc, "--project-path", projectPath, "--output-root", outputRoot, ...extra],
    { env: { ...env, TIA_FIXTURE_BEHAVIOR: behavior }, encoding: "utf8" });
    assert.equal(result.error, undefined);
    return { exitCode: result.status, value: JSON.parse(result.stdout) };
  }
  await t.test("complete export includes user blocks, system blocks, types and tag tables", async () => {
    const output = path.join(root, "success");
    const result = run("", output);
    assert.equal(result.exitCode, 0, JSON.stringify(result.value));
    assert.equal(result.value.snapshot.exportedCount, 5);
    assert.equal(result.value.snapshot.currentPointerUpdated, false);
    assert.equal(result.value.safety.projectMutation, false);
    const manifest = JSON.parse(await readFile(result.value.snapshot.manifestPath, "utf8"));
    assert.equal(manifest.openness.attachCount, 1);
    assert.equal(manifest.objects.filter(o => o.resourceKind === "block").length, 2);
    assert.equal(manifest.objects.filter(o => o.resourceKind === "plc_type").length, 2);
    assert.equal(manifest.objects.filter(o => o.resourceKind === "tag_table").length, 1);
    await assert.rejects(readFile(path.join(output, "current.json")), /ENOENT/);
  });
  await t.test("an open project with a shared writer can be exported without mutating it", async () => {
    const writer = openSync(projectPath, "r+");
    try {
      const result = run("", path.join(root, "open-project"));
      assert.equal(result.exitCode, 0, JSON.stringify(result.value));
      assert.equal(await readFile(projectPath, "utf8"), "fixture only");
    } finally { closeSync(writer); }
  });
  await t.test("Portal's exclusive container lock does not prevent metadata and official object export", async () => {
    const locker = spawn(lockerExe, [projectPath], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    try {
      const [ready] = await once(locker.stdout, "data");
      assert.match(ready.toString(), /LOCKED/);
      const result = run("", path.join(root, "exclusive-project"));
      assert.equal(result.exitCode, 0, JSON.stringify(result.value));
    } finally {
      const closed = once(locker, "exit");
      locker.stdin.end("\n");
      await closed;
    }
    assert.equal(await readFile(projectPath, "utf8"), "fixture only");
  });
  for (const behavior of ["wrong-project", "unreadable-state", "changed-state", "service-failed", "export-failed", "inconsistent"]) {
    await t.test(`${behavior} cannot replace a previous current pointer`, async () => {
      const output = path.join(root, behavior);
      await mkdir(path.join(output, "snapshots", "previous"), { recursive: true });
      const { createHash } = await import("node:crypto");
      const previousManifest = '{"fixture":"previous"}';
      await writeFile(path.join(output, "snapshots", "previous", "manifest.json"), previousManifest);
      const pointer = JSON.stringify({ snapshotId: "previous", manifestSha256: createHash("sha256").update(previousManifest).digest("hex"), publishedPath: "snapshots/previous" });
      await writeFile(path.join(output, "current.json"), pointer);
      const result = run(behavior, output);
      assert.equal(result.exitCode, 2);
      assert.equal(result.value.ok, false);
      if (behavior === "inconsistent") {
        assert.equal(result.value.diagnostics.failedObject.name, "Block2");
        assert.equal(result.value.diagnostics.failedObject.number, 2);
        assert.equal(result.value.diagnostics.failedObject.isConsistent, false);
        assert.equal(result.value.diagnostics.inconsistentObjectCount, 4);
      }
      assert.equal(await readFile(path.join(output, "current.json"), "utf8"), pointer);
      const { readdir } = await import("node:fs/promises");
      assert.deepEqual((await readdir(output)).filter(name => name.startsWith(".tia-snapshot-staging-")), []);
    });
  }
  await t.test("an OS process-start mismatch fails before attachment", () => {
    const result = spawnSync(coreExe, ["--api", apiDll, "--export-snapshot-candidate-v1", "--process-id", String(process.pid),
      "--process-start-time-utc", "2000-01-01T00:00:00Z", "--project-path", projectPath, "--output-root", path.join(root, "wrong-start")],
    { env, encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(JSON.parse(result.stdout).error, /process-start/);
  });
  await t.test("the shared snapshot verifier accepts V15.1 without weakening manifest checks", async () => {
    const oldProject = process.env.TIA_FIXTURE_PROJECT;
    const oldPid = process.env.TIA_FIXTURE_PID;
    process.env.TIA_FIXTURE_PROJECT = projectPath;
    process.env.TIA_FIXTURE_PID = String(process.pid);
    try {
      const result = await runSnapshotExport({ coreExe, apiDll, processId: process.pid, processStartTimeUtc, projectPath,
        outputRoot: path.join(root, "shared"), timeoutMs: 30_000 });
      assert.equal(result.index.itemCount, 5);
      assert.equal(result.manifest.snapshotKind, "tia_openness_full_plc_snapshot");
    } finally {
      if (oldProject === undefined) delete process.env.TIA_FIXTURE_PROJECT; else process.env.TIA_FIXTURE_PROJECT = oldProject;
      if (oldPid === undefined) delete process.env.TIA_FIXTURE_PID; else process.env.TIA_FIXTURE_PID = oldPid;
    }
  });
});
