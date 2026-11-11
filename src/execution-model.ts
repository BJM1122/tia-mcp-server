import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";

export const EXECUTION_ANALYZER_VERSION = "0.5.1";
export const EXECUTION_INDEX_FILENAME = "tia-execution-model.json";

export type CoverageLevel = "exact" | "conservative" | "unsupported";
export type SemanticConfidence = "high" | "medium" | "low";
export type SymbolMatchMode = "exact" | "suffix" | "contains";

export type ExecutionBlockSource = {
  xml?: string;
  sha256?: string;
  name: string;
  number?: string;
  kind?: string;
  language?: string;
  relativePath?: string;
  softwarePath?: string;
  taskOB?: string;
  callPath?: string[];
  instancePath?: string[];
};

export type ExecutionBlockDescriptor = Omit<ExecutionBlockSource, "xml">;

export type SymbolOperand = {
  symbol: string;
  normalizedSymbol: string;
  scope: string;
};

export type ValueExpression =
  | SymbolOperand & { kind: "symbol" }
  | { kind: "literal"; value: string; dataType?: string }
  | { kind: "operation"; operator: string; operands: ValueExpression[]; text: string }
  | { kind: "call-result"; callee: string; output?: string; instance?: string }
  | { kind: "unknown"; text: string; reason: string; symbols: SymbolOperand[] };

export type GuardExpression =
  | { kind: "literal"; value: boolean }
  | SymbolOperand & { kind: "symbol" }
  | { kind: "not"; operand: GuardExpression }
  | { kind: "and" | "or"; operands: GuardExpression[] }
  | { kind: "compare"; operator: string; left: ValueExpression; right: ValueExpression }
  | { kind: "edge"; edge: "rising" | "falling"; operand: GuardExpression; memory?: SymbolOperand }
  | {
      kind: "stateful";
      instruction: string;
      instance?: string;
      output?: string;
      inputs: Record<string, ValueExpression>;
    }
  | {
      kind: "loop";
      loop: "for" | "while" | "repeat";
      header: string;
      condition?: GuardExpression;
      atLeastOnce?: boolean;
    }
  | { kind: "unknown"; text: string; reason: string; symbols: SymbolOperand[] };

export type WriteEffect =
  | { kind: "assign"; value: ValueExpression; readBeforeWrite?: boolean }
  | { kind: "coil"; mode: "normal" | "set" | "reset"; energizeWhen: GuardExpression }
  | {
      kind: "timer";
      instruction: "TON" | "TOF" | "TONR" | "TP";
      instance?: string;
      output: string;
      inputs: Record<string, ValueExpression>;
    }
  | {
      kind: "counter";
      instruction: string;
      instance?: string;
      output: string;
      inputs: Record<string, ValueExpression>;
    }
  | {
      kind: "call-output";
      callee: string;
      output: string;
      instance?: string;
      inOut: boolean;
      callUid?: string;
    }
  | { kind: "unknown"; description: string };

export type ExecutionContext = {
  taskOB: string;
  callPath: string[];
  instancePath: string[];
};

export type WriteSite = {
  siteId: string;
  target: string;
  normalizedTarget: string;
  targetScope: string;
  effect: WriteEffect;
  guard: GuardExpression;
  readSymbols: string[];
  normalizedReadSymbols: string[];
  blockKey: string;
  blockName: string;
  blockNumber: string;
  blockKind: string;
  softwarePath: string;
  language: string;
  relativePath: string;
  network: number;
  networkTitle?: string;
  statementOrder: number;
  xmlLine: number;
  taskOB?: string;
  callPath: string[];
  instancePath: string[];
  executionContexts: ExecutionContext[];
  controlContext: string[];
  confidence: SemanticConfidence;
  coverage: CoverageLevel;
  unsupportedReason?: string;
  sourceKind: "LAD_FBD" | "SCL" | "GRAPH";
  graphAction?: { sequence: number; step: string; stepName: string; action: number; qualifier: string; event: string; interlocked: boolean; text: string };
  composedFrom?: {
    callId: string;
    calleeBlockKey: string;
    calleeSiteId: string;
    formalTarget: string;
    bindingName: string;
  };
};

export type ParameterDirection = "input" | "output" | "inout" | "unknown";

export type ParameterBinding = {
  name: string;
  section: string;
  direction: ParameterDirection;
  actual: ValueExpression;
  sourceSymbols: string[];
  targetSymbols: string[];
};

export type CallSite = {
  callId: string;
  sourceUid?: string;
  calleeName: string;
  calleeKind: string;
  instance?: string;
  parameterBindings: ParameterBinding[];
  guard: GuardExpression;
  readSymbols: string[];
  normalizedReadSymbols: string[];
  blockKey: string;
  blockName: string;
  blockNumber: string;
  blockKind: string;
  softwarePath: string;
  language: string;
  relativePath: string;
  network: number;
  statementOrder: number;
  xmlLine: number;
  taskOB?: string;
  callPath: string[];
  instancePath: string[];
  executionContexts: ExecutionContext[];
  controlContext: string[];
  confidence: SemanticConfidence;
  coverage: CoverageLevel;
  unsupportedReason?: string;
  sourceKind: "LAD_FBD" | "SCL" | "GRAPH";
};

export type ControlFlowSite = {
  controlId: string;
  kind: "return" | "exit" | "continue";
  guard: GuardExpression;
  blockKey: string;
  network: number;
  statementOrder: number;
  xmlLine: number;
  controlContext: string[];
};

export type NetworkCoverage = {
  network: number;
  sourceKind: "LAD_FBD" | "SCL" | "GRAPH" | "UNKNOWN";
  level: CoverageLevel;
  writeSites: number;
  callSites: number;
  issues: string[];
};

export type CoverageReport = {
  level: CoverageLevel;
  exactSites: number;
  conservativeSites: number;
  unsupportedSites: number;
  issues: string[];
};

export type ExecutionBlockAnalysis = {
  analyzerVersion: string;
  blockKey: string;
  name: string;
  number: string;
  kind: string;
  softwarePath: string;
  language: string;
  relativePath: string;
  sha256: string;
  writeSites: WriteSite[];
  callSites: CallSite[];
  controlSites: ControlFlowSite[];
  readSymbols: string[];
  normalizedReadSymbols: string[];
  networks: NetworkCoverage[];
  coverage: CoverageReport;
  graph?: GraphSequence[];
};

export type GraphCondition = { guard: GuardExpression; coverage: CoverageLevel };
export type GraphSequence = {
  sequence: number;
  steps: Array<{
    number: string; name: string; initial: boolean;
    actions: Array<{ qualifier: string; event: string; interlocked: boolean; text: string }>;
    interlocks: GraphCondition[]; supervisions: GraphCondition[];
    exits: Array<{ transition: string; nextSteps: string[] }>;
  }>;
  transitions: Array<{ number: string; name: string; condition: GraphCondition }>;
  branches: Array<{ number: string; attributes: Record<string, string> }>;
  connections: Array<{ from: string; to: string; fromPort: string; toPort: string; linkType: string }>;
  issues: string[];
};

export type SymbolAdjacency = {
  symbol: string;
  normalizedSymbol: string;
  readSiteIds: string[];
  writeSiteIds: string[];
  callSiteIds: string[];
};

export type IncrementalReanalysisPlan = {
  changedBlockKeys: string[];
  addedBlockKeys: string[];
  removedBlockKeys: string[];
  dependentBlockKeys: string[];
  xmlRequiredBlockKeys: string[];
  reusableBlockKeys: string[];
};

export type IncrementalBuildResult = IncrementalReanalysisPlan & {
  pendingBlockKeys: string[];
};

export type ExecutionModelIndex = {
  schemaVersion: 1;
  analyzerVersion: string;
  generatedAt: string;
  sourceSignature: string;
  blocks: Record<string, ExecutionBlockAnalysis>;
  writeSites: WriteSite[];
  callSites: CallSite[];
  roots: Array<{ blockKey: string; taskOB: string }>;
  adjacency: Record<string, SymbolAdjacency>;
  unresolvedCalls: Array<{ callId: string; calleeName: string; callerBlockKey: string }>;
  coverage: CoverageReport;
  incremental: IncrementalBuildResult;
};

export type ExecutionSymbolQuery = {
  query: string;
  normalizedQuery: string;
  matches: SymbolAdjacency[];
  writes: WriteSite[];
  calls: CallSite[];
};

type OrderedElement = Record<string, unknown>;

type AccessSemantic = {
  uid: string;
  scope: string;
  symbol?: SymbolOperand;
  value: ValueExpression;
};

type CodeToken =
  | { kind: "token"; text: string }
  | { kind: "access"; text: string; operand: SymbolOperand }
  | { kind: "call"; text: string; call: ParsedCall };

type ParsedCall = {
  uid: string;
  name: string;
  blockType: string;
  instance?: string;
  parameters: ParameterBinding[];
  // A LAD/FBD instruction box (MOVE, GET, TON, Add ...) whose pins were read from the wiring.
  instruction?: boolean;
  // DisabledENO="true" on the box: ENO is not evaluated and equals EN.
  disabledEno?: boolean;
};

// Calls of this kind are system instructions, never user blocks.
const INSTRUCTION_KIND = "Instruction";

type BlockOwner = {
  blockKey: string;
  name: string;
  number: string;
  kind: string;
  softwarePath: string;
  language: string;
  relativePath: string;
  taskOB?: string;
  callPath: string[];
  instancePath: string[];
};

type LocationSeed = {
  network: number;
  xmlLine: number;
  sourceKind: "LAD_FBD" | "SCL" | "GRAPH";
  networkTitle?: string;
};

type SemanticAccumulator = {
  writes: WriteSite[];
  calls: CallSite[];
  controls: ControlFlowSite[];
  networks: NetworkCoverage[];
  nextOrder: number;
};

const xmlParserOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  preserveOrder: true,
  parseAttributeValue: false,
  parseTagValue: false,
  processEntities: true,
  trimValues: false
};
const xmlParser = new XMLParser(xmlParserOptions);
const graphXmlParser = new XMLParser({ ...xmlParserOptions, htmlEntities: true });

const TRUE_GUARD: GuardExpression = { kind: "literal", value: true };
const FALSE_GUARD: GuardExpression = { kind: "literal", value: false };

