import path from "node:path";
import { projectExtensions } from "./tia-version.js";

const DEFAULT_MAX_BYTES = 1_000_000;
const MAX_PROCESSES = 50;
const MAX_CANDIDATES = 50;
const MAX_TEXT_CHARS = 4_096;

export type TiaUiContextStatus = "selected" | "none" | "multiple" | "timeout" | "error" | "unsupported";
export type TiaUiEvidenceStatus = "resolved" | "unavailable" | "ambiguous" | "error";

export type TiaUiCandidate = {
  text: string | null;
  label: string | null;
  source: string | null;
};

export type TiaUiEvidence = {
  status: TiaUiEvidenceStatus;
  text: string | null;
  label: string | null;
  breadcrumb: string | null;
  editorState: string | null;
  number: string | null;
  source: string | null;
  candidates: TiaUiCandidate[];
};

export type TiaUiProcess = {
  processId: number;
  projectName: string | null;
  projectPath: string | null;
  processStartTimeUtc: string | null;
  mainWindowHandle: number | null;
  windowTitle: string | null;
  isMinimized: boolean | null;
};

export type TiaUiContext = {
  schemaVersion: "1.0";
  observedAt: string;
  status: TiaUiContextStatus;
  selectedProcessId: number | null;
  foregroundProcessId: number | null;
  foregroundWindowHandle: number | null;
  processes: TiaUiProcess[];
  selectedObject: TiaUiEvidence;
  activeEditor: TiaUiEvidence;
  networkOrSection: TiaUiEvidence;
  limitations: string[];
};

export type TiaBlockIdentity = {
  name: string | null;
  kind: "OB" | "FB" | "FC" | "DB";
  number: string;
  label: string;
};

export type TiaCurrentBlockSelection = {
  status: "resolved" | "ambiguous" | "none";
  source: "selectedObject" | "activeEditor" | null;
  block: TiaBlockIdentity | null;
  selection: TiaBlockIdentity | null;
  activeEditor: TiaBlockIdentity | null;
  candidates: TiaBlockIdentity[];
  conflict: boolean;
};

export type LiveProjectIdentity = {
  projectPath?: string | null;
  projectName?: string | null;
};

export type ExportProjectIdentity = {
  exportDir: string;
  indexPath?: string;
  projectPaths?: readonly string[];
  projectNames?: readonly string[];
  generatedAt?: string;
  evidence?: readonly string[];
};

export type ProjectIdentityMatch<T extends ExportProjectIdentity> = {
  status: "matched" | "ambiguous" | "name_only" | "not_found" | "invalid_live_path";
  match: T | null;
  matches: T[];
  nameOnlyCandidates: T[];
  canonicalProjectPath: string | null;
};

export type TiaBlockIndexItem = {
  name?: string;
  number?: string;
  kind?: string;
};

export type BlockMatchResolution<T extends TiaBlockIndexItem> = {
  status: "resolved" | "ambiguous" | "not_found" | "insufficient_identity";
  item: T | null;
  matches: T[];
  reason: string | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\u0000/g, "").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, MAX_TEXT_CHARS);
}

function cleanInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function cleanBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function cleanCandidate(value: unknown): TiaUiCandidate | null {
  const input = record(value);
  if (!input) return null;
  return {
    text: cleanText(input.text),
    label: cleanText(input.label),
    source: cleanText(input.source)
  };
}

function cleanEvidence(value: unknown, fallbackSource: string): TiaUiEvidence {
  const input = record(value) ?? {};
  const rawStatus = cleanText(input.status);
  const status: TiaUiEvidenceStatus =
    rawStatus === "selected" || rawStatus === "available" ? "resolved"
      : rawStatus === "multiple" ? "ambiguous"
        : rawStatus && ["resolved", "unavailable", "ambiguous", "error"].includes(rawStatus)
          ? rawStatus as TiaUiEvidenceStatus
          : "unavailable";
  const candidates = Array.isArray(input.candidates)
    ? input.candidates.slice(0, MAX_CANDIDATES).map(cleanCandidate).filter((candidate): candidate is TiaUiCandidate => Boolean(candidate))
    : [];
  return {
    status,
    text: cleanText(input.text),
    label: cleanText(input.label),
    breadcrumb: cleanText(input.breadcrumb),
    editorState: cleanText(input.editorState),
    number: cleanText(input.number),
    source: cleanText(input.source) ?? fallbackSource,
    candidates
  };
}

