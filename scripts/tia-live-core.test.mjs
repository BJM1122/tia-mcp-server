import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(scriptDir, "..");
const distLiveCoreUrl = new URL("../dist/tia-live-core.js", import.meta.url);
const sourceLiveCoreUrl = new URL("../src/tia-live-core.ts", import.meta.url);
const liveCoreModuleUrl = existsSync(fileURLToPath(distLiveCoreUrl))
  ? distLiveCoreUrl
  : sourceLiveCoreUrl;
const {
  liveCorePipeName,
  liveCorePipePath,
  queryTiaLiveCore
} = await import(liveCoreModuleUrl.href);

const NO_RESPONSE = Symbol("NO_RESPONSE");
const FAKE_API_DLL = "C:\\test-only\\Siemens.Engineering.dll";

function uniqueFakeExe(label) {
  return path.join(
    scriptDir,
    "fixtures",
    `not-a-real-core-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.exe`
  );
}

async function startFakeCore(t, coreExe, handler, apiDll = FAKE_API_DLL) {
  const pipeName = liveCorePipeName(coreExe, apiDll);
  const pipePath = liveCorePipePath(pipeName);
  const requests = [];
  const sockets = new Set();
  const serverErrors = [];

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    let input = "";
    let handled = false;

    socket.on("data", async (chunk) => {
      if (handled) return;
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      try {
        const request = JSON.parse(input.slice(0, newline));
        requests.push(request);
        const response = await handler(request, requests.length, socket);
        if (response === NO_RESPONSE || socket.destroyed) return;
        if (typeof response === "string" || Buffer.isBuffer(response)) {
          socket.end(response);
        } else {
          socket.end(`${JSON.stringify({
            protocolVersion: request.protocolVersion,
            requestId: request.requestId,
            ...response
          })}\n`);
        }
      } catch (error) {
        serverErrors.push(error);
        socket.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, resolve);
  });

  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(() => resolve()));
    assert.deepEqual(serverErrors, []);
  });

  return { pipeName, pipePath, requests };
}

function clientOptions(coreExe, overrides = {}) {
  return {
    coreExe,
    apiDll: FAKE_API_DLL,
    timeoutMs: 1_000,
    startupTimeoutMs: 100,
    ...overrides
  };
}

test("workflow identity probe never launches a missing resident core", async () => {
  await assert.rejects(queryTiaLiveCore({ operation: "ping" },
    clientOptions(uniqueFakeExe("probe-only"), { existingOnly: true })), { code: "ENOENT" });
});

test("workflow PID shortcut uses the prepared identity; unmatched PID or unobservable window requires UI evidence", async t => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tia-workflow-session-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const core = path.join(tempDir, "core.exe"), dll = path.join(tempDir, "api.dll");
  await Promise.all([writeFile(core, ""), writeFile(dll, "")]);
  const session = { processId: 2147483646, processStartTimeUtc: "2026-11-01T12:00:00.0000000Z", canonicalProjectPath: "D:/test.ap20" };
  const fake = await startFakeCore(t, core, () => ({ ok: true, status: "ready", session }), dll);
  const script = [
    'import assert from "node:assert/strict";',
    'import { resolveWorkflowSession } from "./dist/live-session.js";',
    'const args = { processId: 2147483646, timeoutMs: 5000, maxNodes: 30, maxDepth: 2 };',
    'const hit = await resolveWorkflowSession(args);',
    'assert.equal(hit.identitySource, "resident_core_prepared_session");',
    'assert.equal(hit.projectPath, "D:/test.ap20");',
    'await assert.rejects(resolveWorkflowSession({ ...args, processId: 1 }), /UI context companion not found/);',
    'await assert.rejects(resolveWorkflowSession(args, true), /UI context companion not found/);'
  ].join("\n");
  await execFileAsync(process.execPath, ["--input-type=module", "-e", script], { cwd: serverRoot,
    env: { ...process.env, TIA_MCP_OPENNESS_API_DLL: dll, TIA_MCP_API_DLL_V20: dll, TIA_MCP_LIVE_CORE_EXE: core,
      TIA_MCP_UI_CONTEXT_SCRIPT: path.join(tempDir, "absent.ps1") } });
  assert.deepEqual(fake.requests.map(r => r.operation), ["verify_session", "verify_session", "verify_session"]);
});

test("named-pipe client sends a bounded v1 envelope without changing exact PID or project path", async (t) => {
  const coreExe = uniqueFakeExe("protocol");
  const exactProjectPath = "E:\\Projects\\Assembly\\通用装配线.ap20";
  const fake = await startFakeCore(t, coreExe, (request) => ({
    ok: true,
    status: "resolved",
    echo: request
  }));

  const sentAtMs = Date.now();
  const response = await queryTiaLiveCore({
    operation: "query_object",
    timeoutMs: 1_234,
    processId: 4_242,
    projectPath: exactProjectPath,
    identity: {
      resourceKind: "block",
      name: "ConveyorControl",
      blockKind: "FB",
      number: "42",
      namespace: "Plant.UnitA",
      softwarePath: "CPU_A\\PLC_1",
      officialIdentifier: "object-id:test:42"
    },
    includeCrossReferences: true,
    includeBlockXml: false,
    includeInterface: true,
    maxResults: 50,
    maxXmlBytes: 500_000
  }, clientOptions(coreExe, { timeoutMs: 2_000 }));

  assert.equal(response.ok, true);
  assert.equal(response.status, "resolved");
  assert.equal(fake.requests.length, 1);
  const { requestId, deadlineUnixMs, ...requestWithoutId } = fake.requests[0];
  assert.match(requestId, /^[0-9a-f-]{36}$/);
  // The absolute client deadline lets the core skip a request that expired while queued.
  assert.ok(Number.isInteger(deadlineUnixMs));
  assert.ok(deadlineUnixMs >= sentAtMs + 2_000 && deadlineUnixMs <= Date.now() + 2_000);
  assert.deepEqual(requestWithoutId, {
    protocolVersion: 1,
    operation: "query_object",
    timeoutMs: 1_234,
    processId: 4_242,
    projectPath: exactProjectPath,
    identity: {
      resourceKind: "block",
      name: "ConveyorControl",
      blockKind: "FB",
      number: "42",
      namespace: "Plant.UnitA",
      softwarePath: "CPU_A\\PLC_1",
      officialIdentifier: "object-id:test:42"
    },
    includeCrossReferences: true,
    includeBlockXml: false,
    includeInterface: true,
    maxResults: 50,
    maxXmlBytes: 500_000
  });
});

test("resident pipe is reused for consecutive hot requests", async (t) => {
  const coreExe = uniqueFakeExe("hot-reuse");
  const fake = await startFakeCore(t, coreExe, (_request, requestNumber) => ({
    ok: true,
    status: "ready",
    core: { processId: 9_001, resident: true },
    requestNumber
  }));

  const first = await queryTiaLiveCore(
    { operation: "ping" },
    clientOptions(coreExe)
  );
  const second = await queryTiaLiveCore(
    { operation: "ping" },
    clientOptions(coreExe)
  );

  assert.equal(first.core.processId, 9_001);
  assert.equal(second.core.processId, 9_001);
  assert.equal(first.requestNumber, 1);
  assert.equal(second.requestNumber, 2);
  assert.equal(fake.requests.length, 2);
  assert.equal(fake.requests[0].timeoutMs, 1_000);
  assert.equal(fake.requests[1].timeoutMs, 1_000);
});

test("resident pipe identity changes when the native core binary changes", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tia-live-core-fingerprint-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const coreExe = path.join(tempDir, "TiaLiveReadCore.exe");

  await writeFile(coreExe, "first-binary", "utf8");
  const first = liveCorePipeName(coreExe);
  assert.equal(liveCorePipeName(coreExe), first);

  await writeFile(coreExe, "second-binary-with-a-different-size", "utf8");
  const second = liveCorePipeName(coreExe);
  assert.notEqual(second, first);
});

