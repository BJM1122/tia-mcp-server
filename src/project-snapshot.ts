import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { readOnlyProjectVersion } from "./tia-version.js";
import { hashExecutionBlock } from "./execution-model.js";

export const SNAPSHOT_MANIFEST_FILENAME = "manifest.json";
export const EXPORT_INDEX_RELATIVE_PATH = path.join("_codex_index", "tia-export-index.json");

// Generated path labels are ASCII; original engineering names stay in metadata.
export function snapshotPathLabel(value: string, maximumLength = 64): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, maximumLength).replace(/^_+|_+$/g, "") || "unnamed";
}

export interface SnapshotObjectRecord {
  resourceKind: "block" | "plc_type" | "tag_table" | string;
  kind?: string;
  blockKind?: string;
  name: string;
  number?: string;
  programmingLanguage?: string;
  softwarePath?: string;
  namespace?: string;
  groupPath?: string;
  relativePath: string;
  sha256: string;
  bytes: number;
  status: string;
  error?: string;
  [key: string]: unknown;
}

export interface ProjectSnapshotManifest {
  schemaVersion: string;
  snapshotKind: string;
  status: string;
  complete: boolean;
  createdAtUtc: string;
  publicationState?: string;
  project: Record<string, unknown>;
  openness?: Record<string, unknown>;
  inventory?: Record<string, unknown>;
  consistency?: Record<string, unknown>;
  objects: SnapshotObjectRecord[];
  summary?: Record<string, unknown>;
  safety?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SnapshotCoreResponse {
  protocolVersion: number;
  requestId: string;
  ok: boolean;
  status: string;
  error?: string;
  mode?: string;
  snapshot?: {
    publishedPath?: string;
    manifestPath?: string;
    currentPointerPath?: string;
    previousPublishedPath?: string;
    snapshotId?: string;
    manifestSha256?: string;
    complete?: boolean;
    publicationState?: string;
    currentPointerUpdated?: boolean;
    previousCurrentExists?: boolean;
    previousCurrentSnapshotId?: string;
    previousCurrentManifestSha256?: string;
    exportedCount?: number;
    errorCount?: number;
    [key: string]: unknown;
  };
  consistency?: Record<string, unknown>;
  safety?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SnapshotExportOptions {
  coreExe: string;
  apiDll: string;
  processId: number;
  processStartTimeUtc: string;
  projectPath: string;
  outputRoot: string;
  timeoutMs: number;
  maxOutputBytes?: number;
  // false: export every object again instead of copying unchanged ones from the previous snapshot.
  reuseUnchanged?: boolean;
}

export interface SnapshotExportResult {
  exitCode: number | null;
  core: SnapshotCoreResponse;
  publishedPath?: string;
  manifestPath?: string;
  manifestSha256?: string;
  manifest?: ProjectSnapshotManifest;
  indexPath?: string;
  index?: SnapshotExportIndex;
  indexReused?: boolean;
  stderr: string;
}

export interface SnapshotExportIndexItem {
  name?: string;
  number?: string;
  kind?: string;
  programmingLanguage?: string;
  secondaryType?: string;
  relativePath?: string;
  fullPath?: string;
  sha256?: string;
  /** SHA-256 of the XML without the export time; equal for an unchanged object exported again. */
  contentSha256?: string;
  resourceKind?: string;
  softwarePath?: string;
  namespace?: string;
  bytes?: number;
}

export interface SnapshotExportIndex {
  schemaVersion: "2.0";
  source: "official_openness_snapshot";
  generatedAt: string;
  exportDir: string;
  projectPath: string;
  projectName: string;
  snapshotId: string;
  snapshotManifest: string;
  snapshotManifestSha256: string;
  snapshotComplete: boolean;
  xmlFileCount: number;
  itemCount: number;
  callCount: number;
  errorCount: number;
  byKind: Record<string, number>;
  byLanguage: Record<string, number>;
  items: SnapshotExportIndexItem[];
  calls: Array<Record<string, unknown>>;
  errors: Array<Record<string, unknown>>;
  analysis?: {
    executionAnalyzerVersion: string;
    executionModelPath: string;
    fullyUnderstood: boolean;
    coverage: unknown;
  };
}

export class SnapshotFinalizeConflictError extends Error {
  readonly code = "SNAPSHOT_FINALIZE_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "SnapshotFinalizeConflictError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function identifierValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) return String(value);
  return "";
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function safeRelativeXmlPath(value: unknown): string {
  const raw = stringValue(value);
  if (!raw) throw new Error("Snapshot object is missing relativePath.");
  const normalized = path.normalize(raw);
  if (
    path.isAbsolute(normalized)
    || normalized === ".."
    || normalized.startsWith(`..${path.sep}`)
    || path.extname(normalized).toLowerCase() !== ".xml"
  ) {
    throw new Error(`Snapshot object has an unsafe XML relativePath: ${raw}`);
  }
  return normalized;
}

function normalizeSnapshotObject(value: unknown, index: number): SnapshotObjectRecord {
  const source = record(value);
  if (!source) throw new Error(`Snapshot object ${index} is not an object.`);
  const resourceKind = stringValue(source.resourceKind);
  const name = stringValue(source.name);
  const relativePath = safeRelativeXmlPath(source.relativePath);
  const sha256 = stringValue(source.sha256).toLowerCase();
  const bytes = numberValue(source.bytes);
  const status = stringValue(source.status);
  if (!resourceKind || !name || !status) {
    throw new Error(`Snapshot object ${index} is missing resourceKind, name, or status.`);
  }
  if (status === "exported" || status === "completed" || status === "success") {
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error(`Snapshot object ${index} has an invalid SHA-256.`);
    }
    if (!Number.isInteger(bytes) || bytes < 0) {
      throw new Error(`Snapshot object ${index} has invalid byte length.`);
    }
  }
  return {
    ...source,
    resourceKind,
    kind: stringValue(source.kind),
    blockKind: stringValue(source.blockKind),
    name,
    number: identifierValue(source.number),
    programmingLanguage: stringValue(source.programmingLanguage),
    softwarePath: stringValue(source.softwarePath),
    namespace: stringValue(source.namespace),
    groupPath: stringValue(source.groupPath),
    relativePath,
    sha256,
    bytes,
    status,
    error: stringValue(source.error)
  };
}

export function parseSnapshotCoreResponse(stdout: string): SnapshotCoreResponse {
  const text = stdout.replace(/^\uFEFF/, "").trim();
  if (!text) throw new Error("TIA snapshot core returned no JSON.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`TIA snapshot core returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const envelope = record(parsed);
  if (
    !envelope
    || envelope.protocolVersion !== 1
    || typeof envelope.ok !== "boolean"
    || !stringValue(envelope.status)
    || stringValue(envelope.requestId) !== "snapshot-export"
  ) {
    throw new Error("TIA snapshot core returned an invalid v1 snapshot envelope.");
  }
  return envelope as unknown as SnapshotCoreResponse;
}

function runBoundedCoreProcess(args: {
  coreExe: string;
  processArgs: string[];
  timeoutMs: number;
  maxOutputBytes: number;
}): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(args.coreExe, args.processArgs, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;

    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    const append = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > args.maxOutputBytes) {
        finishError(new Error(`TIA snapshot core output exceeded ${args.maxOutputBytes} bytes.`));
        return;
      }
      target.push(chunk);
    };
    const timer = setTimeout(() => {
      finishError(new Error(`TIA snapshot core timed out after ${args.timeoutMs} ms.`));
    }, args.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.once("error", (error) => finishError(new Error(`TIA snapshot core launch failed: ${error.message}`)));
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

async function verifySnapshotCandidateContract(coreExe: string): Promise<void> {
  const result = await runBoundedCoreProcess({
    coreExe,
    processArgs: ["--snapshot-candidate-contract-v1"],
    timeoutMs: 10_000,
    maxOutputBytes: 64_000
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim());
  } catch {
    parsed = null;
  }
  const contract = record(parsed);
  if (
    result.exitCode !== 0
    || !contract
    || Object.keys(contract).length !== 3
    || contract.contractVersion !== 1
    || contract.candidateOnly !== true
    || contract.currentPointerWrittenByNative !== false
  ) {
    throw new Error(
      "TIA snapshot core does not prove the candidate-only v1 contract; no Attach or export was attempted."
    );
  }
}

function runSnapshotProcess(options: SnapshotExportOptions): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  return runBoundedCoreProcess({
    coreExe: options.coreExe,
    processArgs: [
      "--api",
      options.apiDll,
      "--export-snapshot-candidate-v1",
      "--process-id",
      String(options.processId),
      "--process-start-time-utc",
      options.processStartTimeUtc,
      "--project-path",
      options.projectPath,
      "--output-root",
      options.outputRoot,
      ...(options.reuseUnchanged === false ? ["--no-reuse"] : [])
    ],
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes ?? 4_000_000
  });
}

export async function runSnapshotExport(options: SnapshotExportOptions): Promise<SnapshotExportResult> {
  if (!Number.isInteger(options.processId) || options.processId <= 0) {
    throw new Error("TIA snapshot processId must be a positive integer.");
  }
  if (!options.processStartTimeUtc.trim() || !Number.isFinite(Date.parse(options.processStartTimeUtc))) {
    throw new Error("TIA snapshot processStartTimeUtc must be a valid ISO-8601 timestamp.");
  }
  readOnlyProjectVersion(options.projectPath);
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 30_000 || options.timeoutMs > 1_800_000) {
    throw new Error("TIA snapshot timeoutMs must be an integer from 30000 through 1800000.");
  }
  if (!existsSync(options.coreExe)) throw new Error(`TIA snapshot core not found: ${options.coreExe}`);
  if (!existsSync(options.apiDll)) throw new Error(`TIA Openness API not found: ${options.apiDll}`);

