import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHmiSnapshot, hmiExportKey, parseHmiSnapshot } from "../dist/hmi-export.js";

const identity = { projectPath: "c:\\projects\\line.ap20", hmiName: "Operator", hmiPath: "Station/Runtime" };
function observation() {
  return {
    target: { name: "Operator", path: "Station/Runtime", type: "Siemens.Engineering.HmiUnified.HmiSoftware" },
    hmi: { schemaVersion: 1, records: [{ id: "hmi", attributes: { Name: "Operator" } }], issues: [], truncated: false,
      coverage: { sections: ["alarms", "tags", "connections", "screens", "scripts"].map(section => ({ section, state: "exposed" })) } }
  };
}
test("HMI observations round-trip with identity and content integrity", () => {
  const snapshot = createHmiSnapshot(identity, observation());
  assert.equal(snapshot.usable, true);
  assert.deepEqual(parseHmiSnapshot(JSON.stringify(snapshot), identity), snapshot);
});
test("HMI cache keys separate exact projects and duplicate hardware paths", () => {
  for (const changed of [{ projectPath: "c:\\projects\\other.ap20" }, { hmiName: "Heating" }, { hmiPath: "Other/Runtime" }])
    assert.notEqual(hmiExportKey(identity), hmiExportKey({ ...identity, ...changed }));
});
test("wrong HMI targets cannot be published", () => {
  const value = observation();
  value.target.path = "Heating/Runtime";
  assert.throws(() => createHmiSnapshot(identity, value), /identity mismatch/);
});
test("unavailable sections and partial reads cannot become reusable success", () => {
  for (const mutate of [value => value.hmi.issues.push({ status: "attribute_unreadable" }),
    value => value.hmi.truncated = true,
    value => value.hmi.coverage.sections.pop(),
    value => value.hmi.coverage.sections[0].state = "unavailable",
    value => value.hmi.coverage.sections = []]) {
    const value = observation(); mutate(value);
    assert.equal(createHmiSnapshot(identity, value).usable, false);
  }
});
test("tampered or cross-project observations fail closed", () => {
  const value = createHmiSnapshot(identity, observation());
  assert.throws(() => parseHmiSnapshot(JSON.stringify(value), { ...identity, hmiName: "Heating" }), /identity/);
  value.observation.hmi.records[0].attributes.Name = "Tampered";
  assert.throws(() => parseHmiSnapshot(JSON.stringify(value), identity), /integrity/);
});
test("a forged reusable flag cannot conceal missing alarms", () => {
  const value = observation(); value.hmi.coverage.sections.shift();
  const snapshot = createHmiSnapshot(identity, value); snapshot.usable = true;
  assert.throws(() => parseHmiSnapshot(JSON.stringify(snapshot), identity), /integrity/);
});

test("MCP reuses a canonical HMI file without a project file or native core", async () => {
  const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const temp = await mkdtemp(path.join(os.tmpdir(), "tia-hmi-test-"));
  const projectPath = path.join(temp, "offline.ap20");
  const selected = { ...identity, projectPath: projectPath.toLowerCase() };
  const exportRoot = path.resolve(process.env.TIA_MCP_WORKSPACE_ROOT?.trim() || serverRoot, "tia-exports", "hmi");
  const file = path.join(exportRoot, `${hmiExportKey(selected)}.json`);
  const original = JSON.stringify(createHmiSnapshot(selected, observation()));
  const client = new Client({ name: "hmi-cache-test", version: "1.0" });
  try {
    await mkdir(exportRoot, { recursive: true });
    await writeFile(file, original, { flag: "wx" });
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [path.join(serverRoot, "dist/index.js")], cwd: serverRoot,
      env: { ...process.env, TIA_MCP_ALLOWED_PROJECT_ROOTS: temp,
        TIA_MCP_LIVE_CORE_EXE: path.join(temp, "absent.exe") } }));
    const args = { projectPath, hmiName: selected.hmiName, hmiPath: selected.hmiPath };
    const result = await client.callTool({ name: "tia_export_hmi_configuration", arguments: args });
    assert.equal(result.structuredContent.status, "reused", JSON.stringify(result));
    assert.equal(result.structuredContent.file, file);
    assert.equal(await readFile(file, "utf8"), original);
    const refresh = await client.callTool({ name: "tia_export_hmi_configuration", arguments: { ...args, refresh: true, processId: 2147483647 } });
    assert.equal(refresh.structuredContent.ok, false);
    assert.equal(await readFile(file, "utf8"), original, "failed refresh preserves the usable file");
  } finally {
    await client.close();
    await rm(file, { force: true });
    await rm(temp, { recursive: true, force: true });
  }
});