test("resident pipe identity is isolated by the configured Openness API binary", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tia-live-core-api-fingerprint-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const coreExe = path.join(tempDir, "TiaLiveReadCore.exe");
  const apiV20A = path.join(tempDir, "api-a", "Siemens.Engineering.dll");
  const apiV20B = path.join(tempDir, "api-b", "Siemens.Engineering.dll");
  await Promise.all([
    mkdir(path.dirname(apiV20A), { recursive: true }),
    mkdir(path.dirname(apiV20B), { recursive: true })
  ]);
  await writeFile(coreExe, "same-core-binary", "utf8");
  await writeFile(apiV20A, "api-build-a", "utf8");
  await writeFile(apiV20B, "api-build-b", "utf8");

  const first = liveCorePipeName(coreExe, apiV20A);
  const second = liveCorePipeName(coreExe, apiV20B);
  assert.notEqual(first, second);
});

test("cold-start launch failures are classified immediately and shared across concurrent callers", async () => {
  const coreExe = uniqueFakeExe("launch-error");
  const started = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () => queryTiaLiveCore(
      { operation: "ping" },
      clientOptions(coreExe, { timeoutMs: 1_000, startupTimeoutMs: 500 })
    ))
  );

  assert.ok(results.every((result) => result.status === "rejected"));
  for (const result of results) {
    if (result.status === "rejected") {
      assert.match(String(result.reason), /live core launch failed/i);
    }
  }
  assert.ok(Date.now() - started < 1_000, "Launch errors should not be hidden behind the startup timeout.");
});

test("client rejects a pipe response that exceeds its configured byte cap", async (t) => {
  const coreExe = uniqueFakeExe("oversize");
  await startFakeCore(t, coreExe, () => "x".repeat(257));

  await assert.rejects(
    queryTiaLiveCore(
      { operation: "ping" },
      clientOptions(coreExe, { maxResponseBytes: 256 })
    ),
    /response exceeded 256 bytes/
  );
});

test("client rejects an invalid response envelope", async (t) => {
  const coreExe = uniqueFakeExe("invalid-envelope");
  await startFakeCore(t, coreExe, () => ({ ok: true }));

  await assert.rejects(
    queryTiaLiveCore(
      { operation: "ping" },
      clientOptions(coreExe)
    ),
    /invalid response envelope/
  );
});

test("client rejects protocol-version and request-id mismatches", async (t) => {
  const coreExe = uniqueFakeExe("response-correlation");
  await startFakeCore(t, coreExe, (_request, requestNumber) => requestNumber === 1
    ? { protocolVersion: 2, ok: true, status: "ready" }
    : { requestId: "not-the-request-id", ok: true, status: "ready" });

  await assert.rejects(
    queryTiaLiveCore(
      { operation: "ping" },
      clientOptions(coreExe)
    ),
    /protocol mismatch: expected 1, received 2/
  );
  await assert.rejects(
    queryTiaLiveCore(
      { operation: "ping" },
      clientOptions(coreExe)
    ),
    /requestId did not match/
  );
});

test("client enforces one total deadline when a connected pipe never returns a response", { timeout: 4_000 }, async (t) => {
  const coreExe = uniqueFakeExe("timeout");
  await startFakeCore(t, coreExe, () => NO_RESPONSE);

  const started = Date.now();
  await assert.rejects(
    queryTiaLiveCore(
      { operation: "ping" },
      clientOptions(coreExe)
    ),
    /request timed out after \d+ ms/
  );
  const elapsedMs = Date.now() - started;
  assert.ok(elapsedMs >= 800, `Expected the 1000 ms deadline, observed ${elapsedMs} ms.`);
  assert.ok(elapsedMs < 2_000, `The request exceeded one total deadline: ${elapsedMs} ms.`);
});

function uiContextFixture(overrides = {}) {
  return {
    schemaVersion: "1.0",
    observedAt: "2026-07-25T12:00:00.000Z",
    status: "selected",
    selectedProcessId: 4_242,
    foregroundProcessId: 4_242,
    foregroundWindowHandle: 1_001,
    processes: [{
      processId: 4_242,
      projectName: "通用装配线",
      projectPath: "E:\\Projects\\Assembly\\通用装配线.ap20",
      processStartTimeUtc: "2026-07-25T11:59:00.0000000Z",
      mainWindowHandle: 1_001,
      windowTitle: "Siemens - 通用装配线",
      isMinimized: false
    }],
    selectedObject: {
      status: "resolved",
      text: "ConveyorControl [FB42]",
      source: "project_navigator_msaa",
      candidates: []
    },
    activeEditor: {
      status: "resolved",
      breadcrumb: "Project\\CPU\\Program blocks\\ConveyorControl [FB42]",
      source: "editor_frame_msaa",
      candidates: []
    },
    networkOrSection: {
      status: "resolved",
      label: "Network 3",
      number: "3",
      source: "network_container_msaa",
      candidates: []
    },
    limitations: ["Synthetic test context; no TIA process was queried."],
    ...overrides
  };
}

test("accessibility fallback statically binds UI actions to the exact Portal session before and after interaction", async () => {
  const scriptPath = path.join(serverRoot, "tools", "Navigate-TiaPortalAccessibleNetwork.ps1");
  const source = await readFile(scriptPath, "utf8");

  for (const parameterName of [
    "ExpectedProcessStartTimeUtc",
    "ExpectedProjectPath",
    "ApiDll"
  ]) {
    assert.match(
      source,
      new RegExp(
        String.raw`\[Parameter\(\s*Mandatory\s*=\s*\$true\s*\)\][\s\S]{0,180}\$${parameterName}\b`,
        "i"
      ),
      `${parameterName} must remain a mandatory fallback parameter.`
    );
  }

  const verifierDefinition = source.search(/function\s+Test-ExactPortalSession\s*\{/i);
  assert.ok(verifierDefinition >= 0, "Expected Test-ExactPortalSession verifier.");
  const nextFunction = source.slice(verifierDefinition + 1).search(/\r?\nfunction\s+/i);
  const verifierEnd = nextFunction < 0
    ? source.length
    : verifierDefinition + 1 + nextFunction;
  const verifierBody = source.slice(verifierDefinition, verifierEnd);
  assert.match(
    verifierBody,
    /\[Siemens\.Engineering\.TiaPortal\]::GetProcesses\(\)/,
    "The exact-session verifier must use the official TiaPortal.GetProcesses surface."
  );
  for (const verifierEvidence of [
    "$ProcessId",
    "$script:expectedProcessStartUtcTicks",
    "$script:canonicalExpectedProjectPath",
    "Initialize-OfficialApi"
  ]) {
    assert.ok(
      verifierBody.includes(verifierEvidence),
      `Exact-session verification must retain ${verifierEvidence}.`
    );
  }
  assert.match(
    source,
    /AssemblyName\]::GetAssemblyName\(\$script:canonicalApiDll\)[\s\S]{0,250}\.Version\.Major\s+-ne\s+20/,
    "The mandatory ApiDll must be validated as the V20 official API before session verification."
  );

  function verifierCallIndex(phase) {
    const phasePattern = new RegExp(`['"]${phase}['"]`, "ig");
    for (const match of source.slice(verifierEnd).matchAll(phasePattern)) {
      const phaseIndex = verifierEnd + (match.index ?? 0);
      const callIndex = source.lastIndexOf("Test-ExactPortalSession", phaseIndex);
      if (callIndex >= verifierEnd && phaseIndex - callIndex <= 500) return callIndex;
    }
    return -1;
  }

  const beforeEnumeration = verifierCallIndex("before_enumeration");
  const beforeInteraction = verifierCallIndex("before_interaction");
  const afterInteraction = verifierCallIndex("after_interaction");
  assert.ok(beforeEnumeration >= 0, "Missing before_enumeration session verification.");
  assert.ok(beforeInteraction > beforeEnumeration, "Missing ordered before_interaction verification.");

  const actionIndexes = [
    source.indexOf("$selectionPattern.Select()"),
    source.indexOf("$target.SetFocus()")
  ].filter((index) => index >= 0);
  assert.ok(actionIndexes.length > 0, "Expected only the known bounded UIA action sites.");
  const firstAction = Math.min(...actionIndexes);
  const lastAction = Math.max(...actionIndexes);
  assert.ok(beforeInteraction < firstAction, "Session verification must precede every UIA action.");
  assert.ok(afterInteraction > lastAction, "Session verification must follow the final UIA action.");
});

