import assert from "node:assert/strict";
import test from "node:test";

import {
  EXECUTION_ANALYZER_VERSION,
  analyzeExecutionBlock,
  buildExecutionModel,
  executionBlockKey,
  hashExecutionBlock,
  normalizeExecutionSymbol,
  planIncrementalReanalysis,
  queryExecutionSymbol
} from "../dist/execution-model.js";

function access(uid, name, scope = "GlobalVariable") {
  return `<Access Scope="${scope}" UId="${uid}"><Symbol><Component Name="${name}"/></Symbol></Access>`;
}

function constant(uid, value, type = "Bool") {
  return `<Access Scope="LiteralConstant" UId="${uid}"><Constant><ConstantType>${type}</ConstantType><ConstantValue>${value}</ConstantValue></Constant></Access>`;
}

function flgBlock({ kind = "FC", name = "Logic", number = "1", language = "LAD", flg }) {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<Document>",
    `  <SW.Blocks.${kind} ID="0">`,
    "    <AttributeList>",
    `      <Name>${name}</Name>`,
    `      <Number>${number}</Number>`,
    `      <ProgrammingLanguage>${language}</ProgrammingLanguage>`,
    "    </AttributeList>",
    "    <ObjectList>",
    '      <SW.Blocks.CompileUnit ID="1">',
    "        <AttributeList>",
    "          <NetworkSource>",
    flg,
    "          </NetworkSource>",
    "        </AttributeList>",
    "      </SW.Blocks.CompileUnit>",
    "    </ObjectList>",
    `  </SW.Blocks.${kind}>`,
    "</Document>"
  ].join("\n");
}

function sclBlock({ kind = "FC", name = "Logic", number = "1", body }) {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<Document>",
    `  <SW.Blocks.${kind} ID="0">`,
    "    <AttributeList>",
    `      <Name>${name}</Name>`,
    `      <Number>${number}</Number>`,
    "      <ProgrammingLanguage>SCL</ProgrammingLanguage>",
    "    </AttributeList>",
    "    <ObjectList>",
    '      <SW.Blocks.CompileUnit ID="1">',
    "        <AttributeList><NetworkSource><StructuredText>",
    body,
    "        </StructuredText></NetworkSource></AttributeList>",
    "      </SW.Blocks.CompileUnit>",
    "    </ObjectList>",
    `  </SW.Blocks.${kind}>`,
    "</Document>"
  ].join("\n");
}

function token(text) {
  const escaped = text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
  return `<Token Text="${escaped}"/>`;
}

function sclAccess(name, uid = "1", scope = "GlobalVariable") {
  return access(uid, name, scope);
}

function absoluteAccess(uid, area, type, bitOffset, blockNumber = null) {
  return [
    `<Access Scope="Address" UId="${uid}">`,
    `<Address Area="${area}" Type="${type}" BitOffset="${bitOffset}"${blockNumber === null ? "" : ` BlockNumber="${blockNumber}"`}/>` ,
    "</Access>"
  ].join("");
}

function guardSymbols(guard) {
  switch (guard.kind) {
    case "symbol":
      return [guard.symbol];
    case "not":
      return guardSymbols(guard.operand);
    case "and":
    case "or":
      return guard.operands.flatMap(guardSymbols);
    case "compare":
      return [
        ...valueSymbols(guard.left),
        ...valueSymbols(guard.right)
      ];
    case "edge":
      return guardSymbols(guard.operand);
    case "unknown":
      return guard.symbols.map((item) => item.symbol);
    default:
      return [];
  }
}

function valueSymbols(value) {
  if (value.kind === "symbol") return [value.symbol];
  if (value.kind === "operation") return value.operands.flatMap(valueSymbols);
  if (value.kind === "unknown") return value.symbols.map((item) => item.symbol);
  return [];
}

test("LAD/FBD reconstructs a series rung and preserves a normally-closed contact", () => {
  const xml = flgBlock({
    name: "MotorLogic",
    number: "10",
    flg: [
      "            <FlgNet>",
      "              <Parts>",
      access("1", "Start"),
      access("2", "StopOk"),
      access("3", "MotorOn"),
      '                <Part UId="10" Name="Contact"/>',
      '                <Part UId="11" Name="Contact"><Negated Name="operand"/></Part>',
      '                <Part UId="12" Name="Coil"/>',
      "              </Parts>",
      "              <Wires>",
      '                <Wire UId="20"><Powerrail/><NameCon UId="10" Name="in"/></Wire>',
      '                <Wire UId="21"><IdentCon UId="1"/><NameCon UId="10" Name="operand"/></Wire>',
      '                <Wire UId="22"><NameCon UId="10" Name="out"/><NameCon UId="11" Name="in"/></Wire>',
      '                <Wire UId="23"><IdentCon UId="2"/><NameCon UId="11" Name="operand"/></Wire>',
      '                <Wire UId="24"><NameCon UId="11" Name="out"/><NameCon UId="12" Name="in"/></Wire>',
      '                <Wire UId="25"><IdentCon UId="3"/><NameCon UId="12" Name="operand"/></Wire>',
      "              </Wires>",
      "            </FlgNet>"
    ].join("\n")
  });
  const analysis = analyzeExecutionBlock({ xml, kind: "FC", name: "MotorLogic", number: "10" });
  assert.equal(analysis.writeSites.length, 1);
  const write = analysis.writeSites[0];
  assert.equal(write.target, "MotorOn");
  assert.deepEqual(write.effect.kind, "coil");
  assert.equal(write.coverage, "exact");
  assert.deepEqual(new Set(guardSymbols(write.guard)), new Set(["Start", "StopOk"]));
  assert.match(JSON.stringify(write.guard), /"kind":"not"/);
  assert.equal(analysis.networks[0].level, "exact");
});

