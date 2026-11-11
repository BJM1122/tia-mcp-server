import { type JsonValue } from "./core/results.js";
import {
  asArray, extractSimaticObject, flattenInterfaceMembers, objectListText, scalarBoolean
} from "./core/simatic-objects.js";
import { parseSimaticXmlText, scalarString } from "./core/simatic-xml.js";
import { type ExecutionModelIndex, queryExecutionSymbol } from "./execution-model.js";
import {
  type ExportIndex, type ExportIndexCall, type ExportIndexItem, isExecutableBlockKind, readIndexedXml
} from "./export-index.js";
import {
  buildReferenceIndex, computeSourceSignature, loadReferenceIndex, queryAnalysisNotes, queryReferenceIndex,
  type ReferenceIndex
} from "./knowledge.js";

// Read-only queries over a loaded export index: block lookup, symbols, call graph,
// reference index and fast lookup.

const MAX_SYMBOL_SCAN_PER_FILE = 20_000;

function matchText(value: unknown, query: string): boolean {
  return String(value ?? "").toLowerCase().includes(query.toLowerCase());
}

type BlockAlias = {
  prefix: "OB" | "FB" | "FC" | "DB";
  number: string;
  canonical: string;
};

function parseBlockAlias(query: string): BlockAlias | null {
  const match = /^\s*(OB|FB|FC|DB)[\s_-]*(\d+)\s*$/i.exec(query);
  if (!match) return null;
  const prefix = match[1].toUpperCase() as BlockAlias["prefix"];
  const number = String(Number(match[2]));
  return { prefix, number, canonical: `${prefix}${number}` };
}

function kindMatchesBlockAlias(kind: unknown, alias: BlockAlias): boolean {
  const normalizedKind = String(kind ?? "").toUpperCase();
  if (alias.prefix === "DB") return normalizedKind === "GLOBALDB" || normalizedKind === "INSTANCEDB" || normalizedKind === "DB";
  return normalizedKind === alias.prefix;
}

function itemMatchesBlockAlias(item: ExportIndexItem, alias: BlockAlias): boolean {
  const number = String(item.number ?? "");
  return Boolean(number) && String(Number(number)) === alias.number && kindMatchesBlockAlias(item.kind, alias);
}

function queryInterpretation(query: string): Record<string, JsonValue> {
  const alias = parseBlockAlias(query);
  return alias
    ? { type: "blockAlias", canonical: alias.canonical, kind: alias.prefix, number: alias.number }
    : { type: "textOrSymbol", normalized: query.trim().toLowerCase() };
}

export function findItems(index: ExportIndex, query: string, limit: number): ExportIndexItem[] {
  const items = index.items ?? [];
  if (!query.trim()) return items.slice(0, limit);
  const alias = parseBlockAlias(query);
  const direct = alias ? items.filter((item) => itemMatchesBlockAlias(item, alias)) : [];
  const textMatches = items.filter((item) => {
    return (
      matchText(item.name, query) ||
      matchText(item.number, query) ||
      matchText(item.kind, query) ||
      matchText(item.programmingLanguage, query) ||
      matchText(item.relativePath, query)
    );
  });
  return [...direct, ...textMatches.filter((item) => !direct.includes(item))].slice(0, limit);
}

export function findCalls(index: ExportIndex, query: string, limit: number): ExportIndexCall[] {
  const calls = index.calls ?? [];
  if (!query.trim()) return calls.slice(0, limit);
  const alias = parseBlockAlias(query);
  return calls.filter((call) => {
    return (
      Boolean(alias && call.sourceNumber && String(Number(call.sourceNumber)) === alias.number && kindMatchesBlockAlias(call.sourceKind, alias)) ||
      matchText(call.source, query) ||
      matchText(call.sourceNumber, query) ||
      matchText(call.sourceKind, query) ||
      matchText(call.target, query) ||
      matchText(call.targetBlockType, query) ||
      matchText(call.file, query)
    );
  }).slice(0, limit);
}

export function selectBlock(index: ExportIndex, args: { name?: string; number?: string; relativePath?: string }) {
  const items = index.items ?? [];
  if (args.relativePath) {
    return items.find((item) => item.relativePath?.toLowerCase() === args.relativePath?.toLowerCase());
  }
  return items.find((item) => {
    const nameOk = args.name ? item.name?.toLowerCase() === args.name.toLowerCase() : true;
    const numberOk = args.number ? item.number === args.number : true;
    return nameOk && numberOk;
  });
}