function compact(value: string, maxLength = 320): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength)}…`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function cleanSymbol(symbol: string): string {
  return symbol
    .replace(/\s+/g, "")
    .replace(/"([^"]+)"/g, "$1")
    .replace(/^#/, "")
    .replace(/^%/, "")
    .toLowerCase();
}

export function normalizeExecutionSymbol(symbol: string, scope = "", ownerBlockKey = ""): string {
  const normalized = cleanSymbol(symbol);
  if (/local/i.test(scope) && ownerBlockKey) return `${ownerBlockKey.toLowerCase()}::${normalized}`;
  return normalized;
}

export function executionBlockKey(source: Pick<ExecutionBlockSource, "kind" | "number" | "name" | "relativePath" | "softwarePath">): string {
  const kind = (source.kind || inferBlockKind(source.name) || "BLOCK").toUpperCase();
  const identity = source.number?.trim() || source.name.trim() || source.relativePath?.trim() || "unknown";
  const software = cleanSymbol(source.softwarePath ?? "");
  return `${software ? `${software}::` : ""}${kind}:${cleanSymbol(identity)}`;
}

// The export time in DocumentInfo changes on every export; it is not program content.
export function semanticBlockXml(xml: string): string {
  return xml.replace(/<DocumentInfo>[\s\S]*?<\/DocumentInfo>/g,
    (info) => info.replace(/<Created>[^<\r\n]*<\/Created>/g, "<Created/>"));
}

export function hashExecutionBlock(xml: string): string {
  return createHash("sha256").update(semanticBlockXml(xml), "utf8").digest("hex");
}

function inferBlockKind(value: string): string {
  const match = /\b(OB|FB|FC|DB)\s*[-_ ]?\s*(\d+)?\b/i.exec(value);
  return match?.[1]?.toUpperCase() ?? "";
}

function sourceHash(source: ExecutionBlockSource): string {
  if (source.sha256?.trim()) return source.sha256.trim().toLowerCase();
  return source.xml === undefined ? "" : hashExecutionBlock(source.xml);
}

function lineLookup(text: string): (offset: number) => number {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return (offset: number) => {
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (starts[middle] <= offset) low = middle + 1;
      else high = middle;
    }
    return Math.max(1, low);
  };
}

function parseOrdered(xml: string, graph = false): OrderedElement[] {
  const parsed = (graph ? graphXmlParser : xmlParser).parse(xml) as unknown;
  return Array.isArray(parsed) ? parsed.filter(isElement) : [];
}

function isElement(value: unknown): value is OrderedElement {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function elementName(node: OrderedElement): string {
  return Object.keys(node).find((key) => key !== ":@" && key !== "#text" && key !== "?xml") ?? "";
}

function elementChildren(node: OrderedElement): OrderedElement[] {
  const name = elementName(node);
  const value = name ? node[name] : undefined;
  return Array.isArray(value) ? value.filter(isElement) : [];
}

function attributes(node: OrderedElement): Record<string, string> {
  const raw = node[":@"];
  if (!isElement(raw)) return {};
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    result[name.replace(/^@_/, "")] = String(value ?? "");
  }
  return result;
}

function attribute(node: OrderedElement, name: string): string {
  const attrs = attributes(node);
  const match = Object.keys(attrs).find((key) => key.toLowerCase() === name.toLowerCase());
  return match ? attrs[match] : "";
}

function directChildren(node: OrderedElement, name?: string): OrderedElement[] {
  const children = elementChildren(node);
  return name ? children.filter((child) => elementName(child).toLowerCase() === name.toLowerCase()) : children;
}

function descendants(node: OrderedElement | OrderedElement[], name?: string): OrderedElement[] {
  const roots = Array.isArray(node) ? node : [node];
  const result: OrderedElement[] = [];
  const visit = (current: OrderedElement) => {
    const currentName = elementName(current);
    if (!name || currentName.toLowerCase() === name.toLowerCase()) result.push(current);
    for (const child of elementChildren(current)) visit(child);
  };
  for (const root of roots) visit(root);
  return result;
}

function firstDescendant(node: OrderedElement, name: string): OrderedElement | undefined {
  return descendants(node, name)[0];
}

function nodeText(node: OrderedElement): string {
  const values: string[] = [];
  const visit = (current: OrderedElement) => {
    if ("#text" in current) values.push(String(current["#text"] ?? ""));
    for (const child of elementChildren(current)) visit(child);
  };
  visit(node);
  return values.join("");
}

function tokenText(token: CodeToken): string {
  return token.kind === "access" ? token.operand.symbol : token.text;
}

function renderTokens(tokens: CodeToken[]): string {
  return compact(tokens.map(tokenText).join(" "));
}

function symbolOperand(symbol: string, scope: string, ownerBlockKey: string): SymbolOperand {
  return {
    symbol,
    normalizedSymbol: normalizeExecutionSymbol(symbol, scope, ownerBlockKey),
    scope
  };
}

function componentsFrom(node: OrderedElement): string[] {
  const result: string[] = [];
  const visit = (current: OrderedElement) => {
    for (const child of elementChildren(current)) {
      const name = elementName(child);
      if (name.toLowerCase() === "access") continue;
      if (name.toLowerCase() === "component") {
        const component = attribute(child, "Name");
        if (component) result.push(component);
      }
      visit(child);
    }
  };
  visit(node);
  return result;
}

function indexedSymbolComponents(node: OrderedElement): OrderedElement[] {
  return descendants(node, "Component").filter((component) => (
    /^array$/i.test(attribute(component, "AccessModifier"))
    || descendants(component, "Access").length > 0
  ));
}

function integerAttribute(node: OrderedElement, name: string): number | null {
  const value = attribute(node, name).trim();
  if (!/^-?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function absoluteAddressSymbol(node: OrderedElement): string | null {
  const area = attribute(node, "Area").trim().toLowerCase();
  const dataType = attribute(node, "Type").trim().toLowerCase();
  const blockNumber = integerAttribute(node, "BlockNumber");
  const bitOffset = integerAttribute(node, "BitOffset");
  if (bitOffset === null || bitOffset < 0) return null;

  const byteOffset = Math.floor(bitOffset / 8);
  const bitInByte = bitOffset % 8;
  const width = /^(?:bool|bit)$/.test(dataType)
    ? "bit"
    : /^(?:byte|char|sint|usint)$/.test(dataType)
      ? "byte"
      : /^(?:word|int|uint)$/.test(dataType)
        ? "word"
        : /^(?:dword|dint|udint|real|time)$/.test(dataType)
          ? "dword"
          : /^(?:lword|lint|ulint|lreal|ltime)$/.test(dataType)
            ? "lword"
            : "";
  if (!width) return null;

  const offset = width === "bit"
    ? `${byteOffset}.${bitInByte}`
    : String(byteOffset);
  if (area === "db" && blockNumber !== null && blockNumber >= 0) {
    const selector = width === "bit"
      ? "DBX"
      : width === "byte"
        ? "DBB"
        : width === "word"
          ? "DBW"
          : width === "dword"
            ? "DBD"
            : "DBL";
    return `%DB${blockNumber}.${selector}${offset}`;
  }

  const areaPrefix = area === "input"
    ? "I"
    : area === "output"
      ? "Q"
      : area === "memory"
        ? "M"
        : "";
  if (!areaPrefix) return null;
  const selector = width === "bit"
    ? areaPrefix
    : width === "byte"
      ? `${areaPrefix}B`
      : width === "word"
        ? `${areaPrefix}W`
        : width === "dword"
          ? `${areaPrefix}D`
          : `${areaPrefix}L`;
  return `%${selector}${offset}`;
}

function parseAccess(node: OrderedElement, ownerBlockKey: string): AccessSemantic {
  const uid = attribute(node, "UId");
  const scope = attribute(node, "Scope");
  const symbolNode = firstDescendant(node, "Symbol");
  if (symbolNode) {
    const components = componentsFrom(symbolNode);
    const indexedComponents = indexedSymbolComponents(symbolNode);
    if (indexedComponents.length > 0) {
      const referenced = new Map<string, SymbolOperand>();
      for (const component of indexedComponents) {
        for (const nestedAccess of descendants(component, "Access")) {
          const nested = parseAccess(nestedAccess, ownerBlockKey);
          for (const operand of nested.symbol ? [nested.symbol] : collectValueSymbols(nested.value)) {
            referenced.set(operand.normalizedSymbol, operand);
          }
        }
      }
      const base = components.length > 0
        ? symbolOperand(`${components.join(".")}[?]`, scope, ownerBlockKey)
        : undefined;
      if (base) referenced.set(base.normalizedSymbol, base);
      return {
        uid,
        scope,
        value: {
          kind: "unknown",
          text: base?.symbol ?? compact(nodeText(symbolNode)),
          reason: "Array index access is not statically resolved",
          symbols: [...referenced.values()]
        }
      };
    }
    if (components.length > 0) {
      const operand = symbolOperand(components.join("."), scope, ownerBlockKey);
      return { uid, scope, symbol: operand, value: { kind: "symbol", ...operand } };
    }
  }
  const address = firstDescendant(node, "Address");
  if (address) {
    const rendered = absoluteAddressSymbol(address);
    if (rendered) {
      const operand = symbolOperand(rendered, scope || "AbsoluteAddress", ownerBlockKey);
      return { uid, scope: operand.scope, symbol: operand, value: { kind: "symbol", ...operand } };
    }
    return {
      uid,
      scope: scope || "AbsoluteAddress",
      value: {
        kind: "unknown",
        text: compact(nodeText(address)) || JSON.stringify(attributes(address)),
        reason: "Absolute address type or area is not safely canonicalized",
        symbols: []
      }
    };
  }
  const constant = firstDescendant(node, "Constant");
  if (constant) {
    const valueNode = firstDescendant(constant, "ConstantValue");
    const typeNode = firstDescendant(constant, "ConstantType");
    return {
      uid,
      scope,
      value: {
        kind: "literal",
        value: valueNode ? compact(nodeText(valueNode)) : attribute(constant, "Name"),
        dataType: typeNode ? compact(nodeText(typeNode)) : undefined
      }
    };
  }
  return {
    uid,
    scope,
    value: { kind: "unknown", text: compact(nodeText(node)), reason: "Unsupported Access form", symbols: [] }
  };
}

function collectValueSymbols(value: ValueExpression): SymbolOperand[] {
  switch (value.kind) {
    case "symbol":
      return [value];
    case "operation":
      return value.operands.flatMap(collectValueSymbols);
    case "unknown":
      return value.symbols;
    default:
      return [];
  }
}

function collectGuardSymbols(guard: GuardExpression): SymbolOperand[] {
  switch (guard.kind) {
    case "symbol":
      return [guard];
    case "not":
      return collectGuardSymbols(guard.operand);
    case "and":
    case "or":
      return guard.operands.flatMap(collectGuardSymbols);
    case "compare":
      return [...collectValueSymbols(guard.left), ...collectValueSymbols(guard.right)];
    case "edge":
      return [...collectGuardSymbols(guard.operand), ...(guard.memory ? [guard.memory] : [])];
    case "stateful":
      return Object.values(guard.inputs).flatMap(collectValueSymbols);
    case "loop":
      return guard.condition ? collectGuardSymbols(guard.condition) : [];
    case "unknown":
      return guard.symbols;
    default:
      return [];
  }
}

function valueAsGuard(value: ValueExpression, reason = "Expression is not proven Boolean"): GuardExpression {
  if (value.kind === "symbol") return value;
  if (value.kind === "literal") {
    if (/^(true|1)$/i.test(value.value)) return TRUE_GUARD;
    if (/^(false|0)$/i.test(value.value)) return FALSE_GUARD;
  }
  return {
    kind: "unknown",
    text: value.kind === "unknown" ? value.text : JSON.stringify(value),
    reason,
    symbols: collectValueSymbols(value)
  };
}

function notGuard(operand: GuardExpression): GuardExpression {
  if (operand.kind === "literal") return { kind: "literal", value: !operand.value };
  if (operand.kind === "not") return operand.operand;
  return { kind: "not", operand };
}

function andGuard(...items: GuardExpression[]): GuardExpression {
  const operands = items.flatMap((item) => item.kind === "and" ? item.operands : [item]);
  if (operands.some((item) => item.kind === "literal" && !item.value)) return FALSE_GUARD;
  const filtered = operands.filter((item) => !(item.kind === "literal" && item.value));
  if (filtered.length === 0) return TRUE_GUARD;
  if (filtered.length === 1) return filtered[0];
  return { kind: "and", operands: filtered };
}

function orGuard(...items: GuardExpression[]): GuardExpression {
  const operands = items.flatMap((item) => item.kind === "or" ? item.operands : [item]);
  if (operands.some((item) => item.kind === "literal" && item.value)) return TRUE_GUARD;
  const filtered = operands.filter((item) => !(item.kind === "literal" && !item.value));
  if (filtered.length === 0) return FALSE_GUARD;
  if (filtered.length === 1) return filtered[0];
  return { kind: "or", operands: filtered };
}

function directionFromSection(section: string): ParameterDirection {
  if (/^input$/i.test(section)) return "input";
  if (/^output$/i.test(section)) return "output";
  if (/^inout$/i.test(section)) return "inout";
  return "unknown";
}

function coverageRank(level: CoverageLevel): number {
  return level === "exact" ? 0 : level === "conservative" ? 1 : 2;
}

function worstCoverage(levels: CoverageLevel[]): CoverageLevel {
  return levels.reduce<CoverageLevel>((worst, level) => coverageRank(level) > coverageRank(worst) ? level : worst, "exact");
}

function confidenceFor(level: CoverageLevel): SemanticConfidence {
  return level === "exact" ? "high" : level === "conservative" ? "medium" : "low";
}

function issueCoverage(issues: string[], sites: Array<WriteSite | CallSite>): CoverageLevel {
  if (sites.some((site) => site.coverage === "unsupported")) return "unsupported";
  if (issues.length > 0 || sites.some((site) => site.coverage === "conservative")) return "conservative";
  return "exact";
}

function makeOwner(source: ExecutionBlockSource): BlockOwner {
  const kind = (source.kind || inferBlockKind(source.name) || "BLOCK").toUpperCase();
  const number = source.number ?? "";
  const blockKey = executionBlockKey({ ...source, kind });
  const taskOB = source.taskOB || (kind === "OB"
    ? `${source.softwarePath ? `${source.softwarePath} / ` : ""}${source.name}${number ? ` [OB${number}]` : ""}`
    : undefined);
  return {
    blockKey,
    name: source.name,
    number,
    kind,
    softwarePath: source.softwarePath ?? "",
    language: source.language ?? "",
    relativePath: source.relativePath ?? "",
    taskOB,
    callPath: source.callPath ?? (taskOB ? [blockKey] : []),
    instancePath: source.instancePath ?? []
  };
}

function nextOrder(accumulator: SemanticAccumulator): number {
  accumulator.nextOrder += 1;
  return accumulator.nextOrder;
}

function siteBase(
  owner: BlockOwner,
  location: LocationSeed,
  statementOrder: number,
  controlContext: string[]
): Pick<
  WriteSite,
  | "blockKey"
  | "blockName"
  | "blockNumber"
  | "blockKind"
  | "softwarePath"
  | "language"
  | "relativePath"
  | "network"
  | "networkTitle"
  | "statementOrder"
  | "xmlLine"
  | "taskOB"
  | "callPath"
  | "instancePath"
  | "executionContexts"
  | "controlContext"
  | "sourceKind"
> {
  const initialContext = owner.taskOB
    ? [{ taskOB: owner.taskOB, callPath: owner.callPath, instancePath: owner.instancePath }]
    : [];
  return {
    blockKey: owner.blockKey,
    blockName: owner.name,
    blockNumber: owner.number,
    blockKind: owner.kind,
    softwarePath: owner.softwarePath,
    language: owner.language,
    relativePath: owner.relativePath,
    network: location.network,
    networkTitle: location.networkTitle,
    statementOrder,
    xmlLine: location.xmlLine,
    taskOB: owner.taskOB,
    callPath: owner.callPath,
    instancePath: owner.instancePath,
    executionContexts: initialContext,
    controlContext,
    sourceKind: location.sourceKind
  };
}

function siteReadSymbols(guard: GuardExpression, values: ValueExpression[] = []): SymbolOperand[] {
  const byNormalized = new Map<string, SymbolOperand>();
  for (const operand of [...collectGuardSymbols(guard), ...values.flatMap(collectValueSymbols)]) {
    byNormalized.set(operand.normalizedSymbol, operand);
  }
  return [...byNormalized.values()];
}

function makeWriteSite(
  owner: BlockOwner,
  location: LocationSeed,
  accumulator: SemanticAccumulator,
  target: SymbolOperand,
  effect: WriteEffect,
  guard: GuardExpression,
  controlContext: string[],
  coverage: CoverageLevel,
  values: ValueExpression[] = [],
  unsupportedReason?: string
): WriteSite {
  const order = nextOrder(accumulator);
  const reads = siteReadSymbols(guard, values);
  return {
    siteId: `${owner.blockKey}:N${location.network}:W${order}`,
    target: target.symbol,
    normalizedTarget: target.normalizedSymbol,
    targetScope: target.scope,
    effect,
    guard,
    readSymbols: reads.map((item) => item.symbol),
    normalizedReadSymbols: reads.map((item) => item.normalizedSymbol),
    ...siteBase(owner, location, order, controlContext),
    confidence: confidenceFor(coverage),
    coverage,
    unsupportedReason
  };
}

function makeCallSite(
  owner: BlockOwner,
  location: LocationSeed,
  accumulator: SemanticAccumulator,
  call: ParsedCall,
  guard: GuardExpression,
  controlContext: string[],
  coverage: CoverageLevel,
  unsupportedReason?: string
): CallSite {
  const order = nextOrder(accumulator);
  const values = call.parameters
    .filter((binding) => binding.direction === "input" || binding.direction === "inout")
    .map((binding) => binding.actual);
  const reads = siteReadSymbols(guard, values);
  return {
    callId: `${owner.blockKey}:N${location.network}:C${order}`,
    sourceUid: call.uid,
    calleeName: call.name,
    calleeKind: call.blockType,
    instance: call.instance,
    parameterBindings: call.parameters,
    guard,
    readSymbols: reads.map((item) => item.symbol),
    normalizedReadSymbols: reads.map((item) => item.normalizedSymbol),
    ...siteBase(owner, location, order, controlContext),
    confidence: confidenceFor(coverage),
    coverage,
    unsupportedReason
  };
}

function parseInstance(node: OrderedElement | undefined): string | undefined {
  if (!node) return undefined;
  const components = componentsFrom(node);
  if (components.length > 0) return components.join(".");
  const address = firstDescendant(node, "Address");
  if (address) {
    return [
      attribute(address, "Area"),
      attribute(address, "BlockNumber"),
      attribute(address, "BitOffset")
    ].filter(Boolean).join(":");
  }
  return undefined;
}

function normalizeOperator(value: string): string {
  const compacted = value.replace(/\s+/g, "").toUpperCase();
  if (compacted === "&") return "AND";
  if (compacted === "|") return "OR";
  if (compacted === "!") return "NOT";
  if (compacted === "=") return "=";
  return compacted;
}

function isToken(token: CodeToken, value: string): boolean {
  return token.kind === "token" && normalizeOperator(token.text) === normalizeOperator(value);
}

function tokenDepthDelta(token: CodeToken): number {
  if (token.kind !== "token") return 0;
  if (token.text.trim() === "(" || token.text.trim() === "[") return 1;
  if (token.text.trim() === ")" || token.text.trim() === "]") return -1;
  return 0;
}

function stripOuterParentheses(tokens: CodeToken[]): CodeToken[] {
  let result = [...tokens];
  while (result.length >= 2 && isToken(result[0], "(") && isToken(result[result.length - 1], ")")) {
    let depth = 0;
    let enclosesAll = true;
    for (let index = 0; index < result.length; index += 1) {
      depth += tokenDepthDelta(result[index]);
      if (depth === 0 && index < result.length - 1) {
        enclosesAll = false;
        break;
      }
    }
    if (!enclosesAll) break;
    result = result.slice(1, -1);
  }
  return result;
}

function topLevelOperatorIndexes(tokens: CodeToken[], operators: string[]): number[] {
  const normalized = new Set(operators.map(normalizeOperator));
  const indexes: number[] = [];
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (depth === 0 && token.kind === "token" && normalized.has(normalizeOperator(token.text))) indexes.push(index);
    depth += tokenDepthDelta(token);
  }
  return indexes;
}

function splitByIndexes(tokens: CodeToken[], indexes: number[]): CodeToken[][] {
  const result: CodeToken[][] = [];
  let start = 0;
  for (const index of indexes) {
    result.push(tokens.slice(start, index));
    start = index + 1;
  }
  result.push(tokens.slice(start));
  return result;
}

function literalFromToken(value: string): ValueExpression | null {
  const trimmed = value.trim();
  if (
    /^(?:TRUE|FALSE)$/i.test(trimmed)
    || /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][-+]?\d+)?$/.test(trimmed)
    || /^(?:[A-Z_][A-Z0-9_]*#)?(?:[-+]?\d+(?:\.\d+)?|TRUE|FALSE)$/i.test(trimmed)
    || /^'(?:[^']|'')*'$/.test(trimmed)
  ) {
    return { kind: "literal", value: trimmed };
  }
  return null;
}

function valueFromTokens(input: CodeToken[]): ValueExpression {
  const tokens = stripOuterParentheses(input.filter((token) => tokenText(token).trim() !== ""));
  if (tokens.length === 0) return { kind: "unknown", text: "", reason: "Empty expression", symbols: [] };
  if (tokens.length === 1) {
    const token = tokens[0];
    if (token.kind === "access") return { kind: "symbol", ...token.operand };
    if (token.kind === "call") {
      return {
        kind: "call-result",
        callee: token.call.name,
        instance: token.call.instance
      };
    }
    const literal = literalFromToken(token.text);
    if (literal) return literal;
  }
  const accesses = tokens.filter((token): token is Extract<CodeToken, { kind: "access" }> => token.kind === "access");
  const calls = tokens.filter((token): token is Extract<CodeToken, { kind: "call" }> => token.kind === "call");
  const operator = tokens
    .filter((token) => token.kind === "token")
    .map((token) => token.text.trim())
    .find((value) => /^(?:\+|-|\*|\/|MOD|SHL|SHR|AND|OR|XOR)$/i.test(value));
  if (operator) {
    return {
      kind: "operation",
      operator: normalizeOperator(operator),
      operands: [
        ...accesses.map((token): ValueExpression => ({ kind: "symbol", ...token.operand })),
        ...calls.map((token): ValueExpression => ({
          kind: "call-result",
          callee: token.call.name,
          instance: token.call.instance
        }))
      ],
      text: renderTokens(tokens)
    };
  }
  return {
    kind: "unknown",
    text: renderTokens(tokens),
    reason: "Expression grammar not fully resolved",
    symbols: accesses.map((token) => token.operand)
  };
}

function guardFromTokens(input: CodeToken[]): GuardExpression {
  const tokens = stripOuterParentheses(input.filter((token) => tokenText(token).trim() !== ""));
  if (tokens.length === 0) return { kind: "unknown", text: "", reason: "Empty guard", symbols: [] };

  const orIndexes = topLevelOperatorIndexes(tokens, ["OR", "|"]);
  if (orIndexes.length > 0) return orGuard(...splitByIndexes(tokens, orIndexes).map(guardFromTokens));

  const xorIndexes = topLevelOperatorIndexes(tokens, ["XOR"]);
  if (xorIndexes.length > 0) {
    const symbols = tokens
      .filter((token): token is Extract<CodeToken, { kind: "access" }> => token.kind === "access")
      .map((token) => token.operand);
    return { kind: "unknown", text: renderTokens(tokens), reason: "XOR guard is retained conservatively", symbols };
  }

  const andIndexes = topLevelOperatorIndexes(tokens, ["AND", "&"]);
  if (andIndexes.length > 0) return andGuard(...splitByIndexes(tokens, andIndexes).map(guardFromTokens));

  if (isToken(tokens[0], "NOT") || isToken(tokens[0], "!")) return notGuard(guardFromTokens(tokens.slice(1)));

  const comparisons = topLevelOperatorIndexes(tokens, ["=", "<>", ">", ">=", "<", "<="]);
  if (comparisons.length === 1) {
    const index = comparisons[0];
    return {
      kind: "compare",
      operator: normalizeOperator(tokenText(tokens[index])),
      left: valueFromTokens(tokens.slice(0, index)),
      right: valueFromTokens(tokens.slice(index + 1))
    };
  }

  if (tokens.length === 1) {
    const token = tokens[0];
    if (token.kind === "access") return { kind: "symbol", ...token.operand };
    if (token.kind === "token") {
      if (/^(true|1)$/i.test(token.text.trim())) return TRUE_GUARD;
      if (/^(false|0)$/i.test(token.text.trim())) return FALSE_GUARD;
    }
  }
  return valueAsGuard(valueFromTokens(tokens));
}

function directParameterNodes(callInfo: OrderedElement): OrderedElement[] {
  return directChildren(callInfo, "Parameter");
}

function flattenSclNodes(nodes: OrderedElement[], ownerBlockKey: string): CodeToken[] {
  const result: CodeToken[] = [];
  const visit = (node: OrderedElement) => {
    const name = elementName(node).toLowerCase();
    if (name === "linecomment" || name === "comment") return;
    if (name === "access") {
      const callInfo = firstDescendant(node, "CallInfo");
      if (callInfo) {
        const parsed = parseCallInfo(callInfo, ownerBlockKey, attribute(node, "UId"));
        result.push({ kind: "call", text: parsed.name, call: parsed });
        return;
      }
      const access = parseAccess(node, ownerBlockKey);
      if (access.symbol) result.push({ kind: "access", text: access.symbol.symbol, operand: access.symbol });
      else result.push({ kind: "token", text: compact(nodeText(node)) || "<?>" });
      return;
    }
    if (name === "token") {
      result.push({ kind: "token", text: attribute(node, "Text") || nodeText(node) });
      return;
    }
    if (name === "newline") {
      result.push({ kind: "token", text: "\n" });
      return;
    }
    if (name === "text") {
      const text = nodeText(node);
      for (const part of text.match(/:=|=>|>=|<=|<>|\+=|-=|\*=|\/=|[()[\],;:+\-*/=<>]|\S+/g) ?? []) {
        result.push({ kind: "token", text: part });
      }
      return;
    }
    for (const child of elementChildren(node)) visit(child);
  };
  for (const node of nodes) visit(node);
  return combineSplitOperators(result);
}

function combineSplitOperators(tokens: CodeToken[]): CodeToken[] {
  const result: CodeToken[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const current = tokens[index];
    const next = tokens[index + 1];
    if (
      current.kind === "token"
      && next?.kind === "token"
      && [":", "=", ">", "<", "+", "-", "*", "/"].includes(current.text.trim())
      && next.text.trim() === "="
    ) {
      result.push({ kind: "token", text: `${current.text.trim()}=` });
      index += 1;
    } else if (!(current.kind === "token" && current.text === "\n")) {
      result.push(current);
    }
  }
  return result;
}

function parseParameterBinding(parameter: OrderedElement, ownerBlockKey: string): ParameterBinding {
  const name = attribute(parameter, "Name");
  const section = attribute(parameter, "Section");
  const direction = directionFromSection(section);
  const tokens = flattenSclNodes(elementChildren(parameter), ownerBlockKey);
  const actual = valueFromTokens(tokens);
  const symbols = collectValueSymbols(actual);
  return {
    name,
    section,
    direction,
    actual,
    sourceSymbols: direction === "output" ? [] : symbols.map((item) => item.symbol),
    targetSymbols: direction === "output" || direction === "inout" ? symbols.map((item) => item.symbol) : []
  };
}

function parseCallInfo(callInfo: OrderedElement, ownerBlockKey: string, fallbackUid = ""): ParsedCall {
  const instance = parseInstance(directChildren(callInfo, "Instance")[0] ?? firstDescendant(callInfo, "Instance"));
  return {
    uid: attribute(callInfo, "UId") || fallbackUid,
    name: attribute(callInfo, "Name") || "<dynamic-call>",
    blockType: attribute(callInfo, "BlockType") || "UNKNOWN",
    instance,
    parameters: directParameterNodes(callInfo).map((parameter) => parseParameterBinding(parameter, ownerBlockKey))
  };
}

function bindingValue(call: ParsedCall, name: string): ValueExpression | undefined {
  return call.parameters.find((binding) => binding.name.toLowerCase() === name.toLowerCase())?.actual;
}

function callInputMap(call: ParsedCall): Record<string, ValueExpression> {
  const result: Record<string, ValueExpression> = {};
  for (const binding of call.parameters) {
    if (binding.direction === "input" || binding.direction === "inout") result[binding.name] = binding.actual;
  }
  return result;
}

function effectForCallOutput(call: ParsedCall, binding: ParameterBinding): WriteEffect {
  const instruction = call.name.toUpperCase();
  if (["TON", "TOF", "TONR", "TP"].includes(instruction)) {
    return {
      kind: "timer",
      instruction: instruction as "TON" | "TOF" | "TONR" | "TP",
      instance: call.instance,
      output: binding.name,
      inputs: callInputMap(call)
    };
  }
  if (/^(?:CTU|CTD|CTUD|IEC_COUNTER|COUNTER)/.test(instruction)) {
    return {
      kind: "counter",
      instruction,
      instance: call.instance,
      output: binding.name,
      inputs: callInputMap(call)
    };
  }
  if (/^(?:MOVE|MOVE_BLK|CONV|CONVERT)$/.test(instruction) && /^OUT/i.test(binding.name)) {
    return {
      kind: "assign",
      value: bindingValue(call, "IN") ?? {
        kind: "unknown",
        text: `${call.name}.${binding.name}`,
        reason: "MOVE input binding is missing",
        symbols: []
      }
    };
  }
  return {
    kind: "call-output",
    callee: call.name,
    output: binding.name,
    instance: call.instance,
    inOut: binding.direction === "inout",
    callUid: call.uid
  };
}

function coverageForCallOutput(effect: WriteEffect, callCoverage: CoverageLevel): CoverageLevel {
  if (callCoverage === "unsupported") return "unsupported";
  return effect.kind === "call-output" ? "conservative" : callCoverage;
}

function reasonForCallOutput(effect: WriteEffect, callCoverage: CoverageLevel): string | undefined {
  if (callCoverage === "unsupported") return "Dynamic call output";
  if (effect.kind === "call-output") {
    return "Call output is not composed with the callee formal-to-actual write semantics";
  }
  return undefined;
}

function targetOperandsFromBinding(binding: ParameterBinding, ownerBlockKey: string): SymbolOperand[] {
  return collectValueSymbols(binding.actual)
    .filter((operand) => binding.targetSymbols.includes(operand.symbol))
    .map((operand) => symbolOperand(operand.symbol, operand.scope, ownerBlockKey));
}

class SclSemanticParser {
  private position = 0;

  constructor(
    private readonly tokens: CodeToken[],
    private readonly owner: BlockOwner,
    private readonly location: LocationSeed,
    private readonly accumulator: SemanticAccumulator,
    private readonly issues: string[]
  ) {}

  parse(guard: GuardExpression = TRUE_GUARD, controlContext: string[] = []): GuardExpression {
    return this.parseSequence(new Set(), guard, controlContext);
  }

  private word(offset = 0): string {
    const token = this.tokens[this.position + offset];
    return token?.kind === "token" ? normalizeOperator(token.text) : "";
  }

  private consumeWord(word: string): boolean {
    if (this.word() !== normalizeOperator(word)) return false;
    this.position += 1;
    return true;
  }

  private consumeSemicolon(): void {
    if (this.word() === ";") this.position += 1;
  }

  private takeUntilWord(word: string): CodeToken[] {
    const result: CodeToken[] = [];
    let depth = 0;
    while (this.position < this.tokens.length) {
      const token = this.tokens[this.position];
      if (depth === 0 && token.kind === "token" && normalizeOperator(token.text) === normalizeOperator(word)) break;
      result.push(token);
      depth += tokenDepthDelta(token);
      this.position += 1;
    }
    return result;
  }

  private takeStatement(): CodeToken[] {
    const result: CodeToken[] = [];
    let depth = 0;
    while (this.position < this.tokens.length) {
      const token = this.tokens[this.position];
      if (depth === 0 && isToken(token, ";")) {
        this.position += 1;
        break;
      }
      result.push(token);
      depth += tokenDepthDelta(token);
      this.position += 1;
    }
    return result;
  }

  private parseSequence(stops: Set<string>, startingGuard: GuardExpression, controlContext: string[]): GuardExpression {
    let guard = startingGuard;
    while (this.position < this.tokens.length) {
      const word = this.word();
      if (stops.has(word)) break;
      if (word === "IF") {
        guard = this.parseIf(guard, controlContext);
        continue;
      }
      if (word === "CASE") {
        guard = this.parseCase(guard, controlContext);
        continue;
      }
      if (word === "WHILE") {
        this.parseWhile(guard, controlContext);
        continue;
      }
      if (word === "FOR") {
        this.parseFor(guard, controlContext);
        continue;
      }
      if (word === "REPEAT") {
        this.parseRepeat(guard, controlContext);
        continue;
      }
      if (word === "RETURN" || word === "EXIT" || word === "CONTINUE") {
        const kind = word.toLowerCase() as ControlFlowSite["kind"];
        const order = nextOrder(this.accumulator);
        this.accumulator.controls.push({
          controlId: `${this.owner.blockKey}:N${this.location.network}:K${order}`,
          kind,
          guard,
          blockKey: this.owner.blockKey,
          network: this.location.network,
          statementOrder: order,
          xmlLine: this.location.xmlLine,
          controlContext
        });
        this.position += 1;
        this.takeStatement();
        if (kind === "return") guard = FALSE_GUARD;
        else this.issues.push(`SCL ${word} path merge is conservative in network ${this.location.network}`);
        continue;
      }
      if (/^END_(?:IF|CASE|WHILE|FOR|REPEAT)$/.test(word) || word === "ELSIF" || word === "ELSE" || word === "UNTIL") {
        this.issues.push(`Unexpected SCL control token ${word} in network ${this.location.network}`);
        this.position += 1;
        continue;
      }
      const before = this.position;
      const statement = this.takeStatement();
      if (statement.length > 0) this.processSimpleStatement(statement, guard, controlContext);
      if (this.position === before) this.position += 1;
    }
    return guard;
  }

  private parseIf(parentGuard: GuardExpression, controlContext: string[]): GuardExpression {
    this.consumeWord("IF");
    const firstTokens = this.takeUntilWord("THEN");
    if (!this.consumeWord("THEN")) {
      this.issues.push(`IF without THEN in SCL network ${this.location.network}`);
      return parentGuard;
    }
    let previous = guardFromTokens(firstTokens);
    const branchOutcomes: Array<{ entry: GuardExpression; fallthrough: GuardExpression }> = [];
    const firstEntry = andGuard(parentGuard, previous);
    const firstFallthrough = this.parseSequence(
      new Set(["ELSIF", "ELSE", "END_IF"]),
      firstEntry,
      [...controlContext, `IF ${renderTokens(firstTokens)}`]
    );
    branchOutcomes.push({ entry: firstEntry, fallthrough: firstFallthrough });
    while (this.consumeWord("ELSIF")) {
      const conditionTokens = this.takeUntilWord("THEN");
      if (!this.consumeWord("THEN")) {
        this.issues.push(`ELSIF without THEN in SCL network ${this.location.network}`);
        break;
      }
      const condition = guardFromTokens(conditionTokens);
      const entry = andGuard(parentGuard, notGuard(previous), condition);
      const fallthrough = this.parseSequence(
        new Set(["ELSIF", "ELSE", "END_IF"]),
        entry,
        [...controlContext, `ELSIF ${renderTokens(conditionTokens)}`]
      );
      branchOutcomes.push({ entry, fallthrough });
      previous = orGuard(previous, condition);
    }
    if (this.consumeWord("ELSE")) {
      const entry = andGuard(parentGuard, notGuard(previous));
      const fallthrough = this.parseSequence(
        new Set(["END_IF"]),
        entry,
        [...controlContext, "ELSE"]
      );
      branchOutcomes.push({ entry, fallthrough });
    } else {
      const noBranch = andGuard(parentGuard, notGuard(previous));
      branchOutcomes.push({ entry: noBranch, fallthrough: noBranch });
    }
    if (!this.consumeWord("END_IF")) this.issues.push(`IF without END_IF in SCL network ${this.location.network}`);
    this.consumeSemicolon();
    if (branchOutcomes.every((branch) => branch.entry === branch.fallthrough)) return parentGuard;
    return orGuard(...branchOutcomes.map((branch) => branch.fallthrough));
  }

  private parseWhile(parentGuard: GuardExpression, controlContext: string[]): void {
    this.consumeWord("WHILE");
    const conditionTokens = this.takeUntilWord("DO");
    if (!this.consumeWord("DO")) {
      this.issues.push(`WHILE without DO in SCL network ${this.location.network}`);
      return;
    }
    const condition = guardFromTokens(conditionTokens);
    const loop: GuardExpression = {
      kind: "loop",
      loop: "while",
      header: renderTokens(conditionTokens),
      condition
    };
    this.parseSequence(
      new Set(["END_WHILE"]),
      andGuard(parentGuard, loop),
      [...controlContext, `WHILE ${renderTokens(conditionTokens)}`]
    );
    if (!this.consumeWord("END_WHILE")) this.issues.push(`WHILE without END_WHILE in network ${this.location.network}`);
    this.consumeSemicolon();
  }

  private parseFor(parentGuard: GuardExpression, controlContext: string[]): void {
    this.consumeWord("FOR");
    const header = this.takeUntilWord("DO");
    if (!this.consumeWord("DO")) {
      this.issues.push(`FOR without DO in SCL network ${this.location.network}`);
      return;
    }
    this.processSimpleStatement(header, parentGuard, [...controlContext, "FOR initializer"]);
    const loop: GuardExpression = { kind: "loop", loop: "for", header: renderTokens(header) };
    this.parseSequence(
      new Set(["END_FOR"]),
      andGuard(parentGuard, loop),
      [...controlContext, `FOR ${renderTokens(header)}`]
    );
    if (!this.consumeWord("END_FOR")) this.issues.push(`FOR without END_FOR in network ${this.location.network}`);
    this.consumeSemicolon();
    this.issues.push(`FOR iteration count retained conservatively in network ${this.location.network}`);
  }

  private findMatchingUntil(): { until: number; end: number } | null {
    let depth = 0;
    let until = -1;
    for (let index = this.position; index < this.tokens.length; index += 1) {
      const token = this.tokens[index];
      const word = token.kind === "token" ? normalizeOperator(token.text) : "";
      if (word === "REPEAT") depth += 1;
      if (word === "END_REPEAT") {
        if (depth === 0 && until >= 0) return { until, end: index };
        depth = Math.max(0, depth - 1);
      }
      if (word === "UNTIL" && depth === 0 && until < 0) until = index;
    }
    return null;
  }

  private parseRepeat(parentGuard: GuardExpression, controlContext: string[]): void {
    this.consumeWord("REPEAT");
    const match = this.findMatchingUntil();
    if (!match) {
      this.issues.push(`REPEAT without matching UNTIL/END_REPEAT in network ${this.location.network}`);
      return;
    }
    const body = this.tokens.slice(this.position, match.until);
    const conditionTokens = this.tokens.slice(match.until + 1, match.end);
    const condition = guardFromTokens(conditionTokens);
    const loop: GuardExpression = {
      kind: "loop",
      loop: "repeat",
      header: renderTokens(conditionTokens),
      condition: notGuard(condition),
      atLeastOnce: true
    };
    new SclSemanticParser(body, this.owner, this.location, this.accumulator, this.issues)
      .parse(andGuard(parentGuard, loop), [...controlContext, `REPEAT UNTIL ${renderTokens(conditionTokens)}`]);
    this.position = match.end + 1;
    this.consumeSemicolon();
    this.issues.push(`REPEAT first-iteration and repeated-path effects are represented conservatively in network ${this.location.network}`);
  }

  private findMatchingEndCase(): number {
    let depth = 0;
    for (let index = this.position; index < this.tokens.length; index += 1) {
      const token = this.tokens[index];
      const word = token.kind === "token" ? normalizeOperator(token.text) : "";
      if (word === "CASE") depth += 1;
      if (word === "END_CASE") {
        if (depth === 0) return index;
        depth -= 1;
      }
    }
    return -1;
  }

  private parseCase(parentGuard: GuardExpression, controlContext: string[]): GuardExpression {
    this.consumeWord("CASE");
    const selectorTokens = this.takeUntilWord("OF");
    if (!this.consumeWord("OF")) {
      this.issues.push(`CASE without OF in SCL network ${this.location.network}`);
      return parentGuard;
    }
    const end = this.findMatchingEndCase();
    if (end < 0) {
      this.issues.push(`CASE without END_CASE in SCL network ${this.location.network}`);
      return parentGuard;
    }
    const body = this.tokens.slice(this.position, end);
    const selector = valueFromTokens(selectorTokens);
    const branches = splitCaseBranches(body);
    const branchOutcomes: Array<{ entry: GuardExpression; fallthrough: GuardExpression }> = [];
    let hasElse = false;
    if (branches.length === 0) {
      this.issues.push(`CASE branches could not be resolved in network ${this.location.network}`);
    } else {
      const branchGuards: GuardExpression[] = [];
      for (const branch of branches) {
        if (branch.isElse) {
          hasElse = true;
          const entry = andGuard(parentGuard, notGuard(orGuard(...branchGuards)));
          const fallthrough = new SclSemanticParser(branch.body, this.owner, this.location, this.accumulator, this.issues)
            .parse(entry, [...controlContext, "CASE ELSE"]);
          branchOutcomes.push({ entry, fallthrough });
          continue;
        }
        const labelExpressions = splitByIndexes(branch.labels, topLevelOperatorIndexes(branch.labels, [","]))
          .filter((tokens) => tokens.length > 0)
          .map((tokens): GuardExpression => ({
            kind: "compare",
            operator: "=",
            left: selector,
            right: valueFromTokens(tokens)
          }));
        const branchGuard = orGuard(...labelExpressions);
        branchGuards.push(branchGuard);
        const entry = andGuard(parentGuard, branchGuard);
        const fallthrough = new SclSemanticParser(branch.body, this.owner, this.location, this.accumulator, this.issues)
          .parse(entry, [...controlContext, `CASE ${renderTokens(branch.labels)}`]);
        branchOutcomes.push({ entry, fallthrough });
      }
      if (!hasElse) {
        const noBranch = andGuard(parentGuard, notGuard(orGuard(...branchGuards)));
        branchOutcomes.push({ entry: noBranch, fallthrough: noBranch });
      }
    }
    this.position = end + 1;
    this.consumeSemicolon();
    if (branchOutcomes.length === 0) return parentGuard;
    if (branchOutcomes.every((branch) => branch.entry === branch.fallthrough)) return parentGuard;
    return orGuard(...branchOutcomes.map((branch) => branch.fallthrough));
  }

  private processSimpleStatement(statement: CodeToken[], guard: GuardExpression, controlContext: string[]): void {
    const meaningful = statement.filter((token) => tokenText(token).trim() !== "");
    if (meaningful.length === 0) return;
    for (const token of meaningful) {
      if (token.kind === "call") this.emitCall(token.call, guard, controlContext);
    }
    const assignmentIndex = meaningful.findIndex(
      (token) => token.kind === "token" && [":=", "+=", "-=", "*=", "/="].includes(token.text.trim())
    );
    if (assignmentIndex < 0) return;
    const targetToken = [...meaningful.slice(0, assignmentIndex)]
      .reverse()
      .find((token): token is Extract<CodeToken, { kind: "access" }> => token.kind === "access");
    if (!targetToken) {
      this.issues.push(`SCL assignment target unresolved: ${renderTokens(meaningful)}`);
      return;
    }
    const operator = tokenText(meaningful[assignmentIndex]);
    const rhsTokens = meaningful.slice(assignmentIndex + 1);
    const value = valueFromTokens(rhsTokens);
    const coverage: CoverageLevel = value.kind === "unknown" ? "conservative" : "exact";
    const effect: WriteEffect = {
      kind: "assign",
      value,
      readBeforeWrite: operator !== ":="
    };
    const site = makeWriteSite(
      this.owner,
      this.location,
      this.accumulator,
      targetToken.operand,
      effect,
      guard,
      controlContext,
      coverage,
      [value, ...(operator !== ":=" ? [{ kind: "symbol", ...targetToken.operand } as ValueExpression] : [])],
      value.kind === "unknown" ? value.reason : undefined
    );
    this.accumulator.writes.push(site);
  }

  private emitCall(call: ParsedCall, guard: GuardExpression, controlContext: string[]): void {
    const en = bindingValue(call, "EN");
    const callGuard = en ? andGuard(guard, valueAsGuard(en, "Call EN is not proven Boolean")) : guard;
    const unknownBinding = call.parameters.some((binding) => binding.direction === "unknown");
    const coverage: CoverageLevel = call.name === "<dynamic-call>" ? "unsupported" : unknownBinding ? "conservative" : "exact";
    this.accumulator.calls.push(makeCallSite(
      this.owner,
      this.location,
      this.accumulator,
      call,
      callGuard,
      controlContext,
      coverage,
      coverage === "unsupported" ? "Dynamic SCL call target" : unknownBinding ? "Unknown parameter direction" : undefined
    ));
    for (const binding of call.parameters) {
      if (binding.direction !== "output" && binding.direction !== "inout") continue;
      const targets = targetOperandsFromBinding(binding, this.owner.blockKey);
      if (targets.length === 0) {
        this.issues.push(`Output ${call.name}.${binding.name} has no direct symbol target in network ${this.location.network}`);
        continue;
      }
      for (const target of targets) {
        const effect = effectForCallOutput(call, binding);
        const outputCoverage = coverageForCallOutput(effect, coverage);
        this.accumulator.writes.push(makeWriteSite(
          this.owner,
          this.location,
          this.accumulator,
          target,
          effect,
          callGuard,
          controlContext,
          outputCoverage,
          [
            ...(binding.direction === "inout" ? [binding.actual] : []),
            ...Object.values(callInputMap(call))
          ],
          reasonForCallOutput(effect, coverage)
        ));
      }
    }
  }
}

type CaseBranch = { labels: CodeToken[]; body: CodeToken[]; isElse: boolean };

function splitCaseBranches(tokens: CodeToken[]): CaseBranch[] {
  const headers: Array<{ start: number; colon: number }> = [];
  let elseIndex = -1;
  let depth = 0;
  let candidateStart = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const word = token.kind === "token" ? normalizeOperator(token.text) : "";
    if (["IF", "CASE", "WHILE", "FOR", "REPEAT"].includes(word)) depth += 1;
    if (/^END_(?:IF|CASE|WHILE|FOR|REPEAT)$/.test(word)) depth = Math.max(0, depth - 1);
    if (depth !== 0) continue;
    if (word === "ELSE") {
      elseIndex = index;
      break;
    }
    if (isToken(token, ":")) {
      const labels = tokens.slice(candidateStart, index);
      if (looksLikeCaseLabels(labels)) {
        headers.push({ start: candidateStart, colon: index });
      }
    }
    if (isToken(token, ";")) candidateStart = index + 1;
  }

  const branches: CaseBranch[] = [];
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    const end = headers[index + 1]?.start ?? (elseIndex >= 0 ? elseIndex : tokens.length);
    branches.push({
      labels: tokens.slice(header.start, header.colon),
      body: tokens.slice(header.colon + 1, end),
      isElse: false
    });
  }
  if (elseIndex >= 0) branches.push({ labels: [], body: tokens.slice(elseIndex + 1), isElse: true });
  return branches;
}

function looksLikeCaseLabels(tokens: CodeToken[]): boolean {
  if (tokens.length === 0) return false;
  return tokens.every((token) => {
    if (token.kind === "access") return true;
    if (token.kind !== "token") return false;
    return /^(?:,|\.\.|[-+]?\d+(?:\.\d+)?|'[^']*'|[A-Za-z_][A-Za-z0-9_]*)$/.test(token.text.trim());
  });
}

type FlgPart = {
  uid: string;
  name: string;
  negatedPins: Set<string>;
  // A typed part (<TemplateValue Name="SrcType">): And/Or/Xor with a SrcType are word-logic instructions
  // (tDw := a AND 16#FF000000), not Boolean gates, whose names are A/O/X.
  srcType?: boolean;
  // DisabledENO="true": the box does not evaluate ENO, so ENO is its EN.
  disabledEno?: boolean;
};

type FlgEndpoint =
  | { kind: "powerrail" }
  | { kind: "open" }
  | { kind: "ident"; uid: string }
  | { kind: "pin"; uid: string; pin: string };

type FlgWire = {
  uid: string;
  endpoints: FlgEndpoint[];
};

function normalizedPartName(name: string): string {
  const normalized = name.replace(/[^A-Za-z0-9_]/g, "").toUpperCase();
  return normalized === "O" ? "OR" : normalized === "A" ? "AND" : normalized;
}

function isContact(part: FlgPart): boolean {
  return /CONTACT|NORMALLYOPEN|NORMALLYCLOSED/.test(normalizedPartName(part.name));
}

function isCoil(part: FlgPart): boolean {
  return /COIL/.test(normalizedPartName(part.name));
}

function isBooleanPart(part: FlgPart): boolean {
  return !part.srcType && /^(?:AND|OR|NOT|XOR)(?:BOX|GATE)?$/.test(normalizedPartName(part.name));
}

function compareOperator(part: FlgPart): string | null {
  // Whole names only: a prefix match would read GET as GE, LEN/LEFT as LE and NEG as NE.
  const name = normalizedPartName(part.name);
  if (/^(?:EQ|EQUAL|COMPAREEQ)$/.test(name)) return "=";
  if (/^(?:NE|NOTEQUAL|COMPAREN[EO])$/.test(name)) return "<>";
  if (/^(?:GE|GREATEREQUAL|COMPAREGE)$/.test(name)) return ">=";
  if (/^(?:GT|GREATER|COMPAREGT)$/.test(name)) return ">";
  if (/^(?:LE|LESSEQUAL|COMPARELE)$/.test(name)) return "<=";
  if (/^(?:LT|LESS|COMPARELT)$/.test(name)) return "<";
  return null;
}

function edgeKind(part: FlgPart): "rising" | "falling" | null {
  const name = normalizedPartName(part.name);
  if (/^(?:PCONTACT|PBOX|PEDGE|POSEDGE|POSITIVEEDGE|RTRIG|R_TRIG)/.test(name)) return "rising";
  if (/^(?:NCONTACT|NBOX|NEDGE|NEGEDGE|NEGATIVEEDGE|FTRIG|F_TRIG)/.test(name)) return "falling";
  return null;
}

// Parts with their own Boolean meaning; every other Part is an instruction box handled like a call.
function isLogicPart(part: FlgPart): boolean {
  return isContact(part) || isCoil(part) || isBooleanPart(part) || compareOperator(part) !== null || edgeKind(part) !== null;
}

function coilMode(part: FlgPart): "normal" | "set" | "reset" {
  const name = normalizedPartName(part.name);
  if (/^(?:SCOIL|SETCOIL)/.test(name)) return "set";
  if (/^(?:RCOIL|RESETCOIL)/.test(name)) return "reset";
  return "normal";
}

function pinKey(uid: string, pin: string): string {
  return `${uid}:${pin.toLowerCase()}`;
}

function guardHasUnknown(guard: GuardExpression): boolean {
  switch (guard.kind) {
    case "unknown":
      return true;
    case "not":
      return guardHasUnknown(guard.operand);
    case "and":
    case "or":
      return guard.operands.some(guardHasUnknown);
    case "compare":
      return guard.left.kind === "unknown" || guard.right.kind === "unknown";
    case "edge":
      return guardHasUnknown(guard.operand);
    case "loop":
      return !guard.condition || guardHasUnknown(guard.condition);
    default:
      return false;
  }
}

function analyzeFlgNet(
  flgNet: OrderedElement,
  owner: BlockOwner,
  location: LocationSeed,
  accumulator: SemanticAccumulator,
  conditionOutputs?: GuardExpression[]
): void {
  const issues: string[] = [];
  const parts = new Map<string, FlgPart>();
  const accesses = new Map<string, AccessSemantic>();
  const calls = new Map<string, ParsedCall>();
  const executableOrder: string[] = [];
  const partInstances = new Map<string, string | undefined>();
  const wires: FlgWire[] = [];
  const partsNode = firstDescendant(flgNet, "Parts");
  if (!partsNode) {
    accumulator.networks.push({
      network: location.network,
      sourceKind: "LAD_FBD",
      level: "unsupported",
      writeSites: 0,
      callSites: 0,
      issues: ["FlgNet has no Parts element"]
    });
    return;
  }

  for (const child of directChildren(partsNode)) {
    const name = elementName(child).toLowerCase();
    if (name === "access") {
      const access = parseAccess(child, owner.blockKey);
      if (access.uid) accesses.set(access.uid, access);
    } else if (name === "part") {
      const uid = attribute(child, "UId");
      if (!uid) continue;
      const negatedPins = new Set(
        directChildren(child, "Negated")
          .map((node) => attribute(node, "Name").toLowerCase())
          .filter(Boolean)
      );
      const srcType = directChildren(child, "TemplateValue").some((node) => attribute(node, "Name") === "SrcType");
      const disabledEno = attribute(child, "DisabledENO").toLowerCase() === "true";
      parts.set(uid, { uid, name: attribute(child, "Name"), negatedPins, srcType, disabledEno });
      const instanceNode = directChildren(child, "Instance")[0];
      if (instanceNode) partInstances.set(uid, parseInstance(instanceNode));
      executableOrder.push(uid);
    } else if (name === "call") {
      const callInfo = directChildren(child, "CallInfo")[0] ?? firstDescendant(child, "CallInfo");
      const uid = attribute(child, "UId");
      if (!callInfo || !uid) {
        issues.push("Call without CallInfo or UId");
        continue;
      }
      const call = parseCallInfo(callInfo, owner.blockKey, uid);
      call.uid = uid;
      calls.set(uid, call);
      executableOrder.push(uid);
    }
  }

  const wiresNode = firstDescendant(flgNet, "Wires");
  if (wiresNode) {
    for (const wireNode of directChildren(wiresNode, "Wire")) {
      const endpoints: FlgEndpoint[] = [];
      for (const endpoint of directChildren(wireNode)) {
        const name = elementName(endpoint).toLowerCase();
        if (name === "powerrail") endpoints.push({ kind: "powerrail" });
        else if (name === "openbranch" || name === "opencon") endpoints.push({ kind: "open" });
        else if (name === "identcon") endpoints.push({ kind: "ident", uid: attribute(endpoint, "UId") });
        else if (name === "namecon") {
          endpoints.push({ kind: "pin", uid: attribute(endpoint, "UId"), pin: attribute(endpoint, "Name") });
        }
      }
      wires.push({ uid: attribute(wireNode, "UId"), endpoints });
    }
  }

  // Instruction boxes become calls. A pin is an output when a wire starts at it (SimaticML lists a wire's
  // source first) and an input otherwise; EN/ENO are added by bindFlgCall like for block calls.
  for (const part of [...parts.values()]) {
    if (isLogicPart(part)) continue;
    const directions = new Map<string, ParameterDirection>();
    for (const wire of wires) {
      wire.endpoints.forEach((endpoint, index) => {
        if (endpoint.kind !== "pin" || endpoint.uid !== part.uid || /^(?:en|eno)$/i.test(endpoint.pin)) return;
        // A later "out" end is a second driver on the wire (a join), never an input: no input pin has that name.
        if (index === 0 || /^out$/i.test(endpoint.pin)) directions.set(endpoint.pin, "output");
        // "operand" is the instruction's own InOut (SR/RS memory, INC/DEC variable): read and written.
        else if (/^operand$/i.test(endpoint.pin)) directions.set(endpoint.pin, "inout");
        else if (!directions.has(endpoint.pin)) directions.set(endpoint.pin, "input");
      });
    }
    const parameters: ParameterBinding[] = [...directions].map(([name, direction]) => ({
      name,
      section: direction === "output" ? "Output" : "Input",
      direction,
      actual: { kind: "unknown", text: "", reason: "Bound from wiring", symbols: [] },
      sourceSymbols: [],
      targetSymbols: []
    }));
    calls.set(part.uid, {
      uid: part.uid, name: part.name, blockType: INSTRUCTION_KIND, instance: partInstances.get(part.uid), parameters, instruction: true,
      disabledEno: part.disabledEno
    });
    parts.delete(part.uid);
  }

  const wiresByPin = new Map<string, FlgWire[]>();
  for (const wire of wires) {
    for (const endpoint of wire.endpoints) {
      if (endpoint.kind !== "pin") continue;
      const key = pinKey(endpoint.uid, endpoint.pin);
      const existing = wiresByPin.get(key) ?? [];
      existing.push(wire);
      wiresByPin.set(key, existing);
    }
  }

  const pinNames = (uid: string): string[] => unique(
    wires.flatMap((wire) => wire.endpoints)
      .filter((endpoint): endpoint is Extract<FlgEndpoint, { kind: "pin" }> => endpoint.kind === "pin" && endpoint.uid === uid)
      .map((endpoint) => endpoint.pin)
  );

  // Several wires on one pin (a parallel join written as separate wires) act as one wire with all their
  // ends: Boolean drivers are ORed, two data drivers stay an explicit "multiple data drivers" unknown.
  const wireForPin = (uid: string, pin: string): FlgWire | undefined =>
    mergedPinWire(wiresByPin.get(pinKey(uid, pin)));

  const accessValuesOnWire = (wire: FlgWire | undefined): AccessSemantic[] => {
    if (!wire) return [];
    return wire.endpoints
      .filter((endpoint): endpoint is Extract<FlgEndpoint, { kind: "ident" }> => endpoint.kind === "ident")
      .map((endpoint) => accesses.get(endpoint.uid))
      .filter((value): value is AccessSemantic => value !== undefined);
  };

  const symbolsOnWire = (wire: FlgWire | undefined): SymbolOperand[] =>
    accessValuesOnWire(wire).flatMap((access) => access.symbol ? [access.symbol] : []);

  const isOutputPin = (uid: string, pin: string): boolean => {
    const part = parts.get(uid);
    const lowerPin = pin.toLowerCase();
    if (part) {
      if (isContact(part) || isBooleanPart(part) || compareOperator(part) || edgeKind(part)) return /^(?:out|eno|q)$/.test(lowerPin);
      if (isCoil(part)) return false;
      return /^(?:out\d*|eno|q|qu|qd|cv|et)$/.test(lowerPin);
    }
    const call = calls.get(uid);
    if (call) {
      const binding = call.parameters.find((item) => item.name.toLowerCase() === lowerPin);
      return binding?.direction === "output" || binding?.direction === "inout" || lowerPin === "eno";
    }
    return false;
  };

  const wireValueCache = new Map<string, ValueExpression>();
  const outputValueCache = new Map<string, ValueExpression>();
  const wireGuardCache = new Map<string, GuardExpression>();
  const outputGuardCache = new Map<string, GuardExpression>();

  const valueForWire = (wire: FlgWire | undefined, visiting = new Set<string>()): ValueExpression => {
    if (!wire) return { kind: "unknown", text: "", reason: "Pin is not wired", symbols: [] };
    const cached = wireValueCache.get(wire.uid);
    if (cached) return cached;
    if (visiting.has(wire.uid)) return { kind: "unknown", text: wire.uid, reason: "FlgNet value cycle", symbols: [] };
    const next = new Set(visiting).add(wire.uid);
    const direct = accessValuesOnWire(wire).map((access) => access.value);
    const outputs = wire.endpoints
      .filter((endpoint): endpoint is Extract<FlgEndpoint, { kind: "pin" }> => endpoint.kind === "pin" && isOutputPin(endpoint.uid, endpoint.pin))
      .map((endpoint) => valueForOutput(endpoint.uid, endpoint.pin, next));
    const candidates = [...outputs, ...direct];
    let result: ValueExpression;
    if (candidates.length === 0) result = { kind: "unknown", text: wire.uid, reason: "Wire has no value driver", symbols: [] };
    else if (candidates.length === 1) result = candidates[0];
    else {
      result = {
        kind: "unknown",
        text: candidates.map((candidate) => JSON.stringify(candidate)).join(" | "),
        reason: "Wire has multiple data drivers",
        symbols: candidates.flatMap(collectValueSymbols)
      };
    }
    wireValueCache.set(wire.uid, result);
    return result;
  };

  const valueForOutput = (uid: string, pin: string, visiting = new Set<string>()): ValueExpression => {
    const key = pinKey(uid, pin);
    const cached = outputValueCache.get(key);
    if (cached) return cached;
    const part = parts.get(uid);
    const call = calls.get(uid);
    let result: ValueExpression;
    if (part) {
      const operator = compareOperator(part) || normalizedPartName(part.name);
      const inputs = pinNames(uid)
        .filter((name) => !isOutputPin(uid, name) && !/^(?:in|en|operand|bit)$/.test(name.toLowerCase()))
        .map((name) => valueForWire(wireForPin(uid, name), visiting));
      result = {
        kind: "operation",
        operator,
        operands: inputs,
        text: `${part.name}.${pin}`
      };
    } else if (call) {
      result = { kind: "call-result", callee: call.name, output: pin, instance: call.instance };
    } else {
      result = { kind: "unknown", text: `${uid}.${pin}`, reason: "Unknown FlgNet output owner", symbols: [] };
    }
    outputValueCache.set(key, result);
    return result;
  };

  const guardForWire = (wire: FlgWire | undefined, visiting = new Set<string>()): GuardExpression => {
    if (!wire) return { kind: "unknown", text: "", reason: "Boolean pin is not wired", symbols: [] };
    const cached = wireGuardCache.get(wire.uid);
    if (cached) return cached;
    if (visiting.has(wire.uid)) return { kind: "unknown", text: wire.uid, reason: "FlgNet Boolean cycle", symbols: [] };
    const next = new Set(visiting).add(wire.uid);
    const candidates: GuardExpression[] = [];
    if (wire.endpoints.some((endpoint) => endpoint.kind === "powerrail")) candidates.push(TRUE_GUARD);
    for (const endpoint of wire.endpoints) {
      if (endpoint.kind === "pin" && isOutputPin(endpoint.uid, endpoint.pin)) {
        candidates.push(guardForOutput(endpoint.uid, endpoint.pin, next));
      }
    }
    if (candidates.length === 0) {
      for (const access of accessValuesOnWire(wire)) candidates.push(valueAsGuard(access.value));
    }
    const result = candidates.length > 0
      ? orGuard(...candidates)
      : { kind: "unknown", text: wire.uid, reason: "Wire has no Boolean driver", symbols: [] } as GuardExpression;
    wireGuardCache.set(wire.uid, result);
    return result;
  };

  const applyPinNegation = (part: FlgPart, pin: string, guard: GuardExpression): GuardExpression =>
    part.negatedPins.has(pin.toLowerCase()) ? notGuard(guard) : guard;

  const guardForOutput = (uid: string, pin: string, visiting = new Set<string>()): GuardExpression => {
    const key = pinKey(uid, pin);
    const cached = outputGuardCache.get(key);
    if (cached) return cached;
    const part = parts.get(uid);
    const call = calls.get(uid);
    let result: GuardExpression;
    if (part && isContact(part) && !edgeKind(part)) {
      const inputPin = pinNames(uid).find((name) => /^in$/i.test(name));
      const operandPin = pinNames(uid).find((name) => /^(?:operand|bit)$/i.test(name));
      const power = inputPin ? guardForWire(wireForPin(uid, inputPin), visiting) : TRUE_GUARD;
      let condition = operandPin
        ? valueAsGuard(valueForWire(wireForPin(uid, operandPin), visiting), "Contact operand is not proven Boolean")
        : { kind: "unknown", text: part.name, reason: "Contact operand pin missing", symbols: [] } as GuardExpression;
      condition = applyPinNegation(part, operandPin ?? "operand", condition);
      if (/NORMALLYCLOSED/.test(normalizedPartName(part.name)) && !part.negatedPins.has((operandPin ?? "operand").toLowerCase())) {
        condition = notGuard(condition);
      }
      result = applyPinNegation(part, pin, andGuard(power, condition));
    } else if (part && isBooleanPart(part)) {
      const inputs = pinNames(uid)
        .filter((name) => !isOutputPin(uid, name))
        .map((name) => applyPinNegation(part, name, guardForWire(wireForPin(uid, name), visiting)));
      const name = normalizedPartName(part.name);
      if (name.startsWith("AND")) result = andGuard(...inputs);
      else if (name.startsWith("OR")) result = orGuard(...inputs);
      else if (name.startsWith("NOT")) result = notGuard(inputs[0] ?? { kind: "unknown", text: part.name, reason: "NOT input missing", symbols: [] });
      else result = { kind: "unknown", text: part.name, reason: "XOR topology retained conservatively", symbols: inputs.flatMap(collectGuardSymbols) };
      result = applyPinNegation(part, pin, result);
    } else if (part && compareOperator(part)) {
      const dataPins = pinNames(uid).filter((name) => !isOutputPin(uid, name) && !/^(?:in|en|pre)$/i.test(name));
      const powerPin = pinNames(uid).find((name) => /^(?:in|en|pre)$/i.test(name));
      const comparison: GuardExpression = dataPins.length >= 2
        ? {
            kind: "compare",
            operator: compareOperator(part) ?? "?",
            left: valueForWire(wireForPin(uid, dataPins[0]), visiting),
            right: valueForWire(wireForPin(uid, dataPins[1]), visiting)
          }
        : { kind: "unknown", text: part.name, reason: "Comparison operands missing", symbols: [] };
      result = andGuard(powerPin ? guardForWire(wireForPin(uid, powerPin), visiting) : TRUE_GUARD, comparison);
      result = applyPinNegation(part, pin, result);
    } else if (part && edgeKind(part)) {
      // V20 wires P/N contacts as pre (power), operand (signal) and bit (edge memory), bit first.
      // An FBD P_TRIG/N_TRIG box (PBox/NBox) takes its signal on "in" and has no power input.
      const edgeBox = /^[PN]BOX$/.test(normalizedPartName(part.name));
      const operandPin = edgeBox
        ? pinNames(uid).find((name) => /^in$/i.test(name))
        : pinNames(uid).find((name) => /^operand$/i.test(name)) ?? pinNames(uid).find((name) => /^in1$/i.test(name));
      const powerPin = edgeBox ? undefined : pinNames(uid).find((name) => /^(?:in|en|pre)$/i.test(name));
      const memoryPin = pinNames(uid).find((name) => /^(?:bit|memory|m|bitmemory)$/i.test(name));
      const operand = operandPin
        ? guardForWire(wireForPin(uid, operandPin), visiting)
        : { kind: "unknown", text: part.name, reason: "Edge operand missing", symbols: [] } as GuardExpression;
      const memory = memoryPin ? symbolsOnWire(wireForPin(uid, memoryPin))[0] : undefined;
      result = andGuard(
        powerPin ? guardForWire(wireForPin(uid, powerPin), visiting) : TRUE_GUARD,
        { kind: "edge", edge: edgeKind(part) ?? "rising", operand, memory }
      );
    } else if (call) {
      const parameters = bindFlgCall(call, wiresByPin, accesses, owner.blockKey);
      const inputs = Object.fromEntries(
        parameters.filter((binding) => binding.direction === "input" || binding.direction === "inout")
          .map((binding) => [binding.name, binding.actual])
      );
      const instruction = call.name.toUpperCase();
      if (/^eno$/i.test(pin)) {
        // ENO equals EN only for moves, which cannot fail; elsewhere (DIV by zero, overflow, an FB setting
        // ENO) it is EN and an unknown.
        const enWire = wireForPin(uid, "en");
        const enable = enWire ? guardForWire(enWire, visiting) : TRUE_GUARD;
        result = instruction === "MOVE" || call.disabledEno
          ? enable
          : andGuard(enable, { kind: "unknown", text: `${call.name}.ENO`, reason: "ENO of an instruction that can fail", symbols: [] });
      } else if (["TON", "TOF", "TONR", "TP"].includes(instruction) || /^(?:CTU|CTD|CTUD)/.test(instruction)) {
        result = { kind: "stateful", instruction, instance: call.instance, output: pin, inputs };
      } else {
        result = {
          kind: "unknown",
          text: `${call.name}.${pin}`,
          reason: "User/instruction call output requires callee semantics",
          symbols: Object.values(inputs).flatMap(collectValueSymbols)
        };
      }
    } else {
      result = { kind: "unknown", text: `${uid}.${pin}`, reason: "Unsupported FlgNet part", symbols: [] };
      if (part) issues.push(`Unsupported FlgNet part ${part.name} in network ${location.network}`);
    }
    outputGuardCache.set(key, result);
    return result;
  };

  const startWriteCount = accumulator.writes.length;
  const startCallCount = accumulator.calls.length;
  const startStatementOrder = accumulator.nextOrder;
  const emittedUid = new Map<WriteSite | CallSite, string>();

  for (const part of parts.values()) {
    if (!isCoil(part)) continue;
    const operandPin = pinNames(part.uid).find((name) => /^(?:operand|bit|out)$/i.test(name));
    const inputPin = pinNames(part.uid).find((name) => /^(?:in|en)$/i.test(name));
    const targets = operandPin ? symbolsOnWire(wireForPin(part.uid, operandPin)) : [];
    let guard = inputPin
      ? guardForWire(wireForPin(part.uid, inputPin))
      : { kind: "unknown", text: part.name, reason: "Coil input pin missing", symbols: [] } as GuardExpression;
    if (part.negatedPins.has((operandPin ?? "operand").toLowerCase())) guard = notGuard(guard);
    if (conditionOutputs && /^(?:TRCOIL|ILCOIL|SVCOIL)$/.test(normalizedPartName(part.name))) {
      conditionOutputs.push(guard);
      continue;
    }
    if (targets.length === 0) {
      issues.push(`Coil ${part.name} has no direct target symbol`);
      continue;
    }
    const coverage: CoverageLevel = guardHasUnknown(guard) ? "conservative" : "exact";
    for (const target of targets) {
      const write = makeWriteSite(
        owner,
        location,
        accumulator,
        target,
        { kind: "coil", mode: coilMode(part), energizeWhen: guard },
        guard,
        [],
        coverage,
        [],
        coverage === "conservative" ? "Coil guard contains unresolved topology" : undefined
      );
      accumulator.writes.push(write);
      emittedUid.set(write, part.uid);
    }
  }

  for (const originalCall of calls.values()) {
    const directBindings = bindFlgCall(originalCall, wiresByPin, accesses, owner.blockKey);
    const call: ParsedCall = {
      ...originalCall,
      parameters: directBindings.map((binding) => {
        if (binding.direction !== "input") return binding;
        const actual = valueForWire(wireForPin(originalCall.uid, binding.name));
        return {
          ...binding,
          actual,
          sourceSymbols: collectValueSymbols(actual).map((operand) => operand.symbol)
        };
      })
    };
    // An instruction's "in"/"IN" is data (MOVE, TON), never its enable.
    const enWire = wireForPin(call.uid, "EN") ?? (call.instruction ? undefined : wireForPin(call.uid, "in"));
    const callGuard = enWire ? guardForWire(enWire) : TRUE_GUARD;
    const unresolvedDirection = call.parameters.some((binding) => binding.direction === "unknown");
    const callCoverage: CoverageLevel = call.name === "<dynamic-call>"
      ? "unsupported"
      : unresolvedDirection || guardHasUnknown(callGuard) ? "conservative" : "exact";
    const callSite = makeCallSite(
      owner,
      location,
      accumulator,
      call,
      callGuard,
      [],
      callCoverage,
      callCoverage === "unsupported"
        ? "Dynamic LAD/FBD call target"
        : unresolvedDirection
          ? "Unknown call parameter direction"
          : guardHasUnknown(callGuard)
            ? "Call enable topology unresolved"
            : undefined
    );
    accumulator.calls.push(callSite);
    emittedUid.set(callSite, originalCall.uid);
    for (const binding of call.parameters) {
      if (binding.direction !== "output" && binding.direction !== "inout") continue;
      const targets = targetOperandsFromBinding(binding, owner.blockKey);
      if (targets.length === 0) {
        // An output wired into another part (an ENO chain, a box feeding a coil) is followed there.
        const feedsPart = (wiresByPin.get(pinKey(call.uid, binding.name)) ?? []).some((wire) =>
          wire.endpoints.some((end) => end.kind === "pin" && !(end.uid === call.uid && end.pin.toLowerCase() === binding.name.toLowerCase())));
        if (!feedsPart) issues.push(`Output ${call.name}.${binding.name} has no direct target symbol`);
        continue;
      }
      for (const target of targets) {
        const effect = effectForCallOutput(call, binding);
        const outputCoverage = coverageForCallOutput(effect, callCoverage);
        const write = makeWriteSite(
          owner,
          location,
          accumulator,
          target,
          effect,
          callGuard,
          [],
          outputCoverage,
          [
            ...(binding.direction === "inout" ? [binding.actual] : []),
            ...Object.values(callInputMap(call))
          ],
          reasonForCallOutput(effect, callCoverage)
        );
        accumulator.writes.push(write);
        emittedUid.set(write, originalCall.uid);
      }
    }
  }

  const orderByUid = new Map(executableOrder.map((uid, index) => [uid, index]));
  const orderedItems = [
    ...accumulator.writes.slice(startWriteCount),
    ...accumulator.calls.slice(startCallCount)
  ].sort((left, right) => {
    const leftOrder = orderByUid.get(emittedUid.get(left) ?? "") ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = orderByUid.get(emittedUid.get(right) ?? "") ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.statementOrder - right.statementOrder;
  });
  for (let index = 0; index < orderedItems.length; index += 1) {
    const item = orderedItems[index];
    item.statementOrder = startStatementOrder + index + 1;
    if ("siteId" in item) item.siteId = `${owner.blockKey}:N${location.network}:W${item.statementOrder}`;
    else item.callId = `${owner.blockKey}:N${location.network}:C${item.statementOrder}`;
  }
  accumulator.nextOrder = startStatementOrder + orderedItems.length;
  accumulator.writes.splice(
    startWriteCount,
    accumulator.writes.length - startWriteCount,
    ...accumulator.writes.slice(startWriteCount).sort((left, right) => left.statementOrder - right.statementOrder)
  );
  accumulator.calls.splice(
    startCallCount,
    accumulator.calls.length - startCallCount,
    ...accumulator.calls.slice(startCallCount).sort((left, right) => left.statementOrder - right.statementOrder)
  );
  const sideEffectOwners = executableOrder.filter((uid) => isCoil(parts.get(uid) ?? { uid, name: "", negatedPins: new Set() }) || calls.has(uid));
  if (sideEffectOwners.length > 1) {
    issues.push("Multiple LAD/FBD side effects are ordered by SimaticML Parts serialization; compiled scheduling is not independently proven");
  }

  const networkSites = [
    ...accumulator.writes.slice(startWriteCount),
    ...accumulator.calls.slice(startCallCount)
  ];
  if (networkSites.length === 0 && (parts.size > 0 || calls.size > 0)) {
    issues.push("No supported write or call effect was resolved from this FlgNet");
  }
  accumulator.networks.push({
    network: location.network,
    sourceKind: "LAD_FBD",
    level: networkSites.length === 0 && (parts.size > 0 || calls.size > 0)
      ? "unsupported"
      : issueCoverage(issues, networkSites),
    writeSites: accumulator.writes.length - startWriteCount,
    callSites: accumulator.calls.length - startCallCount,
    issues: unique(issues)
  });
}

const mergedPinWires = new WeakMap<FlgWire[], FlgWire>();

function mergedPinWire(list: FlgWire[] | undefined): FlgWire | undefined {
  if (!list || list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  let merged = mergedPinWires.get(list);
  if (!merged) {
    merged = { uid: list.map((wire) => wire.uid).join("+"), endpoints: list.flatMap((wire) => wire.endpoints) };
    mergedPinWires.set(list, merged);
  }
  return merged;
}

function bindFlgCall(
  call: ParsedCall,
  wiresByPin: Map<string, FlgWire[]>,
  accesses: Map<string, AccessSemantic>,
  ownerBlockKey: string
): ParameterBinding[] {
  const result: ParameterBinding[] = [];
  const all = [...call.parameters];
  const knownNames = new Set(all.map((binding) => binding.name.toLowerCase()));
  for (const implicit of ["EN", "ENO"]) {
    if (wiresByPin.has(pinKey(call.uid, implicit)) && !knownNames.has(implicit.toLowerCase())) {
      all.push({
        name: implicit,
        section: implicit === "EN" ? "Input" : "Output",
        direction: implicit === "EN" ? "input" : "output",
        actual: { kind: "unknown", text: "", reason: "Unbound implicit pin", symbols: [] },
        sourceSymbols: [],
        targetSymbols: []
      });
    }
  }
  for (const binding of all) {
    const pinWires = wiresByPin.get(pinKey(call.uid, binding.name)) ?? [];
    const wire = mergedPinWire(pinWires);
    const accessValues = (wire?.endpoints ?? [])
      .filter((endpoint): endpoint is Extract<FlgEndpoint, { kind: "ident" }> => endpoint.kind === "ident")
      .map((endpoint) => accesses.get(endpoint.uid))
      .filter((access): access is AccessSemantic => access !== undefined);
    const symbols = accessValues.flatMap((access) => access.symbol ? [access.symbol] : []);
    let actual: ValueExpression;
    if (pinWires.length > 1 && binding.direction !== "output") {
      actual = {
        kind: "unknown",
        text: `${call.name}.${binding.name}`,
        reason: "Call input has multiple data drivers (several wires)",
        symbols
      };
    } else if (accessValues.length === 1) actual = accessValues[0].value;
    else if (accessValues.length > 1) {
      actual = {
        kind: "unknown",
        text: symbols.map((symbol) => symbol.symbol).join(" | "),
        reason: "Call pin has multiple direct identifiers",
        symbols
      };
    } else {
      actual = {
        kind: "unknown",
        text: `${call.name}.${binding.name}`,
        reason: wire ? "Call pin source is computed by FlgNet topology" : "Call pin is not wired",
        symbols: []
      };
    }
    result.push({
      ...binding,
      actual,
      sourceSymbols: binding.direction === "output" ? [] : symbols.map((symbol) => symbol.symbol),
      targetSymbols: binding.direction === "output" || binding.direction === "inout"
        ? symbols.map((symbol) => symbol.symbol)
        : []
    });
  }
  return result.map((binding) => ({
    ...binding,
    actual: binding.actual.kind === "symbol"
      ? { kind: "symbol", ...symbolOperand(binding.actual.symbol, binding.actual.scope, ownerBlockKey) }
      : binding.actual
  }));
}

type XmlSection = { xml: string; offset: number };

function extractCompileUnits(xml: string): XmlSection[] {
  const result: XmlSection[] = [];
  const regex = /<SW\.Blocks\.CompileUnit\b[\s\S]*?<\/SW\.Blocks\.CompileUnit>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml))) result.push({ xml: match[0], offset: match.index });
  return result.length > 0 ? result : [{ xml, offset: 0 }];
}

function semanticNodesInOrder(nodes: OrderedElement[]): OrderedElement[] {
  const result: OrderedElement[] = [];
  const visit = (node: OrderedElement) => {
    const name = elementName(node).toLowerCase();
    if (name === "flgnet" || name === "structuredtext") {
      result.push(node);
      return;
    }
    for (const child of elementChildren(node)) visit(child);
  };
  for (const node of nodes) visit(node);
  return result;
}

function sourceKindForNode(node: OrderedElement): "LAD_FBD" | "SCL" {
  return elementName(node).toLowerCase() === "flgnet" ? "LAD_FBD" : "SCL";
}

function summarizeCoverage(
  writeSites: WriteSite[],
  callSites: CallSite[],
  networks: NetworkCoverage[],
  extraIssues: string[] = []
): CoverageReport {
  const sites = [...writeSites, ...callSites];
  const exactSites = sites.filter((site) => site.coverage === "exact").length;
  const conservativeSites = sites.filter((site) => site.coverage === "conservative").length;
  const unsupportedSites = sites.filter((site) => site.coverage === "unsupported").length;
  const issues = unique([...networks.flatMap((network) => network.issues), ...extraIssues]);
  const levels = [
    ...sites.map((site) => site.coverage),
    ...networks.map((network) => network.level),
    ...(extraIssues.length > 0 ? ["conservative" as const] : [])
  ];
  return {
    level: levels.length === 0 ? "unsupported" : worstCoverage(levels),
    exactSites,
    conservativeSites,
    unsupportedSites,
    issues
  };
}

function graphCondition(node: OrderedElement, owner: BlockOwner): GraphCondition {
  const net = firstDescendant(node, "FlgNet");
  const outputs: GuardExpression[] = [];
  if (net) analyzeFlgNet(net, owner, { network: 0, xmlLine: 0, sourceKind: "LAD_FBD" },
    { writes: [], calls: [], controls: [], networks: [], nextOrder: 0 }, outputs);
  const guard: GuardExpression = outputs.length === 1 ? outputs[0] : {
    kind: "unknown", text: attribute(node, "Name"),
    reason: "GRAPH condition requires exactly one supported transition/interlock/supervision coil", symbols: []
  };
  return { guard, coverage: guardHasUnknown(guard) ? "unsupported" : "exact" };
}

function analyzeGraphSequences(roots: OrderedElement[], owner: BlockOwner): GraphSequence[] {
  return descendants(roots, "Sequence").map((sequence, index) => {
    const issues: string[] = [];
    const steps = descendants(sequence, "Step");
    const transitions = descendants(sequence, "Transition");
    const branches = descendants(sequence, "Branch");
    const ref = (node: OrderedElement | undefined) => node
      ? elementName(node).replace(/Ref$/, "") + ":" + attribute(node, "Number") : "";
    const connections = descendants(sequence, "Connection").map((node) => {
      const fromNode = firstDescendant(node, "NodeFrom");
      const toNode = firstDescendant(node, "NodeTo");
      const from = fromNode && directChildren(fromNode)[0];
      const to = toNode && directChildren(toNode)[0];
      return { from: ref(from), to: ref(to), fromPort: from ? attribute(from, "Out") : "",
        toPort: to ? attribute(to, "In") : "", linkType: firstDescendant(node, "LinkType") ? nodeText(firstDescendant(node, "LinkType")!) : "" };
    });
    const known = new Set([...steps.map(n => "Step:" + attribute(n, "Number")),
      ...transitions.map(n => "Transition:" + attribute(n, "Number")),
      ...branches.map(n => "Branch:" + attribute(n, "Number"))]);
    if (known.size !== steps.length + transitions.length + branches.length) issues.push("Duplicate GRAPH node identities");
    for (const edge of connections) if (!known.has(edge.from) || !known.has(edge.to))
      issues.push(`Unresolved GRAPH connection ${edge.from} -> ${edge.to}`);
    const next = (node: string, visited = new Set<string>()): string[] => {
      if (visited.has(node)) { issues.push(`GRAPH branch cycle at ${node}`); return []; }
      const seen = new Set(visited).add(node);
      return connections.filter(e => e.from === node).flatMap(e => e.to.startsWith("Branch:") ? next(e.to, seen) : [e.to]);
    };
    return {
      sequence: index + 1,
      steps: steps.map(step => ({
        number: attribute(step, "Number"), name: attribute(step, "Name"), initial: attribute(step, "Init") === "true",
        actions: descendants(step, "Action").map(action => ({
          qualifier: attribute(action, "Qualifier"), event: attribute(action, "Event"),
          interlocked: attribute(action, "Interlock") === "true",
          text: descendants(action, "Token").map(t => attribute(t, "Text")).join("").trim()
        })).filter(a => a.text || a.qualifier),
        interlocks: descendants(step, "Interlock").map(n => graphCondition(n, owner)),
        supervisions: descendants(step, "Supervision").map(n => graphCondition(n, owner)),
        exits: next("Step:" + attribute(step, "Number")).map(t => ({
          transition: t, nextSteps: next(t).filter(s => s.startsWith("Step:"))
        }))
      })),
      transitions: transitions.map(n => ({ number: attribute(n, "Number"), name: attribute(n, "Name"), condition: graphCondition(n, owner) })),
      branches: branches.map(n => ({ number: attribute(n, "Number"), attributes: attributes(n) })),
      connections,
      issues: unique(issues)
    };
  });
}

function graphActionTokens(text: string, owner: BlockOwner): CodeToken[] | null {
  const component = String.raw`(?:"(?:[^"]|"")+"|[\p{L}_][\p{L}\p{N}_]*)`;
  const symbolic = `${component}(?:\\[\\d+(?:,\\d+)*\\])*(?:\\.(?:${component}|%X\\d+)(?:\\[\\d+(?:,\\d+)*\\])*)*`;
  const absolute = String.raw`%?(?:DB\d+\.DB(?:X\d+\.[0-7]|[BWD]\d+)|[IQM](?:[BWD]\d+|\d+\.[0-7]))`;
  const operand = new RegExp(`^(?:${absolute}|#?${symbolic})$`, "iu");
  const lex = new RegExp(String.raw`\s+|//[^\r\n]*|:=|(?:[A-Z_][A-Z0-9_]*#(?:TRUE|FALSE|[-+]?\d+(?:\.\d+)?))|(?:\d+(?:\.\d+)?(?:[Ee][-+]?\d+)?)|'(?:[^']|'')*'|${absolute}|#?${symbolic}|[()+*/;,\-]`, "giyu");
  const tokens: CodeToken[] = [];
  while (lex.lastIndex < text.length) {
    const match = lex.exec(text);
    if (!match) return null;
    const value = match[0];
    if (!value.trim() || value.startsWith("//")) continue;
    if (operand.test(value) && !literalFromToken(value) && !/^(AND|OR|XOR|NOT|MOD|SHL|SHR|CALL)$/i.test(value)) {
      tokens.push({ kind: "access", text: value, operand: symbolOperand(value, value.startsWith("#") ? "LocalVariable" : "GlobalVariable", owner.blockKey) });
    } else tokens.push({ kind: "token", text: value });
  }
  if (tokens.at(-1)?.text === ";") tokens.pop();
  return tokens;
}

