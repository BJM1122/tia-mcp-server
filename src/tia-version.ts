import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// TIA Portal versions come from portal-versions.json, shared with the native
// build (tools/Build-TiaNative.ps1). Adding a version means adding one row
// there and building its native adapter; tools ask for capabilities and never
// compare version strings. A project is always handled by the exact version
// that matches its extension: there is no cross-version fallback.

export type PortalVersionId = string;

// Native companion family that implements a version. null = recognized but not
// built or verified yet, so every capability is unavailable.
export type NativeAdapter = "live-core" | "v15-snapshot";

export type PortalCapability =
  | "passive_ui_context"
  | "snapshot_export"
  | "live_query"
  | "navigation"
  | "engineering_inspect"
  | "block_import"
  | "hmi_export"
  | "hmi_authoring";

export interface PortalVersionProfile {
  readonly id: PortalVersionId;
  readonly projectExtension: string;
  readonly registryKey: string;
  readonly apiFolder: string;
  readonly apiAssembly: { readonly major: number; readonly minor: number };
  readonly apiDllEnv: string;
  readonly legacyApiDllEnv?: string;
  readonly installRoots: readonly string[];
  // Public API features this version has (see apiFeatureNames); compiled in as TIA_API_<NAME>.
  readonly apiFeatures: readonly string[];
  readonly adapter: NativeAdapter | null;
  readonly capabilities: readonly PortalCapability[];
}

const ADAPTERS: readonly NativeAdapter[] = ["live-core", "v15-snapshot"];
export const PORTAL_CAPABILITIES: readonly PortalCapability[] = [
  "passive_ui_context", "snapshot_export", "live_query", "navigation",
  "engineering_inspect", "block_import", "hmi_export", "hmi_authoring"
];
const CAPABILITIES = PORTAL_CAPABILITIES;

// Validate the shared file strictly: a malformed row must stop the server
// rather than silently disable or widen a version.
export function parsePortalVersions(text: string): {
  defaultVersion: PortalVersionId; apiFeatureNames: string[]; versions: PortalVersionProfile[]; components: NativeComponent[];
} {
  const data = JSON.parse(text) as { defaultVersion?: unknown; versions?: unknown; apiFeatureNames?: unknown };
  if (!Array.isArray(data.versions) || typeof data.defaultVersion !== "string") throw new Error("portal-versions.json: expected defaultVersion and versions.");
  // A declared vocabulary, so a misspelt feature cannot silently compile a fallback.
  const featureNames = data.apiFeatureNames;
  if (!Array.isArray(featureNames) || !featureNames.every(name => typeof name === "string" && /^[a-z][a-z0-9_]*$/.test(name))
    || new Set(featureNames).size !== featureNames.length) throw new Error("portal-versions.json: expected unique snake_case apiFeatureNames.");
  const fail = (index: number, field: string): never => { throw new Error(`portal-versions.json: version ${index} has an invalid ${field}.`); };
  const isText = (value: unknown) => typeof value === "string" && value.length > 0;
  const versions = data.versions.map((row: Record<string, any>, index: number): PortalVersionProfile => {
    if (!/^V\d+(\.\d+)?$/.test(String(row.id))) fail(index, "id");
    if (!/^\.ap\d+(_\d+)?$/.test(String(row.projectExtension))) fail(index, "projectExtension");
    if (!/^TIAP\d+(_\d+)?$/.test(String(row.registryKey))) fail(index, "registryKey");
    if (!isText(row.apiFolder) || !isText(row.apiDllEnv)) fail(index, "apiFolder/apiDllEnv");
    if (row.legacyApiDllEnv !== undefined && !isText(row.legacyApiDllEnv)) fail(index, "legacyApiDllEnv");
    if (!Number.isInteger(row.apiAssembly?.major) || !Number.isInteger(row.apiAssembly?.minor)) fail(index, "apiAssembly");
    if (!Array.isArray(row.installRoots) || !row.installRoots.every(isText)) fail(index, "installRoots");
    if (!Array.isArray(row.apiFeatures) || !row.apiFeatures.every((f: unknown) => featureNames.includes(f))
      || new Set(row.apiFeatures).size !== row.apiFeatures.length) fail(index, "apiFeatures");
    if (row.adapter !== null && !ADAPTERS.includes(row.adapter)) fail(index, "adapter");
    if (!Array.isArray(row.capabilities) || !row.capabilities.every((c: unknown) => CAPABILITIES.includes(c as PortalCapability))) fail(index, "capabilities");
    if ((row.adapter === null) !== (row.capabilities.length === 0)) fail(index, "adapter/capabilities pairing");
    return {
      id: row.id, projectExtension: row.projectExtension.toLowerCase(), registryKey: row.registryKey, apiFolder: row.apiFolder,
      apiAssembly: { major: row.apiAssembly.major, minor: row.apiAssembly.minor }, apiDllEnv: row.apiDllEnv,
      ...(row.legacyApiDllEnv ? { legacyApiDllEnv: row.legacyApiDllEnv } : {}),
      installRoots: [...row.installRoots], apiFeatures: [...row.apiFeatures], adapter: row.adapter, capabilities: [...row.capabilities]
    };
  });
  for (const key of ["id", "projectExtension", "registryKey", "apiDllEnv"] as const) {
    if (new Set(versions.map(v => v[key])).size !== versions.length) throw new Error(`portal-versions.json: duplicate ${key}.`);
  }
  if (!versions.some(v => v.id === data.defaultVersion && v.adapter)) throw new Error("portal-versions.json: defaultVersion must have an adapter.");
  return {
    defaultVersion: data.defaultVersion, apiFeatureNames: [...featureNames], versions,
    components: parseComponents((data as { components?: unknown }).components)
  };
}