function blockIdentity(item: ExportIndexItem | undefined): string {
  if (!item) return "";
  return `${item.kind ?? ""}:${item.number ?? ""}:${item.name ?? ""}`;
}

export function blockDisplay(item: ExportIndexItem | undefined): Record<string, JsonValue> {
  if (!item) return {};
  return {
    name: item.name ?? "",
    number: item.number ?? "",
    kind: item.kind ?? "",
    programmingLanguage: item.programmingLanguage ?? "",
    secondaryType: item.secondaryType ?? "",
    relativePath: item.relativePath ?? "",
    sha256: item.sha256 ?? ""
  };
}

function callMatchesSource(call: ExportIndexCall, item: ExportIndexItem): boolean {
  if (!isExecutableBlockKind(item.kind)) return false;
  const kindMatches = call.sourceKind ? call.sourceKind === item.kind : true;
  if (item.number && call.sourceNumber === item.number && kindMatches) return true;
  return Boolean(item.name && call.source?.toLowerCase() === item.name.toLowerCase() && kindMatches);
}

function callMatchesTarget(call: ExportIndexCall, item: ExportIndexItem): boolean {
  return Boolean(item.name && call.target?.toLowerCase() === item.name.toLowerCase());
}

function uniqueCalls(calls: ExportIndexCall[]): ExportIndexCall[] {
  const seen = new Set<string>();
  const result: ExportIndexCall[] = [];
  for (const call of calls) {
    const key = [
      call.source ?? "",
      call.sourceNumber ?? "",
      call.target ?? "",
      call.targetBlockType ?? "",
      call.file ?? ""
    ].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(call);
  }
  return result;
}

export function getBlockRelations(index: ExportIndex, item: ExportIndexItem) {
  const calls = index.calls ?? [];
  const outgoingCalls = uniqueCalls(calls.filter((call) => callMatchesSource(call, item)));
  const incomingCalls = uniqueCalls(calls.filter((call) => callMatchesTarget(call, item)));
  const sameNumberItems = (index.items ?? [])
    .filter((candidate) => candidate.number && candidate.number === item.number && blockIdentity(candidate) !== blockIdentity(item))
    .map(blockDisplay);
  return { outgoingCalls, incomingCalls, sameNumberItems };
}

function itemLookupByName(index: ExportIndex): Map<string, ExportIndexItem[]> {
  const lookup = new Map<string, ExportIndexItem[]>();
  for (const item of index.items ?? []) {
    if (!item.name) continue;
    const key = item.name.toLowerCase();
    const existing = lookup.get(key) ?? [];
    existing.push(item);
    lookup.set(key, existing);
  }
  return lookup;
}

function symbolOwner(item: ExportIndexItem, objectKey: string): Record<string, JsonValue> {
  return {
    name: item.name ?? "",
    number: item.number ?? "",
    kind: item.kind ?? "",
    programmingLanguage: item.programmingLanguage ?? "",
    objectKey,
    relativePath: item.relativePath ?? ""
  };
}

function extractTagTableSymbols(parsed: unknown, item: ExportIndexItem, limit: number) {
  const object = extractSimaticObject(parsed);
  const owner = symbolOwner(item, object.key);
  const objectList = object.value.ObjectList as Record<string, unknown> | undefined;
  const tags = asArray(objectList?.["SW.Tags.PlcTag"] as unknown);
  const symbols: Array<Record<string, JsonValue>> = [];
  let truncated = false;

  for (const tag of tags) {
    if (symbols.length >= limit) {
      truncated = true;
      break;
    }
    const attributeList = (tag as Record<string, unknown>).AttributeList as Record<string, unknown> | undefined;
    symbols.push({
      symbolKind: "plcTag",
      owner: owner as JsonValue,
      section: "Tags",
      path: scalarString(attributeList?.Name),
      name: scalarString(attributeList?.Name),
      datatype: scalarString(attributeList?.DataTypeName),
      address: scalarString(attributeList?.LogicalAddress),
      accessibility: "",
      remanence: "",
      depth: 0,
      comment: objectListText(tag),
      externalAccessible: scalarBoolean(attributeList?.ExternalAccessible),
      externalVisible: scalarBoolean(attributeList?.ExternalVisible),
      externalWritable: scalarBoolean(attributeList?.ExternalWritable),
      setPoint: null
    });
  }

  return { symbols, truncated };
}

