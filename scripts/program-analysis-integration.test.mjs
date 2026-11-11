import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { EXECUTION_ANALYZER_VERSION } from "../dist/execution-model.js";
import { findExportProjectIdentities } from "../dist/export-index.js";

const serverRoot = path.resolve(import.meta.dirname, "..");
const workspaceRoot = path.resolve(process.env.TIA_MCP_WORKSPACE_ROOT?.trim() || serverRoot);

test("MCP symbol trace includes GRAPH reset actions and source metadata", { timeout: 30000 }, async () => {
  const exportDir = path.join(workspaceRoot, "tia-exports", `.graph-write-test-${randomUUID()}`);
  const client = new Client({ name: "graph-write-test", version: "1" });
  try {
    await mkdir(path.join(exportDir, "_codex_index"), { recursive: true });
    const xml = `<Document><Sequence><Step Number="7" Name="Reset"><Actions>
<Action Qualifier="R"><Token Text="&quot;Alarms&quot;.Fault"/><Token Text="&#xA;"/></Action>
</Actions></Step></Sequence></Document>`;
    await writeFile(path.join(exportDir, "FB70.xml"), xml);
    await writeFile(path.join(exportDir, "_codex_index", "tia-export-index.json"), JSON.stringify({ items: [
      { name: "Sequence", kind: "FB", number: "70", programmingLanguage: "GRAPH", relativePath: "FB70.xml", softwarePath: "CPU_1", sha256: createHash("sha256").update(xml).digest("hex") }
    ], calls: [] }));
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(serverRoot, "dist/index.js")], cwd: serverRoot }));
    const result = await client.callTool({ name: "tia_trace_symbol", arguments: { exportDir, query: "Alarms.Fault", match: "exact" } });
    assert.equal(result.structuredContent.ok, true, JSON.stringify(result));
    const writes = result.structuredContent.execution.writes;
    assert.equal(writes.length, 1);
    assert.equal(writes[0].effect.mode, "reset");
    assert.equal(writes[0].graphAction.step, "7");
    assert.equal(writes[0].sourceKind, "GRAPH");
    assert.equal(writes[0].coverage, "conservative");
  } finally {
    await client.close();
    assert.ok(exportDir.startsWith(path.join(workspaceRoot, "tia-exports") + path.sep));
    await rm(exportDir, { recursive: true, force: true });
  }
});
const fakeUiContextScript = path.join(
  serverRoot,
  "scripts",
  "fixtures",
  "Get-FakeTiaPortalUiContext.ps1"
);

function access(uid, name) {
  return `<Access Scope="GlobalVariable" UId="${uid}"><Symbol><Component Name="${name}"/></Symbol></Access>`;
}

function ladFixture() {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<Document>",
    '  <SW.Blocks.OB ID="0">',
    "    <AttributeList>",
    "      <Name>Main</Name>",
    "      <Number>1</Number>",
    "      <ProgrammingLanguage>LAD</ProgrammingLanguage>",
    "    </AttributeList>",
    "    <ObjectList>",
    '      <SW.Blocks.CompileUnit ID="1">',
    "        <AttributeList><NetworkSource><FlgNet><Parts>",
    access("1", "Start"),
    access("2", "StopOk"),
    access("3", "MotorOn"),
    '          <Part UId="10" Name="Contact"/>',
    '          <Part UId="11" Name="Contact"><Negated Name="operand"/></Part>',
    '          <Part UId="12" Name="Coil"/>',
    "        </Parts><Wires>",
    '          <Wire UId="20"><Powerrail/><NameCon UId="10" Name="in"/></Wire>',
    '          <Wire UId="21"><IdentCon UId="1"/><NameCon UId="10" Name="operand"/></Wire>',
    '          <Wire UId="22"><NameCon UId="10" Name="out"/><NameCon UId="11" Name="in"/></Wire>',
    '          <Wire UId="23"><IdentCon UId="2"/><NameCon UId="11" Name="operand"/></Wire>',
    '          <Wire UId="24"><NameCon UId="11" Name="out"/><NameCon UId="12" Name="in"/></Wire>',
    '          <Wire UId="25"><IdentCon UId="3"/><NameCon UId="12" Name="operand"/></Wire>',
    "        </Wires></FlgNet></NetworkSource></AttributeList>",
    "      </SW.Blocks.CompileUnit>",
    "    </ObjectList>",
    "  </SW.Blocks.OB>",
    "</Document>"
  ].join("\n");
}

