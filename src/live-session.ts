import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { paths, resolveOpennessApiDll } from "./core/local-paths.js";
import { runPowerShell } from "./core/process.js";
import { type JsonValue, objectRecord, textResult, truncate } from "./core/results.js";
import { extractSimaticObject, flattenInterfaceMembers } from "./core/simatic-objects.js";
import { parseSimaticXmlText, scalarString } from "./core/simatic-xml.js";
import { analyzeSingleBlockXml } from "./knowledge.js";
import { boundProgramEvidence, ProgramAnalysisCache } from "./program-evidence.js";
import {
  queryTiaLiveCore, type TiaLiveCoreResponse, type TiaLiveObjectIdentity, type TiaLiveResourceKind
} from "./tia-live-core.js";
import { parseTiaUiContextJson, type TiaUiContext } from "./tia-ui-context.js";
import { DEFAULT_PORTAL_VERSION, type ReadOnlyPortalVersion } from "./tia-version.js";

// Live TIA sessions: passive UI context, exact session identity, the prepared resident
// core and live object queries.

export const programAnalysisCache = new ProgramAnalysisCache();

const MAX_UI_CONTEXT_OUTPUT_BYTES = 1_000_000;

export const liveToolOutputSchema = z.object({
  ok: z.boolean(),
  status: z.string(),
  requestedActionCompleted: z.boolean().optional(),
  completeness: z.object({
    requestedActionCompleted: z.boolean().optional()
  }).passthrough().optional()
}).passthrough();

export function liveStructuredResult(value: Record<string, JsonValue>) {
  const summary: Record<string, JsonValue> = {
    ok: value.ok ?? false,
    status: value.status ?? "unknown"
  };
  for (const key of ["readOnly", "requestedActionCompleted", "reason", "error", "exactLiveIdentity", "completeness", "navigation"]) {
    if (value[key] !== undefined) summary[key] = value[key];
  }
  return textResult(JSON.stringify(summary, null, 2), value);
}

export function remainingTimeMs(deadline: number, stage: string, minimum = 500): number {
  const remaining = Math.floor(deadline - Date.now());
  if (remaining < minimum) {
    throw new Error(`TIA live operation timed out before ${stage}; remaining budget ${Math.max(0, remaining)} ms.`);
  }
  return remaining;
}

export async function readCurrentTiaUiContext(args: {
  portalVersion?: ReadOnlyPortalVersion;
  processId?: number;
  timeoutMs: number;
  maxNodes: number;
  maxDepth: number;
}): Promise<{ context: TiaUiContext; companion: Record<string, JsonValue> }> {
  if (process.platform !== "win32") {
    return {
      context: parseTiaUiContextJson(JSON.stringify({
        schemaVersion: "1.0",
        observedAt: new Date().toISOString(),
        status: "unsupported",
        selectedProcessId: null,
        processes: [],
        selectedObject: { status: "unavailable", source: "project_navigator_msaa" },
        activeEditor: { status: "unavailable", source: "editor_frame_msaa" },
        networkOrSection: { status: "unavailable", source: "network_container_msaa" },
        limitations: ["The current TIA UI context companion supports Windows only.", "Mouse hover is not observed."]
      }), { maxBytes: MAX_UI_CONTEXT_OUTPUT_BYTES }),
      companion: { ok: false, status: "unsupported_platform" }
    };
  }
  if (!existsSync(paths.uiContextScript)) {
    throw new Error(`TIA UI context companion not found: ${paths.uiContextScript}`);
  }
  const api = resolveOpennessApiDll(args.portalVersion);
  if (!api) {
    throw new Error(`Siemens.Engineering.dll was not found for ${args.portalVersion ?? "V20"}. Install the matching TIA Openness component; cross-version fallback is disabled.`);
  }
  const commandArgs = [
    "-File",
    paths.uiContextScript,
    "-ApiDll",
    api.dllPath,
    "-MaxNodes",
    String(args.maxNodes),
    "-MaxDepth",
    String(args.maxDepth)
  ];
  if (args.processId !== undefined) commandArgs.push("-ProcessId", String(args.processId));
  const result = await runPowerShell(commandArgs, args.timeoutMs, "tree-force");
  const rawOutput = result.stdout.replace(/^\uFEFF/, "").trim();
  if (!rawOutput) {
    throw new Error(`TIA UI context companion returned no JSON (exit ${result.exitCode ?? "unknown"}${result.stderr.trim() ? `: ${truncate(result.stderr.trim(), 500).text}` : ""}).`);
  }
  const context = parseTiaUiContextJson(rawOutput, { maxBytes: MAX_UI_CONTEXT_OUTPUT_BYTES });
  return {
    context,
    companion: {
      ok: result.exitCode === 0,
      exitCode: result.exitCode ?? -1,
      apiDllSource: api.source
    }
  };
}