test("LAD/FBD treats two driven branch outputs on one wire as OR", () => {
  const xml = flgBlock({
    flg: [
      "            <FlgNet><Parts>",
      access("1", "Auto"),
      access("2", "Manual"),
      access("3", "Run"),
      '              <Part UId="10" Name="Contact"/>',
      '              <Part UId="11" Name="Contact"/>',
      '              <Part UId="12" Name="Coil"/>',
      "            </Parts><Wires>",
      '              <Wire UId="20"><Powerrail/><NameCon UId="10" Name="in"/><NameCon UId="11" Name="in"/></Wire>',
      '              <Wire UId="21"><IdentCon UId="1"/><NameCon UId="10" Name="operand"/></Wire>',
      '              <Wire UId="22"><IdentCon UId="2"/><NameCon UId="11" Name="operand"/></Wire>',
      '              <Wire UId="23"><NameCon UId="10" Name="out"/><NameCon UId="11" Name="out"/><NameCon UId="12" Name="in"/></Wire>',
      '              <Wire UId="24"><IdentCon UId="3"/><NameCon UId="12" Name="operand"/></Wire>',
      "            </Wires></FlgNet>"
    ].join("\n")
  });
  const write = analyzeExecutionBlock({ xml, kind: "FC", name: "Logic", number: "1" }).writeSites[0];
  assert.equal(write.guard.kind, "or");
  assert.deepEqual(new Set(guardSymbols(write.guard)), new Set(["Auto", "Manual"]));
});

test("LAD/FBD preserves SET and RESET coil effects", () => {
  const xml = flgBlock({
    flg: [
      "            <FlgNet><Parts>",
      access("1", "SetCondition"),
      access("2", "ResetCondition"),
      access("3", "Latched"),
      access("4", "Latched"),
      '              <Part UId="10" Name="SCoil"/>',
      '              <Part UId="11" Name="RCoil"/>',
      "            </Parts><Wires>",
      '              <Wire UId="20"><IdentCon UId="1"/><NameCon UId="10" Name="in"/></Wire>',
      '              <Wire UId="21"><IdentCon UId="3"/><NameCon UId="10" Name="operand"/></Wire>',
      '              <Wire UId="22"><IdentCon UId="2"/><NameCon UId="11" Name="in"/></Wire>',
      '              <Wire UId="23"><IdentCon UId="4"/><NameCon UId="11" Name="operand"/></Wire>',
      "            </Wires></FlgNet>"
    ].join("\n")
  });
  const writes = analyzeExecutionBlock({ xml, kind: "FC", name: "Latch", number: "2" }).writeSites;
  assert.deepEqual(writes.map((site) => site.effect.mode), ["set", "reset"]);
  assert.deepEqual(writes.map((site) => site.statementOrder), [1, 2]);
});

test("LAD timer call records stateful Q semantics, instance and parameter bindings", () => {
  const xml = flgBlock({
    kind: "FB",
    name: "TimerLogic",
    number: "20",
    flg: [
      "            <FlgNet><Parts>",
      access("1", "Start"),
      constant("2", "T#2s", "Time"),
      access("3", "Done"),
      '              <Call UId="10"><CallInfo Name="TON" BlockType="FB">',
      '                <Instance Scope="GlobalVariable"><Component Name="Timer1"/></Instance>',
      '                <Parameter Name="IN" Section="Input"/>',
      '                <Parameter Name="PT" Section="Input"/>',
      '                <Parameter Name="Q" Section="Output"/>',
      "              </CallInfo></Call>",
      "            </Parts><Wires>",
      '              <Wire UId="20"><IdentCon UId="1"/><NameCon UId="10" Name="IN"/></Wire>',
      '              <Wire UId="21"><IdentCon UId="2"/><NameCon UId="10" Name="PT"/></Wire>',
      '              <Wire UId="22"><IdentCon UId="3"/><NameCon UId="10" Name="Q"/></Wire>',
      "            </Wires></FlgNet>"
    ].join("\n")
  });
  const analysis = analyzeExecutionBlock({ xml, kind: "FB", name: "TimerLogic", number: "20" });
  assert.equal(analysis.callSites.length, 1);
  assert.equal(analysis.callSites[0].calleeName, "TON");
  assert.equal(analysis.callSites[0].instance, "Timer1");
  assert.equal(analysis.writeSites.length, 1);
  assert.equal(analysis.writeSites[0].target, "Done");
  assert.equal(analysis.writeSites[0].effect.kind, "timer");
  assert.equal(analysis.writeSites[0].effect.instruction, "TON");
  assert.equal(analysis.writeSites[0].effect.output, "Q");
  assert.ok(analysis.writeSites[0].normalizedReadSymbols.includes("start"));
  assert.ok(!analysis.writeSites[0].normalizedReadSymbols.includes("done"));
  for (const instruction of ["TOF", "TONR", "TP"]) {
    const variant = analyzeExecutionBlock({
      xml: xml.replace('Name="TON"', `Name="${instruction}"`),
      kind: "FB",
      name: `Timer${instruction}`,
      number: "20"
    });
    assert.equal(variant.writeSites[0].effect.kind, "timer");
    assert.equal(variant.writeSites[0].effect.instruction, instruction);
  }
});

