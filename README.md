# TIA Portal MCP Server

A local [Model Context Protocol](https://modelcontextprotocol.io) server and CLI
for Windows that lets an AI coding assistant (Claude Code, Codex or any stdio MCP
client) analyze and carefully change Siemens TIA Portal projects through the
official TIA Portal Openness API.

Version **0.29.0** — first standalone public distribution. It contains only the
tool itself: no TIA projects, exports, PLC programs, site data, Siemens binaries
or private Git history.

What it does:

- Exports a complete, hash-verified PLC program-source snapshot (blocks, PLC
  types/UDTs, tag tables) from the project that is already open in TIA Portal,
  and builds an offline index and execution model from it.
- Answers engineering questions offline from that snapshot: call graphs, block
  interfaces, symbol and data-flow traces, references, compact LAD/FBD/SCL text
  rendering of blocks, saved analysis notes.
- Observes the current Portal UI context (open project, selected block, network)
  and runs exact, read-only live queries against the open V20 project.
- Imports 1–20 block XML files into the open project through a plan → approve →
  apply gate with baseline backup, compile, readback comparison and rollback.
- Classic WinCC and WinCC Unified V20 HMI export, analysis and (unaccepted,
  plan-gated) authoring.

It never downloads to a PLC, goes online, forces values or writes PLC runtime data.

## Supported TIA Portal versions

Versions are declared in [`portal-versions.json`](portal-versions.json); the
project file extension selects the version, and there is no cross-version fallback.

| Version | Project | Snapshot export + offline analysis | Block import | Passive UI context | Live query / navigation / engineering inspect | HMI tools |
|---|---|---|---|---|---|---|
| V20 | `.ap20` | yes | yes | yes | yes | yes |
| V15.1 | `.ap15_1` | yes | yes | yes | no | no |
| V17 | `.ap17` | yes | yes | yes | no | no |
| V16, V18, V19 | | recognized and rejected (no adapter) | | | | |

A capability in the table is only an upper bound. It becomes available on a
machine only when the native companion for that exact version is built, is not
older than its sources and passes its offline self-test. `tia_doctor` reports
what is actually available. See [docs/multi-version-architecture.md](docs/multi-version-architecture.md).

Offline analysis tools work on any existing export directory and do not need TIA
Portal at all.

## Prerequisites

- Windows 10/11 x64.
- Node.js 20.11 or later with npm (tested with Node.js 24).
- Windows PowerShell 5.1 (`powershell.exe`, built into Windows). The tool never uses `pwsh`.
- .NET Framework 4.x C# compiler (`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`,
  present on standard Windows installs) to build the native companions.
- For anything that talks to TIA Portal: a licensed TIA Portal installation of a
  supported version **with the TIA Openness option installed**, and the Windows
  user in the local **"Siemens TIA Openness"** group.

### Siemens assemblies

This repository contains **no Siemens binaries**. The native companions are
compiled against `Siemens.Engineering.dll` from your local TIA Portal install
(`<Portal root>\PublicAPI\<version>\Siemens.Engineering.dll`). Resolution order
per version:

1. `TIA_MCP_API_DLL_<version>` (e.g. `TIA_MCP_API_DLL_V20`, `TIA_MCP_API_DLL_V15_1`, `TIA_MCP_API_DLL_V17`);
2. the legacy variable (`TIA_MCP_OPENNESS_API_DLL` for V20, `TIA_MCP_V15_1_API_DLL` for V15.1);
3. the Portal root from the registry (`HKLM\SOFTWARE\Siemens\Automation\_InstalledSW\TIAPxx\Global\Path`);
4. the standard root `C:\Program Files\Siemens\Automation\Portal Vxx`.

Built executables (`tools/*.exe`) are local build output and are ignored by Git.

## Install and build

```powershell
git clone <this repository> tia-mcp
cd tia-mcp
npm ci
npm run build            # TypeScript -> dist/
npm run doctor           # what is available on this machine; attaches to nothing
```

That is enough for the offline analysis tools. Build native companions for the
TIA Portal versions you have:

