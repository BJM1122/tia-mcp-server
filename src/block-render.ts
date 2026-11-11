import { XMLParser } from "fast-xml-parser";

// Compact, read-only text view of one exported Simatic ML object (block, DB, UDT or tag table).
// LAD/FBD networks are rendered structurally from parts and wires, so every instruction box appears
// whether or not the semantic analyzer understands it. SCL is rebuilt from its tokens. Anything else
// is named with its XML line so the caller can open the original.

type ONode = { name: string; attrs: Record<string, string>; children: ONode[]; text: string };

export type RenderedNetwork = {
  network: number;
  language: string;
  title: string;
  comment: string;
  lines: string[];
  supported: boolean;
  xmlLine: number;
};

export type RenderedBlock = {
  objectType: string;
  name: string;
  number: string;
  language: string;
  title: string;
  comment: string;
  interfaceLines: string[];
  tagLines: string[];
  networks: RenderedNetwork[];
};

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true
});

function toNodes(raw: unknown[]): ONode[] {
  const nodes: ONode[] = [];
  for (const entry of raw ?? []) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const attrs = (record[":@"] ?? {}) as Record<string, string>;
    for (const key of Object.keys(record)) {
      if (key === ":@") continue;
      if (key === "#text") { nodes.push({ name: "#text", attrs: {}, children: [], text: String(record[key]) }); continue; }
      const children = toNodes(record[key] as unknown[]);
      const text = children.filter((c) => c.name === "#text").map((c) => c.text).join("");
      nodes.push({ name: key, attrs, children: children.filter((c) => c.name !== "#text" || c.text.trim() !== ""), text });
    }
  }
  return nodes;
}

const kids = (node: ONode | undefined, name?: string) =>
  (node?.children ?? []).filter((c) => c.name !== "#text" && (name === undefined || c.name === name));
const kid = (node: ONode | undefined, name: string) => kids(node, name)[0];
const textOf = (node: ONode | undefined) => (node?.text ?? "").trim();

function multilingual(objectList: ONode | undefined, composition: string): string {
  for (const mt of kids(objectList, "MultilingualText")) {
    if (mt.attrs.CompositionName !== composition) continue;
    const texts = kids(kid(mt, "ObjectList"), "MultilingualTextItem")
      .map((item) => ({ culture: textOf(kid(kid(item, "AttributeList"), "Culture")), text: textOf(kid(kid(item, "AttributeList"), "Text")) }))
      .filter((item) => item.text);
    const preferred = texts.find((item) => /^zh/i.test(item.culture)) ?? texts[0];
    if (preferred) return oneLine(preferred.text);
  }
  return "";
}

function memberComment(member: ONode): string {
  const texts = kids(kid(member, "Comment"), "MultiLanguageText").map((t) => ({ lang: t.attrs.Lang ?? "", text: textOf(t) })).filter((t) => t.text);
  const preferred = texts.find((t) => /^zh/i.test(t.lang)) ?? texts[0];
  return preferred ? oneLine(preferred.text) : "";
}

const oneLine = (text: string) => text.replace(/\s*[\r\n]+\s*/g, " ").trim();

// ---- operands ----

function componentText(component: ONode, scope: string): string {
  let text = component.attrs.Name ?? "?";
  const indices = kids(component, "Access").map((a) => operand(a, scope));
  if (indices.length) text += `[${indices.join(", ")}]`;
  if (component.attrs.SliceAccessModifier) text += `.%${component.attrs.SliceAccessModifier.toUpperCase()}`;
  return text;
}

const AREA: Record<string, string> = { Input: "I", Output: "Q", Memory: "M", PeripheryInput: "I:P", PeripheryOutput: "Q:P", Timer: "T", Counter: "C" };
const WIDTH: Record<string, string> = { Bool: "X", Byte: "B", Char: "B", SInt: "B", USInt: "B", Word: "W", Int: "W", UInt: "W", DWord: "D", DInt: "D", UDInt: "D", Real: "D", Time: "D" };

