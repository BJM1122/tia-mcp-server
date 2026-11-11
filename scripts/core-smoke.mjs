import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const cwd = process.cwd();
const serverPath = path.join(cwd, "dist", "index.js");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd
});
const client = new Client({ name: "tia-mcp-core-smoke", version: "0.0.0" });

await client.connect(transport);
try {
  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name);
  assert.equal(toolNames.length, 47);
  // --list-tools registers into a name collector; it must name exactly what the server serves.
  const catalog = JSON.parse(execFileSync(process.execPath, [serverPath, "--list-tools"], { cwd, encoding: "utf8" })).tools;
  assert.deepEqual([...catalog].sort(), [...toolNames].sort());
  for (const requiredTool of [
    "tia_hmi_authoring_capabilities",
    "tia_generate_unified_hmi_design",
    "tia_create_unified_hmi_project_plan",
    "tia_apply_unified_hmi_project",
    "tia_inspect_unified_hmi",
    "tia_create_unified_hmi_edit_plan",
    "tia_apply_unified_hmi_edit",
    "tia_create_hmi_project_plan",
    "tia_apply_hmi_project",
    "tia_edit_hmi_text",
    "tia_preview_hmi_design",
    "tia_generate_hmi_design",
    "tia_update_hmi_object",
    "tia_export_hmi_bundle",
    "tia_create_hmi_import_plan",
    "tia_apply_hmi_import",
    "tia_export_hmi_native",
    "tia_edit_hmi_native",
    "tia_read_hmi_alarm_export",
    "tia_analyze_hmi_alarms",
    "tia_list_hmi_targets",
    "tia_export_hmi_configuration",
    "tia_inspect_engineering",
    "tia_doctor",
    "tia_get_current_ui_context",
    "tia_query_live_project",
    "tia_search_live_objects",
    "tia_get_graph_context",
    "tia_get_current_block",
    "tia_read_block",
    "tia_search_export",
    "tia_trace_call_graph",
    "tia_fast_lookup",
    "tia_export_project_index",
    "tia_build_reference_index",
    "tia_trace_symbol",
    "tia_trace_data_flow",
    "tia_create_import_plan",
    "tia_apply_import"
  ]) {
    assert.ok(toolNames.includes(requiredTool), `Missing tool: ${requiredTool}`);
  }
  // Merged away in 0.28.0; none may come back beside its replacement.
  for (const removedTool of [
    "tia_validate_environment", "tia_live_core_status", "tia_online_capability_report", "tia_detect_project_profile",
    "tia_get_current_block_details", "tia_get_current_block_live_details", "tia_batch_live_query",
    "tia_get_block_xml", "tia_get_block_context", "tia_extract_block_interface", "tia_extract_symbols",
    "tia_search_blocks", "tia_search_xml_text", "tia_find_references", "tia_batch_lookup", "tia_entry_points_report",
    "tia_create_import_changeset_plan", "tia_apply_import_changeset"
  ]) {
    assert.ok(!toolNames.includes(removedTool), `Merged tool still registered: ${removedTool}`);
  }

  const doctor = await client.callTool({
    name: "tia_doctor",
    arguments: {}
  });
  assert.notEqual(doctor.isError, true, JSON.stringify(doctor));
  assert.equal(doctor.structuredContent?.serverVersion, "0.29.1");
  assert.equal(doctor.structuredContent?.guarantees?.tiaAttached, false);
  assert.equal(doctor.structuredContent?.guarantees?.residentWorkerStarted, false);

  const sections = await client.callTool({
    name: "tia_doctor",
    arguments: { portalVersion: "V20", onlineReport: true }
  });
  assert.notEqual(sections.isError, true, JSON.stringify(sections));
  assert.equal(sections.structuredContent?.liveCore, undefined);
  assert.equal(sections.structuredContent?.guarantees?.residentWorkerStarted, false);
  const validation = { structuredContent: sections.structuredContent?.environment };
  assert.equal(
    validation.structuredContent?.capabilities?.capabilities?.singleBlockImport?.available,
    doctor.structuredContent?.capabilityReport?.capabilities?.singleBlockImport?.available
  );
  assert.equal(
    validation.structuredContent?.capabilities?.capabilities?.projectExport?.available,
    doctor.structuredContent?.capabilityReport?.capabilities?.projectExport?.available
  );

  const online = { structuredContent: sections.structuredContent?.online };
  assert.ok(online.structuredContent?.summary);
  const report = online.structuredContent?.capabilityReport;
  const supportedNow = online.structuredContent?.supportedNow ?? [];
  if (!report?.capabilities?.projectExport?.available) {
    assert.ok(!supportedNow.some((item) => /Export all PLC blocks/i.test(item)));
  }
  if (!report?.capabilities?.singleBlockImport?.available) {
    assert.ok(!supportedNow.some((item) => /confirmed block import/i.test(item)));
  }

  const blockedWrite = await client.callTool({
    name: "tia_apply_import",
    arguments: {
      projectPath: "D:/path-that-must-not-be-opened/test.ap20",
      blocks: [{ xmlPath: "D:/path-that-must-not-be-read/test.xml", targetName: "NeverRun", targetNumber: "9999" }],
      confirmToken: "invalid-core-smoke-token"
    }
  });
  assert.equal(blockedWrite.structuredContent?.blocked, true);
  assert.equal(blockedWrite.structuredContent?.status, "confirmation_invalid_or_expired");

  const hmiApply = tools.tools.find(tool => tool.name === "tia_apply_hmi_import");
  assert.equal(hmiApply.annotations.readOnlyHint, false);
  assert.equal(hmiApply.annotations.idempotentHint, false);
  const blockedHmi = await client.callTool({ name: "tia_apply_hmi_import", arguments: {
    confirmToken: "00000000-0000-4000-8000-000000000000", planSha256: "0".repeat(64), approval: "APPLY_EXACT_HMI_PLAN"
  } });
  assert.equal(blockedHmi.isError, true);
  assert.match(blockedHmi.content[0].text, /missing, expired or already consumed/);
  const blockedProject = await client.callTool({ name: "tia_apply_hmi_project", arguments: {
    confirmToken: "00000000-0000-4000-8000-000000000000", planSha256: "0".repeat(64), approval: "CREATE_EXACT_HMI_PROJECT"
  } });
  assert.equal(blockedProject.isError, true);
  assert.match(blockedProject.content[0].text, /missing, expired or already consumed/);
  for(const [name,approval] of [['tia_apply_unified_hmi_project','CREATE_EXACT_UNIFIED_HMI_PROJECT'],['tia_apply_unified_hmi_edit','APPLY_EXACT_UNIFIED_HMI_EDIT']]) {
    const blocked=await client.callTool({name,arguments:{confirmToken:'00000000-0000-4000-8000-000000000000',planSha256:'0'.repeat(64),approval}});
    assert.equal(blocked.isError,true);assert.match(blocked.content[0].text,/missing, expired or already consumed/);
  }
  const unified=await client.callTool({name:'tia_generate_unified_hmi_design',arguments:{design:{adapter:'wincc-unified-v20',device:{model:'offline-only',width:800,height:480},startScreen:'Main',screens:[{name:'Main',number:1,elements:[]}]}}});
  assert.notEqual(unified.isError,true); assert.equal(JSON.parse(unified.content[0].text).nativeImportArchive,false);
  const design = await client.callTool({ name: "tia_generate_hmi_design", arguments: { design: {
    adapter: "wincc-classic-v20", device: { model: "offline-smoke", width: 800, height: 480 },
    screens: [{ name: "OfflineCandidate", number: 1, elements: [] }]
  } } });
  assert.notEqual(design.isError, true);
  const candidate = JSON.parse(design.content[0].text);
  assert.equal(candidate.artifacts.length, 1);
  assert.equal(candidate.projectCreated, false);
  assert.equal(candidate.nativeImportVerified, false);

  console.log(JSON.stringify({
    ok: true,
    toolCount: toolNames.length,
    status: doctor.structuredContent?.status,
    coreReadReady: report?.readiness?.coreReadReady ?? false,
    projectExportReady: report?.readiness?.projectExportReady ?? false,
    projectImportReady: report?.readiness?.projectImportReady ?? false,
    invalidWriteBlocked: true
  }, null, 2));
} finally {
  await client.close();
}
