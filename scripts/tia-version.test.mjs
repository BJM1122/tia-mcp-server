import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  PORTAL_VERSIONS, apiAssemblyMatches, parsePortalVersions, profileForProject, projectExtensions, requireCapability, resolveApiDll, supportedVersionIds
} from "../dist/tia-version.js";

test("the shared version file is strictly validated", () => {
  const text = readFileSync(new URL("../portal-versions.json", import.meta.url), "utf8");
  assert.equal(parsePortalVersions(text).versions.length, PORTAL_VERSIONS.length);
  const mutate = change => { const data = JSON.parse(text); change(data); return JSON.stringify(data); };
  assert.throws(() => parsePortalVersions(mutate(d => { d.versions[1].projectExtension = ".ap20"; })), /duplicate projectExtension/);
  assert.throws(() => parsePortalVersions(mutate(d => { d.versions[2].capabilities = ["live_query"]; })), /adapter\/capabilities pairing/);
  assert.throws(() => parsePortalVersions(mutate(d => { d.versions[0].capabilities.push("download"); })), /invalid capabilities/);
  assert.throws(() => parsePortalVersions(mutate(d => { d.versions[0].adapter = "plcsim"; })), /invalid adapter/);
  assert.throws(() => parsePortalVersions(mutate(d => { d.defaultVersion = "V16"; })), /defaultVersion must have an adapter/);
});

test("every version row is unique and self-consistent", () => {
  for (const key of ["id", "projectExtension", "registryKey", "apiDllEnv"]) {
    assert.equal(new Set(PORTAL_VERSIONS.map(p => p[key])).size, PORTAL_VERSIONS.length, key);
  }
  for (const p of PORTAL_VERSIONS) {
    assert.match(p.projectExtension, /^\.ap\d+(_\d+)?$/);
    assert.equal(p.adapter === null, p.capabilities.length === 0, p.id);
  }
  assert.deepEqual(supportedVersionIds(), ["V20", "V15.1", "V17"]);
  assert.ok(projectExtensions().includes(".ap16"));
  // Recognized-only versions are not exact project identities for UI matching.
  assert.deepEqual(projectExtensions("passive_ui_context"), [".ap20", ".ap15_1", ".ap17"]);
});

test("capabilities, not version strings, gate tools", () => {
  assert.equal(requireCapability("D:\\P.ap20", "block_import").id, "V20");
  assert.equal(requireCapability("D:\\P.AP15_1", "snapshot_export").id, "V15.1");
  assert.equal(requireCapability("D:\\P.ap15_1", "block_import").id, "V15.1");
  assert.equal(requireCapability("D:\\P.ap17", "snapshot_export").id, "V17");
  assert.equal(requireCapability("D:\\P.ap17", "block_import").id, "V17");
  assert.throws(() => requireCapability("D:\\P.ap17", "live_query"), /V17 does not support live_query/);
  assert.throws(() => requireCapability("D:\\P.ap15_1", "hmi_authoring"), /V15\.1 does not support hmi_authoring/);
  assert.throws(() => requireCapability("D:\\P.ap18", "snapshot_export"), /V18 projects are recognized, but no V18 adapter/);
  assert.throws(() => profileForProject("D:\\P.ap15"), /Not a recognized TIA Portal project/);
});

test("a companion's reported API assembly must be exactly the version's", () => {
  assert.equal(apiAssemblyMatches("V20", "20.0.0.0"), true);
  assert.equal(apiAssemblyMatches("V15.1", "15.1.0.0"), true);
  assert.equal(apiAssemblyMatches("V15.1", "15.0.0.0"), false);
  assert.equal(apiAssemblyMatches("V20", "15.1.0.0"), false);
  assert.equal(apiAssemblyMatches("V20", "20.1.0.0"), false);
  assert.equal(apiAssemblyMatches("V20", "200.0.0.0"), false);
  assert.equal(apiAssemblyMatches("V20", ""), false);
  assert.equal(apiAssemblyMatches("V20", undefined), false);
  assert.throws(() => apiAssemblyMatches("V99", "99.0.0.0"), /Unknown TIA Portal version/);
});

