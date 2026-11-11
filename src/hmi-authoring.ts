import { createHash } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";

export const hmiAdapters = [
  { id: "wincc-classic-v20", family: "WinCC Classic", version: "20", nativeExport: "implemented", candidateEdit: "implemented", import: "implemented_unverified", createProject: "implemented_unverified" },
  { id: "wincc-unified-v20", family: "WinCC Unified", version: "20", nativeExport: "not_implemented", candidateEdit: "implemented_scoped_public_properties", import: "not_enabled", createProject: "implemented_unverified", inspect: "implemented_scoped_projection", editExisting: "implemented_unverified" },
  { id: "mcgspro", family: "McgsPro", version: null, nativeExport: "unverified", candidateEdit: "unverified", import: "not_enabled", createProject: "unverified" },
  { id: "mcgse", family: "MCGSE", version: null, nativeExport: "unverified", candidateEdit: "unverified", import: "not_enabled", createProject: "unverified" }
] as const;

export const digest = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
export type NativeEdit = { start: number; end: number; expected: string; replacement: string };

export function updateNativeObject(original: string, baselineSha256: string, objectName: string, properties: Record<string, string | number>) {
  validateNativeXml(original);
  const parser = new XMLParser({ parseTagValue: false });
  const masked = original.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, value => " ".repeat(value.length));
  const matches = [...masked.matchAll(/<ObjectName>([^<]*)<\/ObjectName>/g)].filter(m => parser.parse(m[0]).ObjectName === objectName);
  if (matches.length !== 1) throw new Error("Object name must resolve to exactly one native object.");
  const at = matches[0].index!;
  const start = masked.lastIndexOf("<AttributeList>", at), end = masked.indexOf("</AttributeList>", at);
  if (start < 0 || end < 0) throw new Error("Native attribute list unavailable.");
  const block = masked.slice(start, end);
  const edits: NativeEdit[] = [];
  for (const [property, value] of Object.entries(properties)) {
    if (["Left", "Top", "Width", "Height"].includes(property)) {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 8192 || (["Width", "Height"].includes(property) && value === 0)) throw new Error("Invalid geometry value.");
    } else if (["ForeColor", "BackColor", "BorderColor"].includes(property)) {
      if (typeof value !== "string" || !/^\d{1,3},\s*\d{1,3},\s*\d{1,3}$/.test(value) || value.split(",").some(v => Number(v) > 255)) throw new Error("Expected RGB components in 0..255.");
    } else throw new Error(`Unsupported object property: ${property}`);
    const found = [...block.matchAll(new RegExp(`<${property}>([^<]*)</${property}>`, "g"))];
    if (found.length !== 1) throw new Error(`Expected exactly one existing scalar ${property}.`);
    const offset = start + found[0].index! + property.length + 2;
    edits.push({ start: offset, end: offset + found[0][1].length, expected: found[0][1], replacement: String(value) });
  }
  if (!edits.length) throw new Error("No properties supplied.");
  return { ...editNativeXml(original, baselineSha256, edits), objectName, properties };
}

export function validateNativeXml(xml: string): void {
  if (Buffer.byteLength(xml, "utf8") > 25_000_000) throw new Error("Native XML exceeds 25 MB.");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("DTD and entity declarations are prohibited.");
  if (XMLValidator.validate(xml) !== true) throw new Error("Invalid native XML.");
  const parsed = new XMLParser({ ignoreAttributes: false, processEntities: false }).parse(xml);
  const document = parsed.Document;
  if (!document || typeof document !== "object" || Object.keys(parsed).some(key => key !== "Document" && key !== "?xml"))
    throw new Error("Expected a native TIA Document root.");
  const roots = [document["Hmi.Screen.Screen"], document["Hmi.Screen.ScreenTemplate"]].filter(value => value !== undefined);
  if (roots.length !== 1 || Array.isArray(roots[0])) throw new Error("Exactly one classic screen or template is required.");
}

// Splice the original text rather than rebuilding XML from a partial object model.
// Unedited ranges, including vendor extensions and ordering, remain byte-identical.
export function editNativeXml(original: string, baselineSha256: string, edits: NativeEdit[]) {
  validateNativeXml(original);
  if (digest(original) !== baselineSha256) throw new Error("Baseline hash mismatch.");
  if (!edits.length || edits.length > 100) throw new Error("Provide 1..100 explicit edits.");
  const ordered = [...edits].sort((a, b) => a.start - b.start);
  let previousEnd = -1;
  for (const edit of ordered) {
    if (!Number.isSafeInteger(edit.start) || !Number.isSafeInteger(edit.end) || edit.start < 0 || edit.end <= edit.start || edit.end > original.length || edit.start < previousEnd)
      throw new Error("Invalid or overlapping UTF-16 edit ranges.");
    if (original.slice(edit.start, edit.end) !== edit.expected) throw new Error("Expected text does not match the selected range.");
    previousEnd = edit.end;
  }
  let candidate = original;
  for (const edit of [...ordered].reverse()) candidate = candidate.slice(0, edit.start) + edit.replacement + candidate.slice(edit.end);
  validateNativeXml(candidate);
  return { schemaVersion: 1, adapter: "wincc-classic-v20", baselineSha256, candidateSha256: digest(candidate), candidateXml: candidate,
    edits: ordered, unchangedRangesPreserved: true, nativeImportVerified: false,
    limitations: ["XML syntax validation does not establish vendor schema, dependency, device or runtime compatibility."] };
}