  await verifySnapshotCandidateContract(options.coreExe);
  const processResult = await runSnapshotProcess(options);
  const core = parseSnapshotCoreResponse(processResult.stdout);
  if (!core.ok) {
    return {
      exitCode: processResult.exitCode,
      core,
      stderr: processResult.stderr
    };
  }
  if (processResult.exitCode !== 0) {
    throw new Error(`TIA snapshot core returned success JSON but exited with code ${String(processResult.exitCode)}.`);
  }

  const publishedPath = stringValue(core.snapshot?.publishedPath);
  const expectedManifestSha256 = stringValue(core.snapshot?.manifestSha256).toLowerCase();
  if (!publishedPath || !/^[a-f0-9]{64}$/.test(expectedManifestSha256)) {
    throw new Error("TIA snapshot core success response is missing publishedPath or manifestSha256.");
  }
  if (
    stringValue(core.snapshot?.publicationState) !== "candidate_not_current"
    || core.snapshot?.currentPointerUpdated !== false
  ) {
    throw new Error("TIA snapshot core did not return a candidate-only publication state.");
  }
  const previousCurrentExists = core.snapshot?.previousCurrentExists;
  const previousCurrentSnapshotId = stringValue(core.snapshot?.previousCurrentSnapshotId);
  const previousCurrentManifestSha256 = stringValue(
    core.snapshot?.previousCurrentManifestSha256
  ).toLowerCase();
  if (
    typeof previousCurrentExists !== "boolean"
    || (
      previousCurrentExists
      && (
        !previousCurrentSnapshotId
        || !/^[a-f0-9]{64}$/.test(previousCurrentManifestSha256)
      )
    )
  ) {
    throw new Error("TIA snapshot core success response is missing the previous current-pointer identity.");
  }
  const realOutputRoot = await realpath(path.resolve(options.outputRoot));
  const realPublishedPath = await realpath(path.resolve(publishedPath));
  if (!isInside(realOutputRoot, realPublishedPath)) {
    throw new Error(`TIA snapshot core published outside outputRoot: ${realPublishedPath}`);
  }
  const verified = await loadVerifiedSnapshotManifest(realPublishedPath, expectedManifestSha256);
  const reportedManifestPath = stringValue(core.snapshot?.manifestPath);
  if (
    !reportedManifestPath
    || canonicalWindowsPath(reportedManifestPath) !== canonicalWindowsPath(verified.manifestPath)
  ) {
    throw new Error("Snapshot manifest path does not match the native Core response.");
  }
  assertSnapshotMatchesRequest(core, verified.manifest, options);
  const built = await buildExportIndexFromSnapshot({
    ...verified,
    snapshotId: stringValue(core.snapshot?.snapshotId)
  });
  return {
    exitCode: processResult.exitCode,
    core,
    publishedPath: verified.publishedPath,
    manifestPath: verified.manifestPath,
    manifestSha256: verified.manifestSha256,
    manifest: verified.manifest,
    indexPath: built.indexPath,
    index: built.index,
    indexReused: built.reused,
    stderr: processResult.stderr
  };
}

