import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type PlcFamily = "S7-1200" | "S7-1500" | "unknown";
export type ReferenceMode = "read" | "write" | "readwrite" | "unknown";

export type KnowledgeItem = {
  name?: string;
  number?: string;
  kind?: string;
  programmingLanguage?: string;
  relativePath?: string;
  sha256?: string;
};

export type KnowledgeExportIndex = {
  generatedAt?: string;
  exportDir?: string;
  items?: KnowledgeItem[];
  calls?: Array<Record<string, unknown>>;
  byKind?: unknown;
  byLanguage?: unknown;
};

export type SymbolReference = {
  symbol: string;
  normalizedSymbol: string;
  scope: string;
  mode: ReferenceMode;
  confidence: "high" | "medium" | "low";
  ownerName: string;
  ownerNumber: string;
  ownerKind: string;
  language: string;
  relativePath: string;
  lineNumber: number;
  contextKind: "SCL" | "LAD_FBD" | "GRAPH_ACTION";
  context: string;
  stepName?: string;
  stepNumber?: string;
  qualifier?: string;
};

export type SymbolFlow = {
  target: string;
  normalizedTarget: string;
  sources: string[];
  normalizedSources: string[];
  confidence: "high" | "medium" | "low";
  ownerName: string;
  ownerNumber: string;
  language: string;
  relativePath: string;
  lineNumber: number;
  contextKind: "SCL" | "LAD_FBD" | "GRAPH_ACTION";
  context: string;
};

export type ReferenceIndex = {
  schemaVersion: 2;
  analyzerVersion: string;
  generatedAt: string;
  exportDir: string;
  sourceSignature: string;
  filesIndexed: number;
  filesSkipped: number;
  parseErrors: Array<{ relativePath: string; error: string }>;
  projectProfile: ProjectProfile;
  definitions: Array<Record<string, unknown>>;
  references: SymbolReference[];
  flows: SymbolFlow[];
  counts: {
    references: number;
    definitions: number;
    flows: number;
    reads: number;
    writes: number;
    readwrites: number;
    unknown: number;
  };
};

export type ProjectProfile = {
  family: PlcFamily;
  confidence: "high" | "medium" | "low";
  projectName: string;
  stationNames: string[];
  cpuOrderNumbers: string[];
  firmwareVersions: string[];
  evidence: string[];
  commonOfflineCapabilities: string[];
  familyAdapter: string;
};

export type AnalysisNote = {
  subject: string;
  normalizedSubject: string;
  summary: string;
  facts: string[];
  evidence: string[];
  confidence: "verified" | "mixed" | "inference";
  sourceSignature: string;
  updatedAt: string;
};

type AnalysisNotesFile = {
  schemaVersion: 1;
  exportDir: string;
  notes: AnalysisNote[];
};

type Owner = {
  name: string;
  number: string;
  kind: string;
  language: string;
  relativePath: string;
};

export type SingleBlockAnalysis = {
  analyzerVersion: string;
  references: SymbolReference[];
  flows: SymbolFlow[];
  counts: {
    references: number;
    flows: number;
    reads: number;
    writes: number;
    readwrites: number;
    unknown: number;
  };
};

type ReadXml = (item: KnowledgeItem) => Promise<{ text: string; fullPath: string }>;

const REFERENCE_INDEX_FILE = "tia-reference-index.json";
const ANALYSIS_NOTES_FILE = "tia-analysis-notes.json";
export const KNOWLEDGE_ANALYZER_VERSION = "2.1";

type JsonCacheEntry<T> = {
  mtimeMs: number;
  size: number;
  value: T;
};

const referenceIndexCache = new Map<string, JsonCacheEntry<ReferenceIndex>>();
const analysisNotesCache = new Map<string, JsonCacheEntry<AnalysisNotesFile>>();
const MAX_REFERENCE_CACHE_ENTRIES = 4;
const MAX_NOTES_CACHE_ENTRIES = 16;

function setLruCache<T>(cache: Map<string, JsonCacheEntry<T>>, key: string, entry: JsonCacheEntry<T>, maxEntries: number): void {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

async function rememberJson<T>(cache: Map<string, JsonCacheEntry<T>>, filePath: string, value: T, maxEntries: number): Promise<void> {
  const fileStat = await stat(filePath);
  setLruCache(cache, filePath, { mtimeMs: fileStat.mtimeMs, size: fileStat.size, value }, maxEntries);
}

async function loadCachedJson<T>(cache: Map<string, JsonCacheEntry<T>>, filePath: string, maxEntries: number): Promise<T> {
  const fileStat = await stat(filePath);
  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
    setLruCache(cache, filePath, cached, maxEntries);
    return cached.value;
  }
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as T;
  setLruCache(cache, filePath, { mtimeMs: fileStat.mtimeMs, size: fileStat.size, value: parsed }, maxEntries);
  return parsed;
}