| Command | Builds |
|---|---|
| `npm run build:production` | TypeScript, then the five production companions: V20 importer, V20 resident live-query core, V20 HMI companion, V15.1 snapshot companion, V15.1 importer. Every component is staged, compiled and must pass its offline self-test before any installed executable is replaced; a failure rolls the whole batch back. **Requires both the V20 and V15.1 Openness APIs.** |
| `npm run build:v17` | V17 snapshot companion (`tools/TiaV15Snapshot.v17.exe`) and V17 importer (`tools/TiaOpennessImportBlock.v17.exe`). |
| `npm run build:native -- -Component <live-core\|importer\|hmi\|v15-snapshot> [-Version <V>]` | One companion for one version, e.g. `npm run build:native -- -Component importer -Version V20` when only V20 is installed. |
| `npm run build:live-core`, `npm run build:hmi-native`, `npm run build:v15-snapshot`, `npm run build:import-helper` | Single-component shortcuts. |

Every rebuilt companion triggers Siemens' Openness authorization prompt in Portal
on its first attach. After rebuilding, reconnect the MCP client so it loads the
new server.

## Register with an MCP client

The server speaks MCP over stdio: `node <repo>\dist\index.js`.

### Claude Code

```powershell
claude mcp add --transport stdio --scope user tia_portal -- node "C:\path\to\tia-mcp\dist\index.js"
claude mcp list
```

Add `--env NAME=value` options before `--` for any configuration below, e.g.
`--env TIA_MCP_ALLOWED_PROJECT_ROOTS=D:\TIA\Projects`. Start a new session and
check the connection with `/mcp`.

### Codex

Merge into `%USERPROFILE%\.codex\config.toml`:

```toml
[mcp_servers.tia_portal]
command = "node"
args = ['C:\path\to\tia-mcp\dist\index.js']
# Snapshot exports and imports can take minutes.
tool_timeout_sec = 900
env = { TIA_MCP_ALLOWED_PROJECT_ROOTS = 'D:\TIA\Projects' }
```

### Other stdio clients

```json
{
  "mcpServers": {
    "tia_portal": {
      "command": "node",
      "args": ["C:\\path\\to\\tia-mcp\\dist\\index.js"]
    }
  }
}
```

If the client cannot find `node`, use the absolute path from `Get-Command node`.
Do not auto-approve the write tools (`tia_apply_*`).

## Configuration

All settings are environment variables; none are required for offline analysis.

| Variable | Default | Purpose |
|---|---|---|
| `TIA_MCP_WORKSPACE_ROOT` | package root | Where snapshots, import evidence (`tia-openness-import/`) and HMI exports (`tia-exports/`) are written. |
| `TIA_MCP_OUTPUT_ROOT` | `<workspace>\tia-out` | Default snapshot output root for `tia_export_project_index` / `--export-snapshot`. |
| `TIA_MCP_ALLOWED_EXPORT_ROOTS` | — | Extra semicolon-separated roots that tools may read exports from or write to. |
| `TIA_MCP_ALLOWED_PROJECT_ROOTS` | `%USERPROFILE%\Documents\Automation` | Semicolon-separated roots for explicit TIA project paths. |
| `TIA_MCP_ALLOW_ANY_LOCAL_PATH=1` | off | Disable the export/output root allowlist for a deliberate session. |
| `TIA_MCP_ALLOW_ANY_PROJECT_PATH=1` | off | Disable the project root allowlist for a deliberate session. |
| `TIA_MCP_API_DLL_<V>` / `TIA_MCP_OPENNESS_API_DLL` / `TIA_MCP_V15_1_API_DLL` | discovered | Openness API DLL per version (see above). |
| `TIA_MCP_OPENNESS_API_XML` | beside the DLL | Optional API XML documentation. |
| `TIA_MCP_LIVE_CORE_EXE`, `TIA_MCP_V15_1_SNAPSHOT_EXE` | `tools\...` | Override the home-version executable of a companion. |
| `TIA_MCP_LIVE_CORE_IDLE_TIMEOUT_MS` | 1 hour | Idle timeout of a prepared live session (30000–86400000). |
| `TIA_MCP_HMI_READ_TIMEOUT_MS` | 120000 | HMI companion limit for inspect/export (10000–3600000; bundle export gets at least 600000). |
| `TIA_MCP_HMI_WRITE_TIMEOUT_MS` | 900000 | HMI companion limit for imports, edits and project creation. Expiry kills the companion and reports an unknown write outcome. |
| `TIA_MCP_ENABLE_NETWORK_PROBE=1` | off | Enable `plc_probe_ports` (read-only TCP reachability probe). |
| `TIA_MCP_ALLOWED_PROBE_HOSTS` | `127.0.0.1,localhost` | Exact host allowlist for the probe, e.g. `192.0.2.10,plc-host`. |
| `TIA_MCP_ALLOWED_PROBE_PORTS` | `102,4840,80,443` | Port allowlist for the probe. |