export function normalizeSnapshotManifest(value: unknown): ProjectSnapshotManifest {
  const source = record(value);
  if (!source) throw new Error("Snapshot manifest must be one JSON object.");
  const rawObjects = source.objects;
  if (!Array.isArray(rawObjects)) throw new Error("Snapshot manifest objects must be an array.");
  const manifest: ProjectSnapshotManifest = {
    ...source,
    schemaVersion: stringValue(source.schemaVersion),
    snapshotKind: stringValue(source.snapshotKind),
    status: stringValue(source.status),
    complete: booleanValue(source.complete),
    createdAtUtc: stringValue(source.createdAtUtc),
    project: record(source.project) ?? {},
    openness: record(source.openness) ?? undefined,
    inventory: record(source.inventory) ?? undefined,
    consistency: record(source.consistency) ?? undefined,
    objects: rawObjects.map(normalizeSnapshotObject),
    summary: record(source.summary) ?? undefined,
    safety: record(source.safety) ?? undefined
  };
  if (!manifest.schemaVersion || !manifest.snapshotKind || !manifest.status || !manifest.createdAtUtc) {
    throw new Error("Snapshot manifest is missing schemaVersion, snapshotKind, status, or createdAtUtc.");
  }
  if (manifest.schemaVersion !== "1.0" || manifest.snapshotKind !== "tia_openness_full_plc_snapshot") {
    throw new Error(
      `Unsupported snapshot manifest contract: ${manifest.schemaVersion}/${manifest.snapshotKind}.`
    );
  }
  return manifest;
}

