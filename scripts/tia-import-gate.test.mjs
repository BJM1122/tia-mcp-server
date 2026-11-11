import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("import plans bind the self-tested importer and exact TIA Openness API identity", async () => {
  // Both apply paths (one block and several) run the shared runImporterApply in import-apply.ts.
  const tool = await readFile(path.join(process.cwd(), "src", "tools", "plc-import.ts"), "utf8");
  const source = await readFile(path.join(process.cwd(), "src", "tools", "import-apply.ts"), "utf8");
  const importer = await readFile(path.join(process.cwd(), "src", "plc-importer.ts"), "utf8");
  const selfTestStart = importer.indexOf("async function verifyImporterOffline(");
  const checkStart = source.indexOf("async function plannedRuntimeChange(");
  const applyStart = source.indexOf("export async function runImporterApply<");
  const importerLaunch = source.indexOf("runProcess(plan.importerExePath", applyStart);
  assert.match(tool, /const applyOne = op\([\s\S]*return runImporterApply\(\{[\s\S]*registerTool\(\s*"tia_apply_import"/);

  assert.ok(selfTestStart >= 0);
  assert.ok(checkStart >= 0);
  assert.ok(applyStart >= 0);
  assert.ok(importerLaunch > applyStart);

  // verifyImporterOffline is the last declaration in plc-importer.ts. The plan
  // binds the digests this self-test computed from the exact files it ran.
  const selfTestSource = importer.slice(selfTestStart);
  assert.match(selfTestSource, /sha256File\(importerExe\)/);
  assert.match(selfTestSource, /sha256File\(apiDll\)/);
  assert.doesNotMatch(selfTestSource, /mtimeMs|size/);
  assert.doesNotMatch(selfTestSource, /=== 20\b/);

  // One runtime check compares the planned importer and API by path and digest.
  const checkSource = source.slice(checkStart, source.indexOf("\n}\n", checkStart));
  assert.match(checkSource, /importerSha256 !== plan\.importerExeSha256/);
  assert.match(checkSource, /apiSha256 !== plan\.opennessApiDllSha256/);
  assert.match(checkSource, /sameCanonicalPath\(importerExePath, plan\.importerExePath\)/);
  assert.match(checkSource, /sameCanonicalPath\(api\.dllPath, plan\.opennessApiDllPath\)/);

  // It runs after every other revalidation and right before the token is taken
  // at the point of no return, so a concurrent apply cannot also run.
  const beforeImporterLaunch = source.slice(applyStart, importerLaunch);
  const check = beforeImporterLaunch.indexOf("await plannedRuntimeChange(plan)");
  const consume = beforeImporterLaunch.indexOf("store.consume(confirmToken)");
  assert.ok(beforeImporterLaunch.indexOf("live_identity_changed") >= 0);
  assert.ok(check > beforeImporterLaunch.indexOf("live_identity_changed"));
  assert.ok(consume > check);
  // The importer rechecks the approved XML digest and the exact process start on launch.
  assert.match(tool, /"--xml-sha256", plan\.xmlSha256/);
  assert.match(source, /"--process-start-time-utc", plan\.processStartTimeUtc/);
  assert.match(beforeImporterLaunch, /"--api", plan\.opennessApiDllPath/);
});

test("import tools expose the correct mutation metadata and reject an invalid token before any write", async () => {
  const cwd = process.cwd();
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(cwd, "dist", "index.js")],
    cwd
  });
  const client = new Client({ name: "tia-import-gate-test", version: "0.0.0" });
  await client.connect(transport);

  try {
    const tools = await client.listTools();
    const planTool = tools.tools.find((tool) => tool.name === "tia_create_import_plan");
    const applyTool = tools.tools.find((tool) => tool.name === "tia_apply_import");

    assert.ok(planTool);
    assert.ok(applyTool);
    assert.equal(planTool.annotations?.readOnlyHint, true);
    assert.equal(planTool.annotations?.destructiveHint, false);
    assert.equal(applyTool.annotations?.readOnlyHint, false);
    assert.equal(applyTool.annotations?.destructiveHint, true);
    assert.equal(applyTool.annotations?.idempotentHint, false);

    const environment = await client.callTool({
      name: "tia_doctor",
      arguments: { portalVersion: "V20" }
    });
    assert.notEqual(environment.isError, true);
    if (environment.structuredContent?.environment?.checks?.importerExe === false) {
      const unavailablePlan = await client.callTool({
        name: "tia_create_import_plan",
        arguments: {
          projectPath: "D:/path-that-must-not-be-opened/test.ap20",
          blocks: [{ xmlPath: "D:/path-that-must-not-be-read/test.xml", targetName: "NeverRun", targetNumber: "9999" }]
        }
      });
      assert.notEqual(unavailablePlan.isError, true);
      assert.equal(unavailablePlan.structuredContent?.ok, false);
      assert.equal(unavailablePlan.structuredContent?.status, "capability_unavailable");
      assert.equal(unavailablePlan.structuredContent?.reason?.code, "ImporterUnavailable");
      assert.equal(unavailablePlan.structuredContent?.writeStatus?.enabled, false);
      assert.equal(unavailablePlan.structuredContent?.writeStatus?.confirmToken, "");
    }

    const blocked = await client.callTool({
      name: "tia_apply_import",
      arguments: {
        projectPath: "D:/path-that-must-not-be-opened/test.ap20",
        blocks: [{ xmlPath: "D:/path-that-must-not-be-read/test.xml", targetName: "NeverRun", targetNumber: "9999" }],
        confirmToken: "invalid-test-token"
      }
    });

    assert.notEqual(blocked.isError, true);
    assert.equal(blocked.structuredContent?.ok, false);
    assert.equal(blocked.structuredContent?.blocked, true);
    assert.equal(blocked.structuredContent?.status, "confirmation_invalid_or_expired");
    assert.equal(blocked.structuredContent?.downloadsToPlc, false);
  } finally {
    await client.close();
  }
});
