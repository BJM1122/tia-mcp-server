import { z } from "zod";
import { digest } from "./hmi-authoring.js";
import { PlanStore } from "./plan-store.js";
import { designSchema, generateHmiDesign, nativeReferences } from "./hmi-design.js";
import { XMLParser, XMLValidator } from "fast-xml-parser";

const nativeKinds = { projectGraphic: "Hmi.Globalization.MultiLingualGraphic", connection: "Hmi.Communication.Connection", tagTable: "Hmi.Tag.TagTable", vbScript: "Hmi.RuntimeScripting.VBScript", textList: "Hmi.TextGraphicList.TextList", graphicList: "Hmi.TextGraphicList.GraphicList" } as const;
const resourceSchema = z.object({ kind: z.enum(["projectGraphic", "connection", "tagTable", "vbScript", "textList", "graphicList"]), name: z.string().min(1).max(128), xml: z.string().max(10_000_000), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

export const projectSpecSchema = z.object({
  outputParent: z.string().min(1),
  projectName: z.string().min(1).max(80).regex(/^[^<>:"/\\|?*\x00-\x1f]+$/).refine(v => !/[. ]$/.test(v) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(v)),
  deviceName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/),
  typeIdentifier: z.string().min(1).max(256).regex(/^(OrderNumber|System):[^\r\n]+$/),
  design: designSchema,
  resources: z.array(resourceSchema).max(100).default([]),
  internalTagTable: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/).default("AI_InternalTags"),
  internalTags: z.array(z.object({ name: z.string().min(1).max(128).regex(/^[^<>"/\\\x00-\x1f]+$/), dataType: z.enum(["Bool","Int","DInt","Real","String"]) }).strict()).max(1000).default([])
}).strict();
export type ProjectSpec = z.infer<typeof projectSpecSchema>;
type HmiProjectPayload = ProjectSpec & { artifacts: Array<{kind:string;name:string;xml:string;sha256:string}>; runtimeSha256: string };
export class HmiProjectPlans {
  private pending: PlanStore<HmiProjectPayload>;
  constructor(now: () => number = Date.now) { this.pending = new PlanStore({ label: "HMI project", ttlMs: 600_000, maxPending: 10, now }); }
  create(spec: ProjectSpec, runtimeSha256: string) {
    if (!/^[a-f0-9]{64}$/.test(runtimeSha256)) throw new Error("Missing runtime fingerprint.");
    const parsed = projectSpecSchema.parse(spec);
    const generated = generateHmiDesign(parsed.design);
    const nativeResources = [...parsed.resources];
    if (parsed.internalTags.length) {
      const escape = (text:string) => text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const entries = parsed.internalTags.map((tag,i)=>`<Hmi.Tag.Tag ID="${(i+1).toString(16).toUpperCase()}" CompositionName="Tags"><AttributeList><Name>${escape(tag.name)}</Name><DataType>${tag.dataType}</DataType></AttributeList></Hmi.Tag.Tag>`).join('');
      const xml = `<?xml version="1.0" encoding="utf-8"?><Document><Engineering version="V20"/><Hmi.Tag.TagTable ID="0"><AttributeList><Name>${parsed.internalTagTable}</Name></AttributeList><ObjectList>${entries}</ObjectList></Hmi.Tag.TagTable></Document>`;
      nativeResources.push({kind:'tagTable',name:parsed.internalTagTable,xml,sha256:digest(xml)});
    }
    const available = new Set(generated.artifacts.map(a => a.name));
    const tagTypes = new Map<string,string>();
    const resources = nativeResources.map(resource => {
      if (digest(resource.xml) !== resource.sha256 || /<!DOCTYPE|<!ENTITY/i.test(resource.xml) || XMLValidator.validate(resource.xml) !== true) throw new Error("Invalid native resource hash/XML.");
      const document = new XMLParser({ignoreAttributes:false,parseTagValue:false}).parse(resource.xml).Document;
      const rootName = nativeKinds[resource.kind];
      if (!document || document.Engineering?.['@_version'] !== 'V20' || Object.keys(document).some(k=>![rootName,'Engineering','DocumentInfo'].includes(k)) || Array.isArray(document[rootName]) || document[rootName]?.AttributeList?.Name !== resource.name) throw new Error("Native resource identity/type mismatch.");
      if (available.has(resource.name)) throw new Error("Duplicate native resource name.");
      available.add(resource.name);
      if (resource.kind === 'tagTable') {
        const tags = document[rootName].ObjectList?.['Hmi.Tag.Tag'] ?? [];
        for (const tag of Array.isArray(tags) ? tags : [tags]) {
          const name = tag.AttributeList?.Name;
          if (typeof name !== 'string' || available.has(name)) throw new Error("Ambiguous native tag name.");
          available.add(name);
          if (typeof tag.AttributeList?.DataType === 'string') tagTypes.set(name,tag.AttributeList.DataType);
        }
      }
      return {...resource, dependencies:nativeReferences(resource.xml)};
    }).sort((a,b)=>Object.keys(nativeKinds).indexOf(a.kind)-Object.keys(nativeKinds).indexOf(b.kind));
    const artifacts = [...resources, ...generated.artifacts];
    for (const screen of [...parsed.design.templates,...parsed.design.screens]) for (const element of screen.elements) {
      if (element.valueTag && !tagTypes.has(element.valueTag)) throw new Error(`IO field requires a typed native tag: ${element.valueTag}`);
      if (element.momentaryTag && !['Bool','Boolean','Binary'].includes(tagTypes.get(element.momentaryTag) ?? '')) throw new Error(`Momentary command requires a native Boolean tag: ${element.momentaryTag}`);
    }
    for (const artifact of artifacts) for (const reference of nativeReferences(artifact.xml)) if (!available.has(reference.name)) throw new Error(`Unresolved native dependency: ${reference.role}/${reference.name}`);
    const payload: HmiProjectPayload = { ...parsed, artifacts, runtimeSha256 };
    const { confirmToken, planSha256, expiresAt } = this.pending.issue(payload, { bytes: 20_000_000, message: "Project candidates exceed 20 MB." });
    return { confirmToken, planSha256, expiresAt, operation: "create_isolated_classic_hmi_project",
      outputParent: parsed.outputParent, projectName: parsed.projectName, deviceName: parsed.deviceName, typeIdentifier: parsed.typeIdentifier,
      device: generated.device, artifacts, compileScope: "hmi_software", saveProject: true,
      overwriteExisting: false, opensExistingProject: false, download: false, nativeAcceptanceVerified: false,
      startupScreenConfigured: false, runtimeReady: false,
      warning: "Creates a new isolated TIA process and project. Failure retains partial output for diagnosis. Catalog compatibility requires native validation." };
  }
  consume(token: string, hash: string) {
    return this.pending.consume(token, hash);
  }
}
