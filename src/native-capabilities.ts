import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";

import { paths, serverRoot, sha256File } from "./core/local-paths.js";
import { runProcess } from "./core/process.js";
import {
  apiAssemblyMatches, componentExe, componentExeName, componentsForVersion, componentSources, installedVersions,
  PORTAL_CAPABILITIES, portalVersion, resolveApiDll, type NativeComponent, type PortalCapability, type PortalVersionId
} from "./tia-version.js";

// Capabilities from evidence. A version row's capabilities are only the upper
// bound; a capability is verified when a companion built for that version is
// present, not older than its sources, and passes its offline self-test
// (no project, no PLC) reporting that target version and that capability.

const SELF_TEST_TIMEOUT_MS = 15_000;

// Newest input of every companion build: the shared C# file, the version table
// that becomes TiaBuildTarget, and the build script (flags and references).
export async function nativeCommonMtimeMs(): Promise<number> {
  const inputs = [paths.nativeCommonSource, paths.portalVersions, paths.nativeBuildScript].filter(file => existsSync(file));
  return Math.max(0, ...(await Promise.all(inputs.map(async file => (await stat(file)).mtimeMs))));
}

export type ComponentStatus = "verified" | "missing" | "stale" | "api_unavailable" | "self_test_failed";

export interface ComponentProbe {
  component: string;
  portalVersion: PortalVersionId;
  exe: string;
  status: ComponentStatus;
  capabilities: PortalCapability[];
  reason: string;
}

export interface VersionCapabilities {
  id: PortalVersionId;
  declared: PortalCapability[];
  verified: PortalCapability[];
  unverified: Array<{ capability: PortalCapability; reason: string }>;
  // Reported by a passing companion but not allowed by the version row; never enabled.
  undeclaredReported: PortalCapability[];
  components: ComponentProbe[];
}

// Judge one self-test run. The last non-empty stdout line is the JSON result.
export function evaluateSelfTest(version: PortalVersionId, exitCode: number | null, stdout: string):
  { ok: true; capabilities: PortalCapability[] } | { ok: false; reason: string } {
  const line = stdout.replace(/^﻿/, "").split(/\r?\n/).map(text => text.trim()).filter(Boolean).at(-1) ?? "";
  let parsed: Record<string, any> | null = null;
  try { parsed = JSON.parse(line); } catch { /* reported below */ }
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "Self-test output is not a JSON object." };
  if (exitCode !== 0 || parsed.ok !== true) return { ok: false, reason: `Self-test failed (exit ${exitCode}): ${String(parsed.error ?? parsed.status ?? "")}`.trim() };
  if (parsed.status !== undefined && parsed.status !== "self_test_passed") return { ok: false, reason: `Unexpected self-test status: ${String(parsed.status)}` };
  const target = parsed.target;
  if (!target || target.portalVersion !== version) {
    return { ok: false, reason: `Companion targets ${String(target?.portalVersion ?? "no version")}, not ${version}; rebuild it for ${version}.` };
  }
  if (!apiAssemblyMatches(version, String(target.apiAssembly ?? ""))) return { ok: false, reason: `Companion API assembly ${String(target.apiAssembly)} is not ${version}'s.` };
  // Compiled with exactly the row's API features: no fallback hidden by a stale or hand-made build.
  const expected = [...portalVersion(version).apiFeatures].sort();
  const compiled = Array.isArray(target.apiFeatures) ? [...target.apiFeatures].map(String).sort() : null;
  if (!compiled || compiled.join(",") !== expected.join(",")) {
    return { ok: false, reason: `Companion was built with API features [${compiled?.join(", ") ?? "unknown"}], but ${version} lists [${expected.join(", ")}]; rebuild it.` };
  }
  const reported = parsed.capabilities;
  if (!Array.isArray(reported) || reported.length === 0 || !reported.every(item => PORTAL_CAPABILITIES.includes(item))) {
    return { ok: false, reason: "Self-test reports no capabilities or an unknown one." };
  }
  return { ok: true, capabilities: [...new Set(reported as PortalCapability[])] };
}

// Keyed by executable and API identity (path, mtime, size): a rebuilt companion
// or a different DLL runs the self-test again. The executable is identified by
// its SHA-256 (copies keep mtime and two builds can share a size); the DLL, which
// is large and installed, by path, mtime, ctime and size. Only passes are cached:
// a failure or timeout (e.g. a scanner holding a fresh build) is retried next time.
const probeCache = new Map<string, Promise<ComponentProbe>>();