// Only export/import use this shortcut. A snapshot also needs a fresh window-state observation.
// attachWhenCold (import plans): a cold V20 core is attached here, best effort. Without it the plan
// and the apply still work through the importer's own attach, only slower.
export async function resolveWorkflowSession(args: Parameters<typeof resolveExactLiveSession>[0] & { projectPath?: string }, requireWindow = false, attachWhenCold = false) {
  if (args.processId && (args.portalVersion ?? "V20") === "V20") {
    try {
      const prepared = await readPreparedLiveSession({ processId: args.processId, existingOnly: true, verifySession: true, expectedProjectPath: args.projectPath, timeoutMs: Math.min(args.timeoutMs, 5000) });
      if (prepared.ok && prepared.response.ok && /\.ap20$/i.test(prepared.projectPath)) {
        let isMinimized: boolean | undefined;
        if (requireWindow) {
          const script = [
            "$ErrorActionPreference='Stop'",
            "Add-Type -AssemblyName UIAutomationClient",
            "$p=Get-Process -Id " + Number(args.processId),
            "if ($p.MainWindowHandle -eq 0) { throw 'Missing window' }",
            "$w=[Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)",
            "$state=$w.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern).Current.WindowVisualState",
            "[pscustomobject]@{start=$p.StartTime.ToUniversalTime().ToString('o');state=$state.ToString()} | ConvertTo-Json -Depth 2 -Compress"
          ].join("; ");
          const output = await runPowerShell(["-NonInteractive", "-Command", script], Math.min(args.timeoutMs, 3000));
          const window = JSON.parse(output.stdout);
          if (output.exitCode !== 0 || window.start !== prepared.processStartTimeUtc ||
              !["Normal", "Maximized", "Minimized"].includes(window.state)) throw new Error("Window identity unavailable");
          isMinimized = window.state === "Minimized";
        }
        return { ok: true as const, identitySource: "resident_core_prepared_session", processId: prepared.processId,
          processStartTimeUtc: prepared.processStartTimeUtc, projectPath: prepared.projectPath, selectedProcess: { isMinimized } };
      }
    } catch { /* Fall back to the full observation when either source is unavailable. */ }
  }
  const observed = await resolveExactLiveSession(args);
  const attached = attachWhenCold && observed.ok && (args.portalVersion ?? "V20") === "V20"
    && (await attachColdSession(observed, Math.min(args.timeoutMs, 15_000))).ok;
  return { ...observed, identitySource: attached ? "current_ui_context_plus_automatic_attach" : "current_ui_context" };
}

export async function resolveExactLiveSession(args: {
  portalVersion?: ReadOnlyPortalVersion;
  processId?: number;
  timeoutMs: number;
  maxNodes: number;
  maxDepth: number;
}) {
  const observed = await readCurrentTiaUiContext(args);
  const selectedProcess = observed.context.processes.find(
    (candidate) => candidate.processId === observed.context.selectedProcessId
  ) ?? null;
  if (
    observed.context.status !== "selected"
    || !selectedProcess?.projectPath
    || !selectedProcess.processId
    || !selectedProcess.processStartTimeUtc
  ) {
    return {
      ok: false as const,
      status: "live_project_unavailable",
      observed,
      selectedProcess,
      reason: "Exactly one current TIA session with an official diagnostic PID, OS process-start identity, and canonical .ap20 project path is required."
    };
  }
  return {
    ok: true as const,
    status: "resolved",
    observed,
    selectedProcess,
    processId: selectedProcess.processId,
    processStartTimeUtc: selectedProcess.processStartTimeUtc,
    projectPath: selectedProcess.projectPath
  };
}

// Live queries without an explicit PID otherwise start one PowerShell UI
// observation (~1 s) per call. The cached identity is only a hint: every use
// is rechecked against the prepared resident session (PID, OS process start,
// canonical project path), and the core rechecks it again per request.
// Kept short: the resident core holds one session, so a cache hit can keep
// serving the previously prepared project if the user switches Portal windows
// within this window. The response always names the project path it read.
const DEFAULT_UI_IDENTITY_CACHE_MS = 5_000;

let uiSessionIdentityCache: {
  processId: number;
  processStartTimeUtc: string;
  projectPath: string;
  observedAtMs: number;
} | null = null;

function uiIdentityCacheMs(): number {
  const raw = process.env.TIA_MCP_UI_IDENTITY_CACHE_MS?.trim();
  if (!raw) return DEFAULT_UI_IDENTITY_CACHE_MS;
  const configured = Number(raw);
  return Number.isInteger(configured) && configured >= 0 && configured <= 60_000
    ? configured
    : DEFAULT_UI_IDENTITY_CACHE_MS;
}

function rememberUiSessionIdentity(processId: number, processStartTimeUtc: string, projectPath: string): void {
  uiSessionIdentityCache = uiIdentityCacheMs() > 0
    ? { processId, processStartTimeUtc, projectPath, observedAtMs: Date.now() }
    : null;
}

function freshUiSessionIdentity() {
  const cached = uiSessionIdentityCache;
  if (!cached) return null;
  if (Date.now() - cached.observedAtMs > uiIdentityCacheMs()) {
    uiSessionIdentityCache = null;
    return null;
  }
  return cached;
}