function graphWrites(roots: OrderedElement[], graph: GraphSequence[], source: ExecutionBlockSource & { xml: string }, owner: BlockOwner) {
  const accumulator: SemanticAccumulator = { writes: [], calls: [], controls: [], networks: [], nextOrder: 0 };
  const issues: string[] = [];
  const offsets = [...source.xml.matchAll(/<Action\b/g)].map(m => m.index!);
  const line = lineLookup(source.xml);
  let ordinal = 0;
  descendants(roots, "Sequence").forEach((sequence, sequenceIndex) => {
    descendants(sequence, "Step").forEach((step, stepIndex) => {
      const stepInfo = graph[sequenceIndex].steps[stepIndex];
      descendants(step, "Action").forEach((action, actionIndex) => {
        const offset = offsets[ordinal++];
        const qualifier = attribute(action, "Qualifier");
        const event = attribute(action, "Event");
        const interlocked = attribute(action, "Interlock") === "true";
        const text = descendants(action, "Token").map(t => attribute(t, "Text")).join(" ").trim();
        const identity = { sequence: sequenceIndex + 1, step: stepInfo.number, stepName: stepInfo.name, action: actionIndex + 1, qualifier, event, interlocked, text };
        const context = `GRAPH sequence ${identity.sequence} step ${identity.step} action ${identity.action}`;
        const unknown = (reason: string): GuardExpression => ({ kind: "unknown", text: context, reason, symbols: [] });
        let guard = unknown(event ? `GRAPH event ${event} must occur; event state is not evaluated` : "GRAPH step must be active; active state is not evaluated");
        if (interlocked) guard = andGuard(guard, ...(stepInfo.interlocks.length
          ? stepInfo.interlocks.map(c => c.guard) : [unknown("GRAPH action interlock is not exposed")]));
        const tokens = graphActionTokens(text, owner);
        if (tokens?.length === 0) return;
        const target = tokens?.[0];
        let effect: WriteEffect | undefined;
        let values: ValueExpression[] = [];
        if (["N", "S", "R"].includes(qualifier) && target?.kind === "access" && tokens?.length === 1) {
          effect = { kind: "coil", mode: qualifier === "S" ? "set" : qualifier === "R" ? "reset" : "normal", energizeWhen: guard };
        } else if (qualifier === "N" && target?.kind === "access" && tokens && tokens.length > 2 && tokens[1].text === ":="
          && !tokens.slice(2).some(t => [":=", ";", "CALL"].includes(t.text.toUpperCase()))) {
          const value = valueFromTokens(tokens.slice(2));
          effect = { kind: "assign", value }; values = [value];
        }
        if (!effect || target?.kind !== "access") {
          issues.push(`${context}: unsupported action ${qualifier} ${compact(text)}; no write inferred`);
          return;
        }
        const location: LocationSeed = { network: ordinal, networkTitle: context, xmlLine: offset === undefined ? 0 : line(offset), sourceKind: "GRAPH" };
        const site = makeWriteSite(owner, location, accumulator, target.operand, effect, guard, [context], "conservative", values,
          "GRAPH source write candidate; event/timing, step scheduling and cross-step output arbitration are not simulated");
        site.graphAction = identity;
        accumulator.writes.push(site);
      });
    });
  });
  return { writes: accumulator.writes, issues };
}