export async function loadVerifiedSnapshotManifest(
  publishedPath: string,
  expectedManifestSha256 = ""
): Promise<{ publishedPath: string; manifestPath: string; manifestSha256: string; manifest: ProjectSnapshotManifest }> {
  const resolvedPublishedPath = await realpath(path.resolve(publishedPath));
  const manifestPath = await realpath(path.join(resolvedPublishedPath, SNAPSHOT_MANIFEST_FILENAME));
  if (!isInside(resolvedPublishedPath, manifestPath)) {
    throw new Error(`Snapshot manifest escaped the published directory: ${manifestPath}`);
  }
  const manifestBytes = await readFile(manifestPath);
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  if (expectedManifestSha256 && manifestSha256 !== expectedManifestSha256.toLowerCase()) {
    throw new Error("Published snapshot manifest SHA-256 does not match the native Core response.");
  }
  const manifest = normalizeSnapshotManifest(JSON.parse(manifestBytes.toString("utf8")));
  const consistency = manifest.consistency ?? {};
  const summary = manifest.summary ?? {};
  const safety = manifest.safety ?? {};
  const openness = manifest.openness ?? {};
  const inventory = manifest.inventory ?? {};
  const inventoryBefore = record(inventory.before) ?? {};
  const inventoryAfter = record(inventory.after) ?? {};
  if (
    !manifest.complete
    || manifest.status !== "consistent_complete"
    || stringValue(manifest.publicationState) !== "candidate_not_current"
    || consistency.consistent !== true
    || consistency.publishAllowed !== true
    || consistency.plcSoftwareIdentityMatches !== true
    || consistency.inventoryTraversalComplete !== true
    || numberValue(inventoryBefore.plcSoftwareCount) < 1
    || numberValue(inventoryAfter.plcSoftwareCount) < 1
    || numberValue(inventoryBefore.traversalErrorCount) !== 0
    || numberValue(inventoryAfter.traversalErrorCount) !== 0
    || manifest.objects.some((item) => item.status !== "exported")
    || numberValue(summary.exportErrorCount) !== 0
    || numberValue(summary.exportedCount) !== manifest.objects.length
    || numberValue(summary.exportableCount) !== manifest.objects.length
    || safety.projectMutation !== false
    || safety.plcAccessed !== false
    || numberValue(openness.attachCount) !== 1
  ) {
    throw new Error(`Published snapshot is not complete: ${manifest.status || "unknown"}.`);
  }
  return { publishedPath: resolvedPublishedPath, manifestPath, manifestSha256, manifest };
}

