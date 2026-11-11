import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);

test("actual C# engineering reader avoids Portal-fatal Unified metadata discovery", { skip: process.platform !== "win32" }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "tia-unified-reader-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const source = await readFile(new URL("../live-core/TiaLiveReadCore.cs", import.meta.url), "utf8");
  const start = source.indexOf("    private sealed class EngineeringReader");
  const end = source.indexOf("    private static Dictionary<string, object> HandleSearchObjects", start);
  assert.ok(start >= 0 && end > start);
  const fixture = await readFile(new URL("./fixtures/unified-hmi-reader-harness.cs", import.meta.url), "utf8");
  const harness = path.join(temp, "Harness.cs");
  const executable = path.join(temp, "Harness.exe");
  await writeFile(harness, fixture.replace("/* ENGINEERING_READER */", source.slice(start, end)));
  const compiler = path.join(process.env.WINDIR, "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
  await exec(compiler, ["/nologo", "/langversion:5", "/r:System.Web.Extensions.dll", `/out:${executable}`, harness]);
  const { stdout } = await exec(executable);
  const result = JSON.parse(stdout);
  const attributes = row => row.attributes;

  await t.test("screens, shared multilingual children and event scripts survive without any metadata or unlisted getter", () => {
    const r = result.unified;
    assert.equal(r.metadataCalls, 0);
    assert.equal(r.forbiddenGetterCalls, 0);
    assert.equal(r.identifierCalls, 0);
    assert.ok(r.records.map(attributes).some(a => a.Name === "Main" && a.Width === 1280));
    assert.ok(r.records.map(attributes).some(a => a.Text === "Caption"));
    const captionId = r.records.find(row => row.attributes.Name === "Start").attributes.Text.refId;
    assert.equal(r.records.find(row => row.id === captionId).attributes.Text, "Caption");
    assert.ok(r.records.map(attributes).some(a => a.ScriptCode === "export function Click() {}"));
    assert.ok(r.records.map(attributes).some(a => a.Name === "Sibling"));
  });
  await t.test("unsupported scope and getter failures remain explicit; failed alarm getters do not imply coverage", () => {
    const r = result.unified;
    assert.ok(r.issues.some(i => i.status === "unified_property_coverage_limited"));
    assert.ok(r.issues.some(i => i.status === "property_unreadable"));
    assert.ok(r.issues.some(i => i.status === "collection_unreadable"));
    assert.equal(r.coverage.sections.find(s => s.section === "alarms").state, "unavailable");
    assert.equal(r.coverage.sections.find(s => s.section === "screens").state, "exposed");
    assert.equal(r.coverage.unifiedReadMode, "explicit_public_property_allowlist");
    assert.equal(r.coverage.completeEngineeringBackup, false);
  });
  await t.test("object limits still stop a deep Unified traversal", () => {
    assert.equal(result.bounded.records.length, 3);
    assert.equal(result.bounded.truncated, true);
    assert.equal(result.bounded.metadataCalls, 0);
  });
  await t.test("section selection and includeScreens avoid unrelated screen getters", () => {
    assert.equal(result.tagsOnly.screenGetterCalls, 0);
    assert.equal(result.noScreens.screenGetterCalls, 0);
    assert.equal(result.tagsOnly.records.length, 1);
  });
  await t.test("the existing non-Unified reader continues to use its original metadata path", () => {
    assert.equal(result.classic.metadataCalls, 1);
    assert.equal(result.classic.records[0].attributes.Name, "Classic");
  });
});
