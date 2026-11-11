# Multi-version architecture

Goal: supporting another TIA Portal version means adding one row to the version
table and building that version's native companions, without changing the
TypeScript tool code. Adding a feature means writing one native operation and one
tool definition.

## Principles

1. **Versions are defined once.** `portal-versions.json` is the single source,
   read by the TypeScript server (`src/tia-version.ts`) and by the native build
   (`tools/Build-TiaNative.ps1`).
2. **Switch on capabilities, not version numbers.** Tools call
   `requireCapability(project, "<capability>")`; they never test
   `version === "Vxx"` or `.ap20`.
   - A version row's capabilities are the **allowed upper bound** (policy).
     Project-path validation and whether a companion may be built for the version
     use it. Offline features (for example reusing existing exports) only need this layer.
   - **Actual availability** is decided by self-test: a companion built for that
     version must exist, must not be older than its sources, must pass its offline
     self-test and must report the capability. Places that launch a companion per
     version (snapshot export, block import) select it through `verifiedProvider()`.
   - Capabilities a companion reports but the version row does not allow are never
     enabled; diagnostics list them as `undeclaredReported`.
3. **Exact selection, no cross-version fallback.** The project file extension
   decides the version. A V15.1 or V17 project is never handed to the V20 API;
   recognized but unadapted versions are rejected.
4. **One native source, compiled per version.** The build generates
   `TiaBuildTarget` constants from the version table and references that version's
   `Siemens.Engineering.dll`; API differences live only in the compatibility layer.
5. **One write gate.** Single-use tokens, pre-write baselines, exclusive access,
   compilation and independent readback are shared by all versions. Tokens and
   plans are managed by `src/plan-store.ts`.

## Layers

| Layer | Location | Responsibility |
|---|---|---|
| Version table | `portal-versions.json`, `src/tia-version.ts` | Extension, registry key, PublicAPI folder, assembly version, adapter, capabilities; install discovery and DLL resolution |
| Native build | `tools/Build-TiaNative.ps1` | Generate `TiaBuildTarget` per version, compile against that version's DLL, offline self-test, atomic replacement |
| Native adapters | `live-core/*.cs`, `live-core/Common/TiaNativeTarget.cs` | Attach, export, import, compile; version identity from compile-time constants; self-test reports `target` (version, API major/minor, extension) and implemented `capabilities` |
| Server | `src/core/*`, `src/plan-store.ts`, domain modules, `src/tools/*`, `src/index.ts` | See "Server modules"; only looks at capabilities |
| Analysis | `execution-model.ts`, `knowledge.ts`, ... | Parses SimaticML into analysis models, version independent |

## Server modules

Dependencies point downwards and there are no cycles.

| Layer | Modules | Content |
|---|---|---|
| Base | `core/local-paths.ts`, `core/process.ts`, `core/results.ts`, `core/simatic-xml.ts`, `core/simatic-objects.ts` | Install paths and allowed roots, process launch, tool result format, Simatic ML parsing |
| Version and gating | `tia-version.ts`, `plan-store.ts`, `native-capabilities.ts` | Version and component tables, allowed capabilities; single-use plan tokens; companion self-test probing and verified capabilities |
| Domain | `export-index.ts`, `export-query.ts`, `live-session.ts`, `environment.ts`, `snapshot-workflow.ts`, `plc-importer.ts` | Export index and execution model; index queries; live sessions and queries; environment checks (including `SERVER_VERSION`); snapshot workflow; importer candidate validation and offline self-test |
| Tools | `tools/hmi.ts`, `tools/live.ts`, `tools/environment.ts`, `tools/export-analysis.ts`, `tools/plc-import.ts`, ... | Each file exports one `registerXxxTools(server)` |
| Entry | `index.ts`, `cli.ts` | Tool catalog, registration, `main`; command line |

Only `index.ts` imports `tools/*`; domain modules never import the tool layer.
A new tool goes into the matching `tools/*` file and its name into
`toolCatalog` in `index.ts` (the smoke test checks that both agree).

## Version table fields

| Field | Meaning |
|---|---|
| `id` | Version, e.g. `V15.1` |
| `projectExtension` | Project extension, e.g. `.ap15_1` |
| `registryKey` | `HKLM\SOFTWARE\Siemens\Automation\_InstalledSW\<key>`; its `Global\Path` is the Portal root |
| `apiFolder` | Sub-folder in `PublicAPI\<folder>\Siemens.Engineering.dll` |
| `apiAssembly` | Required assembly major/minor version |
| `apiDllEnv` / `legacyApiDllEnv` | Environment variables that override the version's DLL path |
| `installRoots` | Fallback Portal roots when neither environment nor registry resolves |
| `adapter` | Native companion family implementing the version; `null` means recognized only |
| `capabilities` | Capabilities the version **allows** (upper bound); actual availability is decided by self-test |
| `apiFeatures` | API features of that version, from the top-level `apiFeatureNames` (typos fail). The build defines `TIA_API_<NAME>` for each; missing ones compile fallback code |

DLL resolution order: `apiDllEnv` → `legacyApiDllEnv` → registry root → `installRoots`.

### API features and compatibility layer