export function computeSourceSignature(index: KnowledgeExportIndex): string {
  const hash = createHash("sha256");
  const records = [...(index.items ?? [])]
    .map((item) => [item.kind ?? "", item.number ?? "", item.name ?? "", item.relativePath ?? "", item.sha256 ?? ""].join("\u0000"))
    .sort();
  for (const record of records) hash.update(record).update("\n");
  return hash.digest("hex");
}

export function referenceIndexPath(exportDir: string): string {
  return path.join(exportDir, "_codex_index", REFERENCE_INDEX_FILE);
}

export function analysisNotesPath(exportDir: string): string {
  return path.join(exportDir, "_codex_index", ANALYSIS_NOTES_FILE);
}

export async function loadReferenceIndex(exportDir: string): Promise<ReferenceIndex | null> {
  const filePath = referenceIndexPath(exportDir);
  if (!existsSync(filePath)) return null;
  try {
    const loaded = await loadCachedJson(referenceIndexCache, filePath, MAX_REFERENCE_CACHE_ENTRIES);
    if (loaded.schemaVersion !== 2 || loaded.analyzerVersion !== KNOWLEDGE_ANALYZER_VERSION) return null;
    return loaded;
  } catch {
    referenceIndexCache.delete(filePath);
    return null;
  }
}

function decodeXml(value: string): string {
  return value
    .replace(/&#xA;|&#10;/gi, "\n")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function normalizeSymbol(symbol: string): string {
  return decodeXml(symbol)
    .replace(/\s+/g, "")
    .replace(/"([^"]+)"/g, "$1")
    .replace(/^#/, "")
    .toLowerCase();
}

function createLineNumberLookup(text: string): (offset: number) => number {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return (offset: number) => {
    const bounded = Math.max(0, Math.min(offset, text.length));
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (starts[middle] <= bounded) low = middle + 1;
      else high = middle;
    }
    return Math.max(1, low);
  };
}

function attribute(xml: string, name: string): string {
  const match = new RegExp(`\\b${name}="([^"]*)"`, "i").exec(xml);
  return match ? decodeXml(match[1]) : "";
}

function symbolFromAccess(accessXml: string): { symbol: string; scope: string } | null {
  const scope = attribute(accessXml, "Scope");
  if (/LiteralConstant|TypedConstant/i.test(scope)) return null;
  const symbolMatch = /<Symbol\b[^>]*>([\s\S]*?)<\/Symbol>/i.exec(accessXml);
  if (!symbolMatch) return null;
  const components: string[] = [];
  const componentRegex = /<Component\b[^>]*\bName="([^"]*)"[^>]*>/gi;
  let componentMatch: RegExpExecArray | null;
  while ((componentMatch = componentRegex.exec(symbolMatch[1]))) {
    components.push(decodeXml(componentMatch[1]));
  }
  if (components.length === 0) return null;
  return { symbol: components.join("."), scope };
}