test("native core offline self-test validates its read-only protocol without connecting to TIA", async (t) => {
  if (process.platform !== "win32") {
    t.skip("The V20 native core is Windows-only.");
    return;
  }
  const coreExe = path.join(serverRoot, "tools", "TiaLiveReadCore.exe");
  const apiDll = process.env.TIA_MCP_OPENNESS_API_DLL
    || "C:\\Program Files\\Siemens\\Automation\\Portal V20\\PublicAPI\\V20\\Siemens.Engineering.dll";
  if (!existsSync(coreExe) || !existsSync(apiDll)) {
    t.skip("The built native core or local V20 PublicAPI DLL is unavailable.");
    return;
  }

  const probeDirectory = await mkdtemp(path.join(os.tmpdir(), "tia-snapshot-contract-probe-"));
  try {
    const entriesBeforeProbe = await readdir(probeDirectory);
    const probe = await execFileAsync(coreExe, [
      "--snapshot-candidate-contract-v1"
    ], {
      cwd: probeDirectory,
      timeout: 15_000,
      windowsHide: true
    });
    assert.equal(probe.stderr.trim(), "");
    assert.deepEqual(JSON.parse(probe.stdout.trim()), {
      contractVersion: 1,
      candidateOnly: true,
      currentPointerWrittenByNative: false
    });
    assert.deepEqual(
      await readdir(probeDirectory),
      entriesBeforeProbe,
      "The native contract probe must not create files or directories."
    );
  } finally {
    await rm(probeDirectory, { recursive: true, force: true });
  }

  const { stdout, stderr } = await execFileAsync(coreExe, [
    "--api",
    apiDll,
    "--self-test"
  ], {
    timeout: 15_000,
    windowsHide: true
  });
  assert.equal(stderr.trim(), "");
  const result = JSON.parse(stdout.trim());
  assert.equal(result.protocolVersion, 1);
  assert.equal(result.requestId, "self-test");
  assert.equal(result.utf8Probe, "\u8def\u5f84\u5757\u540d");
  assert.equal(result.ok, true);
  assert.equal(result.status, "self_test_passed");
  assert.equal(result.tiaConnected, false);
  assert.equal(result.safety?.queryDefault, "read_only");
  assert.equal(result.safety?.engineeringWrites, false);
  assert.equal(result.safety?.portalProcessDispose, false);
  assert.ok(result.checks?.some((check) =>
    check.name === "navigation_confirmation_gate" && check.ok === true
  ));
  for (const requiredCheck of [
    "snapshot_cli_exact_identity",
    "snapshot_ascii_file_names",
    "snapshot_cli_rejects_ambiguous_process_start",
    "snapshot_candidate_contract_v1",
    "snapshot_pointer_atomic_replace",
    "snapshot_current_pointer_read_fails_closed",
    "snapshot_publish_requires_zero_export_errors",
    "snapshot_required_state_read_fails_closed",
    "snapshot_inventory_audit_fails_closed",
    "snapshot_output_layout_fails_closed",
    "snapshot_stale_staging_cleanup_is_bounded",
    "snapshot_manifest_contract",
    "snapshot_incremental_reuse_rules",
    "dependency_v3_semantic_content",
    "dependency_v3_legacy_sha_guard",
    "signature_targets_exact_unique",
    "signature_invalidated_object_retry",
    "verify_session_cached_identity_guards"
  ]) {
    assert.ok(result.checks?.some((check) =>
      check.name === requiredCheck && check.ok === true
    ), `Missing successful native self-test check: ${requiredCheck}`);
  }

  let invalidSnapshotResult;
  try {
    await execFileAsync(coreExe, [
      "--api",
      apiDll,
      "--export-snapshot-candidate-v1"
    ], {
      timeout: 15_000,
      windowsHide: true
    });
    assert.fail("Incomplete snapshot arguments must fail before any TIA attach.");
  } catch (error) {
    invalidSnapshotResult = JSON.parse(String(error.stdout).trim());
  }
  assert.equal(invalidSnapshotResult.requestId, "snapshot-export");
  assert.equal(invalidSnapshotResult.ok, false);
  assert.equal(invalidSnapshotResult.status, "invalid_argument");
  assert.equal(invalidSnapshotResult.mode, "one_shot_export_snapshot");
  assert.equal(invalidSnapshotResult.safety?.projectMutation, false);
  assert.equal(invalidSnapshotResult.safety?.plcAccessed, false);

  let legacyFlagError;
  try {
    await execFileAsync(coreExe, [
      "--api",
      apiDll,
      "--export-snapshot"
    ], {
      timeout: 15_000,
      windowsHide: true
    });
    assert.fail("The legacy snapshot flag must be rejected before any TIA attach.");
  } catch (error) {
    legacyFlagError = error;
  }
  assert.equal(legacyFlagError.code, 2);
  assert.equal(String(legacyFlagError.stdout).trim(), "");
  assert.match(
    String(legacyFlagError.stderr),
    /Unknown or incomplete argument: --export-snapshot/
  );
});