function canonicalWindowsPath(value: string): string {
  let normalized = value.trim();
  if (normalized.startsWith("\\\\?\\UNC\\")) {
    normalized = `\\\\${normalized.slice("\\\\?\\UNC\\".length)}`;
  } else if (normalized.startsWith("\\\\?\\")) {
    normalized = normalized.slice("\\\\?\\".length);
  }
  return path.win32.normalize(normalized).replace(/[\\/]+$/, "").toLowerCase();
}

function processStartIdentity(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return "";
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/i.exec(value.trim())?.[1] ?? "";
  return `${milliseconds}:${fraction.padEnd(7, "0").slice(0, 7)}`;
}

export function assertSnapshotMatchesRequest(
  core: SnapshotCoreResponse,
  manifest: ProjectSnapshotManifest,
  request: Pick<SnapshotExportOptions, "processId" | "processStartTimeUtc" | "projectPath">
): void {
  const snapshot = core.snapshot ?? {};
  const project = manifest.project;
  const coreSnapshotId = stringValue(snapshot.snapshotId);
  const manifestSnapshotId = stringValue(manifest.snapshotId);
  const manifestProcessId = numberValue(project.processId);
  const manifestStart = stringValue(project.processStartTimeUtc);
  const expectedStartIdentity = processStartIdentity(request.processStartTimeUtc);
  const manifestStartIdentity = processStartIdentity(manifestStart);
  const manifestProjectPath = stringValue(project.canonicalProjectPath);
  if (!coreSnapshotId || coreSnapshotId !== manifestSnapshotId) {
    throw new Error("Snapshot ID does not match between the native Core response and manifest.");
  }
  if (manifestProcessId !== request.processId) {
    throw new Error("Snapshot manifest processId does not match the exact requested Portal process.");
  }
  if (
    !expectedStartIdentity
    || !manifestStartIdentity
    || expectedStartIdentity !== manifestStartIdentity
  ) {
    throw new Error("Snapshot manifest process start identity does not match the exact requested Portal process.");
  }
  if (
    !manifestProjectPath
    || canonicalWindowsPath(manifestProjectPath) !== canonicalWindowsPath(request.projectPath)
  ) {
    throw new Error(`Snapshot manifest project path does not match the exact requested TIA project: ${manifestProjectPath} != ${request.projectPath}`);
  }
  if (core.status !== "consistent_complete" || snapshot.complete !== true) {
    throw new Error("Native Core response does not identify one complete, consistent snapshot.");
  }
}

function projectString(project: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = stringValue(project[key]);
    if (value) return value;
  }
  return "";
}

function exportedStatus(status: string): boolean {
  return status === "exported" || status === "completed" || status === "success";
}