function extractInterfaceSymbols(parsed: unknown, item: ExportIndexItem, limit: number) {
  const object = extractSimaticObject(parsed);
  const owner = symbolOwner(item, object.key);
  const iface = flattenInterfaceMembers(parsed, limit);
  return {
    symbols: iface.members.map((member) => ({
      symbolKind: "interfaceMember",
      owner: owner as JsonValue,
      section: member.section ?? "",
      path: member.path ?? "",
      pathComponents: member.pathComponents ?? [],
      name: member.name ?? "",
      datatype: member.datatype ?? "",
      address: "",
      accessibility: member.accessibility ?? "",
      remanence: member.remanence ?? "",
      depth: member.depth ?? 0,
      comment: member.comment ?? "",
      externalAccessible: member.externalAccessible ?? null,
      externalVisible: member.externalVisible ?? null,
      externalWritable: member.externalWritable ?? null,
      setPoint: member.setPoint ?? null
    })),
    truncated: iface.truncated
  };
}

function extractSymbolsFromParsed(parsed: unknown, item: ExportIndexItem, limit: number) {
  const object = extractSimaticObject(parsed);
  if (object.key === "SW.Tags.PlcTagTable") return extractTagTableSymbols(parsed, item, limit);
  return extractInterfaceSymbols(parsed, item, limit);
}

export function itemMatchesSymbolScope(item: ExportIndexItem, scope: "all" | "blocks" | "db" | "types" | "tags"): boolean {
  if (scope === "all") return true;
  if (scope === "tags") return (item.kind ?? "").startsWith("Tag.");
  if (scope === "db") return (item.kind ?? "").includes("DB");
  if (scope === "types") return /(Type|UDT|PlcType)/i.test(item.kind ?? "");
  return ["OB", "FB", "FC"].includes(item.kind ?? "");
}

function recordMatchesQuery(record: Record<string, JsonValue>, query: string | undefined): boolean {
  if (!query?.trim()) return true;
  return JSON.stringify(record).toLowerCase().includes(query.toLowerCase());
}

export async function extractSymbolsFromIndex(
  exportDir: string,
  index: ExportIndex,
  options: {
    scope: "all" | "blocks" | "db" | "types" | "tags";
    query?: string;
    limit: number;
    maxFiles: number;
  }
) {
  const symbols: Array<Record<string, JsonValue>> = [];
  let filesScanned = 0;
  let ownersMatched = 0;
  let skippedLargeFiles = 0;
  let parseErrors = 0;
  let truncated = false;

  for (const item of index.items ?? []) {
    if (filesScanned >= options.maxFiles || symbols.length >= options.limit) {
      truncated = true;
      break;
    }
    if (!itemMatchesSymbolScope(item, options.scope)) continue;
    try {
      const xmlFile = await readIndexedXml(exportDir, item);
      filesScanned += 1;
      const parsed = parseSimaticXmlText(xmlFile.text);
      const perFileScanLimit = options.query?.trim()
        ? MAX_SYMBOL_SCAN_PER_FILE
        : Math.max(options.limit - symbols.length, 0);
      const extracted = extractSymbolsFromParsed(parsed, item, perFileScanLimit);
      const filtered = extracted.symbols.filter((symbol) => recordMatchesQuery(symbol, options.query));
      if (filtered.length > 0) ownersMatched += 1;
      symbols.push(...filtered.slice(0, options.limit - symbols.length));
      if (extracted.truncated) truncated = true;
    } catch (error) {
      if (String(error).includes("too large")) {
        skippedLargeFiles += 1;
      } else {
        parseErrors += 1;
      }
    }
  }

  return {
    symbols,
    counts: {
      filesScanned,
      ownersMatched,
      symbolsReturned: symbols.length,
      skippedLargeFiles,
      parseErrors
    },
    truncated
  };
}

