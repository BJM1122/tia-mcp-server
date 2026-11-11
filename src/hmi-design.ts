import { z } from "zod";
import { navigationEvent, momentaryEvents } from "./hmi-classic-events.js";
import { XMLParser } from "fast-xml-parser";
import { digest, validateNativeXml } from "./hmi-authoring.js";

const name = z.string().min(1).max(128).regex(/^[^/\\\x00-\x1f]+$/);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const element = z.object({
  name, type: z.enum(["text", "rectangle", "button", "ioField"]), x: z.number().int().nonnegative(), y: z.number().int().nonnegative(),
  width: z.number().int().positive(), height: z.number().int().positive(),
  text: z.string().max(4096).default(""), foreground: color.default("#202b38"), background: color.default("#ffffff"),
  transparent: z.boolean().default(true), fontSize: z.number().int().min(8).max(120).default(24),
  navigateTo: name.optional(), valueTag: name.optional(), momentaryTag: name.optional(),
  ioMode: z.enum(["Output", "InputOutput"]).default("Output"), unit: z.string().max(32).default("")
}).strict();
const screen = z.object({ name, number: z.number().int().min(1).max(32767), template: name.optional(),
  background: color.default("#f0f2f5"), elements: z.array(element).max(500) }).strict();
export const designSchema = z.object({
  adapter: z.literal("wincc-classic-v20"),
  device: z.object({ model: z.string().min(1).max(128), width: z.number().int().min(100).max(8192), height: z.number().int().min(100).max(8192) }).strict(),
  templates: z.array(screen.omit({ template: true, number: true })).max(20).default([]),
  screens: z.array(screen).min(1).max(100)
}).strict();
export type HmiDesign = z.infer<typeof designSchema>;
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const rgb = (c: string) => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16)).join(", ");
const tag = (key: string, value: string | number) => `<${key}>${escape(String(value))}</${key}>`;

export function generateHmiDesign(input: unknown) {
  if (Buffer.byteLength(JSON.stringify(input) ?? "") > 20_000_000) throw new Error("Design exceeds 20 MB.");
  const design = designSchema.parse(input);
  validateDesignStructure(design);
  return generateClassicArtifacts(design);
}

// Shared layout/reference validation does not translate vendor serialization.
type LayoutElement = Omit<z.infer<typeof element>, 'type'> & {type:string};
type LayoutPage = {name:string;elements:LayoutElement[]};
export function validateDesignStructure(design: {device:HmiDesign['device'];templates:LayoutPage[];screens:Array<LayoutPage & {number:number;template?:string}>}) {
  const names = new Set<string>(), numbers = new Set<number>();
  for (const s of [...design.templates, ...design.screens]) {
    if (names.has(s.name)) throw new Error(`Duplicate screen/template name: ${s.name}`);
    names.add(s.name);
    const elements = new Set<string>();
    for (const e of s.elements) {
      if (elements.has(e.name)) throw new Error(`Duplicate element: ${e.name}`);
      elements.add(e.name);
      if (e.navigateTo && (e.type !== "button" || !design.screens.some(screen => screen.name === e.navigateTo))) throw new Error(`Navigation must be on a button and target an existing design screen: ${e.name}`);
      if (e.momentaryTag && (e.type !== "button" || e.navigateTo)) throw new Error(`Momentary commands require a dedicated button: ${e.name}`);
      if ((e.type === "ioField") !== Boolean(e.valueTag)) throw new Error(`IO fields require an exact valueTag; other controls cannot use it: ${e.name}`);
      if (e.x + e.width > design.device.width || e.y + e.height > design.device.height) throw new Error(`Element outside device bounds: ${e.name}`);
    }
  }
  for (const s of design.screens) {
    if (numbers.has(s.number)) throw new Error(`Duplicate screen number: ${s.number}`);
    numbers.add(s.number);
    if (s.template && !design.templates.some(t => t.name === s.template)) throw new Error(`Unresolved template: ${s.template}`);
  }
}