The same C# source compiles per version. API differences are concentrated in a
compatibility layer (for the resident core, `live-core/LiveCoreApiCompat.cs`)
selected with `#if TIA_API_<NAME>`. V20 defines all symbols. A version lacking a
feature compiles the fallback and reports the feature as unavailable instead of
crashing or pretending to have it.

| Feature | V20 | V15.1 / V17 | Behavior when missing |
|---|---|---|---|
| `cross_reference` | yes | no | Cross-references return `supported: false`, `not_available_in_portal_version` |
| `object_identifier` | yes | no | Official identifier returns `service_unavailable` |
| `block_interface` | yes | no | Direct DB interface read unavailable; block XML required |
| `software_namespaces` | yes | no | Namespace empty; `namespace` attribute field marked unavailable |
| `safety_tags` | yes | no | `isSafety` field marked unavailable |
| `local_sessions` | yes | no | No local session count in diagnostics |

Every companion's self-test reports the compiled features in
`target.apiFeatures`. The build and the server require an exact match with the
version row; otherwise the companion is not accepted.

### Preview builds

`Build-TiaNative.ps1 -Preview` builds a component for a version whose row belongs
to the component's adapter family even before the row allows the capability, for
testing before enablement, e.g. `-Component live-core -Version V15.1 -Preview`.
The server never probes or launches preview outputs.

## Component table fields

`components` in `portal-versions.json`, shared by the native build and the server.

| Field | Meaning |
|---|---|
| `id` | Component name, the build's `-Component` argument |
| `adapters` | Adapter families served by the component. A component can be built for a version when the version's `adapter` is listed and the row allows `buildCapability`. The importer serves `live-core` and `v15-snapshot`, so V20, V15.1 and V17 each get an importer |
| `buildCapability` | Capability the version row must allow for this component to be built |
| `baseName`, `outputDir` | Executable name and output directory (relative to the package). The component's home version uses `<baseName>.exe`, other versions `<baseName>.<version>.exe`, e.g. `TiaOpennessImportBlock.v15_1.exe` |
| `sources` | Source files (relative to the package), used for build and staleness checks; `Common/TiaNativeTarget.cs` and the version table always count |
| `selfTestArgs` | Offline self-test arguments; `{api}` is replaced by the version's DLL |
| `exeEnv` | Optional; overrides only the home version's executable path |

Compiler options and references (`/optimize+`, `System.Web.Extensions.dll`, ...)
live only in `tools/Build-TiaNative.ps1`.

The self-test output must contain
`"target": { "portalVersion", "apiAssembly", "projectExtension" }` and
`"capabilities": [...]`. The server accepts only results whose version and API
match the row, with exit code 0 and `ok: true`. Results are cached by executable
and DLL path, modification time and size.

## Capabilities

| Capability | Meaning |
|---|---|
| `passive_ui_context` | Passive UI context observation |
| `snapshot_export` | PLC program-source snapshot export |
| `live_query` | Resident-core live queries |
| `navigation` | Locating objects in the editor |
| `engineering_inspect` | Read-only hardware, network and HMI diagnostics |
| `block_import` | Plan-gated block import |
| `hmi_export` | HMI configuration export |
| `hmi_authoring` | HMI authoring |

## Current version support

| Version | Adapter | Allowed capabilities |
|---|---|---|
| V20 | `live-core` | all of the above |
| V15.1 | `v15-snapshot` | `passive_ui_context`, `snapshot_export`, `block_import` |
| V17 | `v15-snapshot` | `passive_ui_context`, `snapshot_export`, `block_import` (`apiFeatures` empty) |
| V16, V18, V19 | none | recognized and rejected |

Live queries and HMI tools use the default (V20) companions only.

## Adding a version

1. Install that TIA Portal version with Openness and add the current user to the
   "Siemens TIA Openness" group.
2. Add a row to `portal-versions.json`, or complete an existing recognized-only
   row with an `adapter`. List only `apiFeatures` confirmed against that version's
   `Siemens.Engineering.dll`. Leave `capabilities` empty or list only verified ones.
3. Build a preview and run the offline self-test, e.g.
   `npm run build:native -- -Component live-core -Version V16 -Preview`
   (output `tools/TiaLiveReadCore.v16.exe`).
   - A compile error means the version lacks an API: add a feature to
     `apiFeatureNames`, add fallback code under `#if`, and add the feature to the
     rows that have it.
   - Remove a capability from the self-test report when the version cannot provide it.
   - Add the capability to the row only after it passes on a copy of a test
     project; then build normally (without `-Preview`).
   - Import plans record the version's importer path and hash; apply revalidates
     with that version's own self-test, never the default version's.
4. Run `tia_doctor` with `portalVersion` and check
   `environment.portalVersions[].capabilities` (verified) and `components`.
5. Run read, export, import, compile and readback against a **copy** of a test
   project for that version. Never use a production project.

## Approaches not taken

- **Pure reflection adapters**: no compile-time checking, verbose, only testable against fake APIs.
- **One executable swapping DLLs at runtime** (AssemblyResolve to another version): not supported by Siemens; signature mismatches surface only at runtime.
- **Opening older projects in a newer Portal**: upgrades and changes the project.
