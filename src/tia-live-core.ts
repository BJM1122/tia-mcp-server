import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const PROTOCOL_VERSION = 1;
const DEFAULT_IDLE_TIMEOUT_MS = 3_600_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 8_000;
const MIN_REQUEST_TIMEOUT_MS = 1_000;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
const MIN_IDLE_TIMEOUT_MS = 30_000;
const MAX_IDLE_TIMEOUT_MS = 86_400_000;
const MAX_RESPONSE_BYTES = 40_000_000;
const ALREADY_RUNNING_EXIT_CODE = 17;
const MAX_STDERR_LOG_BYTES = 1_000_000;
// The core keeps a second listening instance, but a missing pipe can still be
// seen briefly (e.g. when an abandoned instance is replaced); retry before
// concluding that no core is running.
const UNAVAILABLE_RETRY_DELAYS_MS = [25, 75];
const startupFlights = new Map<string, Promise<void>>();
const binaryFingerprintCache = new Map<string, {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  sha256: string;
}>();

export type TiaLiveResourceKind = "block" | "plc_type" | "tag_table" | "plc_tag";

export interface TiaLiveObjectIdentity {
  resourceKind: TiaLiveResourceKind;
  name: string;
  blockKind?: string;
  number?: string;
  tagTableName?: string;
  namespace?: string;
  softwarePath?: string;
  officialIdentifier?: string;
}

export interface TiaLiveCoreRequest {
  operation: "verify_session" | "export_blocks_for_signature" | "ping" | "attach_session" | "query_object" | "search_objects" | "read_engineering" | "list_hmi_targets" | "read_hmi" | "navigate_object" | "shutdown";
  targets?: Array<{ kind: string; name: string; number: string }>;
  resourceKind?: TiaLiveResourceKind;
  query?: string;
  softwarePath?: string;
  blockKind?: string;
  number?: string;
  offset?: number;
  hmiName?: string;
  hmiPath?: string;
  hmiSections?: string;
  includeScreens?: boolean;
  maxObjects?: number;
  timeoutMs?: number;
  // Absolute client deadline (Unix ms); the core skips a request still queued past it.
  deadlineUnixMs?: number;
  processId?: number;
  processStartTimeUtc?: string;
  projectPath?: string;
  identity?: TiaLiveObjectIdentity;
  includeCrossReferences?: boolean;
  includeBlockXml?: boolean;
  includeProgramBody?: boolean;
  includeInterface?: boolean;
  refreshInventory?: boolean;
  retryNotFoundWithRefresh?: boolean;
  maxResults?: number;
  maxXmlBytes?: number;
  confirmNavigation?: boolean;
}

export interface TiaLiveCoreResponse {
  protocolVersion: number;
  requestId: string;
  ok: boolean;
  status: string;
  error?: string;
  [key: string]: unknown;
}

export interface TiaLiveCoreClientOptions {
  coreExe: string;
  apiDll: string;
  timeoutMs: number;
  idleTimeoutMs?: number;
  startupTimeoutMs?: number;
  existingOnly?: boolean;
  maxResponseBytes?: number;
}

function liveCoreBinaryFingerprint(coreExe: string): string {
  const resolved = path.resolve(coreExe);
  try {
    const fileStat = statSync(resolved);
    const cached = binaryFingerprintCache.get(resolved);
    if (
      cached
      && cached.mtimeMs === fileStat.mtimeMs
      && cached.ctimeMs === fileStat.ctimeMs
      && cached.size === fileStat.size
    ) {
      return cached.sha256;
    }
    const sha256 = createHash("sha256").update(readFileSync(resolved)).digest("hex");
    binaryFingerprintCache.set(resolved, {
      mtimeMs: fileStat.mtimeMs,
      ctimeMs: fileStat.ctimeMs,
      size: fileStat.size,
      sha256
    });
    return sha256;
  } catch {
    return createHash("sha256").update(`missing:${resolved.toLowerCase()}`).digest("hex");
  }
}

export function liveCorePipeName(coreExe: string, apiDll?: string): string {
  const user = (os.userInfo().username || "user").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 48);
  const binaryFingerprint = liveCoreBinaryFingerprint(coreExe);
  const scopeHash = createHash("sha256")
    .update(path.resolve(coreExe).toLowerCase())
    .update("\0")
    .update(binaryFingerprint);
  if (apiDll?.trim()) {
    scopeHash
      .update("\0")
      .update(path.resolve(apiDll).toLowerCase())
      .update("\0")
      .update(liveCoreBinaryFingerprint(apiDll));
  } else {
    scopeHash.update("\0api-unspecified");
  }
  const scope = scopeHash.digest("hex").slice(0, 12);
  return `tia-mcp-live-read-v1-${user}-${scope}`;
}

export function liveCorePipePath(pipeName: string): string {
  return `\\\\.\\pipe\\${pipeName}`;
}

function isUnavailableError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED" || code === "EPIPE";
}

