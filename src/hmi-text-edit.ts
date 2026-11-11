import { XMLParser } from "fast-xml-parser";
import { editNativeXml, validateNativeXml } from "./hmi-authoring.js";

type Span = { name: string; start: number; contentStart: number; contentEnd: number; end: number; children: Span[]; open: string };
function spans(xml: string) {
  const roots: Span[] = [], stack: Span[] = [];
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[A-Za-z_][\w.:-]*(?:[^<>"']|"[^"]*"|'[^']*')*>/g;
  for (const match of xml.matchAll(tokens)) {
    const text = match[0], start = match.index!;
    if (/^<[!?]/.test(text)) continue;
    if (text.startsWith("</")) {
      const node = stack.pop();
      if (!node || text.slice(2, -1).trim() !== node.name) throw new Error("Unexpected XML nesting.");
      node.contentEnd = start; node.end = start + text.length;
    } else {
      const node: Span = { name: /^<([^\s/>]+)/.exec(text)![1], start, contentStart: start + text.length, contentEnd: start + text.length, end: start + text.length, children: [], open: text };
      (stack.at(-1)?.children ?? roots).push(node);
      if (!text.endsWith("/>")) stack.push(node);
    }
  }
  if (stack.length) throw new Error("Unclosed XML.");
  return roots;
}
const parser = new XMLParser({ parseTagValue: false });
function all(nodes: Span[]): Span[] { return nodes.flatMap(n => [n, ...all(n.children)]); }
function attribute(xml: string, node: Span, key: string) {
  const leaf = node.children.find(n => n.name === "AttributeList")?.children.find(n => n.name === key);
  return leaf ? parser.parse(xml.slice(leaf.start, leaf.end))[key] : undefined;
}
const escaped = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function editNativeText(xml: string, baselineSha256: string, objectName: string, culture: string, text: string, composition = "Text") {
  validateNativeXml(xml);
  const objects = all(spans(xml)).filter(n => attribute(xml, n, "ObjectName") === objectName);
  if (objects.length !== 1) throw new Error("Text object must be uniquely identified by ObjectName.");
  const texts = all(objects[0].children).filter(n => n.name === "MultilingualText" && new RegExp(`\\bCompositionName=["']${composition}["']`).test(n.open));
  const items = texts.flatMap(n => all(n.children)).filter(n => n.name === "MultilingualTextItem" && attribute(xml, n, "Culture") === culture);
  if (items.length !== 1) throw new Error("Exactly one existing text item for the requested culture/composition is required.");
  const leaf = items[0].children.find(n => n.name === "AttributeList")?.children.find(n => n.name === "Text");
  if (!leaf) throw new Error("Native text field missing.");
  const old = xml.slice(leaf.start, leaf.end);
  const replacement = `<Text><body>${text.split(/\r?\n/).map(line => `<p>${escaped(line)}</p>`).join("")}</body></Text>`;
  return { ...editNativeXml(xml, baselineSha256, [{ start: leaf.start, end: leaf.end, expected: old, replacement }]), objectName, culture, composition };
}