// A query against a cold resident core attaches by itself instead of sending the caller to
// tia_prepare_live_session. Only a minimized Portal still needs the user first: the Siemens
// authorization prompt of a first attach would be hidden behind it.
async function attachColdSession(observed: {
  processId: number; processStartTimeUtc: string; projectPath: string; selectedProcess: { isMinimized?: boolean | null } | null;
}, timeoutMs: number) {
  if (observed.selectedProcess?.isMinimized === true) {
    return { ok: false as const, status: "portal_must_be_visible_for_authorization",
      reason: "Restore TIA Portal and retry: the first Openness attach may show a Siemens authorization prompt, which a minimized Portal would hide." };
  }
  try {
    await attachExactLiveSession({ processId: observed.processId, processStartTimeUtc: observed.processStartTimeUtc, projectPath: observed.projectPath, timeoutMs });
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, status: "live_session_attach_error",
      reason: `Automatic Openness attach failed: ${error instanceof Error ? error.message : String(error)} Bring TIA Portal to the foreground, approve the Siemens Openness access prompt if it is showing, and retry.` };
  }
}

export async function resolvePreparedLiveQuerySession(args: {
  processId?: number;
  timeoutMs: number;
  maxNodes: number;
  maxDepth: number;
}) {
  if (args.processId) {
    try {
      const prepared = await readPreparedLiveSession({
        processId: args.processId,
        timeoutMs: Math.min(args.timeoutMs, 5_000)
      });
      if (prepared.ok) {
        return {
          ok: true as const,
          status: "resolved",
          processId: prepared.processId,
          processStartTimeUtc: prepared.processStartTimeUtc,
          projectPath: prepared.projectPath,
          identitySource: "resident_core_prepared_session",
          context: null
        };
      }
      const observed = await resolveExactLiveSession(args);
      if (!observed.ok) {
        return { ok: false as const, status: observed.status, reason: observed.reason, identitySource: "current_ui_context", context: observed.observed.context };
      }
      const attached = await attachColdSession(observed, args.timeoutMs);
      if (!attached.ok) return { ...attached, identitySource: "current_ui_context", context: observed.observed.context };
      return {
        ok: true as const,
        status: "resolved",
        processId: observed.processId,
        processStartTimeUtc: observed.processStartTimeUtc,
        projectPath: observed.projectPath,
        identitySource: "current_ui_context_plus_automatic_attach",
        context: observed.observed.context
      };
    } catch (error) {
      return {
        ok: false as const,
        status: "live_core_unavailable",
        reason: error instanceof Error ? error.message : String(error),
        identitySource: "resident_core_status",
        context: null
      };
    }
  }

  const cached = freshUiSessionIdentity();
  if (cached) {
    try {
      const prepared = await readPreparedLiveSession({
        processId: cached.processId,
        timeoutMs: Math.min(args.timeoutMs, 5_000),
        expectedProjectPath: cached.projectPath,
        expectedProcessStartTimeUtc: cached.processStartTimeUtc
      });
      if (prepared.ok) {
        return {
          ok: true as const,
          status: "resolved",
          processId: cached.processId,
          processStartTimeUtc: cached.processStartTimeUtc,
          projectPath: cached.projectPath,
          identitySource: "cached_current_ui_context_plus_prepared_resident_session",
          context: null
        };
      }
    } catch {
      // Fall through to a fresh UI observation.
    }
    uiSessionIdentityCache = null;
  }

  const observed = await resolveExactLiveSession(args);
  if (!observed.ok) {
    uiSessionIdentityCache = null;
    return {
      ok: false as const,
      status: observed.status,
      reason: observed.reason,
      identitySource: "current_ui_context",
      context: observed.observed.context
    };
  }
  const prepared = await readPreparedLiveSession({
    processId: observed.processId,
    timeoutMs: Math.min(args.timeoutMs, 5_000),
    expectedProjectPath: observed.projectPath,
    expectedProcessStartTimeUtc: observed.processStartTimeUtc
  });
  if (!prepared.ok) {
    const attached = await attachColdSession(observed, args.timeoutMs);
    if (!attached.ok) {
      uiSessionIdentityCache = null;
      return { ...attached, identitySource: "current_ui_context", context: observed.observed.context };
    }
  }
  rememberUiSessionIdentity(observed.processId, observed.processStartTimeUtc, observed.projectPath);
  return {
    ok: true as const,
    status: "resolved",
    processId: observed.processId,
    processStartTimeUtc: observed.processStartTimeUtc,
    projectPath: observed.projectPath,
    identitySource: "current_ui_context_plus_prepared_resident_session",
    context: observed.observed.context
  };
}

