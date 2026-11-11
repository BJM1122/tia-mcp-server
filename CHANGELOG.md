# Changelog

## 0.29.0 — 2026-11-10

First standalone public distribution of the TIA Portal MCP server.

- Adds TIA Portal V17 (`.ap17`) through the same native companion family as
  V15.1: PLC program-source snapshot export (`tia_export_project_index`),
  single- and multi-block import (`tia_create_import_plan` / `tia_apply_import`)
  and passive UI context (`tia_get_current_ui_context` with `portalVersion: "V17"`).
  Offline analysis tools work on V17 exports as on any other export. V17 has no
  live query, navigation, engineering inspection or HMI tools; its `apiFeatures`
  are empty. Build its two companions with `npm run build:v17`.
- Snapshot-adapter environment checks are version specific
  (`validateSnapshotAdapter(version)`); missing, stale or failed companions are
  reported with version and executable name.
- Project extensions in tool descriptions are generated from the version table.
- Distribution changes:
  - The single-block importer source `TiaOpennessImportBlock.cs`, previously kept
    beside the package, is now part of the repository at
    `live-core/TiaOpennessImportBlock.cs`; all native companions, including the
    importer, are built into `tools/`.
  - Host-specific paths, captured project identities, site-specific scripts,
    validation logs and private Git history were removed. Default paths are now
    neutral and configurable: generated data goes under the package root (or
    `TIA_MCP_WORKSPACE_ROOT`), snapshots default to `<workspace>/tia-out`
    (`TIA_MCP_OUTPUT_ROOT`), and explicit project paths default to
    `%USERPROFILE%\Documents\Automation` (`TIA_MCP_ALLOWED_PROJECT_ROOTS`).
    Siemens Openness DLLs are resolved from environment variables, the registry or
    the standard `C:\Program Files\Siemens\Automation\Portal Vxx` install root.
  - The integration smoke script that depended on private exports was removed;
    `npm run test:integration` now runs only the environment-driven live import
    plan test. Test fixtures are synthetic.
  - Documentation is in English.

Upgrade note: `portal-versions.json` is a build input of every native companion,
so after changing it all companions are reported stale until
`npm run build:production` (and `npm run build:v17` when V17 is used) rebuilds
them. Each rebuilt executable triggers the Siemens Openness authorization prompt
on its first attach. Portal must be visible for that first attach.

Not verified by this release: imports that change logic, real saves after import,
fault-injected rollback, FB imports with instance DBs on V17, and know-how
protected blocks.

## Earlier history (0.10 – 0.28, summary)

- **0.28** — Tool surface reduced from 63 to 47 tools by merging overlapping
  tools into `tia_doctor`, `tia_read_export_index`, `tia_get_current_block`,
  `tia_query_live_project`, `tia_read_block`, `tia_search_export`,
  `tia_fast_lookup`, `tia_trace_call_graph`, `tia_create_import_plan` and
  `tia_apply_import`. Live queries and import plans attach a cold session
  themselves when Portal is visible; a minimized Portal returns
  `portal_must_be_visible_for_authorization`.
- **0.27** — Import plans and independent readback reuse the resident V20 core
  (`verify_session`, `export_blocks_for_signature`) with exact PID, process-start
  and project-path checks and a safe fallback to the importer's own attach.
  Content-based dependency stamps for incremental snapshots. One shared apply
  pipeline for single-block and multi-block import (`src/tools/import-apply.ts`),
  one timeout bound shared by TypeScript and the importer, `compileScope:
  "software"` with baseline compile and time-budget checks, faster multi-block
  verification. Windows PowerShell 5.1 rules enforced by tests.
- **0.24 – 0.26** — Compact text block reader (`tia_read_block`) rendering
  LAD/FBD networks from parts and wires and SCL as source; analyzer support for
  box instructions; ENO and parallel-branch fixes; incremental snapshot reuse
  of unchanged objects; faster modification-state reads; smaller export index
  listings; `tia_reanalyze_snapshot`; summary/detail levels for snapshot results.
- **0.21 – 0.23** — Multi-version architecture: one version/component table
  (`portal-versions.json`), registry install discovery, capability-based gating,
  per-version native builds (`tools/Build-TiaNative.ps1`), self-test-verified
  capabilities, API-feature compatibility layer, a shared single-use plan store
  for all write paths. Read-only V15.1 program-source snapshot adapter and
  version-selected V15.1 block import.
- **0.20** — Siemens HMI authoring with separate classic WinCC V20 and WinCC
  Unified V20 adapters, exact single-use write plans, isolated project creation,
  scoped edits and offline previews (`TiaHmiNative.exe`). Native acceptance is
  still pending; see `docs/hmi-authoring-status.md`.
- **0.10 – 0.14** — Resident read-only V20 live-query core, exact-session
  attach with explicit Portal authorization, GRAPH write-index support, WinCC
  alarm workbook reading and HMI alarm analysis, execution-model based symbol
  and data-flow tracing, analysis notes bound to export signatures.
