import assert from "node:assert/strict";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const cwd = process.cwd();
const transport = new StdioClientTransport({
  command: "node",
  args: [path.join(cwd, "dist", "index.js")],
  cwd
});
const client = new Client({ name: "tia-ui-context-smoke", version: "0.0.0" });

await client.connect(transport);
try {
  const listed = await client.listTools();
  const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
  for (const name of ["tia_get_current_ui_context", "tia_get_current_block"]) {
    const tool = byName.get(name);
    assert.ok(tool, `Missing tool: ${name}`);
    assert.equal(tool.annotations?.readOnlyHint, true, `${name} must be read-only`);
    assert.equal(tool.annotations?.destructiveHint, false, `${name} must be non-destructive`);
    assert.equal(tool.annotations?.idempotentHint, true, `${name} must be idempotent`);
  }

  const liveStarted = performance.now();
  const context = await client.callTool({
    name: "tia_get_current_ui_context",
    arguments: {
      includeExportMatches: true,
      timeoutMs: 15_000,
      maxNodes: 800,
      maxDepth: 8
    }
  });
  const liveElapsedMs = Math.round(performance.now() - liveStarted);
  assert.notEqual(context.isError, true, context.content?.[0]?.text);
  assert.equal(context.structuredContent?.readOnly, true);
  assert.equal(context.structuredContent?.guarantees?.polling, false);
  assert.equal(context.structuredContent?.guarantees?.hoverIdentification, false);
  if (process.env.TIA_UI_CONTEXT_EXPECT_EXPORT_MISMATCH === "1") {
    assert.equal(context.structuredContent?.context?.status, "selected");
    assert.equal(context.structuredContent?.exportResolution?.status, "not_found");
    assert.equal(context.structuredContent?.exportResolution?.match, null);
  }

  const details = await client.callTool({
    name: "tia_get_current_block",
    arguments: {
      source: "export",
      processId: 2_147_483_647,
      timeoutMs: 15_000,
      maxExportMatches: 5,
      includeInterface: false,
      includeExistingReferences: false
    }
  });
  assert.notEqual(details.isError, true, details.content?.[0]?.text);
  assert.equal(details.structuredContent?.readOnly, true);
  assert.equal(details.structuredContent?.guarantees?.projectOrPlcChanged, false);
  assert.equal(details.structuredContent?.status, "live_project_unavailable");

  console.log(JSON.stringify({
    ok: true,
    toolCount: listed.tools.length,
    detailUnavailableStatus: details.structuredContent?.status ?? "unknown",
    liveContextStatus: context.structuredContent?.context?.status ?? "unknown",
    liveWindowMinimized: context.structuredContent?.context?.processes?.find(
      (process) => process.processId === context.structuredContent?.context?.selectedProcessId
    )?.isMinimized ?? null,
    currentBlockStatus: context.structuredContent?.currentBlock?.status ?? "unknown",
    currentBlockLabel: context.structuredContent?.currentBlock?.block?.label ?? null,
    networkStatus: context.structuredContent?.context?.networkOrSection?.status ?? "unknown",
    networkNumber: context.structuredContent?.context?.networkOrSection?.number ?? null,
    exportResolutionStatus: context.structuredContent?.exportResolution?.status ?? null,
    liveElapsedMs
  }, null, 2));
} finally {
  await client.close();
}