test("unique OB to FB output composes callee guards and formal parameters onto the DB actual", () => {
  const callerXml = flgBlock({
    kind: "OB",
    name: "Main",
    number: "1",
    flg: [
      "            <FlgNet><Parts>",
      access("1", "DB41.DBX6.2"),
      access("2", "StartCondition"),
      '              <Call UId="10"><CallInfo Name="Worker" BlockType="FB">',
      '                <Instance Scope="GlobalVariable"><Component Name="Cell1"/></Instance>',
      '                <Parameter Name="Enable" Section="Input"/>',
      '                <Parameter Name="OUT" Section="Output"/>',
      "              </CallInfo></Call>",
      "            </Parts><Wires>",
      '              <Wire UId="20"><IdentCon UId="1"/><NameCon UId="10" Name="OUT"/></Wire>',
      '              <Wire UId="21"><IdentCon UId="2"/><NameCon UId="10" Name="Enable"/></Wire>',
      "            </Wires></FlgNet>"
    ].join("\n")
  });
  const workerXml = sclBlock({
    kind: "FB",
    name: "Worker",
    number: "2",
    body: [
      token("IF"),
      sclAccess("Enable", "1", "LocalVariable"),
      token("THEN"),
      sclAccess("OUT", "2", "LocalVariable"),
      token(":="),
      token("TRUE"),
      token(";"),
      token("END_IF"),
      token(";")
    ].join("\n")
  });
  const model = buildExecutionModel([
    { xml: callerXml, kind: "OB", name: "Main", number: "1" },
    { xml: workerXml, kind: "FB", name: "Worker", number: "2" }
  ]);
  const write = model.writeSites.find((site) => site.target === "DB41.DBX6.2");
  assert.ok(write);
  assert.equal(write.effect.kind, "assign");
  assert.equal(write.effect.value.kind, "literal");
  assert.equal(write.effect.value.value, "TRUE");
  assert.equal(write.guard.kind, "symbol");
  assert.equal(write.guard.symbol, "StartCondition");
  assert.deepEqual(write.normalizedReadSymbols, ["startcondition"]);
  assert.equal(write.coverage, "exact");
  assert.equal(write.unsupportedReason, undefined);
  assert.equal(write.composedFrom.calleeBlockKey, "FB:2");
  assert.equal(write.composedFrom.formalTarget, "OUT");
  assert.equal(write.executionContexts.length, 1);
  assert.deepEqual(write.executionContexts[0].callPath, ["OB:1", "FB:2"]);
  assert.deepEqual(write.executionContexts[0].instancePath, ["Cell1"]);
  assert.equal(model.unresolvedCalls.length, 0);
  assert.equal(model.coverage.level, "exact");

  const changedWorkerXml = workerXml.replace('<Token Text="IF"/>', '<Token Text="IF"/><Token Text="NOT"/>');
  const refreshed = buildExecutionModel([
    {
      sha256: hashExecutionBlock(callerXml),
      kind: "OB",
      name: "Main",
      number: "1"
    },
    {
      xml: changedWorkerXml,
      sha256: hashExecutionBlock(changedWorkerXml),
      kind: "FB",
      name: "Worker",
      number: "2"
    }
  ], model);
  const recomposed = refreshed.writeSites.find((site) => site.target === "DB41.DBX6.2");
  assert.ok(recomposed);
  assert.equal(recomposed.guard.kind, "not");
  assert.equal(recomposed.guard.operand.kind, "symbol");
  assert.equal(recomposed.guard.operand.symbol, "StartCondition");
  assert.deepEqual(refreshed.incremental.pendingBlockKeys, []);

  const unresolved = buildExecutionModel([
    { xml: callerXml, kind: "OB", name: "Main", number: "1" }
  ]);
  const fallback = unresolved.writeSites.find((site) => site.target === "DB41.DBX6.2");
  assert.ok(fallback);
  assert.equal(fallback.effect.kind, "call-output");
  assert.equal(fallback.coverage, "conservative");
  assert.match(fallback.unsupportedReason, /not composed/i);
});