test("API resolution prefers env, then legacy env, registry, then known roots, and never crosses versions", () => {
  const installed = new Set([
    "E:\\TIA\\Portal V15_1\\PublicAPI\\V15.1\\Siemens.Engineering.dll",
    "C:\\Program Files\\Siemens\\Automation\\Portal V15_1\\PublicAPI\\V15.1\\Siemens.Engineering.dll",
    "C:\\Program Files\\Siemens\\Automation\\Portal V20\\PublicAPI\\V20\\Siemens.Engineering.dll",
    "F:\\override\\Siemens.Engineering.dll"
  ]);
  const exists = file => installed.has(file);
  // Registry roots keep the trailing backslash Siemens often records.
  const registry = { TIAP15_1: "E:\\TIA\\Portal V15_1\\" };
  const roots = key => registry[key] ?? null;
  assert.deepEqual(resolveApiDll("V15.1", { env: {}, roots, exists }),
    { dllPath: "E:\\TIA\\Portal V15_1\\PublicAPI\\V15.1\\Siemens.Engineering.dll", source: "registry_TIAP15_1" });
  assert.equal(resolveApiDll("V15.1", { env: {}, roots: () => null, exists }).source, "known_install_root");
  assert.equal(resolveApiDll("V15.1", { env: { TIA_MCP_V15_1_API_DLL: "F:\\override\\Siemens.Engineering.dll" }, roots, exists }).source, "TIA_MCP_V15_1_API_DLL");
  assert.equal(resolveApiDll("V15.1", { env: { TIA_MCP_API_DLL_V15_1: "F:\\override\\Siemens.Engineering.dll", TIA_MCP_V15_1_API_DLL: "x" }, roots, exists }).source, "TIA_MCP_API_DLL_V15_1");
  // The generic legacy variable belongs to V20 only.
  assert.equal(resolveApiDll("V20", { env: { TIA_MCP_OPENNESS_API_DLL: "F:\\override\\Siemens.Engineering.dll" }, roots, exists }).source, "TIA_MCP_OPENNESS_API_DLL");
  assert.notEqual(resolveApiDll("V15.1", { env: { TIA_MCP_OPENNESS_API_DLL: "F:\\override\\Siemens.Engineering.dll" }, roots, exists }).source, "TIA_MCP_OPENNESS_API_DLL");
  assert.equal(resolveApiDll("V16", { env: {}, roots, exists }), null);
});

test("V20 resolves registry, then the Program Files root, and never a V15.1 file", () => {
  const v20 = root => `${root}\\PublicAPI\\V20\\Siemens.Engineering.dll`;
  const all = new Set([v20("G:\\TIA\\Portal V20"), v20("C:\\Program Files\\Siemens\\Automation\\Portal V20")]);
  const exists = file => all.has(file);
  assert.equal(resolveApiDll("V20", { env: {}, roots: k => k === "TIAP20" ? "G:\\TIA\\Portal V20" : null, exists }).dllPath, v20("G:\\TIA\\Portal V20"));
  assert.equal(resolveApiDll("V20", { env: {}, roots: () => null, exists }).dllPath, v20("C:\\Program Files\\Siemens\\Automation\\Portal V20"));
  // A V20 registry entry that only holds a V15.1 API folder is not a V20 API.
  const v15Only = new Set(["G:\\TIA\\Portal V20\\PublicAPI\\V15.1\\Siemens.Engineering.dll"]);
  assert.equal(resolveApiDll("V20", { env: {}, roots: () => "G:\\TIA\\Portal V20", exists: f => v15Only.has(f) }), null);
});

test("registry is not read when an env override resolves", () => {
  let reads = 0;
  const roots = () => { reads++; return null; };
  resolveApiDll("V15.1", { env: { TIA_MCP_API_DLL_V15_1: "F:\\o.dll" }, roots, exists: f => f === "F:\\o.dll" });
  assert.equal(reads, 0);
});