## Typical workflow

1. `tia_doctor` — what is ready, degraded, missing or stale. With
   `portalVersion` or `projectPath` it adds per-version capability status.
2. `tia_get_current_ui_context` — the running Portal processes, open project,
   selected block/network. Pass the returned `processId` to later calls when more
   than one Portal is open.
3. Live reads (V20): `tia_get_current_block`, `tia_query_live_project`,
   `tia_search_live_objects`, `tia_get_graph_context`. They attach an exact
   read-only session themselves when Portal is visible.
4. For whole-program analysis, `tia_export_project_index` once. The first call is
   an authorization preflight; keep Portal visible and repeat with explicit
   authorization readiness. Later snapshots reuse unchanged objects.
5. Offline: `tia_fast_lookup`, `tia_read_block`, `tia_search_export`,
   `tia_trace_call_graph`, `tia_trace_symbol`, `tia_trace_data_flow`. Save
   verified conclusions with `tia_save_analysis_note`.
6. Changes: `tia_create_import_plan` → human approval → `tia_apply_import`.

### First attach and Siemens authorization

The first Openness attach of a given executable makes TIA Portal show an
authorization dialog that a human must approve. The server never attaches
silently from a cold state: a cold `tia_prepare_live_session` /
`--prepare-live-session` first returns `portal_authorization_check_required`,
and a minimized Portal returns `portal_must_be_visible_for_authorization`. Keep
Portal in the foreground and approve the prompt.

## Import safety model (plan → approve → apply)

Block import is the only PLC-program write path. It is deliberately two-step:

1. **Plan** — `tia_create_import_plan` validates 1–20 candidate SimaticML block
   files (`blocks: [{ xmlPath, targetName, targetNumber }]`) against the exact
   open project. It returns a review and a short-lived (15 min), single-use
   confirmation token bound to: Portal PID and process-start time, canonical
   project path, every target block and candidate XML SHA-256, compile scope,
   the save choice (`saveProject` defaults to `false`), and the self-tested,
   version-selected importer and Openness API paths and SHA-256 hashes.
2. **Approve** — a human reviews the plan. The assistant must not approve its
   own plan; configure the client so `tia_apply_import` is never auto-approved.
3. **Apply** — `tia_apply_import` with the token and the same block list. It
   re-verifies identities and hashes, consumes the token once, then: exports a
   baseline of each target, imports, compiles (block or PLC-software scope),
   re-exports and compares program content, and rolls every imported block back
   on failure. A separate process then reads the blocks back independently.
   It never downloads to a PLC. With `saveProject: false` the project stays
   unsaved for review in TIA Portal.

Any identity, hash, file or block-list change between plan and apply blocks the
import; never replay a token, create a new plan. HMI write tools use the same
single-use plan store. See [docs/current-ui-context.md](docs/current-ui-context.md)
and [docs/live-openness.md](docs/live-openness.md).

## Tools (47)

| Area | Tools |
|---|---|
| Diagnostics | `tia_doctor`, `plc_probe_ports` (disabled by default) |
| UI context and live V20 session | `tia_get_current_ui_context`, `tia_prepare_live_session`, `tia_get_current_block`, `tia_query_live_project`, `tia_search_live_objects`, `tia_get_graph_context`, `tia_navigate_live_object`, `tia_inspect_engineering` |
| Snapshots and indexes | `tia_export_project_index`, `tia_list_export_indexes`, `tia_read_export_index`, `tia_reanalyze_snapshot`, `tia_build_reference_index` |
| Offline analysis | `tia_read_block`, `tia_search_export`, `tia_fast_lookup`, `tia_trace_call_graph`, `tia_trace_symbol`, `tia_trace_data_flow`, `tia_save_analysis_note`, `tia_search_analysis_notes` |
| Block import | `tia_create_import_plan`, `tia_apply_import` |
| HMI read and analysis | `tia_list_hmi_targets`, `tia_export_hmi_configuration`, `tia_read_hmi_alarm_export`, `tia_analyze_hmi_alarms`, `tia_export_hmi_native`, `tia_export_hmi_bundle`, `tia_inspect_unified_hmi`, `tia_hmi_authoring_capabilities` |
| HMI authoring (classic WinCC) | `tia_generate_hmi_design`, `tia_preview_hmi_design`, `tia_edit_hmi_native`, `tia_edit_hmi_text`, `tia_update_hmi_object`, `tia_create_hmi_import_plan`, `tia_apply_hmi_import`, `tia_create_hmi_project_plan`, `tia_apply_hmi_project` |
| HMI authoring (WinCC Unified) | `tia_generate_unified_hmi_design`, `tia_create_unified_hmi_project_plan`, `tia_apply_unified_hmi_project`, `tia_create_unified_hmi_edit_plan`, `tia_apply_unified_hmi_edit` |