test("comparison, rising-edge memory and IEC counter output remain explicit stateful semantics", () => {
  const edgeXml = flgBlock({
    flg: [
      "            <FlgNet><Parts>",
      access("1", "Actual"),
      access("2", "Limit"),
      access("3", "EdgeMemory"),
      access("4", "Pulse"),
      '              <Part UId="10" Name="Ge"/>',
      '              <Part UId="11" Name="PBox"/>',
      '              <Part UId="12" Name="Coil"/>',
      "            </Parts><Wires>",
      '              <Wire UId="20"><IdentCon UId="1"/><NameCon UId="10" Name="in1"/></Wire>',
      '              <Wire UId="21"><IdentCon UId="2"/><NameCon UId="10" Name="in2"/></Wire>',
      // Real V20 PBox/NBox wiring: the signal on "in", the edge memory on "bit".
      '              <Wire UId="23"><NameCon UId="10" Name="out"/><NameCon UId="11" Name="in"/></Wire>',
      '              <Wire UId="24"><IdentCon UId="3"/><NameCon UId="11" Name="bit"/></Wire>',
      '              <Wire UId="25"><NameCon UId="11" Name="out"/><NameCon UId="12" Name="in"/></Wire>',
      '              <Wire UId="26"><IdentCon UId="4"/><NameCon UId="12" Name="operand"/></Wire>',
      "            </Wires></FlgNet>"
    ].join("\n")
  });
  const edgeWrite = analyzeExecutionBlock({ xml: edgeXml, kind: "FC", name: "Edge", number: "3" }).writeSites[0];
  assert.match(JSON.stringify(edgeWrite.guard), /"kind":"compare"/);
  assert.match(JSON.stringify(edgeWrite.guard), /"kind":"edge","edge":"rising"/);
  assert.match(JSON.stringify(edgeWrite.guard), /EdgeMemory/);
  const fallingWrite = analyzeExecutionBlock({
    xml: edgeXml.replace('Name="PBox"', 'Name="NBox"'),
    kind: "FC",
    name: "FallingEdge",
    number: "4"
  }).writeSites[0];
  assert.match(JSON.stringify(fallingWrite.guard), /"kind":"edge","edge":"falling"/);

  const counterXml = flgBlock({
    kind: "FB",
    name: "CounterLogic",
    number: "21",
    flg: [
      "            <FlgNet><Parts>",
      access("1", "CountPulse"),
      access("2", "Reached"),
      '              <Call UId="10"><CallInfo Name="CTU" BlockType="FB">',
      '                <Instance Scope="GlobalVariable"><Component Name="Counter1"/></Instance>',
      '                <Parameter Name="CU" Section="Input"/>',
      '                <Parameter Name="Q" Section="Output"/>',
      "              </CallInfo></Call>",
      "            </Parts><Wires>",
      '              <Wire UId="20"><IdentCon UId="1"/><NameCon UId="10" Name="CU"/></Wire>',
      '              <Wire UId="21"><IdentCon UId="2"/><NameCon UId="10" Name="Q"/></Wire>',
      "            </Wires></FlgNet>"
    ].join("\n")
  });
  const counterWrite = analyzeExecutionBlock({ xml: counterXml, kind: "FB", name: "CounterLogic", number: "21" }).writeSites[0];
  assert.equal(counterWrite.effect.kind, "counter");
  assert.equal(counterWrite.effect.instruction, "CTU");
  assert.equal(counterWrite.effect.output, "Q");
});

test("SCL keeps IF/ELSIF/ELSE guards, CASE guards, loop context, RETURN and statement order", () => {
  const body = [
    token("IF"), sclAccess("A", "1"), token("THEN"),
    sclAccess("Q", "2"), token(":="), sclAccess("B", "3"), token(";"),
    token("ELSIF"), sclAccess("C", "4"), token("THEN"),
    sclAccess("Q", "5"), token(":="), token("TRUE"), token(";"),
    token("ELSE"),
    sclAccess("Q", "6"), token(":="), token("FALSE"), token(";"),
    token("END_IF"), token(";"),
    token("CASE"), sclAccess("Mode", "7"), token("OF"),
    token("1"), token(":"), sclAccess("State", "8"), token(":="), sclAccess("X", "9"), token(";"),
    token("2"), token(":"), sclAccess("State", "10"), token(":="), sclAccess("Y", "11"), token(";"),
    token("ELSE"), sclAccess("State", "12"), token(":="), token("0"), token(";"),
    token("END_CASE"), token(";"),
    token("WHILE"), sclAccess("Enabled", "13"), token("DO"),
    sclAccess("Count", "14"), token("+="), token("1"), token(";"),
    token("RETURN"), token(";"),
    sclAccess("NeverAfterReturn", "15"), token(":="), token("TRUE"), token(";"),
    token("END_WHILE"), token(";")
  ].join("\n");
  const xml = sclBlock({ name: "Sequence", number: "30", body });
  const analysis = analyzeExecutionBlock({ xml, kind: "FC", name: "Sequence", number: "30", language: "SCL" });
  assert.equal(analysis.writeSites.length, 8);
  assert.deepEqual(
    analysis.writeSites.map((site) => site.statementOrder),
    [...analysis.writeSites.map((site) => site.statementOrder)].sort((a, b) => a - b)
  );
  assert.equal(analysis.writeSites.filter((site) => site.target === "Q").length, 3);
  assert.equal(analysis.writeSites.filter((site) => site.target === "State").length, 3);
  assert.match(JSON.stringify(analysis.writeSites.find((site) => site.target === "State").guard), /"kind":"compare"/);
  const count = analysis.writeSites.find((site) => site.target === "Count");
  assert.equal(count.effect.readBeforeWrite, true);
  assert.match(JSON.stringify(count.guard), /"kind":"loop"/);
  const unreachable = analysis.writeSites.find((site) => site.target === "NeverAfterReturn");
  assert.deepEqual(unreachable.guard, { kind: "literal", value: false });
  assert.equal(analysis.controlSites.length, 1);
  assert.equal(analysis.controlSites[0].kind, "return");
});

test("SCL conditional RETURN constrains every following statement to the true fallthrough path", () => {
  const body = [
    token("IF"), sclAccess("Abort", "1"), token("THEN"),
    token("RETURN"), token(";"),
    token("END_IF"), token(";"),
    sclAccess("AfterReturn", "2"), token(":="), token("TRUE"), token(";")
  ].join("\n");
  const analysis = analyzeExecutionBlock({
    xml: sclBlock({ name: "ReturnFlow", number: "31", body }),
    kind: "FC",
    name: "ReturnFlow",
    number: "31",
    language: "SCL"
  });
  const write = analysis.writeSites.find((site) => site.target === "AfterReturn");
  assert.ok(write);
  assert.deepEqual(write.guard, {
    kind: "not",
    operand: {
      kind: "symbol",
      symbol: "Abort",
      normalizedSymbol: "abort",
      scope: "GlobalVariable"
    }
  });
  assert.equal(write.coverage, "exact");
  assert.equal(analysis.coverage.level, "exact");
});

