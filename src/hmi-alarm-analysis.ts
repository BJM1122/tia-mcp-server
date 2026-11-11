import type { EngineeringRecord } from "./engineering-diagnostics.js";
import type { WriteSite } from "./execution-model.js";

export type AlarmWorkbook = { sha256: string; sheets: Array<{ name: string; rows: Array<{ row: number; cells: Record<string, string> }> }> };
const columnAttributes: Record<string, string> = {
  id: "Id", name: "Name", class: "AlarmClass", "alarm class": "AlarmClass",
  "trigger tag": "TriggerTag", "trigger bit": "TriggerBit",
  "acknowledge tag": "AcknowledgementHmiTag", "acknowledgment bit": "AcknowledgementHmiBit",
  "hmi acknowledgement tag": "AcknowledgementHmiTag", "hmi acknowledgment tag": "AcknowledgementHmiTag",
  "hmi acknowledgement bit": "AcknowledgementHmiBit", "hmi acknowledgment bit": "AcknowledgementHmiBit",
  "plc acknowledgement tag": "AcknowledgementPlcTag", "plc acknowledgment tag": "AcknowledgementPlcTag",
  "plc acknowledgement bit": "AcknowledgementPlcBit", "plc acknowledgment bit": "AcknowledgementPlcBit"
};
const string = (value: unknown) => typeof value === "string" ? value.trim() : "";
const referenceId = (value: unknown) => value && typeof value === "object" && "refId" in value ? string(value.refId) : "";

/** Workbook identity is caller-declared: the standard alarm sheets contain no project identity. */
export function readAlarmRows(book: AlarmWorkbook) {
  const records: EngineeringRecord[] = [];
  const sources: Record<string, unknown> = {};
  const issues: unknown[] = [];
  for (const sheet of book.sheets) {
    const headerIndex = sheet.rows.findIndex(row => Object.values(row.cells).some(v => v.trim().toLowerCase() === "trigger tag")
      && Object.values(row.cells).some(v => v.trim().toLowerCase() === "id"));
    if (headerIndex < 0) { issues.push({ sheet: sheet.name, code: "unsupported_alarm_sheet_headers" }); continue; }
    const header = sheet.rows[headerIndex].cells;
    if (new Set(Object.values(header).map(v => v.toLowerCase())).size !== Object.values(header).length)
      throw new Error("Duplicate alarm column headings.");
    const discrete = Object.values(header).some(v => v.trim().toLowerCase() === "trigger bit");
    for (const row of sheet.rows.slice(headerIndex + 1)) {
      if (!Object.values(row.cells).some(v => v.trim())) continue;
      const attributes: Record<string, unknown> = {};
      const raw: Record<string, string> = {};
      for (const [column, value] of Object.entries(row.cells)) {
        const heading = header[column] || column;
        raw[heading] = value;
        const key = columnAttributes[heading.trim().toLowerCase()];
        if (key) {
          if (key in attributes) throw new Error(`Ambiguous alarm columns for ${key}.`);
          attributes[key] = /Bit$/.test(key) && /^\d+$/.test(value) ? Number(value) : value;
        } else if (/^(event text|alarm text|info text)(\s|$)/i.test(heading)) attributes[heading] = value;
      }
      if (!string(attributes.Id)) { issues.push({ sheet: sheet.name, row: row.row, code: "missing_alarm_id" }); continue; }
      const id = `xlsx:${sheet.name}:${row.row}`;
      records.push({ id, parentId: null, relation: "WorkbookAlarm", type: discrete ? "Export.DiscreteAlarm" : "Export.AnalogAlarm",
        attributes, collections: [], unreadableAttributes: [] });
      sources[id] = { sheet: sheet.name, row: row.row, cells: raw };
    }
  }
  if (!records.length) issues.push({ code: "no_alarm_rows_read", meaning: "This is not proof that the HMI has no alarms." });
  return { records, sources, issues, sha256: book.sha256 };
}

export type PlcDefinition = { symbol: string; aliases: string[]; datatype: string; softwarePath: string; source: unknown };
export type ConnectionBinding = { connectionName: string; softwarePath: string };

