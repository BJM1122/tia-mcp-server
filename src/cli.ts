import { readFile } from "node:fs/promises";
import { normalizePath, paths } from "./core/local-paths.js";
import { DEFAULT_TIMEOUT_MS } from "./core/process.js";
import { type JsonValue, objectRecord } from "./core/results.js";
import {
  type DoctorRequirement, requiredCapability, SERVER_VERSION, collectDoctorReport
} from "./environment.js";
import {
  attachExactLiveSession, liveCoreOptions, mergeLiveCompleteness, parseLiveBlockXml, queryExactLiveBatch,
  queryExactLiveObject, readPreparedLiveSession, remainingTimeMs, resolveExactLiveSession,
  resolvePreparedLiveQuerySession, withoutBlockXmlPayload
} from "./live-session.js";
import { executeProjectSnapshot } from "./snapshot-workflow.js";
import { queryTiaLiveCore, type TiaLiveObjectIdentity, type TiaLiveResourceKind } from "./tia-live-core.js";
import { selectCurrentBlock } from "./tia-ui-context.js";

// Command-line entry points used outside MCP (--doctor, --live-core-status/--prewarm,
// --prepare-live-session, --export-snapshot, --live-current-block, --live-query, --live-batch).

function cliArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) return undefined;
  return process.argv[index + 1];
}

function cliInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = cliArgument(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function cliOptionalProcessId(): number | undefined {
  const raw = cliArgument("--process-id");
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("--process-id must be a positive integer.");
  }
  return value;
}

export async function runDoctorCli(): Promise<void> {
  const required = cliArgument("--require") as DoctorRequirement | undefined;
  if (required && !["core-read", "project-export", "project-import", "network-probe"].includes(required)) {
    throw new Error("--require must be core-read, project-export, project-import, or network-probe.");
  }
  const validated = await collectDoctorReport();
  const requirement = requiredCapability(validated.capabilityReport, required);
  const ok = requirement?.available ?? validated.status === "ready";
  console.log(JSON.stringify({
    ok,
    status: requirement && !requirement.available
      ? "required_capability_unavailable"
      : validated.capabilityReport.status,
    serverVersion: SERVER_VERSION,
    requiredCapability: required ?? "",
    requirement,
    checks: validated.checks,
    portalVersions: validated.portalVersions,
    unavailableCapabilities: validated.unavailableCapabilities,
    capabilityReport: validated.capabilityReport,
    guarantees: {
      tiaAttached: false,
      residentWorkerStarted: false,
      projectModified: false,
      plcAccessed: false
    }
  }, null, 2));
  if (!ok) process.exitCode = 2;
}

export async function runLiveCoreStatusCli(): Promise<void> {
  const timeoutMs = cliInteger("--timeout-ms", 5_000, 1_000, 60_000);
  const response = await queryTiaLiveCore(
    { operation: "ping", timeoutMs },
    liveCoreOptions(timeoutMs)
  );
  console.log(JSON.stringify(response, null, 2));
}

