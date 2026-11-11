export interface EngineeringRecord {
  id: string;
  parentId: string | null;
  relation: string;
  type: string;
  attributes: Record<string, unknown>;
  collections: string[];
  unreadableAttributes: string[];
}

export interface EngineeringObservation {
  records: EngineeringRecord[];
  issues: unknown[];
  truncated: boolean;
}

/** Rules consume observed engineering evidence only; absence is never runtime truth. */
export function inspectEngineering(observation: EngineeringObservation) {
  const records = observation.records;
  const byId = new Map(records.map(r => [r.id, r]));
  const findings: Array<{ code: string; severity: "warning" | "needs_review"; objects: string[]; message: string; evidence: unknown }> = [];
  let findingCount = 0;
  const add = (code: string, severity: "warning" | "needs_review", objects: string[], message: string, evidence: unknown) => {
    findingCount++;
    if (findings.length < 500) findings.push({ code, severity, objects, message, evidence });
  };
  const text = (v: unknown): string => typeof v === "string" ? v.trim() : "";
  const ref = (v: unknown): string => v && typeof v === "object" && "refId" in v ? text(v.refId) : "";
  const name = (r: EngineeringRecord) => text(r.attributes.Name);
  const ancestors = (r: EngineeringRecord) => {
    const chain = [r];
    const seen = new Set([r.id]);
    while (r.parentId && byId.has(r.parentId) && !seen.has(r.parentId)) {
      r = byId.get(r.parentId)!; seen.add(r.id); chain.push(r);
    }
    return chain;
  };
  const hmiRoot = (r: EngineeringRecord) => ancestors(r).find(p => /\.(HmiTarget|HmiSoftware)$/.test(p.type));
  const plcRoot = (r: EngineeringRecord) => ancestors(r).find(p => p.type.endsWith(".PlcSoftware"));
  const hmiTags = records.filter(r => /\.Hmi(?:Unified)?\./.test(r.type) && /\.(Tag|HmiTag|HmiSystemTag)$/.test(r.type));
  const plcTags = records.filter(r => r.type.endsWith(".PlcTag"));
  const connections = records.filter(r => /\.(Connection|HmiConnection)$/.test(r.type) && hmiRoot(r));
  const normalizeType = (v: unknown) => ({ boolean: "bool", int16: "int", uint16: "uint", int32: "dint", uint32: "udint", float: "real" }[text(v).toLowerCase()] ?? text(v).toLowerCase());
  const widths: Record<string, number> = { bool: 1, byte: 8, sint: 8, usint: 8, word: 16, int: 16, uint: 16, dword: 32, dint: 32, udint: 32, lword: 64, lint: 64, ulint: 64 };
  const links: Array<Record<string, unknown>> = [];
  const resolve = (value: unknown, candidates: EngineeringRecord[]) => {
    const id = ref(value);
    return id ? candidates.filter(r => r.id === id) : candidates.filter(r => name(r) === text(value) && text(value) !== "");
  };

  const duplicate = (items: EngineeringRecord[], attribute: string, code: string) => {
    const groups = new Map<string, EngineeringRecord[]>();
    for (const r of items) {
      const subnet = ref(r.attributes.ConnectedSubnet);
      const value = text(r.attributes[attribute]);
      if (!subnet || !value || value === "0.0.0.0") continue;
      const key = `${subnet}\0${value.toLowerCase()}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    for (const group of groups.values()) if (group.length > 1) {
      add(code, "needs_review", group.map(r => r.id),
        `Multiple configured nodes share ${attribute} on the same observed subnet; check intentional redundancy before changing anything.`,
        group.map(r => ({ [attribute]: r.attributes[attribute], subnet: r.attributes.ConnectedSubnet })));
    }
  };
  const nodes = records.filter(r => r.type === "Siemens.Engineering.HW.Node");
  duplicate(nodes, "Address", "duplicate_configured_ip");
  duplicate(nodes, "PnDeviceName", "duplicate_configured_pn_name");
  const ipv4 = (value: string): number | null => {
    const octets = value.split(".");
    if (octets.length !== 4 || octets.some(o => !/^\d{1,3}$/.test(o) || Number(o) > 255)) return null;
    return octets.reduce((n, o) => (n * 256 + Number(o)) >>> 0, 0);
  };
  for (const node of nodes) {
    const address = text(node.attributes.Address);
    const maskText = text(node.attributes.SubnetMask);
    if (!address || address === "0.0.0.0") continue;
    const ip = ipv4(address);
    if (ip === null) {
      // Other node protocols may expose non-IP addresses.
      if (address.includes(".")) add("invalid_configured_ipv4", "warning", [node.id], "Configured dotted IPv4 address is malformed.", { address });
      continue;
    }
    if (!maskText) continue;
    const mask = ipv4(maskText);
    const inverse = mask === null ? null : (~mask >>> 0);
    if (mask === null || inverse === null || (inverse & (inverse + 1)) !== 0) {
      add("invalid_configured_subnet_mask", "warning", [node.id], "Configured IPv4 mask is malformed or non-contiguous.", { mask: maskText });
      continue;
    }
    const gateway = ipv4(text(node.attributes.RouterAddress));
    if (node.attributes.UseRouter === true && gateway !== null && gateway !== 0 && (gateway & mask) !== (ip & mask))
      add("configured_gateway_outside_subnet", "needs_review", [node.id], "Enabled router address is outside the node's configured subnet.", { address, mask: maskText, gateway: node.attributes.RouterAddress });
  }

  for (const tag of hmiTags) {
    const connectionValue = tag.attributes.Connection ?? tag.attributes.ConnectionName;
    const symbol = tag.attributes.PlcTag;
    if (!text(connectionValue) && !ref(connectionValue) && !text(symbol) && !ref(symbol)) continue;
    const root = hmiRoot(tag);
    const matches = resolve(connectionValue, connections.filter(c => hmiRoot(c)?.id === root?.id));
    const link: Record<string, unknown> = { hmiTag: tag.id, plcReference: symbol ?? null, status: "unresolved_connection" };
    links.push(link);
    if (matches.length !== 1) {
      add("hmi_connection_unresolved", "needs_review", [tag.id],
        "The HMI connection did not resolve uniquely within this HMI's observed data.", { connection: connectionValue, matches: matches.map(r => r.id) });
      continue;
    }
    const connection = matches[0]; link.connection = connection.id;
    const partnerId = ref(connection.attributes.Partner);
    const partnerName = text(connection.attributes.Partner);
    const stationName = text(connection.attributes.Station);
    // A PLC name shared by multiple devices is not a valid controller identity.
    const software = records.filter(r => {
      if (!r.type.endsWith(".PlcSoftware")) return false;
      const chain = ancestors(r);
      if (partnerId) return chain.some(p => p.id === partnerId);
      // Unified V20 exposes Partner and Station as strings, not object references.
      return !!partnerName && !!stationName &&
        chain.some(p => p.type === "Siemens.Engineering.HW.Device" && name(p) === stationName) &&
        chain.some(p => (p.type.endsWith(".PlcSoftware") || p.type === "Siemens.Engineering.HW.DeviceItem") && name(p) === partnerName);
    });
    if (software.length !== 1) {
      link.status = "plc_identity_unresolved";
      add("hmi_plc_identity_unresolved", "needs_review", [tag.id, connection.id],
        "The connection's observed partner does not identify exactly one PLC software. Do not match globally by tag name.", { partner: connection.attributes.Partner ?? null });
      continue;
    }
    link.plcSoftware = software[0].id;
    const tags = resolve(symbol, plcTags.filter(p => plcRoot(p)?.id === software[0].id));
    if (tags.length !== 1) {
      link.status = "plc_reference_needs_block_query";
      add("hmi_plc_reference_unresolved", "needs_review", [tag.id, software[0].id],
        "Reference is not uniquely resolved in PLC tag tables. DB members, structured references and absolute addressing need a separate exact PLC query; this is not a missing-variable diagnosis.", { plcReference: symbol ?? null });
      continue;
    }
    const target = tags[0]; link.plcTag = target.id; link.status = "resolved";
    const hmiType = normalizeType(tag.attributes.DataTypeName ?? tag.attributes.DataType);
    const plcType = normalizeType(target.attributes.DataTypeName ?? target.attributes.DataType);
    if (hmiType && plcType && hmiType !== plcType) add("hmi_plc_type_difference", "needs_review", [tag.id, target.id],
      "Declared types differ; verify whether the HMI driver intentionally converts them.", { hmiType, plcType });
  }

  const alarms = records.filter(r => /\.(HmiDiscreteAlarm|HmiAnalogAlarm|DiscreteAlarm|AnalogAlarm)$/.test(r.type));
  for (const alarm of alarms) {
    const value = alarm.attributes.RaisedStateTag ?? alarm.attributes.TriggerTag;
    if (value === undefined) {
      add("alarm_trigger_unavailable", "needs_review", [alarm.id], "Alarm trigger attribute was not exposed/read; trigger validation is incomplete.", null);
      continue;
    }
    const matches = resolve(value, hmiTags.filter(t => hmiRoot(t)?.id === hmiRoot(alarm)?.id));
    if (matches.length !== 1) {
      add("alarm_trigger_unresolved", "needs_review", [alarm.id], "Alarm trigger does not resolve uniquely within the observed HMI tags.", { trigger: value });
      continue;
    }
    const tag = matches[0];
    const bit = alarm.attributes.RaisedStateTagBitNumber ?? alarm.attributes.TriggerBit;
    const width = widths[normalizeType(tag.attributes.DataTypeName ?? tag.attributes.DataType)];
    const array = tag.attributes.ArraySize ?? tag.attributes.ArrayDimensions;
    const isComposite = /array|udt|struct/i.test(text(tag.attributes.TagType));
    if (!isComposite && typeof bit === "number" && Number.isInteger(bit) && width && (array === undefined || array === 0 || array === 1) && (bit < 0 || bit >= width)) {
      add("alarm_bit_out_of_range", "warning", [alarm.id, tag.id], "Configured alarm bit is outside the observed scalar tag width.", { bit, width });
    }
  }
  const paths = Object.fromEntries(records.map(r => [r.id, ancestors(r).reverse().map(p => `${p.relation}[${name(p) || p.id}]`).join("/")]));
  return {
    status: observation.truncated || observation.issues.length ? "partial" : "observed_scope_checked",
    counts: { objects: records.length, networkNodes: nodes.length, hmiTags: hmiTags.length, alarms: alarms.length, plcTags: plcTags.length, findings: findingCount },
    findings, findingsTruncated: findingCount > findings.length, links, paths,
    coverage: {
      network: "same-subnet duplicate IP/PN names, malformed IPv4/masks and enabled gateway subnet; redundancy requires human review",
      hmiPlc: "exact HMI connection and partner identity, PLC tag-table references and declared type differences",
      alarms: "exposed trigger references and known scalar bit widths only",
      notChecked: ["physical wiring and runtime connectivity", "DB members and symbolic expression evaluation", "alarm text meaning, acknowledgement and reset logic", "screen event/script behavior", "hardware catalog compatibility, IO overlap and GSD parameters", "atomic project consistency during observation"]
    },
    conclusion: "No findings means only that these bounded rules found no issue in the observed data; it is not a whole-project pass."
  };
}
