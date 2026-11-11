import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { jsonResult, type JsonValue } from "../core/results.js";
import { normalizePath, normalizeTiaProjectPath, sameCanonicalPath } from "../core/local-paths.js";
import { captureImportBaselines } from "../import-baseline.js";
import { IMPORTER_MAX_TIMEOUT_MS } from "../core/importer-output.js";
import { PlanStore } from "../plan-store.js";
import { readXmlCandidate, validateImporterForVersion } from "../plc-importer.js";
import { op } from "../core/tool-op.js";
import { changesetImportOps } from "./plc-import-changeset.js";
import { profileForProject, type PortalVersionId } from "../tia-version.js";

// Single-block PLC import: a read-only plan binds the exact live process,
// project, XML digest, importer and Openness API identity to a one-time token;
// apply revalidates all of it once before the importer runs. Never downloads.

import { runImporterApply, type PlcImportServices } from "./import-apply.js";
export { plannedRuntimeChange, type PlcImportServices } from "./import-apply.js";

type PendingImportPlan = {
  targetContentSha256: string;
  baselineSource: string;
  portalVersion: PortalVersionId;
  processId: number;
  processStartTimeUtc: string;
  projectPath: string;
  xmlPath: string;
  xmlSha256: string;
  importerExePath: string;
  importerExeSha256: string;
  opennessApiDllPath: string;
  opennessApiDllSha256: string;
  targetKind: string;
  targetName: string;
  targetNumber: string;
  compileScope: "block" | "software";
  saveProject: boolean;
};

// Same bound as MaxTimeoutMs in TiaOpennessImportBlock.cs (checked by scripts/importer-contract.test.mjs).
export const MAX_APPLY_TIMEOUT_MS = IMPORTER_MAX_TIMEOUT_MS;

// No approval hash: apply binds the request fields to the plan instead.
const importPlans = new PlanStore<PendingImportPlan>({
  label: "PLC import", ttlMs: 15 * 60 * 1000, maxPending: 16, overflow: "evict-oldest",
  tokenPrefix: "TIA_IMPORT_", approvalHash: false
});