function addressText(address: ONode): string {
  const area = address.attrs.Area ?? "";
  const type = address.attrs.Type ?? "";
  const bit = Number(address.attrs.BitOffset ?? "0");
  const byte = Math.floor(bit / 8);
  const width = WIDTH[type] ?? "";
  if (area === "DB" || area === "DI") {
    // A DB reference alone (<Address Area="DB" BlockNumber="1003"/> before ".DBD0" in SCL) has no offset.
    if (address.attrs.BitOffset === undefined && address.attrs.BlockNumber) return `%DB${address.attrs.BlockNumber}`;
    const prefix = address.attrs.BlockNumber ? `%DB${address.attrs.BlockNumber}.` : "";
    return width === "X" || !width ? `${prefix}DBX${byte}.${bit % 8}` : `${prefix}DB${width}${byte}`;
  }
  const letter = AREA[area] ?? area;
  if (letter === "T" || letter === "C") return `%${letter}${address.attrs.BlockNumber ?? byte}`;
  return width === "X" || !width ? `%${letter}${byte}.${bit % 8}` : `%${letter}${width}${byte}`;
}

export function operand(access: ONode, outerScope = ""): string {
  const scope = access.attrs.Scope ?? outerScope;
  const symbol = kid(access, "Symbol");
  if (symbol) {
    const addresses = kids(symbol, "Address");
    if (addresses.length && !kid(symbol, "Component")) return addresses.map(addressText).join(".").replace(/\.%/g, ".");
    const parts = kids(symbol, "Component").map((c) => componentText(c, scope));
    if (scope === "LocalVariable" || scope === "LocalConstant") return `#${parts.join(".")}`;
    if (!parts.length) return "?";
    return [`"${parts[0]}"`, ...parts.slice(1)].join(".");
  }
  const constant = kid(access, "Constant");
  if (constant) {
    if (constant.attrs.Name) return scope === "LocalConstant" ? `#${constant.attrs.Name}` : `"${constant.attrs.Name}"`;
    return textOf(kid(constant, "ConstantValue")) || "?";
  }
  const address = kid(access, "Address");
  if (address) return addressText(address);
  const label = kid(access, "Label");
  if (label) return label.attrs.Name ?? "?";
  return `?${scope}`;
}

// An instruction or FB instance: <Instance Scope="GlobalVariable"><Component Name="GET_DB"/></Instance>,
// sometimes wrapped in a Symbol.
function instanceName(instance: ONode): string {
  if (kid(instance, "Symbol")) return operand(instance, instance.attrs.Scope);
  const parts = kids(instance, "Component").map((c) => componentText(c, instance.attrs.Scope ?? ""));
  if (!parts.length) return "?";
  return instance.attrs.Scope === "LocalVariable" ? `#${parts.join(".")}` : [`"${parts[0]}"`, ...parts.slice(1)].join(".");
}

// ---- LAD / FBD ----

const CONTACT = new Set(["Contact"]);
const EDGE_CONTACT: Record<string, string> = { PContact: "P", NContact: "N" };
const EDGE_BOX: Record<string, string> = { PBox: "P", NBox: "N" };
const LOGIC: Record<string, string> = { O: "OR", Or: "OR", A: "AND", And: "AND", X: "XOR", Xor: "XOR" };
const COMPARE: Record<string, string> = { Eq: "==", Ne: "<>", Gt: ">", Ge: ">=", Lt: "<", Le: "<=" };
const COIL: Record<string, string> = { Coil: "", SCoil: "S ", RCoil: "R ", ResetIECTimerCoil: "RT ", SetIECTimerCoil: "ST " };
// GRAPH-only coils are listed so that a GRAPH network is reported rather than silently half-rendered.
const GRAPH_COIL = new Set(["TrCoil", "SvCoil", "IlCoil"]);

// A wire end. SimaticML lists a wire's source first and its sinks after it.
type End = { kind: "power" | "ident" | "open" | "pin"; uid: string; pin: string };

function wireEnd(node: ONode): End | null {
  if (node.name === "Powerrail") return { kind: "power", uid: "", pin: "" };
  if (node.name === "IdentCon") return { kind: "ident", uid: node.attrs.UId, pin: "" };
  if (node.name === "OpenCon") return { kind: "open", uid: node.attrs.UId, pin: "" };
  if (node.name === "NameCon") return { kind: "pin", uid: node.attrs.UId, pin: node.attrs.Name };
  return null;
}

const partName = (box: ONode) => box.attrs.Name ?? kid(box, "CallInfo")?.attrs.Name ?? "?";
// And/Or/Xor with a SrcType template are word-logic instructions (tDw := a AND 16#FF000000) with EN/ENO and
// data outputs, not the Boolean gates A/O/X.
const isWordLogic = (box: ONode) => partName(box) in LOGIC && kids(box, "TemplateValue").some((t) => t.attrs.Name === "SrcType");
const logicOp = (box: ONode): string | undefined => (isWordLogic(box) ? undefined : LOGIC[partName(box)]);
// Boxes whose ENO is their EN: MOVE cannot fail, and DisabledENO="true" means ENO is not evaluated.
const enoIsEn = (box: ONode) => partName(box) === "Move" || box.attrs.DisabledENO === "true";
const NO_BOX = { name: "Part", attrs: {}, children: [], text: "" } as unknown as ONode;

