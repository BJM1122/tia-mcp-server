import assert from "node:assert/strict";
import test from "node:test";

import { renderBlockXml } from "../dist/block-render.js";
import { analyzeExecutionBlock } from "../dist/execution-model.js";

// Synthetic LAD fixtures from the 0.24.1 review (Codex): ENO chains and the two ways a parallel join can
// be written (several sources on one wire, several wires on one input pin). Neither parallel form occurs
// in the real V20 exports checked so far (375 blocks), but both must keep every Boolean branch, and the
// renderer and the analyzer must agree. Not plant exports; never import these.

const access = (uid, name) =>
  `<Access Scope="GlobalVariable" UId="${uid}"><Symbol><Component Name="${name}"/></Symbol></Access>`;
const pin = (uid, name) => `<NameCon UId="${uid}" Name="${name}"/>`;
const ident = (uid) => `<IdentCon UId="${uid}"/>`;
const power = "<Powerrail/>";
let wireUid = 500;
const wire = (...ends) => `<Wire UId="${wireUid++}">${ends.join("")}</Wire>`;

function fc(name, parts, wires) {
  return `<?xml version="1.0" encoding="utf-8"?>
<Document>
  <SW.Blocks.FC ID="0">
    <AttributeList><Name>${name}</Name><Number>1</Number><ProgrammingLanguage>LAD</ProgrammingLanguage></AttributeList>
    <ObjectList>
      <SW.Blocks.CompileUnit ID="1" CompositionName="CompileUnits">
        <AttributeList>
          <NetworkSource>
            <FlgNet xmlns="http://www.siemens.com/automation/Openness/SW/NetworkSource/FlgNet/v5">
              <Parts>${parts}</Parts>
              <Wires>${wires}</Wires>
            </FlgNet>
          </NetworkSource>
          <ProgrammingLanguage>LAD</ProgrammingLanguage>
        </AttributeList>
      </SW.Blocks.CompileUnit>
    </ObjectList>
  </SW.Blocks.FC>
</Document>`;
}

const render = (xml) => renderBlockXml(xml).networks[0];
const analyze = (xml) => analyzeExecutionBlock({ xml, kind: "FC", name: "Probe", number: "1" });

function guardSymbols(guard, out = []) {
  if (!guard || typeof guard !== "object") return out;
  if (guard.kind === "symbol") out.push(guard.symbol);
  for (const value of Object.values(guard)) {
    if (Array.isArray(value)) value.forEach((item) => guardSymbols(item, out));
    else if (value && typeof value === "object") guardSymbols(value, out);
  }
  return out;
}

// Parallel Auto/Manual contacts driving the Run coil, written in one of the two join forms.
function parallel(form, { reverse = false, negateManual = false } = {}) {
  const parts = access(1, "Auto") + access(2, "Manual") + access(3, "Run") +
    '<Part UId="10" Name="Contact"/>' +
    `<Part UId="11" Name="Contact">${negateManual ? '<Negated Name="operand"/>' : ""}</Part>` +
    '<Part UId="12" Name="Coil"/>';
  const [first, second] = reverse ? [11, 10] : [10, 11];
  const join = form === "one-wire"
    ? wire(pin(first, "out"), pin(second, "out"), pin(12, "in"))
    : wire(pin(first, "out"), pin(12, "in")) + wire(pin(second, "out"), pin(12, "in"));
  return fc("BranchProbe", parts,
    wire(power, pin(10, "in"), pin(11, "in")) + wire(ident(1), pin(10, "operand")) +
      wire(ident(2), pin(11, "operand")) + join + wire(ident(3), pin(12, "operand")));
}