function cleanProcess(value: unknown): TiaUiProcess | null {
  const input = record(value);
  if (!input) return null;
  const processId = cleanInteger(input.processId ?? input.pid);
  if (!processId || processId <= 0) return null;
  return {
    processId,
    projectName: cleanText(input.projectName),
    projectPath: cleanText(input.projectPath),
    processStartTimeUtc: cleanText(input.processStartTimeUtc),
    mainWindowHandle: cleanInteger(input.mainWindowHandle),
    windowTitle: cleanText(input.windowTitle),
    isMinimized: cleanBoolean(input.isMinimized)
  };
}

export function parseTiaUiContextJson(
  input: string | Uint8Array,
  options: { maxBytes?: number } = {}
): TiaUiContext {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("maxBytes must be a positive integer");
  const text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error(`TIA UI context JSON exceeds ${maxBytes} bytes`);
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed) throw new Error("TIA UI context JSON is empty");

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`TIA UI context JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const inputRecord = record(parsed);
  if (!inputRecord) throw new Error("TIA UI context JSON must be an object");

  const rawStatus = cleanText(inputRecord.status);
  const status: TiaUiContextStatus = rawStatus && ["selected", "none", "multiple", "timeout", "error", "unsupported"].includes(rawStatus)
    ? rawStatus as TiaUiContextStatus
    : "error";
  const processes = Array.isArray(inputRecord.processes)
    ? inputRecord.processes.slice(0, MAX_PROCESSES).map(cleanProcess).filter((process): process is TiaUiProcess => Boolean(process))
    : [];
  const limitations = Array.isArray(inputRecord.limitations)
    ? inputRecord.limitations.slice(0, MAX_CANDIDATES).map(cleanText).filter((item): item is string => Boolean(item))
    : [];

  return {
    schemaVersion: "1.0",
    observedAt: cleanText(inputRecord.observedAt) ?? new Date(0).toISOString(),
    status,
    selectedProcessId: cleanInteger(inputRecord.selectedProcessId),
    foregroundProcessId: cleanInteger(inputRecord.foregroundProcessId),
    foregroundWindowHandle: cleanInteger(inputRecord.foregroundWindowHandle),
    processes,
    selectedObject: cleanEvidence(inputRecord.selectedObject, "project_navigator_msaa"),
    activeEditor: cleanEvidence(inputRecord.activeEditor, "editor_frame_msaa"),
    networkOrSection: cleanEvidence(inputRecord.networkOrSection, "network_container_msaa"),
    limitations
  };
}

function normalizedBlockNumber(value: string): string {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? String(parsed) : value.replace(/^0+(?=\d)/, "");
}

export function parseTiaBlockLabel(value: string | null | undefined): TiaBlockIdentity | null {
  const text = cleanText(value);
  if (!text) return null;
  const match = /(.+?)\s*\[\s*(OB|FB|FC|DB)\s*[-_]?\s*(\d+)\s*\]\s*$/i.exec(text);
  if (!match) return null;
  const rawName = match[1].trim();
  const name = rawName.split(/[\\/]/).at(-1)?.trim() ?? "";
  if (!name) return null;
  const kind = match[2].toUpperCase() as TiaBlockIdentity["kind"];
  return {
    name,
    kind,
    number: normalizedBlockNumber(match[3]),
    label: `${name} [${kind}${normalizedBlockNumber(match[3])}]`
  };
}

function sameBlock(left: TiaBlockIdentity, right: TiaBlockIdentity): boolean {
  return left.kind === right.kind
    && left.number === right.number
    && (left.name ?? "").localeCompare(right.name ?? "", undefined, { sensitivity: "accent" }) === 0;
}

export function selectCurrentBlock(context: TiaUiContext): TiaCurrentBlockSelection {
  const selection = context.selectedObject.status === "resolved"
    ? parseTiaBlockLabel(context.selectedObject.label ?? context.selectedObject.text)
    : null;
  const activeEditor = context.activeEditor.status === "resolved"
    ? parseTiaBlockLabel(
    context.activeEditor.label
      ?? context.activeEditor.text
      ?? context.activeEditor.breadcrumb
    )
    : null;
  const selectionCandidates = context.selectedObject.candidates
    .map((candidate) => parseTiaBlockLabel(candidate.label ?? candidate.text))
    .filter((candidate): candidate is TiaBlockIdentity => Boolean(candidate));
  const editorCandidates = context.activeEditor.candidates
    .map((candidate) => parseTiaBlockLabel(candidate.label ?? candidate.text))
    .filter((candidate): candidate is TiaBlockIdentity => Boolean(candidate));
  if (context.selectedObject.status === "ambiguous") {
    return {
      status: "ambiguous",
      source: "selectedObject",
      block: null,
      selection,
      activeEditor,
      candidates: selectionCandidates,
      conflict: false
    };
  }
  const conflict = Boolean(selection && activeEditor && !sameBlock(selection, activeEditor));
  if (selection) {
    return { status: "resolved", source: "selectedObject", block: selection, selection, activeEditor, candidates: [], conflict };
  }
  if (context.activeEditor.status === "ambiguous") {
    return {
      status: "ambiguous",
      source: "activeEditor",
      block: null,
      selection,
      activeEditor,
      candidates: editorCandidates,
      conflict: false
    };
  }
  if (activeEditor) {
    return { status: "resolved", source: "activeEditor", block: activeEditor, selection, activeEditor, candidates: [], conflict };
  }
  return { status: "none", source: null, block: null, selection, activeEditor, candidates: [], conflict: false };
}

function canonicalWindowsProjectPath(value: string | null | undefined): string | null {
  const cleaned = cleanText(value);
  if (!cleaned || !path.win32.isAbsolute(cleaned) || !projectExtensions("passive_ui_context").includes(path.win32.extname(cleaned).toLowerCase())) return null;
  return path.win32.normalize(cleaned).replace(/[\\/]+$/, "").toLowerCase();
}

function sameProjectName(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = cleanText(left)?.toLocaleLowerCase();
  const b = cleanText(right)?.toLocaleLowerCase();
  return Boolean(a && b && a === b);
}

export function matchProjectIdentity<T extends ExportProjectIdentity>(
  live: LiveProjectIdentity,
  candidates: readonly T[]
): ProjectIdentityMatch<T> {
  const canonicalProjectPath = canonicalWindowsProjectPath(live.projectPath);
  if (!canonicalProjectPath) {
    return {
      status: "invalid_live_path",
      match: null,
      matches: [],
      nameOnlyCandidates: [],
      canonicalProjectPath: null
    };
  }
  const matches = candidates.filter((candidate) =>
    (candidate.projectPaths ?? []).some((projectPath) => canonicalWindowsProjectPath(projectPath) === canonicalProjectPath)
  );
  const nameOnlyCandidates = candidates.filter((candidate) =>
    !matches.includes(candidate)
    && (candidate.projectNames ?? []).some((projectName) => sameProjectName(projectName, live.projectName))
  );
  if (matches.length === 1) {
    return { status: "matched", match: matches[0], matches, nameOnlyCandidates, canonicalProjectPath };
  }
  if (matches.length > 1) {
    return { status: "ambiguous", match: null, matches, nameOnlyCandidates, canonicalProjectPath };
  }
  if (nameOnlyCandidates.length > 0) {
    return { status: "name_only", match: null, matches, nameOnlyCandidates, canonicalProjectPath };
  }
  return { status: "not_found", match: null, matches, nameOnlyCandidates, canonicalProjectPath };
}

function canonicalKind(value: string | undefined): string {
  const normalized = value?.trim().toUpperCase() ?? "";
  if (normalized === "GLOBALDB" || normalized === "INSTANCEDB") return "DB";
  const match = /(?:^|[.\s])(OB|FB|FC|DB)$/i.exec(normalized);
  return match ? match[1].toUpperCase() : normalized;
}

export function resolveBlockMatch<T extends TiaBlockIndexItem>(
  identity: TiaBlockIdentity | null | undefined,
  items: readonly T[]
): BlockMatchResolution<T> {
  if (!identity || (!identity.name && !(identity.kind && identity.number))) {
    return { status: "insufficient_identity", item: null, matches: [], reason: "A block name or kind/number identity is required." };
  }
  const matches = items.filter((item) => {
    const nameMatches = identity.name
      ? (item.name ?? "").localeCompare(identity.name, undefined, { sensitivity: "accent" }) === 0
      : true;
    const kindMatches = identity.kind ? canonicalKind(item.kind) === identity.kind : true;
    const numberMatches = identity.number
      ? normalizedBlockNumber(String(item.number ?? "")) === normalizedBlockNumber(identity.number)
      : true;
    return nameMatches && kindMatches && numberMatches;
  });
  if (matches.length === 1) return { status: "resolved", item: matches[0], matches, reason: null };
  if (matches.length > 1) {
    return { status: "ambiguous", item: null, matches, reason: "Multiple indexed blocks match the observed UI identity." };
  }
  return { status: "not_found", item: null, matches, reason: "No indexed block matches the observed UI identity." };
}
