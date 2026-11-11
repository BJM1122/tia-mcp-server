import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { assertAllowedLocalRoot, normalizePath, sameCanonicalPath, sha256File } from "./core/local-paths.js";
import { runProcess } from "./core/process.js";
import { probeComponent } from "./native-capabilities.js";
import { objectRecord, truncate } from "./core/results.js";
import { parseSimaticXmlText, scalarString } from "./core/simatic-xml.js";
import { resolveApiDll, apiAssemblyMatches, componentAllowed, nativeComponent, portalVersion, DEFAULT_PORTAL_VERSION, type PortalVersionId } from "./tia-version.js";

// The single-block importer companion: candidate XML validation and the
// offline (no project, no PLC) self-test that binds importer and API identity.

export const MAX_IMPORT_XML_BYTES = 25_000_000;
const IMPORTER_SELF_TEST_TIMEOUT_MS = 8_000;

export type ImporterSelfTestResult = {
  passed: boolean;
  status: string;
  error: string;
  protocolVersion?: number;
  apiAssemblyVersion?: string;
  importerSha256?: string;
  apiDllPath?: string;
  apiDllSha256?: string;
  // Named offline checks the importer ran; "changeset_ordering" marks changeset support.
  checks?: string[];
};
let importerSelfTestCache: {
  key: string;
  result: ImporterSelfTestResult;
} | null = null;

export async function readXmlCandidate(xmlPath: string) {
  const resolvedXml = normalizePath(xmlPath);
  assertAllowedLocalRoot(resolvedXml, "Import XML path");
  if (path.extname(resolvedXml).toLowerCase() !== ".xml") {
    throw new Error(`Import file must be .xml: ${resolvedXml}`);
  }
  const realXml = await realpath(resolvedXml);
  assertAllowedLocalRoot(realXml, "Import XML path");
  const fileStat = await stat(realXml);
  if (fileStat.size > MAX_IMPORT_XML_BYTES) {
    throw new Error(`Import XML is too large: ${fileStat.size} bytes`);
  }
  const text = await readFile(realXml, "utf8");
  const sha256 = createHash("sha256").update(text).digest("hex");
  const parsed = parseSimaticXmlText(text);
  const document = parsed?.Document;
  if (!document || typeof document !== "object") {
    throw new Error("Import XML is not a Simatic ML Document");
  }
  const objectKeys = Object.keys(document).filter((key) => /^SW\.(Blocks|PlcTypes|Tags)\./.test(key));
  if (objectKeys.length !== 1 || !/^SW\.Blocks\./.test(objectKeys[0] ?? "")) {
    throw new Error(`Import XML must contain exactly one SW.Blocks object; found ${objectKeys.length}`);
  }
  const objectKey = objectKeys[0];
  const objectValue = Array.isArray(document[objectKey]) ? document[objectKey][0] : document[objectKey];
  const attributes = objectValue?.AttributeList ?? {};
  return {
    realXml,
    bytes: fileStat.size,
    sha256,
    objectKey,
    blockKind: objectKey.slice("SW.Blocks.".length),
    name: scalarString(attributes.Name),
    number: scalarString(attributes.Number),
    programmingLanguage: scalarString(attributes.ProgrammingLanguage),
    secondaryType: scalarString(attributes.SecondaryType)
  };
}

export type ImporterRuntime = {
  available: true;
  importerExePath: string;
  apiDllPath: string;
  selfTest: ImporterSelfTestResult;
} | {
  available: false;
  reason: { code: string; message: string; missingComponents: string[] };
};