test("absolute Bool addresses use DBX/I/Q/M aliases and dynamic array indices cannot be marked exact", () => {
  const addressBody = [
    absoluteAccess("1", "DB", "Bool", 50, 41), token(":="), token("TRUE"), token(";"),
    absoluteAccess("2", "Output", "Bool", 19), token(":="),
    absoluteAccess("3", "Input", "Bool", 12), token(";"),
    absoluteAccess("4", "Memory", "Bool", 1), token(":="), token("FALSE"), token(";")
  ].join("\n");
  const addressAnalysis = analyzeExecutionBlock({
    xml: sclBlock({ name: "AbsoluteAddresses", number: "32", body: addressBody }),
    kind: "FC",
    name: "AbsoluteAddresses",
    number: "32",
    language: "SCL"
  });
  assert.deepEqual(
    addressAnalysis.writeSites.map((site) => site.target),
    ["%DB41.DBX6.2", "%Q2.3", "%M0.1"]
  );
  assert.deepEqual(
    addressAnalysis.writeSites.map((site) => site.normalizedTarget),
    ["db41.dbx6.2", "q2.3", "m0.1"]
  );
  assert.ok(addressAnalysis.writeSites[1].normalizedReadSymbols.includes("i1.4"));
  const exactAddressQuery = queryExecutionSymbol(buildExecutionModel([{
    xml: sclBlock({ name: "AbsoluteAddresses", number: "32", body: addressBody }),
    kind: "FC",
    name: "AbsoluteAddresses",
    number: "32",
    language: "SCL"
  }]), "DB41.DBX6.2", { match: "exact" });
  assert.equal(exactAddressQuery.matches.length, 1);
  assert.equal(exactAddressQuery.writes.length, 1);
  assert.equal(exactAddressQuery.writes[0].target, "%DB41.DBX6.2");

  const arrayAccess = [
    '<Access Scope="GlobalVariable" UId="10"><Symbol>',
    '<Component Name="Array" AccessModifier="Array">',
    '<Access Scope="GlobalVariable" UId="11"><Symbol><Component Name="Index"/></Symbol></Access>',
    "</Component></Symbol></Access>"
  ].join("");
  const arrayBody = [
    sclAccess("ArrayValue", "12"), token(":="), arrayAccess, token(";")
  ].join("\n");
  const arrayAnalysis = analyzeExecutionBlock({
    xml: sclBlock({ name: "ArrayAccess", number: "33", body: arrayBody }),
    kind: "FC",
    name: "ArrayAccess",
    number: "33",
    language: "SCL"
  });
  const arrayWrite = arrayAnalysis.writeSites.find((site) => site.target === "ArrayValue");
  assert.ok(arrayWrite);
  assert.equal(arrayWrite.effect.kind, "assign");
  assert.equal(arrayWrite.effect.value.kind, "unknown");
  assert.equal(arrayWrite.coverage, "conservative");
  assert.equal(arrayAnalysis.coverage.level, "conservative");
});

test("project model builds OB roots and keeps both FB instance execution contexts", () => {
  const obXml = flgBlock({
    kind: "OB",
    name: "Main",
    number: "1",
    flg: [
      "            <FlgNet><Parts>",
      '              <Call UId="10"><CallInfo Name="Worker" BlockType="FB"><Instance Scope="GlobalVariable"><Component Name="Cell1"/></Instance></CallInfo></Call>',
      '              <Call UId="11"><CallInfo Name="Worker" BlockType="FB"><Instance Scope="GlobalVariable"><Component Name="Cell2"/></Instance></CallInfo></Call>',
      "            </Parts><Wires/></FlgNet>"
    ].join("\n")
  });
  const workerXml = sclBlock({
    kind: "FB",
    name: "Worker",
    number: "100",
    body: [
      sclAccess("Ready", "1", "LocalVariable"),
      token(":="),
      sclAccess("MachineOk", "2"),
      token(";")
    ].join("\n")
  });
  const index = buildExecutionModel([
    { xml: obXml, sha256: hashExecutionBlock(obXml), kind: "OB", name: "Main", number: "1" },
    { xml: workerXml, sha256: hashExecutionBlock(workerXml), kind: "FB", name: "Worker", number: "100" }
  ]);
  assert.equal(index.roots.length, 1);
  const write = index.writeSites.find((site) => site.target === "Ready");
  assert.equal(write.executionContexts.length, 2);
  assert.deepEqual(
    new Set(write.executionContexts.map((context) => context.instancePath.at(-1))),
    new Set(["Cell1", "Cell2"])
  );
  assert.equal(write.taskOB, undefined);
  assert.deepEqual(write.callPath, []);
});

test("softwarePath keeps identical OB/FB numbers in different PLC software containers isolated", () => {
  const plcA = sclBlock({
    kind: "OB",
    name: "Main",
    number: "1",
    body: [sclAccess("RunA", "1"), token(":="), token("TRUE"), token(";")].join("\n")
  });
  const plcB = sclBlock({
    kind: "OB",
    name: "Main",
    number: "1",
    body: [sclAccess("RunB", "1"), token(":="), token("TRUE"), token(";")].join("\n")
  });
  const index = buildExecutionModel([
    { xml: plcA, softwarePath: "StationA/PLC_1/Software", kind: "OB", name: "Main", number: "1" },
    { xml: plcB, softwarePath: "StationB/PLC_1/Software", kind: "OB", name: "Main", number: "1" }
  ]);
  const keys = Object.keys(index.blocks);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
  assert.ok(keys.includes("stationa/plc_1/software::OB:1"));
  assert.ok(keys.includes("stationb/plc_1/software::OB:1"));
  assert.equal(index.roots.length, 2);
  assert.deepEqual(
    new Set(index.writeSites.map((site) => site.softwarePath)),
    new Set(["StationA/PLC_1/Software", "StationB/PLC_1/Software"])
  );
});