// A native companion program. Built per version by tools/Build-TiaNative.ps1;
// its self-test reports the version it targets and the capabilities it implements.
export interface NativeComponent {
  readonly id: string;
  // Adapter families whose versions may get a build of this component. A shared
  // single-purpose companion (the importer) can serve several families.
  readonly adapters: readonly NativeAdapter[];
  // The version row must allow this capability before the component may be built for it.
  readonly buildCapability: PortalCapability;
  readonly baseName: string;
  // Relative to the package root.
  readonly outputDir: string;
  readonly sources: readonly string[];
  // "{api}" is replaced by the version's Siemens.Engineering.dll.
  readonly selfTestArgs: readonly string[];
  // Overrides the executable of the component's home version only.
  readonly exeEnv?: string;
}

function parseComponents(value: unknown): NativeComponent[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("portal-versions.json: expected components.");
  const fail = (index: number, field: string): never => { throw new Error(`portal-versions.json: component ${index} has an invalid ${field}.`); };
  const relative = (item: unknown) => typeof item === "string" && item.length > 0 && !path.win32.isAbsolute(item) && !path.posix.isAbsolute(item);
  const components = value.map((row: Record<string, any>, index: number): NativeComponent => {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(String(row.id))) fail(index, "id");
    if (!Array.isArray(row.adapters) || row.adapters.length === 0 || !row.adapters.every((a: unknown) => ADAPTERS.includes(a as NativeAdapter))
      || new Set(row.adapters).size !== row.adapters.length) fail(index, "adapters");
    if (!CAPABILITIES.includes(row.buildCapability)) fail(index, "buildCapability");
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(String(row.baseName))) fail(index, "baseName");
    if (!relative(row.outputDir)) fail(index, "outputDir");
    if (!Array.isArray(row.sources) || row.sources.length === 0 || !row.sources.every(relative)) fail(index, "sources");
    if (!Array.isArray(row.selfTestArgs) || !row.selfTestArgs.every((a: unknown) => typeof a === "string" && a.length > 0)
      || row.selfTestArgs.filter((a: string) => a === "{api}").length !== 1) fail(index, "selfTestArgs");
    if (row.exeEnv !== undefined && !/^[A-Z][A-Z0-9_]*$/.test(String(row.exeEnv))) fail(index, "exeEnv");
    return {
      id: row.id, adapters: [...row.adapters], buildCapability: row.buildCapability, baseName: row.baseName, outputDir: row.outputDir,
      sources: [...row.sources], selfTestArgs: [...row.selfTestArgs], ...(row.exeEnv ? { exeEnv: row.exeEnv } : {})
    };
  });
  for (const key of ["id", "baseName"] as const) {
    if (new Set(components.map(c => c[key])).size !== components.length) throw new Error(`portal-versions.json: duplicate component ${key}.`);
  }
  return components;
}

// src/ and dist/ are both one level below the package root that holds the file.
const table = parsePortalVersions(readFileSync(new URL("../portal-versions.json", import.meta.url), "utf8"));
export const PORTAL_VERSIONS: readonly PortalVersionProfile[] = table.versions;
export const DEFAULT_PORTAL_VERSION: PortalVersionId = table.defaultVersion;
export const NATIVE_COMPONENTS: readonly NativeComponent[] = table.components;

export function nativeComponent(id: string): NativeComponent {
  const component = NATIVE_COMPONENTS.find(c => c.id === id);
  if (!component) throw new Error(`Unknown native component: ${id}`);
  return component;
}