test("existing MCP analysis tools prefer the execution model while preserving legacy fields", {
  timeout: 30_000
}, async (t) => {
  const serverPath = path.join(serverRoot, "dist", "index.js");
  if (!existsSync(serverPath)) {
    t.skip("Run npm run build before the integration test.");
    return;
  }
  const exportDir = path.join(
    workspaceRoot,
    "tia-exports",
    `.program-analysis-test-${process.pid}-${randomUUID()}`
  );
  t.after(() => rm(exportDir, { recursive: true, force: true }));
  const xml = ladFixture();
  const sha256 = createHash("sha256").update(xml).digest("hex");
  const items = [];
  for (const number of ["1", "2", "3"]) {
    const relativePath = path.join("objects", "blocks", `MotorLogic${number}.xml`);
    const xmlPath = path.join(exportDir, relativePath);
    await mkdir(path.dirname(xmlPath), { recursive: true });
    await writeFile(xmlPath, xml, "utf8");
    items.push({
      name: `Main${number}`,
      number,
      kind: "OB",
      programmingLanguage: "LAD",
      relativePath,
      sha256,
      softwarePath: "CPU_1\\PLC_1"
    });
  }
  const indexDir = path.join(exportDir, "_codex_index");
  await mkdir(indexDir, { recursive: true });
  await writeFile(path.join(indexDir, "tia-export-index.json"), JSON.stringify({
    schemaVersion: "2.0",
    source: "synthetic_offline_test",
    generatedAt: "2026-07-29T00:00:00.000Z",
    exportDir,
    xmlFileCount: 3,
    itemCount: 3,
    callCount: 0,
    errorCount: 0,
    byKind: { OB: 3 },
    byLanguage: { LAD: 3 },
    items,
    calls: [],
    errors: []
  }, null, 2), "utf8");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: serverRoot,
    stderr: "pipe"
  });
  const client = new Client({ name: "program-analysis-integration", version: "0.0.0" });
  await client.connect(transport);
  try {
    const built = await client.callTool({
      name: "tia_build_reference_index",
      arguments: { exportDir, forceRebuild: true }
    });
    assert.notEqual(built.isError, true, JSON.stringify(built));
    assert.equal(built.structuredContent?.ok, true);
    assert.equal(built.structuredContent?.executionModel?.writeSiteCount, 3);
    assert.equal(built.structuredContent?.executionModel?.coverage?.level, "exact");

    const trace = await client.callTool({
      name: "tia_trace_symbol",
      arguments: {
        exportDir,
        query: "MotorOn",
        match: "suffix",
        autoBuild: true,
        limit: 1
      }
    });
    assert.equal(trace.structuredContent?.preferredResult, "execution");
    assert.equal(trace.structuredContent?.execution?.writes?.length, 1);
    assert.equal(trace.structuredContent?.execution?.total?.writes, 3);
    assert.equal(trace.structuredContent?.execution?.truncated, true);
    assert.equal(trace.structuredContent?.execution?.writes?.[0]?.target, "MotorOn");
    assert.equal(trace.structuredContent?.execution?.writes?.[0]?.guard?.kind, "and");

    const flow = await client.callTool({
      name: "tia_trace_data_flow",
      arguments: {
        exportDir,
        query: "MotorOn",
        direction: "upstream",
        match: "suffix",
        maxDepth: 3,
        maxNodes: 2,
        autoBuild: true
      }
    });
    assert.equal(flow.structuredContent?.preferredResult, "execution");
    assert.equal(flow.structuredContent?.execution?.orderedWriteSites?.length, 2);
    assert.equal(flow.structuredContent?.execution?.query?.total?.writes, 3);
    assert.equal(flow.structuredContent?.execution?.query?.truncated, true);
    assert.equal(flow.structuredContent?.execution?.coverage?.level, "exact");
    assert.ok(flow.structuredContent?.flow, "Legacy bounded flow remains present for compatibility.");

    const fast = await client.callTool({
      name: "tia_fast_lookup",
      arguments: { exportDir, query: "MotorOn", autoBuild: true, limit: 1 }
    });
    assert.equal(fast.structuredContent?.preferredResult, "execution");
    assert.equal(fast.structuredContent?.execution?.writes?.length, 1);
    assert.equal(fast.structuredContent?.execution?.total?.writes, 3);
    assert.equal(fast.structuredContent?.execution?.truncated, true);
  } finally {
    await client.close();
  }
});