for (const form of ["one-wire", "two-wires"]) {
  for (const reverse of [false, true]) {
    test(`parallel join (${form}${reverse ? ", reversed" : ""}) keeps both branches in renderer and analyzer`, () => {
      const xml = parallel(form, { reverse });
      const network = render(xml);
      const line = network.lines.find((l) => l.includes('"Run" ='));
      assert.ok(line, network.lines.join("\n"));
      assert.match(line, /"Auto"/);
      assert.match(line, /"Manual"/);
      assert.match(line, / OR /);
      assert.equal(network.lines.some((l) => l.includes("unconnected")), false, network.lines.join("\n"));

      const writes = analyze(xml).writeSites.filter((w) => w.target === "Run");
      assert.equal(writes.length, 1);
      assert.equal(writes[0].guard.kind, "or");
      assert.deepEqual(guardSymbols(writes[0].guard).sort(), ["Auto", "Manual"]);
      assert.equal(writes[0].coverage, "exact");
    });
  }

  test(`parallel join (${form}) keeps a negated branch`, () => {
    const xml = parallel(form, { negateManual: true });
    const line = render(xml).lines.find((l) => l.includes('"Run" ='));
    assert.match(line, /NOT "Manual"/);
    assert.match(line, /"Auto"/);
    const guard = analyze(xml).writeSites.find((w) => w.target === "Run").guard;
    assert.equal(guard.kind, "or");
    assert.ok(guard.operands.some((g) => g.kind === "not" && g.operand.symbol === "Manual"), JSON.stringify(guard));
  });
}

// Enable -> box.en, box.eno -> coil Done.
function enoChain(box) {
  return fc("EnoProbe",
    access(1, "Enable") + access(2, "Done") + `<Part Name="${box}" UId="10"/><Part Name="Coil" UId="11"/>`,
    wire(ident(1), pin(10, "en")) + wire(pin(10, "eno"), pin(11, "in")) + wire(ident(2), pin(11, "operand")));
}