// Keep quoted component boundaries: "A.B" is different from "A"."B".
export function symbolKey(value: string): string | null {
  const tokens = value.trim().match(/"(?:[^"]|"")*"|[\p{L}_][\p{L}\p{N}_]*|\d+|[.\[\],%]/gu);
  if (!tokens || tokens.join("").replace(/\s/g, "") !== value.replace(/\s/g, "")) return null;
  if (!/^(?:"(?:[^"]|"")+"|[\p{L}_][\p{L}\p{N}_]*)(?:\[\d+(?:,\d+)*\])*(?:\.(?:"(?:[^"]|"")+"|[\p{L}_][\p{L}\p{N}_]*)(?:\[\d+(?:,\d+)*\])*)*$/u.test(tokens.join(""))) return null;
  return tokens.map(t => t.startsWith('"') ? t.slice(1, -1).replace(/""/g, '"').toLowerCase() : t.toLowerCase()).map(t => `${t.length}:${t}`).join("|");
}
function addressKey(value: string) {
  const compact = value.replace(/^%/, "").replace(/\s/g, "").toUpperCase();
  return /^(?:[IQM](?:[BWD]\d+|\d+\.[0-7])|DB\d+\.DB(?:X\d+\.[0-7]|[BWD]\d+))$/.test(compact) ? compact : null;
}
function sameSymbol(a: string, b: string) {
  const key = symbolKey(a);
  return (key !== null && key === symbolKey(b)) || (addressKey(a) !== null && addressKey(a) === addressKey(b));
}
function clearing(site: WriteSite) {
  if (site.effect.kind === "coil" && site.effect.mode === "reset") return "reset_coil";
  if (site.effect.kind === "assign" && site.effect.value.kind === "literal" && /^(false|0|(?:bool|byte|word|dword|lword)#(?:false|0|16#0))$/i.test(site.effect.value.value)) return "assigns_zero_or_false";
  if (site.effect.kind === "coil" && site.effect.mode === "normal") return "normal_coil_follows_guard";
  return null;
}

export function analyzeHmiAlarms(options: {
  records: EngineeringRecord[]; alarms?: EngineeringRecord[]; definitions: PlcDefinition[];
  bindings: ConnectionBinding[]; writes: WriteSite[]; query?: string; resetTagNames?: string[]; limit: number;
}) {
  const { records, definitions, bindings, writes } = options;
  const byId = new Map(records.map(r => [r.id, r]));
  if (byId.size !== records.length) throw new Error("Duplicate HMI record IDs.");
  const tags = records.filter(r => /\.(Tag|HmiTag|HmiSystemTag)$/.test(r.type));
  const connections = records.filter(r => /\.(Connection|HmiConnection)$/.test(r.type));
  const ancestors = (r: EngineeringRecord) => {
    const result = [r]; const seen = new Set([r.id]);
    while (r.parentId && byId.has(r.parentId) && !seen.has(r.parentId)) { r = byId.get(r.parentId)!; seen.add(r.id); result.push(r); }
    return result;
  };
  const root = (r: EngineeringRecord) => ancestors(r).find(p => /\.(HmiTarget|HmiSoftware)$/.test(p.type))?.id;
  const resolve = (value: unknown, candidates: EngineeringRecord[]) => referenceId(value)
    ? candidates.filter(r => r.id === referenceId(value)) : candidates.filter(r => string(r.attributes.Name) === string(value) && string(value));
  const link = (value: unknown, alarm?: EngineeringRecord, bit?: unknown) => {
    const scope = alarm && root(alarm);
    const found = resolve(value, tags.filter(t => !scope || root(t) === scope));
    if (found.length !== 1) return { status: "hmi_tag_unresolved", reference: value ?? null, candidates: found.map(t => t.id) };
    const tag = found[0];
    const connection = resolve(tag.attributes.Connection ?? tag.attributes.ConnectionName, connections.filter(c => root(c) === root(tag)));
    const base = { hmiTag: tag.id, hmiTagName: tag.attributes.Name, plcReference: tag.attributes.PlcTag ?? tag.attributes.LogicalAddress ?? null };
    if (connection.length !== 1) return { ...base, status: "connection_unresolved" };
    const selected = bindings.filter(b => b.connectionName === string(connection[0].attributes.Name));
    if (selected.length !== 1) return { ...base, status: "plc_binding_required", connection: connection[0].attributes };
    const reference = string(base.plcReference);
    const matches = definitions.filter(d => d.softwarePath === selected[0].softwarePath && [d.symbol, ...d.aliases].some(s => sameSymbol(s, reference)));
    if (matches.length !== 1) return { ...base, status: matches.length > 1 ? "plc_symbol_ambiguous" : "plc_symbol_unresolved", softwarePath: selected[0].softwarePath,
      candidates: matches.map(d => d.source) };
    const definition = matches[0];
    const names = [definition.symbol, ...definition.aliases];
    const widths: Record<string, number> = { bool: 1, byte: 8, word: 16, int: 16, uint: 16, dword: 32, dint: 32, udint: 32, lword: 64, lint: 64, ulint: 64 };
    const width = widths[definition.datatype.toLowerCase()];
    if (bit !== undefined && (typeof bit !== "number" || !Number.isInteger(bit) || bit < 0 || width && bit >= width))
      return { ...base, status: "invalid_or_unsupported_bit", bit, width: width ?? null, definition };
    const matchesOperand = (operand: string) => {
      if (names.some(n => sameSymbol(n, operand))) return true;
      const slice = /^(.*)\.%X(\d+)$/i.exec(operand);
      return typeof bit === "number" && !!slice && Number(slice[2]) === bit && names.some(n => sameSymbol(n, slice[1]));
    };
    const related = writes.filter(w => w.softwarePath === definition.softwarePath && (matchesOperand(w.target) || w.readSymbols.some(matchesOperand)));
    const writers = related.filter(w => matchesOperand(w.target));
    const events = records.filter(r => ancestors(r).some(p => /screen|event|script/i.test(p.type + p.relation)) &&
      Object.entries(r.attributes).some(([key, v]) => referenceId(v) === tag.id || /^(Tag|TagName|ProcessValue|Variable)$/i.test(key) && string(v) === string(tag.attributes.Name)));
    return { ...base, status: "resolved_source", connection: connection[0].attributes, bindingEvidence: "caller_selected_connection_to_software_path",
      definition, writers: writers.slice(0, 50), clearCandidates: writers.filter(clearing).slice(0, 50).map(w => ({ reason: clearing(w), site: w })),
      consumers: related.filter(w => !writers.includes(w)).slice(0, 50), truncated: related.length > 50,
      screenBindings: events.slice(0, 50).map(r => ({ id: r.id, path: ancestors(r).reverse().map(p => p.attributes.Name ?? p.id), attributes: r.attributes })),
      screenBindingsTruncated: events.length > 50 };
  };
  const allAlarms = options.alarms ?? records.filter(r => /\.(HmiDiscreteAlarm|HmiAnalogAlarm|DiscreteAlarm|AnalogAlarm)$/.test(r.type));
  const selected = allAlarms.filter(a => !options.query || JSON.stringify(a.attributes).toLowerCase().includes(options.query.toLowerCase()));
  const alarms = selected.slice(0, options.limit).map(alarm => {
    const a = alarm.attributes;
    const roles = [
      ["trigger", a.RaisedStateTag ?? a.TriggerTag, a.RaisedStateTagBitNumber ?? a.TriggerBit],
      ["hmiAcknowledgement", a.AcknowledgementHmiTag, a.AcknowledgementHmiBit],
      ["plcAcknowledgement", a.AcknowledgementPlcTag, a.AcknowledgementPlcBit],
      ["acknowledgmentControl", a.AcknowledgmentControlTag, a.AcknowledgmentControlTagBitNumber],
      ["acknowledgmentState", a.AcknowledgmentStateTag, a.AcknowledgmentStateTagBitNumber]
    ];
    return { id: alarm.id, attributes: a, roles: roles.map(([role, tag, bit]) => ({ role, bit: bit ?? null,
      bitEvidence: "Configured bit retained; containing-word writes are candidates, not proven bit transitions.",
      ...(tag === undefined || tag === "" ? { status: "not_exposed_or_unconfigured" } : link(tag, alarm, bit)) })) };
  });
  return { alarms, matchedCount: selected.length, truncated: selected.length > alarms.length,
    resetTags: (options.resetTagNames ?? []).map(name => ({ name, ...link(name) })),
    limits: ["Source configuration only; no PLC runtime or physical behavior verification.",
      "Acknowledgement is separate from clearing the PLC alarm condition; candidate writes retain guards and execution order.",
      "Expressions, array/UDT expansion and optimized DB byte offsets are not inferred.",
      "Screen bindings are observed references, not proof of a button write; scripts are never executed.",
      "Absence of a definition, writer or event is incomplete evidence, not proof of absence."] };
}