function renderFlgNet(flg: ONode): { lines: string[]; supported: boolean } {
  const parts = kid(flg, "Parts");
  const operands = new Map<string, string>();
  const boxes = new Map<string, ONode>();
  for (const node of kids(parts)) {
    if (node.name === "Access") operands.set(node.attrs.UId, operand(node));
    else if (node.name === "Part" || node.name === "Call") boxes.set(node.attrs.UId, node);
  }
  const inputs = new Map<string, End[]>();           // `${uid}:${pin}` -> what drives it (several = a join)
  const inputPins = new Map<string, string[]>();     // uid -> input pin names in wire order
  const outputs = new Map<string, string[]>();       // `${uid}:${pin}` -> operands written
  const consumed = new Set<string>();                // uids whose output another part reads
  const outputPins = new Map<string, string[]>();    // uid -> output pin names in wire order
  const push = (map: Map<string, string[]>, key: string, value: string) => {
    const list = map.get(key) ?? [];
    if (!list.includes(value)) list.push(value);
    map.set(key, list);
  };
  // Whether a driver carries power flow, so that several of them on one input are a parallel join (OR).
  const powerFlowOut = (box: ONode) => {
    const name = partName(box);
    return CONTACT.has(name) || name in EDGE_CONTACT || name in EDGE_BOX || logicOp(box) !== undefined ||
      name in COMPARE || name === "Not" || name === "InRange" || name === "OutRange" || COIL[name] !== undefined;
  };
  const isPowerDriver = (end: End) => end.kind === "power" ||
    (end.kind === "pin" && (end.pin === "eno" || (end.pin === "out" && powerFlowOut(boxes.get(end.uid) ?? NO_BOX))));
  let ambiguous = false;
  for (const wire of kids(kid(flg, "Wires"), "Wire")) {
    const ends = kids(wire).map(wireEnd).filter((e): e is End => e !== null);
    if (!ends.length) continue;
    // The first end drives the wire. A later "out"/"eno" end is a second driver (a parallel join written
    // on one wire); no input pin has those names.
    const drivers = [ends[0], ...ends.slice(1).filter((e) => e.kind === "pin" && (e.pin === "out" || e.pin === "eno"))];
    const sinks = ends.slice(1).filter((e) => !drivers.includes(e));
    for (const driver of drivers) if (driver.kind === "pin") push(outputPins, driver.uid, driver.pin);
    for (const sink of sinks) {
      if (sink.kind === "ident") {
        for (const driver of drivers) {
          if (driver.kind === "pin") push(outputs, `${driver.uid}:${driver.pin}`, operands.get(sink.uid) ?? "?");
        }
        if (drivers.length > 1) ambiguous = true;   // two outputs writing one variable
      }
      if (sink.kind !== "pin") continue;
      const key = `${sink.uid}:${sink.pin}`;
      inputs.set(key, [...(inputs.get(key) ?? []), ...drivers]);
      push(inputPins, sink.uid, sink.pin);
      for (const driver of drivers) {
        if (driver.kind !== "pin") continue;
        // A box's ENO read by another part is shown as Name#uid.ENO (except MOVE, whose ENO is its EN).
        if (driver.pin !== "eno" || !enoIsEn(boxes.get(driver.uid) ?? NO_BOX)) consumed.add(driver.uid);
      }
    }
  }

  let supported = !ambiguous;
  const memo = new Map<string, string>();
  const visiting = new Set<string>();
  const negated = (box: ONode, pin: string) => kids(box, "Negated").some((n) => n.attrs.Name === pin);
  const andPower = (power: string | null, term: string) => (!power || power === "TRUE" ? term : `${power} AND ${term}`);
  // An uninstanced box is named "Add#25" only when another part reads its output, so the reader can follow it.
  const label = (uid: string): string => {
    const box = boxes.get(uid);
    if (!box) return "?";
    const instance = kid(box, "Instance") ?? kid(kid(box, "CallInfo"), "Instance");
    if (instance) return `${partName(box)}[${instanceName(instance)}]`;
    return consumed.has(uid) ? `${partName(box)}#${uid}` : partName(box);
  };

  const driverExpr = (source: End): string => {
    if (source.kind === "power") return "TRUE";
    if (source.kind === "ident") return operands.get(source.uid) ?? "?";
    return outputExpr(source.uid, source.pin);
  };
  const inputExpr = (uid: string, pin: string): string | null => {
    const sources = (inputs.get(`${uid}:${pin}`) ?? []).filter((s) => s.kind !== "open");
    if (!sources.length) return null;
    if (sources.length === 1) return driverExpr(sources[0]);
    // Several drivers: a parallel join of power-flow branches is their OR; anything else (two variables,
    // a data output) has no defined meaning and is reported instead of picking one.
    if (sources.every(isPowerDriver)) return `(${sources.map((s) => wrap(driverExpr(s))).join(" OR ")})`;
    supported = false;
    return `‹ambiguous: ${sources.map(driverExpr).join(" | ")}›`;
  };

  const outputExpr = (uid: string, pin: string): string => {
    const key = `${uid}:${pin}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    if (visiting.has(key)) return "‹loop›";
    visiting.add(key);
    const box = boxes.get(uid);
    let result: string;
    if (!box) result = "?";
    else {
      const name = partName(box);
      // LAD comparators take power flow on "pre"; contacts and coils on "in".
      const power = inputExpr(uid, "in") ?? inputExpr(uid, "pre");
      if (CONTACT.has(name)) {
        const op = inputExpr(uid, "operand") ?? "?";
        result = andPower(power, negated(box, "operand") ? `NOT ${op}` : op);
      } else if (EDGE_CONTACT[name]) {
        result = andPower(power, `${EDGE_CONTACT[name]}(${inputExpr(uid, "operand") ?? "?"})`);
      } else if (EDGE_BOX[name]) {
        result = `${EDGE_BOX[name]}(${inputExpr(uid, "in") ?? "?"})`;
      } else if (logicOp(box)) {
        const terms = (inputPins.get(uid) ?? []).filter((p) => /^in\d+$/.test(p))
          .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)))
          .map((p) => {
            const term = wrap(inputExpr(uid, p) ?? "?");
            return negated(box, p) ? `NOT ${term}` : term;
          });
        result = terms.length === 1 ? terms[0] : `(${terms.join(` ${logicOp(box)} `)})`;
      } else if (name === "Not") {
        result = `NOT ${wrap(power ?? "?")}`;
      } else if (COMPARE[name]) {
        result = andPower(power, `${inputExpr(uid, "in1") ?? "?"} ${COMPARE[name]} ${inputExpr(uid, "in2") ?? "?"}`);
      } else if (name === "InRange" || name === "OutRange") {
        const pick = (...pins: string[]) => pins.map((p) => inputExpr(uid, p)).find((v) => v !== null) ?? "?";
        result = andPower(power, `${name}(${pick("min", "MIN")}, ${pick("operand", "VAL", "in")}, ${pick("max", "MAX")})`);
      } else if (COIL[name] !== undefined || GRAPH_COIL.has(name)) {
        result = power ?? "?";
      } else if (pin === "eno") {
        // Only MOVE cannot fail, so its ENO is its EN; any other box (Add overflow, DIV by zero, an FB
        // clearing ENO) can be FALSE while EN is TRUE.
        result = enoIsEn(box) ? inputExpr(uid, "en") ?? "TRUE" : `${label(uid)}.ENO`;
      } else {
        result = `${label(uid)}.${pin}`;
      }
    }
    // FBD can negate a box output (<Negated Name="out"/>).
    if (box && negated(box, pin)) result = `NOT ${wrap(result)}`;
    visiting.delete(key);
    memo.set(key, result);
    return result;
  };

  const isLogic = (box: ONode) => {
    const name = partName(box);
    return CONTACT.has(name) || name in EDGE_CONTACT || name in EDGE_BOX || logicOp(box) !== undefined
      || name in COMPARE || name === "Not" || name === "InRange" || name === "OutRange";
  };

  const lines: string[] = [];
  for (const [uid, box] of boxes) {
    const name = partName(box);
    if (GRAPH_COIL.has(name)) { supported = false; continue; }
    if (isLogic(box)) {
      // Shown inside the condition of whatever it drives; listed only when nothing reads it.
      if (!consumed.has(uid)) lines.push(`  (unconnected ${name}${inputExpr(uid, "operand") ? ` ${inputExpr(uid, "operand")}` : ""})`);
      continue;
    }
    if (COIL[name] !== undefined) {
      const target = inputExpr(uid, "operand") ?? "?";
      const condition = inputExpr(uid, "in") ?? "?";
      const shown = negated(box, "operand") ? `NOT ${wrap(condition)}` : condition;
      lines.push(COIL[name] ? `  ${COIL[name]}${target} IF ${shown}` : `  ${target} = ${shown}`);
      continue;
    }
    // Any other instruction or block call: its enable condition, connected inputs and written outputs.
    const enable = inputExpr(uid, "en");
    const args = (inputPins.get(uid) ?? []).filter((p) => p !== "en").flatMap((p) => {
      const value = inputExpr(uid, p);
      return value === null ? [] : [`${p}:=${negated(box, p) ? `NOT ${wrap(value)}` : value}`];
    });
    const writes = (outputPins.get(uid) ?? []).filter((p) => p !== "eno")
      .flatMap((p) => (outputs.get(`${uid}:${p}`) ?? []).map((target) => `${p}=>${target}`));
    const templates = kids(box, "TemplateValue").filter((t) => t.attrs.Type === "Type").map((t) => `${t.attrs.Name}=${textOf(t)}`);
    const call = `${label(uid)}${templates.length ? `<${templates.join(",")}>` : ""}(${args.join(", ")})${writes.length ? ` => ${writes.join(", ")}` : ""}`;
    lines.push(enable && enable !== "TRUE" ? `  IF ${enable}: ${call}` : `  ${call}`);
  }
  return { lines, supported };
}

function wrap(expr: string): string {
  return /\s(AND|OR|XOR)\s/.test(expr) && !/^\(.*\)$/.test(expr) ? `(${expr})` : expr;
}

// ---- SCL ----

function renderScl(node: ONode): string {
  let out = "";
  for (const child of node.children) {
    switch (child.name) {
      case "#text": break;
      case "Token": out += child.attrs.Text ?? ""; break;
      case "Blank": out += " ".repeat(Number(child.attrs.Num ?? "1")); break;
      case "NewLine": out += "\n".repeat(Number(child.attrs.Num ?? "1")); break;
      case "LineComment": out += `//${kids(child, "Text").map(textOf).join("")}`; break;
      case "Comment": out += `(*${kids(child, "Text").map(textOf).join("")}*)`; break;
      case "Text": out += child.text; break;
      case "Access": {
        if (child.attrs.Scope === "Call") out += renderScl(child);
        else out += operand(child);
        break;
      }
      case "Instruction": case "CallInfo": {
        const instance = kid(child, "Instance");
        // A multi-instance call has neither: its instance precedes the Call access as an ordinary operand.
        out += instance ? instanceName(instance) : child.attrs.Name ?? "";
        out += renderScl({ ...child, children: child.children.filter((c) => c.name !== "Instance" && c.name !== "TemplateValue") });
        break;
      }
      case "Parameter": out += `${child.attrs.Name ?? ""}${renderScl(child)}`; break;
      case "TemplateValue": case "Instance": break;
      default: out += renderScl(child);
    }
  }
  return out;
}

