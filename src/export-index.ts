import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertAllowedLocalRoot, isAllowedLocalRoot, isInside, normalizePath, paths, sameCanonicalPath, workspaceRoot
} from "./core/local-paths.js";
import { type JsonValue, objectRecord } from "./core/results.js";
import { asArray } from "./core/simatic-objects.js";
import {
  buildExecutionModel, EXECUTION_ANALYZER_VERSION, EXECUTION_INDEX_FILENAME, executionBlockKey,
  type ExecutionBlockSource, type ExecutionModelIndex, planIncrementalReanalysis
} from "./execution-model.js";
import { loadVerifiedSnapshotManifest } from "./project-snapshot.js";
import { type ExportProjectIdentity, matchProjectIdentity } from "./tia-ui-context.js";
import { MAX_IMPORT_XML_BYTES } from "./plc-importer.js";

// Export index on disk: loading, discovery of current snapshots, project identity sidecars,
// indexed XML access and upkeep of the execution model next to each export.

export const MAX_XML_SEARCH_BYTES = 5_000_000;

const MAX_EXPORT_IDENTITY_SIDECAR_BYTES = 25_000_000;

const MAX_CURRENT_SNAPSHOT_POINTER_BYTES = 1_000_000;

const DEFAULT_EXECUTION_CHANGED_XML_MAX_BYTES = 256 * 1024 * 1024;

function executionChangedXmlMaxBytes(): number {
  const configured = Number(process.env.TIA_MCP_EXECUTION_CHANGED_XML_MAX_BYTES ?? "");
  return Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, 2_000_000_000)
    : DEFAULT_EXECUTION_CHANGED_XML_MAX_BYTES;
}

export type ExportIndexItem = {
  name?: string;
  number?: string;
  kind?: string;
  programmingLanguage?: string;
  secondaryType?: string;
  relativePath?: string;
  fullPath?: string;
  sha256?: string;
  contentSha256?: string;
  resourceKind?: string;
  softwarePath?: string;
  namespace?: string;
  bytes?: number;
};

export type ExportIndexCall = {
  source?: string;
  sourceNumber?: string;
  sourceKind?: string;
  sourceLanguage?: string;
  target?: string;
  targetBlockType?: string;
  file?: string;
};

export type ExportIndex = {
  schemaVersion?: string;
  source?: string;
  generatedAt?: string;
  exportDir?: string;
  projectPath?: string;
  projectName?: string;
  snapshotId?: string;
  snapshotManifest?: string;
  snapshotManifestSha256?: string;
  snapshotComplete?: boolean;
  analysis?: {
    executionAnalyzerVersion?: string;
    executionModelPath?: string;
    fullyUnderstood?: boolean;
    coverage?: JsonValue;
  };
  xmlFileCount?: number;
  itemCount?: number;
  callCount?: number;
  errorCount?: number;
  byKind?: JsonValue;
  byLanguage?: JsonValue;
  items?: ExportIndexItem[];
  calls?: ExportIndexCall[];
  errors?: JsonValue[];
};

type JsonFileCacheEntry = {
  mtimeMs: number;
  size: number;
  value: unknown;
};

const jsonFileCache = new Map<string, JsonFileCacheEntry>();

const MAX_JSON_FILE_CACHE_ENTRIES = 16;

function rememberJsonFile(key: string, entry: JsonFileCacheEntry): void {
  jsonFileCache.delete(key);
  jsonFileCache.set(key, entry);
  while (jsonFileCache.size > MAX_JSON_FILE_CACHE_ENTRIES) {
    const oldest = jsonFileCache.keys().next().value as string | undefined;
    if (!oldest) break;
    jsonFileCache.delete(oldest);
  }
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const fileStat = await stat(filePath);
  const cached = jsonFileCache.get(filePath);
  if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
    rememberJsonFile(filePath, cached);
    return cached.value as T;
  }
  const text = await readFile(filePath, "utf8");
  const parsed = JSON.parse(text) as T;
  rememberJsonFile(filePath, { mtimeMs: fileStat.mtimeMs, size: fileStat.size, value: parsed });
  return parsed;
}

export async function atomicWriteJsonFile(filePath: string, value: unknown): Promise<void> {
  return atomicWriteFile(filePath, JSON.stringify(value, null, 2) + "\n");
}