`node dist/index.js --list-tools` prints the registered catalog. HMI authoring
has not passed native acceptance; see [docs/hmi-authoring-status.md](docs/hmi-authoring-status.md).

## CLI

The CLI shares the capability checks and resident-query implementation with MCP:

```powershell
npm run doctor                                   # same as node dist\index.js --doctor
node dist\index.js --doctor --require core-read
npm run prewarm                                  # start/fingerprint the helper; no attach
node dist\index.js --prepare-live-session --process-id <PID>
node dist\index.js --prepare-live-session --process-id <PID> --confirm-portal-authorization-ready
node dist\index.js --live-query --process-id <PID> --resource-kind block --name Main --number 1
node dist\index.js --live-batch --input .\queries.json
node dist\index.js --export-snapshot --process-id <PID> --project-path '<project>.ap20'
node dist\index.js --export-snapshot --process-id <PID> --project-path '<project>.ap20' --confirm-portal-authorization-ready
```

`queries.json` is an array or `{ "queries": [...] }`; each item has a unique
`operationId`, `resourceKind`, exact `name` and optional `number`, `blockKind`
or `softwarePath`.

## Tests

| Command | Needs |
|---|---|
| `npm test` (= `npm run test:all`: `test:unit` + `test:smoke`) | Windows, Node.js, Windows PowerShell 5.1 and the .NET Framework `csc.exe`. No TIA Portal. Tests that execute real built companions or the real Openness API skip themselves when those are absent. |
| `npm run test:import-gate`, `npm run test:live-core` | Built companions and `TIA_MCP_OPENNESS_API_DLL`; otherwise those tests skip. |
| `npm run test:integration` | A running Portal and `TIA_IMPORT_TEST_PROCESS_ID`, `TIA_IMPORT_TEST_PROJECT_PATH`, `TIA_IMPORT_TEST_XML_PATH`, `TIA_IMPORT_TEST_TARGET_NAME`, `TIA_IMPORT_TEST_TARGET_NUMBER`. Creates a plan and verifies that a mismatched apply is blocked; it imports nothing. |
| `node scripts/read-only-live-smoke.mjs <PID> '<GRAPH block>' <transition> --authorization-ready` | A running V20 Portal; read-only. |

All test fixtures are synthetic. Use copies of test projects for any live
verification, never production projects.

## Documentation

- [Live Openness queries](docs/live-openness.md)
- [Current UI context](docs/current-ui-context.md)
- [Multi-version architecture](docs/multi-version-architecture.md)
- [Engineering diagnostics](docs/engineering-diagnostics.md)
- [HMI export](docs/hmi-export.md), [HMI alarm analysis](docs/hmi-alarm-analysis.md)
- [HMI authoring status](docs/hmi-authoring-status.md), [requirements](docs/hmi-authoring-requirements.md), [classic workflow](docs/hmi-authoring.md), [Unified workflow](docs/hmi-unified.md)
- [PowerShell 5.1 rules](docs/powershell-5.1.md)

## Limitations

- No PLC download, upload, online monitoring, forcing or runtime value access.
  Online monitoring would need a separate PLC Web API, OPC UA or S7 read path.
- Live queries, navigation, engineering inspection and HMI tools are V20 only.
- Not verified: imports that change logic followed by a real save,
  fault-injected rollback, FB imports with instance DBs on V17, know-how
  protected blocks, and native acceptance of HMI authoring.
- Siemens, SIMATIC, TIA Portal and WinCC are trademarks of Siemens AG. This
  project is not affiliated with or endorsed by Siemens.
