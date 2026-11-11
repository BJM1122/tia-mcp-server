import assert from "node:assert/strict";
import test from "node:test";

import { formatRenderedBlock, renderBlockXml } from "../dist/block-render.js";

// Synthetic Simatic ML only: no plant programs in the repository.

const global = (uid, ...names) =>
  `<Access Scope="GlobalVariable" UId="${uid}"><Symbol>${names.map((n) => `<Component Name="${n}" />`).join("")}</Symbol></Access>`;
const local = (uid, name) => `<Access Scope="LocalVariable" UId="${uid}"><Symbol><Component Name="${name}" /></Symbol></Access>`;
const literal = (uid, value, type = "Int") =>
  `<Access Scope="LiteralConstant" UId="${uid}"><Constant><ConstantType>${type}</ConstantType><ConstantValue>${value}</ConstantValue></Constant></Access>`;
let wireUid = 900;
const wire = (...ends) => `<Wire UId="${wireUid++}">${ends.join("")}</Wire>`;
const power = "<Powerrail />";
const ident = (uid) => `<IdentCon UId="${uid}" />`;
const pin = (uid, name) => `<NameCon UId="${uid}" Name="${name}" />`;
const open = (uid) => `<OpenCon UId="${uid}" />`;

function title(text, id) {
  return `<MultilingualText ID="${id}" CompositionName="Title"><ObjectList><MultilingualTextItem ID="${id}1" CompositionName="Items"><AttributeList><Culture>zh-CN</Culture><Text>${text}</Text></AttributeList></MultilingualTextItem></ObjectList></MultilingualText>`;
}

function block({ kind = "FC", name = "Logic", number = "1", language = "LAD", networks, iface = "" }) {
  const units = networks.map((n, i) => `
      <SW.Blocks.CompileUnit ID="${i + 10}" CompositionName="CompileUnits">
        <AttributeList>
          <NetworkSource>${n.source}</NetworkSource>
          <ProgrammingLanguage>${n.language ?? language}</ProgrammingLanguage>
        </AttributeList>
        <ObjectList>${n.title ? title(n.title, `T${i}`) : ""}</ObjectList>
      </SW.Blocks.CompileUnit>`).join("");
  return `<?xml version="1.0" encoding="utf-8"?>
<Document>
  <SW.Blocks.${kind} ID="0">
    <AttributeList>
      ${iface}
      <Name>${name}</Name>
      <Number>${number}</Number>
      <ProgrammingLanguage>${language}</ProgrammingLanguage>
    </AttributeList>
    <ObjectList>${units}
    </ObjectList>
  </SW.Blocks.${kind}>
</Document>`;
}

const flg = (parts, wires) =>
  `<FlgNet xmlns="http://www.siemens.com/automation/Openness/SW/NetworkSource/FlgNet/v5"><Parts>${parts}</Parts><Wires>${wires}</Wires></FlgNet>`;

test("LAD contacts, a parallel branch, a negated contact and a coil read as one assignment", () => {
  const source = flg(
    global(21, "Start") + global(22, "Auto") + global(23, "Fault") + global(24, "Motor") +
      '<Part Name="Contact" UId="30" /><Part Name="Contact" UId="31" /><Part Name="O" UId="32"><TemplateValue Name="Card" Type="Cardinality">2</TemplateValue></Part>' +
      '<Part Name="Contact" UId="33"><Negated Name="operand" /></Part><Part Name="Coil" UId="34" />',
    wire(power, pin(30, "in"), pin(31, "in")) + wire(ident(21), pin(30, "operand")) + wire(ident(22), pin(31, "operand")) +
      wire(pin(30, "out"), pin(32, "in1")) + wire(pin(31, "out"), pin(32, "in2")) + wire(pin(32, "out"), pin(33, "in")) +
      wire(ident(23), pin(33, "operand")) + wire(pin(33, "out"), pin(34, "in")) + wire(ident(24), pin(34, "operand"))
  );
  const text = formatRenderedBlock(renderBlockXml(block({ networks: [{ source, title: "电机" }] })));
  assert.match(text, /^FC1 "Logic" LAD/);
  assert.match(text, /\nNW1 电机\n {2}"Motor" = \("Start" OR "Auto"\) AND NOT "Fault"$/);
});

test("set/reset coils and a comparator powered through its pre pin keep the full condition", () => {
  const source = flg(
    global(21, "DB1", "Mode") + literal(22, 10) + global(23, "Ready") + global(24, "Hold") +
      '<Part Name="Contact" UId="30" /><Part Name="Eq" UId="31"><TemplateValue Name="SrcType" Type="Type">Int</TemplateValue></Part><Part Name="SCoil" UId="32" /><Part Name="RCoil" UId="33" />',
    wire(power, pin(30, "in")) + wire(ident(23), pin(30, "operand")) + wire(pin(30, "out"), pin(31, "pre")) +
      wire(ident(21), pin(31, "in1")) + wire(ident(22), pin(31, "in2")) + wire(pin(31, "out"), pin(32, "in")) + wire(ident(24), pin(32, "operand")) +
      wire(power, pin(33, "in")) + wire(ident(23), pin(33, "operand"))
  );
  const text = formatRenderedBlock(renderBlockXml(block({ networks: [{ source }] })));
  assert.match(text, /S "Hold" IF "Ready" AND "DB1"\.Mode == 10/);
  assert.match(text, /R "Ready" IF TRUE/);
});