test("changed execution XML aggregate byte limit is reported as explicitly incomplete", {
  timeout: 30_000
}, async (t) => {
  const serverPath = path.join(serverRoot, "dist", "index.js");
  if (!existsSync(serverPath)) {
    t.skip("Run npm run build before the integration test.");
    return;
  }
  const exportDir = path.join(
    workspaceRoot,
    "tia-exports",
    `.program-analysis-budget-test-${process.pid}-${randomUUID()}`
  );
  t.after(() => rm(exportDir, { recursive: true, force: true }));
  const relativePath = path.join("objects", "blocks", "Main.xml");
  const xmlPath = path.join(exportDir, relativePath);
  await mkdir(path.dirname(xmlPath), { recursive: true });
  const xml = ladFixture();
  const sha256 = createHash("sha256").update(xml).digest("hex");
  await writeFile(xmlPath, xml, "utf8");
  const indexDir = path.join(exportDir, "_codex_index");
  await mkdir(indexDir, { recursive: true });
  await writeFile(path.join(indexDir, "tia-export-index.json"), JSON.stringify({
    schemaVersion: "2.0",
    source: "synthetic_offline_test",
    generatedAt: "2026-07-29T00:00:00.000Z",
    exportDir,
    xmlFileCount: 1,
    itemCount: 1,
    callCount: 0,
    errorCount: 0,
    byKind: { OB: 1 },
    byLanguage: { LAD: 1 },
    items: [{
      name: "Main",
      number: "1",
      kind: "OB",
      programmingLanguage: "LAD",
      relativePath,
      sha256,
      softwarePath: "CPU_1\\PLC_1"
    }],
    calls: [],
    errors: []
  }, null, 2), "utf8");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: serverRoot,
    env: {
      TIA_MCP_EXECUTION_CHANGED_XML_MAX_BYTES: "64"
    },
    stderr: "pipe"
  });
  const client = new Client({ name: "program-analysis-budget-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const built = await client.callTool({
      name: "tia_build_reference_index",
      arguments: { exportDir, forceRebuild: true }
    });
    assert.notEqual(built.isError, true, JSON.stringify(built));
    assert.equal(built.structuredContent?.ok, false);
    assert.equal(
      built.structuredContent?.status,
      "execution_analysis_incomplete_xml_byte_limit"
    );
    assert.equal(built.structuredContent?.executionModel?.xmlByteLimit, 64);
    assert.equal(built.structuredContent?.executionModel?.xmlByteLimitExceeded, true);
    assert.equal(built.structuredContent?.executionModel?.xmlBytesRead, 0);
    assert.deepEqual(
      built.structuredContent?.executionModel?.incremental?.pendingBlockKeys,
      ["cpu_1\\plc_1::OB:1"]
    );
  } finally {
    await client.close();
  }
});