export async function buildExportIndexFromSnapshot(args: {
  publishedPath: string;
  manifestPath: string;
  manifestSha256: string;
  manifest: ProjectSnapshotManifest;
  snapshotId?: string;
  verifyOnly?: boolean;
}): Promise<{ indexPath: string; index: SnapshotExportIndex; reused: boolean }> {
  const publishedPath = await realpath(path.resolve(args.publishedPath));
  const objects = args.manifest.objects;
  const successful = objects.filter((item) => exportedStatus(item.status));
  const items: SnapshotExportIndexItem[] = [];
  const errors: Array<Record<string, unknown>> = [];
  const byKind: Record<string, number> = {};
  const byLanguage: Record<string, number> = {};

  for (const item of objects) {
    if (!exportedStatus(item.status)) {
      errors.push({
        resourceKind: item.resourceKind,
        kind: item.kind || item.blockKind || "",
        name: item.name,
        number: item.number || "",
        error: item.error || item.status
      });
      continue;
    }
    const relativePath = safeRelativeXmlPath(item.relativePath);
    const fullPath = await realpath(path.join(publishedPath, relativePath));
    if (!isInside(publishedPath, fullPath)) {
      throw new Error(`Snapshot XML escaped the published directory: ${fullPath}`);
    }
    const fileStat = await stat(fullPath);
    if (fileStat.size !== item.bytes) {
      throw new Error(`Snapshot XML byte length changed after publication: ${relativePath}`);
    }
    const bytes = await readFile(fullPath);
    const currentSha256 = createHash("sha256").update(bytes).digest("hex");
    if (currentSha256 !== item.sha256) {
      throw new Error(`Snapshot XML SHA-256 changed after publication: ${relativePath}`);
    }
    const kind = item.resourceKind === "plc_type"
      ? "Type.PlcType"
      : item.resourceKind === "tag_table"
        ? "Tag.PlcTagTable"
        : item.blockKind || item.kind || item.resourceKind;
    const language = item.programmingLanguage || "";
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    if (language) byLanguage[language] = (byLanguage[language] ?? 0) + 1;
    items.push({
      name: item.name,
      number: item.number || "",
      kind,
      programmingLanguage: language,
      secondaryType: item.resourceKind,
      relativePath,
      fullPath,
      sha256: item.sha256,
      contentSha256: hashExecutionBlock(bytes.toString("utf8")),
      resourceKind: item.resourceKind,
      softwarePath: item.softwarePath || "",
      namespace: item.namespace || "",
      bytes: item.bytes
    });
  }

  if (successful.length !== items.length) {
    throw new Error("Snapshot object inventory changed while the export index was being built.");
  }

  const projectPath = projectString(args.manifest.project, "canonicalProjectPath", "projectPath", "path");
  const projectName = projectString(args.manifest.project, "name", "projectName");
  const index: SnapshotExportIndex = {
    schemaVersion: "2.0",
    source: "official_openness_snapshot",
    generatedAt: args.manifest.createdAtUtc,
    exportDir: publishedPath,
    projectPath,
    projectName,
    snapshotId: args.snapshotId ?? "",
    snapshotManifest: path.relative(publishedPath, args.manifestPath) || SNAPSHOT_MANIFEST_FILENAME,
    snapshotManifestSha256: args.manifestSha256,
    snapshotComplete: true,
    xmlFileCount: items.length,
    itemCount: items.length,
    callCount: 0,
    errorCount: errors.length,
    byKind,
    byLanguage,
    items,
    calls: [],
    errors
  };

  const indexPath = path.join(publishedPath, EXPORT_INDEX_RELATIVE_PATH);
  if (args.verifyOnly) return { indexPath, index, reused: false };
  await mkdir(path.dirname(indexPath), { recursive: true });
  const serialized = `${JSON.stringify(index, null, 2)}\n`;
  if (existsSync(indexPath)) {
    const current = await readFile(indexPath, "utf8");
    if (current !== serialized) {
      throw new Error(`Snapshot export index already exists with different content: ${indexPath}`);
    }
    return { indexPath, index, reused: true };
  }
  await persistSnapshotExportIndex(indexPath, index, publishedPath);
  return { indexPath, index, reused: false };
}