async function sendPipeRequest(
  pipePath: string,
  request: TiaLiveCoreRequest & { protocolVersion: number; requestId: string },
  expectedRequestId: string,
  timeoutMs: number,
  maxResponseBytes: number
): Promise<TiaLiveCoreResponse> {
  return new Promise<TiaLiveCoreResponse>((resolve, reject) => {
    const socket = net.createConnection(pipePath);
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    // Absolute deadline: an idle socket timeout would restart on every chunk.
    const timer = setTimeout(
      () => finishError(new Error(`TIA live core request timed out after ${timeoutMs} ms.`)),
      timeoutMs
    );

    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };

    socket.once("connect", () => {
      socket.write(JSON.stringify(request) + "\n", "utf8");
    });
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      const newline = chunk.indexOf(0x0a);
      const payloadChunk = newline >= 0 ? chunk.subarray(0, newline) : chunk;
      received += payloadChunk.length;
      if (received > maxResponseBytes) {
        finishError(new Error(`TIA live core response exceeded ${maxResponseBytes} bytes.`));
        return;
      }
      chunks.push(payloadChunk);
      if (newline < 0) return;
      settled = true;
      clearTimeout(timer);
      socket.end();
      try {
        const buffer = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, received);
        const parsed = JSON.parse(buffer.toString("utf8")) as TiaLiveCoreResponse;
        if (!parsed || typeof parsed !== "object" || typeof parsed.ok !== "boolean" || typeof parsed.status !== "string") {
          throw new Error("TIA live core returned an invalid response envelope.");
        }
        if (parsed.protocolVersion !== PROTOCOL_VERSION) {
          throw new Error(`TIA live core protocol mismatch: expected ${PROTOCOL_VERSION}, received ${String(parsed.protocolVersion)}.`);
        }
        if (parsed.requestId !== expectedRequestId) {
          throw new Error("TIA live core response requestId did not match the request.");
        }
        resolve(parsed);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", finishError);
    socket.once("end", () => {
      if (!settled) finishError(new Error("TIA live core closed the pipe before returning a complete response."));
    });
  });
}

interface LiveCoreLaunch {
  stderrLogPath: string | null;
  stderrLogStartOffset: number;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
}

function openLiveCoreStderrLog(pipeName: string): { fd: number | "ignore"; logPath: string | null; startOffset: number } {
  try {
    const directory = path.join(os.tmpdir(), "tia-mcp-live-core");
    mkdirSync(directory, { recursive: true });
    const logPath = path.join(directory, `${pipeName}.stderr.log`);
    // Append so a relaunch keeps a crashed core's output and does not truncate
    // a log a running core still writes; start over once it grows large.
    let flags = "a";
    let startOffset = 0;
    try {
      startOffset = statSync(logPath).size;
      if (startOffset > MAX_STDERR_LOG_BYTES) {
        flags = "w";
        startOffset = 0;
      }
    } catch {
      // No log yet.
    }
    return { fd: openSync(logPath, flags), logPath, startOffset };
  } catch {
    return { fd: "ignore", logPath: null, startOffset: 0 };
  }
}

// Reads only what this launch appended, so an older core's error is not
// reported as the current failure.
function readLogTail(logPath: string | null, startOffset: number, maxChars = 600): string {
  if (!logPath) return "";
  try {
    const text = readFileSync(logPath).subarray(startOffset).toString("utf8").trim();
    return text.length > maxChars ? text.slice(-maxChars) : text;
  } catch {
    return "";
  }
}

