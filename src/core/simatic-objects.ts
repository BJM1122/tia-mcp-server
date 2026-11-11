import { type JsonValue } from "./results.js";
import { scalarString } from "./simatic-xml.js";

// Navigation helpers for parsed Simatic ML objects (attributes, comments, interface members).

export function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function attributeValue(node: unknown, name: string): string {
  if (!node || typeof node !== "object") return "";
  const value = (node as Record<string, unknown>)[`@_${name}`];
  return scalarString(value);
}

function textValue(node: unknown): string {
  if (node === undefined || node === null) return "";
  if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") return String(node);
  if (typeof node === "object") {
    const text = (node as Record<string, unknown>)["#text"];
    return scalarString(text);
  }
  return "";
}

function booleanAttributes(node: unknown): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  if (!node || typeof node !== "object") return result;
  const attributeList = (node as Record<string, unknown>).AttributeList as Record<string, unknown> | undefined;
  for (const attr of asArray(attributeList?.BooleanAttribute as unknown)) {
    const name = attributeValue(attr, "Name");
    if (!name) continue;
    result[name] = textValue(attr).toLowerCase() === "true";
  }
  return result;
}

function commentText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const comment = (node as Record<string, unknown>).Comment as Record<string, unknown> | undefined;
  const texts = asArray(comment?.MultiLanguageText as unknown)
    .map(textValue)
    .filter(Boolean);
  return texts.join(" | ");
}

export function objectListText(node: unknown, compositionName = "Comment"): string {
  if (!node || typeof node !== "object") return "";
  const objectList = (node as Record<string, unknown>).ObjectList as Record<string, unknown> | undefined;
  const texts: string[] = [];
  for (const mt of asArray(objectList?.MultilingualText as unknown)) {
    if (attributeValue(mt, "CompositionName") !== compositionName) continue;
    const mtObjectList = (mt as Record<string, unknown>).ObjectList as Record<string, unknown> | undefined;
    for (const item of asArray(mtObjectList?.MultilingualTextItem as unknown)) {
      const attributeList = (item as Record<string, unknown>).AttributeList as Record<string, unknown> | undefined;
      const text = scalarString(attributeList?.Text);
      if (text) texts.push(text);
    }
  }
  return texts.join(" | ");
}

export function extractSimaticObject(parsed: unknown): { key: string; value: Record<string, unknown> } {
  const document = (parsed as Record<string, unknown>)?.Document as Record<string, unknown> | undefined;
  if (!document || typeof document !== "object") {
    throw new Error("XML is not a Simatic ML Document");
  }
  const key = Object.keys(document).find((candidate) => /^SW\./.test(candidate));
  if (!key) throw new Error("No SW.* object found in Simatic ML Document");
  const rawValue = document[key];
  const value = (Array.isArray(rawValue) ? rawValue[0] : rawValue) as Record<string, unknown>;
  return { key, value };
}

export function flattenInterfaceMembers(parsed: unknown, limit: number) {
  const object = extractSimaticObject(parsed);
  const attributeList = object.value.AttributeList as Record<string, unknown> | undefined;
  const interfaceNode = attributeList?.Interface as Record<string, unknown> | undefined;
  const sectionsNode = interfaceNode?.Sections as Record<string, unknown> | undefined;
  const sections = asArray(sectionsNode?.Section as unknown);
  const members: Array<Record<string, JsonValue>> = [];
  let truncated = false;

  function walkMember(member: unknown, section: string, parentPath: string, depth: number, parentComponents: string[] = []) {
    if (!member || typeof member !== "object") return;
    if (members.length >= limit) {
      truncated = true;
      return;
    }
    const memberRecord = member as Record<string, unknown>;
    const name = attributeValue(memberRecord, "Name");
    const currentPath = parentPath ? `${parentPath}.${name}` : name;
    const pathComponents = [...parentComponents, name];
    const bools = booleanAttributes(memberRecord);
    members.push({
      section,
      path: currentPath,
      pathComponents,
      name,
      datatype: attributeValue(memberRecord, "Datatype"),
      accessibility: attributeValue(memberRecord, "Accessibility"),
      remanence: attributeValue(memberRecord, "Remanence"),
      depth,
      comment: commentText(memberRecord),
      externalAccessible: bools.ExternalAccessible ?? null,
      externalVisible: bools.ExternalVisible ?? null,
      externalWritable: bools.ExternalWritable ?? null,
      setPoint: bools.SetPoint ?? null
    });
    for (const child of asArray(memberRecord.Member as unknown)) {
      walkMember(child, section, currentPath, depth + 1, pathComponents);
      if (truncated) return;
    }
    const nestedSections = (memberRecord.Sections as Record<string, unknown> | undefined)?.Section;
    for (const nestedSection of asArray(nestedSections as unknown)) {
      const nestedSectionName = attributeValue(nestedSection, "Name") || section;
      const nestedMembers = (nestedSection as Record<string, unknown>).Member;
      for (const child of asArray(nestedMembers as unknown)) {
        walkMember(child, nestedSectionName, currentPath, depth + 1, pathComponents);
        if (truncated) return;
      }
    }
  }

  for (const section of sections) {
    const sectionName = attributeValue(section, "Name");
    for (const member of asArray((section as Record<string, unknown>).Member as unknown)) {
      walkMember(member, sectionName, "", 0);
      if (truncated) break;
    }
    if (truncated) break;
  }

  return {
    objectKey: object.key,
    name: scalarString((attributeList as Record<string, unknown> | undefined)?.Name),
    number: scalarString((attributeList as Record<string, unknown> | undefined)?.Number),
    programmingLanguage: scalarString((attributeList as Record<string, unknown> | undefined)?.ProgrammingLanguage),
    members,
    truncated
  };
}

export function scalarBoolean(value: unknown): boolean | null {
  const text = scalarString(value).toLowerCase();
  if (text === "true") return true;
  if (text === "false") return false;
  return null;
}