export function buildCallGraph(index: ExportIndex, startItem: ExportIndexItem, direction: "downstream" | "upstream" | "both", maxDepth: number, maxEdges: number) {
  const lookup = itemLookupByName(index);
  const nodes = new Map<string, Record<string, JsonValue>>();
  const edges: Array<Record<string, JsonValue>> = [];
  const queue: Array<{ name: string; depth: number; item?: ExportIndexItem }> = [{ name: startItem.name ?? "", depth: 0, item: startItem }];
  const visited = new Set<string>();
  let truncated = false;

  function nodeKey(name: string) {
    return name.toLowerCase();
  }

  function addNode(name: string, depth: number, item?: ExportIndexItem) {
    const key = nodeKey(name);
    const existing = nodes.get(key);
    if (existing) {
      existing.minDepth = Math.min(Number(existing.minDepth ?? depth), depth);
      return;
    }
    nodes.set(key, {
      name,
      minDepth: depth,
      resolved: Boolean(item),
      item: item ? blockDisplay(item) as JsonValue : null
    });
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (!current.name) continue;
    const key = nodeKey(current.name);
    if (visited.has(`${key}:${current.depth}`)) continue;
    visited.add(`${key}:${current.depth}`);
    addNode(current.name, current.depth, current.item);
    if (current.depth >= maxDepth) continue;

      const currentItems = current.item ? [current.item] : lookup.get(key) ?? [];
      const hasResolvedItems = currentItems.length > 0;
      const matchedCalls = uniqueCalls((index.calls ?? []).filter((call) => {
      const sourceMatch = currentItems.some((item) => callMatchesSource(call, item)) || (!hasResolvedItems && call.source?.toLowerCase() === key);
      const targetMatch = call.target?.toLowerCase() === key;
      return (
        (direction === "downstream" && sourceMatch) ||
        (direction === "upstream" && targetMatch) ||
        (direction === "both" && (sourceMatch || targetMatch))
      );
    }));

    for (const call of matchedCalls) {
      if (edges.length >= maxEdges) {
        truncated = true;
        break;
      }
      const isOutgoing = call.source?.toLowerCase() === key || currentItems.some((item) => callMatchesSource(call, item));
      const nextName = isOutgoing ? call.target ?? "" : call.source ?? "";
      const nextItem = (lookup.get(nextName.toLowerCase()) ?? [])[0];
      edges.push({
        source: call.source ?? "",
        sourceNumber: call.sourceNumber ?? "",
        sourceKind: call.sourceKind ?? "",
        sourceLanguage: call.sourceLanguage ?? "",
        target: call.target ?? "",
        targetBlockType: call.targetBlockType ?? "",
        file: call.file ?? "",
        traversal: isOutgoing ? "outgoing" : "incoming",
        depth: current.depth + 1
      });
      if (nextName) {
        addNode(nextName, current.depth + 1, nextItem);
        const visitKey = `${nodeKey(nextName)}:${current.depth + 1}`;
        if (!visited.has(visitKey)) queue.push({ name: nextName, depth: current.depth + 1, item: nextItem });
      }
    }
    if (truncated) break;
  }

  return {
    start: blockDisplay(startItem),
    direction,
    maxDepth,
    maxEdges,
    truncated,
    nodeCount: nodes.size,
    edgeCount: edges.length,
    nodes: Array.from(nodes.values()),
    edges
  };
}