test("the ENO of an instruction that can fail is kept, not shown as its EN", () => {
  const xml = enoChain("Add");
  const line = render(xml).lines.find((l) => l.includes('"Done" ='));
  assert.ok(line);
  assert.notEqual(line.trim(), '"Done" = "Enable"');
  assert.match(line, /Add(?:#\d+)?\.ENO/);
  const write = analyze(xml).writeSites.find((w) => w.target === "Done");
  assert.equal(write.coverage, "conservative");
  assert.ok(JSON.stringify(write.guard).includes("Add.ENO"));
});

test("MOVE keeps its ENO = EN simplification in renderer and analyzer", () => {
  const xml = enoChain("Move");
  const line = render(xml).lines.find((l) => l.includes('"Done" ='));
  assert.equal(line.trim(), '"Done" = "Enable"');
  const write = analyze(xml).writeSites.find((w) => w.target === "Done");
  assert.equal(write.guard.kind, "symbol");
  assert.equal(write.guard.symbol, "Enable");
});

test("two data wires on one input pin are ambiguous, not merged", () => {
  // Add.in1 is fed by two variables: neither side may pick one or OR them.
  const xml = fc("DataProbe",
    access(1, "A") + access(2, "B") + access(3, "C") + access(4, "Sum") + '<Part Name="Add" UId="10"/>',
    wire(power, pin(10, "en")) + wire(ident(1), pin(10, "in1")) + wire(ident(2), pin(10, "in1")) +
      wire(ident(3), pin(10, "in2")) + wire(pin(10, "out"), ident(4)));
  const network = render(xml);
  assert.equal(network.supported, false, network.lines.join("\n"));
  assert.ok(network.lines.some((l) => l.includes("ambiguous")), network.lines.join("\n"));
  const text = JSON.stringify(analyze(xml));
  assert.ok(text.includes("multiple data drivers"), "analyzer marks the data pin ambiguous");
});

test("a Boolean branch joined with a data output on one wire is unsupported in the renderer", () => {
  // Contact.out and Add.out on one wire into a coil: not a valid power-flow join.
  const xml = fc("MixedProbe",
    access(1, "Auto") + access(2, "Run") + access(3, "X") +
      '<Part UId="10" Name="Contact"/><Part UId="11" Name="Add"/><Part UId="12" Name="Coil"/>',
    wire(power, pin(10, "in"), pin(11, "en")) + wire(ident(1), pin(10, "operand")) + wire(ident(3), pin(11, "in1")) +
      wire(pin(10, "out"), pin(11, "out"), pin(12, "in")) + wire(ident(2), pin(12, "operand")));
  const network = render(xml);
  assert.equal(network.supported, false, network.lines.join("\n"));
  const write = analyze(xml).writeSites.find((w) => w.target === "Run");
  assert.equal(write.coverage, "conservative");
});

// Word logic as exported by V20 (FB226 in a real project): And<SrcType=DWord>, DisabledENO, out -> tDw,
// eno -> Shr.en. It is an instruction writing tDw, not a Boolean AND gate driving Shr.
function wordAnd() {
  return fc("WordLogicProbe",
    access(1, "Pointer") + `<Access Scope="LiteralConstant" UId="2"><Constant><ConstantType>DWord</ConstantType><ConstantValue>16#FF000000</ConstantValue></Constant></Access>` +
      access(3, "tDw") + access(4, "Area") + `<Access Scope="LiteralConstant" UId="5"><Constant><ConstantType>Int</ConstantType><ConstantValue>24</ConstantValue></Constant></Access>` +
      '<Part Name="And" UId="10" DisabledENO="true"><TemplateValue Name="Card" Type="Cardinality">2</TemplateValue><TemplateValue Name="SrcType" Type="Type">DWord</TemplateValue></Part>' +
      '<Part Name="Shr" UId="11"><TemplateValue Name="SrcType" Type="Type">DWord</TemplateValue></Part>',
    wire(power, pin(10, "en")) + wire(ident(1), pin(10, "in1")) + wire(ident(2), pin(10, "in2")) +
      wire(pin(10, "eno"), pin(11, "en")) + wire(pin(10, "out"), ident(3)) +
      wire(ident(3), pin(11, "in")) + wire(ident(5), pin(11, "n")) + wire(pin(11, "out"), ident(4)));
}

test("a typed And (word logic) is an instruction that writes its output, not a Boolean gate", () => {
  const xml = wordAnd();
  const lines = render(xml).lines;
  const andLine = lines.find((l) => l.includes("And<SrcType=DWord>"));
  assert.ok(andLine, lines.join("\n"));
  assert.match(andLine, /out=>"tDw"/);
  assert.match(andLine, /in1:="Pointer"/);
  const shrLine = lines.find((l) => l.includes("Shr"));
  assert.doesNotMatch(shrLine, /"Pointer" AND/, "Shr is not enabled by the word AND of its inputs");
  assert.doesNotMatch(shrLine, /^\s*IF /, "DisabledENO: And.ENO is its EN (power rail), so Shr runs unconditionally");

  const writes = analyze(xml).writeSites;
  assert.ok(writes.some((w) => w.target === "tDw"), "the analyzer records the write to tDw");
  const area = writes.find((w) => w.target === "Area");
  assert.ok(area);
  assert.deepEqual(guardSymbols(area.guard), [], JSON.stringify(area.guard));
});

test("an untyped A/O/X part is still a Boolean gate", () => {
  const xml = fc("GateProbe",
    access(1, "X1") + access(2, "X2") + access(3, "Y") +
      '<Part Name="A" UId="10"><TemplateValue Name="Card" Type="Cardinality">2</TemplateValue></Part><Part Name="Coil" UId="11"/>',
    wire(ident(1), pin(10, "in1")) + wire(ident(2), pin(10, "in2")) + wire(pin(10, "out"), pin(11, "in")) + wire(ident(3), pin(11, "operand")));
  assert.match(render(xml).lines.find((l) => l.includes('"Y" =')), /"X1" AND "X2"/);
  const guard = analyze(xml).writeSites.find((w) => w.target === "Y").guard;
  assert.equal(guard.kind, "and");
});