export function registerPlcImportTools(server: McpServer, services: PlcImportServices) {
  const { resolveExactLiveSession } = services;
  const planOne = op({
        processId: z.number().int().positive().optional(),
        projectPath: z.string(),
        xmlPath: z.string(),
        targetName: z.string(),
        targetNumber: z.string(),
        compileScope: z.enum(["block", "software"]).default("software"),
        // Saving would also store unrelated unsaved edits; leave it for review in TIA Portal.
        saveProject: z.boolean().default(false).describe("Default false: the project stays unsaved for review in TIA Portal. true also saves any other unsaved edits in the project."),
        timeoutMs: z.number().int().min(1_000).max(60_000).default(15_000),
        note: z.string().optional()
      },
    async ({ processId, projectPath, xmlPath, targetName, targetNumber, compileScope, saveProject, timeoutMs, note }) => {
      let requestedVersion: PortalVersionId;
      try { requestedVersion = profileForProject(projectPath).id; }
      catch (error) { return jsonResult({ ok: false, status: "project_path_invalid", error: String(error) }); }
      const runtime = await validateImporterForVersion(requestedVersion);
      if (!runtime.available) {
        return jsonResult({
          ok: false,
          status: "capability_unavailable",
          reason: {
            code: runtime.reason.code,
            message: runtime.reason.message,
            missingComponents: runtime.reason.missingComponents
          },
          projectPath: normalizePath(projectPath),
          xmlPath: normalizePath(xmlPath),
          targetName,
          targetNumber,
          compileScope,
          saveProject,
          note: note ?? "",
          writeStatus: {
            enabled: false,
            confirmationRequired: true,
            confirmToken: "",
            expiresAt: ""
          },
          writeGate: {
            tool: "tia_apply_import",
            exactProcessAndProjectBound: true,
            stagedXmlSha256Bound: true,
            oneTimeToken: true,
            downloadsToPlc: false
          }
        });
      }
      if (!runtime.selfTest.checks?.includes("target_baseline")) {
        return jsonResult({ ok: false, status: "capability_unavailable", reason: { code: "ImporterWithoutBaselineGuard",
          message: "Rebuild the version-specific importer to enable target baseline checks." },
          writeStatus: { enabled: false, confirmToken: "" } });
      }
      // Older importers compiled and rolled back one block only, which leaves FBs with dependent
      // instance DBs inconsistent; refuse a token rather than learn this after the import.
      if (!runtime.selfTest.checks?.includes("software_compile_fallback")) {
        return jsonResult({ ok: false, status: "capability_unavailable", reason: { code: "ImporterWithoutSoftwareCompile",
          message: `Rebuild the version-specific importer: compileScope "${compileScope}" needs software-scope compile, fallback and rollback.` },
          writeStatus: { enabled: false, confirmToken: "" } });
      }
      let canonicalProjectPath = normalizePath(projectPath);
      let projectValidationError = "";
      // The project's version selected the importer and API validated above.
      const portalVersion = requestedVersion;
      try {
        canonicalProjectPath = await normalizeTiaProjectPath(projectPath, "block_import");
        if (profileForProject(canonicalProjectPath).id !== portalVersion) throw new Error("The canonical project path names another TIA Portal version.");
      } catch (error) {
        projectValidationError = error instanceof Error ? error.message : String(error);
      }
      let candidate: Awaited<ReturnType<typeof readXmlCandidate>> | null = null;
      let validationError = "";
      try {
        candidate = await readXmlCandidate(xmlPath);
      } catch (error) {
        validationError = error instanceof Error ? error.message : String(error);
      }
      let live: Awaited<ReturnType<typeof resolveExactLiveSession>> | null = null;
      let liveValidationError = "";
      try {
        live = await resolveExactLiveSession({
          portalVersion,
          processId,
          projectPath: canonicalProjectPath,
          timeoutMs,
          maxNodes: 2_000,
          maxDepth: 12
        });
      } catch (error) {
        liveValidationError = error instanceof Error ? error.message : String(error);
      }
      const exactLive = live?.ok === true ? live : null;
      const exactProjectMatch = Boolean(
        exactLive
        && !projectValidationError
        && sameCanonicalPath(exactLive.projectPath, canonicalProjectPath)
      );
      const nameMatches = candidate ? candidate.name === targetName : false;
      const numberMatches = candidate ? candidate.number === targetNumber : false;
      // The passed self-test hashed the exact importer and API it ran; the plan binds those digests.
      const importerExePath = runtime.importerExePath;
      const importerSelfTest = runtime.selfTest;
      const importerExeSha256 = importerSelfTest.importerSha256 ?? "";
      const opennessApiDllPath = normalizePath(runtime.apiDllPath);
      const opennessApiDllSha256 = importerSelfTest.apiDllSha256 ?? "";
      const opennessApiAssemblyVersion = importerSelfTest.apiAssemblyVersion ?? "";
      const ok = Boolean(
        candidate
        && !projectValidationError
        && exactLive
        && exactProjectMatch
        && nameMatches
        && numberMatches
        && importerExeSha256
        && opennessApiDllSha256
      );
      let targetContentSha256 = "";
      let baselineCaptureMs = 0;
      let baselineSource = "not_attempted";
      let baselineFallbackReason = "";
      let confirmToken = "";
      let expiresAt = "";
      if (ok && candidate && exactLive) {
        try {
          const capture = await captureImportBaselines(importerExePath, opennessApiDllPath, exactLive, [{
            xml: candidate.realXml, sha256: candidate.sha256, kind: candidate.blockKind,
            number: candidate.number, name: candidate.name
          }], timeoutMs);
          targetContentSha256 = capture.signatures[0];
          baselineCaptureMs = capture.elapsedMs;
          baselineSource = capture.baselineSource;
          baselineFallbackReason = capture.baselineFallbackReason;
        } catch (error) {
          return jsonResult({ ok: false, status: "baseline_capture_failed", error: String(error),
            writeStatus: { enabled: false, confirmToken: "" } });
        }
        ({ confirmToken, expiresAt } = importPlans.issue({
          targetContentSha256,
          portalVersion, baselineSource,
          processId: exactLive.processId,
          processStartTimeUtc: exactLive.processStartTimeUtc,
          projectPath: canonicalProjectPath,
          xmlPath: candidate.realXml,
          xmlSha256: candidate.sha256,
          importerExePath,
          importerExeSha256,
          opennessApiDllPath,
          opennessApiDllSha256,
          targetKind: candidate.blockKind,
          targetName,
          targetNumber,
          compileScope,
          saveProject
        }));
      }
      const plan = {
        targetContentSha256, baselineCaptureMs, baselineSource, baselineFallbackReason,
        ok,
        portalVersion,
        projectPath: canonicalProjectPath,
        xmlPath: candidate?.realXml ?? normalizePath(xmlPath),
        targetName,
        targetNumber,
        compileScope,
        saveProject,
        note: note ?? "",
        liveIdentity: exactLive ? {
          processId: exactLive.processId,
          processStartTimeUtc: exactLive.processStartTimeUtc,
          projectPath: exactLive.projectPath
        } : null,
        checks: {
          projectExists: !projectValidationError,
          projectValidationError,
          xmlExists: candidate !== null,
          xmlValidationError: validationError,
          nameMatches,
          numberMatches,
          exactLiveSession: Boolean(exactLive),
          liveValidationError: liveValidationError || (live && !live.ok ? live.reason : ""),
          exactProjectMatch,
          importerExePath,
          importerExeSha256,
          importerSelfTestPassed: importerSelfTest.passed,
          importerSelfTestStatus: importerSelfTest.status,
          opennessApiDllPath,
          opennessApiDllSha256,
          opennessApiAssemblyVersion
        },
        candidate: candidate ? {
          bytes: candidate.bytes,
          sha256: candidate.sha256,
          objectKey: candidate.objectKey,
          blockKind: candidate.blockKind,
          name: candidate.name,
          number: candidate.number,
          programmingLanguage: candidate.programmingLanguage,
          secondaryType: candidate.secondaryType
        } : null,
        writeStatus: {
          enabled: ok,
          confirmationRequired: true,
          confirmToken,
          expiresAt,
          reason: ok
            ? null
            : {
                code: "ImportPlanValidationFailed",
                message: "The exact project, live session, candidate XML, and target identity must all validate before import can be enabled."
              }
        },
        writeGate: {
          tool: "tia_apply_import",
          exactProcessAndProjectBound: true,
          stagedXmlSha256Bound: true,
          selfTestedImporterSha256Bound: true,
          opennessApiPathSha256AndVersionBound: true,
          oneTimeToken: true,
          targetContentBound: true,
          baselineExportBeforeImport: true,
          compileBeforeSave: true,
          compileScope,
          softwareCompileBeforeImport: compileScope === "software",
          blockCompileFallsBackToSoftware: compileScope === "block",
          rollbackCompileScope: "software",
          applyTimeoutMsMax: MAX_APPLY_TIMEOUT_MS,
          verificationExportBeforeSave: true,
          rollbackAttemptedOnFailure: true,
          downloadsToPlc: false
        },
        requiredHumanReview: [
          "Review XML diff against the exported baseline.",
          "The project must not contain unrelated unsaved changes when saveProject=true.",
          "Review all compile errors and warnings returned by the tool.",
          "PLC download is not implemented by this MCP server."
        ]
      };
      return jsonResult({ ...plan, identitySource: exactLive?.identitySource ?? null } as Record<string, JsonValue>);
    }
  );

  const applyOne = op({
        projectPath: z.string(),
        xmlPath: z.string(),
        targetName: z.string(),
        targetNumber: z.string(),
        outDir: z.string().optional(),
        // The importer refuses more than this; a larger value used to fail before the import started.
        timeoutMs: z.number().int().min(60_000).max(MAX_APPLY_TIMEOUT_MS).default(300_000)
          .describe("At most 600000. A software compile and a possible rollback compile must both fit."),
        confirmToken: z.string()
      },
    async ({ projectPath, xmlPath, targetName, targetNumber, outDir, timeoutMs, confirmToken }) => {
      // Validate against a copy; the token is consumed only at the point of no
      // return, and a failed identity check discards it.
      const plan = importPlans.peek(confirmToken);
      if (!plan) {
        return jsonResult({ ok: false, status: "confirmation_invalid_or_expired", blocked: true, downloadsToPlc: false });
      }
      let canonicalProjectPath: string;
      let candidate: Awaited<ReturnType<typeof readXmlCandidate>>;
      try {
        canonicalProjectPath = await normalizeTiaProjectPath(projectPath, "block_import");
        candidate = await readXmlCandidate(xmlPath);
      } catch (error) {
        return jsonResult({
          ok: false, status: "input_revalidation_failed", blocked: true,
          error: error instanceof Error ? error.message : String(error), downloadsToPlc: false
        });
      }
      const requestMatchesPlan = (
        sameCanonicalPath(canonicalProjectPath, plan.projectPath)
        && sameCanonicalPath(candidate.realXml, plan.xmlPath)
        && candidate.sha256 === plan.xmlSha256
        && candidate.blockKind === plan.targetKind
        && targetName === plan.targetName
        && targetNumber === plan.targetNumber
        && candidate.name === targetName
        && candidate.number === targetNumber
      );
      if (!requestMatchesPlan) {
        return jsonResult({ ok: false, status: "plan_binding_mismatch", blocked: true, downloadsToPlc: false });
      }

      return runImporterApply({
        plan, confirmToken, store: importPlans, services, outDir, timeoutMs,
        targets: [plan],
        outDirTag: "",
        summaryFileName: "import-block.json",
        noun: "import",
        okStatus: { saved: "imported_compiled_verified_saved", unsaved: "imported_compiled_verified_unsaved" },
        prepare: async () => ({ args: [
          "--xml", plan.xmlPath,
          "--xml-sha256", plan.xmlSha256,
          "--baseline-sha256", plan.targetContentSha256,
          "--target-name", plan.targetName,
          "--target-number", plan.targetNumber,
          "--target-kind", plan.targetKind,
          "--compile-scope", plan.compileScope
        ] }),
        verifySummary: async (summary) => {
          // The re-export must be the planned block, and its program content must match the candidate.
          let verificationIdentityMatches = false;
          if (typeof summary.verificationExport === "string" && summary.verificationExport) {
            try {
              const exported = await readXmlCandidate(summary.verificationExport);
              verificationIdentityMatches = exported.name === plan.targetName && exported.number === plan.targetNumber;
            } catch {
              verificationIdentityMatches = false;
            }
          }
          return {
            verified: summary.programContentMatches === true && verificationIdentityMatches,
            fields: { verificationIdentityMatches }
          };
        },
        summaryFields: (summary, projectTouched) => ({
          sourceImportStarted: summary?.sourceImportStarted ?? (projectTouched === false ? false : null),
          compileScope: plan.compileScope,
          compileScopeUsed: summary?.compileScopeUsed ?? null,
          softwareCompileFallback: summary?.softwareCompileFallback === true,
          verificationIdentityMatches: false
        })
      });
    }
  );
  const { planMany, applyMany } = changesetImportOps(services);
  const blockSchema = z.object({ xmlPath: z.string(), targetName: z.string(), targetNumber: z.string() });
  server.registerTool(
    "tia_create_import_plan",
    {
      title: "Create TIA Import Plan",
      description: "Read-only validation for importing 1 to 20 candidate Simatic ML blocks as one change (for example a DB member plus the FC networks that use it). Binds one short-lived confirmation token to the exact live TIA process and project, every candidate XML digest and target identity, each target's current content digest, the importer and API identity, and the save choice. Several blocks also return each candidate as compact text for review; tia_apply_import then imports them in one session, data blocks first, with one software compile, and rolls all of them back on any failure.",
      inputSchema: {
        processId: z.number().int().positive().optional(),
        projectPath: z.string(),
        blocks: z.array(blockSchema).min(1).max(20),
        compileScope: z.enum(["block", "software"]).optional().describe("One block only; default software. Several blocks always compile the software."),
        saveProject: z.boolean().default(false).describe("Default false: the project stays unsaved for review in TIA Portal. true also saves any other unsaved edits in the project."),
        includeReview: z.boolean().optional().describe("Several blocks: compact text of each candidate; default true."),
        timeoutMs: z.number().int().min(1_000).max(60_000).default(15_000),
        note: z.string().optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async (args) => args.blocks.length === 1 ? planOne({ ...args, ...args.blocks[0] }) : planMany(args)
  );
  server.registerTool(
    "tia_apply_import",
    {
      title: "Apply TIA Project Import",
      description: "Consume one import plan token and import its blocks into the exact running TIA process with the version-selected importer: back up every target, override-import (data blocks first), compile, re-export and compare every block, roll back on any failure, and optionally save. blocks must repeat the planned blocks in the planned order. Never downloads to a PLC.",
      inputSchema: {
        projectPath: z.string(),
        blocks: z.array(blockSchema).min(1).max(20),
        outDir: z.string().optional(),
        timeoutMs: z.number().int().min(60_000).max(MAX_APPLY_TIMEOUT_MS).default(MAX_APPLY_TIMEOUT_MS)
          .describe("At most 600000. A software compile and a possible rollback compile must both fit."),
        confirmToken: z.string()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
    },
    async (args) => args.blocks.length === 1 ? applyOne({ ...args, ...args.blocks[0] }) : applyMany(args)
  );
}