export function analyzeExecutionBlock(source: ExecutionBlockSource): ExecutionBlockAnalysis {
  if (source.xml === undefined) {
    throw new Error(`XML is required to analyze changed block ${executionBlockKey(source)}`);
  }
  const owner = makeOwner(source);
  const graphRoots = /<Sequence\b/.test(source.xml) ? parseOrdered(source.xml, true) : [];
  const graph = analyzeGraphSequences(graphRoots, owner);
  if (graph.length > 0) {
    const actions = graphWrites(graphRoots, graph, { ...source, xml: source.xml }, owner);
    const operands = graph.flatMap(s => s.transitions.flatMap(t => collectGuardSymbols(t.condition.guard)));
    const issues = ["GRAPH topology and conditions are source evidence; active steps, action scheduling, timed qualifiers and simultaneous branches are not simulated",
      ...graph.flatMap(s => s.issues), ...actions.issues];
    return {
      analyzerVersion: EXECUTION_ANALYZER_VERSION, blockKey: owner.blockKey, name: owner.name, number: owner.number,
      kind: owner.kind, softwarePath: owner.softwarePath, language: owner.language, relativePath: owner.relativePath,
      sha256: sourceHash(source), writeSites: actions.writes, callSites: [], controlSites: [], graph,
      readSymbols: unique([...operands.map(o => o.symbol), ...actions.writes.flatMap(w => w.readSymbols)]),
      normalizedReadSymbols: unique([...operands.map(o => o.normalizedSymbol), ...actions.writes.flatMap(w => w.normalizedReadSymbols)]),
      networks: [], coverage: { level: "conservative", exactSites: 0, conservativeSites: actions.writes.length, unsupportedSites: 0, issues }
    };
  }
  const sourceLine = lineLookup(source.xml);
  const accumulator: SemanticAccumulator = {
    writes: [],
    calls: [],
    controls: [],
    networks: [],
    nextOrder: 0
  };
  const blockIssues: string[] = [];
  let networkNumber = 0;

  for (const section of extractCompileUnits(source.xml)) {
    let roots: OrderedElement[];
    try {
      roots = parseOrdered(section.xml);
    } catch (error) {
      blockIssues.push(`XML parse failed near line ${sourceLine(section.offset)}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const semanticNodes = semanticNodesInOrder(roots);
    if (semanticNodes.length === 0) {
      if (/<(?:Graph|Step|Transition)\b/i.test(section.xml)) {
        networkNumber += 1;
        accumulator.networks.push({
          network: networkNumber,
          sourceKind: "UNKNOWN",
          level: "unsupported",
          writeSites: 0,
          callSites: 0,
          issues: ["GRAPH execution semantics are not implemented in analyzer 0.1.0"]
        });
      } else if (/<(?:StatementList|InstructionList)\b/i.test(section.xml) || /\bProgrammingLanguage[^>]*>\s*STL\b/i.test(section.xml)) {
        networkNumber += 1;
        accumulator.networks.push({
          network: networkNumber,
          sourceKind: "UNKNOWN",
          level: "unsupported",
          writeSites: 0,
          callSites: 0,
          issues: ["STL execution semantics are not implemented"]
        });
      }
      continue;
    }

    let searchOffset = 0;
    for (const semanticNode of semanticNodes) {
      networkNumber += 1;
      const tag = sourceKindForNode(semanticNode) === "LAD_FBD" ? "<FlgNet" : "<StructuredText";
      const localOffset = section.xml.indexOf(tag, searchOffset);
      if (localOffset >= 0) searchOffset = localOffset + tag.length;
      const location: LocationSeed = {
        network: networkNumber,
        xmlLine: sourceLine(section.offset + Math.max(0, localOffset)),
        sourceKind: sourceKindForNode(semanticNode)
      };
      if (location.sourceKind === "LAD_FBD") {
        analyzeFlgNet(semanticNode, owner, location, accumulator);
      } else {
        const issues: string[] = [];
        const startWrites = accumulator.writes.length;
        const startCalls = accumulator.calls.length;
        const tokens = flattenSclNodes(elementChildren(semanticNode), owner.blockKey);
        if (tokens.length === 0) issues.push("StructuredText contains no analyzable tokens");
        else new SclSemanticParser(tokens, owner, location, accumulator, issues).parse();
        const sites = [
          ...accumulator.writes.slice(startWrites),
          ...accumulator.calls.slice(startCalls)
        ];
        if (sites.length === 0 && tokens.length > 0) issues.push("No supported SCL write or call effect was found");
        accumulator.networks.push({
          network: networkNumber,
          sourceKind: "SCL",
          level: sites.length === 0 && tokens.length > 0 ? "unsupported" : issueCoverage(issues, sites),
          writeSites: accumulator.writes.length - startWrites,
          callSites: accumulator.calls.length - startCalls,
          issues: unique(issues)
        });
      }
    }
  }

  if (/KnowHowProtected|IsKnowHowProtected/i.test(source.xml) && />\s*true\s*</i.test(source.xml)) {
    blockIssues.push("Block contains know-how protected content; hidden logic cannot be analyzed");
  }
  if (accumulator.networks.length === 0) {
    accumulator.networks.push({
      network: 0,
      sourceKind: "UNKNOWN",
      level: "unsupported",
      writeSites: 0,
      callSites: 0,
      issues: ["No supported executable representation was found"]
    });
  }
  const normalizedReadSymbols = unique([
    ...accumulator.writes.flatMap((site) => site.normalizedReadSymbols),
    ...accumulator.calls.flatMap((site) => site.normalizedReadSymbols)
  ]);
  const readPairs = [
    ...accumulator.writes.flatMap((site) => site.normalizedReadSymbols.map((normalized, index) => ({
      normalized,
      symbol: site.readSymbols[index] ?? normalized
    }))),
    ...accumulator.calls.flatMap((site) => site.normalizedReadSymbols.map((normalized, index) => ({
      normalized,
      symbol: site.readSymbols[index] ?? normalized
    })))
  ];
  const readSymbols = normalizedReadSymbols.map(
    (normalized) => readPairs.find((pair) => pair.normalized === normalized)?.symbol ?? normalized
  );
  return {
    analyzerVersion: EXECUTION_ANALYZER_VERSION,
    blockKey: owner.blockKey,
    name: owner.name,
    number: owner.number,
    kind: owner.kind,
    softwarePath: owner.softwarePath,
    language: owner.language,
    relativePath: owner.relativePath,
    sha256: sourceHash(source),
    writeSites: accumulator.writes,
    callSites: accumulator.calls,
    controlSites: accumulator.controls,
    readSymbols,
    normalizedReadSymbols,
    networks: accumulator.networks,
    coverage: summarizeCoverage(accumulator.writes, accumulator.calls, accumulator.networks, blockIssues)
  };
}

function identityMaps(blocks: Record<string, ExecutionBlockAnalysis>): {
  byName: Map<string, string[]>;
  byNumber: Map<string, string[]>;
} {
  const byName = new Map<string, string[]>();
  const byNumber = new Map<string, string[]>();
  for (const [key, block] of Object.entries(blocks)) {
    const software = cleanSymbol(block.softwarePath);
    const name = cleanSymbol(block.name);
    const number = cleanSymbol(block.number);
    const nameKey = `${software}\0${name}`;
    const numberKey = `${software}\0${block.kind.toLowerCase()}:${number}`;
    if (name) byName.set(nameKey, [...(byName.get(nameKey) ?? []), key]);
    if (number) byNumber.set(numberKey, [...(byNumber.get(numberKey) ?? []), key]);
  }
  return { byName, byNumber };
}

function resolveCallTarget(
  call: Pick<CallSite, "calleeName" | "calleeKind" | "softwarePath">,
  blocks: Record<string, ExecutionBlockAnalysis>,
  maps = identityMaps(blocks)
): string | null {
  if (call.calleeKind === INSTRUCTION_KIND) return null;
  const software = cleanSymbol(call.softwarePath);
  const byName = maps.byName.get(`${software}\0${cleanSymbol(call.calleeName)}`) ?? [];
  if (byName.length === 1) return byName[0];
  const numberMatch = /\b(?:OB|FB|FC)?\s*(\d+)\b/i.exec(call.calleeName);
  if (numberMatch) {
    const byNumber = maps.byNumber.get(`${software}\0${call.calleeKind.toLowerCase()}:${cleanSymbol(numberMatch[1])}`) ?? [];
    if (byNumber.length === 1) return byNumber[0];
  }
  return null;
}

function descriptorRecord(sources: ExecutionBlockSource[]): Record<string, ExecutionBlockSource> {
  const result: Record<string, ExecutionBlockSource> = {};
  for (const source of sources) {
    const key = executionBlockKey(source);
    if (result[key]) throw new Error(`Duplicate execution block key ${key}`);
    result[key] = source;
  }
  return result;
}

export function planIncrementalReanalysis(
  sources: ExecutionBlockDescriptor[],
  previous?: ExecutionModelIndex
): IncrementalReanalysisPlan {
  const current = descriptorRecord(sources);
  const previousBlocks = previous?.analyzerVersion === EXECUTION_ANALYZER_VERSION ? previous.blocks : {};
  const currentKeys = new Set(Object.keys(current));
  const previousKeys = new Set(Object.keys(previousBlocks));
  const addedBlockKeys = [...currentKeys].filter((key) => !previousKeys.has(key)).sort();
  const removedBlockKeys = [...previousKeys].filter((key) => !currentKeys.has(key)).sort();
  const changedBlockKeys = [...currentKeys]
    .filter((key) => {
      const old = previousBlocks[key];
      if (!old) return true;
      const hash = sourceHash(current[key]);
      return !hash || hash !== old.sha256;
    })
    .sort();
  const changedOrRemoved = new Set([...changedBlockKeys, ...removedBlockKeys]);

  const reverse = new Map<string, Set<string>>();
  if (previous) {
    const maps = identityMaps(previousBlocks);
    for (const call of previous.callSites) {
      const target = resolveCallTarget(call, previousBlocks, maps);
      if (!target) continue;
      const callers = reverse.get(target) ?? new Set<string>();
      callers.add(call.blockKey);
      reverse.set(target, callers);
    }
  }
  const dependent = new Set<string>();
  const queue = [...changedOrRemoved];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const changed = queue[cursor];
    for (const caller of reverse.get(changed) ?? []) {
      if (changedOrRemoved.has(caller) || dependent.has(caller) || !currentKeys.has(caller)) continue;
      dependent.add(caller);
      queue.push(caller);
    }
  }
  const reusableBlockKeys = [...currentKeys]
    .filter((key) => !changedOrRemoved.has(key))
    .sort();
  return {
    changedBlockKeys,
    addedBlockKeys,
    removedBlockKeys,
    dependentBlockKeys: [...dependent].sort(),
    xmlRequiredBlockKeys: changedBlockKeys,
    reusableBlockKeys
  };
}

function isBuiltinInstruction(call: CallSite): boolean {
  return call.calleeKind === INSTRUCTION_KIND
    || /^(?:TON|TOF|TONR|TP|CTU|CTD|CTUD|MOVE|MOVE_BLK|CONV|CONVERT|R_TRIG|F_TRIG)$/i.test(call.calleeName);
}

function sourceSignature(blocks: Record<string, ExecutionBlockAnalysis>, pending: string[]): string {
  const hash = createHash("sha256");
  for (const block of Object.values(blocks).sort((left, right) => left.blockKey.localeCompare(right.blockKey))) {
    hash.update(block.blockKey).update("\0").update(block.sha256).update("\n");
  }
  for (const key of [...pending].sort()) hash.update(key).update("\0pending\n");
  return hash.digest("hex");
}

function buildExecutionContexts(
  blocks: Record<string, ExecutionBlockAnalysis>
): {
  roots: Array<{ blockKey: string; taskOB: string }>;
  contexts: Map<string, ExecutionContext[]>;
  unresolvedCalls: Array<{ callId: string; calleeName: string; callerBlockKey: string }>;
  issues: string[];
} {
  const roots = Object.values(blocks)
    .filter((block) => block.kind.toUpperCase() === "OB")
    .map((block) => ({
      blockKey: block.blockKey,
      taskOB: `${block.softwarePath ? `${block.softwarePath} / ` : ""}${block.name}${block.number ? ` [OB${block.number}]` : ""}`
    }))
    .sort((left, right) => left.blockKey.localeCompare(right.blockKey));
  const maps = identityMaps(blocks);
  const contexts = new Map<string, ExecutionContext[]>();
  const unresolvedCalls: Array<{ callId: string; calleeName: string; callerBlockKey: string }> = [];
  const issues: string[] = [];
  const queue: Array<{ blockKey: string; context: ExecutionContext }> = roots.map((root) => ({
    blockKey: root.blockKey,
    context: { taskOB: root.taskOB, callPath: [root.blockKey], instancePath: [] }
  }));
  const seen = new Set<string>();
  const MAX_CONTEXTS_PER_BLOCK = 128;
  const MAX_TOTAL_CONTEXTS = 4_096;
  const cappedBlocks = new Set<string>();
  let totalContexts = 0;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const item = queue[cursor];
    const contextKey = `${item.blockKey}\0${item.context.taskOB}\0${item.context.callPath.join(">")}\0${item.context.instancePath.join(">")}`;
    if (seen.has(contextKey)) continue;
    seen.add(contextKey);
    const blockContexts = contexts.get(item.blockKey) ?? [];
    if (blockContexts.length >= MAX_CONTEXTS_PER_BLOCK) {
      if (!cappedBlocks.has(item.blockKey)) {
        issues.push(`Execution context limit reached for ${item.blockKey}`);
        cappedBlocks.add(item.blockKey);
      }
      continue;
    }
    if (totalContexts >= MAX_TOTAL_CONTEXTS) {
      issues.push(`Global execution context limit reached at ${MAX_TOTAL_CONTEXTS}`);
      break;
    }
    blockContexts.push(item.context);
    totalContexts += 1;
    contexts.set(item.blockKey, blockContexts);
    const block = blocks[item.blockKey];
    if (!block) continue;
    for (const call of block.callSites) {
      const target = resolveCallTarget(call, blocks, maps);
      if (!target) {
        if (!isBuiltinInstruction(call)) unresolvedCalls.push({
          callId: call.callId,
          calleeName: call.calleeName,
          callerBlockKey: call.blockKey
        });
        continue;
      }
      if (item.context.callPath.includes(target)) {
        issues.push(`Recursive/cyclic call path stopped at ${call.callId} -> ${target}`);
        continue;
      }
      queue.push({
        blockKey: target,
        context: {
          taskOB: item.context.taskOB,
          callPath: [...item.context.callPath, target],
          instancePath: call.instance
            ? [...item.context.instancePath, call.instance]
            : [...item.context.instancePath]
        }
      });
    }
  }
  return {
    roots,
    contexts,
    unresolvedCalls: unresolvedCalls.filter(
      (item, index, array) => array.findIndex((candidate) => candidate.callId === item.callId) === index
    ),
    issues: unique(issues)
  };
}

function attachContexts<T extends WriteSite | CallSite>(site: T, contexts: ExecutionContext[]): T {
  const effective = contexts.length > 0 ? contexts : site.executionContexts;
  if (effective.length === 1) {
    return {
      ...site,
      taskOB: effective[0].taskOB,
      callPath: effective[0].callPath,
      instancePath: effective[0].instancePath,
      executionContexts: effective
    };
  }
  return {
    ...site,
    taskOB: undefined,
    callPath: [],
    instancePath: [],
    executionContexts: effective
  };
}

type FormalBindingMap = Map<string, ValueExpression>;

type SubstitutionState = {
  issues: string[];
};

function callFormalBindings(call: CallSite): FormalBindingMap {
  const result = new Map<string, ValueExpression>();
  for (const binding of call.parameterBindings) {
    const name = cleanSymbol(binding.name);
    if (name) result.set(name, binding.actual);
  }
  return result;
}

function formalReference(
  operand: SymbolOperand,
  bindings: FormalBindingMap
): { actual: ValueExpression; suffix: string; formal: string } | null {
  const symbol = cleanSymbol(operand.symbol);
  const names = [...bindings.keys()].sort((left, right) => right.length - left.length);
  for (const name of names) {
    if (symbol === name) return { actual: bindings.get(name)!, suffix: "", formal: name };
    if (symbol.startsWith(`${name}.`)) {
      return {
        actual: bindings.get(name)!,
        suffix: symbol.slice(name.length),
        formal: name
      };
    }
  }
  return null;
}

function substituteSymbolValue(
  operand: SymbolOperand,
  bindings: FormalBindingMap,
  state: SubstitutionState
): ValueExpression {
  const reference = formalReference(operand, bindings);
  if (!reference) return { kind: "symbol", ...operand };
  if (!reference.suffix) return reference.actual;
  if (reference.actual.kind !== "symbol") {
    state.issues.push(`Formal ${reference.formal}${reference.suffix} is bound to a non-symbol expression`);
    return {
      kind: "unknown",
      text: `${reference.formal}${reference.suffix}`,
      reason: "Structured formal member cannot be appended to a non-symbol actual parameter",
      symbols: collectValueSymbols(reference.actual)
    };
  }
  return {
    kind: "symbol",
    symbol: `${reference.actual.symbol}${reference.suffix}`,
    normalizedSymbol: `${reference.actual.normalizedSymbol}${reference.suffix}`,
    scope: reference.actual.scope
  };
}

function substituteValue(
  value: ValueExpression,
  bindings: FormalBindingMap,
  state: SubstitutionState
): ValueExpression {
  switch (value.kind) {
    case "symbol":
      return substituteSymbolValue(value, bindings, state);
    case "operation":
      return {
        ...value,
        operands: value.operands.map((operand) => substituteValue(operand, bindings, state))
      };
    case "unknown": {
      const symbols = new Map<string, SymbolOperand>();
      for (const operand of value.symbols) {
        for (const replacement of collectValueSymbols(substituteSymbolValue(operand, bindings, state))) {
          symbols.set(replacement.normalizedSymbol, replacement);
        }
      }
      return { ...value, symbols: [...symbols.values()] };
    }
    default:
      return value;
  }
}

function substituteGuard(
  guard: GuardExpression,
  bindings: FormalBindingMap,
  state: SubstitutionState
): GuardExpression {
  switch (guard.kind) {
    case "symbol":
      return valueAsGuard(
        substituteSymbolValue(guard, bindings, state),
        "Formal Boolean parameter is bound to an expression that cannot be proven Boolean"
      );
    case "not":
      return notGuard(substituteGuard(guard.operand, bindings, state));
    case "and":
      return andGuard(...guard.operands.map((operand) => substituteGuard(operand, bindings, state)));
    case "or":
      return orGuard(...guard.operands.map((operand) => substituteGuard(operand, bindings, state)));
    case "compare":
      return {
        ...guard,
        left: substituteValue(guard.left, bindings, state),
        right: substituteValue(guard.right, bindings, state)
      };
    case "edge": {
      let memory = guard.memory;
      if (memory) {
        const replacement = substituteSymbolValue(memory, bindings, state);
        if (replacement.kind === "symbol") memory = replacement;
        else {
          memory = undefined;
          state.issues.push("Edge memory formal is not bound to one direct symbol");
        }
      }
      return {
        ...guard,
        operand: substituteGuard(guard.operand, bindings, state),
        memory
      };
    }
    case "stateful":
      return {
        ...guard,
        inputs: Object.fromEntries(
          Object.entries(guard.inputs).map(([name, value]) => [name, substituteValue(value, bindings, state)])
        )
      };
    case "loop":
      return {
        ...guard,
        condition: guard.condition ? substituteGuard(guard.condition, bindings, state) : undefined
      };
    case "unknown": {
      const symbols = new Map<string, SymbolOperand>();
      for (const operand of guard.symbols) {
        for (const replacement of collectValueSymbols(substituteSymbolValue(operand, bindings, state))) {
          symbols.set(replacement.normalizedSymbol, replacement);
        }
      }
      return { ...guard, symbols: [...symbols.values()] };
    }
    default:
      return guard;
  }
}

function substituteEffect(
  effect: WriteEffect,
  bindings: FormalBindingMap,
  state: SubstitutionState
): WriteEffect {
  switch (effect.kind) {
    case "assign":
      return { ...effect, value: substituteValue(effect.value, bindings, state) };
    case "coil":
      return { ...effect, energizeWhen: substituteGuard(effect.energizeWhen, bindings, state) };
    case "timer":
    case "counter":
      return {
        ...effect,
        inputs: Object.fromEntries(
          Object.entries(effect.inputs).map(([name, value]) => [name, substituteValue(value, bindings, state)])
        )
      };
    default:
      return effect;
  }
}

function valueHasUnknown(value: ValueExpression): boolean {
  if (value.kind === "unknown") return true;
  if (value.kind === "operation") return value.operands.some(valueHasUnknown);
  return false;
}

function effectHasUnknown(effect: WriteEffect): boolean {
  switch (effect.kind) {
    case "assign":
      return valueHasUnknown(effect.value);
    case "coil":
      return guardHasUnknown(effect.energizeWhen);
    case "timer":
    case "counter":
      return Object.values(effect.inputs).some(valueHasUnknown);
    case "call-output":
    case "unknown":
      return true;
    default:
      return false;
  }
}

function effectReadValues(effect: WriteEffect): ValueExpression[] {
  switch (effect.kind) {
    case "assign":
      return [effect.value];
    case "timer":
    case "counter":
      return Object.values(effect.inputs);
    default:
      return [];
  }
}

function formalTargetMatches(site: WriteSite, bindingName: string): boolean {
  const target = cleanSymbol(site.target);
  const formal = cleanSymbol(bindingName);
  return Boolean(formal && (target === formal || target.startsWith(`${formal}.`)));
}

function resolvedCallContexts(
  call: CallSite,
  calleeBlockKey: string,
  contexts: Map<string, ExecutionContext[]>
): ExecutionContext[] {
  const parents = contexts.get(call.blockKey) ?? call.executionContexts;
  return parents.map((parent) => ({
    taskOB: parent.taskOB,
    callPath: parent.callPath.at(-1) === calleeBlockKey
      ? parent.callPath
      : [...parent.callPath, calleeBlockKey],
    instancePath: call.instance
      ? [...parent.instancePath, call.instance]
      : [...parent.instancePath]
  }));
}

function composeResolvedCallOutputWrites(
  blocks: Record<string, ExecutionBlockAnalysis>,
  contexts: Map<string, ExecutionContext[]>
): WriteSite[] {
  const maps = identityMaps(blocks);
  const replacements = new Map<string, WriteSite[]>();

  for (const caller of Object.values(blocks)) {
    for (const call of caller.callSites) {
      const calleeKey = resolveCallTarget(call, blocks, maps);
      const callee = calleeKey ? blocks[calleeKey] : undefined;
      if (!callee || !["FC", "FB"].includes(callee.kind.toUpperCase())) continue;
      const bindings = callFormalBindings(call);
      const callContexts = resolvedCallContexts(call, callee.blockKey, contexts);

      for (const binding of call.parameterBindings) {
        if (binding.direction !== "output" && binding.direction !== "inout") continue;
        const opaqueSites = caller.writeSites.filter((site) => (
          site.effect.kind === "call-output"
          && site.effect.callUid === call.sourceUid
          && cleanSymbol(site.effect.output) === cleanSymbol(binding.name)
        ));
        const calleeSites = callee.writeSites.filter((site) => formalTargetMatches(site, binding.name));
        if (opaqueSites.length === 0 || calleeSites.length === 0) continue;

        for (const opaque of opaqueSites) {
          const composed: WriteSite[] = [];
          for (const calleeSite of calleeSites) {
            const state: SubstitutionState = { issues: [] };
            const targetValue = substituteSymbolValue(
              {
                symbol: calleeSite.target,
                normalizedSymbol: calleeSite.normalizedTarget,
                scope: calleeSite.targetScope
              },
              bindings,
              state
            );
            if (targetValue.kind !== "symbol") continue;
            const substitutedGuard = substituteGuard(calleeSite.guard, bindings, state);
            const guard = andGuard(call.guard, substitutedGuard);
            const effect = substituteEffect(calleeSite.effect, bindings, state);
            const baseCoverage = worstCoverage([call.coverage, calleeSite.coverage]);
            const coverage: CoverageLevel = baseCoverage === "unsupported"
              ? "unsupported"
              : state.issues.length > 0 || guardHasUnknown(guard) || effectHasUnknown(effect)
                ? "conservative"
                : baseCoverage;
            const reads = siteReadSymbols(guard, effectReadValues(effect));
            const provenanceHash = createHash("sha256")
              .update(call.callId)
              .update("\0")
              .update(calleeSite.siteId)
              .update("\0")
              .update(targetValue.normalizedSymbol)
              .digest("hex")
              .slice(0, 12);
            const composedSite = attachContexts({
              ...opaque,
              siteId: `${opaque.siteId}:X${provenanceHash}`,
              target: targetValue.symbol,
              normalizedTarget: targetValue.normalizedSymbol,
              targetScope: targetValue.scope,
              effect,
              guard,
              readSymbols: reads.map((item) => item.symbol),
              normalizedReadSymbols: reads.map((item) => item.normalizedSymbol),
              controlContext: [
                ...opaque.controlContext,
                `CALL ${call.calleeName}.${binding.name}`,
                ...calleeSite.controlContext
              ],
              confidence: confidenceFor(coverage),
              coverage,
              unsupportedReason: coverage === "exact"
                ? undefined
                : unique([
                    ...state.issues,
                    calleeSite.unsupportedReason ?? "",
                    effectHasUnknown(effect) ? "Composed callee effect remains unresolved" : ""
                  ]).join("; ") || "Formal-to-actual call composition remains conservative",
              composedFrom: {
                callId: call.callId,
                calleeBlockKey: callee.blockKey,
                calleeSiteId: calleeSite.siteId,
                formalTarget: calleeSite.target,
                bindingName: binding.name
              }
            }, callContexts);
            composed.push(composedSite);
          }
          if (composed.length > 0) replacements.set(opaque.siteId, composed);
        }
      }
    }
  }

  return Object.values(blocks).flatMap((block) => block.writeSites.flatMap((site) => {
    const replacement = replacements.get(site.siteId);
    return replacement ?? [attachContexts(site, contexts.get(block.blockKey) ?? [])];
  }));
}

function projectNetworkCoverage(
  blocks: Record<string, ExecutionBlockAnalysis>,
  writeSites: WriteSite[],
  callSites: CallSite[]
): NetworkCoverage[] {
  return Object.values(blocks).flatMap((block) => block.networks.map((network) => {
    const writes = writeSites.filter((site) => site.blockKey === block.blockKey && site.network === network.network);
    const calls = callSites.filter((site) => site.blockKey === block.blockKey && site.network === network.network);
    const sites = [...writes, ...calls];
    return {
      ...network,
      level: sites.length === 0 && network.writeSites + network.callSites > 0
        ? "unsupported"
        : issueCoverage(network.issues, sites),
      writeSites: writes.length,
      callSites: calls.length
    };
  }));
}

function buildAdjacency(writeSites: WriteSite[], callSites: CallSite[]): Record<string, SymbolAdjacency> {
  const result: Record<string, SymbolAdjacency> = {};
  const ensure = (symbol: string, normalizedSymbol: string): SymbolAdjacency => {
    const existing = result[normalizedSymbol];
    if (existing) return existing;
    const created: SymbolAdjacency = {
      symbol,
      normalizedSymbol,
      readSiteIds: [],
      writeSiteIds: [],
      callSiteIds: []
    };
    result[normalizedSymbol] = created;
    return created;
  };
  for (const site of writeSites) {
    ensure(site.target, site.normalizedTarget).writeSiteIds.push(site.siteId);
    for (let index = 0; index < site.normalizedReadSymbols.length; index += 1) {
      ensure(site.readSymbols[index] ?? site.normalizedReadSymbols[index], site.normalizedReadSymbols[index])
        .readSiteIds.push(site.siteId);
    }
  }
  for (const site of callSites) {
    for (let index = 0; index < site.normalizedReadSymbols.length; index += 1) {
      const entry = ensure(site.readSymbols[index] ?? site.normalizedReadSymbols[index], site.normalizedReadSymbols[index]);
      entry.readSiteIds.push(site.callId);
      entry.callSiteIds.push(site.callId);
    }
    for (const binding of site.parameterBindings) {
      for (const target of binding.targetSymbols) {
        const normalized = normalizeExecutionSymbol(target, "", site.blockKey);
        ensure(target, normalized).callSiteIds.push(site.callId);
      }
    }
  }
  for (const entry of Object.values(result)) {
    entry.readSiteIds = unique(entry.readSiteIds);
    entry.writeSiteIds = unique(entry.writeSiteIds);
    entry.callSiteIds = unique(entry.callSiteIds);
  }
  return result;
}

export function buildExecutionModel(
  sources: ExecutionBlockSource[],
  previous?: ExecutionModelIndex
): ExecutionModelIndex {
  const descriptors = descriptorRecord(sources);
  const plan = planIncrementalReanalysis(sources, previous);
  const blocks: Record<string, ExecutionBlockAnalysis> = {};
  const pendingBlockKeys: string[] = [];
  for (const [key, source] of Object.entries(descriptors)) {
    const old = previous?.analyzerVersion === EXECUTION_ANALYZER_VERSION ? previous.blocks[key] : undefined;
    const hash = sourceHash(source);
    if (old && hash && old.sha256 === hash) {
      const relativePath = source.relativePath ?? old.relativePath;
      const softwarePath = source.softwarePath ?? old.softwarePath;
      blocks[key] = {
        ...old,
        relativePath,
        softwarePath,
        writeSites: old.writeSites.map((site) => ({
          ...site,
          relativePath,
          softwarePath
        })),
        callSites: old.callSites.map((site) => ({
          ...site,
          relativePath,
          softwarePath
        }))
      };
      continue;
    }
    if (source.xml === undefined) {
      pendingBlockKeys.push(key);
      continue;
    }
    blocks[key] = analyzeExecutionBlock({ ...source, sha256: hash || undefined });
  }

  const execution = buildExecutionContexts(blocks);
  const callSites = Object.values(blocks)
    .flatMap((block) => block.callSites.map((site) => attachContexts(site, execution.contexts.get(block.blockKey) ?? [])))
    .sort((left, right) =>
      left.blockKey.localeCompare(right.blockKey)
      || left.network - right.network
      || left.statementOrder - right.statementOrder
    );
  const writeSites = composeResolvedCallOutputWrites(blocks, execution.contexts)
    .sort((left, right) =>
      left.blockKey.localeCompare(right.blockKey)
      || left.network - right.network
      || left.statementOrder - right.statementOrder
      || left.siteId.localeCompare(right.siteId)
    );
  const globalIssues = [
    ...execution.issues,
    ...execution.unresolvedCalls.map((call) => `Unresolved call ${call.calleeName} at ${call.callId}`),
    ...pendingBlockKeys.map((key) => `Changed block ${key} requires XML before execution analysis is complete`),
    ...(execution.roots.length === 0 && Object.keys(blocks).length > 0 ? ["No OB root is present; task execution paths are unresolved"] : [])
  ];
  const networks = projectNetworkCoverage(blocks, writeSites, callSites);
  return {
    schemaVersion: 1,
    analyzerVersion: EXECUTION_ANALYZER_VERSION,
    generatedAt: new Date().toISOString(),
    sourceSignature: sourceSignature(blocks, pendingBlockKeys),
    blocks,
    writeSites,
    callSites,
    roots: execution.roots,
    adjacency: buildAdjacency(writeSites, callSites),
    unresolvedCalls: execution.unresolvedCalls,
    coverage: summarizeCoverage(writeSites, callSites, networks, globalIssues),
    incremental: {
      ...plan,
      pendingBlockKeys: pendingBlockKeys.sort()
    }
  };
}

function matchesSymbol(value: string, query: string, mode: SymbolMatchMode): boolean {
  if (mode === "exact") return value === query;
  if (mode === "suffix") return value === query || value.endsWith(`.${query}`) || value.endsWith(`::${query}`);
  return value.includes(query);
}

const executionQueryRuntime = new WeakMap<
  ExecutionModelIndex,
  { writesById: Map<string, WriteSite>; callsById: Map<string, CallSite> }
>();

function executionQueryMaps(
  index: ExecutionModelIndex
): { writesById: Map<string, WriteSite>; callsById: Map<string, CallSite> } {
  const cached = executionQueryRuntime.get(index);
  if (cached) return cached;
  const created = {
    writesById: new Map(index.writeSites.map((site) => [site.siteId, site])),
    callsById: new Map(index.callSites.map((site) => [site.callId, site]))
  };
  executionQueryRuntime.set(index, created);
  return created;
}

export function queryExecutionSymbol(
  index: ExecutionModelIndex,
  symbol: string,
  options: { match?: SymbolMatchMode } = {}
): ExecutionSymbolQuery {
  const mode = options.match ?? "suffix";
  const normalizedQuery = cleanSymbol(symbol);
  const exact = mode === "exact" ? index.adjacency[normalizedQuery] : undefined;
  const matches = exact
    ? [exact]
    : (mode === "exact"
      ? []
      : Object.values(index.adjacency)
        .filter((entry) => matchesSymbol(entry.normalizedSymbol, normalizedQuery, mode))
        .sort((left, right) => left.normalizedSymbol.localeCompare(right.normalizedSymbol)));
  const siteIds = new Set(matches.flatMap((entry) => [...entry.readSiteIds, ...entry.writeSiteIds]));
  const callIds = new Set(matches.flatMap((entry) => entry.callSiteIds));
  const runtime = executionQueryMaps(index);
  return {
    query: symbol,
    normalizedQuery,
    matches,
    writes: [...siteIds]
      .map((siteId) => runtime.writesById.get(siteId))
      .filter((site): site is WriteSite => Boolean(site)),
    calls: [...new Set([...callIds, ...siteIds])]
      .map((callId) => runtime.callsById.get(callId))
      .filter((site): site is CallSite => Boolean(site))
  };
}