export async function probeComponent(component: NativeComponent, version: PortalVersionId): Promise<ComponentProbe> {
  const exe = componentExe(component.id, version, serverRoot);
  const base = { component: component.id, portalVersion: version, exe, capabilities: [] as PortalCapability[] };
  if (!existsSync(exe)) {
    const fix = component.exeEnv && process.env[component.exeEnv]?.trim()
      ? `check ${component.exeEnv}`
      : `build it with npm run build:native -- -Component ${component.id} -Version ${version}`;
    return { ...base, status: "missing", reason: `${exe} was not found; ${fix}.` };
  }
  const api = resolveApiDll(version);
  if (!api) return { ...base, status: "api_unavailable", reason: `Siemens.Engineering.dll for ${version} was not found.` };
  const inputs = componentSources(component.id, serverRoot).filter(file => existsSync(file));
  const [exeStat, apiStat, inputsMtime, commonMtime] = await Promise.all([
    stat(exe), stat(api.dllPath),
    Promise.all(inputs.map(async file => (await stat(file)).mtimeMs)).then(times => Math.max(0, ...times)),
    nativeCommonMtimeMs()
  ]);
  if (Math.max(inputsMtime, commonMtime) > exeStat.mtimeMs) {
    return { ...base, status: "stale", reason: `${componentExeName(component.id, version)} is older than its sources; rebuild it.` };
  }
  let exeSha256: string;
  try { exeSha256 = await sha256File(exe); }
  catch (error) { return { ...base, status: "self_test_failed", reason: error instanceof Error ? error.message : String(error) }; }
  const key = [component.id, version, exe, exeSha256, api.dllPath, apiStat.mtimeMs, apiStat.ctimeMs, apiStat.size].join("|");
  let probe = probeCache.get(key);
  if (!probe) {
    probe = (async (): Promise<ComponentProbe> => {
      try {
        const args = component.selfTestArgs.map(arg => arg === "{api}" ? api.dllPath : arg);
        const result = await runProcess(exe, args, SELF_TEST_TIMEOUT_MS, "tree-force");
        const judged = evaluateSelfTest(version, result.exitCode, result.stdout);
        return judged.ok
          ? { ...base, status: "verified", capabilities: judged.capabilities, reason: "" }
          : { ...base, status: "self_test_failed", reason: judged.reason };
      } catch (error) {
        return { ...base, status: "self_test_failed", reason: error instanceof Error ? error.message : String(error) };
      }
    })();
    probeCache.set(key, probe);
    // Concurrent callers share the run; a failure is dropped once it settles.
    void probe.then(result => { if (result.status !== "verified" && probeCache.get(key) === probe) probeCache.delete(key); });
  }
  return probe;
}

export async function versionCapabilities(version: PortalVersionId): Promise<VersionCapabilities> {
  const profile = portalVersion(version);
  const declared = profile.adapter ? [...profile.capabilities] : [];
  const components = await Promise.all(componentsForVersion(version).map(component => probeComponent(component, version)));
  const reported = new Set(components.filter(probe => probe.status === "verified").flatMap(probe => probe.capabilities));
  const verified: PortalCapability[] = [];
  const unverified: VersionCapabilities["unverified"] = [];
  for (const capability of declared) {
    // Passive UI context is the server's own PowerShell reader, not a native companion.
    if (capability === "passive_ui_context") {
      if (existsSync(paths.uiContextScript)) verified.push(capability);
      else unverified.push({ capability, reason: `UI context script not found: ${paths.uiContextScript}` });
    } else if (reported.has(capability)) {
      verified.push(capability);
    } else {
      const reasons = components.filter(probe => probe.status !== "verified").map(probe => `${probe.component}: ${probe.reason}`);
      unverified.push({ capability, reason: reasons.join(" ") || "No companion built for this version reports it." });
    }
  }
  const undeclaredReported = [...reported].filter(capability => !declared.includes(capability));
  return { id: version, declared, verified, unverified, undeclaredReported, components };
}

// Every recognized version: installation, the table's upper bound and the
// self-test evidence. Versions without an adapter run no companion.
export async function portalVersionReport() {
  return Promise.all(installedVersions().map(async installed => {
    if (!installed.adapter) return { ...installed, capabilities: [], unverifiedCapabilities: [], undeclaredReported: [], components: [] };
    const evidence = await versionCapabilities(installed.id);
    return {
      ...installed, capabilities: evidence.verified, unverifiedCapabilities: evidence.unverified,
      undeclaredReported: evidence.undeclaredReported, components: evidence.components
    };
  }));
}

export function summarizePortalReadiness(versions: Awaited<ReturnType<typeof portalVersionReport>>) {
  // An absent API is not a broken installation of that version.
  const installed = versions.filter(version => version.apiDll && version.adapter);
  const unavailableCapabilities = installed.flatMap(version =>
    version.unverifiedCapabilities.map(item => ({ portalVersion: version.id, ...item })));
  const status: "ready" | "degraded" | "unavailable" = unavailableCapabilities.length
    ? "degraded" : installed.length ? "ready" : "unavailable";
  return { status, unavailableCapabilities };
}

// Candidate order for a capability: the component built for it (its
// buildCapability) first, then the others in table order. So enabling a broader
// companion for a version never silently replaces a dedicated one; switching
// providers is an explicit table change.
export function providerOrder(components: readonly NativeComponent[], capability: PortalCapability): NativeComponent[] {
  return [...components.filter(c => c.buildCapability === capability), ...components.filter(c => c.buildCapability !== capability)];
}

// The companion that will serve a capability for a version: the first in
// providerOrder whose self-test passed and reported it. Probing stops at that
// one, so a launch does not self-test unrelated companions.
export async function verifiedProvider(version: PortalVersionId, capability: PortalCapability):
  Promise<{ ok: true; component: string; exe: string } | { ok: false; reason: string; components: ComponentProbe[] }> {
  const profile = portalVersion(version);
  if (!profile.adapter || !profile.capabilities.includes(capability)) {
    return { ok: false, reason: `TIA Portal ${version} does not allow ${capability}.`, components: [] };
  }
  const components: ComponentProbe[] = [];
  for (const component of providerOrder(componentsForVersion(version), capability)) {
    const probe = await probeComponent(component, version);
    if (probe.status === "verified" && probe.capabilities.includes(capability)) return { ok: true, component: probe.component, exe: probe.exe };
    components.push(probe);
  }
  const reasons = components.filter(probe => probe.status !== "verified").map(probe => `${probe.component}: ${probe.reason}`);
  return { ok: false, reason: `No verified ${version} companion provides ${capability}. ${reasons.join(" ")}`.trim(), components };
}
