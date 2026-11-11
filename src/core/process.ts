import { spawn } from "node:child_process";

import { workspaceRoot } from "./local-paths.js";

export const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_PROCESS_OUTPUT_CHARS = 32_000_000;
const MAX_PROCESS_STDERR_CHARS = 64_000;

export type ProcessTimeoutMode = "direct" | "tree-force";

export async function runPowerShell(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS, timeoutMode: ProcessTimeoutMode = "direct") {
  return runProcess("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", ...args], timeoutMs, timeoutMode);
}

export async function runProcess(command: string, args: string[], timeoutMs = DEFAULT_TIMEOUT_MS, timeoutMode: ProcessTimeoutMode = "direct") {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: workspaceRoot,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const stopChild = () => {
      if (timeoutMode === "tree-force") {
        killProcessTree(child.pid);
      } else {
        child.kill();
      }
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      stopChild();
      fail(new Error(`Command timed out after ${timeoutMs} ms: ${command}`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    // Bound memory without killing the child: some callers (the importer) write
    // to TIA, and an output limit must not interrupt them. Excess output is
    // dropped; a truncated JSON result then fails the caller's parse.
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < MAX_PROCESS_OUTPUT_CHARS) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      // Keep the head: callers report the first error lines.
      if (stderr.length < MAX_PROCESS_STDERR_CHARS) stderr += chunk;
    });
    child.on("error", (error) => {
      fail(error);
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

export function killProcessTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    killer.on("error", () => undefined);
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process may have already exited.
  }
}
