import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const processId = Number(process.env.TIA_IMPORT_TEST_PROCESS_ID ?? "");
const projectPath = process.env.TIA_IMPORT_TEST_PROJECT_PATH ?? "";
const xmlPath = process.env.TIA_IMPORT_TEST_XML_PATH ?? "";
const targetName = process.env.TIA_IMPORT_TEST_TARGET_NAME ?? "";
const targetNumber = process.env.TIA_IMPORT_TEST_TARGET_NUMBER ?? "";
const enabled = Number.isInteger(processId) && processId > 0
  && projectPath !== ""
  && xmlPath !== ""
  && targetName !== ""
  && targetNumber !== "";

test("live import plan binds exact identity and a mismatched apply request cannot execute", {
  skip: enabled ? false : "Set TIA_IMPORT_TEST_* environment variables for the read-only live plan test."
}, async () => {
  const cwd = process.cwd();
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(cwd, "dist", "index.js")],
    cwd
  });
  const client = new Client({ name: "tia-import-plan-live-test", version: "0.0.0" });
  await client.connect(transport);

  try {
    const planned = await client.callTool({
      name: "tia_create_import_plan",
      arguments: {
        processId,
        projectPath,
        blocks: [{ xmlPath, targetName, targetNumber }],
        compileScope: "software",
        saveProject: true,
        timeoutMs: 20_000,
        note: "read-only live plan smoke"
      }
    });
    assert.notEqual(planned.isError, true);
    assert.equal(
      planned.structuredContent?.ok,
      true,
      JSON.stringify(planned.structuredContent, null, 2)
    );
    assert.equal(planned.structuredContent?.checks?.exactProjectMatch, true);
    assert.equal(planned.structuredContent?.writeStatus?.enabled, true);
    const confirmToken = planned.structuredContent?.writeStatus?.confirmToken;
    assert.match(confirmToken, /^TIA_IMPORT_[0-9a-f-]{36}$/);

    const blocked = await client.callTool({
      name: "tia_apply_import",
      arguments: {
        projectPath,
        blocks: [{ xmlPath, targetName: `${targetName}_MISMATCH`, targetNumber }],
        confirmToken
      }
    });
    assert.notEqual(blocked.isError, true);
    assert.equal(blocked.structuredContent?.ok, false);
    assert.equal(blocked.structuredContent?.blocked, true);
    assert.equal(blocked.structuredContent?.status, "plan_binding_mismatch");
    assert.equal(blocked.structuredContent?.downloadsToPlc, false);
  } finally {
    await client.close();
  }
});