test("current block details never reuse an execution model whose descriptors are stale", {
  timeout: 30_000
}, async (t) => {
  const serverPath = path.join(serverRoot, "dist", "index.js");
  if (!existsSync(serverPath)) {
    t.skip("Run npm run build before the integration test.");
    return;
  }
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tia-current-execution-test-"));
  const exportDir = path.join(
    workspaceRoot,
    "tia-exports",
    `.program-analysis-current-test-${process.pid}-${randomUUID()}`
  );
  t.after(() => Promise.all([
    rm(tempDir, { recursive: true, force: true }),
    rm(exportDir, { recursive: true, force: true })
  ]));

  const exactProjectPath = "E:\\Projects\\Assembly\\GenericLine.ap20";
  const uiContextFile = path.join(tempDir, "ui-context.json");
  await writeFile(uiContextFile, JSON.stringify({
    schemaVersion: "1.0",
    observedAt: "2026-07-29T00:00:00.000Z",
    status: "selected",
    selectedProcessId: 4_242,
    foregroundProcessId: 4_242,
    foregroundWindowHandle: 1_001,
    processes: [{
      processId: 4_242,
      projectName: "GenericLine",
      projectPath: exactProjectPath,
      processStartTimeUtc: "2026-07-29T00:00:00.0000000Z",
      mainWindowHandle: 1_001,
      windowTitle: "Siemens - GenericLine",
      isMinimized: false
    }],
    selectedObject: {
      status: "resolved",
      text: "Main [OB1]",
      source: "project_navigator_msaa",
      candidates: []
    },
    activeEditor: {
      status: "resolved",
      breadcrumb: "Project\\CPU\\Program blocks\\Main [OB1]",
      source: "editor_frame_msaa",
      candidates: []
    },
    networkOrSection: {
      status: "resolved",
      label: "Network 1",
      number: "1",
      source: "network_container_msaa",
      candidates: []
    },
    limitations: ["Synthetic test context."]
  }), "utf8");

  const relativePath = path.join("objects", "blocks", "Main.xml");
  const xmlPath = path.join(exportDir, relativePath);
  await mkdir(path.dirname(xmlPath), { recursive: true });
  const initialXml = ladFixture();
  await writeFile(xmlPath, initialXml, "utf8");
  const indexDir = path.join(exportDir, "_codex_index");
  await mkdir(indexDir, { recursive: true });
  await writeFile(path.join(exportDir, "manifest.json"), JSON.stringify({
    project: {
      canonicalProjectPath: exactProjectPath,
      name: "GenericLine"
    }
  }), "utf8");
  const indexPath = path.join(indexDir, "tia-export-index.json");
  const makeIndex = (xml) => ({
    schemaVersion: "2.0",
    source: "synthetic_offline_test",
    generatedAt: "2026-07-29T00:00:00.000Z",
    exportDir,
    xmlFileCount: 1,
    itemCount: 1,
    callCount: 0,
    errorCount: 0,
    byKind: { OB: 1 },
    byLanguage: { LAD: 1 },
    items: [{
      name: "Main",
      number: "1",
      kind: "OB",
      programmingLanguage: "LAD",
      relativePath,
      sha256: createHash("sha256").update(xml).digest("hex"),
      softwarePath: "CPU_1\\PLC_1"
    }],
    calls: [],
    errors: []
  });
  await writeFile(indexPath, JSON.stringify(makeIndex(initialXml), null, 2), "utf8");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: serverRoot,
    env: {
      TIA_MCP_UI_CONTEXT_SCRIPT: fakeUiContextScript,
      TIA_MCP_TEST_UI_CONTEXT_FILE: uiContextFile
    },
    stderr: "pipe"
  });
  const client = new Client({ name: "program-analysis-current-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const built = await client.callTool({
      name: "tia_build_reference_index",
      arguments: { exportDir, forceRebuild: true }
    });
    assert.equal(built.structuredContent?.ok, true);

    const changedXml = initialXml.replaceAll("MotorOn", "MotorChangedAfterSnapshot");
    await writeFile(xmlPath, changedXml, "utf8");
    await writeFile(indexPath, JSON.stringify(makeIndex(changedXml), null, 2), "utf8");

    const details = await client.callTool({
      name: "tia_get_current_block",
      arguments: {
        source: "export",
        processId: 4_242,
        exportDir,
        includeInterface: false,
        includeExistingReferences: true,
        limit: 20
      }
    });
    assert.equal(details.structuredContent?.ok, true, JSON.stringify(details));
    assert.equal(details.structuredContent?.details?.existingExecutionModel?.found, true);
    assert.equal(
      details.structuredContent?.details?.existingExecutionModel?.descriptorsCurrent,
      false
    );
    assert.equal(details.structuredContent?.details?.existingExecutionModel?.reused, false);
    assert.equal(details.structuredContent?.details?.lookup?.execution, null);
  } finally {
    await client.close();
  }
});