// Whether the version row allows building this component (same rule as the
// build): the version's adapter family is one the component serves, and the row
// allows the component's capability.
export function componentAllowed(component: NativeComponent, profile: PortalVersionProfile): boolean {
  return profile.adapter !== null && component.adapters.includes(profile.adapter)
    && profile.capabilities.includes(component.buildCapability);
}

export function componentsForVersion(id: PortalVersionId): NativeComponent[] {
  const profile = portalVersion(id);
  return NATIVE_COMPONENTS.filter(component => componentAllowed(component, profile));
}

// The component's own version keeps the historical, unsuffixed file name: the
// default version if it allows the component, else the first row that does.
export function componentHomeVersion(id: string): PortalVersionId | null {
  const component = nativeComponent(id);
  const allowed = PORTAL_VERSIONS.filter(profile => componentAllowed(component, profile)).map(profile => profile.id);
  return allowed.includes(DEFAULT_PORTAL_VERSION) ? DEFAULT_PORTAL_VERSION : allowed[0] ?? null;
}

// e.g. TiaLiveReadCore.exe for V20, TiaLiveReadCore.v16.exe, TiaV15Snapshot.v15_1.exe off-home.
export function componentExeName(id: string, version: PortalVersionId): string {
  const component = nativeComponent(id);
  const suffix = version === componentHomeVersion(id) ? "" : `.${version.toLowerCase().replaceAll(".", "_")}`;
  return `${component.baseName}${suffix}.exe`;
}

export function componentExe(id: string, version: PortalVersionId, packageRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const component = nativeComponent(id);
  const override = component.exeEnv && version === componentHomeVersion(id) ? env[component.exeEnv]?.trim() : "";
  return override || path.join(packageRoot, component.outputDir, componentExeName(id, version));
}

export function componentSources(id: string, packageRoot: string): string[] {
  return nativeComponent(id).sources.map(source => path.join(packageRoot, source));
}

export function portalVersion(id: PortalVersionId): PortalVersionProfile {
  const profile = PORTAL_VERSIONS.find(p => p.id === id);
  if (!profile) throw new Error(`Unknown TIA Portal version: ${id}`);
  return profile;
}

// Versions with a built adapter, default first. Used for tool input enums.
export function supportedVersionIds(): [PortalVersionId, ...PortalVersionId[]] {
  const ids = PORTAL_VERSIONS.filter(p => p.adapter).map(p => p.id);
  return [DEFAULT_PORTAL_VERSION, ...ids.filter(id => id !== DEFAULT_PORTAL_VERSION)];
}

// All recognized extensions, or only those of versions that have a capability.
export function projectExtensions(capability?: PortalCapability): string[] {
  return PORTAL_VERSIONS.filter(p => !capability || hasCapability(p, capability)).map(p => p.projectExtension);
}

// Recognize the version from the extension; unknown extensions are rejected.
export function profileForProject(projectPath: string): PortalVersionProfile {
  const extension = path.win32.extname(projectPath).toLowerCase();
  const profile = PORTAL_VERSIONS.find(p => p.projectExtension === extension);
  if (!profile) {
    throw new Error(`Not a recognized TIA Portal project (${projectExtensions().join(", ")}): ${projectPath}`);
  }
  return profile;
}

// A companion's self-test reports the loaded Siemens.Engineering version, e.g.
// "20.0.0.0". It must be exactly the version's API: major and minor match.
export function apiAssemblyMatches(id: PortalVersionId, assemblyVersion: string | undefined): boolean {
  const match = /^(\d+)\.(\d+)(?:\.\d+){0,2}$/.exec(assemblyVersion ?? "");
  const { major, minor } = portalVersion(id).apiAssembly;
  return Boolean(match) && Number(match![1]) === major && Number(match![2]) === minor;
}

export function hasCapability(profile: PortalVersionProfile, capability: PortalCapability): boolean {
  return profile.adapter !== null && profile.capabilities.includes(capability);
}

export function requireCapability(projectPath: string, capability: PortalCapability): PortalVersionProfile {
  const profile = profileForProject(projectPath);
  if (profile.adapter === null) {
    throw new Error(`TIA Portal ${profile.id} projects are recognized, but no ${profile.id} adapter is built or verified yet.`);
  }
  if (!profile.capabilities.includes(capability)) {
    const available = profile.capabilities.join(", ") || "none";
    throw new Error(`TIA Portal ${profile.id} does not support ${capability} in this tool (available: ${available}).`);
  }
  return profile;
}