// ---- interface and tags ----

function renderMembers(members: ONode[], depth: number, lines: string[]) {
  for (const member of members) {
    const start = textOf(kid(member, "StartValue"));
    const comment = memberComment(member);
    lines.push(`${"  ".repeat(depth)}${member.attrs.Name} : ${member.attrs.Datatype ?? "?"}${start ? ` := ${start}` : ""}${comment ? `  // ${comment}` : ""}`);
    // Members of a named type ("UDT", "FB" multi-instance, Array of "UDT") are that type's interface, repeated
    // in every export; read the type itself instead. Anonymous Structs are expanded.
    if (/"/.test(member.attrs.Datatype ?? "")) continue;
    renderMembers(kids(member, "Member"), depth + 1, lines);
    for (const section of kids(kid(member, "Sections"), "Section")) renderMembers(kids(section, "Member"), depth + 1, lines);
  }
}

function renderInterface(attributeList: ONode | undefined): string[] {
  const lines: string[] = [];
  for (const section of kids(kid(kid(attributeList, "Interface"), "Sections"), "Section")) {
    const members = kids(section, "Member");
    if (!members.length) continue;
    if (section.attrs.Name === "Return" && members.length === 1 && members[0].attrs.Datatype === "Void") continue;
    lines.push(`${section.attrs.Name}`);
    renderMembers(members, 1, lines);
  }
  return lines;
}

function renderTags(object: ONode): string[] {
  const lines: string[] = [];
  for (const tag of kids(kid(object, "ObjectList"), "SW.Tags.PlcTag")) {
    const a = kid(tag, "AttributeList");
    const comment = multilingual(kid(tag, "ObjectList"), "Comment");
    lines.push(`${textOf(kid(a, "Name"))} : ${textOf(kid(a, "DataTypeName"))} @ ${textOf(kid(a, "LogicalAddress"))}${comment ? `  // ${comment}` : ""}`);
  }
  for (const constant of kids(kid(object, "ObjectList"), "SW.Tags.PlcUserConstant")) {
    const a = kid(constant, "AttributeList");
    lines.push(`CONST ${textOf(kid(a, "Name"))} : ${textOf(kid(a, "DataTypeName"))} = ${textOf(kid(a, "Value"))}`);
  }
  return lines;
}

// ---- entry points ----

function lineOffsets(xml: string): number[] {
  const offsets: number[] = [];
  const re = /<SW\.Blocks\.CompileUnit\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) offsets.push(xml.slice(0, match.index).split("\n").length);
  return offsets;
}

export function renderBlockXml(xml: string): RenderedBlock {
  const text = xml.replace(/^﻿/, "");
  const roots = toNodes(parser.parse(text) as unknown[]);
  const document = roots.find((n) => n.name === "Document");
  const object = kids(document).find((n) => /^SW\./.test(n.name));
  if (!object) throw new Error("XML is not a Simatic ML document with an SW.* object");
  const attributeList = kid(object, "AttributeList");
  const objectList = kid(object, "ObjectList");
  const units = kids(objectList, "SW.Blocks.CompileUnit");
  const offsets = lineOffsets(text);
  const networks: RenderedNetwork[] = units.map((unit, index) => {
    const unitAttributes = kid(unit, "AttributeList");
    const language = textOf(kid(unitAttributes, "ProgrammingLanguage"));
    const source = kid(unitAttributes, "NetworkSource");
    const body = kids(source)[0];
    let lines: string[] = [];
    let supported = true;
    if (!body) lines = [];
    else if (body.name === "FlgNet") ({ lines, supported } = renderFlgNet(body));
    else if (body.name === "StructuredText") lines = renderScl(body).replace(/\s+$/, "").split("\n").map((l) => `  ${l}`.trimEnd());
    else supported = false;
    return {
      network: index + 1,
      language,
      title: multilingual(kid(unit, "ObjectList"), "Title"),
      comment: multilingual(kid(unit, "ObjectList"), "Comment"),
      lines,
      supported,
      xmlLine: offsets[index] ?? 0
    };
  });
  return {
    objectType: object.name.replace(/^SW\.(Blocks|Types|Tags)\./, ""),
    name: textOf(kid(attributeList, "Name")),
    number: textOf(kid(attributeList, "Number")),
    language: textOf(kid(attributeList, "ProgrammingLanguage")),
    title: multilingual(objectList, "Title"),
    comment: multilingual(objectList, "Comment"),
    interfaceLines: renderInterface(attributeList),
    tagLines: object.name === "SW.Tags.PlcTagTable" ? renderTags(object) : [],
    networks
  };
}

export type RenderOptions = { networks?: number[]; includeInterface?: boolean; includeComments?: boolean };

export function formatRenderedBlock(block: RenderedBlock, options: RenderOptions = {}): string {
  const out: string[] = [];
  const id = block.number ? `${block.objectType}${block.number}` : block.objectType;
  out.push(`${id} "${block.name}"${block.language ? ` ${block.language}` : ""}${block.title ? ` — ${block.title}` : ""}`);
  if (options.includeComments !== false && block.comment) out.push(`// ${block.comment}`);
  if (options.includeInterface !== false && block.interfaceLines.length) out.push("", "INTERFACE", ...block.interfaceLines.map((l) => `  ${l}`));
  if (block.tagLines.length) out.push("", "TAGS", ...block.tagLines.map((l) => `  ${l}`));
  const wanted = options.networks?.length ? new Set(options.networks) : null;
  for (const network of block.networks) {
    if (wanted && !wanted.has(network.network)) continue;
    out.push("", `NW${network.network}${network.title ? ` ${network.title}` : ""}${network.language && network.language !== block.language ? ` [${network.language}]` : ""}`);
    if (options.includeComments !== false && network.comment) out.push(`  // ${network.comment}`);
    if (!network.supported) out.push(`  ‹${network.language || "this network"} not rendered — see XML line ${network.xmlLine}›`);
    out.push(...network.lines);
    if (network.supported && !network.lines.length) out.push("  (empty)");
  }
  return out.join("\n");
}