test("automatic project matching accepts only the verified analyzed current snapshot", {
  timeout: 30_000
}, async (t) => {
  const serverPath = path.join(serverRoot, "dist", "index.js");
  if (!existsSync(serverPath)) {
    t.skip("Run npm run build before the integration test.");
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tia-current-discovery-test-"));
  const discoveryRoot = path.join(
    workspaceRoot,
    "tia-exports",
    `.snapshot-discovery-test-${process.pid}-${randomUUID()}`
  );
  const scopeDir = path.join(discoveryRoot, "GenericLine-0123456789ab");
  const exactProjectPath = "E:\\Projects\\Assembly\\GenericLine.ap20";
  const currentSnapshotId = "20260729T0100000000000Z-current";
  const historicalSnapshotId = "20260729T0000000000000Z-history";
  const incompleteCandidateId = "20260729T0200000000000Z-candidate";
  t.after(() => Promise.all([
    rm(tempDir, { recursive: true, force: true }),
    rm(discoveryRoot, { recursive: true, force: true })
  ]));

  const createSnapshot = async (snapshotId, analysisComplete, targetScope = scopeDir) => {
    const exportDir = path.join(targetScope, "snapshots", snapshotId);
    const indexDir = path.join(exportDir, "_codex_index");
    await mkdir(indexDir, { recursive: true });
    const manifest = {
      schemaVersion: "1.0",
      snapshotKind: "tia_openness_full_plc_snapshot",
      status: "consistent_complete",
      complete: true,
      publicationState: "candidate_not_current",
      createdAtUtc: "2026-07-29T00:00:00.000Z",
      snapshotId,
      project: {
        canonicalProjectPath: exactProjectPath,
        name: "GenericLine"
      },
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
      summary: {
        exportableCount: 0,
        exportedCount: 0,
        exportErrorCount: 0
      },
      safety: {
        projectMutation: false,
        plcAccessed: false
      }
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
    await writeFile(path.join(exportDir, "manifest.json"), manifestBytes);

    const sourceSignature = `source-${snapshotId}`;
    const executionModelRelativePath = path.join("_codex_index", "tia-execution-model.json");
    const index = {
      schemaVersion: "2.0",
      source: "official_openness_snapshot",
      generatedAt: snapshotId === incompleteCandidateId ? "2026-07-29T02:00:00.000Z" : "2026-07-29T00:00:00.000Z",
      exportDir,
      projectPath: exactProjectPath,
      projectName: "GenericLine",
      snapshotId,
      snapshotManifest: "manifest.json",
      snapshotManifestSha256: manifestSha256,
      snapshotComplete: true,
      xmlFileCount: 0,
      itemCount: 0,
      callCount: 0,
      errorCount: 0,
      byKind: {},
      byLanguage: {},
      items: [],
      calls: [],
      errors: [],
      ...(analysisComplete ? {
        analysis: {
          executionAnalyzerVersion: EXECUTION_ANALYZER_VERSION,
          executionModelPath: executionModelRelativePath,
          fullyUnderstood: true,
          coverage: {
            level: "exact",
            exactSites: 0,
            conservativeSites: 0,
            unsupportedSites: 0,
            issues: []
          }
        }
      } : {})
    };
    await writeFile(
      path.join(indexDir, "tia-export-index.json"),
      `${JSON.stringify(index, null, 2)}\n`,
      "utf8"
    );
    if (analysisComplete) {
      await writeFile(
        path.join(exportDir, executionModelRelativePath),
        `${JSON.stringify({
          schemaVersion: 1,
          analyzerVersion: EXECUTION_ANALYZER_VERSION,
          generatedAt: "2026-07-29T00:00:00.000Z",
          sourceSignature,
          blocks: {},
          writeSites: [],
          callSites: [],
          roots: [],
          adjacency: {},
          unresolvedCalls: [],
          coverage: {
            level: "exact",
            exactSites: 0,
            conservativeSites: 0,
            unsupportedSites: 0,
            issues: []
          },
          incremental: {
            changedBlockKeys: [],
            addedBlockKeys: [],
            removedBlockKeys: [],
            dependentBlockKeys: [],
            xmlRequiredBlockKeys: [],
            reusableBlockKeys: [],
            pendingBlockKeys: []
          }
        }, null, 2)}\n`,
        "utf8"
      );
    }
    return { exportDir, manifestSha256, sourceSignature };
  };

  const current = await createSnapshot(currentSnapshotId, true);
  await createSnapshot(historicalSnapshotId, true);
  await createSnapshot(incompleteCandidateId, false);
  const currentPointerPath = path.join(scopeDir, "current.json");
  const currentPointer = {
    schemaVersion: "1.0",
    snapshotId: currentSnapshotId,
    snapshotRelativePath: `snapshots/${currentSnapshotId}`,
    manifestRelativePath: `snapshots/${currentSnapshotId}/manifest.json`,
    manifestSha256: current.manifestSha256,
    status: "snapshot_analyzed_exact",
    complete: true,
    publishedAtUtc: "2026-07-29T01:00:00.000Z",
    analysis: {
      executionAnalyzerVersion: EXECUTION_ANALYZER_VERSION,
      sourceSignature: current.sourceSignature,
      fullyUnderstood: true,
      coverageLevel: "exact"
    }
  };
  await writeFile(currentPointerPath, `${JSON.stringify(currentPointer, null, 2)}\n`, "utf8");
  const testRoot = path.join(discoveryRoot, "_test");
  const testScope = path.join(testRoot, "GenericLine-test");
  const testCurrent = await createSnapshot(currentSnapshotId, true, testScope);
  await writeFile(path.join(testScope, "current.json"), `${JSON.stringify(currentPointer)}\n`, "utf8");

  const uiContextFile = path.join(tempDir, "ui-context.json");
  await writeFile(uiContextFile, JSON.stringify({
    schemaVersion: "1.0",
    observedAt: "2026-07-29T00:00:00.000Z",
    status: "selected",
    selectedProcessId: 4_242,
    foregroundProcessId: 4_242,
    foregroundWindowHandle: 1_001,
    processes: [{
      processId: 4_242,
      projectName: "GenericLine",
      projectPath: exactProjectPath,
      processStartTimeUtc: "2026-07-29T00:00:00.0000000Z",
      mainWindowHandle: 1_001,
      windowTitle: "Siemens - GenericLine",
      isMinimized: false
    }],
    selectedObject: { status: "unavailable", source: "project_navigator_msaa", candidates: [] },
    activeEditor: { status: "unavailable", source: "editor_frame_msaa", candidates: [] },
    networkOrSection: { status: "unavailable", source: "network_container_msaa", candidates: [] },
    limitations: ["Synthetic current snapshot discovery context."]
  }), "utf8");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: serverRoot,
    env: {
      TIA_MCP_UI_CONTEXT_SCRIPT: fakeUiContextScript,
      TIA_MCP_TEST_UI_CONTEXT_FILE: uiContextFile
    },
    stderr: "pipe"
  });
  const client = new Client({ name: "snapshot-current-discovery-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const listed = await client.callTool({
      name: "tia_list_export_indexes",
      arguments: { roots: [discoveryRoot], maxResults: 10 }
    });
    assert.equal(listed.structuredContent?.indexes?.length, 1, JSON.stringify(listed));
    assert.equal(listed.structuredContent.indexes[0].summary.snapshotId, currentSnapshotId);
    assert.equal(listed.structuredContent.indexes[0].historyCount, 3);
    assert.deepEqual(listed.structuredContent.omitted, { historySnapshots: 2, testDirectories: 1, filteredOut: 0, beyondMaxResults: 0 });
    const history = await client.callTool({
      name: "tia_list_export_indexes",
      arguments: { roots: [discoveryRoot], maxResults: 10, includeHistory: true }
    });
    assert.equal(history.structuredContent?.indexes?.length, 3, JSON.stringify(history));
    assert.equal(history.structuredContent.omitted.historySnapshots, 0);
    const bySnapshotId = new Map(
      history.structuredContent.indexes.map((item) => [item.summary.snapshotId, item])
    );
    assert.equal(bySnapshotId.get(currentSnapshotId)?.publication?.state, "current");
    assert.equal(
      bySnapshotId.get(currentSnapshotId)?.publication?.automaticMatchEligible,
      true
    );
    assert.equal(
      bySnapshotId.get(historicalSnapshotId)?.publication?.state,
      "historical_or_candidate"
    );
    assert.equal(
      bySnapshotId.get(historicalSnapshotId)?.publication?.automaticMatchEligible,
      false
    );
    assert.equal(
      bySnapshotId.get(incompleteCandidateId)?.publication?.state,
      "candidate_incomplete"
    );
    const withTests = await client.callTool({
      name: "tia_list_export_indexes",
      arguments: { roots: [discoveryRoot], includeTestSnapshots: true }
    });
    assert.equal(withTests.structuredContent.indexes.length, 2);
    assert.equal(withTests.structuredContent.omitted.testDirectories, 0);
    assert.ok(withTests.structuredContent.indexes.some((item) => item.exportDir === testCurrent.exportDir));
    const explicitTestRoot = await client.callTool({
      name: "tia_list_export_indexes", arguments: { roots: [testRoot] }
    });
    assert.equal(explicitTestRoot.structuredContent.indexes.length, 1);
    assert.equal(explicitTestRoot.structuredContent.omitted.testDirectories, 0);
    assert.equal((await findExportProjectIdentities([testRoot], 10)).length, 1);
    assert.equal((await findExportProjectIdentities([discoveryRoot], 10)).length, 1);

    const matched = await client.callTool({
      name: "tia_get_current_ui_context",
      arguments: {
        processId: 4_242,
        roots: [discoveryRoot],
        includeExportMatches: true,
        maxExportMatches: 10,
        timeoutMs: 10_000,
        maxNodes: 100,
        maxDepth: 4
      }
    });
    assert.equal(matched.structuredContent?.exportResolution?.status, "matched");
    assert.equal(matched.structuredContent?.exportResolution?.matches?.length, 1);
    assert.equal(
      path.resolve(matched.structuredContent?.exportResolution?.match?.exportDir),
      path.resolve(current.exportDir)
    );
    assert.equal(
      matched.structuredContent?.exportResolution?.match?.publication?.state,
      "current"
    );

    await writeFile(currentPointerPath, `${JSON.stringify({
      ...currentPointer,
      manifestSha256: "f".repeat(64)
    }, null, 2)}\n`, "utf8");
    const invalidCurrent = await client.callTool({
      name: "tia_get_current_ui_context",
      arguments: {
        processId: 4_242,
        roots: [discoveryRoot],
        includeExportMatches: true,
        maxExportMatches: 10,
        timeoutMs: 10_000,
        maxNodes: 100,
        maxDepth: 4
      }
    });
    assert.equal(invalidCurrent.structuredContent?.exportResolution?.status, "not_found");
    assert.equal(invalidCurrent.structuredContent?.exportResolution?.matches?.length, 0);

    const listedAfterInvalidPointer = await client.callTool({
      name: "tia_list_export_indexes",
      arguments: { roots: [discoveryRoot], maxResults: 10 }
    });
    assert.equal(listedAfterInvalidPointer.structuredContent?.indexes?.length, 1);
    assert.equal(listedAfterInvalidPointer.structuredContent.indexes[0].summary.snapshotId, incompleteCandidateId);
    assert.equal(listedAfterInvalidPointer.structuredContent.indexes[0].historyCount, 3);
    assert.equal(listedAfterInvalidPointer.structuredContent.omitted.historySnapshots, 2);
    assert.match(listedAfterInvalidPointer.structuredContent.indexes[0].publication.reason, /manifest.*hash|sha-?256/i);
    assert.equal(
      listedAfterInvalidPointer.structuredContent.indexes.every(
        (item) => item.publication?.automaticMatchEligible === false
      ),
      true
    );
    await rm(currentPointerPath);
    const missingPointer = await client.callTool({
      name: "tia_list_export_indexes", arguments: { roots: [scopeDir] }
    });
    assert.equal(missingPointer.structuredContent.indexes[0].summary.snapshotId, incompleteCandidateId);
    assert.equal(missingPointer.structuredContent.indexes[0].publication.currentPointerStatus, "missing");
    assert.ok(missingPointer.structuredContent.indexes[0].publication.reason);
    assert.equal(
      listedAfterInvalidPointer.structuredContent.indexes.every(
        (item) => item.publication?.currentPointerStatus === "invalid"
      ),
      true
    );
  } finally {
    await client.close();
  }
});