export async function runAccessibleNetworkNavigation(args: {
  processId: number;
  processStartTimeUtc: string;
  projectPath: string;
  apiDll: string;
  exactLabel: string;
  timeoutMs: number;
  maxNodes: number;
  maxDepth: number;
}): Promise<Record<string, JsonValue>> {
  if (!existsSync(paths.accessibleNavigationScript)) {
    return {
      ok: false,
      status: "unsupported",
      reason: `Controlled accessibility locator not found: ${paths.accessibleNavigationScript}`,
      attempted: false
    };
  }
  const innerTimeoutMs = Math.min(Math.max(500, args.timeoutMs - 1_000), 14_000);
  const outerTimeoutMs = innerTimeoutMs + 1_000;
  const result = await runPowerShell([
    "-File",
    paths.accessibleNavigationScript,
    "-ProcessId",
    String(args.processId),
    "-ExpectedProcessStartTimeUtc",
    args.processStartTimeUtc,
    "-ExpectedProjectPath",
    args.projectPath,
    "-ApiDll",
    args.apiDll,
    "-ExactLabel",
    args.exactLabel,
    "-OfficialNavigationStatus",
    "opened_object",
    "-ConfirmNavigation",
    "NAVIGATE_ACCESSIBLE_NETWORK",
    "-TimeoutMs",
    String(innerTimeoutMs),
    "-MaxNodes",
    String(args.maxNodes),
    "-MaxDepth",
    String(args.maxDepth)
  ], outerTimeoutMs, "tree-force");
  const rawOutput = result.stdout.replace(/^\uFEFF/, "").trim();
  if (!rawOutput) {
    return {
      ok: false,
      status: "error",
      reason: `Accessibility locator returned no JSON (exit ${result.exitCode ?? "unknown"}${result.stderr.trim() ? `: ${truncate(result.stderr.trim(), 500).text}` : ""}).`,
      attempted: true
    };
  }
  if (Buffer.byteLength(rawOutput, "utf8") > MAX_UI_CONTEXT_OUTPUT_BYTES) {
    return {
      ok: false,
      status: "error",
      reason: `Accessibility locator output exceeded ${MAX_UI_CONTEXT_OUTPUT_BYTES} bytes.`,
      attempted: true
    };
  }
  try {
    const parsed = objectRecord(JSON.parse(rawOutput));
    if (!parsed || typeof parsed.status !== "string" || typeof parsed.ok !== "boolean") {
      throw new Error("invalid response envelope");
    }
    return {
      ...(parsed as Record<string, JsonValue>),
      attempted: true,
      exitCode: result.exitCode ?? -1
    };
  } catch (error) {
    return {
      ok: false,
      status: "error",
      reason: `Accessibility locator returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      attempted: true,
      exitCode: result.exitCode ?? -1
    };
  }
}

export function liveCoreOptions(timeoutMs: number) {
  const api = resolveOpennessApiDll();
  if (!api) {
    throw new Error(`Siemens.Engineering.dll was not found. Set TIA_MCP_API_DLL_${DEFAULT_PORTAL_VERSION.replaceAll(".", "_")} to the TIA Portal ${DEFAULT_PORTAL_VERSION} PublicAPI DLL.`);
  }
  if (!existsSync(paths.liveCoreExe)) {
    throw new Error(`TIA live read core not found: ${paths.liveCoreExe}. Run the production build first.`);
  }
  const configuredIdleTimeoutMs = Number(process.env.TIA_MCP_LIVE_CORE_IDLE_TIMEOUT_MS ?? "");
  const idleTimeoutMs = Number.isInteger(configuredIdleTimeoutMs)
    && configuredIdleTimeoutMs >= 30_000
    && configuredIdleTimeoutMs <= 86_400_000
    ? configuredIdleTimeoutMs
    : 3_600_000;
  return {
    coreExe: paths.liveCoreExe,
    apiDll: api.dllPath,
    timeoutMs,
    idleTimeoutMs
  };
}

export function canonicalProjectPathForComparison(value: unknown): string {
  let normalized = String(value ?? "").trim();
  if (normalized.startsWith("\\\\?\\UNC\\")) {
    normalized = `\\\\${normalized.slice("\\\\?\\UNC\\".length)}`;
  } else if (normalized.startsWith("\\\\?\\")) {
    normalized = normalized.slice("\\\\?\\".length);
  }
  return path.win32.normalize(normalized).replace(/[\\/]+$/, "").toLowerCase();
}

export function assertLiveCoreSession(
  response: TiaLiveCoreResponse,
  expectedProcessId: number,
  expectedProjectPath: string,
  expectedProcessStartTimeUtc?: string
): void {
  const session = objectRecord(response.session);
  if (!session && !response.ok) return;
  const actualProcessId = Number(session?.processId);
  const actualProjectPath = canonicalProjectPathForComparison(session?.canonicalProjectPath);
  const expectedCanonicalPath = canonicalProjectPathForComparison(expectedProjectPath);
  const expectedStartMs = expectedProcessStartTimeUtc ? Date.parse(expectedProcessStartTimeUtc) : Number.NaN;
  const actualStartText = String(session?.processStartTimeUtc ?? "");
  const actualStartMs = actualStartText ? Date.parse(actualStartText) : Number.NaN;
  const startMatches = !expectedProcessStartTimeUtc
    || (Number.isFinite(expectedStartMs) && Number.isFinite(actualStartMs) && expectedStartMs === actualStartMs);
  if (!session || actualProcessId !== expectedProcessId || !actualProjectPath || actualProjectPath !== expectedCanonicalPath || !startMatches) {
    throw new Error(
      `TIA live core session identity mismatch; expected PID ${expectedProcessId} and ${expectedProjectPath}, ` +
      `received PID ${Number.isFinite(actualProcessId) ? actualProcessId : "missing"} and ${String(session?.canonicalProjectPath ?? "missing")}` +
      (expectedProcessStartTimeUtc ? `; expected process start ${expectedProcessStartTimeUtc}, received ${actualStartText || "missing"}` : "") +
      "."
    );
  }
}

export function liveCoreSessionMatches(
  response: TiaLiveCoreResponse,
  expectedProcessId: number,
  expectedProjectPath: string,
  expectedProcessStartTimeUtc?: string
): boolean {
  try {
    assertLiveCoreSession(
      response,
      expectedProcessId,
      expectedProjectPath,
      expectedProcessStartTimeUtc
    );
    return Boolean(objectRecord(response.session));
  } catch {
    return false;
  }
}

export async function readPreparedLiveSession(args: {
  existingOnly?: boolean;
  verifySession?: boolean;
  processId: number;
  timeoutMs: number;
  expectedProjectPath?: string;
  expectedProcessStartTimeUtc?: string;
}) {
  const response = await queryTiaLiveCore(
    args.verifySession
      ? { operation: "verify_session", processId: args.processId, projectPath: args.expectedProjectPath,
          processStartTimeUtc: args.expectedProcessStartTimeUtc, timeoutMs: args.timeoutMs }
      : { operation: "ping", timeoutMs: args.timeoutMs },
    { ...liveCoreOptions(args.timeoutMs), existingOnly: args.existingOnly }
  );
  const session = objectRecord(response.session);
  const processId = Number(session?.processId);
  const projectPath = String(session?.canonicalProjectPath ?? "");
  const processStartTimeUtc = String(session?.processStartTimeUtc ?? "");
  const baseIdentityPresent = Boolean(
    session
    && processId === args.processId
    && projectPath
    && processStartTimeUtc
  );
  const expectedIdentityMatches = !args.expectedProjectPath
    || liveCoreSessionMatches(
      response,
      args.processId,
      args.expectedProjectPath,
      args.expectedProcessStartTimeUtc
    );
  return {
    ok: baseIdentityPresent && expectedIdentityMatches,
    response,
    session,
    processId,
    projectPath,
    processStartTimeUtc
  };
}

export function withoutBlockXmlPayload(response: TiaLiveCoreResponse): Record<string, JsonValue> {
  const copy = { ...response } as Record<string, unknown>;
  const blockXml = objectRecord(copy.blockXml);
  if (blockXml) {
    const blockXmlCopy = { ...blockXml };
    delete blockXmlCopy.base64;
    delete blockXmlCopy.xmlBase64;
    copy.blockXml = blockXmlCopy;
  }
  return copy as Record<string, JsonValue>;
}

export function liveBlockXmlText(response: TiaLiveCoreResponse, maxXmlBytes: number): {
  text: string;
  metadata: Record<string, JsonValue>;
} | null {
  const blockXml = objectRecord(response.blockXml);
  if (!blockXml) return null;
  const encoded = String(blockXml.base64 ?? blockXml.xmlBase64 ?? "");
  if (!encoded) return null;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > maxXmlBytes) {
    throw new Error(`Temporary block XML exceeded the requested ${maxXmlBytes} byte limit.`);
  }
  const declaredBytes = Number(blockXml.bytes ?? bytes.length);
  if (Number.isFinite(declaredBytes) && declaredBytes !== bytes.length) {
    throw new Error(`Temporary block XML byte count mismatch: declared ${declaredBytes}, decoded ${bytes.length}.`);
  }
  const declaredSha256 = String(blockXml.sha256 ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(declaredSha256)) {
    throw new Error("Temporary block XML response did not include a valid sha256 digest.");
  }
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== declaredSha256) {
    throw new Error(`Temporary block XML sha256 mismatch: declared ${declaredSha256}, decoded ${actualSha256}.`);
  }
  return {
    text: bytes.toString("utf8").replace(/^\uFEFF/, ""),
    metadata: withoutBlockXmlPayload(response).blockXml as Record<string, JsonValue>
  };
}

export function parseLiveBlockXml(
  response: TiaLiveCoreResponse,
  maxXmlBytes: number,
  interfaceLimit: number,
  bodyEvidenceLimit: number,
  includeInterface: boolean,
  includeProgramBody: boolean,
  includeRawXml: boolean
): Record<string, JsonValue> | null {
  const xml = liveBlockXmlText(response, maxXmlBytes);
  if (!xml) return null;
  const parsed = parseSimaticXmlText(xml.text);
  const object = extractSimaticObject(parsed);
  const attributes = object.value.AttributeList as Record<string, unknown> | undefined;
  const item = {
    name: scalarString(attributes?.Name),
    number: scalarString(attributes?.Number),
    kind: object.key.split(".").at(-1) ?? object.key,
    programmingLanguage: scalarString(attributes?.ProgrammingLanguage),
    softwarePath: scalarString(objectRecord(objectRecord(response.object)?.identity)?.softwarePath),
    relativePath: "<temporary-current-block-export>"
  };
  const analysis = includeProgramBody ? analyzeSingleBlockXml(xml.text, item) : null;
  const analysisStarted = Date.now();
  const execution = includeProgramBody ? programAnalysisCache.analyze({ ...item, xml: xml.text, language: item.programmingLanguage }) : null;
  return {
    provenance: {
      source: "official_openness_block_export",
      scope: "one_resolved_live_block",
      persistentExportOrIndexCreated: false,
      bodyAnalysis: includeProgramBody ? "local_existing_simatic_ml_heuristic_parser" : "not_requested",
      bodyAnalysisHeuristic: includeProgramBody,
      bodyLineSemantics: includeProgramBody
        ? "Simatic ML export line numbers; not TIA editor network or source-code line navigation"
        : "not_requested",
      temporaryFileCleanup: xml.metadata.tempCleanup ?? null
    },
    xml: xml.metadata,
    identity: item,
    execution: execution ? boundProgramEvidence(execution.result, bodyEvidenceLimit) as unknown as JsonValue : null,
    analysisTimings: { executionMs: Date.now() - analysisStarted, cacheHit: execution?.cacheHit ?? false },
    interface: includeInterface
      ? flattenInterfaceMembers(parsed, interfaceLimit) as unknown as JsonValue
      : null,
    bodyAnalysis: analysis
      ? {
          ...analysis,
          heuristic: true,
          lineSemantics: "Simatic ML export lines, not TIA editor network/source lines",
          references: analysis.references.slice(0, bodyEvidenceLimit),
          flows: analysis.flows.slice(0, bodyEvidenceLimit),
          truncated: analysis.references.length > bodyEvidenceLimit || analysis.flows.length > bodyEvidenceLimit
        } as unknown as JsonValue
      : null,
    rawXml: includeRawXml ? xml.text : null
  };
}

export function mergeLiveCompleteness(
  core: TiaLiveCoreResponse,
  args: {
    temporaryBlockEvidence: JsonValue;
    includeInterface: boolean;
    includeProgramBody: boolean;
  }
): Record<string, JsonValue> {
  const base = objectRecord(core.completeness) ?? {};
  const incompleteComponents = Array.isArray(base.incompleteComponents)
    ? [...base.incompleteComponents] as JsonValue[]
    : [];
  const temporaryEvidence = objectRecord(args.temporaryBlockEvidence);
  const coreBlockXml = objectRecord(core.blockXml);
  const localParseFailed = temporaryEvidence?.ok === false;
  const localEvidenceMissing = (
    !temporaryEvidence && (coreBlockXml?.included === true && (args.includeInterface || args.includeProgramBody)
      || core.ok && args.includeProgramBody)
  );
  const localInterface = objectRecord(temporaryEvidence?.interface);
  const localBodyAnalysis = objectRecord(temporaryEvidence?.bodyAnalysis);
  const localInterfaceTruncated = args.includeInterface && localInterface?.truncated === true;
  const localProgramBodyTruncated = args.includeProgramBody && (localBodyAnalysis?.truncated === true || objectRecord(temporaryEvidence?.execution)?.truncated === true);

  if (localParseFailed || localEvidenceMissing) {
    incompleteComponents.push({
      component: "localTemporaryXmlParse",
      status: localParseFailed ? "failed" : "missing",
      reason: localParseFailed
        ? "The official temporary XML was returned and cleaned up, but the bounded local Simatic ML parser rejected it."
        : "The core reported included temporary XML, but no parsed local Simatic ML evidence was produced."
    });
  }
  if (localInterfaceTruncated) {
    incompleteComponents.push({
      component: "localInterfaceParse",
      status: "truncated",
      reason: "The temporary single-block interface parsed successfully but exceeded interfaceLimit.",
      returnedMembers: Array.isArray(localInterface?.members) ? localInterface.members.length : 0
    });
  }
  if (localProgramBodyTruncated) {
    incompleteComponents.push({
      component: "localProgramBodyAnalysis",
      status: "truncated",
      reason: "The temporary single-block program-body analysis exceeded bodyEvidenceLimit.",
      returnedReferences: Array.isArray(localBodyAnalysis?.references) ? localBodyAnalysis.references.length : 0,
      returnedFlows: Array.isArray(localBodyAnalysis?.flows) ? localBodyAnalysis.flows.length : 0
    });
  }
  const coreCompleted = base.requestedActionCompleted === true
    || (base.requestedActionCompleted === undefined && core.status === "resolved");
  const localIncomplete = (
    localParseFailed
    || localEvidenceMissing
    || localInterfaceTruncated
    || localProgramBodyTruncated
  );
  return {
    ...(base as Record<string, JsonValue>),
    requestedActionCompleted: coreCompleted && incompleteComponents.length === 0 && !localIncomplete,
    localTemporaryXmlParse: localParseFailed || localEvidenceMissing
      ? "incomplete"
      : "complete_or_not_requested",
    localInterfaceParse: !args.includeInterface
      ? "not_requested"
      : localInterfaceTruncated
        ? "truncated"
        : localInterface
          ? "complete"
          : "direct_or_not_present",
    localProgramBodyAnalysis: !args.includeProgramBody
      ? "not_requested"
      : localProgramBodyTruncated
        ? "truncated"
        : localBodyAnalysis
          ? "complete"
          : "not_present",
    incompleteComponents
  };
}

export async function queryExactLiveObject(args: {
  processId: number;
  processStartTimeUtc: string;
  projectPath: string;
  identity: TiaLiveObjectIdentity;
  timeoutMs: number;
  includeCrossReferences: boolean;
  includeBlockXml: boolean;
  includeProgramBody: boolean;
  includeInterface: boolean;
  maxResults: number;
  maxXmlBytes: number;
  preparedSessionChecked?: boolean;
  portalMinimized?: boolean;
  refreshInventory?: boolean;
  retryNotFoundWithRefresh?: boolean;
}) {
  const deadline = Date.now() + args.timeoutMs;
  if (!args.preparedSessionChecked) {
    const prepared = await readPreparedLiveSession({
      processId: args.processId,
      timeoutMs: Math.min(args.timeoutMs, 5_000),
      expectedProjectPath: args.projectPath,
      expectedProcessStartTimeUtc: args.processStartTimeUtc
    });
    if (!prepared.ok) {
      const attached = await attachColdSession({ ...args, selectedProcess: { isMinimized: args.portalMinimized } },
        remainingTimeMs(deadline, "automatic Openness attach", 1_000));
      if (!attached.ok) throw new Error(attached.reason);
    }
  }
  const queryTimeoutMs = remainingTimeMs(deadline, "prepared resident live query", 1_000);
  const response = await queryTiaLiveCore({
    operation: "query_object",
    timeoutMs: queryTimeoutMs,
    processId: args.processId,
    processStartTimeUtc: args.processStartTimeUtc,
    projectPath: args.projectPath,
    identity: args.identity,
    includeCrossReferences: args.includeCrossReferences,
    includeBlockXml: args.includeBlockXml,
    includeProgramBody: args.includeProgramBody,
    includeInterface: args.includeInterface,
    refreshInventory: args.refreshInventory ?? false,
    retryNotFoundWithRefresh: args.retryNotFoundWithRefresh ?? true,
    maxResults: args.maxResults,
    maxXmlBytes: args.maxXmlBytes
  }, liveCoreOptions(queryTimeoutMs));
  assertLiveCoreSession(response, args.processId, args.projectPath, args.processStartTimeUtc);
  return response;
}

export async function refreshPreparedLiveInventory(args: {
  processId: number;
  processStartTimeUtc: string;
  projectPath: string;
  identity: TiaLiveObjectIdentity;
}): Promise<Record<string, JsonValue>> {
  try {
    const prepared = await readPreparedLiveSession({
      processId: args.processId,
      timeoutMs: 5_000,
      expectedProjectPath: args.projectPath,
      expectedProcessStartTimeUtc: args.processStartTimeUtc
    });
    if (!prepared.ok) {
      return {
        attempted: false,
        status: "not_needed_no_prepared_resident_session"
      };
    }
    const refreshed = await queryExactLiveObject({
      processId: args.processId,
      processStartTimeUtc: args.processStartTimeUtc,
      projectPath: args.projectPath,
      identity: args.identity,
      timeoutMs: 10_000,
      includeCrossReferences: false,
      includeBlockXml: false,
      includeProgramBody: false,
      includeInterface: false,
      maxResults: 1,
      maxXmlBytes: 100_000,
      preparedSessionChecked: true,
      refreshInventory: true,
      retryNotFoundWithRefresh: false
    });
    return {
      attempted: true,
      ok: refreshed.ok,
      status: refreshed.status,
      inventoryRefreshForced: refreshed.inventoryRefreshForced === true
    };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      status: "refresh_failed_non_fatal",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function attachExactLiveSession(args: {
  processId: number;
  processStartTimeUtc: string;
  projectPath: string;
  timeoutMs: number;
}) {
  const response = await queryTiaLiveCore({
    operation: "attach_session",
    timeoutMs: args.timeoutMs,
    processId: args.processId,
    processStartTimeUtc: args.processStartTimeUtc,
    projectPath: args.projectPath
  }, liveCoreOptions(args.timeoutMs));
  assertLiveCoreSession(response, args.processId, args.projectPath, args.processStartTimeUtc);
  return response;
}

export type LiveBatchQueryItem = TiaLiveObjectIdentity & {
  operationId: string;
};

export async function queryExactLiveBatch(args: {
  processId?: number;
  queries: LiveBatchQueryItem[];
  timeoutMs: number;
  maxNodes: number;
  maxDepth: number;
  includeCrossReferences: boolean;
  maxResultsPerQuery: number;
  refreshInventory?: boolean;
  includeProgramBody?: boolean;
  bodyEvidenceLimit?: number;
  maxXmlBytes?: number;
}): Promise<Record<string, JsonValue>> {
  const startedAt = Date.now();
  const deadline = startedAt + args.timeoutMs;
  const live = await resolvePreparedLiveQuerySession({
    processId: args.processId,
    timeoutMs: remainingTimeMs(deadline, "prepared live-session identity", 1_000),
    maxNodes: args.maxNodes,
    maxDepth: args.maxDepth
  });
  if (!live.ok) {
    return {
      ok: false,
      readOnly: true,
      status: live.status,
      reason: live.reason,
      queryCount: args.queries.length,
      completedCount: 0,
      failedCount: 0,
      skippedCount: args.queries.length,
      results: [],
      context: live.context as unknown as JsonValue
    };
  }

  const results: Array<Record<string, JsonValue>> = [];
  let completedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let reusedSessionCount = 0;
  let responseBytes = 0;
  const refreshedKinds = new Set<TiaLiveResourceKind>();

  for (let index = 0; index < args.queries.length; index += 1) {
    const query = args.queries[index];
    const { operationId, ...identity } = query;
    const remaining = deadline - Date.now();
    if (remaining < 1_000) {
      for (const skipped of args.queries.slice(index)) {
        results.push({
          operationId: skipped.operationId,
          ok: false,
          status: "skipped_timeout_budget_exhausted",
          object: skipped as unknown as JsonValue
        });
        skippedCount += 1;
      }
      break;
    }
    const itemStartedAt = Date.now();
    try {
      const forceKindRefresh = args.refreshInventory === true && !refreshedKinds.has(identity.resourceKind);
      const core = await queryExactLiveObject({
        processId: live.processId,
        processStartTimeUtc: live.processStartTimeUtc,
        projectPath: live.projectPath,
        identity,
        timeoutMs: Math.min(60_000, remaining),
        includeCrossReferences: args.includeCrossReferences,
        includeBlockXml: args.includeProgramBody === true && identity.resourceKind === "block",
        includeProgramBody: args.includeProgramBody === true && identity.resourceKind === "block",
        includeInterface: false,
        maxResults: args.maxResultsPerQuery,
        maxXmlBytes: args.maxXmlBytes ?? 2_000_000,
        preparedSessionChecked: true,
        refreshInventory: forceKindRefresh,
        retryNotFoundWithRefresh: !forceKindRefresh && !refreshedKinds.has(identity.resourceKind)
      });
      const session = objectRecord(core.session);
      if (session?.sessionReused === true) reusedSessionCount += 1;
      if (
        core.inventoryRefreshForced === true
        || core.inventoryRefreshedAfterMiss === true
      ) {
        refreshedKinds.add(identity.resourceKind);
      }
      const temporaryBlockEvidence = core.ok && args.includeProgramBody && identity.resourceKind === "block"
        ? parseLiveBlockXml(core, args.maxXmlBytes ?? 2_000_000, 1, args.bodyEvidenceLimit ?? 200, false, true, false) : null;
      const completeness = mergeLiveCompleteness(core, {
        temporaryBlockEvidence: temporaryBlockEvidence as JsonValue,
        includeInterface: false, includeProgramBody: args.includeProgramBody === true && identity.resourceKind === "block"
      });
      const item = {
        operationId,
        ok: core.ok,
        status: core.status,
        elapsedMs: Date.now() - itemStartedAt,
        object: identity as unknown as JsonValue,
        directLive: withoutBlockXmlPayload(core) as unknown as JsonValue,
        temporaryBlockEvidence: temporaryBlockEvidence as JsonValue,
        completeness
      };
      const itemBytes = Buffer.byteLength(JSON.stringify(item));
      if (responseBytes + itemBytes > 8_000_000) {
        for (const skipped of args.queries.slice(index)) {
          results.push({ operationId: skipped.operationId, ok: false, status: "skipped_response_budget_exhausted", object: skipped as unknown as JsonValue });
          skippedCount += 1;
        }
        break;
      }
      responseBytes += itemBytes;
      results.push(item);
      if (core.ok && completeness.requestedActionCompleted) completedCount += 1;
      else failedCount += 1;
    } catch (error) {
      failedCount += 1;
      results.push({
        operationId,
        ok: false,
        status: "live_query_error",
        elapsedMs: Date.now() - itemStartedAt,
        object: identity as unknown as JsonValue,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const requestedActionCompleted = failedCount === 0 && skippedCount === 0;
  return {
    ok: requestedActionCompleted,
    readOnly: true,
    status: requestedActionCompleted ? "completed" : "partial",
    requestedActionCompleted,
    exactLiveIdentity: {
      processId: live.processId,
      processStartTimeUtc: live.processStartTimeUtc,
      projectPath: live.projectPath
    },
    queryCount: args.queries.length,
    completedCount,
    failedCount,
    skippedCount,
    reusedSessionCount,
    refreshedResourceKinds: [...refreshedKinds],
    elapsedMs: Date.now() - startedAt,
    results,
    provenance: {
      identitySource: live.identitySource,
      currentUiContextReads: live.context ? 1 : 0,
      residentCore: true,
      requestsSerialized: true,
      exactIdentityRevalidatedPerItem: true,
      temporaryXmlExports: args.includeProgramBody === true,
      projectMutation: false,
      plcAccessed: false
    }
  };
}