export async function atomicWriteFile(filePath: string, content: string | Buffer): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}-${process.pid}-${randomUUID()}.tmp`
  );
  try {
    await writeFile(temporaryPath, content, {
      encoding: "utf8",
      flag: "wx"
    });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function indexPathForExport(exportDir: string): string {
  return path.join(exportDir, "_codex_index", "tia-export-index.json");
}

export async function loadExportIndex(exportDir: string): Promise<{ exportDir: string; indexPath: string; index: ExportIndex }> {
  const resolvedExportDir = normalizePath(exportDir);
  assertAllowedLocalRoot(resolvedExportDir, "Export directory");
  const realExportDir = await realpath(resolvedExportDir);
  assertAllowedLocalRoot(realExportDir, "Export directory");
  const indexPath = indexPathForExport(realExportDir);
  if (!existsSync(indexPath)) {
    throw new Error(`Index not found: ${indexPath}`);
  }
  const realIndexPath = await realpath(indexPath);
  if (!isInside(realExportDir, realIndexPath)) {
    throw new Error(`Refusing to read index outside exportDir: ${realIndexPath}`);
  }
  const index = await readJsonFile<ExportIndex>(realIndexPath);
  return { exportDir: realExportDir, indexPath: realIndexPath, index };
}

type CurrentSnapshotResolution = {
  status: "valid" | "missing" | "invalid";
  scopeDir: string;
  pointerPath: string;
  exportDir?: string;
  indexPath?: string;
  snapshotId?: string;
  manifestSha256?: string;
  analysisStatus?: string;
  error?: string;
};

type SnapshotPublication = {
  kind: "official_snapshot" | "legacy_export";
  state: "current" | "historical_or_candidate" | "candidate_incomplete" | "legacy";
  automaticMatchEligible: boolean;
  currentPointerStatus: "valid" | "missing" | "invalid" | "not_applicable";
  currentPointerPath?: string;
  currentSnapshotId?: string;
  analysisStatus?: string;
  reason?: string;
};

function safeDiscoveryRelativePath(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = path.normalize(value.trim());
  if (
    path.isAbsolute(normalized)
    || normalized === ".."
    || normalized.startsWith(`..${path.sep}`)
  ) {
    return null;
  }
  return normalized;
}

function filesystemErrorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
}

async function readValidatedCurrentSnapshot(scopeDir: string): Promise<CurrentSnapshotResolution> {
  let realScopeDir: string;
  try {
    realScopeDir = await realpath(scopeDir);
    assertAllowedLocalRoot(realScopeDir, "Snapshot project scope");
  } catch (error) {
    return {
      status: "invalid",
      scopeDir: normalizePath(scopeDir),
      pointerPath: path.join(normalizePath(scopeDir), "current.json"),
      error: error instanceof Error ? error.message : String(error)
    };
  }

  const pointerPath = path.join(realScopeDir, "current.json");
  let pointerObserved = false;
  try {
    const pointerStat = await lstat(pointerPath);
    pointerObserved = true;
    if (!pointerStat.isFile() || pointerStat.isSymbolicLink()) {
      throw new Error("current.json is not a regular non-link file.");
    }
    if (pointerStat.size > MAX_CURRENT_SNAPSHOT_POINTER_BYTES) {
      throw new Error(`current.json exceeds ${MAX_CURRENT_SNAPSHOT_POINTER_BYTES} bytes.`);
    }

    const pointer = objectRecord(JSON.parse(await readFile(pointerPath, "utf8")));
    const pointerAnalysis = objectRecord(pointer?.analysis);
    const snapshotId = typeof pointer?.snapshotId === "string" ? pointer.snapshotId.trim() : "";
    const manifestSha256 = typeof pointer?.manifestSha256 === "string"
      ? pointer.manifestSha256.trim().toLowerCase()
      : "";
    const analysisStatus = typeof pointer?.status === "string" ? pointer.status.trim() : "";
    const snapshotRelativePath = safeDiscoveryRelativePath(pointer?.snapshotRelativePath);
    const manifestRelativePath = safeDiscoveryRelativePath(pointer?.manifestRelativePath);
    const supportedAnalysisStatus = (
      analysisStatus === "snapshot_analyzed_exact"
      || analysisStatus === "snapshot_analyzed_with_coverage_gaps"
    );
    if (
      pointer?.schemaVersion !== "1.0"
      || pointer?.complete !== true
      || !snapshotId
      || !/^[a-f0-9]{64}$/.test(manifestSha256)
      || !snapshotRelativePath
      || !manifestRelativePath
      || !supportedAnalysisStatus
      || typeof pointerAnalysis?.executionAnalyzerVersion !== "string"
      || !pointerAnalysis.executionAnalyzerVersion.trim()
      || typeof pointerAnalysis?.sourceSignature !== "string"
      || !pointerAnalysis.sourceSignature.trim()
      || typeof pointerAnalysis?.fullyUnderstood !== "boolean"
    ) {
      throw new Error("current.json does not contain one complete analyzed snapshot identity.");
    }

    const realSnapshotsDir = await realpath(path.join(realScopeDir, "snapshots"));
    const realExportDir = await realpath(path.resolve(realScopeDir, snapshotRelativePath));
    const realManifestPath = await realpath(path.resolve(realScopeDir, manifestRelativePath));
    if (
      !isInside(realScopeDir, realSnapshotsDir)
      || !sameCanonicalPath(path.dirname(realExportDir), realSnapshotsDir)
      || path.basename(realExportDir) !== snapshotId
      || !isInside(realExportDir, realManifestPath)
      || path.basename(realManifestPath).toLowerCase() !== "manifest.json"
    ) {
      throw new Error("current.json points outside the direct snapshots directory.");
    }

    const verified = await loadVerifiedSnapshotManifest(realExportDir, manifestSha256);
    if (
      !sameCanonicalPath(verified.manifestPath, realManifestPath)
      || String(verified.manifest.snapshotId ?? "") !== snapshotId
    ) {
      throw new Error("current.json does not match the verified snapshot manifest identity.");
    }

    const realIndexPath = await realpath(indexPathForExport(realExportDir));
    if (!isInside(realExportDir, realIndexPath)) {
      throw new Error("The current snapshot index escaped its snapshot directory.");
    }
    const index = await readJsonFile<ExportIndex>(realIndexPath);
    if (
      index.source !== "official_openness_snapshot"
      || index.snapshotComplete !== true
      || index.snapshotId !== snapshotId
      || String(index.snapshotManifestSha256 ?? "").toLowerCase() !== manifestSha256
      || !index.analysis?.executionAnalyzerVersion
      || !index.analysis.executionModelPath
    ) {
      throw new Error("The current snapshot index is not a complete analyzed official snapshot.");
    }

    const modelRelativePath = safeDiscoveryRelativePath(index.analysis.executionModelPath);
    if (!modelRelativePath) {
      throw new Error("The current snapshot index has an unsafe execution-model path.");
    }
    const reportedModelPath = await realpath(path.resolve(realExportDir, modelRelativePath));
    const expectedModelPath = await realpath(executionModelPath(realExportDir));
    if (
      !isInside(realExportDir, reportedModelPath)
      || !sameCanonicalPath(reportedModelPath, expectedModelPath)
    ) {
      throw new Error("The current snapshot index points to an unexpected execution model.");
    }

    const executionModel = await loadExecutionModel(realExportDir);
    if (
      !executionModel
      || executionModel.analyzerVersion !== pointerAnalysis.executionAnalyzerVersion
      || executionModel.analyzerVersion !== index.analysis.executionAnalyzerVersion
      || executionModel.sourceSignature !== pointerAnalysis.sourceSignature
      || !Array.isArray(executionModel.incremental?.pendingBlockKeys)
      || executionModel.incremental.pendingBlockKeys.length !== 0
    ) {
      throw new Error("The current snapshot execution model is missing, stale, or incomplete.");
    }
    const fullyUnderstood = executionModelFullyUnderstood(executionModel);
    if (
      pointerAnalysis.fullyUnderstood !== fullyUnderstood
      || index.analysis.fullyUnderstood !== fullyUnderstood
      || (analysisStatus === "snapshot_analyzed_exact") !== fullyUnderstood
    ) {
      throw new Error("The current snapshot analysis status does not match its execution model.");
    }

    return {
      status: "valid",
      scopeDir: realScopeDir,
      pointerPath,
      exportDir: realExportDir,
      indexPath: realIndexPath,
      snapshotId,
      manifestSha256,
      analysisStatus
    };
  } catch (error) {
    if (!pointerObserved && filesystemErrorCode(error) === "ENOENT") {
      return { status: "missing", scopeDir: realScopeDir, pointerPath };
    }
    return {
      status: "invalid",
      scopeDir: realScopeDir,
      pointerPath,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function classifyExportPublication(
  exportDir: string,
  index: ExportIndex,
  currentForScope: (scopeDir: string) => Promise<CurrentSnapshotResolution>
): Promise<SnapshotPublication> {
  if (index.source !== "official_openness_snapshot") {
    return {
      kind: "legacy_export",
      state: "legacy",
      automaticMatchEligible: true,
      currentPointerStatus: "not_applicable"
    };
  }

  const snapshotsDir = path.dirname(exportDir);
  if (path.basename(snapshotsDir).toLowerCase() !== "snapshots") {
    return {
      kind: "official_snapshot",
      state: index.analysis?.executionAnalyzerVersion
        ? "historical_or_candidate"
        : "candidate_incomplete",
      automaticMatchEligible: false,
      currentPointerStatus: "invalid",
      reason: "Official snapshot is not a direct child of a project scope snapshots directory."
    };
  }

  const current = await currentForScope(path.dirname(snapshotsDir));
  if (
    current.status === "valid"
    && current.exportDir
    && sameCanonicalPath(current.exportDir, exportDir)
  ) {
    return {
      kind: "official_snapshot",
      state: "current",
      automaticMatchEligible: true,
      currentPointerStatus: "valid",
      currentPointerPath: current.pointerPath,
      currentSnapshotId: current.snapshotId,
      analysisStatus: current.analysisStatus
    };
  }

  const analysisComplete = Boolean(
    index.snapshotComplete === true
    && index.analysis?.executionAnalyzerVersion
    && index.analysis.executionModelPath
  );
  return {
    kind: "official_snapshot",
    state: analysisComplete ? "historical_or_candidate" : "candidate_incomplete",
    automaticMatchEligible: false,
    currentPointerStatus: current.status,
    currentPointerPath: current.pointerPath,
    currentSnapshotId: current.snapshotId,
    analysisStatus: current.analysisStatus,
    reason: current.status === "valid"
      ? "This snapshot is not the project scope current.json target."
      : current.error ?? "The project scope has no valid current.json target."
  };
}

export async function findExportIndexes(
  roots: string[],
  maxResults: number,
  options: {
    automaticCurrentOnly?: boolean;
    includeHistory?: boolean;
    includeTestSnapshots?: boolean;
    projectName?: string;
    projectPath?: string;
  } = {}
) {
  const found: Array<Record<string, JsonValue>> = [];
  const omitted = { historySnapshots: 0, testDirectories: 0, filteredOut: 0, beyondMaxResults: 0 };
  const visited = new Set<string>();
  const currentSnapshotCache = new Map<string, Promise<CurrentSnapshotResolution>>();
  const snapshotDirectoryCache = new Map<string, Promise<string[]>>();

  const snapshotsFor = (snapshotsDir: string): Promise<string[]> => {
    const key = normalizePath(snapshotsDir).toLowerCase();
    let snapshots = snapshotDirectoryCache.get(key);
    if (!snapshots) {
      snapshots = readdir(snapshotsDir, { withFileTypes: true })
        .then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
        .catch(() => []);
      snapshotDirectoryCache.set(key, snapshots);
    }
    return snapshots;
  };

  async function latestSnapshot(snapshotsDir: string, names: string[]): Promise<string | undefined> {
    const candidates = await Promise.all(names.map(async (name) => {
      const dir = path.join(snapshotsDir, name);
      try {
        const loaded = await loadExportIndex(dir);
        const generatedAt = Date.parse(loaded.index.generatedAt ?? "");
        return { dir, time: Number.isFinite(generatedAt) ? generatedAt : (await stat(dir)).mtimeMs };
      } catch {
        return null;
      }
    }));
    return candidates.filter((item) => item !== null)
      .sort((left, right) => right.time - left.time || right.dir.localeCompare(left.dir))[0]?.dir;
  }

  const currentForScope = (scopeDir: string): Promise<CurrentSnapshotResolution> => {
    const cacheKey = normalizePath(scopeDir).toLowerCase();
    let current = currentSnapshotCache.get(cacheKey);
    if (!current) {
      current = readValidatedCurrentSnapshot(scopeDir);
      currentSnapshotCache.set(cacheKey, current);
    }
    return current;
  };

  async function walk(dir: string, depth: number) {
    if ((options.automaticCurrentOnly && found.length >= maxResults) || depth > 8) return;
    const resolved = normalizePath(dir);
    if (!existsSync(resolved)) return;
    let realDir: string;
    try {
      realDir = await realpath(resolved);
      assertAllowedLocalRoot(realDir, "Search root");
    } catch {
      return;
    }
    const directoryKey = realDir.toLowerCase();
    if (visited.has(directoryKey)) return;
    visited.add(directoryKey);

    if (
      (options.automaticCurrentOnly || !options.includeHistory)
      && path.basename(realDir).toLowerCase() === "snapshots"
    ) {
      const current = await currentForScope(path.dirname(realDir));
      const snapshots = await snapshotsFor(realDir);
      const eligible = snapshots.filter((name) => {
        if (name.startsWith("_") && (options.automaticCurrentOnly || !options.includeTestSnapshots)) {
          omitted.testDirectories += 1;
          return false;
        }
        return true;
      });
      let selected: string | undefined;
      if (
        current.status === "valid"
        && current.exportDir
        && sameCanonicalPath(path.dirname(current.exportDir), realDir)
        && eligible.some((name) => sameCanonicalPath(path.join(realDir, name), current.exportDir!))
      ) {
        selected = current.exportDir;
      }
      if (!selected && !options.automaticCurrentOnly) selected = await latestSnapshot(realDir, eligible);
      omitted.historySnapshots += Math.max(0, eligible.length - (selected ? 1 : 0));
      if (selected) await walk(selected, depth + 1);
      return;
    }

    const indexPath = path.join(realDir, "_codex_index", "tia-export-index.json");
    if (existsSync(indexPath)) {
      let summary: Record<string, JsonValue> = {};
      let realIndexPath = "";
      let publication: SnapshotPublication | null = null;
      try {
        realIndexPath = await realpath(indexPath);
        if (!isInside(realDir, realIndexPath) || !isAllowedLocalRoot(realIndexPath)) {
          throw new Error(`Index path is outside the searched export directory: ${realIndexPath}`);
        }
        const index = await readJsonFile<ExportIndex>(realIndexPath);
        summary = summarizeIndex(index);
        publication = await classifyExportPublication(realDir, index, currentForScope);
      } catch (error) {
        summary = { error: error instanceof Error ? error.message : String(error) };
      }
      if (!options.automaticCurrentOnly || publication?.automaticMatchEligible === true) {
        const matches = (!options.projectName || String(summary.projectName ?? "").toLowerCase().includes(options.projectName.toLowerCase()))
          && (!options.projectPath || (Boolean(summary.projectPath) && sameCanonicalPath(String(summary.projectPath), options.projectPath)));
        if (!matches) omitted.filteredOut += 1;
        else if (found.length >= maxResults) omitted.beyondMaxResults += 1;
        else found.push({
          exportDir: realDir,
          indexPath: realIndexPath || indexPath,
          summary,
          ...(path.basename(path.dirname(realDir)).toLowerCase() === "snapshots"
            ? { historyCount: (await snapshotsFor(path.dirname(realDir))).length }
            : {}),
          publication: (publication ?? {
            kind: "official_snapshot",
            state: "candidate_incomplete",
            automaticMatchEligible: false,
            currentPointerStatus: "invalid",
            reason: "The export index could not be validated."
          }) as unknown as JsonValue
        });
      }
      if (options.automaticCurrentOnly && found.length >= maxResults) return;
      if (options.automaticCurrentOnly && publication?.state === "current") return;
    }

    let entries;
    try {
      entries = await readdir(realDir, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "accent" }));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (options.automaticCurrentOnly && found.length >= maxResults) break;
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "_codex_index") continue;
      // "_" marks test snapshots; "." marks scratch directories the test suite creates (and may leave behind after a crash).
      if ((entry.name.startsWith("_") || entry.name.startsWith(".")) && (options.automaticCurrentOnly || !options.includeTestSnapshots)) {
        omitted.testDirectories += 1;
        continue;
      }
      if (entry.name.toLowerCase() === "snapshots" && options.includeHistory && !options.automaticCurrentOnly) {
        const current = await currentForScope(realDir);
        if (
          current.status === "valid"
          && current.exportDir
          && sameCanonicalPath(path.dirname(current.exportDir), path.join(realDir, entry.name))
          && (options.includeTestSnapshots || !path.basename(current.exportDir).startsWith("_"))
        ) {
          await walk(current.exportDir, depth + 2);
        }
      }
      await walk(path.join(realDir, entry.name), depth + 1);
    }
  }

  for (const root of roots) {
    await walk(root, 0);
    if (options.automaticCurrentOnly && found.length >= maxResults) break;
  }
  return { indexes: found, omitted };
}

export function summarizeIndex(index: ExportIndex, includeCoverageIssues = false) {
  const analysis = index.analysis;
  const coverage = objectRecord(analysis?.coverage) as Record<string, JsonValue> | null;
  return {
    generatedAt: index.generatedAt ?? "",
    exportDir: index.exportDir ?? "",
    xmlFileCount: index.xmlFileCount ?? 0,
    itemCount: index.itemCount ?? 0,
    callCount: index.callCount ?? 0,
    errorCount: index.errorCount ?? 0,
    byKind: index.byKind ?? [],
    byLanguage: index.byLanguage ?? [],
    source: index.source ?? "legacy_export",
    projectPath: index.projectPath ?? "",
    projectName: index.projectName ?? "",
    snapshotId: index.snapshotId ?? "",
    snapshotComplete: index.snapshotComplete ?? null,
    analysis: analysis ? {
      executionAnalyzerVersion: analysis.executionAnalyzerVersion ?? "",
      executionModelPath: analysis.executionModelPath ?? "",
      fullyUnderstood: analysis.fullyUnderstood ?? null,
      coverage: {
        level: coverage?.level ?? null,
        exactSites: coverage?.exactSites ?? 0,
        conservativeSites: coverage?.conservativeSites ?? 0,
        unsupportedSites: coverage?.unsupportedSites ?? 0,
        issueCount: Array.isArray(coverage?.issues) ? coverage.issues.length : coverage?.issueCount ?? 0,
        ...(includeCoverageIssues ? { issues: coverage?.issues ?? [] } : {})
      }
    } : null
  };
}

export function currentContextSearchRoots(roots?: string[]): string[] {
  const selected = roots && roots.length > 0
    ? roots
    : [
        path.join(workspaceRoot, "tia-openness-export"),
        path.join(workspaceRoot, "tia-exports"),
        paths.defaultOutputRoot
      ];
  for (const root of selected) assertAllowedLocalRoot(root, "Search root");
  return selected;
}

function addUniqueString(target: string[], value: unknown): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (!trimmed || target.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) return;
  target.push(trimmed);
}

export async function readExportProjectIdentity(
  exportDir: string,
  indexPath: string,
  generatedAt: string
): Promise<ExportProjectIdentity> {
  const projectPaths: string[] = [];
  const projectNames: string[] = [];
  const evidence: string[] = [];

  const snapshotManifest = path.join(exportDir, "manifest.json");
  if (existsSync(snapshotManifest)) {
    try {
      const realManifest = await realpath(snapshotManifest);
      if (!isInside(exportDir, realManifest) || !isAllowedLocalRoot(realManifest)) {
        throw new Error("manifest_outside_export");
      }
      const manifestStat = await stat(realManifest);
      if (manifestStat.size > MAX_EXPORT_IDENTITY_SIDECAR_BYTES) {
        evidence.push("manifest.json:skipped_too_large");
      } else {
        const manifest = objectRecord(await readJsonFile<unknown>(realManifest));
        const project = objectRecord(manifest?.project);
        addUniqueString(projectPaths, project?.canonicalProjectPath);
        addUniqueString(projectPaths, project?.projectPath);
        addUniqueString(projectPaths, project?.path);
        addUniqueString(projectNames, project?.name);
        addUniqueString(projectNames, project?.projectName);
        evidence.push("manifest.json");
      }
    } catch (error) {
      evidence.push(`manifest.json:unreadable:${error instanceof Error ? error.name : "error"}`);
    }
  }

  for (const fileName of ["export-cs.json", "probe-cs.json"]) {
    const candidate = path.join(exportDir, fileName);
    if (!existsSync(candidate)) continue;
    try {
      const realCandidate = await realpath(candidate);
      if (!isInside(exportDir, realCandidate) || !isAllowedLocalRoot(realCandidate)) continue;
      const candidateStat = await stat(realCandidate);
      if (candidateStat.size > MAX_EXPORT_IDENTITY_SIDECAR_BYTES) {
        evidence.push(`${fileName}:skipped_too_large`);
        continue;
      }
      const raw = objectRecord(await readJsonFile<unknown>(realCandidate));
      if (!raw) {
        evidence.push(`${fileName}:invalid_object`);
        continue;
      }
      addUniqueString(projectPaths, raw.projectPathArgument);
      addUniqueString(projectPaths, raw.projectPath);
      addUniqueString(projectPaths, raw.projectPathOpened);
      addUniqueString(projectNames, raw.projectName);
      for (const project of asArray(raw.projects as unknown)) {
        const record = objectRecord(project);
        if (!record) continue;
        addUniqueString(projectPaths, record.path);
        addUniqueString(projectNames, record.name);
      }
      evidence.push(fileName);
    } catch (error) {
      evidence.push(`${fileName}:unreadable:${error instanceof Error ? error.name : "error"}`);
    }
  }

  return {
    exportDir,
    indexPath,
    projectPaths,
    projectNames,
    generatedAt,
    evidence
  };
}

type DiscoveredExportProjectIdentity = ExportProjectIdentity & {
  publication?: JsonValue;
};

export async function findExportProjectIdentities(
  roots: string[],
  maxResults: number
): Promise<DiscoveredExportProjectIdentity[]> {
  const found = await findExportIndexes(roots, maxResults, { automaticCurrentOnly: true });
  const identities: DiscoveredExportProjectIdentity[] = [];
  for (const result of found.indexes) {
    const exportDir = String(result.exportDir ?? "");
    const indexPath = String(result.indexPath ?? "");
    const summary = objectRecord(result.summary);
    if (!exportDir || !indexPath) continue;
    identities.push({
      ...await readExportProjectIdentity(exportDir, indexPath, String(summary?.generatedAt ?? "")),
      publication: result.publication
    });
  }
  return identities;
}

export function matchPreferredDiscoveredProjectIdentity(
  live: { projectPath?: string | null; projectName?: string | null },
  candidates: readonly DiscoveredExportProjectIdentity[]
) {
  const currentSnapshots = candidates.filter((candidate) => {
    const publication = objectRecord(candidate.publication);
    return publication?.state === "current";
  });
  const currentMatch = matchProjectIdentity(live, currentSnapshots);
  if (currentMatch.status === "matched" || currentMatch.status === "ambiguous") {
    return currentMatch;
  }

  const legacyExports = candidates.filter((candidate) => {
    const publication = objectRecord(candidate.publication);
    return publication?.state === "legacy";
  });
  const legacyMatch = matchProjectIdentity(live, legacyExports);
  if (legacyMatch.status === "matched" || legacyMatch.status === "ambiguous") {
    return legacyMatch;
  }
  return matchProjectIdentity(live, candidates);
}

export function isExecutableBlockKind(kind: string | undefined): boolean {
  return ["OB", "FB", "FC"].includes(kind ?? "");
}

function resolveXmlPathFromItem(exportDir: string, item: ExportIndexItem): Promise<{ realPath: string; bytes: number }> {
  const relativeXml = safeRelativeXmlPath(item.relativePath);
  const fullPath = normalizePath(path.join(exportDir, relativeXml));
  return realpath(fullPath).then(async (realFullPath) => {
    if (!isInside(exportDir, realFullPath)) {
      throw new Error(`Refusing to read outside exportDir: ${realFullPath}`);
    }
    const fileStat = await stat(realFullPath);
    return { realPath: realFullPath, bytes: fileStat.size };
  });
}

function safeRelativeXmlPath(relativePath: string | undefined): string {
  if (!relativePath) throw new Error("Indexed item has no relativePath");
  const normalized = path.normalize(relativePath);
  if (path.isAbsolute(normalized) || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`Refusing unsafe relativePath: ${relativePath}`);
  }
  if (path.extname(normalized).toLowerCase() !== ".xml") {
    throw new Error(`Indexed item is not an XML file: ${relativePath}`);
  }
  return normalized;
}

export async function readIndexedXml(exportDir: string, item: ExportIndexItem, maxBytes = MAX_XML_SEARCH_BYTES) {
  const resolved = await resolveXmlPathFromItem(exportDir, item);
  if (resolved.bytes > maxBytes) {
    throw new Error(`Indexed XML is too large: ${resolved.bytes} bytes`);
  }
  return {
    fullPath: resolved.realPath,
    bytes: resolved.bytes,
    text: await readFile(resolved.realPath, "utf8")
  };
}

export function executionModelPath(exportDir: string): string {
  return path.join(exportDir, "_codex_index", EXECUTION_INDEX_FILENAME);
}

export async function loadExecutionModel(exportDir: string): Promise<ExecutionModelIndex | null> {
  const loaded = await readStoredExecutionModel(exportDir);
  return loaded?.analyzerVersion === EXECUTION_ANALYZER_VERSION ? loaded : null;
}

export async function readStoredExecutionModel(exportDir: string): Promise<ExecutionModelIndex | null> {
  const filePath = executionModelPath(exportDir);
  if (!existsSync(filePath)) return null;
  try {
    const realFilePath = await realpath(filePath);
    if (!isInside(exportDir, realFilePath)) return null;
    const loaded = await readJsonFile<ExecutionModelIndex>(realFilePath);
    if (
      loaded.schemaVersion !== 1
      || !loaded.blocks
      || !Array.isArray(loaded.writeSites)
      || !Array.isArray(loaded.callSites)
    ) {
      return null;
    }
    return loaded;
  } catch {
    return null;
  }
}

function executionBlockDescriptors(index: ExportIndex): ExecutionBlockSource[] {
  return (index.items ?? [])
    .filter((item) => isExecutableBlockKind(item.kind))
    .map((item) => ({
      name: item.name ?? "",
      number: item.number ?? "",
      kind: item.kind ?? "",
      language: item.programmingLanguage ?? "",
      relativePath: item.relativePath ?? "",
      // Prefer the hash without the export time, so a re-export of an unchanged block reuses its analysis.
      sha256: item.contentSha256 || item.sha256 || "",
      softwarePath: item.softwarePath ?? "",
      taskOB: item.kind === "OB" ? `${item.kind}${item.number || `:${item.name ?? ""}`}` : undefined
    }));
}

export function executionModelFullyUnderstood(model: ExecutionModelIndex): boolean {
  return (
    model.coverage.level === "exact"
    && model.coverage.issues.length === 0
    && model.unresolvedCalls.length === 0
    && model.incremental.pendingBlockKeys.length === 0
  );
}

export function executionModelDescriptorsCurrent(
  index: ExportIndex,
  model: ExecutionModelIndex | null
): model is ExecutionModelIndex {
  if (!model || model.incremental.pendingBlockKeys.length > 0) return false;
  const plan = planIncrementalReanalysis(executionBlockDescriptors(index), model);
  return (
    plan.changedBlockKeys.length === 0
    && plan.addedBlockKeys.length === 0
    && plan.removedBlockKeys.length === 0
    && plan.xmlRequiredBlockKeys.length === 0
  );
}

async function readPreviousExecutionModel(
  previousExportDir: string | undefined,
  currentIndex: ExportIndex
): Promise<ExecutionModelIndex | null> {
  if (!previousExportDir?.trim()) return null;
  try {
    const previous = await loadExportIndex(previousExportDir);
    if (
      currentIndex.projectPath
      && previous.index.projectPath
      && !sameCanonicalPath(currentIndex.projectPath, previous.index.projectPath)
    ) {
      return null;
    }
    return loadExecutionModel(previous.exportDir);
  } catch {
    return null;
  }
}

export async function ensureExecutionModel(
  exportDir: string,
  index: ExportIndex,
  options: {
    autoBuild: boolean;
    forceRebuild?: boolean;
    previousExportDir?: string;
    persist?: boolean;
  }
): Promise<{
  executionModel: ExecutionModelIndex | null;
  rebuilt: boolean;
  reusedFromCurrent: boolean;
  previousSnapshotReused: boolean;
  xmlReadErrors: Array<{ blockKey: string; error: string }>;
  xmlBytesRead: number;
  xmlByteLimit: number;
  xmlByteLimitExceeded: boolean;
}> {
  const descriptors = executionBlockDescriptors(index);
  const xmlByteLimit = executionChangedXmlMaxBytes();
  const current = options.forceRebuild ? null : await loadExecutionModel(exportDir);
  if (current) {
    const currentPlan = planIncrementalReanalysis(descriptors, current);
    if (
      currentPlan.changedBlockKeys.length === 0
      && currentPlan.addedBlockKeys.length === 0
      && currentPlan.removedBlockKeys.length === 0
      && currentPlan.xmlRequiredBlockKeys.length === 0
    ) {
      return {
        executionModel: current,
        rebuilt: false,
        reusedFromCurrent: true,
        previousSnapshotReused: false,
        xmlReadErrors: [],
        xmlBytesRead: 0,
        xmlByteLimit,
        xmlByteLimitExceeded: false
      };
    }
  }
  if (!options.autoBuild && !options.forceRebuild) {
    return {
      executionModel: current,
      rebuilt: false,
      reusedFromCurrent: Boolean(current),
      previousSnapshotReused: false,
      xmlReadErrors: [],
      xmlBytesRead: 0,
      xmlByteLimit,
      xmlByteLimitExceeded: false
    };
  }

  const previous = current ?? await readPreviousExecutionModel(options.previousExportDir, index);
  const plan = planIncrementalReanalysis(descriptors, previous ?? undefined);
  const xmlRequired = new Set(plan.xmlRequiredBlockKeys);
  const itemsByBlockKey = new Map<string, ExportIndexItem>();
  for (const item of index.items ?? []) {
    if (!isExecutableBlockKind(item.kind)) continue;
    const descriptor = executionBlockDescriptors({ items: [item] })[0];
    if (descriptor) itemsByBlockKey.set(executionBlockKey(descriptor), item);
  }
  const xmlReadErrors: Array<{ blockKey: string; error: string }> = [];
  const sources: ExecutionBlockSource[] = [];
  let xmlBytesRead = 0;
  let xmlByteLimitExceeded = false;
  for (const descriptor of descriptors) {
    const blockKey = executionBlockKey(descriptor);
    if (!xmlRequired.has(blockKey)) {
      sources.push(descriptor);
      continue;
    }
    if (xmlByteLimitExceeded) {
      sources.push(descriptor);
      continue;
    }
    const item = itemsByBlockKey.get(blockKey);
    if (!item) {
      xmlReadErrors.push({ blockKey, error: "Indexed block descriptor could not be resolved to one XML item." });
      sources.push(descriptor);
      continue;
    }
    try {
      const resolved = await resolveXmlPathFromItem(exportDir, item);
      if (resolved.bytes > MAX_IMPORT_XML_BYTES) {
        throw new Error(`Indexed XML is too large: ${resolved.bytes} bytes`);
      }
      if (xmlBytesRead + resolved.bytes > xmlByteLimit) {
        xmlByteLimitExceeded = true;
        xmlReadErrors.push({
          blockKey,
          error: `Changed execution XML byte budget exceeded before ${blockKey}: `
            + `${xmlBytesRead} + ${resolved.bytes} > ${xmlByteLimit}. `
            + "The execution model is explicitly incomplete; raise "
            + "TIA_MCP_EXECUTION_CHANGED_XML_MAX_BYTES deliberately or reduce the changed snapshot."
        });
        sources.push(descriptor);
        continue;
      }
      const bytes = await readFile(resolved.realPath);
      if (options.persist === false && createHash("sha256").update(bytes).digest("hex") !== item.sha256) {
        throw new Error("XML changed after manifest verification: " + item.relativePath);
      }
      const text = bytes.toString("utf8");
      xmlBytesRead += resolved.bytes;
      sources.push({ ...descriptor, xml: text });
    } catch (error) {
      xmlReadErrors.push({
        blockKey,
        error: error instanceof Error ? error.message : String(error)
      });
      sources.push(descriptor);
    }
  }
  const executionModel = buildExecutionModel(sources, previous ?? undefined);
  const outputPath = executionModelPath(exportDir);
  if (options.persist !== false) await atomicWriteJsonFile(outputPath, executionModel);
  return {
    executionModel,
    rebuilt: true,
    reusedFromCurrent: false,
    previousSnapshotReused: Boolean(previous && previous !== current),
    xmlReadErrors,
    xmlBytesRead,
    xmlByteLimit,
    xmlByteLimitExceeded
  };
}
