import assert from "node:assert/strict";
import { test } from "node:test";

import { buildTiaCapabilityReport } from "../dist/tia-capabilities.js";

function facts(overrides = {}) {
  return {
    opennessApiDllFound: true,
    opennessApiDllPath: "C:\\Program Files\\Siemens\\Automation\\Portal V20\\PublicAPI\\V20\\Siemens.Engineering.dll",
    opennessApiXmlFound: true,
    opennessApiXmlPath: "C:\\Program Files\\Siemens\\Automation\\Portal V20\\PublicAPI\\V20\\Siemens.Engineering.xml",
    uiContextScript: true,
    uiContextScriptPath: "C:\\tia\\Get-TiaPortalUiContext.ps1",
    liveCoreExe: true,
    liveCoreExePath: "C:\\tia\\TiaLiveReadCore.exe",
    liveCoreSource: true,
    liveCoreSourcePath: "C:\\tia\\TiaLiveReadCore.cs",
    liveCoreBuildScript: true,
    liveCoreBuildScriptPath: "C:\\tia\\Build-TiaLiveReadCore.ps1",
    liveCoreStale: false,
    exportScript: true,
    exportScriptPath: "C:\\tia\\export_tia_project.ps1",
    readerScript: true,
    readerScriptPath: "C:\\tia\\read_tia_xml_export.ps1",
    exporterExe: true,
    exporterExePath: "C:\\tia\\TiaOpennessExport.exe",
    importerSource: true,
    importerSourcePath: "C:\\tia\\TiaOpennessImportBlock.cs",
    importerExe: true,
    importerExePath: "C:\\tia\\TiaOpennessImportBlock.exe",
    importerStale: false,
    importerSelfTestPassed: true,
    importerSelfTestStatus: "self_test_passed",
    importerSelfTestError: "",
    importerBuildScript: true,
    importerBuildScriptPath: "C:\\tia\\Build-TiaOpennessImportBlock.ps1",
    networkProbeEnabled: false,
    ...overrides
  };
}

test("capability report distinguishes ready, policy-disabled, and not-implemented surfaces", () => {
  const report = buildTiaCapabilityReport(facts());

  assert.equal(report.status, "ready");
  assert.equal(report.readiness.coreReadReady, true);
  assert.equal(report.capabilities.residentLiveRead.state, "ready");
  assert.equal(report.capabilities.singleBlockImport.available, true);
  assert.equal(report.capabilities.networkProbe.state, "disabled_by_policy");
  assert.equal(report.capabilities.liveBatchQuery.state, "ready");
  assert.equal(report.capabilities.liveBatchQuery.available, true);
  assert.equal(report.capabilities.engineeringDiagnostics.available, true);
  assert.equal(report.capabilities.plcDownload.available, false);
});

test("new engineering diagnostics are unavailable on a stale native core", () => {
  const report = buildTiaCapabilityReport(facts({ liveCoreStale: true }));
  assert.equal(report.capabilities.engineeringDiagnostics.state, "installed_but_stale");
  assert.equal(report.capabilities.engineeringDiagnostics.available, false);
});

test("an installed importer stays write-disabled until its offline safety self-test passes", () => {
  const report = buildTiaCapabilityReport(facts({
    importerSelfTestPassed: false,
    importerSelfTestStatus: "invalid_self_test_envelope",
    importerSelfTestError: "protocol mismatch"
  }));

  assert.equal(report.status, "degraded");
  assert.equal(report.readiness.projectImportReady, false);
  assert.equal(report.capabilities.singleBlockImport.state, "unverified");
  assert.equal(report.capabilities.singleBlockImport.available, false);
  assert.equal(report.capabilities.singleBlockImport.verified, false);
  assert.equal(report.capabilities.singleBlockImport.reasonCode, "ImporterSelfTestRequired");
  assert.ok(report.capabilities.singleBlockImport.warnings.some((item) => item.includes("protocol mismatch")));
});

test("a stale importer stays write-disabled even if its previous self-test passed", () => {
  const report = buildTiaCapabilityReport(facts({
    importerStale: true,
    importerSelfTestPassed: true
  }));

  assert.equal(report.status, "degraded");
  assert.equal(report.readiness.projectImportReady, false);
  assert.equal(report.capabilities.singleBlockImport.state, "installed_but_stale");
  assert.equal(report.capabilities.singleBlockImport.available, false);
  assert.equal(report.capabilities.singleBlockImport.reasonCode, "ImporterStale");
});

test("missing production importer is reported as a stable blocker and never as an enabled write", () => {
  const importerPath = "C:\\tia\\TiaOpennessImportBlock.exe";
  const report = buildTiaCapabilityReport(facts({
    importerExe: false,
    importerExePath: importerPath
  }));

  assert.equal(report.status, "degraded");
  assert.equal(report.readiness.projectImportReady, false);
  assert.equal(report.capabilities.singleBlockImport.state, "unavailable_missing_component");
  assert.equal(report.capabilities.singleBlockImport.reasonCode, "ImporterUnavailable");
  assert.deepEqual(report.capabilities.singleBlockImport.missingComponents, [importerPath]);
  assert.ok(report.blockers.some((blocker) =>
    blocker.capability === "singleBlockImport"
    && blocker.reasonCode === "ImporterUnavailable"
  ));
});

test("stale resident executable remains usable but is explicitly unverified", () => {
  const report = buildTiaCapabilityReport(facts({ liveCoreStale: true }));

  assert.equal(report.status, "degraded");
  assert.equal(report.readiness.coreReadReady, true);
  assert.equal(report.capabilities.residentLiveRead.state, "installed_but_stale");
  assert.equal(report.capabilities.residentLiveRead.available, true);
  assert.equal(report.capabilities.residentLiveRead.verified, false);
  assert.ok(report.recommendations.some((item) => item.includes("build:live-core")));
});

test("missing exact-identity live dependencies make the core read surface unavailable", () => {
  const report = buildTiaCapabilityReport(facts({
    uiContextScript: false,
    liveCoreExe: false
  }));

  assert.equal(report.status, "unavailable");
  assert.equal(report.readiness.coreReadReady, false);
  assert.equal(report.capabilities.currentUiContext.available, false);
  assert.equal(report.capabilities.residentLiveRead.available, false);
  assert.equal(report.capabilities.offlineIndexRead.available, true);
});

test("official snapshot export no longer depends on retired external exporter companions", () => {
  const report = buildTiaCapabilityReport(facts({
    exportScript: false,
    readerScript: false,
    exporterExe: false
  }));

  assert.equal(report.readiness.projectExportReady, true);
  assert.equal(report.capabilities.projectExport.state, "ready");
  assert.equal(report.capabilities.projectExport.reasonCode, "ProjectExportReady");
});

test("a stale native Core blocks the new one-shot snapshot surface", () => {
  const report = buildTiaCapabilityReport(facts({ liveCoreStale: true }));

  assert.equal(report.readiness.projectExportReady, false);
  assert.equal(report.capabilities.projectExport.state, "installed_but_stale");
  assert.equal(report.capabilities.projectExport.available, false);
  assert.equal(report.capabilities.projectExport.reasonCode, "ProjectExportCoreStale");
});
