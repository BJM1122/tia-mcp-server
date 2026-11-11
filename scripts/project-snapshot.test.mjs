import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  assertSnapshotMatchesRequest,
  buildExportIndexFromSnapshot,
  finalizeSnapshotCurrentPointer,
  loadVerifiedSnapshotManifest,
  normalizeSnapshotManifest,
  parseSnapshotCoreResponse,
  persistSnapshotExportIndex,
  snapshotPathLabel
} from "../dist/project-snapshot.js";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("generated snapshot labels contain only ASCII path characters", () => {
  assert.equal(snapshotPathLabel("Line-4\u88c5\u914d\u7ebf_V20"), "Line-4__V20");
  assert.equal(snapshotPathLabel("\u9ed8\u8ba4\u53d8\u91cf\u8868"), "unnamed");
  assert.equal(snapshotPathLabel("../A:B / C"), "A_B_C");
  assert.equal(snapshotPathLabel("Line-5__V20"), "Line-5__V20");
  assert.equal(snapshotPathLabel("a".repeat(100)).length, 64);
});

test("snapshot core output requires the exact v1 one-shot envelope", () => {
  const parsed = parseSnapshotCoreResponse(JSON.stringify({
    protocolVersion: 1,
    requestId: "snapshot-export",
    ok: true,
    status: "complete",
    mode: "export_snapshot",
    snapshot: { publishedPath: "D:\\Output\\snapshots\\one" }
  }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.snapshot?.publishedPath, "D:\\Output\\snapshots\\one");

  assert.throws(
    () => parseSnapshotCoreResponse('{"protocolVersion":1,"requestId":"wrong","ok":true,"status":"complete"}'),
    /invalid v1 snapshot envelope/
  );
});

test("snapshot manifest rejects traversal paths before any indexed XML read", () => {
  assert.throws(
    () => normalizeSnapshotManifest({
      schemaVersion: "1.0",
      snapshotKind: "tia_openness_full_plc_snapshot",
      status: "consistent_complete",
      complete: true,
      createdAtUtc: "2026-07-29T00:00:00.000Z",
      project: {},
      consistency: { consistent: true, publishAllowed: true },
      objects: [{
        resourceKind: "block",
        blockKind: "FC",
        name: "Unsafe",
        relativePath: "..\\outside.xml",
        sha256: "0".repeat(64),
        bytes: 1,
        status: "exported"
      }]
    }),
    /unsafe XML relativePath/
  );
});

test("complete official snapshot becomes the existing bounded export-index shape", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tia-project-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const publishedPath = path.join(root, "snapshots", "20260729-test");
  const relativeXml = path.join("objects", "blocks", "FC3.xml");
  const xmlPath = path.join(publishedPath, relativeXml);
  await mkdir(path.dirname(xmlPath), { recursive: true });
  const xml = Buffer.from("<Document><SW.Blocks.FC /></Document>", "utf8");
  await writeFile(xmlPath, xml);
  const typeRelativeXml = path.join("objects", "types", "Motor.xml");
  const tagRelativeXml = path.join("objects", "tag-tables", "GlobalTags.xml");
  const typeXml = Buffer.from("<Document><SW.Types.PlcType /></Document>", "utf8");
  const tagXml = Buffer.from("<Document><SW.Tags.PlcTagTable /></Document>", "utf8");
  await mkdir(path.dirname(path.join(publishedPath, typeRelativeXml)), { recursive: true });
  await mkdir(path.dirname(path.join(publishedPath, tagRelativeXml)), { recursive: true });
  await writeFile(path.join(publishedPath, typeRelativeXml), typeXml);
  await writeFile(path.join(publishedPath, tagRelativeXml), tagXml);

  const manifest = {
    schemaVersion: "1.0",
    snapshotKind: "tia_openness_full_plc_snapshot",
    status: "consistent_complete",
    complete: true,
    publicationState: "candidate_not_current",
    snapshotId: "20260729-test",
    createdAtUtc: "2026-07-29T00:00:00.000Z",
    project: {
      canonicalProjectPath: "D:\\Projects\\Machine.ap20",
      name: "Machine"
    },
    objects: [
      {
        resourceKind: "block",
        kind: "FC",
        blockKind: "FC",
        name: "设备全局",
        number: 3,
        programmingLanguage: "LAD",
        softwarePath: "CPU_1\\PLC_1",
        relativePath: relativeXml,
        sha256: sha256(xml),
        bytes: xml.length,
        status: "exported"
      },
      {
        resourceKind: "plc_type",
        kind: "plc_type",
        blockKind: null,
        name: "Motor",
        number: null,
        programmingLanguage: null,
        softwarePath: "CPU_1\\PLC_1",
        relativePath: typeRelativeXml,
        sha256: sha256(typeXml),
        bytes: typeXml.length,
        status: "exported"
      },
      {
        resourceKind: "tag_table",
        kind: "tag_table",
        blockKind: null,
        name: "GlobalTags",
        number: null,
        programmingLanguage: null,
        softwarePath: "CPU_1\\PLC_1",
        relativePath: tagRelativeXml,
        sha256: sha256(tagXml),
        bytes: tagXml.length,
        status: "exported"
      }
    ],
    inventory: {
      before: { plcSoftwareCount: 1, traversalErrorCount: 0 },
      after: { plcSoftwareCount: 1, traversalErrorCount: 0 }
    },
    consistency: {
      consistent: true,
      publishAllowed: true,
      plcSoftwareIdentityMatches: true,
      inventoryTraversalComplete: true
    },
    openness: { attachCount: 1 },
    summary: {
      exportableCount: 3,
      exportedCount: 3,
      exportErrorCount: 0
    },
    safety: { projectMutation: false, plcAccessed: false }
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const manifestPath = path.join(publishedPath, "manifest.json");
  await writeFile(manifestPath, manifestBytes);

  const loaded = await loadVerifiedSnapshotManifest(publishedPath, sha256(manifestBytes));
  const built = await buildExportIndexFromSnapshot({
    ...loaded,
    snapshotId: "20260729-test"
  });

  assert.equal(built.reused, false);
  assert.equal(built.index.snapshotComplete, true);
  assert.equal(built.index.projectPath, "D:\\Projects\\Machine.ap20");
  assert.equal(built.index.itemCount, 3);
  assert.deepEqual(built.index.byKind, {
    FC: 1,
    "Type.PlcType": 1,
    "Tag.PlcTagTable": 1
  });
  assert.deepEqual(built.index.byLanguage, { LAD: 1 });
  assert.equal(built.index.items[0].name, "设备全局");
  assert.equal(built.index.items[0].number, "3");
  assert.equal(built.index.items[0].relativePath, relativeXml);
  assert.equal(built.index.items[1].kind, "Type.PlcType");
  assert.equal(built.index.items[2].kind, "Tag.PlcTagTable");

  const persisted = JSON.parse(await readFile(built.indexPath, "utf8"));
  assert.equal(persisted.source, "official_openness_snapshot");
  assert.equal(persisted.items[0].sha256, sha256(xml));
  // No DocumentInfo here, so the content hash equals the file hash.
  assert.equal(persisted.items[0].contentSha256, sha256(xml));

  const second = await buildExportIndexFromSnapshot({
    ...loaded,
    snapshotId: "20260729-test"
  });
  assert.equal(second.reused, true);

  const updated = {
    ...built.index,
    callCount: 1,
    calls: [{ source: "设备全局", target: "MotorControl" }]
  };
  await persistSnapshotExportIndex(built.indexPath, updated, publishedPath);
  assert.equal(JSON.parse(await readFile(built.indexPath, "utf8")).callCount, 1);
});

test("current pointer is finalized only after the analyzed candidate is reverified", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tia-project-snapshot-finalize-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshotId = "snapshot-finalized";
  const publishedPath = path.join(root, "snapshots", snapshotId);
  await mkdir(publishedPath, { recursive: true });
  const manifest = {
    schemaVersion: "1.0",
    snapshotKind: "tia_openness_full_plc_snapshot",
    status: "consistent_complete",
    complete: true,
    publicationState: "candidate_not_current",
    createdAtUtc: "2026-07-29T00:00:00.000Z",
    snapshotId,
    project: { canonicalProjectPath: "D:\\Projects\\Machine.ap20" },
    openness: { attachCount: 1 },
    inventory: {
      before: { plcSoftwareCount: 1, traversalErrorCount: 0 },
      after: { plcSoftwareCount: 1, traversalErrorCount: 0 }
    },
    consistency: {
      consistent: true,
      publishAllowed: true,
      plcSoftwareIdentityMatches: true,
      inventoryTraversalComplete: true
    },
    objects: [],
    summary: { exportableCount: 0, exportedCount: 0, exportErrorCount: 0 },
    safety: { projectMutation: false, plcAccessed: false }
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const manifestPath = path.join(publishedPath, "manifest.json");
  await writeFile(manifestPath, manifestBytes);
  await assert.rejects(readFile(path.join(root, "current.json"), "utf8"), /ENOENT/);

  const pointerPath = await finalizeSnapshotCurrentPointer({
    outputRoot: root,
    publishedPath,
    manifestPath,
    manifestSha256: sha256(manifestBytes),
    snapshotId,
    expectedCurrentPointerPath: path.join(root, "current.json"),
    previousCurrentExists: false,
    status: "snapshot_analyzed_with_coverage_gaps",
    analysis: { fullyUnderstood: false }
  });
  const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
  assert.equal(pointer.snapshotId, snapshotId);
  assert.equal(pointer.snapshotRelativePath, `snapshots/${snapshotId}`);
  assert.equal(pointer.status, "snapshot_analyzed_with_coverage_gaps");
  assert.equal(pointer.analysis.fullyUnderstood, false);

  await assert.rejects(
    finalizeSnapshotCurrentPointer({
      outputRoot: root,
      publishedPath,
      manifestPath,
      manifestSha256: sha256(manifestBytes),
      snapshotId,
      expectedCurrentPointerPath: path.join(root, "elsewhere.json"),
      previousCurrentExists: true,
      previousCurrentSnapshotId: snapshotId,
      previousCurrentManifestSha256: sha256(manifestBytes),
      status: "snapshot_analyzed_exact"
    }),
    /current pointer path does not match/
  );
});

test("interleaved candidate finalization uses a cross-process compare-and-swap identity", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tia-project-snapshot-cas-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const createCandidate = async (snapshotId) => {
    const publishedPath = path.join(root, "snapshots", snapshotId);
    await mkdir(publishedPath, { recursive: true });
    const manifest = {
      schemaVersion: "1.0",
      snapshotKind: "tia_openness_full_plc_snapshot",
      status: "consistent_complete",
      complete: true,
      publicationState: "candidate_not_current",
      createdAtUtc: "2026-07-29T00:00:00.000Z",
      snapshotId,
      project: { canonicalProjectPath: "D:\\Projects\\Machine.ap20" },
      openness: { attachCount: 1 },
      inventory: {
        before: { plcSoftwareCount: 1, traversalErrorCount: 0 },
        after: { plcSoftwareCount: 1, traversalErrorCount: 0 }
      },
      consistency: {
        consistent: true,
        publishAllowed: true,
        plcSoftwareIdentityMatches: true,
        inventoryTraversalComplete: true
      },
      objects: [],
      summary: { exportableCount: 0, exportedCount: 0, exportErrorCount: 0 },
      safety: { projectMutation: false, plcAccessed: false }
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const manifestPath = path.join(publishedPath, "manifest.json");
    await writeFile(manifestPath, manifestBytes);
    return {
      snapshotId,
      publishedPath,
      manifestPath,
      manifestSha256: sha256(manifestBytes)
    };
  };
  const older = await createCandidate("candidate-older");
  const newer = await createCandidate("candidate-newer");
  const currentPointerPath = path.join(root, "current.json");

  await finalizeSnapshotCurrentPointer({
    outputRoot: root,
    ...newer,
    expectedCurrentPointerPath: currentPointerPath,
    previousCurrentExists: false,
    status: "snapshot_analyzed_exact"
  });
  await assert.rejects(
    finalizeSnapshotCurrentPointer({
      outputRoot: root,
      ...older,
      expectedCurrentPointerPath: currentPointerPath,
      previousCurrentExists: false,
      status: "snapshot_analyzed_exact"
    }),
    /current\.json changed after native snapshot enumeration/
  );
  assert.equal(JSON.parse(await readFile(currentPointerPath, "utf8")).snapshotId, newer.snapshotId);

  const latest = await createCandidate("candidate-latest");
  await finalizeSnapshotCurrentPointer({
    outputRoot: root,
    ...latest,
    expectedCurrentPointerPath: currentPointerPath,
    previousCurrentExists: true,
    previousCurrentSnapshotId: newer.snapshotId,
    previousCurrentManifestSha256: newer.manifestSha256,
    status: "snapshot_analyzed_exact"
  });
  assert.equal(JSON.parse(await readFile(currentPointerPath, "utf8")).snapshotId, latest.snapshotId);
  await assert.rejects(readFile(path.join(root, ".current.json.lock"), "utf8"), /ENOENT/);
});

test("manifest hash mismatch is rejected before index creation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tia-project-snapshot-hash-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "manifest.json"), JSON.stringify({
    schemaVersion: "1.0",
    snapshotKind: "tia_openness_full_plc_snapshot",
    status: "consistent_complete",
    complete: true,
    createdAtUtc: "2026-07-29T00:00:00.000Z",
    project: {},
    consistency: { consistent: true, publishAllowed: true },
    objects: []
  }));

  await assert.rejects(
    loadVerifiedSnapshotManifest(root, "f".repeat(64)),
    /manifest SHA-256 does not match/
  );
});