// A default-version environment check cannot authorize another version's write.
export async function validateImporterForVersion(version: PortalVersionId): Promise<ImporterRuntime> {
  const unavailable = (code: string, message: string, files: string[] = []): ImporterRuntime =>
    ({ available: false, reason: { code, message, missingComponents: files } });
  try {
    const profile = portalVersion(version);
    const component = nativeComponent("importer");
    if (!componentAllowed(component, profile)) return unavailable("ImportCapabilityDisabled", version + " does not allow single-block import.");
    const probe = await probeComponent(component, version);
    if (probe.status !== "verified" || !probe.capabilities.includes("block_import")) {
      const codes: Record<string, string> = { missing: "ImporterUnavailable", stale: "ImporterStale", api_unavailable: "OpennessApiUnavailable" };
      return unavailable(codes[probe.status] ?? "ImporterSelfTestFailed", probe.reason || "Importer self-test did not report block_import.", [probe.exe]);
    }
    const api = resolveApiDll(version);
    if (!api) return unavailable("OpennessApiUnavailable", "Siemens.Engineering.dll for " + version + " was not found.");
    const [importerExePath, apiDllPath] = await Promise.all([realpath(probe.exe), realpath(api.dllPath)]);
    const selfTest = await verifyImporterOffline(importerExePath, apiDllPath, version);
    if (!selfTest.passed) return unavailable("ImporterSelfTestFailed", selfTest.error, [importerExePath]);
    return { available: true, importerExePath, apiDllPath, selfTest };
  } catch (error) {
    return unavailable("ImporterUnavailable", error instanceof Error ? error.message : String(error));
  }
}

export async function verifyImporterOffline(
  importerExe: string,
  apiDll: string,
  portalVersion: PortalVersionId = DEFAULT_PORTAL_VERSION
): Promise<ImporterSelfTestResult> {
  let cacheKey = "";
  let importerSha256 = "";
  let apiDllSha256 = "";
  const canonicalApiDll = normalizePath(apiDll);
  try {
    [importerSha256, apiDllSha256] = await Promise.all([
      sha256File(importerExe),
      sha256File(apiDll)
    ]);
    cacheKey = [
      portalVersion,
      normalizePath(importerExe).toLowerCase(),
      importerSha256,
      canonicalApiDll.toLowerCase(),
      apiDllSha256
    ].join("|");
    if (importerSelfTestCache?.key === cacheKey) return importerSelfTestCache.result;

    const processResult = await runProcess(
      importerExe,
      ["--self-test", "--api", apiDll],
      IMPORTER_SELF_TEST_TIMEOUT_MS,
      "tree-force"
    );
    const jsonLine = processResult.stdout
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? "";
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = objectRecord(JSON.parse(jsonLine));
    } catch {
      parsed = null;
    }
    const safety = objectRecord(parsed?.safety);
    const apiAssemblyVersion = String(parsed?.apiAssemblyVersion ?? "");
    const apiPath = String(parsed?.apiPath ?? "");
    const passed = Boolean(
      processResult.exitCode === 0
      && parsed?.ok === true
      && parsed?.status === "self_test_passed"
      && parsed?.protocolVersion === 1
      && apiAssemblyMatches(portalVersion, apiAssemblyVersion)
      && apiPath
      && sameCanonicalPath(apiPath, apiDll)
      && safety?.selfTestOnly === true
      && safety?.projectOpened === false
      && safety?.projectModified === false
      && safety?.plcAccessed === false
      && safety?.import === false
      && safety?.download === false
    );
    const result: ImporterSelfTestResult = {
      passed,
      status: String(parsed?.status ?? (processResult.exitCode === 0 ? "invalid_self_test_envelope" : "self_test_process_failed")),
      error: passed
        ? ""
        : truncate(
            processResult.stderr.trim()
              || String(parsed?.error ?? "")
              || `Importer --self-test did not satisfy the protocol, API ${portalVersion} identity, and no-project/no-PLC safety contract.`,
            1_000
          ).text,
      protocolVersion: typeof parsed?.protocolVersion === "number" ? parsed.protocolVersion : undefined,
      apiAssemblyVersion: apiAssemblyVersion || undefined,
      importerSha256,
      apiDllPath: canonicalApiDll,
      apiDllSha256,
      checks: Array.isArray(parsed?.checks) ? (parsed.checks as unknown[]).map(String) : []
    };
    importerSelfTestCache = { key: cacheKey, result };
    return result;
  } catch (error) {
    const result: ImporterSelfTestResult = {
      passed: false,
      status: "self_test_error",
      error: error instanceof Error ? error.message : String(error),
      importerSha256: importerSha256 || undefined,
      apiDllPath: canonicalApiDll,
      apiDllSha256: apiDllSha256 || undefined
    };
    if (cacheKey) importerSelfTestCache = { key: cacheKey, result };
    return result;
  }
}
