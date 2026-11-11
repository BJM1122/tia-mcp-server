import type { JsonValue } from "./core/results.js";
import path from "node:path";
import { lstat, readFile, realpath } from "node:fs/promises";
import { assertAllowedLocalRoot, sameCanonicalPath } from "./core/local-paths.js";
import { atomicWriteFile, atomicWriteJsonFile, ensureExecutionModel, executionModelFullyUnderstood, executionModelPath, loadExportIndex } from "./export-index.js";
import { buildExportIndexFromSnapshot, loadVerifiedSnapshotManifest, finalizeSnapshotCurrentPointer, SnapshotFinalizeConflictError } from "./project-snapshot.js";
import { compactCoverage } from "./snapshot-workflow.js";

export async function reanalyzeSnapshot(args: { projectScopeDir?: string; exportDir?: string }): Promise<Record<string, JsonValue>> {
  try {
    if (Boolean(args.projectScopeDir) === Boolean(args.exportDir)) throw new Error("Specify exactly one projectScopeDir or exportDir.");
    const input = await realpath(args.projectScopeDir || args.exportDir!);
    assertAllowedLocalRoot(input, "Snapshot directory");
    const scope = args.exportDir ? path.dirname(path.dirname(input)) : input;
    assertAllowedLocalRoot(scope, "Snapshot scope");
    const current = path.join(scope, "current.json");
    const info = await lstat(current);
    if (!info.isFile() || info.size > 64_000) throw new Error("Invalid current.json file.");
    const pointerBytes = await readFile(current);
    const pointer = JSON.parse(pointerBytes.toString("utf8"));
    const { snapshotId, manifestSha256 } = pointer;
    if (pointer.schemaVersion !== "1.0" || pointer.complete !== true || typeof snapshotId !== "string" ||
        path.basename(snapshotId) !== snapshotId || !snapshotId || [".", ".."].includes(snapshotId) ||
        !/^[a-f0-9]{64}$/i.test(manifestSha256)) throw new Error("Invalid current snapshot identity.");
    for (const relative of [pointer.snapshotRelativePath, pointer.manifestRelativePath]) {
      if (typeof relative !== "string" || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
        throw new Error("Unsafe relative path in current.json.");
      }
    }
    const expectedDir = path.join(scope, "snapshots", snapshotId);
    const dir = await realpath(expectedDir);
    if (!sameCanonicalPath(dir, expectedDir) || (args.exportDir && !sameCanonicalPath(dir, input)) ||
        !sameCanonicalPath(path.resolve(scope, pointer.snapshotRelativePath), dir) ||
        !sameCanonicalPath(path.resolve(scope, pointer.manifestRelativePath), path.join(dir, "manifest.json"))) {
      throw new Error("Requested snapshot is not the direct current target.");
    }
    const verified = await loadVerifiedSnapshotManifest(dir, manifestSha256);
    if (verified.manifest.snapshotId !== snapshotId) throw new Error("Manifest snapshot identity mismatch.");
    const { index: manifestIndex } = await buildExportIndexFromSnapshot({ ...verified, snapshotId, verifyOnly: true });
    const { index, indexPath } = await loadExportIndex(dir);
    if (index.source !== "official_openness_snapshot" || index.snapshotComplete !== true ||
        index.snapshotId !== snapshotId || index.snapshotManifestSha256 !== verified.manifestSha256 ||
        !index.projectPath || !sameCanonicalPath(index.projectPath, manifestIndex.projectPath)) {
      throw new Error("Export index and verified manifest identify different snapshots.");
    }
    // Keep the original descriptor hash scheme so older indexes can reuse the rebuilt model.
    const items = new Map(manifestIndex.items.map(item => [item.relativePath, item]));
    if (!index.items || index.items.length !== items.size) throw new Error("Export inventory differs from the manifest.");
    for (const item of index.items) {
      const source = items.get(item.relativePath ?? "");
      if (!source || source.name !== item.name || source.kind !== item.kind || source.number !== item.number ||
          source.sha256 !== item.sha256 || (item.contentSha256 && item.contentSha256 !== source.contentSha256) ||
          source.programmingLanguage !== item.programmingLanguage || source.softwarePath !== item.softwarePath) {
        throw new Error("Index descriptor differs from the verified manifest: " + item.relativePath);
      }
      items.delete(source.relativePath);
    }
    const indexDir = path.join(dir, "_codex_index");
    if (!sameCanonicalPath(path.join(indexDir, "tia-export-index.json"), indexPath)) throw new Error("Index file is redirected.");
    if (!sameCanonicalPath(await realpath(indexDir), indexDir)) throw new Error("Index directory is redirected.");
    const modelPath = executionModelPath(dir);
    const built = await ensureExecutionModel(dir, index, { autoBuild: true, forceRebuild: true, persist: false });
    const model = built.executionModel;
    if (!model || model.incremental.pendingBlockKeys.length || built.xmlReadErrors.length || built.xmlByteLimitExceeded) {
      throw new Error("Incomplete execution model: " + JSON.stringify(built.xmlReadErrors.slice(0, 3)));
    }
    const fullyUnderstood = executionModelFullyUnderstood(model);
    const analysis = { executionAnalyzerVersion: model.analyzerVersion, executionModelPath: path.relative(dir, modelPath),
      fullyUnderstood, coverage: compactCoverage(model.coverage) };
    const status = fullyUnderstood ? "snapshot_analyzed_exact" : "snapshot_analyzed_with_coverage_gaps";
    await finalizeSnapshotCurrentPointer({ outputRoot: scope, publishedPath: dir, manifestPath: verified.manifestPath,
      snapshotId, manifestSha256, previousCurrentExists: true, previousCurrentSnapshotId: snapshotId,
      previousCurrentManifestSha256: manifestSha256, expectedPointerBytes: pointerBytes, status,
      analysis: { executionAnalyzerVersion: model.analyzerVersion, sourceSignature: model.sourceSignature, fullyUnderstood, coverageLevel: model.coverage.level },
      publishIndexes: async () => {
        const undo: Array<() => Promise<void>> = [];
        const rollback = async () => { for (const restore of undo.reverse()) await restore(); };
        try {
          for (const [file, value] of [[modelPath, model], [indexPath, { ...index, analysis }]] as const) {
            if (!(await lstat(file)).isFile()) throw new Error("Expected regular analyzed snapshot file: " + file);
            const original = await readFile(file);
            await atomicWriteJsonFile(file, value);
            undo.push(() => atomicWriteFile(file, original));
          }
        } catch (error) { await rollback(); throw error; }
        return rollback;
      }
    });
    return { ok: true, status, snapshotId, exportDir: dir, verifiedObjects: manifestIndex.itemCount, analyzerVersion: model.analyzerVersion };
  } catch (error) {
    return { ok: false, status: error instanceof SnapshotFinalizeConflictError ? "snapshot_finalize_conflict" : "snapshot_reanalysis_refused", error: String(error) };
  }
}