test("real native core starts detached (no console) and serves queued pipe clients", { timeout: 60_000 }, async (t) => {
  if (process.platform !== "win32") {
    t.skip("The V20 native core is Windows-only.");
    return;
  }
  const builtCoreExe = process.env.TIA_MCP_LIVE_CORE_EXE?.trim()
    || path.join(serverRoot, "tools", "TiaLiveReadCore.exe");
  const apiDll = process.env.TIA_MCP_OPENNESS_API_DLL
    || "C:\\Program Files\\Siemens\\Automation\\Portal V20\\PublicAPI\\V20\\Siemens.Engineering.dll";
  if (!existsSync(builtCoreExe) || !existsSync(apiDll)) {
    t.skip("The built native core or local V20 PublicAPI DLL is unavailable.");
    return;
  }

  // A private copy gets its own pipe name, so a resident production core is
  // neither reused nor disturbed. Only ping/shutdown are sent: no TIA attach.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tia-real-core-"));
  const coreExe = path.join(tempDir, "TiaLiveReadCore.exe");
  await writeFile(coreExe, await readFile(builtCoreExe));
  const options = { coreExe, apiDll, timeoutMs: 15_000, idleTimeoutMs: 30_000 };
  const pipePath = liveCorePipePath(liveCorePipeName(coreExe, apiDll));
  let corePid = 0;
  t.after(async () => {
    try {
      await queryTiaLiveCore({ operation: "shutdown" }, { ...options, timeoutMs: 3_000 });
    } catch {
      // Already gone.
    }
    for (let i = 0; i < 50 && corePid; i++) {
      try { process.kill(corePid, 0); } catch { break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  // Regression: Console.OutputEncoding threw IOException without a console, so
  // the detached core exited immediately and every live tool timed out.
  const cold = await queryTiaLiveCore({ operation: "ping" }, options);
  assert.equal(cold.ok, true);
  assert.equal(cold.status, "ready");
  corePid = cold.core?.processId;
  assert.ok(Number.isInteger(corePid) && corePid > 0);

  const concurrent = await Promise.all(
    Array.from({ length: 6 }, () => queryTiaLiveCore({ operation: "ping" }, options))
  );
  for (const response of concurrent) {
    assert.equal(response.ok, true);
    assert.equal(response.core?.processId, corePid, "Concurrent clients must queue on the one resident core.");
  }

  const rawRequest = (extra = "") =>
    `{"protocolVersion":1,"requestId":"raw-${Math.random().toString(16).slice(2)}","operation":"ping","timeoutMs":5000${extra}}\n`;
  const connect = () => new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
  const readLine = (socket) => new Promise((resolve, reject) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) resolve(JSON.parse(buffer.slice(0, newline)));
    });
    socket.once("error", reject);
  });

  // Hold the serving instance with a partial line, queue one client that
  // abandons its request and one whose deadline already passed.
  const holder = await connect();
  const holderReply = readLine(holder);
  holder.write(`{"protocolVersion":1,"requestId":"holder","operation":"ping",`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const abandoned = await connect();
  abandoned.write(rawRequest());
  await new Promise((resolve) => setTimeout(resolve, 100));
  abandoned.destroy();
  holder.write(`"timeoutMs":5000}\n`);
  assert.equal((await holderReply).ok, true);
  holder.destroy();

  const expired = await connect();
  const expiredReply = readLine(expired);
  expired.write(rawRequest(`,"deadlineUnixMs":${Date.now() - 1_000}`));
  const expiredResponse = await expiredReply;
  expired.destroy();
  assert.equal(expiredResponse.ok, false);
  assert.equal(expiredResponse.status, "deadline_expired");

  const after = await queryTiaLiveCore({ operation: "ping" }, options);
  assert.equal(after.ok, true);
  assert.equal(after.core?.processId, corePid, "An abandoned queued client must not terminate the core.");
});

test("native snapshot mode is a single-attach official Openness export with a stable manifest contract", async () => {
  const source = await readFile(
    path.join(serverRoot, "live-core", "TiaLiveReadCore.cs"),
    "utf8"
  );

  for (const argument of [
    "--export-snapshot-candidate-v1",
    "--snapshot-candidate-contract-v1",
    "--process-id",
    "--project-path",
    "--process-start-time-utc",
    "--process-start-utc-ticks",
    "--output-root"
  ]) {
    assert.ok(source.includes(`"${argument}"`), `Missing snapshot CLI argument ${argument}.`);
  }
  assert.doesNotMatch(
    source,
    /"--export-snapshot"/,
    "The legacy snapshot flag must not be accepted by the native parser."
  );
  const contractBranch = source.indexOf("if (snapshotCandidateContractV1)");
  const configureAssembly = source.indexOf("ConfigureAssemblyResolution(_apiPath)");
  const contractBranchEnd = source.indexOf(
    "if (!exportSnapshotCandidateV1)",
    contractBranch
  );
  assert.ok(
    contractBranch >= 0 &&
      contractBranchEnd > contractBranch &&
      configureAssembly > contractBranchEnd,
    "The contract probe must return before API loading and export/session work."
  );
  const contractBranchSource = source.slice(contractBranch, contractBranchEnd);
  assert.doesNotMatch(
    contractBranchSource,
    /EnsureAttachedSession|Directory\.CreateDirectory/,
    "The contract probe must not attach to TIA or create directories."
  );
  assert.match(
    source,
    /SnapshotCandidateContractMap\(\)[\s\S]*?"contractVersion",\s*1,[\s\S]*?"candidateOnly",\s*true,[\s\S]*?"currentPointerWrittenByNative",\s*false/
  );
  assert.match(
    source,
    /EnsureAttachedSession\(\s*options\.Session,\s*true,\s*null,\s*false,\s*true\)/
  );
  assert.match(source, /BuildSnapshotExportInventory\(session\)/);
  // One device-tree walk for blocks, PLC types and whole tag tables; never individual tags.
  const snapshotInventoryCall = source.match(/BuildInventory\(session,\s*new ObjectKind\[\]\s*\{([^}]*)\}\)/);
  assert.ok(snapshotInventoryCall, "snapshot inventory call");
  assert.match(snapshotInventoryCall[1], /ObjectKind\.Block/);
  assert.match(snapshotInventoryCall[1], /ObjectKind\.PlcType/);
  assert.match(snapshotInventoryCall[1], /ObjectKind\.TagTable/);
  assert.doesNotMatch(snapshotInventoryCall[1], /ObjectKind\.PlcTag/);
  assert.match(source, /\(\(PlcBlock\)record\.Value\)\.Export\(destination,\s*ExportOptions\.WithDefaults\)/);
  assert.match(source, /\(\(PlcType\)record\.Value\)\.Export\(destination,\s*ExportOptions\.WithDefaults\)/);
  assert.match(source, /\(\(PlcTagTable\)record\.Value\)\.Export\(destination,\s*ExportOptions\.WithDefaults\)/);
  assert.doesNotMatch(source, /PlcTag\)record\.Value\)\.Export/);
  assert.match(source, /VerifyExactSnapshotSession\(session,\s*options\.Session,\s*"before_enumeration"\)/);
  assert.match(source, /VerifyExactSnapshotSession\(session,\s*options\.Session,\s*"after_inventory"\)/);
  assert.match(source, /Directory\.Move\(stagingDirectory,\s*publishedDirectory\)/);
  assert.match(source, /File\.Replace\(tempPath,\s*targetPath,\s*backupPath,\s*true\)/);
  assert.match(
    source,
    /return consistent && exportErrorCount == 0;/
  );
  assert.match(source, /"snapshot_export_incomplete"/);
  assert.match(
    source,
    /CleanupStaleSnapshotStaging\(options\.OutputRoot\)/
  );
  assert.match(
    source,
    /Directory\.GetDirectories\(\s*root,\s*SnapshotStagingPrefix \+ "\*",\s*SearchOption\.TopDirectoryOnly\)/
  );
  assert.match(source, /FileAttributes\.ReparsePoint/);
  assert.match(source, /Guid\.TryParseExact\(suffix,\s*"N",\s*out parsed\)/);
  assert.match(source, /DeleteSnapshotTreeWithoutFollowingReparsePoints/);
  assert.match(source, /EnsureSnapshotDirectChildDirectory\(\s*options\.OutputRoot,\s*"snapshots"\s*\)/);
  assert.match(source, /EnsureSnapshotTreeHasNoReparsePoints\(stagingDirectory\)/);
  assert.match(source, /SnapshotInventoryTraversalErrors/);
  assert.match(source, /"snapshot_inventory_incomplete"/);
  assert.match(source, /"snapshot_plc_software_not_found"/);
  assert.match(source, /"snapshot_consistency_unavailable"/);

  const oneShotStart = source.indexOf("private static int RunSnapshotExport");
  const oneShotEnd = source.indexOf("private static void VerifyExactSnapshotSession", oneShotStart);
  const oneShot = source.slice(oneShotStart, oneShotEnd);
  const rejectIncomplete = oneShot.indexOf("if (!publishAllowed)");
  const publishDirectory = oneShot.indexOf("Directory.Move(stagingDirectory, publishedDirectory)");
  const updatePointer = oneShot.indexOf("AtomicWriteJson(");
  const readPreviousCurrent = oneShot.indexOf("ReadPreviousSnapshotPointerStrict(");
  const cleanStaging = oneShot.indexOf("CleanupStaleSnapshotStaging(");
  const attachSession = oneShot.indexOf("EnsureAttachedSession(");
  assert.ok(rejectIncomplete >= 0);
  assert.ok(publishDirectory > rejectIncomplete);
  assert.ok(
    readPreviousCurrent >= 0 &&
      cleanStaging > readPreviousCurrent &&
      attachSession > readPreviousCurrent,
    "Native export must strictly read current.json before cleanup or TIA attach."
  );
  assert.equal(updatePointer, -1, "Native snapshot export must not advance current.json before offline analysis succeeds.");
  assert.doesNotMatch(source, /ReadPreviousPublishedPath/);
  assert.match(oneShot, /"publicationState",\s*"candidate_not_current"/);
  assert.match(oneShot, /"currentPointerUpdated",\s*false/);
  assert.match(
    oneShot.slice(rejectIncomplete, publishDirectory),
    /return incompleteExport \? 21 : 20;/
  );

  for (const field of [
    "canonicalProjectPath",
    "processStartUtcTicks",
    "identityFingerprint",
    "modifiedStateFingerprint",
    "plcSoftwareCount",
    "plcSoftwareIdentityFingerprint",
    "traversalErrorCount",
    "plcSoftwareIdentityMatches",
    "inventoryTraversalComplete",
    "publicationState",
    "previousPublishedPath",
    "previousCurrentExists",
    "previousCurrentSnapshotId",
    "previousCurrentManifestSha256",
    "resourceKind",
    "blockKind",
    "programmingLanguage",
    "relativePath",
    "sha256",
    "bytes",
    "status",
    "error"
  ]) {
    assert.ok(source.includes(`"${field}"`), `Missing stable snapshot manifest field ${field}.`);
  }
});

