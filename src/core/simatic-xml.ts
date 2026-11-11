import { XMLParser } from "fast-xml-parser";

export function parseSimaticXmlText(text: string) {
  return new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: true
  }).parse(text.replace(/^\uFEFF/, ""));
}

export function scalarString(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return scalarString(value[0]);
  if (typeof value === "object") return "";
  return String(value);
}