test("every instruction box appears, with its instance, connected inputs and written outputs", () => {
  const get = flg(
    global(21, "Clock_10Hz") + literal(22, "W#16#101", "Word") + literal(23, "P#DB4.DBX94.0 BYTE 4", "Remote") + literal(24, "P#DB409.DBX110.0 BYTE 4", "Any") +
      '<Part Name="GET" Version="1.3" UId="25"><Instance Scope="GlobalVariable" UId="26"><Component Name="GET_DB" /></Instance><TemplateValue Name="remote_type" Type="Type">Remote</TemplateValue></Part>',
    wire(power, pin(25, "en")) + wire(ident(21), pin(25, "REQ")) + wire(ident(22), pin(25, "ID")) + wire(ident(23), pin(25, "ADDR_2")) +
      wire(open(40), pin(25, "ADDR_3")) + wire(ident(24), pin(25, "RD_2")) + wire(pin(25, "NDR"), open(41))
  );
  const move = flg(
    global(21, "AlwaysTRUE") + global(22, "Link", "In", "Count") + global(23, "Collect", "Count") +
      '<Part Name="Contact" UId="24" /><Part Name="Move" UId="25" DisabledENO="true"><TemplateValue Name="Card" Type="Cardinality">1</TemplateValue></Part>',
    wire(power, pin(24, "in")) + wire(ident(21), pin(24, "operand")) + wire(pin(24, "out"), pin(25, "en")) +
      wire(ident(22), pin(25, "in")) + wire(pin(25, "out1"), ident(23))
  );
  const call = flg(
    global(21, "Ready") + local(22, "speed") +
      '<Call UId="23"><CallInfo Name="FB10_Drive" BlockType="FB"><Instance Scope="GlobalVariable" UId="24"><Component Name="Drive_DB" /></Instance><Parameter Name="iRun" Section="Input" Type="Bool" /><Parameter Name="oSpeed" Section="Output" Type="Real" /></CallInfo></Call>',
    wire(power, pin(23, "en")) + wire(ident(21), pin(23, "iRun")) + wire(pin(23, "oSpeed"), ident(22))
  );
  const text = formatRenderedBlock(renderBlockXml(block({ networks: [{ source: get }, { source: move }, { source: call }] })));
  assert.match(text, /GET\["GET_DB"\]<remote_type=Remote>\(REQ:="Clock_10Hz", ID:=W#16#101, ADDR_2:=P#DB4\.DBX94\.0 BYTE 4, RD_2:=P#DB409\.DBX110\.0 BYTE 4\)$/m);
  assert.match(text, /IF "AlwaysTRUE": Move\(in:="Link"\.In\.Count\) => out1=>"Collect"\.Count/);
  assert.match(text, /FB10_Drive\["Drive_DB"\]\(iRun:="Ready"\) => oSpeed=>#speed/);
  assert.doesNotMatch(text, /Card|ADDR_3|NDR/);
});

test("a box whose output feeds another part is labelled so the reader can follow it", () => {
  const source = flg(
    local(21, "a") + literal(22, 30, "Real") + global(23, "Limit") + global(24, "Alarm") +
      '<Part Name="Add" UId="25"><TemplateValue Name="SrcType" Type="Type">Real</TemplateValue></Part><Part Name="Gt" UId="26" /><Part Name="Coil" UId="27" />',
    wire(power, pin(25, "en")) + wire(ident(21), pin(25, "in1")) + wire(ident(22), pin(25, "in2")) +
      wire(pin(25, "out"), pin(26, "in1")) + wire(ident(23), pin(26, "in2")) + wire(power, pin(26, "pre")) +
      wire(pin(26, "out"), pin(27, "in")) + wire(ident(24), pin(27, "operand"))
  );
  const text = formatRenderedBlock(renderBlockXml(block({ networks: [{ source }] })));
  assert.match(text, /Add#25<SrcType=Real>\(in1:=#a, in2:=30\)/);
  assert.match(text, /"Alarm" = Add#25\.out > "Limit"/);
});

test("SCL is rebuilt from tokens, including multi-instance calls and absolute DB addresses", () => {
  const scl = `<StructuredText xmlns="http://www.siemens.com/automation/Openness/SW/NetworkSource/StructuredText/v4">
    <Access Scope="LocalVariable" UId="21"><Symbol><Component Name="trig"><Token Text="[" /><Access Scope="LiteralConstant"><Constant><ConstantValue>1</ConstantValue></Constant></Access><Token Text="]" /></Component></Symbol></Access>
    <Access Scope="Call" UId="22"><Instruction><Token Text="(" /><Parameter Name="CLK"><Token Text=":=" /><Access Scope="GlobalVariable"><Symbol><Component Name="Running" /></Symbol></Access></Parameter><Token Text=")" /></Instruction></Access>
    <Token Text=";" /><NewLine Num="1" />
    <Access Scope="GlobalVariable"><Symbol><Component Name="GLB" /><Token Text="." /><Component Name="Alarm" /></Symbol></Access>
    <Blank Num="1" /><Token Text=":=" /><Blank Num="1" />
    <Access Scope="Address"><Symbol><Address Area="DB" Type="Alarm" BlockNumber="1003" /><Token Text="." /><Address Area="DB" Type="DWord" BitOffset="32" /></Symbol></Access>
    <Blank Num="1" /><Token Text="&lt;&gt;" /><Blank Num="1" /><Access Scope="LiteralConstant"><Constant><ConstantValue>0</ConstantValue></Constant></Access>
    <Token Text=";" /><Blank Num="1" /><LineComment><Text>报警汇总</Text></LineComment>
  </StructuredText>`;
  const text = formatRenderedBlock(renderBlockXml(block({ language: "SCL", networks: [{ source: scl }] })));
  assert.match(text, /\n {2}#trig\[1\]\(CLK:="Running"\);\n {2}"GLB"\.Alarm := %DB1003\.DBD4 <> 0; \/\/报警汇总$/);
});

test("interface: sections, start values and comments; members of named types are not repeated", () => {
  const iface = `<Interface><Sections xmlns="http://www.siemens.com/automation/Openness/SW/Interface/v5">
    <Section Name="Input"><Member Name="iRun" Datatype="Bool"><Comment><MultiLanguageText Lang="zh-CN">运行</MultiLanguageText></Comment></Member></Section>
    <Section Name="Static">
      <Member Name="recv" Datatype="Struct"><Member Name="count" Datatype="UDInt"><StartValue>0</StartValue></Member></Member>
      <Member Name="alm" Datatype="Array[1..10] of &quot;AlarmFB&quot;"><Sections><Section Name="Input"><Member Name="iTrig0" Datatype="Bool" /></Section></Sections></Member>
    </Section>
    <Section Name="Return"><Member Name="Ret_Val" Datatype="Void" /></Section>
  </Sections></Interface>`;
  const text = formatRenderedBlock(renderBlockXml(block({ kind: "FB", networks: [], iface })));
  assert.match(text, /INTERFACE\n {2}Input\n {4}iRun : Bool {2}\/\/ 运行\n {2}Static\n {4}recv : Struct\n {6}count : UDInt := 0\n {4}alm : Array\[1\.\.10\] of "AlarmFB"$/);
  assert.doesNotMatch(text, /iTrig0|Return|Void/);
});

test("GRAPH and unknown sources are reported with their XML line instead of half-rendered", () => {
  const graph = '<Graph xmlns="http://www.siemens.com/automation/Openness/SW/NetworkSource/Graph/v5"><Sequence /></Graph>';
  const rendered = renderBlockXml(block({ language: "GRAPH", networks: [{ source: graph }] }));
  assert.equal(rendered.networks[0].supported, false);
  assert.ok(rendered.networks[0].xmlLine > 1);
  assert.match(formatRenderedBlock(rendered), /‹GRAPH not rendered — see XML line \d+›/);
});

test("network selection and options", () => {
  const n = (op) => ({ source: flg(global(21, op) + '<Part Name="Coil" UId="22" />', wire(power, pin(22, "in")) + wire(ident(21), pin(22, "operand"))) });
  const xml = block({ networks: [n("A"), n("B"), n("C")] });
  const text = formatRenderedBlock(renderBlockXml(xml), { networks: [2] });
  assert.match(text, /NW2\n {2}"B" = TRUE/);
  assert.doesNotMatch(text, /NW1|NW3/);
});

test("tag tables list name, type, address and comment", () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?><Document><SW.Tags.PlcTagTable ID="0"><AttributeList><Name>IO</Name></AttributeList><ObjectList>
    <SW.Tags.PlcTag ID="1" CompositionName="Tags"><AttributeList><DataTypeName>Bool</DataTypeName><LogicalAddress>%I0.0</LogicalAddress><Name>急停</Name></AttributeList>
      <ObjectList><MultilingualText ID="2" CompositionName="Comment"><ObjectList><MultilingualTextItem ID="3" CompositionName="Items"><AttributeList><Culture>zh-CN</Culture><Text>常闭</Text></AttributeList></MultilingualTextItem></ObjectList></MultilingualText></ObjectList></SW.Tags.PlcTag>
  </ObjectList></SW.Tags.PlcTagTable></Document>`;
  assert.match(formatRenderedBlock(renderBlockXml(xml)), /TAGS\n {2}急停 : Bool @ %I0\.0 {2}\/\/ 常闭/);
});

test("non-Simatic XML is rejected", () => {
  assert.throws(() => renderBlockXml("<root/>"), /not a Simatic ML document/);
});