test("resident query/navigation operations permit cold Attach only through explicit attach_session", async () => {
  const source = await readFile(
    path.join(serverRoot, "live-core", "TiaLiveReadCore.cs"),
    "utf8"
  );
  assert.match(
    source,
    /HandleAttachSession[\s\S]*?EnsureAttachedSession\(sessionRequest,\s*false,\s*null,\s*false,\s*true\)/
  );
  assert.match(
    source,
    /HandleQueryObject[\s\S]*?EnsureAttachedSession\(sessionRequest,\s*options\.RefreshInventory,\s*selector\.Kind,\s*true,\s*false\)/
  );
  assert.match(
    source,
    /HandleNavigateObject[\s\S]*?EnsureAttachedSession\(sessionRequest,\s*true,\s*selector\.Kind,\s*true,\s*false\)/
  );
  const failClosedGuard = source.indexOf("if (!allowAttach)");
  const nativeAttach = source.indexOf("TiaPortal portal = descriptor.Attach();");
  assert.ok(failClosedGuard >= 0 && nativeAttach > failClosedGuard);
  assert.match(source, /"session_not_prepared"/);
});

test("MCP live tools preserve exact session identity and expose success, ambiguity, mismatch, and UI refusal as structured results", {
  timeout: 30_000
}, async (t) => {
  if (process.platform !== "win32") {
    t.skip("The UI-context companion is Windows-only.");
    return;
  }

  const serverPath = path.join(serverRoot, "dist", "index.js");
  if (!existsSync(serverPath)) {
    t.skip("Run the TypeScript production build first so dist/index.js exists.");
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tia-mcp-live-test-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const uiContextFile = path.join(tempDir, "ui-context.json");
  const fakeApiDll = path.join(tempDir, "Siemens.Engineering.dll");
  const fakeCoreExe = path.join(tempDir, "TiaLiveReadCore-test-double.exe");
  const fakeUiContextScript = path.join(scriptDir, "fixtures", "Get-FakeTiaPortalUiContext.ps1");
  await writeFile(uiContextFile, JSON.stringify(uiContextFixture()), "utf8");
  await writeFile(fakeApiDll, "", "utf8");
  await writeFile(fakeCoreExe, "", "utf8");

  const exactProjectPath = "E:\\Projects\\Assembly\\通用装配线.ap20";
  const currentBlockXml = [
    "<?xml version=\"1.0\" encoding=\"utf-8\"?>",
    "<Document>",
    "  <SW.Blocks.FB ID=\"0\">",
    "    <AttributeList>",
    "      <Name>ConveyorControl</Name>",
    "      <Number>42</Number>",
    "      <ProgrammingLanguage>SCL</ProgrammingLanguage>",
    "    </AttributeList>",
    "  </SW.Blocks.FB>",
    "</Document>"
  ].join("\n");
  const currentBlockXmlBytes = Buffer.from(currentBlockXml, "utf8");
  const currentBlockXmlSha256 = createHash("sha256").update(currentBlockXmlBytes).digest("hex");
  const malformedBlockXmlBytes = Buffer.from(
    "<MalformedXmlBlock />",
    "utf8"
  );
  const malformedBlockXmlSha256 = createHash("sha256").update(malformedBlockXmlBytes).digest("hex");
  const boundedEvidenceXml = [
    "<?xml version=\"1.0\" encoding=\"utf-8\"?>",
    "<Document>",
    "  <SW.Blocks.FB ID=\"0\">",
    "    <AttributeList>",
    "      <Name>BoundedEvidenceBlock</Name>",
    "      <Number>100</Number>",
    "      <ProgrammingLanguage>SCL</ProgrammingLanguage>",
    "      <Interface>",
    "        <Sections>",
    "          <Section Name=\"Input\">",
    "            <Member Name=\"InputA\" Datatype=\"Bool\" />",
    "            <Member Name=\"InputB\" Datatype=\"Bool\" />",
    "            <Member Name=\"InputC\" Datatype=\"Bool\" />",
    "          </Section>",
    "        </Sections>",
    "      </Interface>",
    "    </AttributeList>",
    "    <ObjectList>",
    "      <StructuredText>",
    "        <Access Scope=\"GlobalVariable\"><Symbol><Component Name=\"TargetA\" /></Symbol></Access>",
    "        <Token Text=\":=\" />",
    "        <Access Scope=\"GlobalVariable\"><Symbol><Component Name=\"SourceA\" /></Symbol></Access>",
    "        <Token Text=\";\" />",
    "        <NewLine />",
    "        <Access Scope=\"GlobalVariable\"><Symbol><Component Name=\"TargetB\" /></Symbol></Access>",
    "        <Token Text=\":=\" />",
    "        <Access Scope=\"GlobalVariable\"><Symbol><Component Name=\"SourceB\" /></Symbol></Access>",
    "        <Token Text=\";\" />",
    "      </StructuredText>",
    "    </ObjectList>",
    "  </SW.Blocks.FB>",
    "</Document>"
  ].join("\n");
  const boundedEvidenceXmlBytes = Buffer.from(boundedEvidenceXml, "utf8");
  const boundedEvidenceXmlSha256 = createHash("sha256").update(boundedEvidenceXmlBytes).digest("hex");
  let attachedSession = null;
  const fake = await startFakeCore(t, fakeCoreExe, (request) => {
    if (request.operation === "ping") {
      return {
        ok: true,
        status: "ready",
        session: attachedSession
      };
    }
    if (request.operation === "attach_session") {
      attachedSession = {
        processId: request.processId,
        canonicalProjectPath: request.projectPath,
        processStartTimeUtc: request.processStartTimeUtc,
        sessionReused: true
      };
      return {
        ok: true,
        status: "attached",
        session: {
          processId: request.processId,
          canonicalProjectPath: request.projectPath,
          processStartTimeUtc: request.processStartTimeUtc,
          sessionReused: false,
          inventoryCount: 0,
          inventoryByKind: {
            block: { loaded: false, count: 0, builtAtUtc: null },
            plc_type: { loaded: false, count: 0, builtAtUtc: null },
            tag_table: { loaded: false, count: 0, builtAtUtc: null },
            plc_tag: { loaded: false, count: 0, builtAtUtc: null }
          }
        },
        timings: { attach: 25, inventory: 0, total: 30 },
        provenance: { inventoryBuilt: false, projectMutation: false }
      };
    }
    if (request.operation === "read_engineering") {
      return {
        ok: true, status: "partial",
        session: { ...attachedSession, processId: request.maxObjects === 2 ? 9999 : attachedSession.processId },
        engineering: { records: [], issues: [{ status: "classic_hmi_alarms_unsupported" }], truncated: false }
      };
    }
    if (request.operation === "search_objects") {
      return { ok: true, status: "searched", session: attachedSession,
        matches: [{ resourceKind: "block", name: "ConveyorControl", number: "87", softwarePath: "CPU_A\\PLC_1" }],
        totalMatches: 1, nextOffset: null };
    }
    const name = request.identity?.name;
    if (name === "Duplicate") {
      return {
        ok: false,
        status: "ambiguous",
        error: "The selector matched more than one object.",
        matches: [{ name: "Duplicate" }, { name: "Duplicate" }]
      };
    }
    if (name === "WrongProject") {
      return {
        ok: false,
        status: "project_mismatch",
        error: "The exact TIA process does not report the requested canonical .ap20 path.",
        diagnostics: { phase: "after_attach", reason: "empty_project_collection",
          processId: 4242, expectedProjectPath: "C:\\projects\\line.ap20",
          descriptorProjectPath: "C:\\projects\\line.ap20", projectsEnumerated: true,
          projectCount: 0, exactMatchCount: 0, observedProjectPaths: [], pathsTruncated: false }
      };
    }
    if (name === "MissingBlockFirst" || name === "MissingBlockSecond") {
      return {
        ok: false,
        status: "not_found",
        error: "No exact object matched in the verified project inventory.",
        inventoryRefreshForced: request.refreshInventory === true,
        inventoryRefreshedAfterMiss: name === "MissingBlockFirst",
        session: {
          processId: request.processId,
          canonicalProjectPath: request.projectPath,
          processStartTimeUtc: request.processStartTimeUtc,
          sessionReused: true
        }
      };
    }
    const response = {
      ok: true,
      status: "resolved",
      inventoryRefreshForced: request.refreshInventory === true,
      requestedActionCompleted: true,
      completeness: {
        requestedActionCompleted: true,
        directObject: "complete",
        localTemporaryXmlParse: "not_requested",
        incompleteComponents: []
      },
      session: {
        processId: request.processId,
        canonicalProjectPath: request.projectPath,
        processStartTimeUtc: request.processStartTimeUtc,
        sessionReused: true
      },
      object: {
        resourceKind: request.identity?.resourceKind,
        name
      },
      blockXml: { included: false, status: "not_requested" }
    };
    if (name === "ConveyorControl" && request.includeBlockXml) {
      response.blockXml = {
        included: true,
        status: "exported",
        encoding: "base64",
        bytes: currentBlockXmlBytes.length,
        sha256: currentBlockXmlSha256,
        base64: currentBlockXmlBytes.toString("base64"),
        tempCleanup: {
          attempted: true,
          deleted: true
        }
      };
    }
    if (name === "MalformedXmlBlock" && request.includeBlockXml) {
      response.blockXml = {
        included: true,
        status: "exported",
        encoding: "base64",
        bytes: malformedBlockXmlBytes.length,
        sha256: malformedBlockXmlSha256,
        base64: malformedBlockXmlBytes.toString("base64"),
        tempCleanup: {
          attempted: true,
          deleted: true
        }
      };
    }
    if (name === "BoundedEvidenceBlock" && request.includeBlockXml) {
      response.blockXml = {
        included: true,
        status: "exported",
        encoding: "base64",
        bytes: boundedEvidenceXmlBytes.length,
        sha256: boundedEvidenceXmlSha256,
        base64: boundedEvidenceXmlBytes.toString("base64"),
        tempCleanup: {
          attempted: true,
          deleted: true
        }
      };
    }
    return response;
  }, fakeApiDll);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: tempDir,
    env: {
      TIA_MCP_OPENNESS_API_DLL: fakeApiDll,
      TIA_MCP_UI_CONTEXT_SCRIPT: fakeUiContextScript,
      TIA_MCP_LIVE_CORE_EXE: fakeCoreExe,
      TIA_MCP_TEST_UI_CONTEXT_FILE: uiContextFile
    },
    stderr: "pipe"
  });
  const client = new Client({ name: "tia-live-core-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const authorizationPreflight = await client.callTool({
      name: "tia_prepare_live_session",
      arguments: {
        processId: 4_242,
        timeoutMs: 3_000
      }
    });
    assert.equal(authorizationPreflight.structuredContent?.ok, false);
    assert.equal(authorizationPreflight.structuredContent?.status, "portal_authorization_check_required");
    assert.equal(authorizationPreflight.structuredContent?.attachAttempted, false);
    assert.equal(fake.requests.some((request) => request.operation === "attach_session"), false);

    // A query against a cold core attaches by itself; no separate prepare call is needed.
    const coldQuery = await client.callTool({
      name: "tia_query_live_project",
      arguments: {
        processId: 4_242,
        resourceKind: "block",
        name: "DB_Main",
        includeCrossReferences: false,
        includeInterface: false,
        timeoutMs: 3_000
      }
    });
    assert.notEqual(coldQuery.structuredContent?.status, "portal_authorization_check_required", JSON.stringify(coldQuery.structuredContent));
    assert.equal(fake.requests.filter((request) => request.operation === "attach_session").length, 1);
    assert.equal(fake.requests.some((request) => request.operation === "query_object"), true);

    const prepared = await client.callTool({
      name: "tia_prepare_live_session",
      arguments: {
        processId: 4_242,
        confirmPortalAuthorizationReady: true,
        timeoutMs: 3_000
      }
    });
    assert.notEqual(prepared.isError, true, JSON.stringify(prepared));
    assert.equal(prepared.structuredContent?.ok, true);
    assert.equal(prepared.structuredContent?.status, "attached");
    assert.equal(prepared.structuredContent?.inventoryEnumerated, false);
    assert.equal(prepared.structuredContent?.exactLiveIdentity?.processId, 4_242);

    const search = await client.callTool({ name: "tia_search_live_objects", arguments: { processId: 4242, query: "Conveyor", maxResults: 5, timeoutMs: 3000 } });
    assert.equal(search.structuredContent?.matches?.[0]?.name, "ConveyorControl");
    const searchRequest = fake.requests.find(r => r.operation === "search_objects");
    assert.equal(searchRequest.projectPath, exactProjectPath);
    assert.equal(searchRequest.processStartTimeUtc, attachedSession.processStartTimeUtc);
    assert.equal(searchRequest.query, "Conveyor");
    assert.equal(searchRequest.maxResults, 5);

    const bodyBatch = await client.callTool({ name: "tia_query_live_project", arguments: {
      processId: 4242, includeProgramBody: true, timeoutMs: 5000,
      queries: [
        { operationId: "good", resourceKind: "block", name: "ConveyorControl" },
        { operationId: "bad", resourceKind: "block", name: "MalformedXmlBlock" },
        { operationId: "after-bad", resourceKind: "block", name: "BoundedEvidenceBlock" }
      ]
    } });
    assert.equal(bodyBatch.structuredContent?.completedCount, 2);
    assert.equal(bodyBatch.structuredContent?.failedCount, 1);
    assert.ok(bodyBatch.structuredContent?.results[0].temporaryBlockEvidence.execution);
    assert.ok(bodyBatch.structuredContent?.results[2].temporaryBlockEvidence.execution);
    assert.equal(bodyBatch.structuredContent?.results[0].temporaryBlockEvidence.rawXml, null);

    const engineering = await client.callTool({ name: "tia_inspect_engineering", arguments: { processId: 4242, includeScreens: true, maxObjects: 1, timeoutMs: 3000 } });
    assert.equal(engineering.structuredContent?.ok, true);
    assert.equal(engineering.structuredContent?.diagnostics?.status, "partial");
    const engineeringRequest = fake.requests.find(r => r.operation === "read_engineering");
    assert.equal(engineeringRequest.projectPath, exactProjectPath);
    assert.equal(engineeringRequest.processStartTimeUtc, attachedSession.processStartTimeUtc);
    assert.equal(engineeringRequest.maxObjects, 1);
    assert.equal(engineeringRequest.includeScreens, true);
    const wrongEngineering = await client.callTool({ name: "tia_inspect_engineering", arguments: { processId: 4242, maxObjects: 2, timeoutMs: 3000 } });
    assert.equal(wrongEngineering.structuredContent?.ok, false);
    assert.match(wrongEngineering.structuredContent?.error, /identity mismatch/);

    const success = await client.callTool({
    name: "tia_query_live_project",
    arguments: {
      processId: 4_242,
      resourceKind: "block",
      name: "DB_Main",
      blockKind: "DB",
      number: "100",
      namespace: "Plant.UnitA",
      softwarePath: "CPU_A\\PLC_1",
      officialIdentifier: "object-id:test:db100",
      includeCrossReferences: false,
      includeInterface: false,
      includeProgramBody: false,
      refreshInventory: true,
      timeoutMs: 3_000
    }
  });
  assert.notEqual(success.isError, true, JSON.stringify(success));
  assert.equal(success.structuredContent?.ok, true);
  assert.equal(success.structuredContent?.status, "resolved");
  assert.equal(success.structuredContent?.exactLiveIdentity?.processId, 4_242);
  assert.equal(success.structuredContent?.exactLiveIdentity?.projectPath, exactProjectPath);
  assert.deepEqual(success.structuredContent?.exactLiveIdentity?.object, {
    resourceKind: "block",
    name: "DB_Main",
    blockKind: "DB",
    number: "100",
    namespace: "Plant.UnitA",
    softwarePath: "CPU_A\\PLC_1",
    officialIdentifier: "object-id:test:db100"
  });
  const successWorkerRequest = fake.requests
    .filter((request) => request.operation === "query_object")
    .at(-1);
  assert.equal(successWorkerRequest?.refreshInventory, true);
  assert.equal(successWorkerRequest?.retryNotFoundWithRefresh, true);

  const ambiguous = await client.callTool({
    name: "tia_query_live_project",
    arguments: {
      processId: 4_242,
      resourceKind: "block",
      name: "Duplicate",
      includeCrossReferences: false,
      includeInterface: false,
      timeoutMs: 3_000
    }
  });
  assert.equal(ambiguous.structuredContent?.ok, false);
  assert.equal(ambiguous.structuredContent?.status, "ambiguous");
  assert.equal(ambiguous.structuredContent?.directLive?.matches?.length, 2);

  const mismatch = await client.callTool({
    name: "tia_query_live_project",
    arguments: {
      processId: 4_242,
      resourceKind: "block",
      name: "WrongProject",
      includeCrossReferences: false,
      includeInterface: false,
      timeoutMs: 3_000
    }
  });
  assert.equal(mismatch.structuredContent?.ok, false);
  assert.equal(mismatch.structuredContent?.status, "project_mismatch");
  assert.equal(mismatch.structuredContent?.directLive?.diagnostics?.reason, "empty_project_collection");
  assert.equal(mismatch.structuredContent?.directLive?.diagnostics?.projectCount, 0);
  assert.deepEqual(mismatch.structuredContent?.directLive?.diagnostics?.observedProjectPaths, []);
  assert.match(
    mismatch.structuredContent?.directLive?.error ?? "",
    /exact TIA process/
  );

  const currentBlock = await client.callTool({
    name: "tia_get_current_block",
    arguments: {
      processId: 4_242,
      includeCrossReferences: false,
      includeInterface: true,
      includeProgramBody: true,
      timeoutMs: 3_000
    }
  });
  assert.equal(currentBlock.structuredContent?.ok, true);
  assert.equal(currentBlock.structuredContent?.currentBlock?.block?.name, "ConveyorControl");
  assert.equal(currentBlock.structuredContent?.exactLiveIdentity?.processId, 4_242);
  assert.equal(currentBlock.structuredContent?.exactLiveIdentity?.projectPath, exactProjectPath);
  assert.equal(currentBlock.structuredContent?.directLive?.blockXml?.base64, undefined);
  assert.equal(currentBlock.structuredContent?.directLive?.blockXml?.bytes, currentBlockXmlBytes.length);
  assert.equal(currentBlock.structuredContent?.directLive?.blockXml?.sha256, currentBlockXmlSha256);
  assert.equal(currentBlock.structuredContent?.temporaryBlockEvidence?.identity?.name, "ConveyorControl");
  assert.equal(currentBlock.structuredContent?.temporaryBlockEvidence?.rawXml, null);

  const malformedXml = await client.callTool({
    name: "tia_query_live_project",
    arguments: {
      processId: 4_242,
      resourceKind: "block",
      name: "MalformedXmlBlock",
      blockKind: "FB",
      number: "99",
      includeCrossReferences: false,
      includeInterface: false,
      includeProgramBody: true,
      timeoutMs: 3_000
    }
  });
  assert.equal(malformedXml.structuredContent?.ok, true);
  assert.equal(malformedXml.structuredContent?.status, "partial");
  assert.equal(malformedXml.structuredContent?.requestedActionCompleted, false);
  assert.equal(malformedXml.structuredContent?.completeness?.requestedActionCompleted, false);
  assert.equal(malformedXml.structuredContent?.completeness?.localTemporaryXmlParse, "incomplete");
  const localParseComponent = malformedXml.structuredContent?.completeness?.incompleteComponents?.find(
    (component) => component.component === "localTemporaryXmlParse"
  );
  assert.equal(localParseComponent?.status, "failed");
  assert.equal(
    malformedXml.structuredContent?.temporaryBlockEvidence?.status,
    "temporary_block_xml_parse_error"
  );
  assert.equal(malformedXml.structuredContent?.directLive?.blockXml?.base64, undefined);
  assert.equal(malformedXml.structuredContent?.directLive?.blockXml?.sha256, malformedBlockXmlSha256);

  const truncatedLocalEvidence = await client.callTool({
    name: "tia_query_live_project",
    arguments: {
      processId: 4_242,
      resourceKind: "block",
      name: "BoundedEvidenceBlock",
      blockKind: "FB",
      number: "100",
      includeCrossReferences: false,
      includeInterface: true,
      includeProgramBody: true,
      interfaceLimit: 1,
      bodyEvidenceLimit: 1,
      timeoutMs: 3_000
    }
  });
  assert.equal(truncatedLocalEvidence.structuredContent?.ok, true);
  assert.equal(truncatedLocalEvidence.structuredContent?.status, "partial");
  assert.equal(truncatedLocalEvidence.structuredContent?.requestedActionCompleted, false);
  assert.equal(
    truncatedLocalEvidence.structuredContent?.completeness?.requestedActionCompleted,
    false
  );
  assert.equal(
    truncatedLocalEvidence.structuredContent?.completeness?.localInterfaceParse,
    "truncated"
  );
  assert.equal(
    truncatedLocalEvidence.structuredContent?.completeness?.localProgramBodyAnalysis,
    "truncated"
  );
  const interfaceComponent = truncatedLocalEvidence.structuredContent
    ?.completeness?.incompleteComponents?.find(
      (component) => component.component === "localInterfaceParse"
    );
  const bodyComponent = truncatedLocalEvidence.structuredContent
    ?.completeness?.incompleteComponents?.find(
      (component) => component.component === "localProgramBodyAnalysis"
    );
  assert.equal(interfaceComponent?.status, "truncated");
  assert.equal(bodyComponent?.status, "truncated");
  assert.equal(truncatedLocalEvidence.structuredContent?.temporaryBlockEvidence?.interface?.truncated, true);
  assert.equal(
    truncatedLocalEvidence.structuredContent?.temporaryBlockEvidence?.interface?.members?.length,
    1
  );
  assert.equal(
    truncatedLocalEvidence.structuredContent?.temporaryBlockEvidence?.bodyAnalysis?.truncated,
    true
  );
  assert.equal(
    truncatedLocalEvidence.structuredContent?.temporaryBlockEvidence?.bodyAnalysis?.references?.length,
    1
  );
  assert.equal(
    truncatedLocalEvidence.structuredContent?.temporaryBlockEvidence?.bodyAnalysis?.flows?.length,
    1
  );
  assert.equal(
    truncatedLocalEvidence.structuredContent?.temporaryBlockEvidence?.bodyAnalysis?.counts?.references,
    4
  );
  assert.equal(
    truncatedLocalEvidence.structuredContent?.temporaryBlockEvidence?.bodyAnalysis?.counts?.flows,
    2
  );

  const batch = await client.callTool({
    name: "tia_query_live_project",
    arguments: {
      processId: 4_242,
      queries: [
        {
          operationId: "read-db-main",
          resourceKind: "block",
          name: "DB_Main",
          blockKind: "DB",
          number: "100"
        },
        {
          operationId: "read-duplicate",
          resourceKind: "block",
          name: "Duplicate"
        }
      ],
      includeCrossReferences: false,
      timeoutMs: 5_000
    }
  });
  assert.notEqual(batch.isError, true, JSON.stringify(batch));
  assert.equal(batch.structuredContent?.ok, false);
  assert.equal(batch.structuredContent?.status, "partial");
  assert.equal(batch.structuredContent?.queryCount, 2);
  assert.equal(batch.structuredContent?.completedCount, 1);
  assert.equal(batch.structuredContent?.failedCount, 1);
  assert.equal(batch.structuredContent?.skippedCount, 0);
  assert.equal(batch.structuredContent?.provenance?.currentUiContextReads, 0);
  assert.equal(batch.structuredContent?.provenance?.identitySource, "resident_core_prepared_session");
  assert.equal(batch.structuredContent?.results?.[0]?.operationId, "read-db-main");
  assert.equal(batch.structuredContent?.results?.[0]?.status, "resolved");
  assert.equal(batch.structuredContent?.results?.[1]?.operationId, "read-duplicate");
  assert.equal(batch.structuredContent?.results?.[1]?.status, "ambiguous");

  const automaticRefreshRequestStart = fake.requests.length;
  const automaticRefreshBatch = await client.callTool({
    name: "tia_query_live_project",
    arguments: {
      processId: 4_242,
      queries: [
        {
          operationId: "missing-block-first",
          resourceKind: "block",
          name: "MissingBlockFirst"
        },
        {
          operationId: "missing-block-second",
          resourceKind: "block",
          name: "MissingBlockSecond"
        }
      ],
      includeCrossReferences: false,
      timeoutMs: 5_000
    }
  });
  assert.notEqual(automaticRefreshBatch.isError, true, JSON.stringify(automaticRefreshBatch));
  assert.equal(automaticRefreshBatch.structuredContent?.status, "partial");
  assert.equal(automaticRefreshBatch.structuredContent?.failedCount, 2);
  const automaticRefreshRequests = fake.requests
    .slice(automaticRefreshRequestStart)
    .filter((request) => request.operation === "query_object");
  assert.deepEqual(
    automaticRefreshRequests.map((request) => ({
      name: request.identity?.name,
      refreshInventory: request.refreshInventory,
      retryNotFoundWithRefresh: request.retryNotFoundWithRefresh
    })),
    [
      {
        name: "MissingBlockFirst",
        refreshInventory: false,
        retryNotFoundWithRefresh: true
      },
      {
        name: "MissingBlockSecond",
        refreshInventory: false,
        retryNotFoundWithRefresh: false
      }
    ]
  );

  const forcedRefreshRequestStart = fake.requests.length;
  const forcedRefreshBatch = await client.callTool({
    name: "tia_query_live_project",
    arguments: {
      processId: 4_242,
      queries: [
        {
          operationId: "force-block-first",
          resourceKind: "block",
          name: "ForceBlockFirst"
        },
        {
          operationId: "force-type-first",
          resourceKind: "plc_type",
          name: "ForceTypeFirst"
        },
        {
          operationId: "force-block-second",
          resourceKind: "block",
          name: "ForceBlockSecond"
        },
        {
          operationId: "force-type-second",
          resourceKind: "plc_type",
          name: "ForceTypeSecond"
        }
      ],
      includeCrossReferences: false,
      refreshInventory: true,
      timeoutMs: 5_000
    }
  });
  assert.notEqual(forcedRefreshBatch.isError, true, JSON.stringify(forcedRefreshBatch));
  assert.equal(forcedRefreshBatch.structuredContent?.status, "completed");
  assert.equal(forcedRefreshBatch.structuredContent?.completedCount, 4);
  const forcedRefreshRequests = fake.requests
    .slice(forcedRefreshRequestStart)
    .filter((request) => request.operation === "query_object");
  assert.deepEqual(
    forcedRefreshRequests.map((request) => ({
      resourceKind: request.identity?.resourceKind,
      name: request.identity?.name,
      refreshInventory: request.refreshInventory,
      retryNotFoundWithRefresh: request.retryNotFoundWithRefresh
    })),
    [
      {
        resourceKind: "block",
        name: "ForceBlockFirst",
        refreshInventory: true,
        retryNotFoundWithRefresh: false
      },
      {
        resourceKind: "plc_type",
        name: "ForceTypeFirst",
        refreshInventory: true,
        retryNotFoundWithRefresh: false
      },
      {
        resourceKind: "block",
        name: "ForceBlockSecond",
        refreshInventory: false,
        retryNotFoundWithRefresh: false
      },
      {
        resourceKind: "plc_type",
        name: "ForceTypeSecond",
        refreshInventory: false,
        retryNotFoundWithRefresh: false
      }
    ]
  );

  const pipeRequestsBeforeUiRefusal = fake.requests.length;
  await writeFile(uiContextFile, JSON.stringify(uiContextFixture({
    selectedObject: {
      status: "ambiguous",
      source: "project_navigator_msaa",
      candidates: [
        { label: "ConveyorControl [FB42]" },
        { label: "Sequence [FC7]" }
      ]
    }
  })), "utf8");
  const selectionRefusal = await client.callTool({
    name: "tia_get_current_block",
    arguments: {
      processId: 4_242,
      includeCrossReferences: false,
      includeInterface: false,
      includeProgramBody: false,
      timeoutMs: 3_000
    }
  });
  assert.equal(selectionRefusal.structuredContent?.ok, false);
  assert.equal(selectionRefusal.structuredContent?.status, "current_block_ambiguous");
  assert.equal(fake.requests.length, pipeRequestsBeforeUiRefusal);

  await writeFile(uiContextFile, JSON.stringify(uiContextFixture({
    status: "multiple",
    selectedProcessId: null
  })), "utf8");
  const projectRefusal = await client.callTool({
    name: "tia_query_live_project",
    arguments: {
      resourceKind: "plc_type",
      name: "MotorType",
      includeCrossReferences: false,
      includeInterface: false,
      timeoutMs: 3_000
    }
  });
  assert.equal(projectRefusal.structuredContent?.ok, false);
  assert.equal(projectRefusal.structuredContent?.status, "live_project_unavailable");
  assert.equal(fake.requests.length, pipeRequestsBeforeUiRefusal);

  assert.deepEqual(
    fake.requests.filter((request) => request.operation !== "ping").map((request) => ({
      operation: request.operation,
      processId: request.processId,
      projectPath: request.projectPath,
      name: request.identity?.name
    })),
    [
        { operation: "attach_session", processId: 4_242, projectPath: exactProjectPath, name: undefined },
        { operation: "query_object", processId: 4_242, projectPath: exactProjectPath, name: "DB_Main" },
        { operation: "attach_session", processId: 4_242, projectPath: exactProjectPath, name: undefined },
        { operation: "search_objects", processId: 4_242, projectPath: exactProjectPath, name: undefined },
        { operation: "query_object", processId: 4_242, projectPath: exactProjectPath, name: "ConveyorControl" },
        { operation: "query_object", processId: 4_242, projectPath: exactProjectPath, name: "MalformedXmlBlock" },
        { operation: "query_object", processId: 4_242, projectPath: exactProjectPath, name: "BoundedEvidenceBlock" },
        { operation: "read_engineering", processId: 4_242, projectPath: exactProjectPath, name: undefined },
        { operation: "read_engineering", processId: 4_242, projectPath: exactProjectPath, name: undefined },
        { operation: "query_object", processId: 4_242, projectPath: exactProjectPath, name: "DB_Main" },
        { operation: "query_object", processId: 4_242, projectPath: exactProjectPath, name: "Duplicate" },
        { operation: "query_object", processId: 4_242, projectPath: exactProjectPath, name: "WrongProject" },
        { operation: "query_object", processId: 4_242, projectPath: exactProjectPath, name: "ConveyorControl" },
        { operation: "query_object", processId: 4_242, projectPath: exactProjectPath, name: "MalformedXmlBlock" },
        { operation: "query_object", processId: 4_242, projectPath: exactProjectPath, name: "BoundedEvidenceBlock" },
        { operation: "query_object", processId: 4_242, projectPath: exactProjectPath, name: "DB_Main" },
        { operation: "query_object", processId: 4_242, projectPath: exactProjectPath, name: "Duplicate" },
        { operation: "query_object", processId: 4_242, projectPath: exactProjectPath, name: "MissingBlockFirst" },
        { operation: "query_object", processId: 4_242, projectPath: exactProjectPath, name: "MissingBlockSecond" },
        { operation: "query_object", processId: 4_242, projectPath: exactProjectPath, name: "ForceBlockFirst" },
        { operation: "query_object", processId: 4_242, projectPath: exactProjectPath, name: "ForceTypeFirst" },
        { operation: "query_object", processId: 4_242, projectPath: exactProjectPath, name: "ForceBlockSecond" },
        { operation: "query_object", processId: 4_242, projectPath: exactProjectPath, name: "ForceTypeSecond" }
    ]
  );
  } finally {
    await client.close();
  }
});
