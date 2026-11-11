import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  componentExe, componentSources, requireCapability, resolveApiDll, DEFAULT_PORTAL_VERSION, type PortalCapability, type PortalVersionId
} from "../tia-version.js";

// Install layout and local path policy. src/core and dist/core are two levels
// below the package root.
export const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// Working directory for snapshots, import evidence and HMI exports. Defaults to the
// package root; set TIA_MCP_WORKSPACE_ROOT to keep generated data elsewhere.
export const workspaceRoot = path.resolve(process.env.TIA_MCP_WORKSPACE_ROOT?.trim() || serverRoot);
// Optional legacy export scripts/executables; the doctor only reports whether they exist.
const toolRoot = path.join(workspaceRoot, "tools");
const standardV20PublicApi = "C:\\Program Files\\Siemens\\Automation\\Portal V20\\PublicAPI\\V20";

export function normalizePath(inputPath: string): string {
  return path.resolve(inputPath);
}

export function sameCanonicalPath(left: string, right: string): boolean {
  return normalizePath(left).toLowerCase() === normalizePath(right).toLowerCase();
}

export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(normalizePath(parent), normalizePath(child));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export const paths = {
  workspaceRoot,
  exportScript: path.join(toolRoot, "export_tia_project.ps1"),
  readerScript: path.join(toolRoot, "read_tia_xml_export.ps1"),
  uiContextScript: process.env.TIA_MCP_UI_CONTEXT_SCRIPT?.trim()
    || path.join(serverRoot, "tools", "Get-TiaPortalUiContext.ps1"),
  liveCoreBuildScript: path.join(serverRoot, "tools", "Build-TiaLiveReadCore.ps1"),
  importerBuildScript: path.join(serverRoot, "tools", "Build-TiaOpennessImportBlock.ps1"),
  // Default-version companions, from the component table (env overrides included).
  liveCoreExe: componentExe("live-core", DEFAULT_PORTAL_VERSION, serverRoot),
  liveCoreSource: componentSources("live-core", serverRoot)[0],
  // Compiled into every native companion; editing it makes all of them stale.
  nativeCommonSource: path.join(serverRoot, "live-core", "Common", "TiaNativeTarget.cs"),
  portalVersions: path.join(serverRoot, "portal-versions.json"),
  nativeBuildScript: path.join(serverRoot, "tools", "Build-TiaNative.ps1"),
  accessibleNavigationScript: process.env.TIA_MCP_ACCESSIBLE_NAVIGATION_SCRIPT?.trim()
    || path.join(serverRoot, "tools", "Navigate-TiaPortalAccessibleNetwork.ps1"),
  exporterExe: path.join(toolRoot, "TiaOpennessExport.exe"),
  // Built beside the package (repository root), as the build writes it.
  importerSource: componentSources("importer", serverRoot)[0],
  importerExe: componentExe("importer", DEFAULT_PORTAL_VERSION, serverRoot),
  opennessApiDll: path.join(standardV20PublicApi, "Siemens.Engineering.dll"),
  opennessApiXml: path.join(standardV20PublicApi, "Siemens.Engineering.xml"),
  // Default snapshot output root; override with TIA_MCP_OUTPUT_ROOT.
  defaultOutputRoot: path.resolve(process.env.TIA_MCP_OUTPUT_ROOT?.trim() || path.join(workspaceRoot, "tia-out"))
};

export const allowedOutputRoots = [...new Set([
  normalizePath(paths.defaultOutputRoot),
  normalizePath(path.join(workspaceRoot, "tia-openness-export")),
  normalizePath(path.join(workspaceRoot, "tia-openness-import")),
  normalizePath(path.join(workspaceRoot, "tia-exports")),
  ...(process.env.TIA_MCP_ALLOWED_EXPORT_ROOTS ?? "")
    .split(";")
    .map((root) => root.trim())
    .filter(Boolean)
    .map(normalizePath)
])];

// TIA Portal's default project location; override with TIA_MCP_ALLOWED_PROJECT_ROOTS.
const defaultAllowedProjectRoots = [
  normalizePath(path.join(os.homedir(), "Documents", "Automation"))
];

export function isAllowedLocalRoot(inputPath: string): boolean {
  const resolved = normalizePath(inputPath);
  return allowedOutputRoots.some((root) => isInside(root, resolved));
}

export function assertAllowedLocalRoot(inputPath: string, label: string) {
  if (process.env.TIA_MCP_ALLOW_ANY_LOCAL_PATH === "1") return;
  if (!isAllowedLocalRoot(inputPath)) {
    throw new Error(`${label} must be under one of: ${allowedOutputRoots.join("; ")}. Set TIA_MCP_ALLOW_ANY_LOCAL_PATH=1 only for a deliberate local session.`);
  }
}

export function getAllowedProjectRoots(): string[] {
  const fromEnv = process.env.TIA_MCP_ALLOWED_PROJECT_ROOTS;
  if (!fromEnv?.trim()) return defaultAllowedProjectRoots;
  return fromEnv
    .split(";")
    .map((root) => root.trim())
    .filter(Boolean)
    .map(normalizePath);
}

export function isAllowedProjectPath(projectPath: string): boolean {
  const resolved = normalizePath(projectPath);
  return getAllowedProjectRoots().some((root) => isInside(root, resolved));
}

export async function normalizeTiaProjectPath(projectPath: string, capability: PortalCapability = "live_query"): Promise<string> {
  const resolved = normalizePath(projectPath);
  requireCapability(resolved, capability);
  const realProjectPath = await realpath(resolved);
  requireCapability(realProjectPath, capability);
  if (process.env.TIA_MCP_ALLOW_ANY_PROJECT_PATH === "1") return realProjectPath;
  if (!isAllowedProjectPath(realProjectPath)) {
    throw new Error(`TIA project path must be under one of: ${getAllowedProjectRoots().join("; ")}. Set TIA_MCP_ALLOW_ANY_PROJECT_PATH=1 only for a deliberate local session.`);
  }
  return realProjectPath;
}

export function resolveOpennessApiDll(portalVersion: PortalVersionId = DEFAULT_PORTAL_VERSION): { dllPath: string; source: string } | null {
  return resolveApiDll(portalVersion);
}

export async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}