test("snapshot request identity is locked end to end across response and manifest", () => {
  const request = {
    processId: 4_242,
    processStartTimeUtc: "2026-07-29T08:00:00.0000000Z",
    projectPath: "D:\\Projects\\Machine.ap20"
  };
  const core = {
    protocolVersion: 1,
    requestId: "snapshot-export",
    ok: true,
    status: "consistent_complete",
    snapshot: {
      snapshotId: "snapshot-1",
      complete: true
    }
  };
  const manifest = normalizeSnapshotManifest({
    schemaVersion: "1.0",
    snapshotKind: "tia_openness_full_plc_snapshot",
    status: "consistent_complete",
    complete: true,
    createdAtUtc: "2026-07-29T08:00:00.000Z",
    snapshotId: "snapshot-1",
    project: {
      processId: 4_242,
      processStartTimeUtc: "2026-07-29T08:00:00.0000000Z",
      canonicalProjectPath: "d:\\projects\\Machine.ap20"
    },
    consistency: { consistent: true, publishAllowed: true },
    objects: []
  });

  assert.doesNotThrow(() => assertSnapshotMatchesRequest(core, manifest, request));
  assert.throws(
    () => assertSnapshotMatchesRequest(core, {
      ...manifest,
      project: { ...manifest.project, processId: 4_243 }
    }, request),
    /processId does not match/
  );
  assert.throws(
    () => assertSnapshotMatchesRequest(core, {
      ...manifest,
      project: { ...manifest.project, canonicalProjectPath: "D:\\Projects\\Other.ap20" }
    }, request),
    /project path does not match/
  );
});