test("manifest hashes permit reuse without XML and expose pending changed blocks plus callers", () => {
  const obXml = flgBlock({
    kind: "OB",
    name: "Main",
    number: "1",
    flg: [
      "            <FlgNet><Parts>",
      '              <Call UId="10"><CallInfo Name="Worker" BlockType="FB"><Instance Scope="GlobalVariable"><Component Name="Cell"/></Instance></CallInfo></Call>',
      "            </Parts><Wires/></FlgNet>"
    ].join("\n")
  });
  const workerXml = sclBlock({
    kind: "FB",
    name: "Worker",
    number: "100",
    body: [sclAccess("Q", "1"), token(":="), token("TRUE"), token(";")].join("\n")
  });
  const initial = buildExecutionModel([
    { xml: obXml, sha256: hashExecutionBlock(obXml), kind: "OB", name: "Main", number: "1", relativePath: "old/OB1.xml" },
    { xml: workerXml, sha256: hashExecutionBlock(workerXml), kind: "FB", name: "Worker", number: "100", relativePath: "old/FB100.xml" }
  ]);
  const unchangedDescriptors = [
    { sha256: hashExecutionBlock(obXml), kind: "OB", name: "Main", number: "1", relativePath: "new/OB1.xml" },
    { sha256: hashExecutionBlock(workerXml), kind: "FB", name: "Worker", number: "100", relativePath: "new/FB100.xml" }
  ];
  const reused = buildExecutionModel(unchangedDescriptors, initial);
  assert.deepEqual(reused.incremental.pendingBlockKeys, []);
  assert.deepEqual(reused.incremental.changedBlockKeys, []);
  assert.equal(reused.writeSites.length, initial.writeSites.length);
  assert.equal(reused.blocks["FB:100"].relativePath, "new/FB100.xml");
  assert.equal(reused.writeSites[0].relativePath, "new/FB100.xml");

  const changedHash = "f".repeat(64);
  const changedDescriptors = [
    unchangedDescriptors[0],
    { sha256: changedHash, kind: "FB", name: "Worker", number: "100" }
  ];
  const plan = planIncrementalReanalysis(changedDescriptors, initial);
  assert.deepEqual(plan.xmlRequiredBlockKeys, ["FB:100"]);
  assert.deepEqual(plan.dependentBlockKeys, ["OB:1"]);
  const partial = buildExecutionModel(changedDescriptors, initial);
  assert.deepEqual(partial.incremental.pendingBlockKeys, ["FB:100"]);
  assert.match(partial.coverage.issues.join("\n"), /requires XML/);
  assert.equal(executionBlockKey(changedDescriptors[1]), "FB:100");
});

test("a re-export that only changes the export time keeps the block hash and reuses its analysis", () => {
  const body = sclBlock({
    kind: "FB",
    name: "Worker",
    number: "100",
    body: [sclAccess("Q", "1"), token(":="), token("TRUE"), token(";")].join("\n")
  });
  const exported = (created) => body.replace("<Document>",
    `<Document>\n  <DocumentInfo>\n    <Created>${created}</Created>\n    <ExportSetting>None</ExportSetting>\n  </DocumentInfo>`);
  const first = exported("2026-11-05T17:47:58.6038184Z");
  const again = exported("2026-11-05T17:52:28.6038184Z");
  assert.notEqual(first, again);
  assert.equal(hashExecutionBlock(first), hashExecutionBlock(again));
  const initial = buildExecutionModel([{ xml: first, sha256: hashExecutionBlock(first), kind: "FB", name: "Worker", number: "100" }]);
  const plan = planIncrementalReanalysis([{ sha256: hashExecutionBlock(again), kind: "FB", name: "Worker", number: "100" }], initial);
  assert.deepEqual(plan.xmlRequiredBlockKeys, []);
  assert.deepEqual(plan.reusableBlockKeys, ["FB:100"]);

  // A program change, or any other DocumentInfo field, still changes the hash.
  const edited = again.replace(token("TRUE"), token("FALSE"));
  assert.notEqual(hashExecutionBlock(edited), hashExecutionBlock(again));
  const otherSetting = again.replace("<ExportSetting>None</ExportSetting>", "<ExportSetting>WithDefaults</ExportSetting>");
  assert.notEqual(hashExecutionBlock(otherSetting), hashExecutionBlock(again));
});

test("local symbols are owner-scoped and symbol adjacency supports fast suffix query", () => {
  const firstXml = sclBlock({
    kind: "FB",
    name: "First",
    number: "1",
    body: [sclAccess("Temp", "1", "LocalVariable"), token(":="), sclAccess("Input", "2"), token(";")].join("\n")
  });
  const secondXml = sclBlock({
    kind: "FB",
    name: "Second",
    number: "2",
    body: [sclAccess("Temp", "1", "LocalVariable"), token(":="), sclAccess("Input", "2"), token(";")].join("\n")
  });
  const index = buildExecutionModel([
    { xml: firstXml, kind: "FB", name: "First", number: "1" },
    { xml: secondXml, kind: "FB", name: "Second", number: "2" }
  ]);
  assert.equal(normalizeExecutionSymbol("#Temp", "LocalVariable", "FB:1"), "fb:1::temp");
  assert.ok(index.adjacency["fb:1::temp"]);
  assert.ok(index.adjacency["fb:2::temp"]);
  const query = queryExecutionSymbol(index, "Temp", { match: "suffix" });
  assert.equal(query.matches.length, 2);
  assert.equal(query.writes.length, 2);
});

