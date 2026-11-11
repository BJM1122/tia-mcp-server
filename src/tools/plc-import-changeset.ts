import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { formatRenderedBlock, renderBlockXml } from "../block-render.js";
import {
  assertAllowedLocalRoot, normalizePath, normalizeTiaProjectPath, sameCanonicalPath
} from "../core/local-paths.js";
import { captureImportBaselines } from "../import-baseline.js";
import { IMPORTER_MAX_TIMEOUT_MS } from "../core/importer-output.js";
import { jsonResult, truncate, type JsonValue } from "../core/results.js";
import { PlanStore } from "../plan-store.js";
import { op } from "../core/tool-op.js";
import { readXmlCandidate, validateImporterForVersion } from "../plc-importer.js";
import { profileForProject, type PortalVersionId } from "../tia-version.js";
import { runImporterApply, type PlcImportServices, type PrepareResult } from "./import-apply.js";

// Several reviewed blocks as one change: one plan and approval, one attach, every target backed up
// first, data blocks imported before code, one software compile, every block verified, and one
// rollback of all of them on any failure. Same gate as the single-block import; never downloads.

const MIN_BLOCKS = 2;
const MAX_BLOCKS = 20;
const REVIEW_CHARS = 4_000;

type ChangesetItem = { targetContentSha256: string; xmlPath: string; xmlSha256: string; targetKind: string; targetName: string; targetNumber: string };

type PendingChangesetPlan = {
  baselineSource: string;
  portalVersion: PortalVersionId;
  processId: number;
  processStartTimeUtc: string;
  projectPath: string;
  importerExePath: string;
  importerExeSha256: string;
  opennessApiDllPath: string;
  opennessApiDllSha256: string;
  items: ChangesetItem[];
  saveProject: boolean;
};

const changesetPlans = new PlanStore<PendingChangesetPlan>({
  label: "PLC import changeset", ttlMs: 15 * 60 * 1000, maxPending: 8, overflow: "evict-oldest",
  tokenPrefix: "TIA_CHANGESET_", approvalHash: false
});

const blockSchema = z.object({ xmlPath: z.string(), targetName: z.string(), targetNumber: z.string() });

// The order the importer applies (global DBs, FC/FB, instance DBs, OBs), shown in the plan for review.
const rank = (kind: string) => kind === "InstanceDB" ? 2 : kind.endsWith("DB") ? 0 : kind === "OB" ? 3 : 1;
const importOrder = <T extends { blockKind: string }>(items: T[]) =>
  [...items].sort((a, b) => rank(a.blockKind) - rank(b.blockKind));