export async function runPrepareLiveSessionCli(): Promise<void> {
  const timeoutMs = cliInteger("--timeout-ms", 20_000, 3_000, 60_000);
  const deadline = Date.now() + timeoutMs;
  const confirmPortalAuthorizationReady = process.argv.includes("--confirm-portal-authorization-ready");
  const live = await resolveExactLiveSession({
    processId: cliOptionalProcessId(),
    timeoutMs: remainingTimeMs(deadline, "current UI-context read", 1_000),
    maxNodes: cliInteger("--max-nodes", 800, 50, 2_000),
    maxDepth: cliInteger("--max-depth", 8, 2, 12)
  });
  if (!live.ok) {
    console.log(JSON.stringify({
      ok: false,
      status: live.status,
      reason: live.reason,
      context: live.observed.context
    }, null, 2));
    process.exitCode = 2;
    return;
  }
  const portalMinimized = live.selectedProcess?.isMinimized === true;
  const prepared = await readPreparedLiveSession({
    processId: live.processId,
    timeoutMs: Math.min(remainingTimeMs(deadline, "resident session status", 1_000), 5_000),
    expectedProjectPath: live.projectPath,
    expectedProcessStartTimeUtc: live.processStartTimeUtc
  });
  if (!prepared.ok && !confirmPortalAuthorizationReady) {
    console.log(JSON.stringify({
      ok: false,
      status: "portal_authorization_check_required",
      requiresUserAction: true,
      reason: "Bring TIA Portal to the foreground. The next confirmed call may show a Siemens Openness access prompt; approve it in Portal.",
      exactLiveIdentity: {
        processId: live.processId,
        processStartTimeUtc: live.processStartTimeUtc,
        projectPath: live.projectPath
      },
      portalMinimized,
      attachAttempted: false,
      nextCommandFlag: "--confirm-portal-authorization-ready"
    }, null, 2));
    process.exitCode = 2;
    return;
  }
  if (!prepared.ok && portalMinimized) {
    console.log(JSON.stringify({
      ok: false,
      status: "portal_must_be_visible_for_authorization",
      requiresUserAction: true,
      reason: "Restore TIA Portal before starting a cold Openness attach so the Siemens authorization prompt cannot be hidden.",
      attachAttempted: false
    }, null, 2));
    process.exitCode = 2;
    return;
  }
  try {
    if (!prepared.ok) {
      console.error("TIA Portal may now show a Siemens Openness authorization prompt; approve it to continue.");
    }
    const core = await attachExactLiveSession({
      processId: live.processId,
      processStartTimeUtc: live.processStartTimeUtc,
      projectPath: live.projectPath,
      timeoutMs: remainingTimeMs(deadline, "Openness attach", 1_000)
    });
    console.log(JSON.stringify({
      ...core,
      exactLiveIdentity: {
        processId: live.processId,
        processStartTimeUtc: live.processStartTimeUtc,
        projectPath: live.projectPath
      },
      portalMinimized,
      inventoryEnumerated: false
    }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({
      ok: false,
      status: "live_session_attach_error",
      error: error instanceof Error ? error.message : String(error),
      portalMinimized,
      likelyAction: portalMinimized
        ? "Restore TIA Portal and respond to any Siemens Openness authorization dialog, then retry."
        : "Check Siemens TIA Openness authorization/group membership, then retry."
    }, null, 2));
    process.exitCode = 2;
  }
}

export async function runExportSnapshotCli(): Promise<void> {
  const projectPath = cliArgument("--project-path");
  if (!projectPath?.trim()) {
    throw new Error("--export-snapshot requires --project-path <exact .ap20>.");
  }
  const timeoutMs = cliInteger("--timeout-ms", DEFAULT_TIMEOUT_MS, 60_000, 1_800_000);
  const result = await executeProjectSnapshot({
    processId: cliOptionalProcessId(),
    projectPath,
    outputRoot: cliArgument("--output-root") ?? paths.defaultOutputRoot,
    timeoutMs,
    confirmPortalAuthorizationReady: process.argv.includes("--confirm-portal-authorization-ready")
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.ok !== true || result.requestedActionCompleted !== true) process.exitCode = 2;
}

export async function runLiveCurrentBlockCli(): Promise<void> {
  const timeoutMs = cliInteger("--timeout-ms", 20_000, 3_000, 60_000);
  const deadline = Date.now() + timeoutMs;
  const processId = cliOptionalProcessId();
  const includeProgramBody = process.argv.includes("--include-body");
  const includeRawXml = process.argv.includes("--include-raw-xml");
  if (includeRawXml && !includeProgramBody) {
    throw new Error("--include-raw-xml requires --include-body.");
  }
  const live = await resolveExactLiveSession({
    processId,
    timeoutMs: remainingTimeMs(deadline, "current UI-context read", 1_000),
    maxNodes: 800,
    maxDepth: 8
  });
  const currentBlock = selectCurrentBlock(live.observed.context);
  if (!live.ok || currentBlock.status !== "resolved" || !currentBlock.block) {
    console.log(JSON.stringify({
      ok: false,
      status: live.ok
        ? (currentBlock.status === "ambiguous" ? "current_block_ambiguous" : "current_block_unavailable")
        : live.status,
      context: live.observed.context,
      currentBlock
    }, null, 2));
    process.exitCode = 2;
    return;
  }
  const identity: TiaLiveObjectIdentity = {
    resourceKind: "block",
    name: currentBlock.block.name ?? "",
    blockKind: currentBlock.block.kind,
    number: currentBlock.block.number
  };
  const core = await queryExactLiveObject({
    processId: live.processId,
    processStartTimeUtc: live.processStartTimeUtc,
    projectPath: live.projectPath,
    identity,
    timeoutMs: remainingTimeMs(deadline, "official live block query", 1_000),
    includeCrossReferences: true,
    includeBlockXml: includeProgramBody,
    includeProgramBody,
    includeInterface: true,
    maxResults: 500,
    maxXmlBytes: 15_000_000
  });
  let temporaryBlockEvidence: JsonValue = null;
  if (core.ok) {
    try {
      temporaryBlockEvidence = parseLiveBlockXml(
        core,
        15_000_000,
        1_000,
        1_000,
        true,
        includeProgramBody,
        includeRawXml
      ) as unknown as JsonValue;
    } catch (error) {
      temporaryBlockEvidence = {
        ok: false,
        status: "temporary_block_xml_parse_error",
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
  const completeness = mergeLiveCompleteness(core, {
    temporaryBlockEvidence,
    includeInterface: true,
    includeProgramBody
  });
  const requestedActionCompleted = core.ok && completeness.requestedActionCompleted === true;
  const combinedStatus = core.ok && !requestedActionCompleted ? "partial" : core.status;
  console.log(JSON.stringify({
    ok: core.ok,
    status: combinedStatus,
    requestedActionCompleted,
    completeness,
    exactLiveIdentity: {
      processId: live.processId,
      projectPath: live.projectPath,
      object: identity
    },
    currentBlock,
    directLive: withoutBlockXmlPayload(core),
    temporaryBlockEvidence
  }, null, 2));
  if (!requestedActionCompleted) process.exitCode = 2;
}

export async function runLiveQueryCli(): Promise<void> {
  const timeoutMs = cliInteger("--timeout-ms", 20_000, 3_000, 60_000);
  const deadline = Date.now() + timeoutMs;
  const processId = cliOptionalProcessId();
  const resourceKind = cliArgument("--resource-kind") as TiaLiveResourceKind | undefined;
  const name = cliArgument("--name");
  if (!resourceKind || !["block", "plc_type", "tag_table", "plc_tag"].includes(resourceKind) || !name?.trim()) {
    throw new Error("--live-query requires --resource-kind block|plc_type|tag_table|plc_tag and --name <exact-name>.");
  }
  const includeProgramBody = process.argv.includes("--include-body");
  const includeRawXml = process.argv.includes("--include-raw-xml");
  const includeInterface = process.argv.includes("--include-interface");
  if (includeRawXml && !includeProgramBody) {
    throw new Error("--include-raw-xml requires --include-body.");
  }
  if (includeProgramBody && resourceKind !== "block") {
    throw new Error("--include-body is supported only for --resource-kind block.");
  }
  const live = await resolvePreparedLiveQuerySession({
    processId,
    timeoutMs: remainingTimeMs(deadline, "prepared live-session identity", 1_000),
    maxNodes: 800,
    maxDepth: 8
  });
  if (!live.ok) {
    console.log(JSON.stringify({
      ok: false,
      status: live.status,
      reason: live.reason,
      context: live.context
    }, null, 2));
    process.exitCode = 2;
    return;
  }
  const identity: TiaLiveObjectIdentity = {
    resourceKind,
    name: name.trim(),
    blockKind: cliArgument("--block-kind"),
    number: cliArgument("--number"),
    tagTableName: cliArgument("--tag-table")
  };
  const core = await queryExactLiveObject({
    processId: live.processId,
    processStartTimeUtc: live.processStartTimeUtc,
    projectPath: live.projectPath,
    identity,
    timeoutMs: remainingTimeMs(deadline, "official live project query", 1_000),
    includeCrossReferences: !process.argv.includes("--no-cross-references"),
    includeBlockXml: resourceKind === "block" && includeProgramBody,
    includeProgramBody,
    includeInterface,
    maxResults: cliInteger("--max-results", 500, 1, 5_000),
    maxXmlBytes: 15_000_000,
    preparedSessionChecked: true,
    refreshInventory: process.argv.includes("--refresh-inventory")
  });
  let temporaryBlockEvidence: JsonValue = null;
  if (core.ok && resourceKind === "block" && (includeInterface || includeProgramBody)) {
    try {
      temporaryBlockEvidence = parseLiveBlockXml(
        core,
        15_000_000,
        1_000,
        1_000,
        includeInterface,
        includeProgramBody,
        includeRawXml
      ) as unknown as JsonValue;
    } catch (error) {
      temporaryBlockEvidence = {
        ok: false,
        status: "temporary_block_xml_parse_error",
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
  const completeness = mergeLiveCompleteness(core, {
    temporaryBlockEvidence,
    includeInterface,
    includeProgramBody
  });
  const requestedActionCompleted = core.ok && completeness.requestedActionCompleted === true;
  const combinedStatus = core.ok && !requestedActionCompleted ? "partial" : core.status;
  console.log(JSON.stringify({
    ok: core.ok,
    status: combinedStatus,
    requestedActionCompleted,
    completeness,
    exactLiveIdentity: {
      processId: live.processId,
      projectPath: live.projectPath,
      object: identity
    },
    directLive: withoutBlockXmlPayload(core),
    temporaryBlockEvidence
  }, null, 2));
  if (!requestedActionCompleted) process.exitCode = 2;
}

export async function runLiveBatchCli(): Promise<void> {
  const inputPath = cliArgument("--input");
  if (!inputPath) {
    throw new Error("--live-batch requires --input <queries.json>.");
  }
  const timeoutMs = cliInteger("--timeout-ms", 30_000, 3_000, 120_000);
  const rawText = await readFile(normalizePath(inputPath), "utf8");
  if (Buffer.byteLength(rawText, "utf8") > 1_000_000) {
    throw new Error("--input JSON must not exceed 1,000,000 bytes.");
  }
  const parsed = JSON.parse(rawText) as unknown;
  const parsedObject = objectRecord(parsed);
  const rawQueries = Array.isArray(parsed) ? parsed : parsedObject?.queries;
  if (!Array.isArray(rawQueries) || rawQueries.length < 1 || rawQueries.length > 50) {
    throw new Error("--input must be an array of 1..50 live query objects or an object with a queries array.");
  }
  const operationIds = new Set<string>();
  const queries = rawQueries.map((raw, index) => {
    const record = objectRecord(raw);
    const resourceKind = String(record?.resourceKind ?? "");
    const name = String(record?.name ?? "").trim();
    const operationId = String(record?.operationId ?? `query-${index + 1}`).trim();
    if (!["block", "plc_type", "tag_table", "plc_tag"].includes(resourceKind) || !name || !operationId) {
      throw new Error(`Invalid live batch query at index ${index}.`);
    }
    if (operationIds.has(operationId)) {
      throw new Error(`Duplicate operationId in --input: ${operationId}`);
    }
    operationIds.add(operationId);
    return {
      operationId,
      resourceKind: resourceKind as TiaLiveResourceKind,
      name,
      blockKind: typeof record?.blockKind === "string" ? record.blockKind : undefined,
      number: typeof record?.number === "string" ? record.number : undefined,
      tagTableName: typeof record?.tagTableName === "string" ? record.tagTableName : undefined,
      namespace: typeof record?.namespace === "string" ? record.namespace : undefined,
      softwarePath: typeof record?.softwarePath === "string" ? record.softwarePath : undefined,
      officialIdentifier: typeof record?.officialIdentifier === "string" ? record.officialIdentifier : undefined
    };
  });
  const result = await queryExactLiveBatch({
    processId: cliOptionalProcessId(),
    queries,
    timeoutMs,
    maxNodes: cliInteger("--max-nodes", 800, 50, 2_000),
    maxDepth: cliInteger("--max-depth", 8, 2, 12),
    includeCrossReferences: process.argv.includes("--cross-references"),
    maxResultsPerQuery: cliInteger("--max-results", 200, 1, 1_000),
    refreshInventory: process.argv.includes("--refresh-inventory")
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.ok !== true) process.exitCode = 2;
}