test("export discovery filters before limiting and returns compact coverage unless explicitly requested", {
  timeout: 30_000
}, async (t) => {
  const root = path.join(workspaceRoot, "tia-exports", `.index-summary-test-${randomUUID()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const issues = [{ reason: "Conservative call", blockKey: "OB:1" }, { reason: "Unsupported instruction" }];
  const projectPath = "E:\\Projects\\Assembly\\Target.ap20";
  const targetDir = path.join(root, "b-target");
  for (const [dir, projectName] of [[path.join(root, "a-other"), "Other"], [targetDir, "TargetLine"]]) {
    await mkdir(path.join(dir, "_codex_index"), { recursive: true });
    await writeFile(path.join(dir, "_codex_index", "tia-export-index.json"), JSON.stringify({
      exportDir: dir, projectName, projectPath: projectName === "Other" ? "E:\\Other.ap20" : projectPath,
      analysis: {
        executionAnalyzerVersion: "test", executionModelPath: "model.json", fullyUnderstood: false,
        extraAnalysisData: "must not leak",
        coverage: { level: "conservative", exactSites: 3, conservativeSites: 2, unsupportedSites: 1, issues, extraCoverageData: "must not leak" }
      }
    }));
  }
  const client = new Client({ name: "index-summary-test", version: "1" });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [path.join(serverRoot, "dist", "index.js")], cwd: serverRoot, stderr: "pipe"
  }));
  try {
    const list = async (args) => {
      const result = await client.callTool({ name: "tia_list_export_indexes", arguments: { roots: [root], maxResults: 1, ...args } });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return result.structuredContent;
    };
    assert.equal((await list({})).omitted.beyondMaxResults, 1);
    const filtered = await list({ projectName: "gEtLi" });
    assert.equal(filtered.indexes.length, 1);
    assert.equal(filtered.indexes[0].exportDir, targetDir);
    assert.deepEqual(filtered.omitted, { historySnapshots: 0, testDirectories: 0, filteredOut: 1, beyondMaxResults: 0 });
    const analysis = filtered.indexes[0].summary.analysis;
    assert.deepEqual(analysis, {
      executionAnalyzerVersion: "test", executionModelPath: "model.json", fullyUnderstood: false,
      coverage: { level: "conservative", exactSites: 3, conservativeSites: 2, unsupportedSites: 1, issueCount: 2 }
    });
    const pathFiltered = await list({ projectPath: "e:/projects/Assembly/sub/../Target.ap20" });
    assert.equal(pathFiltered.indexes[0].exportDir, targetDir);
    assert.equal(pathFiltered.omitted.filteredOut, 1);
    assert.equal((await list({ projectName: "absent" })).indexes.length, 0);
    assert.equal((await list({ projectPath: "E:\\Projects\\Assembly\\Target.ap20.extra" })).indexes.length, 0);
    assert.equal((await list({ projectName: "Other", projectPath })).indexes.length, 0);
    for (const includeCoverageIssues of [undefined, false, true]) {
      const read = await client.callTool({
        name: "tia_read_export_index",
        arguments: { exportDir: targetDir, ...(includeCoverageIssues === undefined ? {} : { includeCoverageIssues }) }
      });
      assert.notEqual(read.isError, true, JSON.stringify(read));
      const coverage = read.structuredContent.summary.analysis.coverage;
      assert.equal(coverage.issueCount, 2);
      if (includeCoverageIssues) assert.deepEqual(coverage.issues, issues);
      else assert.equal(Object.hasOwn(coverage, "issues"), false);
    }
  } finally {
    await client.close();
  }
});