export async function persistSnapshotExportIndex(
  indexPath: string,
  index: SnapshotExportIndex,
  publishedPath: string
): Promise<void> {
  const resolvedIndexPath = path.resolve(indexPath);
  const resolvedPublishedPath = await realpath(path.resolve(publishedPath));
  if (
    path.basename(resolvedIndexPath).toLowerCase() !== "tia-export-index.json"
    || path.basename(path.dirname(resolvedIndexPath)).toLowerCase() !== "_codex_index"
    || !isInside(resolvedPublishedPath, resolvedIndexPath)
  ) {
    throw new Error(`Refusing to write an unexpected snapshot index path: ${resolvedIndexPath}`);
  }
  const temporaryPath = path.join(
    path.dirname(resolvedIndexPath),
    `.tia-export-index-${process.pid}-${randomUUID()}.tmp`
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(index, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx"
    });
    await rename(temporaryPath, resolvedIndexPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

type CurrentPointerIdentity = {
  exists: boolean;
  snapshotId: string;
  manifestSha256: string;
};

async function readCurrentPointerIdentity(currentPointerPath: string): Promise<CurrentPointerIdentity> {
  try {
    const currentStat = await lstat(currentPointerPath);
    if (!currentStat.isFile() || currentStat.isSymbolicLink()) {
      throw new Error(`Refusing to read a non-regular current pointer: ${currentPointerPath}`);
    }
    if (currentStat.size < 2 || currentStat.size > 64_000) {
      throw new Error(`Current pointer has an invalid byte length: ${currentStat.size}`);
    }
    const pointer = record(JSON.parse(await readFile(currentPointerPath, "utf8")));
    const snapshotId = stringValue(pointer?.snapshotId);
    const manifestSha256 = stringValue(pointer?.manifestSha256).toLowerCase();
    if (
      !pointer
      || stringValue(pointer.schemaVersion) !== "1.0"
      || !snapshotId
      || !/^[a-f0-9]{64}$/.test(manifestSha256)
    ) {
      throw new Error(`Current pointer has an invalid identity contract: ${currentPointerPath}`);
    }
    return { exists: true, snapshotId, manifestSha256 };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
    if (code === "ENOENT") return { exists: false, snapshotId: "", manifestSha256: "" };
    throw error;
  }
}

async function acquireCurrentPointerLock(outputRoot: string): Promise<() => Promise<void>> {
  const lockPath = path.join(outputRoot, ".current.json.lock");
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${JSON.stringify({
          schemaVersion: "1.0",
          token,
          createdAtUtc: new Date().toISOString()
        })}\n`, "utf8");
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
        throw error;
      }
      return async () => {
        await handle.close().catch(() => undefined);
        try {
          const current = record(JSON.parse(await readFile(lockPath, "utf8")));
          if (stringValue(current?.token) === token) {
            await rm(lockPath, { force: true });
          }
        } catch {
          // A missing lock already means this owner no longer holds it.
        }
      };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
      if (code !== "EEXIST") throw error;
      let lockStat;
      try {
        lockStat = await lstat(lockPath);
      } catch (lockError) {
        const lockCode = lockError && typeof lockError === "object" && "code" in lockError
          ? String((lockError as { code?: unknown }).code ?? "")
          : "";
        if (lockCode === "ENOENT") continue;
        throw lockError;
      }
      if (!lockStat.isFile() || lockStat.isSymbolicLink()) {
        throw new Error(`Refusing to wait on a non-regular current pointer lock: ${lockPath}`);
      }
      if (Date.now() - lockStat.mtimeMs > 60_000) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new SnapshotFinalizeConflictError("Timed out waiting for another snapshot finalizer.");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

export async function finalizeSnapshotCurrentPointer(args: {
  outputRoot: string;
  publishedPath: string;
  manifestPath: string;
  manifestSha256: string;
  snapshotId: string;
  expectedCurrentPointerPath?: string;
  previousCurrentExists: boolean;
  previousCurrentSnapshotId?: string;
  previousCurrentManifestSha256?: string;
  status: string;
  analysis?: Record<string, unknown>;
  publishIndexes?: () => Promise<() => Promise<void>>;
  expectedPointerBytes?: Buffer;
}): Promise<string> {
  const realOutputRoot = await realpath(path.resolve(args.outputRoot));
  const realPublishedPath = await realpath(path.resolve(args.publishedPath));
  const realSnapshotsDirectory = await realpath(path.join(realOutputRoot, "snapshots"));
  const realPublishedParent = await realpath(path.dirname(realPublishedPath));
  if (
    !isInside(realOutputRoot, realSnapshotsDirectory)
    || canonicalWindowsPath(realSnapshotsDirectory) !== canonicalWindowsPath(realPublishedParent)
    || path.basename(realPublishedPath) !== args.snapshotId
  ) {
    throw new Error(`Refusing to finalize a snapshot outside the direct snapshots directory: ${realPublishedPath}`);
  }

  const verified = await loadVerifiedSnapshotManifest(realPublishedPath, args.manifestSha256);
  const realRequestedManifestPath = await realpath(path.resolve(args.manifestPath));
  if (canonicalWindowsPath(verified.manifestPath) !== canonicalWindowsPath(realRequestedManifestPath)) {
    throw new Error(
      "Refusing to finalize a snapshot whose manifest path changed after analysis: "
      + `${canonicalWindowsPath(verified.manifestPath)} != ${canonicalWindowsPath(realRequestedManifestPath)}`
    );
  }
  if (stringValue(verified.manifest.snapshotId) !== args.snapshotId) {
    throw new Error(
      `Refusing to finalize a snapshot whose manifest snapshotId changed after analysis: `
      + `${stringValue(verified.manifest.snapshotId) || "<missing>"} != ${args.snapshotId}`
    );
  }

  const currentPointerPath = path.join(realOutputRoot, "current.json");
  if (args.expectedCurrentPointerPath) {
    const requestedPointerPath = path.resolve(args.expectedCurrentPointerPath);
    const realRequestedPointerParent = await realpath(path.dirname(requestedPointerPath));
    const normalizedRequestedPointer = path.join(
      realRequestedPointerParent,
      path.basename(requestedPointerPath)
    );
    if (canonicalWindowsPath(normalizedRequestedPointer) !== canonicalWindowsPath(currentPointerPath)) {
      throw new Error("Native snapshot current pointer path does not match the validated output root.");
    }
  }

  const snapshotRelativePath = path.relative(realOutputRoot, realPublishedPath);
  const manifestRelativePath = path.relative(realOutputRoot, verified.manifestPath);
  if (
    path.isAbsolute(snapshotRelativePath)
    || snapshotRelativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(manifestRelativePath)
    || manifestRelativePath.startsWith(`..${path.sep}`)
  ) {
    throw new Error("Refusing to finalize a snapshot with an escaping relative path.");
  }

  const pointer = {
    schemaVersion: "1.0",
    snapshotId: args.snapshotId,
    snapshotRelativePath: snapshotRelativePath.replaceAll(path.sep, "/"),
    manifestRelativePath: manifestRelativePath.replaceAll(path.sep, "/"),
    manifestSha256: args.manifestSha256.toLowerCase(),
    status: args.status,
    complete: true,
    publishedAtUtc: new Date().toISOString(),
    analysis: args.analysis ?? {}
  };
  const expectedPrevious = {
    exists: args.previousCurrentExists,
    snapshotId: stringValue(args.previousCurrentSnapshotId),
    manifestSha256: stringValue(args.previousCurrentManifestSha256).toLowerCase()
  };
  if (
    expectedPrevious.exists
    && (
      !expectedPrevious.snapshotId
      || !/^[a-f0-9]{64}$/.test(expectedPrevious.manifestSha256)
    )
  ) {
    throw new Error("Native snapshot response is missing the previous current-pointer identity.");
  }

  const releaseLock = await acquireCurrentPointerLock(realOutputRoot);
  try {
    const observedPrevious = await readCurrentPointerIdentity(currentPointerPath);
    if (
      observedPrevious.exists !== expectedPrevious.exists
      || (
        observedPrevious.exists
        && (
          observedPrevious.snapshotId !== expectedPrevious.snapshotId
          || observedPrevious.manifestSha256 !== expectedPrevious.manifestSha256
        )
      )
    ) {
      throw new SnapshotFinalizeConflictError(
        "current.json changed after native snapshot enumeration; the newer analyzed pointer was preserved."
      );
    }

    if (args.expectedPointerBytes && !(await readFile(currentPointerPath)).equals(args.expectedPointerBytes)) {
      throw new SnapshotFinalizeConflictError("current.json changed during reanalysis.");
    }
    await loadVerifiedSnapshotManifest(realPublishedPath, args.manifestSha256);
    const temporaryPath = path.join(
      realOutputRoot,
      `.current.json.${process.pid}.${randomUUID()}.tmp`
    );
    try {
      await writeFile(temporaryPath, `${JSON.stringify(args.expectedPointerBytes ? { ...JSON.parse(args.expectedPointerBytes.toString("utf8")), analysis: pointer.analysis, status: pointer.status } : pointer, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx"
      });
      const rollback = await args.publishIndexes?.();
      try {
        if (args.expectedPointerBytes && !(await readFile(currentPointerPath)).equals(args.expectedPointerBytes)) {
          throw new SnapshotFinalizeConflictError("current.json changed during index publication.");
        }
        await rename(temporaryPath, currentPointerPath);
      } catch (error) {
        await rollback?.();
        throw error;
      }
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  } finally {
    await releaseLock();
  }
  return currentPointerPath;
}