async function startLiveCore(pipeName: string, options: TiaLiveCoreClientOptions): Promise<LiveCoreLaunch> {
  const idleTimeoutMs = Math.min(
    MAX_IDLE_TIMEOUT_MS,
    Math.max(MIN_IDLE_TIMEOUT_MS, options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS)
  );
  const stderrLog = openLiveCoreStderrLog(pipeName);
  const launch: LiveCoreLaunch = {
    stderrLogPath: stderrLog.logPath,
    stderrLogStartOffset: stderrLog.startOffset,
    exit: null
  };
  try {
    await new Promise<void>((resolve, reject) => {
      let child;
      try {
        child = spawn(options.coreExe, [
          "--serve",
          "--pipe",
          pipeName,
          "--api",
          options.apiDll,
          "--idle-timeout",
          String(idleTimeoutMs)
        ], {
          detached: true,
          windowsHide: true,
          stdio: ["ignore", "ignore", stderrLog.fd]
        });
      } catch (error) {
        reject(new Error(`TIA live core launch failed: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      // Observed only while this client is waiting for startup; unref keeps the
      // resident core independent of this MCP process.
      child.once("exit", (code, signal) => {
        launch.exit = { code, signal };
      });
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
      child.once("error", (error) => {
        reject(new Error(`TIA live core launch failed: ${error.message}`));
      });
    });
  } finally {
    if (typeof stderrLog.fd === "number") {
      try { closeSync(stderrLog.fd); } catch { /* already closed */ }
    }
  }
  return launch;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function startOrJoinLiveCore(
  pipeName: string,
  pipePath: string,
  options: TiaLiveCoreClientOptions,
  startupTimeoutMs: number,
  maxResponseBytes: number
): Promise<void> {
  const existing = startupFlights.get(pipeName);
  if (existing) return existing;

  const flight = (async () => {
    const launch = await startLiveCore(pipeName, options);
    const startupDeadline = Date.now() + startupTimeoutMs;
    let lastError: unknown = null;
    while (Date.now() < startupDeadline) {
      await delay(Math.min(100, Math.max(1, startupDeadline - Date.now())));
      // Exit code 17 means another resident core already owns this pipe; keep
      // pinging it. Any other early exit is a launch failure: report it now
      // instead of waiting out the whole startup budget.
      if (launch.exit && launch.exit.code !== ALREADY_RUNNING_EXIT_CODE) {
        const tail = readLogTail(launch.stderrLogPath, launch.stderrLogStartOffset);
        throw new Error(
          `TIA live core exited during startup (exit ${launch.exit.code ?? launch.exit.signal ?? "unknown"}).` +
          (tail ? ` stderr: ${tail}` : "") +
          (launch.stderrLogPath ? ` Log: ${launch.stderrLogPath}` : "")
        );
      }
      const remaining = startupDeadline - Date.now();
      if (remaining <= 0) break;
      const requestId = randomUUID();
      try {
        const response = await sendPipeRequest(
          pipePath,
          {
            operation: "ping",
            protocolVersion: PROTOCOL_VERSION,
            requestId,
            timeoutMs: Math.max(MIN_REQUEST_TIMEOUT_MS, remaining),
            deadlineUnixMs: Date.now() + remaining
          },
          requestId,
          remaining,
          maxResponseBytes
        );
        if (response.ok) return;
        lastError = new Error(`TIA live core startup ping returned ${response.status}.`);
      } catch (error) {
        lastError = error;
        if (!isUnavailableError(error)) throw error;
      }
    }
    throw new Error(
      `TIA live core did not become available within ${startupTimeoutMs} ms.` +
      (lastError instanceof Error ? ` Last error: ${lastError.message}` : "")
    );
  })();
  startupFlights.set(pipeName, flight);
  void flight.finally(() => {
    if (startupFlights.get(pipeName) === flight) startupFlights.delete(pipeName);
  }).catch(() => undefined);
  return flight;
}

async function awaitWithinDeadline(promise: Promise<void>, deadline: number): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("TIA live core request deadline expired during startup.");
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`TIA live core startup exceeded the request deadline after ${remaining} ms.`)),
          remaining
        );
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function queryTiaLiveCore(
  request: TiaLiveCoreRequest,
  options: TiaLiveCoreClientOptions
): Promise<TiaLiveCoreResponse> {
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < MIN_REQUEST_TIMEOUT_MS || options.timeoutMs > MAX_REQUEST_TIMEOUT_MS) {
    throw new Error(`TIA live core timeoutMs must be an integer from ${MIN_REQUEST_TIMEOUT_MS} through ${MAX_REQUEST_TIMEOUT_MS}.`);
  }
  const timeoutMs = options.timeoutMs;
  const requestedTimeoutMs = request.timeoutMs ?? timeoutMs;
  if (!Number.isInteger(requestedTimeoutMs) || requestedTimeoutMs < MIN_REQUEST_TIMEOUT_MS || requestedTimeoutMs > timeoutMs) {
    throw new Error(`TIA live core request timeoutMs must be an integer from ${MIN_REQUEST_TIMEOUT_MS} through the client deadline ${timeoutMs}.`);
  }
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const pipeName = liveCorePipeName(options.coreExe, options.apiDll);
  const pipePath = liveCorePipePath(pipeName);
  const deadline = Date.now() + timeoutMs;
  const requestId = randomUUID();
  const wireRequest = {
    ...request,
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    timeoutMs: requestedTimeoutMs,
    deadlineUnixMs: deadline
  };

  for (let attempt = 0; ; attempt++) {
    try {
      return await sendPipeRequest(
        pipePath,
        wireRequest,
        requestId,
        Math.max(1, deadline - Date.now()),
        maxResponseBytes
      );
    } catch (error) {
      if (options.existingOnly || !isUnavailableError(error)) throw error;
    }
    const retryDelayMs = UNAVAILABLE_RETRY_DELAYS_MS[attempt];
    if (retryDelayMs === undefined || deadline - Date.now() <= retryDelayMs) break;
    await delay(retryDelayMs);
  }

  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const boundedStartupTimeoutMs = Math.min(timeoutMs, startupTimeoutMs);
  await awaitWithinDeadline(
    startOrJoinLiveCore(
      pipeName,
      pipePath,
      options,
      boundedStartupTimeoutMs,
      maxResponseBytes
    ),
    deadline
  );
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("TIA live core request deadline expired after startup.");
  return sendPipeRequest(pipePath, wireRequest, requestId, remaining, maxResponseBytes);
}
