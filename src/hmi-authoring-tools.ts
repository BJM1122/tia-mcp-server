import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { digest, editNativeXml, hmiAdapters, updateNativeObject } from "./hmi-authoring.js";
import { designSchema, generateHmiDesign, nativeReferences } from "./hmi-design.js";
import { HmiImportPlans } from "./hmi-import-plan.js";
import { HmiProjectPlans, projectSpecSchema } from "./hmi-project.js";
import { editNativeText } from "./hmi-text-edit.js";
import { previewHmiDesign } from "./hmi-preview.js";
import { workspaceRoot } from "./core/local-paths.js";
import { unifiedDesignSchema, unifiedProjectSpecSchema, generateUnifiedDesign, UnifiedProjectPlans } from "./hmi-unified.js";
import { UnifiedEditPlans, unifiedIdentitySchema, unifiedEditInputSchema, type UnifiedObservation } from "./hmi-unified-edit.js";

// Attach, export and headless project creation are slow in TIA. A write that is
// killed mid-compile or mid-save is worse than a long wait, so writes get a wide limit.
export function hmiTimeoutMs(kind: "read" | "bundle" | "write"): number {
  const defaults = { read: 120_000, bundle: 600_000, write: 900_000 };
  const variable = kind === "write" ? "TIA_MCP_HMI_WRITE_TIMEOUT_MS" : "TIA_MCP_HMI_READ_TIMEOUT_MS";
  const raw = process.env[variable]?.trim();
  const value = raw ? Number(raw) : NaN;
  if (!Number.isInteger(value) || value < 10_000 || value > 3_600_000) return defaults[kind];
  if (kind === "bundle") return Math.max(value, defaults.bundle);
  // A write limit below the read default would bring back mid-compile kills.
  return kind === "write" ? Math.max(value, defaults.read) : value;
}

