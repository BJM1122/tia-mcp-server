# Offline HMI alarm evidence (0.14)

These tools reuse source exports. They do not attach to Portal, export another PLC program, open Excel, execute HMI scripts, modify an engineering project or access PLC runtime.

## Classic alarm XLSX

`tia_read_hmi_alarm_export({file, query?, limit?})` reads an existing official WinCC alarm `.xlsx` file within the configured export roots. It returns worksheet/row evidence, file SHA-256, multilingual text, trigger/acknowledgement fields, and all original row columns. The reader supports shared strings, inline strings and sparse cells. It rejects formulas rather than trusting cached formula results. Compressed/expanded size, cell count, text length, execution time and output are bounded. It never extracts ZIP entries to disk or follows external workbook relationships.

V20 Basic/Comfort/RT Advanced exports use the documented English headers `ID`, `Trigger tag`, `Trigger bit`, `Acknowledge tag`, `Acknowledgment bit`, `PLC acknowledgement tag`, and `PLC acknowledgment bit`. HMI-prefixed acknowledgement headings are also accepted. `Event text [language]`, `Alarm text` and `Info text` fields retain their language labels. Unknown columns remain raw evidence; sheets without recognized ID/trigger headings produce an explicit issue. Analog rows retain limit fields in the raw evidence; this reader does not evaluate limit expressions. Unsupported/localized column layouts and an empty result never imply that there are no alarms.

The official alarm workbook does not establish project/HMI ownership. The caller must select the correct file; its hash proves which file was read, not which project created it. This reader does not automatically drive the TIA export dialog. Reuse an existing export first.

## PLC and HMI linkage

`tia_analyze_hmi_alarms` accepts:

- `projectPath`, `hmiName`, `hmiPath`: the exact identity previously used by `tia_export_hmi_configuration`.
- `exportDir`: an existing indexed PLC export with matching recorded project path. Missing or conflicting project identity is refused; project-name similarity is insufficient.
- `connectionBindings`: explicit `{connectionName, softwarePath}` selections from the HMI connection evidence and PLC export index. These are reported as caller-selected bindings, not an automatically verified controller link. Each connection must have exactly one selection; duplicate PLC symbols stay ambiguous.
- Optional `alarmWorkbook`: the correct official alarm XLSX for classic alarm evidence. The analysis uses these alarm rows and reports the file hash/row provenance; it does not alter the canonical HMI observation or conceal its original missing-section issues.
- Optional `query`, `limit` (default 5, maximum 20), and `resetTagNames` (up to 10 exact HMI tag names). Reset tags are explicitly selected, never guessed from button names.

Example:

```json
{
  "projectPath": "%USERPROFILE%/Documents/Automation/Line/Line.ap20",
  "hmiName": "Panel",
  "hmiPath": "Station/Panel/Runtime",
  "exportDir": "<workspace>/tia-out/Line",
  "connectionBindings": [{"connectionName": "PLC connection", "softwarePath": "Station/CPU/PLC"}],
  "alarmWorkbook": "<workspace>/tia-out/Line/alarms.xlsx",
  "query": "Pressure",
  "resetTagNames": ["ResetCommand"]
}
```

Results distinguish alarm trigger, classic HMI/PLC acknowledgement, Unified acknowledgement control/state, and separately selected reset tags. Exact PLC tag names, recorded absolute tag addresses and explicit DB member paths/DB-number aliases are resolved only within the selected PLC software. Quoted member boundaries are retained. Unexpanded UDTs, expressions, arrays and inferred optimized DB offsets remain unresolved.

The existing execution analyzer supplies writers, consumers, source file/network, ordered effects, guards and coverage. Reset coils and assignments of zero/false are clear candidates; normal coils follow their guards. Whole-word writes and explicit `.%Xn` writes are retained for a selected alarm bit, with no claim that an observed write executes or actually clears a runtime alarm. HMI acknowledgement is not PLC condition clearing. Exposed screen tag/object references include their parent path, but reference presence alone does not prove button behavior. Missing scripts/events stay an evidence gap.

Partial HMI snapshots remain analyzable, with original coverage/issues visible. PLC symbol scan errors, execution coverage, clipping and source dates remain visible too. The tool may build the existing offline execution cache, but does not create another source export. A source-only result is never a complete alarm/reset-loop validation.

## GRAPH context

The existing `tia_get_graph_context` now also returns the connected source branches, original branch attributes and connection ports, bounded by its existing result limit. This exposes branch structure previously omitted from focused results. It does not simulate parallel branch scheduling, timed actions or active steps, and exact step/transition selection in the Portal editor remains unsupported.

## Validation and deployment

Run `npm run test:all`. Synthetic XLSX and PLC/HMI fixtures exercise the actual MCP tools with the live helper deliberately unavailable. They test partial evidence, exact-project rejection, multibyte text, DB resolution, PLC isolation and formula rejection. These tests do not replace a real project validation. Rebuild and reconnect the intended MCP installation before expecting the new 0.14 tool catalog; a worktree build does not update Claude/Codex's shared installation.

## Official format references

- [V20 classic HMI alarm export](https://docs.tia.siemens.cloud/r/en-us/v20/using-global-functions-basic-panels-panels-comfort-panels-rt-advanced-rt-professional/importing-and-exporting-project-data-basic-panels-panels-comfort-panels-rt-advanced-rt-professional/importing-and-exporting-alarms-basic-panels-panels-comfort-panels-rt-advanced-rt-professional/exporting-alarms-basic-panels-panels-comfort-panels-rt-advanced-rt-professional)
- [V20 discrete alarm workbook fields](https://docs.tia.siemens.cloud/r/en-us/v20/using-global-functions-basic-panels-panels-comfort-panels-rt-advanced-rt-professional/importing-and-exporting-project-data-basic-panels-panels-comfort-panels-rt-advanced-rt-professional/importing-and-exporting-alarms-basic-panels-panels-comfort-panels-rt-advanced-rt-professional/format-of-the-discrete-alarm-data-basic-panels-panels-comfort-panels-rt-advanced)