test("unsupported GRAPH content is explicit and never reported as fully understood", () => {
  const xml = [
    "<Document><SW.Blocks.FB><ObjectList>",
    '<SW.Blocks.CompileUnit ID="1"><AttributeList><NetworkSource><Graph><Step Name="S1"/></Graph></NetworkSource></AttributeList></SW.Blocks.CompileUnit>',
    "</ObjectList></SW.Blocks.FB></Document>"
  ].join("");
  const analysis = analyzeExecutionBlock({ xml, kind: "FB", name: "GraphBlock", number: "9", language: "GRAPH" });
  assert.equal(analysis.coverage.level, "unsupported");
  assert.match(analysis.coverage.issues.join("\n"), /GRAPH execution semantics are not implemented/);
  assert.equal(analysis.analyzerVersion, EXECUTION_ANALYZER_VERSION);
});

test("LAD instruction boxes: MOVE assigns, GET is an instruction call, and ENO chains keep the enable", () => {
  const xml = flgBlock({
    flg: [
      "            <FlgNet><Parts>",
      access("1", "Enable"),
      access("2", "Source"),
      access("3", "TargetA"),
      access("4", "Other"),
      access("5", "TargetB"),
      access("6", "Clock"),
      '              <Part UId="10" Name="Contact"/>',
      '              <Part UId="11" Name="Move" DisabledENO="false"><TemplateValue Name="Card" Type="Cardinality">1</TemplateValue></Part>',
      '              <Part UId="12" Name="Move"><TemplateValue Name="Card" Type="Cardinality">1</TemplateValue></Part>',
      '              <Part UId="13" Name="GET" Version="1.3"><Instance Scope="GlobalVariable" UId="14"><Component Name="GET_DB"/></Instance></Part>',
      "            </Parts><Wires>",
      '              <Wire UId="20"><Powerrail/><NameCon UId="10" Name="in"/><NameCon UId="13" Name="en"/></Wire>',
      '              <Wire UId="21"><IdentCon UId="1"/><NameCon UId="10" Name="operand"/></Wire>',
      '              <Wire UId="22"><NameCon UId="10" Name="out"/><NameCon UId="11" Name="en"/></Wire>',
      '              <Wire UId="23"><IdentCon UId="2"/><NameCon UId="11" Name="in"/></Wire>',
      '              <Wire UId="24"><NameCon UId="11" Name="out1"/><IdentCon UId="3"/></Wire>',
      '              <Wire UId="25"><NameCon UId="11" Name="eno"/><NameCon UId="12" Name="en"/></Wire>',
      '              <Wire UId="26"><IdentCon UId="4"/><NameCon UId="12" Name="in"/></Wire>',
      '              <Wire UId="27"><NameCon UId="12" Name="out1"/><IdentCon UId="5"/></Wire>',
      '              <Wire UId="28"><IdentCon UId="6"/><NameCon UId="13" Name="REQ"/></Wire>',
      "            </Wires></FlgNet>"
    ].join("\n")
  });
  const analysis = analyzeExecutionBlock({ xml, kind: "FC", name: "Boxes", number: "3" });
  const byTarget = Object.fromEntries(analysis.writeSites.map((site) => [site.target, site]));
  assert.equal(byTarget.TargetA.effect.kind, "assign");
  assert.equal(byTarget.TargetA.effect.value.symbol, "Source");
  assert.deepEqual(guardSymbolsOf(byTarget.TargetA.guard), ["Enable"]);
  assert.equal(byTarget.TargetB.effect.value.symbol, "Other");
  assert.deepEqual(guardSymbolsOf(byTarget.TargetB.guard), ["Enable"], "the second MOVE runs when the first one's ENO is on");
  const get = analysis.callSites.find((call) => call.calleeName === "GET");
  assert.equal(get.calleeKind, "Instruction");
  assert.equal(get.instance, "GET_DB");
  assert.deepEqual(get.parameterBindings.filter((b) => b.name === "REQ").map((b) => b.direction), ["input"]);
  assert.notEqual(analysis.networks[0].level, "unsupported");
});

test("instruction calls are never reported as unresolved user blocks", () => {
  const xml = flgBlock({
    kind: "OB",
    name: "Main",
    number: "1",
    flg: [
      "            <FlgNet><Parts>",
      access("1", "A"),
      access("2", "B"),
      '              <Part UId="10" Name="Add"><TemplateValue Name="SrcType" Type="Type">Int</TemplateValue></Part>',
      "            </Parts><Wires>",
      '              <Wire UId="20"><Powerrail/><NameCon UId="10" Name="en"/></Wire>',
      '              <Wire UId="21"><IdentCon UId="1"/><NameCon UId="10" Name="in1"/></Wire>',
      '              <Wire UId="22"><IdentCon UId="1"/><NameCon UId="10" Name="in2"/></Wire>',
      '              <Wire UId="23"><NameCon UId="10" Name="out"/><IdentCon UId="2"/></Wire>',
      "            </Wires></FlgNet>"
    ].join("\n")
  });
  const model = buildExecutionModel([{ xml, kind: "OB", name: "Main", number: "1", relativePath: "Main.xml" }]);
  assert.equal(model.unresolvedCalls.length, 0);
  const write = Object.values(model.blocks)[0].writeSites[0];
  assert.equal(write.target, "B");
  assert.equal(write.effect.kind, "call-output");
  assert.ok(write.normalizedReadSymbols.includes("a"));
});