export function runHmiNative(executable: string, api: string, request: object, timeoutMs = hmiTimeoutMs("read")): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [api], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "", stderr = "", size = 0;
    const writes = ["import", "create_project", "create_unified_project", "edit_unified"].includes((request as { operation?: string }).operation ?? "");
    const uncertain = writes ? " HMI write outcome is unknown; read back and create a new plan. Never replay the token." : " No project write was requested.";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Native HMI operation timed out." + uncertain)); }, timeoutMs);
    child.stdout.on("data", chunk => {
      size += Buffer.byteLength(chunk, "utf8");
      if (size > 40_000_000) { child.kill(); reject(new Error("Native HMI response exceeds limit." + uncertain)); }
      else stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString("utf8")).slice(-4000); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.stdin.on("error", () => { /* Exit handler reports a failed companion. */ });
    child.on("close", code => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(stdout.replace(/^\uFEFF/, ""));
        if ((code !== 0 || result.ok !== true) && !writes) throw new Error(result.error || stderr || "Native export failed.");
        if (writes && code !== 0 && result.ok === true) {
          resolve({...result,ok:false,status:'companion_exited_after_write',error:'Companion exited abnormally after reporting success.',requiresFreshReadback:true});
          return;
        }
        resolve(result);
      } catch (error) { reject(new Error(String(error) + uncertain)); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export function registerHmiAuthoringTools(server: McpServer, serverRoot: string, normalizeProject: (value: string, capability?: "hmi_export" | "hmi_authoring") => Promise<string>, normalizeNewProjectParent: (value: string) => Promise<string>, resolveApiDll: () => string | undefined) {
  const executable = path.join(serverRoot, "tools", "TiaHmiNative.exe");
  // Same resolution as every companion (env override, registry, known roots); an
  // unresolved DLL fails in runtimeFingerprint with the setting to fix.
  const api = resolveApiDll() ?? "";
  const reply = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
  const plans = new HmiImportPlans();
  const projectPlans = new HmiProjectPlans();
  const unifiedPlans = new UnifiedProjectPlans();
  const unifiedEdits = new UnifiedEditPlans();
  const nativeIdentityRequest = (value: { processId: number; processStartTimeUtc: string; projectPath: string; targetPath: string; kind: string; objectPath: string }) => ({
    processId: value.processId, processStartTimeUtc: value.processStartTimeUtc, projectPath: value.projectPath,
    targetPath: value.targetPath, kind: value.kind, objectPath: value.objectPath
  });
  const identitySchema = {
    processId: z.number().int().positive(), processStartTimeUtc: z.string().datetime({ offset: true }), projectPath: z.string(),
    targetPath: z.string().min(1), kind: z.enum(["screen", "template"]), objectPath: z.string().min(1)
  };
  const runtimeFingerprint = async () => {
    const sources = ["TiaHmiNative.cs", "TiaHmiProject.cs", "TiaHmiUnified.cs", path.join("Common", "TiaNativeTarget.cs")].map(name => path.join(serverRoot, "live-core", name))
      .concat(path.join(serverRoot, "portal-versions.json"), path.join(serverRoot, "tools", "Build-TiaNative.ps1"));
    if (!existsSync(executable) || sources.some(source => existsSync(source) && statSync(source).mtimeMs > statSync(executable).mtimeMs)) throw new Error("HMI companion is missing or older than its sources; run npm run build:hmi-native.");
    if (!existsSync(api)) throw new Error("Siemens.Engineering.dll was not found. Set TIA_MCP_API_DLL_V20 (or TIA_MCP_OPENNESS_API_DLL) to the TIA Portal V20 PublicAPI DLL.");
    return createHash("sha256").update(await readFile(executable)).update(await readFile(api)).digest("hex");
  };
  server.registerTool("tia_inspect_unified_hmi", {
    description:"Read-only Unified V20 inspection. Empty targetPath lists targets; empty screenPath lists screens including groups; empty objectName lists screen items. A selected primitive returns a scoped property baseline and scripts, not a complete native import archive.",
    inputSchema:{...unifiedIdentitySchema,targetPath:z.string().default(''),screenPath:z.string().default(''),objectName:z.string().default('')},annotations:{readOnlyHint:true}
  },async input=>{
    const projectPath=await normalizeProject(input.projectPath,"hmi_export"); await runtimeFingerprint();
    return reply(await runHmiNative(executable,api,{...input,projectPath,operation:'inspect_unified'}));
  });
  server.registerTool("tia_create_unified_hmi_edit_plan", {
    description:"Read-only exact plan for existing Unified control geometry, ARGB colors, text in one existing language and font size. Rejects dynamically bound properties and stale identities. Compile covers the entire hosting device; save is optional and covers the entire project.",
    inputSchema:{input:unifiedEditInputSchema},annotations:{readOnlyHint:true}
  },async ({input})=>{
    const projectPath=await normalizeProject(input.projectPath),fingerprint=await runtimeFingerprint();
    const result=await runHmiNative(executable,api,{...input,projectPath,operation:'inspect_unified'});
    if(!result.observation||typeof result.baselineSha256!=='string') throw new Error('Unified property baseline unavailable.');
    return reply(unifiedEdits.create({...input,projectPath},{...(result.observation as UnifiedObservation),baselineSha256:result.baselineSha256},fingerprint));
  });
  server.registerTool("tia_apply_unified_hmi_edit", {
    description:"Apply one explicitly approved immutable Unified property plan, recheck baseline under exclusive access, keep scoped recovery values, compile the hosting device and verify in a fresh helper session. No object reconstruction, download or automatic rollback.",
    inputSchema:{confirmToken:z.string().uuid(),planSha256:z.string().regex(/^[a-f0-9]{64}$/),approval:z.literal('APPLY_EXACT_UNIFIED_HMI_EDIT')},annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false}
  },async ({confirmToken,planSha256})=>{
    const plan=unifiedEdits.consume(confirmToken,planSha256);
    if(await normalizeProject(plan.projectPath)!==plan.projectPath) throw new Error('Unified canonical project path changed.');
    if(await runtimeFingerprint()!==plan.runtimeSha256) throw new Error('HMI runtime changed; replan.');
    const recoveryDirectory=path.resolve(workspaceRoot,'tia-openness-import','unified',confirmToken);
    try {
      const result=await runHmiNative(executable,api,{...plan,operation:'edit_unified',recoveryDirectory},hmiTimeoutMs('write'));
      if(result.ok!==true) return reply({...result,tokenConsumed:true,requiresFreshReadback:true,recoveryDirectory});
      const independent=await runHmiNative(executable,api,{...plan,operation:'inspect_unified'});
      const verified=typeof independent.baselineSha256==='string'&&independent.baselineSha256===result.readbackSha256;
      return reply({...result,ok:verified,independentReadbackSucceeded:verified,verificationMode:'independent_session_scoped_properties',tokenConsumed:true,physicalOperationTested:false});
    }catch(error) {return reply({ok:false,status:'unified_write_outcome_requires_readback',error:String(error),recoveryDirectory,tokenConsumed:true,requiresFreshReadback:true});}
  });
  server.registerTool("tia_generate_unified_hmi_design", {
    description: "Generate an offline WinCC Unified V20 public-API creation program with screens, reusable layouts, internal/external tags, explicit connections, discrete alarms, native controls, navigation and event script bodies. This JSON is not a native import archive. No TIA access or network probing.",
    inputSchema: {design:unifiedDesignSchema}, annotations:{readOnlyHint:true}
  }, async ({design})=>reply(generateUnifiedDesign(design)));
  server.registerTool("tia_create_unified_hmi_project_plan", {
    description: "Create an immutable offline plan for a NEW isolated Unified V20 project. Exact catalog ID, destination, startup screen, objects and scripts are included. No existing project is opened or overwritten.",
    inputSchema:{spec:unifiedProjectSpecSchema},annotations:{readOnlyHint:true}
  },async ({spec})=>{
    const outputParent=await normalizeNewProjectParent(spec.outputParent);
    if(existsSync(path.join(outputParent,spec.projectName))) throw new Error("Project destination already exists.");
    return reply(unifiedPlans.create({...spec,outputParent},await runtimeFingerprint()));
  });
  server.registerTool("tia_apply_unified_hmi_project", {
    description:"Apply an explicitly approved Unified project creation plan once in an isolated TIA process. Create native objects, compile the created device, save and independently reopen for requested-value verification. No download; partial failed output is retained. Two headless TIA sessions; can take several minutes (TIA_MCP_HMI_WRITE_TIMEOUT_MS, default 15 min).",
    inputSchema:{confirmToken:z.string().uuid(),planSha256:z.string().regex(/^[a-f0-9]{64}$/),approval:z.literal("CREATE_EXACT_UNIFIED_HMI_PROJECT")},
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}
  },async ({confirmToken,planSha256})=>{
    const plan=unifiedPlans.consume(confirmToken,planSha256);
    if(await normalizeNewProjectParent(plan.outputParent)!==plan.outputParent||existsSync(path.join(plan.outputParent,plan.projectName))) throw new Error("Unified destination changed or now exists.");
    if(await runtimeFingerprint()!==plan.runtimeSha256) throw new Error("HMI runtime changed; replan.");
    try {return reply({...await runHmiNative(executable,api,{...plan,operation:"create_unified_project"},hmiTimeoutMs("write")),tokenConsumed:true});}
    catch(error) {return reply({ok:false,status:"unified_creation_outcome_unknown",error:String(error),outputDirectory:path.join(plan.outputParent,plan.projectName),tokenConsumed:true,retryAllowed:false});}
  });
  server.registerTool("tia_create_hmi_project_plan", {
    description: "Offline immutable plan to create a NEW isolated classic WinCC V20 project and device, import generated screen/template candidates, compile, save and reopen for verification. Requires an exact Siemens catalog type identifier. Does not access TIA or overwrite an existing directory.",
    inputSchema: { spec: projectSpecSchema }, annotations: { readOnlyHint: true }
  }, async ({ spec }) => {
    const outputParent = await normalizeNewProjectParent(spec.outputParent);
    if (existsSync(path.join(outputParent, spec.projectName))) throw new Error("Project destination already exists.");
    return reply(projectPlans.create({ ...spec, outputParent }, await runtimeFingerprint()));
  });
  server.registerTool("tia_apply_hmi_project", {
    description: "Create a new isolated classic WinCC project only after explicit approval of the exact immutable plan. Does not attach to an existing project or download. Compiles, saves and independently reopens the generated project. Partial failed output is retained. Two headless TIA sessions; can take several minutes (TIA_MCP_HMI_WRITE_TIMEOUT_MS, default 15 min).",
    inputSchema: { confirmToken: z.string().uuid(), planSha256: z.string().regex(/^[a-f0-9]{64}$/), approval: z.literal("CREATE_EXACT_HMI_PROJECT") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ confirmToken, planSha256 }) => {
    const plan = projectPlans.consume(confirmToken, planSha256);
    if (await normalizeNewProjectParent(plan.outputParent) !== plan.outputParent || existsSync(path.join(plan.outputParent, plan.projectName))) throw new Error("Project destination changed or now exists.");
    if (await runtimeFingerprint() !== plan.runtimeSha256) throw new Error("HMI runtime changed; replan.");
    try {
      return reply({ ...await runHmiNative(executable, api, { ...plan, operation: "create_project" }, hmiTimeoutMs("write")), tokenConsumed: true });
    } catch (error) { return reply({ ok: false, status: "project_creation_outcome_unknown", error: String(error), outputDirectory: path.join(plan.outputParent, plan.projectName), tokenConsumed: true, retryAllowed: false }); }
  });
  server.registerTool("tia_generate_hmi_design", {
    description: "Generate classic V20 native screen/template candidates with text, rectangles, buttons, navigation, momentary tag commands and IO fields. No visual template required. Dependencies must be provided when planning a project. Native serialization requires later TIA validation.",
    inputSchema: { design: designSchema }, annotations: { readOnlyHint: true }
  }, async ({ design }) => reply(generateHmiDesign(design)));
  server.registerTool("tia_preview_hmi_design", {
    description: "Generate self-contained offline HTML to preview a design, screen navigation, local IO values and press/release buttons. Never connects to equipment. This is not TIA runtime simulation or a verified native rendering.",
    inputSchema: { design: z.union([designSchema,unifiedDesignSchema]) }, annotations: { readOnlyHint: true }
  }, async ({design}) => reply(previewHmiDesign(design)));
  server.registerTool("tia_edit_hmi_text", {
    description: "Replace the text of one uniquely named classic HMI object in one existing language. Supports Text, TextOn or TextOff. Preserves other languages, events, bindings and unknown XML; replaces formatting only inside the selected text value.",
    inputSchema: { originalXml: z.string().max(25_000_000), baselineSha256: z.string().regex(/^[a-f0-9]{64}$/), objectName: z.string().min(1), culture: z.string().min(1).max(32), text: z.string().max(20000), composition: z.enum(["Text", "TextOn", "TextOff"]).default("Text") },
    annotations: { readOnlyHint: true }
  }, async input => reply(editNativeText(input.originalXml, input.baselineSha256, input.objectName, input.culture, input.text, input.composition)));
  server.registerTool("tia_update_hmi_object", {
    description: "Offline scoped edit of one uniquely named native screen object. Change existing geometry or RGB color properties while preserving all other native XML, bindings and extensions verbatim.",
    inputSchema: { originalXml: z.string().max(25_000_000), baselineSha256: z.string().regex(/^[a-f0-9]{64}$/), objectName: z.string().min(1), properties: z.record(z.string(), z.union([z.string(), z.number()])) },
    annotations: { readOnlyHint: true }
  }, async input => reply(updateNativeObject(input.originalXml, input.baselineSha256, input.objectName, input.properties)));
  server.registerTool("tia_export_hmi_bundle", {
    description: "Export classic V20 screens, templates, tag tables, VB scripts, text/graphic lists, project graphics and connections as native XML in one read-only attachment, with hashes and external-reference inventory. Alarms, recipes and library types are excluded; dependency closure is incomplete.",
    inputSchema: { processId: identitySchema.processId, processStartTimeUtc: identitySchema.processStartTimeUtc, projectPath: identitySchema.projectPath, targetPath: identitySchema.targetPath },
    annotations: { readOnlyHint: true }
  }, async input => {
    const projectPath = await normalizeProject(input.projectPath, "hmi_export");
    await runtimeFingerprint();
    const result = await runHmiNative(executable, api, { ...input, projectPath, operation: "export_bundle" }, hmiTimeoutMs("bundle"));
    const artifacts = result.artifacts as Array<{ kind: string; objectPath: string; xml: string; sha256: string }>;
    if (!Array.isArray(artifacts) || artifacts.some(a => digest(a.xml) !== a.sha256)) throw new Error("Invalid native bundle integrity.");
    return reply({ ...result, identity: { ...input, projectPath }, artifacts: artifacts.map(a => ({ ...a, references: nativeReferences(a.xml) })), dependencyClosureVerified: false });
  });
  server.registerTool("tia_create_hmi_import_plan", {
    description: "Read-only exact plan for replacement of one existing classic V20 screen/template. Captures live baseline, full exact diff, compile/save scope and immutable one-time approval token. Rejects renamed objects and changed external references.",
    inputSchema: { ...identitySchema, candidateXml: z.string().max(25_000_000), saveProject: z.boolean().default(false) },
    annotations: { readOnlyHint: true }
  }, async input => {
    const projectPath = await normalizeProject(input.projectPath);
    const fingerprint = await runtimeFingerprint();
    const baseline = await runHmiNative(executable, api, { ...nativeIdentityRequest(input), projectPath, operation: "export" });
    if (typeof baseline.xml !== "string" || typeof baseline.comparisonSha256 !== "string") throw new Error("Native baseline unavailable.");
    return reply(plans.create({ ...input, projectPath }, baseline.xml, baseline.comparisonSha256, fingerprint));
  });
  server.registerTool("tia_apply_hmi_import", {
    description: "Apply an explicitly approved exact HMI import plan once. Backs up the original object, rechecks baseline under exclusive access, imports, compiles and reads back. No download. Failure can leave unsaved engineering changes; never replay a token.",
    inputSchema: { confirmToken: z.string().uuid(), planSha256: z.string().regex(/^[a-f0-9]{64}$/), approval: z.literal("APPLY_EXACT_HMI_PLAN") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ confirmToken, planSha256 }) => {
    const plan = plans.consume(confirmToken, planSha256);
    if (await normalizeProject(plan.projectPath) !== plan.projectPath) throw new Error("Canonical project path changed; create a new plan.");
    if (await runtimeFingerprint() !== plan.runtimeSha256) throw new Error("HMI companion/API changed; create a new plan.");
    const recoveryDirectory = path.resolve(workspaceRoot, "tia-openness-import", "hmi", confirmToken);
    try {
      // Import + whole-HMI compile under exclusive access: never use the read limit here.
      const result = await runHmiNative(executable, api, { ...nativeIdentityRequest(plan), candidateXml: plan.candidateXml, candidateSha256: plan.candidateSha256,
        baselineComparisonSha256: plan.baselineComparisonSha256, saveProject: plan.saveProject, operation: "import", recoveryDirectory }, hmiTimeoutMs("write"));
      if (result.ok !== true) return reply({ ...result, recoveryDirectory, tokenConsumed: true, requiresFreshReadback: true });
      const independent = await runHmiNative(executable, api, { ...nativeIdentityRequest(plan), operation: "export" });
      const verified = typeof independent.comparisonSha256 === "string" && independent.comparisonSha256 === result.readbackComparisonSha256;
      return reply({ ...result, ok: verified, independentReadbackSucceeded: verified, verificationMode: "independent_session_strict_native_root", tokenConsumed: true, physicalOperationTested: false });
    } catch (error) {
      return reply({ ok: false, status: "write_outcome_requires_readback", error: String(error), tokenConsumed: true, recoveryDirectory, requiresFreshReadback: true });
    }
  });
  server.registerTool("tia_hmi_authoring_capabilities", {
    description: "Report separate HMI software/version adapters and implemented authoring boundaries. Availability is not live verification.",
    inputSchema: {}, annotations: { readOnlyHint: true }
  }, async () => reply({ adapters: hmiAdapters, nativeCompanionAvailable: existsSync(executable),
    unified: { creation: 'implemented_unverified', controls:['text','rectangle','button','ioField','alarmView','trendView'], resources:['internalTags','connections','externalTags','alarmClasses','discreteAlarms'],
      existingEdit:'scoped_static_properties',completeNativeArchive:false,download:false,networkProbing:false },
    deviceProfiles: [], deviceCompatibilityVerified: false, projectCreationAvailable: existsSync(executable), projectCreationVerified: false,
    candidateGeneration: ["screen", "template", "text", "rectangle", "button", "ioField", "internalTags"], batchExport: ["screen", "template", "tagTable", "vbScript", "textList", "graphicList", "projectGraphic", "connection"],
    importAvailable: existsSync(executable), importScope: "replace_existing_screen_or_template_with_unchanged_external_references", nativeImportVerified: false }));
  server.registerTool("tia_export_hmi_native", {
    description: "Read-only classic WinCC V20 native screen/template XML export using the official API. Discover exact targets first, then list object paths with an empty objectPath. Requires exact PID, process start and project. Dependencies are not included; this is not a complete HMI backup.",
    inputSchema: {
      operation: z.enum(["discover", "export"]).default("discover"),
      processId: z.number().int().positive(), processStartTimeUtc: z.string().datetime({ offset: true }), projectPath: z.string(),
      targetPath: z.string().default(""), kind: z.enum(["screen", "template"]).default("screen"), objectPath: z.string().default("")
    }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, async request => {
    const projectPath = await normalizeProject(request.projectPath, "hmi_export");
    await runtimeFingerprint();
    const result = await runHmiNative(executable, api, { ...request, projectPath });
    return reply({ ...result, identity: { ...request, projectPath },
      ...(typeof result.xml === "string" ? { baselineSha256: digest(result.xml), hashEncoding: "utf8", adapter: "wincc-classic-v20" } : {}) });
  });
  server.registerTool("tia_edit_hmi_native", {
    description: "Create an offline native XML candidate using exact UTF-16 ranges and expected text. Preserves every unedited range, including unknown vendor XML. Does not import, compile or establish dependency compatibility.",
    inputSchema: { originalXml: z.string().max(25_000_000), baselineSha256: z.string().regex(/^[a-f0-9]{64}$/),
      edits: z.array(z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive(), expected: z.string(), replacement: z.string() })).min(1).max(100) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, async input => reply(editNativeXml(input.originalXml, input.baselineSha256, input.edits)));
}