// Kept for the read-only snapshot path: an exact version with a built adapter.
export type ReadOnlyPortalVersion = PortalVersionId;
export function readOnlyProjectVersion(projectPath: string): PortalVersionId {
  return requireCapability(projectPath, "snapshot_export").id;
}

// Maps a registry key such as TIAP15_1 to the Portal root it records.
export type RegistryRoots = (registryKey: string) => string | null;

// The Portal root is recorded on the Global (or EditionMain) subkey of each
// _InstalledSW\TIAPxx key. One PowerShell read covers every version and emits
// UTF-8 JSON, so non-ASCII install paths survive (reg.exe pipes the OEM code
// page). Read once per process; a version installed later needs a restart to
// be found through the registry (known roots are still checked every time).
const REGISTRY_SCRIPT = [
  "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
  "$r = @{}",
  "foreach ($k in Get-ChildItem 'HKLM:\\SOFTWARE\\Siemens\\Automation\\_InstalledSW' -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -like 'TIAP*' }) {",
  "  foreach ($s in 'Global', 'EditionMain') {",
  "    $v = (Get-ItemProperty -LiteralPath (Join-Path $k.PSPath $s) -Name Path -ErrorAction SilentlyContinue).Path",
  "    if ($v) { $r[$k.PSChildName] = [string]$v; break }",
  "  }",
  "}",
  "$r | ConvertTo-Json -Depth 2 -Compress"
].join("\n");

let registryRootsCache: Map<string, string> | null = null;
export const readRegistryRoots: RegistryRoots = registryKey => {
  if (!registryRootsCache) {
    registryRootsCache = new Map();
    if (process.platform === "win32") {
      try {
        const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", REGISTRY_SCRIPT],
          { encoding: "utf8", windowsHide: true, timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
        const parsed = JSON.parse(output.replace(/^\uFEFF/, "").trim() || "{}") as Record<string, unknown>;
        for (const [key, value] of Object.entries(parsed)) if (typeof value === "string") registryRootsCache.set(key, value);
      } catch { /* registry discovery is optional; known roots still apply */ }
    }
  }
  return registryRootsCache.get(registryKey) ?? null;
};

export interface ResolvedApi { dllPath: string; source: string }

export function installRootFromRegistry(profile: PortalVersionProfile, roots: RegistryRoots = readRegistryRoots): string | null {
  const value = roots(profile.registryKey);
  return value ? value.replace(/[\\/]+$/, "") : null;
}

// Order: version env override, legacy env name, registry install, known roots.
// The registry is the installed Portal, so it outranks hard-coded locations.
// It is read only when no env override resolves.
export function resolveApiDll(
  id: PortalVersionId,
  options: { env?: NodeJS.ProcessEnv; roots?: RegistryRoots; exists?: (file: string) => boolean } = {}
): ResolvedApi | null {
  const profile = portalVersion(id);
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const inRoot = (root: string) => path.win32.join(root, "PublicAPI", profile.apiFolder, "Siemens.Engineering.dll");
  const candidates: Array<() => ResolvedApi> = [
    () => ({ dllPath: env[profile.apiDllEnv]?.trim() ?? "", source: profile.apiDllEnv }),
    () => ({ dllPath: profile.legacyApiDllEnv ? env[profile.legacyApiDllEnv]?.trim() ?? "" : "", source: profile.legacyApiDllEnv ?? "" }),
    () => {
      const root = installRootFromRegistry(profile, options.roots);
      return { dllPath: root ? inRoot(root) : "", source: `registry_${profile.registryKey}` };
    },
    ...profile.installRoots.map(root => () => ({ dllPath: inRoot(root), source: "known_install_root" }))
  ];
  for (const candidate of candidates) {
    const resolved = candidate();
    if (resolved.dllPath && exists(resolved.dllPath)) return resolved;
  }
  return null;
}

export interface InstalledVersion {
  id: PortalVersionId; installRoot: string | null; apiDll: string | null; apiSource: string | null;
  adapter: NativeAdapter | null;
  // Upper bound from the version table; native-capabilities.ts has what is verified.
  declaredCapabilities: PortalCapability[];
}

// Diagnostic view: what is installed and what the table allows for it.
export function installedVersions(roots: RegistryRoots = readRegistryRoots): InstalledVersion[] {
  return PORTAL_VERSIONS.map(profile => {
    const api = resolveApiDll(profile.id, { roots });
    return {
      id: profile.id, installRoot: installRootFromRegistry(profile, roots), apiDll: api?.dllPath ?? null, apiSource: api?.source ?? null,
      adapter: profile.adapter, declaredCapabilities: profile.adapter ? [...profile.capabilities] : []
    };
  });
}