test("a P contact wired as V20 exports it (pre, bit before operand) is a rising edge of the operand in series", () => {
  const xml = flgBlock({
    flg: [
      "            <FlgNet><Parts>",
      access("1", "Button"),
      access("2", "EdgeMem"),
      access("3", "Pulse"),
      access("4", "Enable"),
      '              <Part UId="9" Name="Contact"/>',
      '              <Part UId="10" Name="PContact"/>',
      '              <Part UId="11" Name="Coil"/>',
      "            </Parts><Wires>",
      '              <Wire UId="19"><Powerrail/><NameCon UId="9" Name="in"/></Wire>',
      '              <Wire UId="20"><IdentCon UId="4"/><NameCon UId="9" Name="operand"/></Wire>',
      '              <Wire UId="21"><NameCon UId="9" Name="out"/><NameCon UId="10" Name="pre"/></Wire>',
      '              <Wire UId="22"><IdentCon UId="2"/><NameCon UId="10" Name="bit"/></Wire>',
      '              <Wire UId="23"><IdentCon UId="1"/><NameCon UId="10" Name="operand"/></Wire>',
      '              <Wire UId="24"><NameCon UId="10" Name="out"/><NameCon UId="11" Name="in"/></Wire>',
      '              <Wire UId="25"><IdentCon UId="3"/><NameCon UId="11" Name="operand"/></Wire>',
      "            </Wires></FlgNet>"
    ].join("\n")
  });
  const guard = analyzeExecutionBlock({ xml, kind: "FC", name: "Edge", number: "4" }).writeSites[0].guard;
  const edge = JSON.stringify(guard);
  assert.ok(edge.includes('"kind":"edge"'), edge);
  assert.deepEqual(guardSymbolsOf(guard).sort(), ["Button", "Enable"], edge);
  assert.ok(edge.includes('"memory":{"symbol":"EdgeMem"'), edge);
});

test("an SR box writes its operand, and ENO of a box that can fail is not exact", () => {
  const xml = flgBlock({
    flg: [
      "            <FlgNet><Parts>",
      access("1", "SetIt"),
      access("2", "ResetIt"),
      access("3", "Latch"),
      access("4", "A"),
      access("5", "Q"),
      access("6", "Ok"),
      '              <Part UId="10" Name="Sr"/>',
      '              <Part UId="11" Name="Div"><TemplateValue Name="SrcType" Type="Type">Int</TemplateValue></Part>',
      '              <Part UId="12" Name="Coil"/>',
      "            </Parts><Wires>",
      '              <Wire UId="20"><IdentCon UId="1"/><NameCon UId="10" Name="s"/></Wire>',
      '              <Wire UId="21"><IdentCon UId="2"/><NameCon UId="10" Name="r1"/></Wire>',
      '              <Wire UId="22"><IdentCon UId="3"/><NameCon UId="10" Name="operand"/></Wire>',
      '              <Wire UId="23"><Powerrail/><NameCon UId="11" Name="en"/></Wire>',
      '              <Wire UId="24"><IdentCon UId="4"/><NameCon UId="11" Name="in1"/></Wire>',
      '              <Wire UId="25"><IdentCon UId="4"/><NameCon UId="11" Name="in2"/></Wire>',
      '              <Wire UId="26"><NameCon UId="11" Name="out"/><IdentCon UId="5"/></Wire>',
      '              <Wire UId="27"><NameCon UId="11" Name="eno"/><NameCon UId="12" Name="in"/></Wire>',
      '              <Wire UId="28"><IdentCon UId="6"/><NameCon UId="12" Name="operand"/></Wire>',
      "            </Wires></FlgNet>"
    ].join("\n")
  });
  const analysis = analyzeExecutionBlock({ xml, kind: "FC", name: "Boxes2", number: "5" });
  assert.ok(analysis.writeSites.some((site) => site.target === "Latch"), JSON.stringify(analysis.writeSites.map((s) => s.target)));
  const ok = analysis.writeSites.find((site) => site.target === "Ok");
  assert.notEqual(ok.coverage, "exact");
});

function guardSymbolsOf(guard) {
  return [...new Set(guardSymbols(guard))];
}
test("an FBD P_TRIG box (PBox) is a rising edge of its in signal", () => {
  const xml = flgBlock({
    language: "FBD",
    flg: [
      "            <FlgNet><Parts>",
      access("1", "Sig"),
      access("2", "EdgeMem"),
      access("3", "Pulse"),
      '              <Part UId="10" Name="PBox"/>',
      '              <Part UId="11" Name="Coil"/>',
      "            </Parts><Wires>",
      '              <Wire UId="20"><IdentCon UId="1"/><NameCon UId="10" Name="in"/></Wire>',
      '              <Wire UId="21"><IdentCon UId="2"/><NameCon UId="10" Name="bit"/></Wire>',
      '              <Wire UId="22"><NameCon UId="10" Name="out"/><NameCon UId="11" Name="in"/></Wire>',
      '              <Wire UId="23"><IdentCon UId="3"/><NameCon UId="11" Name="operand"/></Wire>',
      "            </Wires></FlgNet>"
    ].join("\n")
  });
  const site = analyzeExecutionBlock({ xml, kind: "FC", name: "Edge2", number: "6" }).writeSites[0];
  assert.deepEqual(guardSymbolsOf(site.guard), ["Sig"], JSON.stringify(site.guard));
  assert.equal(site.coverage, "exact", JSON.stringify(site.guard));
});