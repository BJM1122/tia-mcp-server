# Read-only engineering diagnostics (0.11.0)

`tia_inspect_engineering` returns engineering evidence and diagnostic findings in one call. It reuses the resident Core and does not import, compile, save, export files, change UI focus, scan a network or access PLC runtime values.

## Use

1. Call `tia_doctor` and `tia_get_current_ui_context`.
2. Prepare the exact session with `tia_prepare_live_session`; retain the existing visible-Portal authorization requirement for a cold attachment.
3. Call `tia_inspect_engineering` with the exact `processId`. `maxObjects` defaults to 5000 (maximum 20000); `includeScreens` defaults to false. The request has a bounded total deadline, at most 60 seconds.

The reader rechecks PID, process-start identity and canonical project path after traversal. It is an observation, not an atomic snapshot: editing during traversal can change the evidence. Findings must be confirmed with focused reads before any proposed change.

## Evidence

- Device groups, devices, nested modules, addresses, network interfaces, nodes and exposed IO relationships.
- PLC tag tables, tags and declared types.
- Classic HMI / Unified software, connections and tags exposed by the installed V20 object model.
- Unified discrete/analog alarms, trigger and acknowledgement attributes, and exposed multilingual text.
- Optional exposed screen objects and allowlisted attributes. Screen XML, dynamic expressions and scripts are not exported or evaluated.

The Core reads only allowlisted attributes and compositions/properties through the official engineering object model. Every record has an observation-local ID, parent, relation, type, readable attributes and a list of unreadable/omitted attributes. Official object identifiers are used internally to resolve repeated references when supported. Diagnostics include object IDs plus paths so the client can trace each finding back to its evidence.

## Automatic checks

- Duplicate configured IP/PROFINET names within the same observed subnet (review required for intentional redundancy).
- Malformed IPv4 addresses/non-contiguous masks and enabled gateways outside the configured subnet.
- HMI connection references scoped to the owning HMI.
- HMI-to-PLC tag-table references with exact connection partner identity. Unified string identities require both `Station` and `Partner` and one matching PLC; no global same-name fallback.
- Declared HMI/PLC type differences, reported for review because a driver may perform valid conversion.
- Exposed alarm trigger references and discrete alarm bit bounds for known scalar types. Array/UDT layouts are not inferred.

## Limits

Classic `Siemens.Engineering.Hmi.HmiTarget` does not expose the Unified alarm collections in this V20 API. The result reports `classic_hmi_alarms_unsupported`, not zero alarms or a clean alarm check. A separate official alarm XLSX export can now be read with `tia_read_hmi_alarm_export`; this tool does not automate that export. See [offline alarm analysis](hmi-alarm-analysis.md) for linking saved HMI evidence to PLC DB/tag source and clear candidates.

PLC DB members, absolute/structured references and expressions are not resolved against tag tables. The report requests an exact block query rather than declaring a variable missing. Alarm wording, acknowledgement/reset logic and screen behavior require further PLC/HMI evidence; reading their attributes does not validate the logic.

Hardware catalog/GSD compatibility, IO address overlap, physical wiring and online connectivity are not automatically validated. This version exposes evidence for inspection and implements only the listed checks.

Limits, unreadable attributes, unsupported values and unsupported classic alarms produce explicit issues. `partial`, `truncated`, `findingsTruncated` and coverage must remain visible. No findings is never a whole-project pass. Diagnostic output is capped at 500 findings while retaining the total count.

## Installation and validation

Build the V20 native Core and TypeScript server together. A stale native Core makes the new capability unavailable in `tia_doctor`. Existing MCP connections do not hot-load the new tool: use a fresh connection to verify version 0.11.0 and its tool list.

Automated validation covers scoped multi-PLC matching, ambiguous connections, unresolved DB references, IP/mask checks, alarm widths/arrays, bounded findings and incomplete evidence. Native compilation/self-test checks the installed V20 API contract. These checks do not replace a live run on a representative HMI project.

## API references

- Installed V20 `Siemens.Engineering.xml`: `IEngineeringObject.GetCompositionInfos`, `GetComposition`, `GetAttributeInfos`; `Hmi.HmiTarget`; `HmiUnified.HmiSoftware`; `HW.Features.NetworkInterface`.
- [V20 object structure and attributes](https://docs.tia.siemens.cloud/r/zh-cn/v20/tia-portal-openness-%E7%94%A8%E4%BA%8E%E5%B7%A5%E7%A8%8B%E7%BB%84%E6%80%81%E5%B7%A5%E4%BD%9C%E6%B5%81%E8%87%AA%E5%8A%A8%E5%8C%96%E7%9A%84-api/tia-portal-openness-api/%E9%A1%B9%E7%9B%AE%E5%92%8C%E9%A1%B9%E7%9B%AE%E6%95%B0%E6%8D%AE%E7%9A%84%E5%8A%9F%E8%83%BD/%E7%A1%AE%E5%AE%9A%E5%AF%B9%E8%B1%A1%E7%BB%93%E6%9E%84%E5%92%8C%E5%B1%9E%E6%80%A7).
- [V20 Unified connection properties](https://docs.tia.siemens.cloud/r/de-de/v20/funktionen-fur-den-zugriff-auf-die-daten-eines-hmi-unified-gerates-rt-unified/hmisoftware-rt-unified/verbindungen-rt-unified/auf-eigenschaften-von-verbindungen-zugreifen-rt-unified).
