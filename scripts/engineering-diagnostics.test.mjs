import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectEngineering } from "../dist/engineering-diagnostics.js";

const record = (id, type, attributes = {}, parentId = null) => ({ id, type: `Siemens.Engineering.${type}`, attributes, parentId, relation: "Items", collections: [], unreadableAttributes: [] });
const run = (records, extra = {}) => inspectEngineering({ records, issues: [], truncated: false, ...extra });
const reference = refId => ({ refId });

test("same IP is a review finding only inside the same observed subnet", () => {
  const rows = ["a", "b", "c"].map((id, i) => record(id, "HW.Node", { Address: "192.0.2.10", ConnectedSubnet: reference(i === 2 ? "s2" : "s1") }));
  const report = run(rows);
  assert.equal(report.findings.length, 1);
  assert.deepEqual(report.findings[0].objects, ["a", "b"]);
  assert.equal(report.findings[0].severity, "needs_review");
  assert.equal(run(rows.map(r => ({ ...r, attributes: { Address: "192.0.2.10" } }))).findings.length, 0);
});

test("malformed masks and enabled off-subnet gateways carry actual evidence", () => {
  const r = run([
    record("a", "HW.Node", { Address: "192.0.2.10", SubnetMask: "255.0.255.0" }),
    record("b", "HW.Node", { Address: "192.0.2.10", SubnetMask: "255.255.255.0", UseRouter: true, RouterAddress: "198.51.100.1" }),
    record("c", "HW.Node", { Address: "2" })
  ]);
  assert.deepEqual(r.findings.map(f => f.code), ["invalid_configured_subnet_mask", "configured_gateway_outside_subnet"]);
});

function linkedProject() {
  return [
    record("cpuA", "HW.Device", { Name: "CPU A" }),
    record("cpuB", "HW.Device", { Name: "CPU B" }),
    record("plcA", "SW.PlcSoftware", { Name: "PLC" }, "cpuA"),
    record("plcB", "SW.PlcSoftware", { Name: "PLC" }, "cpuB"),
    record("pa", "SW.Tags.PlcTag", { Name: "Ready", DataTypeName: "Bool" }, "plcA"),
    record("pb", "SW.Tags.PlcTag", { Name: "Ready", DataTypeName: "Int" }, "plcB"),
    record("hmi", "HmiUnified.HmiSoftware", { Name: "HMI" }),
    record("connection", "HmiUnified.HmiConnections.HmiConnection", { Name: "PLC connection", Partner: reference("cpuA") }, "hmi"),
    record("tag", "HmiUnified.HmiTags.HmiTag", { Name: "Ready display", Connection: "PLC connection", PlcTag: "Ready", DataType: "Bool" }, "hmi")
  ];
}

test("same PLC/tag names do not cross a connection's exact partner", () => {
  const r = run(linkedProject());
  assert.equal(r.links[0].plcTag, "pa");
  assert.equal(r.findings.length, 0);
});

test("ambiguous HMI connections are never guessed", () => {
  const rows = linkedProject();
  rows.push(record("connection2", "HmiUnified.HmiConnections.HmiConnection", { Name: "PLC connection", Partner: reference("cpuB") }, "hmi"));
  const r = run(rows);
  assert.equal(r.links[0].status, "unresolved_connection");
  assert.equal(r.findings[0].code, "hmi_connection_unresolved");
});

test("missing partner cannot fall back to a globally matching PLC tag", () => {
  const rows = linkedProject();
  delete rows.find(r => r.id === "connection").attributes.Partner;
  assert.equal(run(rows).links[0].status, "plc_identity_unresolved");
});

test("Unified V20 string Station plus Partner identifies the PLC without a global-name guess", () => {
  const rows = linkedProject();
  const c = rows.find(r => r.id === "connection");
  c.attributes.Partner = "PLC";
  c.attributes.Station = "CPU A";
  assert.equal(run(rows).links[0].plcTag, "pa");
  delete c.attributes.Station;
  assert.equal(run(rows).links[0].status, "plc_identity_unresolved");
});

test("DB references remain unresolved rather than falsely missing", () => {
  const rows = linkedProject();
  rows.find(r => r.id === "tag").attributes.PlcTag = '"DB100".Ready';
  const r = run(rows);
  assert.equal(r.links[0].status, "plc_reference_needs_block_query");
  assert.equal(r.findings[0].severity, "needs_review");
});

test("declared type differences remain a review item, not an incompatible-driver claim", () => {
  const rows = linkedProject();
  rows.find(r => r.id === "tag").attributes.DataType = "Int";
  assert.equal(run(rows).findings[0].code, "hmi_plc_type_difference");
});

test("alarm bit limits use the trigger tag belonging to the same HMI", () => {
  const rows = [
    record("h1", "HmiUnified.HmiSoftware"), record("h2", "HmiUnified.HmiSoftware"),
    record("t1", "HmiUnified.HmiTags.HmiTag", { Name: "Alarms", DataType: "Word" }, "h1"),
    record("t2", "HmiUnified.HmiTags.HmiTag", { Name: "Alarms", DataType: "DWord" }, "h2"),
    record("alarm", "HmiUnified.HmiAlarm.HmiDiscreteAlarm", { RaisedStateTag: "Alarms", RaisedStateTagBitNumber: 16 }, "h1")
  ];
  assert.equal(run(rows).findings[0].code, "alarm_bit_out_of_range");
  rows[4].attributes.RaisedStateTagBitNumber = 15;
  assert.equal(run(rows).findings.length, 0);
  rows[4].attributes.RaisedStateTagBitNumber = 16;
  rows[2].attributes.ArraySize = 2;
  assert.equal(run(rows).findings.length, 0);
  delete rows[2].attributes.ArraySize;
  rows[2].attributes.TagType = "Array";
  assert.equal(run(rows).findings.length, 0);
});

test("partial evidence never becomes a whole-project pass", () => {
  const r = run([], { truncated: true, issues: [{ status: "classic_hmi_alarms_unsupported" }] });
  assert.equal(r.status, "partial");
  assert.match(r.conclusion, /not a whole-project pass/);
  assert.ok(r.coverage.notChecked.includes("alarm text meaning, acknowledgement and reset logic"));
});

test("finding output is bounded without losing the actual finding count", () => {
  const rows = Array.from({ length: 510 }, (_, i) => record(String(i), "HW.Node", { Address: "999.1.1.1" }));
  const r = run(rows);
  assert.equal(r.findings.length, 500);
  assert.equal(r.counts.findings, 510);
  assert.equal(r.findingsTruncated, true);
});