function compactContext(value: string, maxLength = 600): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength)}…`;
}

function ownerFromItem(item: KnowledgeItem): Owner {
  return {
    name: item.name ?? "",
    number: item.number ?? "",
    kind: item.kind ?? "",
    language: item.programmingLanguage ?? "",
    relativePath: item.relativePath ?? ""
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function combineModes(modes: ReferenceMode[]): ReferenceMode {
  const known = new Set(modes.filter((mode) => mode !== "unknown"));
  if (known.has("readwrite") || (known.has("read") && known.has("write"))) return "readwrite";
  if (known.has("write")) return "write";
  if (known.has("read")) return "read";
  return "unknown";
}

function fallbackAssignmentSource(rendered: string): string {
  const assignment = /:=\s*(.*?)\s*;?\s*$/s.exec(rendered);
  const rightHandSide = assignment?.[1]?.trim() ?? "";
  if (!rightHandSide) return "";
  const prefix = /^(?:[-+]?\d+(?:\.\d+)?|true|false|'[^']*'|"[^"]*")$/i.test(rightHandSide)
    ? "constant"
    : "expression";
  return `${prefix}:${compactContext(rightHandSide, 200)}`;
}

function reference(owner: Owner, symbol: string, scope: string, mode: ReferenceMode, confidence: SymbolReference["confidence"], lineNumber: number, contextKind: SymbolReference["contextKind"], context: string, extra: Partial<SymbolReference> = {}): SymbolReference {
  return {
    symbol,
    normalizedSymbol: normalizeSymbol(symbol),
    scope,
    mode,
    confidence,
    ownerName: owner.name,
    ownerNumber: owner.number,
    ownerKind: owner.kind,
    language: owner.language,
    relativePath: owner.relativePath,
    lineNumber,
    contextKind,
    context: compactContext(context),
    ...extra
  };
}

type SclEvent =
  | { kind: "access"; symbol: string; scope: string; offset: number }
  | { kind: "token"; text: string; offset: number }
  | { kind: "newline"; text: string; offset: number };

function processScl(text: string, owner: Owner, lineNumberAt: (offset: number) => number): { references: SymbolReference[]; flows: SymbolFlow[]; ranges: Array<[number, number]> } {
  const references: SymbolReference[] = [];
  const flows: SymbolFlow[] = [];
  const ranges: Array<[number, number]> = [];
  const structuredTextRegex = /<StructuredText\b[^>]*>([\s\S]*?)<\/StructuredText>/gi;
  let structuredMatch: RegExpExecArray | null;

  while ((structuredMatch = structuredTextRegex.exec(text))) {
    const full = structuredMatch[0];
    const baseOffset = structuredMatch.index;
    ranges.push([baseOffset, baseOffset + full.length]);
    const body = structuredMatch[1];
    const events: SclEvent[] = [];
    const eventRegex = /<LineComment\b[^>]*>[\s\S]*?<\/LineComment>|<Access\b[^>]*>[\s\S]*?<\/Access>|<Token\b[^>]*\bText="([^"]*)"[^>]*\/?>(?:<\/Token>)?|<NewLine\b[^>]*\/?>/gi;
    let eventMatch: RegExpExecArray | null;
    while ((eventMatch = eventRegex.exec(body))) {
      const raw = eventMatch[0];
      const offset = baseOffset + full.indexOf(body) + eventMatch.index;
      if (/^<LineComment/i.test(raw)) continue;
      if (/^<Access/i.test(raw)) {
        const parsed = symbolFromAccess(raw);
        if (parsed) events.push({ kind: "access", ...parsed, offset });
      } else if (/^<Token/i.test(raw)) {
        events.push({ kind: "token", text: decodeXml(eventMatch[1] ?? ""), offset });
      } else {
        events.push({ kind: "newline", text: "\n", offset });
      }
    }

    let statement: SclEvent[] = [];
    const flush = () => {
      if (statement.length === 0) return;
      const significant = statement.filter((event) => event.kind !== "newline");
      const accesses = significant.filter((event): event is Extract<SclEvent, { kind: "access" }> => event.kind === "access");
      if (accesses.length === 0) {
        statement = [];
        return;
      }
      const rendered = significant.map((event) => event.kind === "access" ? event.symbol : event.text).join(" ");
      const statementRefs: SymbolReference[] = [];
      for (let index = 0; index < significant.length; index += 1) {
        const event = significant[index];
        if (event.kind !== "access") continue;
        const previous = significant[index - 1];
        const next = significant[index + 1];
        let mode: ReferenceMode = "read";
        let confidence: SymbolReference["confidence"] = "high";
        if (next?.kind === "token" && [":=", "=:", "+=", "-=", "*=", "/="].includes(next.text)) {
          mode = ["+=", "-=", "*=", "/="].includes(next.text) ? "readwrite" : "write";
        } else if (previous?.kind === "token" && previous.text === "=>") {
          mode = "write";
        } else if (previous?.kind === "token" && previous.text === ":=") {
          mode = "read";
        } else if (rendered.includes("(") && rendered.includes(":=")) {
          confidence = "medium";
        }
        const ref = reference(owner, event.symbol, event.scope, mode, confidence, lineNumberAt(event.offset), "SCL", rendered);
        references.push(ref);
        statementRefs.push(ref);
      }
      const writers = statementRefs.filter((ref) => ref.mode === "write" || ref.mode === "readwrite");
      const readers = statementRefs.filter((ref) => ref.mode === "read" || ref.mode === "readwrite");
      for (const writer of writers) {
        const fallback = fallbackAssignmentSource(rendered);
        const sources = unique([...readers.map((reader) => reader.symbol), ...(readers.length === 0 && fallback ? [fallback] : [])]);
        if (sources.length === 0) continue;
        flows.push({
          target: writer.symbol,
          normalizedTarget: writer.normalizedSymbol,
          sources,
          normalizedSources: sources.map(normalizeSymbol),
          confidence: statementRefs.some((ref) => ref.confidence !== "high") ? "medium" : "high",
          ownerName: owner.name,
          ownerNumber: owner.number,
          language: owner.language,
          relativePath: owner.relativePath,
          lineNumber: writer.lineNumber,
          contextKind: "SCL",
          context: compactContext(rendered)
        });
      }
      statement = [];
    };

    for (const event of events) {
      statement.push(event);
      if (event.kind === "token" && event.text === ";") flush();
    }
    flush();
  }
  return { references, flows, ranges };
}

function graphSymbols(text: string): Array<{ symbol: string; index: number }> {
  const result: Array<{ symbol: string; index: number }> = [];
  const segment = '(?:"[^"]+"|#?[A-Za-z_\\u0080-\\uFFFF][A-Za-z0-9_\\u0080-\\uFFFF]*|%[IQM][A-Za-z0-9_.]+)';
  const regex = new RegExp(`${segment}(?:\\.${segment}|\\[[^\\]]+\\])*`, "g");
  const keywords = new Set(["true", "false", "if", "then", "else", "end_if", "and", "or", "not"]);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) {
    const normalized = normalizeSymbol(match[0]);
    if (keywords.has(normalized)) continue;
    result.push({ symbol: match[0].replace(/"/g, ""), index: match.index });
  }
  return result;
}

function processGraphActions(text: string, owner: Owner, lineNumberAt: (offset: number) => number): { references: SymbolReference[]; flows: SymbolFlow[]; ranges: Array<[number, number]> } {
  const references: SymbolReference[] = [];
  const flows: SymbolFlow[] = [];
  const ranges: Array<[number, number]> = [];
  const stepRegex = /<Step\b([^>]*)>([\s\S]*?)<\/Step>/gi;
  let stepMatch: RegExpExecArray | null;
  while ((stepMatch = stepRegex.exec(text))) {
    const stepStart = stepMatch.index;
    const stepName = attribute(stepMatch[1], "Name");
    const stepNumber = attribute(stepMatch[1], "Number");
    const actionRegex = /<Action\b([^>]*)>([\s\S]*?)<\/Action>|<Action\b([^>]*)\/>/gi;
    let actionMatch: RegExpExecArray | null;
    while ((actionMatch = actionRegex.exec(stepMatch[2]))) {
      const actionText = actionMatch[2] ?? "";
      if (!actionText) continue;
      const actionOffset = stepStart + stepMatch[0].indexOf(stepMatch[2]) + actionMatch.index;
      ranges.push([actionOffset, actionOffset + actionMatch[0].length]);
      const qualifier = attribute(actionMatch[1] ?? actionMatch[3] ?? "", "Qualifier") || "N";
      const tokenValues: string[] = [];
      const tokenRegex = /<Token\b[^>]*\bText="([^"]*)"[^>]*\/?>(?:<\/Token>)?/gi;
      let tokenMatch: RegExpExecArray | null;
      while ((tokenMatch = tokenRegex.exec(actionText))) tokenValues.push(decodeXml(tokenMatch[1] ?? ""));
      const rendered = tokenValues.join(" ").replace(/\s+/g, " ").trim();
      const symbols = graphSymbols(rendered);
      if (symbols.length === 0) continue;
      const assignmentAt = rendered.indexOf(":=");
      const actionRefs: SymbolReference[] = [];
      for (const item of symbols) {
        const mode: ReferenceMode = assignmentAt >= 0 ? (item.index < assignmentAt ? "write" : "read") : "write";
        const ref = reference(owner, item.symbol, "GraphAction", mode, assignmentAt >= 0 ? "high" : "medium", lineNumberAt(actionOffset), "GRAPH_ACTION", rendered, { stepName, stepNumber, qualifier });
        references.push(ref);
        actionRefs.push(ref);
      }
      const writers = actionRefs.filter((ref) => ref.mode === "write" || ref.mode === "readwrite");
      const readers = actionRefs.filter((ref) => ref.mode === "read" || ref.mode === "readwrite");
      for (const writer of writers) {
        const fallback = fallbackAssignmentSource(rendered);
        const sources = unique([...readers.map((reader) => reader.symbol), ...(readers.length === 0 && fallback ? [fallback] : [])]);
        if (sources.length === 0) continue;
        flows.push({
          target: writer.symbol,
          normalizedTarget: writer.normalizedSymbol,
          sources,
          normalizedSources: sources.map(normalizeSymbol),
          confidence: "high",
          ownerName: owner.name,
          ownerNumber: owner.number,
          language: owner.language,
          relativePath: owner.relativePath,
          lineNumber: writer.lineNumber,
          contextKind: "GRAPH_ACTION",
          context: compactContext(`${stepName} [${qualifier}] ${rendered}`)
        });
      }
    }
  }
  return { references, flows, ranges };
}

function classifyPartPin(partName: string, pinName: string): ReferenceMode {
  const part = partName.toLowerCase();
  const pin = pinName.toLowerCase();
  if (part.includes("contact")) return "read";
  if (part.includes("coil")) return "write";
  if (part.includes("move") || part.includes("convert") || part.includes("assign")) {
    if (/^(out|output|dest|destination)/.test(pin)) return "write";
    if (/^(in|input|src|source)/.test(pin)) return "read";
  }
  if (/^(in|input|operand|src|source|en)/.test(pin)) return "read";
  if (/^(out|output|dest|destination)/.test(pin)) return "write";
  return "unknown";
}

function processFlgNets(text: string, owner: Owner, lineNumberAt: (offset: number) => number): { references: SymbolReference[]; flows: SymbolFlow[]; ranges: Array<[number, number]> } {
  const references: SymbolReference[] = [];
  const flows: SymbolFlow[] = [];
  const ranges: Array<[number, number]> = [];
  const netRegex = /<FlgNet\b[^>]*>([\s\S]*?)<\/FlgNet>/gi;
  let netMatch: RegExpExecArray | null;
  while ((netMatch = netRegex.exec(text))) {
    const netXml = netMatch[0];
    const netOffset = netMatch.index;
    ranges.push([netOffset, netOffset + netXml.length]);
    const parts = new Map<string, string>();
    const partRegex = /<Part\b[^>]*>/gi;
    let partMatch: RegExpExecArray | null;
    while ((partMatch = partRegex.exec(netXml))) {
      const uid = attribute(partMatch[0], "UId");
      const name = attribute(partMatch[0], "Name");
      if (uid) parts.set(uid, name);
    }
    const calls = new Map<string, { name: string; parameters: Map<string, string> }>();
    const callRegex = /<Call\b([^>]*)>([\s\S]*?)<\/Call>/gi;
    let callMatch: RegExpExecArray | null;
    while ((callMatch = callRegex.exec(netXml))) {
      const uid = attribute(callMatch[1], "UId");
      const info = /<CallInfo\b([^>]*)>/i.exec(callMatch[2]);
      const parameters = new Map<string, string>();
      const parameterRegex = /<Parameter\b[^>]*>/gi;
      let parameterMatch: RegExpExecArray | null;
      while ((parameterMatch = parameterRegex.exec(callMatch[2]))) {
        parameters.set(attribute(parameterMatch[0], "Name"), attribute(parameterMatch[0], "Section"));
      }
      if (uid) calls.set(uid, { name: info ? attribute(info[1], "Name") : "", parameters });
    }
    const connections = new Map<string, Array<{ uid: string; pin: string }>>();
    const wireRegex = /<Wire\b[^>]*>([\s\S]*?)<\/Wire>/gi;
    let wireMatch: RegExpExecArray | null;
    while ((wireMatch = wireRegex.exec(netXml))) {
      const accessIds: string[] = [];
      const identRegex = /<IdentCon\b[^>]*\bUId="([^"]+)"[^>]*\/?>/gi;
      let identMatch: RegExpExecArray | null;
      while ((identMatch = identRegex.exec(wireMatch[1]))) accessIds.push(identMatch[1]);
      const nameCons: Array<{ uid: string; pin: string }> = [];
      const nameRegex = /<NameCon\b[^>]*>/gi;
      let nameMatch: RegExpExecArray | null;
      while ((nameMatch = nameRegex.exec(wireMatch[1]))) {
        nameCons.push({ uid: attribute(nameMatch[0], "UId"), pin: attribute(nameMatch[0], "Name") });
      }
      for (const accessId of accessIds) {
        const existing = connections.get(accessId) ?? [];
        existing.push(...nameCons);
        connections.set(accessId, existing);
      }
    }
    const netRefs: SymbolReference[] = [];
    const accessRegex = /<Access\b[^>]*>[\s\S]*?<\/Access>/gi;
    let accessMatch: RegExpExecArray | null;
    while ((accessMatch = accessRegex.exec(netXml))) {
      const parsed = symbolFromAccess(accessMatch[0]);
      if (!parsed) continue;
      const uid = attribute(accessMatch[0], "UId");
      const modes: ReferenceMode[] = [];
      const contextParts: string[] = [];
      for (const connection of connections.get(uid) ?? []) {
        const call = calls.get(connection.uid);
        if (call) {
          const section = call.parameters.get(connection.pin) ?? "";
          modes.push(section === "Input" ? "read" : section === "Output" ? "write" : section === "InOut" ? "readwrite" : "unknown");
          contextParts.push(`Call ${call.name}.${connection.pin} [${section || "unknown"}]`);
          continue;
        }
        const part = parts.get(connection.uid);
        if (part) {
          modes.push(classifyPartPin(part, connection.pin));
          contextParts.push(`Part ${part}.${connection.pin}`);
        }
      }
      const mode = combineModes(modes);
      const confidence: SymbolReference["confidence"] = mode === "unknown" ? "low" : contextParts.some((item) => item.includes("[unknown]")) ? "medium" : "high";
      const ref = reference(owner, parsed.symbol, parsed.scope, mode, confidence, lineNumberAt(netOffset + accessMatch.index), "LAD_FBD", contextParts.join("; ") || "Unresolved FlgNet access");
      references.push(ref);
      netRefs.push(ref);
    }
    const readers = netRefs.filter((ref) => ref.mode === "read" || ref.mode === "readwrite");
    const writers = netRefs.filter((ref) => ref.mode === "write" || ref.mode === "readwrite");
    for (const writer of writers) {
      const sources = unique(readers.map((reader) => reader.symbol));
      if (sources.length === 0) continue;
      flows.push({
        target: writer.symbol,
        normalizedTarget: writer.normalizedSymbol,
        sources,
        normalizedSources: sources.map(normalizeSymbol),
        confidence: "medium",
        ownerName: owner.name,
        ownerNumber: owner.number,
        language: owner.language,
        relativePath: owner.relativePath,
        lineNumber: writer.lineNumber,
        contextKind: "LAD_FBD",
        context: compactContext(writer.context)
      });
    }
  }
  return { references, flows, ranges };
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

function detectFamilyFromText(value: string): PlcFamily {
  if (/S7[-_ ]?1200|S71200|System:Device\.S71200|6ES7\s*21[1-7]/i.test(value)) return "S7-1200";
  if (/S7[-_ ]?1500|S71500|System:Device\.S71500|6ES7\s*51[1-8]/i.test(value)) return "S7-1500";
  return "unknown";
}

export async function detectProjectProfile(exportDir: string, index: KnowledgeExportIndex): Promise<ProjectProfile> {
  const evidence: string[] = [];
  const stationNames: string[] = [];
  const cpuOrderNumbers: string[] = [];
  const firmwareVersions: string[] = [];
  let family: PlcFamily = "unknown";
  let projectName = "";
  const candidates = [path.join(exportDir, "probe-cs.json"), path.join(exportDir, "export-cs.json")];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const raw = await readFile(candidate, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      projectName ||= String(parsed.projectName ?? "");
      const detected = detectFamilyFromText(raw);
      if (detected !== "unknown") {
        family = detected;
        evidence.push(`${path.basename(candidate)} identifies ${detected}`);
      }
      const orderRegex = /OrderNumber:([^"/]+)(?:\/V([0-9.]+))?/gi;
      let orderMatch: RegExpExecArray | null;
      while ((orderMatch = orderRegex.exec(raw))) {
        cpuOrderNumbers.push(orderMatch[1].trim());
        if (orderMatch[2]) firmwareVersions.push(orderMatch[2]);
      }
      const stationRegex = /"name":"([^"]*(?:S7-1200|S7-1500|S71200|S71500)[^"]*)"/gi;
      let stationMatch: RegExpExecArray | null;
      while ((stationMatch = stationRegex.exec(raw))) stationNames.push(stationMatch[1]);
    } catch {
      evidence.push(`${path.basename(candidate)} exists but could not be parsed`);
    }
  }
  if (family === "unknown") {
    const pathEvidence = [exportDir, ...(index.items ?? []).slice(0, 50).map((item) => item.relativePath ?? "")].join("\n");
    family = detectFamilyFromText(pathEvidence);
    if (family !== "unknown") evidence.push(`Export paths identify ${family}`);
  }
  if (!projectName) projectName = path.basename(exportDir);
  return {
    family,
    confidence: evidence.some((item) => item.includes("probe-cs.json")) ? "high" : family === "unknown" ? "low" : "medium",
    projectName,
    stationNames: unique(stationNames),
    cpuOrderNumbers: unique(cpuOrderNumbers),
    firmwareVersions: unique(firmwareVersions),
    evidence,
    commonOfflineCapabilities: [
      "Simatic ML block and DB inventory",
      "OB/FB/FC call graph",
      "PLC tag and address lookup",
      "SCL/LAD/FBD/GRAPH symbol references",
      "persistent analysis notes bound to export signature"
    ],
    familyAdapter: family === "unknown" ? "generic-simaticml" : family.toLowerCase()
  };
}

export async function buildReferenceIndex(exportDir: string, index: KnowledgeExportIndex, readXml: ReadXml, definitions: Array<Record<string, unknown>> = []): Promise<ReferenceIndex> {
  const references: SymbolReference[] = [];
  const flows: SymbolFlow[] = [];
  const parseErrors: Array<{ relativePath: string; error: string }> = [];
  let filesIndexed = 0;
  let filesSkipped = 0;
  for (const item of index.items ?? []) {
    if (!["OB", "FB", "FC"].includes(item.kind ?? "")) {
      filesSkipped += 1;
      continue;
    }
    try {
      const { text } = await readXml(item);
      const owner = ownerFromItem(item);
      const lineNumberAt = createLineNumberLookup(text);
      const scl = processScl(text, owner, lineNumberAt);
      const graph = processGraphActions(text, owner, lineNumberAt);
      const flg = processFlgNets(text, owner, lineNumberAt);
      references.push(...scl.references, ...graph.references, ...flg.references);
      flows.push(...scl.flows, ...graph.flows, ...flg.flows);
      filesIndexed += 1;
    } catch (error) {
      parseErrors.push({ relativePath: item.relativePath ?? "", error: error instanceof Error ? error.message : String(error) });
    }
  }
  const result: ReferenceIndex = {
    schemaVersion: 2,
    analyzerVersion: KNOWLEDGE_ANALYZER_VERSION,
    generatedAt: new Date().toISOString(),
    exportDir,
    sourceSignature: computeSourceSignature(index),
    filesIndexed,
    filesSkipped,
    parseErrors,
    projectProfile: await detectProjectProfile(exportDir, index),
    definitions,
    references,
    flows,
    counts: {
      references: references.length,
      definitions: definitions.length,
      flows: flows.length,
      reads: references.filter((ref) => ref.mode === "read").length,
      writes: references.filter((ref) => ref.mode === "write").length,
      readwrites: references.filter((ref) => ref.mode === "readwrite").length,
      unknown: references.filter((ref) => ref.mode === "unknown").length
    }
  };
  const outputPath = referenceIndexPath(exportDir);
  await atomicWriteJson(outputPath, result);
  await rememberJson(referenceIndexCache, outputPath, result, MAX_REFERENCE_CACHE_ENTRIES);
  return result;
}

export function analyzeSingleBlockXml(text: string, item: KnowledgeItem): SingleBlockAnalysis {
  const owner = ownerFromItem(item);
  const lineNumberAt = createLineNumberLookup(text);
  const scl = processScl(text, owner, lineNumberAt);
  const graph = processGraphActions(text, owner, lineNumberAt);
  const flg = processFlgNets(text, owner, lineNumberAt);
  const references = [...scl.references, ...graph.references, ...flg.references];
  const flows = [...scl.flows, ...graph.flows, ...flg.flows];
  return {
    analyzerVersion: KNOWLEDGE_ANALYZER_VERSION,
    references,
    flows,
    counts: {
      references: references.length,
      flows: flows.length,
      reads: references.filter((ref) => ref.mode === "read").length,
      writes: references.filter((ref) => ref.mode === "write").length,
      readwrites: references.filter((ref) => ref.mode === "readwrite").length,
      unknown: references.filter((ref) => ref.mode === "unknown").length
    }
  };
}

function symbolMatches(value: string, query: string, mode: "exact" | "suffix" | "contains"): boolean {
  const normalizedValue = normalizeSymbol(value);
  const normalizedQuery = normalizeSymbol(query);
  if (mode === "exact") return normalizedValue === normalizedQuery;
  if (mode === "suffix") return normalizedValue === normalizedQuery || normalizedValue.endsWith(`.${normalizedQuery}`);
  return normalizedValue.includes(normalizedQuery);
}

export function queryReferenceIndex(index: ReferenceIndex, query: string, match: "exact" | "suffix" | "contains", limit: number) {
  const matches = index.references.filter((ref) => symbolMatches(ref.symbol, query, match));
  const writers = matches.filter((ref) => ref.mode === "write" || ref.mode === "readwrite").slice(0, limit);
  const readers = matches.filter((ref) => ref.mode === "read" || ref.mode === "readwrite").slice(0, limit);
  const unknown = matches.filter((ref) => ref.mode === "unknown").slice(0, limit);
  const upstreamFlows = index.flows.filter((flow) => symbolMatches(flow.target, query, match)).slice(0, limit);
  const downstreamFlows = index.flows.filter((flow) => flow.sources.some((source) => symbolMatches(source, query, match))).slice(0, limit);
  return {
    query,
    normalizedQuery: normalizeSymbol(query),
    match,
    totalReferences: matches.length,
    writers,
    readers,
    unknown,
    upstreamFlows,
    downstreamFlows,
    truncated: matches.length > writers.length + readers.length + unknown.length
  };
}

function traceDataFlowDirection(
  index: ReferenceIndex,
  query: string,
  direction: "upstream" | "downstream",
  match: "exact" | "suffix" | "contains",
  maxDepth: number,
  maxNodes: number
) {
  const queue: Array<{ symbol: string; depth: number; initial: boolean }> = [{ symbol: query, depth: 0, initial: true }];
  const visited = new Set<string>();
  const nodes = new Map<string, { symbol: string; normalizedSymbol: string; depth: number }>();
  const edges: Array<Record<string, unknown>> = [];
  const edgeKeys = new Set<string>();
  const unresolvedLeaves: string[] = [];
  let truncated = false;

  while (queue.length > 0) {
    const current = queue.shift()!;
    const normalizedCurrent = normalizeSymbol(current.symbol);
    if (!normalizedCurrent || visited.has(normalizedCurrent)) continue;
    if (nodes.size >= maxNodes) {
      truncated = true;
      break;
    }
    visited.add(normalizedCurrent);
    nodes.set(normalizedCurrent, { symbol: current.symbol, normalizedSymbol: normalizedCurrent, depth: current.depth });
    if (current.depth >= maxDepth) continue;

    const currentMatch = current.initial ? match : "exact";
    const matchingFlows = direction === "upstream"
      ? index.flows.filter((flow) => symbolMatches(flow.target, current.symbol, currentMatch))
      : index.flows.filter((flow) => flow.sources.some((source) => symbolMatches(source, current.symbol, currentMatch)));

    if (matchingFlows.length === 0) {
      unresolvedLeaves.push(current.symbol);
      continue;
    }

    for (const flow of matchingFlows) {
      const neighbors = direction === "upstream" ? flow.sources : [flow.target];
      for (const neighbor of neighbors) {
        if (nodes.size + queue.length >= maxNodes) {
          truncated = true;
          break;
        }
        const source = direction === "upstream" ? neighbor : current.symbol;
        const target = direction === "upstream" ? flow.target : neighbor;
        const edgeKey = [normalizeSymbol(source), normalizeSymbol(target), flow.relativePath, flow.lineNumber].join("|");
        if (!edgeKeys.has(edgeKey)) {
          edgeKeys.add(edgeKey);
          edges.push({
            source,
            target,
            confidence: flow.confidence,
            ownerName: flow.ownerName,
            ownerNumber: flow.ownerNumber,
            language: flow.language,
            relativePath: flow.relativePath,
            lineNumber: flow.lineNumber,
            contextKind: flow.contextKind,
            context: flow.context
          });
        }
        const normalizedNeighbor = normalizeSymbol(neighbor);
        if (normalizedNeighbor && !visited.has(normalizedNeighbor)) {
          queue.push({ symbol: neighbor, depth: current.depth + 1, initial: false });
        }
      }
      if (truncated) break;
    }
    if (truncated) break;
  }

  return {
    direction,
    nodeCount: nodes.size,
    edgeCount: edges.length,
    nodes: [...nodes.values()],
    edges,
    unresolvedLeaves: unique(unresolvedLeaves),
    truncated
  };
}

export function traceDataFlow(
  index: ReferenceIndex,
  query: string,
  direction: "upstream" | "downstream" | "both",
  match: "exact" | "suffix" | "contains",
  maxDepth: number,
  maxNodes: number
) {
  return {
    query,
    normalizedQuery: normalizeSymbol(query),
    match,
    maxDepth,
    maxNodes,
    upstream: direction === "downstream" ? null : traceDataFlowDirection(index, query, "upstream", match, maxDepth, maxNodes),
    downstream: direction === "upstream" ? null : traceDataFlowDirection(index, query, "downstream", match, maxDepth, maxNodes),
    limitations: [
      "The trace is derived from exported SCL assignments, GRAPH actions, and LAD/FBD network heuristics.",
      "Dynamic addressing, indirect access, optimized runtime layout, and logic outside the current export may remain unresolved.",
      "Confidence and source XML location are attached to every edge; verify medium/low-confidence edges before field changes."
    ]
  };
}

export async function loadAnalysisNotes(exportDir: string): Promise<AnalysisNotesFile> {
  const filePath = analysisNotesPath(exportDir);
  if (!existsSync(filePath)) return { schemaVersion: 1, exportDir, notes: [] };
  return loadCachedJson(analysisNotesCache, filePath, MAX_NOTES_CACHE_ENTRIES);
}

export async function saveAnalysisNote(exportDir: string, sourceSignature: string, note: Omit<AnalysisNote, "normalizedSubject" | "sourceSignature" | "updatedAt">): Promise<AnalysisNote> {
  const file = await loadAnalysisNotes(exportDir);
  const saved: AnalysisNote = {
    ...note,
    normalizedSubject: normalizeSymbol(note.subject),
    sourceSignature,
    updatedAt: new Date().toISOString()
  };
  const existingIndex = file.notes.findIndex((item) => item.normalizedSubject === saved.normalizedSubject);
  if (existingIndex >= 0) file.notes[existingIndex] = saved;
  else file.notes.push(saved);
  const outputPath = analysisNotesPath(exportDir);
  await atomicWriteJson(outputPath, file);
  await rememberJson(analysisNotesCache, outputPath, file, MAX_NOTES_CACHE_ENTRIES);
  return saved;
}

export async function queryAnalysisNotes(exportDir: string, sourceSignature: string, query: string, limit: number) {
  const file = await loadAnalysisNotes(exportDir);
  const normalizedQuery = normalizeSymbol(query);
  const matches = file.notes.filter((note) => {
    const haystack = [note.subject, note.summary, ...note.facts, ...note.evidence].join("\n").toLowerCase();
    return !normalizedQuery || normalizeSymbol(haystack).includes(normalizedQuery);
  }).slice(0, limit).map((note) => ({ ...note, stale: note.sourceSignature !== sourceSignature }));
  return { query, count: matches.length, notes: matches };
}