export function changesetImportOps(services: PlcImportServices) {
  const { resolveExactLiveSession } = services;
  const planMany = op({
        processId: z.number().int().positive().optional(),
        projectPath: z.string(),
        blocks: z.array(blockSchema).min(MIN_BLOCKS).max(MAX_BLOCKS),
        saveProject: z.boolean().default(false).describe("false leaves the project unsaved for review in TIA Portal."),
        includeReview: z.boolean().default(true).describe(`Compact text of each candidate, up to ${REVIEW_CHARS} characters each.`),
        timeoutMs: z.number().int().min(1_000).max(60_000).default(15_000),
        note: z.string().optional()
      },
    async ({ processId, projectPath, blocks, saveProject, includeReview, timeoutMs, note }) => {
      let portalVersion: PortalVersionId;
      try { portalVersion = profileForProject(projectPath).id; }
      catch (error) { return jsonResult({ ok: false, status: "project_path_invalid", error: String(error) }); }
      const runtime = await validateImporterForVersion(portalVersion);
      if (!runtime.available) {
        return jsonResult({ ok: false, status: "capability_unavailable", reason: runtime.reason, writeStatus: { enabled: false, confirmToken: "" } });
      }
      if (!runtime.selfTest.checks?.includes("changeset_ordering")) {
        return jsonResult({ ok: false, status: "capability_unavailable",
          reason: { code: "ImporterWithoutChangeset", message: "The installed importer predates changesets; rebuild it.", missingComponents: [runtime.importerExePath] },
          writeStatus: { enabled: false, confirmToken: "" } });
      }
      if (!runtime.selfTest.checks.includes("target_baseline")) {
        return jsonResult({ ok: false, status: "capability_unavailable", reason: { code: "ImporterWithoutBaselineGuard",
          message: "Rebuild the version-specific importer to enable target baseline checks." },
          writeStatus: { enabled: false, confirmToken: "" } });
      }
      let canonicalProjectPath = normalizePath(projectPath);
      let projectValidationError = "";
      try {
        canonicalProjectPath = await normalizeTiaProjectPath(projectPath, "block_import");
        if (profileForProject(canonicalProjectPath).id !== portalVersion) throw new Error("The canonical project path names another TIA Portal version.");
      } catch (error) {
        projectValidationError = error instanceof Error ? error.message : String(error);
      }

      const checked = await Promise.all(blocks.map(async (block) => {
        try {
          const candidate = await readXmlCandidate(block.xmlPath);
          const problems = [
            candidate.name !== block.targetName ? `name is ${candidate.name}` : "",
            candidate.number !== block.targetNumber ? `number is ${candidate.number}` : ""
          ].filter(Boolean);
          let review = "";
          if (includeReview) {
            try { review = truncate(formatRenderedBlock(renderBlockXml(await readFile(candidate.realXml, "utf8"))), REVIEW_CHARS).text; }
            catch (error) { review = `(not rendered: ${error instanceof Error ? error.message : String(error)})`; }
          }
          return { block, candidate, problems, review };
        } catch (error) {
          return { block, candidate: null, problems: [error instanceof Error ? error.message : String(error)], review: "" };
        }
      }));
      const identities = checked.flatMap((c) => c.candidate ? [`${c.candidate.blockKind.endsWith("DB") ? "DB" : c.candidate.blockKind}#${c.candidate.number}`, `${c.candidate.blockKind}:${c.candidate.name}`] : []);
      const duplicates = [...new Set(identities.filter((id, i) => identities.indexOf(id) !== i))];

      let live: Awaited<ReturnType<typeof resolveExactLiveSession>> | null = null;
      let liveValidationError = "";
      try {
        live = await resolveExactLiveSession({ portalVersion, processId, projectPath: canonicalProjectPath, timeoutMs, maxNodes: 2_000, maxDepth: 12 });
      } catch (error) {
        liveValidationError = error instanceof Error ? error.message : String(error);
      }
      const exactLive = live?.ok === true ? live : null;
      const exactProjectMatch = Boolean(exactLive && !projectValidationError && sameCanonicalPath(exactLive.projectPath, canonicalProjectPath));
      const importerExeSha256 = runtime.selfTest.importerSha256 ?? "";
      const opennessApiDllSha256 = runtime.selfTest.apiDllSha256 ?? "";
      const ok = Boolean(
        exactLive && exactProjectMatch && !projectValidationError && duplicates.length === 0
        && checked.every((c) => c.candidate && c.problems.length === 0)
        && importerExeSha256 && opennessApiDllSha256
      );
      let signatures: string[] = [];
      let baselineCaptureMs = 0;
      let baselineSource = "not_attempted";
      let baselineFallbackReason = "";
      let confirmToken = "";
      let expiresAt = "";
      if (ok && exactLive) {
        try {
          const capture = await captureImportBaselines(runtime.importerExePath, runtime.apiDllPath, exactLive,
            checked.map(({ candidate }) => ({
              xml: candidate!.realXml, sha256: candidate!.sha256, name: candidate!.name,
              number: candidate!.number, kind: candidate!.blockKind
            })), timeoutMs);
          signatures = capture.signatures;
          baselineCaptureMs = capture.elapsedMs;
          baselineSource = capture.baselineSource;
          baselineFallbackReason = capture.baselineFallbackReason;
        } catch (error) {
          return jsonResult({ ok: false, status: "baseline_capture_failed", error: String(error),
            writeStatus: { enabled: false, confirmToken: "" } });
        }
        ({ confirmToken, expiresAt } = changesetPlans.issue({
          portalVersion, baselineSource,
          processId: exactLive.processId,
          processStartTimeUtc: exactLive.processStartTimeUtc,
          projectPath: canonicalProjectPath,
          importerExePath: runtime.importerExePath,
          importerExeSha256,
          opennessApiDllPath: normalizePath(runtime.apiDllPath),
          opennessApiDllSha256,
          items: checked.map((c, i) => ({
            targetContentSha256: signatures[i],
            xmlPath: c.candidate!.realXml, xmlSha256: c.candidate!.sha256, targetKind: c.candidate!.blockKind,
            targetName: c.block.targetName, targetNumber: c.block.targetNumber
          })),
          saveProject
        }));
      }
      const order = importOrder(checked.filter((c) => c.candidate).map((c) => ({ blockKind: c.candidate!.blockKind, name: c.candidate!.name, number: c.candidate!.number })));
      return jsonResult({
        identitySource: exactLive?.identitySource ?? null,
        ok,
        portalVersion,
        projectPath: canonicalProjectPath,
        saveProject,
        note: note ?? "",
        importOrder: order.map((o) => `${o.blockKind}${o.number} "${o.name}"`),
        compileScope: "software",
        baselineCaptureMs, baselineSource, baselineFallbackReason,
        blocks: checked.map((c, i) => ({
          targetContentSha256: signatures[i] ?? "",
          xmlPath: c.candidate?.realXml ?? normalizePath(c.block.xmlPath),
          targetName: c.block.targetName,
          targetNumber: c.block.targetNumber,
          blockKind: c.candidate?.blockKind ?? "",
          sha256: c.candidate?.sha256 ?? "",
          bytes: c.candidate?.bytes ?? 0,
          problems: c.problems,
          review: c.review
        })) as JsonValue,
        checks: {
          projectValidationError,
          exactLiveSession: Boolean(exactLive),
          liveValidationError: liveValidationError || (live && !live.ok ? live.reason : ""),
          exactProjectMatch,
          duplicateTargets: duplicates,
          importerExePath: runtime.importerExePath,
          importerExeSha256,
          opennessApiDllPath: normalizePath(runtime.apiDllPath),
          opennessApiDllSha256
        },
        writeStatus: { enabled: ok, confirmationRequired: true, confirmToken, expiresAt },
        writeGate: {
          tool: "tia_apply_import",
          oneTimeToken: true,
          targetContentBound: true,
          everyXmlSha256Bound: true,
          baselineExportOfEveryTargetBeforeImport: true,
          dataBlocksImportedFirst: true,
          oneSoftwareCompile: true,
          rollbackOfAllImportedBlocksOnFailure: true,
          downloadsToPlc: false
        },
        requiredHumanReview: [
          "Review each block's compact text (and its XML diff where needed).",
          "Apply first compiles the whole PLC software and refuses if it already has errors.",
          "saveProject=true also saves any other unsaved edits in the project.",
          "A changed target invalidates the whole approval before baseline compilation or any import.",
          "Re-importing a DB recreates it: every user is recompiled and the DB is reinitialized on the next download.",
          "PLC download is not implemented by this MCP server."
        ]
      });
    }
  );

  const applyMany = op({
        projectPath: z.string(),
        blocks: z.array(blockSchema).min(MIN_BLOCKS).max(MAX_BLOCKS),
        outDir: z.string().optional(),
        timeoutMs: z.number().int().min(60_000).max(IMPORTER_MAX_TIMEOUT_MS).default(IMPORTER_MAX_TIMEOUT_MS).describe("At most 600000. Before each block the importer checks that the elapsed time plus two compile times and a margin still fit, so the compile and a possible rollback finish inside it."),
        confirmToken: z.string()
      },
    async ({ projectPath, blocks, outDir, timeoutMs, confirmToken }) => {
      const plan = changesetPlans.peek(confirmToken);
      if (!plan) return jsonResult({ ok: false, status: "confirmation_invalid_or_expired", blocked: true, downloadsToPlc: false });

      // The request must name the planned blocks in the planned order, with unchanged files.
      let bindingOk = blocks.length === plan.items.length;
      try {
        const canonicalProjectPath = await normalizeTiaProjectPath(projectPath, "block_import");
        bindingOk = bindingOk && sameCanonicalPath(canonicalProjectPath, plan.projectPath);
        for (let i = 0; bindingOk && i < blocks.length; i++) {
          const candidate = await readXmlCandidate(blocks[i].xmlPath);
          const item = plan.items[i];
          bindingOk = sameCanonicalPath(candidate.realXml, item.xmlPath) && candidate.sha256 === item.xmlSha256
            && candidate.blockKind === item.targetKind && blocks[i].targetName === item.targetName
            && blocks[i].targetNumber === item.targetNumber && candidate.name === item.targetName && candidate.number === item.targetNumber;
        }
      } catch (error) {
        return jsonResult({ ok: false, status: "input_revalidation_failed", blocked: true, error: error instanceof Error ? error.message : String(error), downloadsToPlc: false });
      }
      if (!bindingOk) return jsonResult({ ok: false, status: "plan_binding_mismatch", blocked: true, downloadsToPlc: false });

      return runImporterApply({
        plan, confirmToken, store: changesetPlans, services, outDir, timeoutMs,
        targets: plan.items,
        outDirTag: "-changeset",
        summaryFileName: "import-changeset.json",
        noun: "changeset",
        okStatus: { saved: "changeset_imported_compiled_verified_saved", unsaved: "changeset_imported_compiled_verified_unsaved" },
        precheck: (resolvedOutDir) => {
          const changesetPath = `${resolvedOutDir}.changeset.json`;
          assertAllowedLocalRoot(changesetPath, "Import changeset file");
          return existsSync(changesetPath) ? { status: "output_directory_already_exists", outDir: resolvedOutDir } : null;
        },
        prepare: async (resolvedOutDir): Promise<PrepareResult> => {
          const changesetPath = `${resolvedOutDir}.changeset.json`;
          // Hash exactly what is written, and never write through an existing path. Written before the
          // token is consumed, so a failed write leaves the approval usable.
          const changesetText = JSON.stringify({
            items: plan.items.map((item) => ({ xml: item.xmlPath, sha256: item.xmlSha256, targetContentSha256: item.targetContentSha256, name: item.targetName, number: item.targetNumber, kind: item.targetKind }))
          });
          const changesetSha256 = createHash("sha256").update(changesetText, "utf8").digest("hex");
          try {
            await mkdir(path.dirname(changesetPath), { recursive: true });
            await writeFile(changesetPath, changesetText, { encoding: "utf8", flag: "wx" });
          } catch (error) {
            return { blocked: { status: "changeset_file_write_failed", error: error instanceof Error ? error.message : String(error) } };
          }
          return {
            args: ["--changeset", changesetPath, "--changeset-sha256", changesetSha256, "--compile-scope", "software"],
            abandon: () => rm(changesetPath, { force: true })
          };
        },
        verifySummary: async (summary) => {
          const items = Array.isArray(summary.items) ? summary.items as Array<Record<string, JsonValue>> : [];
          return {
            verified: items.length === plan.items.length && items.every((item) => item.programContentMatches === true),
            fields: {}
          };
        },
        summaryFields: (summary, projectTouched) => ({
          importStarted: summary ? summary.importStarted !== false : projectTouched !== false
        })
      });
    }
  );
  return { planMany, applyMany };
}