export async function ensureReferenceIndex(
  exportDir: string,
  index: ExportIndex,
  options: { autoBuild: boolean; forceRebuild?: boolean }
): Promise<{ referenceIndex: ReferenceIndex | null; rebuilt: boolean; stale: boolean }> {
  const sourceSignature = computeSourceSignature(index);
  const existing = await loadReferenceIndex(exportDir);
  const stale = Boolean(existing && existing.sourceSignature !== sourceSignature);
  if (existing && !stale && !options.forceRebuild) {
    existing.definitions ??= [];
    return { referenceIndex: existing, rebuilt: false, stale: false };
  }
  if (!options.autoBuild && !options.forceRebuild) {
    return { referenceIndex: existing, rebuilt: false, stale };
  }
  const definitions = await extractSymbolsFromIndex(exportDir, index, {
    scope: "all",
    limit: 100_000,
    maxFiles: Math.max((index.items ?? []).length, 1)
  });
  const compactDefinitions = definitions.symbols.filter((definition) => {
    const owner = definition.owner && typeof definition.owner === "object"
      ? definition.owner as Record<string, JsonValue>
      : {};
    const kind = String(owner.kind ?? "");
    const depth = Number(definition.depth ?? 0);
    if (kind === "GlobalDB" || kind === "Tag.PlcTagTable" || kind.startsWith("Type.")) return true;
    if (kind === "InstanceDB") return depth <= 2;
    if (["OB", "FB", "FC"].includes(kind)) return depth === 0;
    return false;
  });
  const referenceIndex = await buildReferenceIndex(
    exportDir,
    index,
    async (item) => {
      const xml = await readIndexedXml(exportDir, item as ExportIndexItem);
      return { text: xml.text, fullPath: xml.fullPath };
    },
    compactDefinitions as Array<Record<string, unknown>>
  );
  return { referenceIndex, rebuilt: true, stale: false };
}

const definitionSearchTextCache = new WeakMap<object, string>();

function knowledgeDefinitionMatches(definition: Record<string, unknown>, query: string): boolean {
  const alias = parseBlockAlias(query);
  if (alias) {
    const owner = definition.owner && typeof definition.owner === "object"
      ? definition.owner as Record<string, unknown>
      : {};
    const ownerNumber = String(owner.number ?? "");
    if (ownerNumber && String(Number(ownerNumber)) === alias.number && kindMatchesBlockAlias(owner.kind, alias)) return true;
  }
  let searchText = definitionSearchTextCache.get(definition);
  if (!searchText) {
    searchText = JSON.stringify(definition).toLowerCase();
    definitionSearchTextCache.set(definition, searchText);
  }
  return searchText.includes(query.toLowerCase());
}

export function findKnowledgeDefinitions(referenceIndex: ReferenceIndex | null, query: string, limit: number): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  for (const definition of referenceIndex?.definitions ?? []) {
    if (!knowledgeDefinitionMatches(definition, query)) continue;
    found.push(definition);
    if (found.length >= limit) break;
  }
  return found;
}

export function boundedExecutionSymbolQuery(
  executionModel: ExecutionModelIndex,
  query: string,
  match: "exact" | "suffix" | "contains",
  limit: number
) {
  const result = queryExecutionSymbol(executionModel, query, { match });
  const boundedLimit = Math.max(1, Math.floor(limit));
  const total = {
    matches: result.matches.length,
    writes: result.writes.length,
    calls: result.calls.length
  };
  const bounded = {
    ...result,
    matches: result.matches.slice(0, boundedLimit),
    writes: result.writes.slice(0, boundedLimit),
    calls: result.calls.slice(0, boundedLimit)
  };
  const returned = {
    matches: bounded.matches.length,
    writes: bounded.writes.length,
    calls: bounded.calls.length
  };
  return {
    ...bounded,
    limit: boundedLimit,
    total,
    returned,
    truncated: (
      returned.matches < total.matches
      || returned.writes < total.writes
      || returned.calls < total.calls
    )
  };
}

export async function buildFastLookupResult(
  exportDir: string,
  index: ExportIndex,
  referenceIndex: ReferenceIndex | null,
  executionModel: ExecutionModelIndex | null,
  sourceSignature: string,
  query: string,
  limit: number
): Promise<Record<string, JsonValue>> {
  const notes = await queryAnalysisNotes(exportDir, sourceSignature, query, limit);
  const definitions = findKnowledgeDefinitions(referenceIndex, query, limit);
  return {
    query,
    interpretation: queryInterpretation(query),
    blocks: findItems(index, query, limit) as unknown as JsonValue,
    calls: findCalls(index, query, limit) as unknown as JsonValue,
    definitions: definitions as unknown as JsonValue,
    trace: (referenceIndex ? queryReferenceIndex(referenceIndex, query, "contains", limit) : null) as unknown as JsonValue,
    preferredResult: executionModel ? "execution" : "legacy",
    execution: executionModel
      ? boundedExecutionSymbolQuery(executionModel, query, "contains", limit) as unknown as JsonValue
      : null,
    analysisNotes: notes as unknown as JsonValue
  };
}