function generateClassicArtifacts(design: HmiDesign) {
  let artifactBytes = 0;
  const artifacts = [...design.templates.map(s => ({ ...s, kind: "template" as const, number: undefined, template: undefined })),
    ...design.screens.map(s => ({ ...s, kind: "screen" as const }))].map(s => {
    let nextId = 0;
    const id = () => (nextId++).toString(16).toUpperCase();
    const rootId = id(), layerId = id();
    const items = s.elements.map(e => {
      const type = e.type === "text" ? "TextField" : e.type === "button" ? "Button" : e.type === "ioField" ? "IOField" : "Rectangle";
      const attrs = tag("ObjectName", e.name) + tag("Left", e.x) + tag("Top", e.y) + tag("Width", e.width) + tag("Height", e.height)
        + tag("BackColor", rgb(e.background)) + tag("BackFillStyle", e.transparent ? "Transparent" : "Solid") + tag("BorderWidth", 0);
      const itemId = id();
      const font = `<Hmi.Globalization.MultiLingualFont ID="${id()}" CompositionName="Font"><ObjectList><Hmi.Globalization.FontItem ID="${id()}" CompositionName="Items"><AttributeList><Culture>zh-CN</Culture><FontFamily>Microsoft YaHei</FontFamily>${tag("FontSize", e.fontSize)}<FontStyle>Regular</FontStyle></AttributeList></Hmi.Globalization.FontItem></ObjectList></Hmi.Globalization.MultiLingualFont>`;
      const label = (composition: string) => `<MultilingualText ID="${id()}" CompositionName="${composition}"><ObjectList><MultilingualTextItem ID="${id()}" CompositionName="Items"><AttributeList><Culture>zh-CN</Culture><Text><body><p>${escape(e.text)}</p></body></Text></AttributeList></MultilingualTextItem></ObjectList></MultilingualText>`;
      const navigation = (e.navigateTo ? navigationEvent(id, e.navigateTo) : "") + (e.momentaryTag ? momentaryEvents(id, e.momentaryTag) : "");
      const content = e.type === "rectangle" ? "" : `<ObjectList>${font}${e.type === "button" ? label("TextOff") + label("TextOn") : e.type === "text" ? label("Text") : ""}${navigation}</ObjectList>`;
      const valueLink = e.valueTag ? `<LinkList><ProcessValue TargetID="@OpenLink">${tag("Name",e.valueTag)}</ProcessValue></LinkList>` : "";
      const ioAttributes = e.type === "ioField" ? tag("Mode", e.ioMode) + tag("Unit", e.unit) : "";
      return `<Hmi.Screen.${type} ID="${itemId}" CompositionName="ScreenItems"><AttributeList>${attrs}${ioAttributes}${e.type !== "rectangle" ? tag("ForeColor", rgb(e.foreground)) + "<HorizontalAlignment>Left</HorizontalAlignment><VerticalAlignment>Middle</VerticalAlignment>" : ""}</AttributeList>${valueLink}${content}</Hmi.Screen.${type}>`;
    }).join("");
    const rootType = s.kind === "screen" ? "Screen" : "ScreenTemplate";
    const xml = `<?xml version="1.0" encoding="utf-8"?><Document><Engineering version="V20"/><Hmi.Screen.${rootType} ID="${rootId}"><AttributeList>${tag("Name", s.name)}${s.number === undefined ? "" : tag("Number", s.number)}${tag("Width", design.device.width)}${tag("Height", design.device.height)}${tag("BackColor", rgb(s.background))}</AttributeList>${s.template ? `<LinkList><Template TargetID="@OpenLink">${tag("Name", s.template)}</Template></LinkList>` : ""}<ObjectList><Hmi.Screen.ScreenLayer ID="${layerId}" CompositionName="Layers"><AttributeList><Index>0</Index><Name/><VisibleES>true</VisibleES></AttributeList><ObjectList>${items}</ObjectList></Hmi.Screen.ScreenLayer></ObjectList></Hmi.Screen.${rootType}></Document>`;
    validateNativeXml(xml);
    artifactBytes += Buffer.byteLength(xml);
    if (artifactBytes > 20_000_000) throw new Error("Generated package exceeds 20 MB.");
    return { kind: s.kind, name: s.name, xml, sha256: digest(xml), dependencies: [...(s.template ? [{ kind: "template", name: s.template }] : []), ...s.elements.filter(e => e.navigateTo).map(e => ({ kind: "screen", name: e.navigateTo! })), ...s.elements.flatMap(e => [e.valueTag,e.momentaryTag].filter(Boolean).map(name=>({kind:"tag",name:name!})))] };
  });
  return { schemaVersion: 1, adapter: design.adapter, device: design.device, artifacts,
    nativeImportVerified: false, deviceCompatibilityVerified: false, projectCreated: false,
    supportedControls: ["text", "rectangle", "button", "ioField"], limitations: ["Native XML candidates, including event/IO serialization, require TIA import and compile validation.", "Referenced tags and connections must be supplied as native resources; bindings do not establish PLC runtime compatibility.", "Use the separately approved project creation workflow to create an .ap20 project."] };
}

export function nativeReferences(xml: string) {
  const parsed = new XMLParser({ ignoreAttributes: false, processEntities: false, parseTagValue: false }).parse(xml);
  const references: Array<{ role: string; name: string }> = [];
  function walk(value: unknown, key = "") {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const v of value) walk(v, key); return; }
    const o = value as Record<string, unknown>;
    if (o["@_TargetID"] === "@OpenLink") references.push({ role: key, name: typeof o.Name === "string" ? o.Name : JSON.stringify(o.Name ?? "") });
    for (const [k, v] of Object.entries(o)) walk(v, k);
  }
  walk(parsed);
  return references.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function nativeIdentity(xml: string) {
  validateNativeXml(xml);
  const document = new XMLParser({ ignoreAttributes: false, parseTagValue: false }).parse(xml).Document;
  const kind = document["Hmi.Screen.Screen"] ? "screen" : "template";
  const root = document[kind === "screen" ? "Hmi.Screen.Screen" : "Hmi.Screen.ScreenTemplate"];
  const name = root.AttributeList?.Name;
  if (typeof name !== "string" || !name || /[/\\]/.test(name)) throw new Error("Invalid native object name.");
  if (Object.keys(document).some(k => !["Engineering", "DocumentInfo", kind === "screen" ? "Hmi.Screen.Screen" : "Hmi.Screen.ScreenTemplate"].includes(k))) throw new Error("Unexpected additional top-level objects.");
  if (document.Engineering?.["@_version"] !== "V20") throw new Error("Expected V20 engineering XML.");
  return { kind, name };
}

export function nativeDeviceFields(xml: string) {
  const document = new XMLParser({ parseTagValue: false }).parse(xml).Document;
  const attrs = (document["Hmi.Screen.Screen"] ?? document["Hmi.Screen.ScreenTemplate"]).AttributeList;
  return { number: attrs.Number ?? null, width: attrs.Width ?? null, height: attrs.Height ?? null };
}
