# Live TIA Portal V20 Openness Queries

This document defines the fast path for inspecting the exact project already
open in TIA Portal V20. It is generic across S7-1200 and S7-1500 projects and
contains no project-name, CPU, or block-number special case.

`project_mismatch` failures include `diagnostics` with the verification phase,
PID, expected and descriptor project paths, and observed project paths. The
reason distinguishes a descriptor mismatch, an empty project collection,
different attached paths, and multiple exact matches. Counts are null when the
project collection was not enumerated; `observedPathSource` identifies whether
the evidence came from the descriptor, selected project, or project collection.
At most 20 paths are returned, with full counts and an explicit truncation flag.
These diagnostics do not relax identity checks or select another project.
After-attach failures also include the API's reported project count, local-session
count, and loaded Openness assembly identity. Supplemental count failures are
reported separately without hiding the original mismatch.

The live path is intentionally narrower than the complete PLC program-source snapshot:

- attach to one exact existing Portal process and one exact already-open
  `.ap20` project;
- query allowlisted public Openness properties and Step7 cross-references;
- export only one resolved PLC block to temporary XML when its body or complete
  interface is required; and
- keep UI navigation separate from pure read/query tools.

It does not read TIA internal databases, create a persistent live reference
index, or treat UI text as proof of PLC runtime or physical state.

## Primary Evidence

The implementation was checked against the V20 public assembly
(`Siemens.Engineering.dll`, assembly version `20.0.0.0`) and the XML
documentation installed beside it:

```text
<Portal V20 root>\PublicAPI\V20\Siemens.Engineering.xml
```

Important documented members include:

- `CrossReferenceService.GetCrossReferences(CrossReferenceFilter)`;
- `CrossReferenceResult.Sources`, `SourceObject.References`, and
  `ReferenceObject.Locations`;
- `Location.Access`, `ReferenceType`, `ReferenceLocation`, `ReferencedAs`, and
  `ReferencedAsName`;
- `PlcBlock.Export(FileInfo, ExportOptions)`;
- direct `PlcBlock`, `DataBlock`, `InstanceDB`, `PlcType`, `PlcTagTable`, and
  `PlcTag` properties; and
- `PlcBlock.ShowInEditor()`, `PlcType.ShowInEditor()`, and
  `PlcTagTable.ShowInEditor()`.

The V20 API exposes no general external getter for the current Project-tree or
editor selection. The Add-In `MenuSelectionProvider` is a different, in-process
Add-In context. Therefore current selection is observed through the bounded
accessibility companion, while process/project identity and engineering data
are revalidated through official Openness APIs.

## Exact Session and Ownership Lifecycle

The live request follows this chain:

1. `tia_get_current_ui_context` obtains Portal process diagnostics and bounded
   accessibility evidence. A caller-supplied PID is honored exactly; no
   `GetProcesses().First()` or project-name fallback is allowed.
2. The request proceeds only with an exact PID, OS process-start identity, and
   canonical `.ap20` path.
3. A cold session first returns `portal_authorization_check_required` without
   Attach. After Portal is visible and the engineer has been explicitly told to
   approve the Siemens Openness prompt, only `attach_session` may call
   `TiaPortal.GetProcess(pid, timeout)` and Attach. It verifies the descriptor's
   canonical `ProjectPath` and requires exactly one attached `Project.Path`
   equal to the requested path.
4. The session cache key includes PID, OS process start time, and canonical
   project path. A PID reused by another process is not treated as the same
   session.
5. The core builds a typed, in-memory object inventory for that exact attached
   session and reuses it for exact object resolution. This is not an export or
   cross-reference index. Direct attributes and cross-references are read on
   demand.
6. MCP and CLI clients share the same per-user, per-Core-binary and per-API-
   binary named pipe.
   Pipe ACL creation fails closed, protocol version and request ID are
   validated, and requests are serialized. The default one-hour idle
   timeout ends only the helper and disconnects its additional Openness
   session.
7. Before accepting a successful response, the caller revalidates the returned
   PID, canonical project path, and required OS process-start identity against
   the UI context. A mismatch fails the whole request.

`TiaPortalProcess` is a descriptor and is never disposed because that operation
can close the user's Portal process. The core owns only its attached
`TiaPortal` session. Disposing that attached handle disconnects the helper; it
does not save or close the user's already-open project. A strict request
watchdog may terminate the helper if an Openness call blocks, but the helper
does not own or terminate TIA Portal.

Every mismatch, missing selection, ambiguous object, timeout, access denial, or
unsupported operation is returned explicitly. One request deadline is carried
across UI observation, session/query work, and response validation; the helper
watchdog terminates only the helper if an Openness call exceeds it. No first
match is selected.

## Capability Matrix

| Need | Evidence path | Support and boundary |
|---|---|---|
| Current Portal PID and project | Official process diagnostics plus bounded UI context | Exact PID and canonical `.ap20` path are required and revalidated before attach. |
| Current selected/open PLC block | Bounded UI observation, then exact typed Openness resolution | Supported when one block identity is exposed. Ambiguous or missing UI state fails closed. |
| Block identity and attributes | Direct `PlcBlock` public getters | Name, namespace, number, subtype, language, dates, consistency, protection, memory layout, and allowlisted headers are direct API evidence. |
| Global/instance DB companion data | Direct typed block model | DB subtype and `InstanceDB.InstanceOfName` are direct. Resolving the named FB/UDT is a separate exact query; no name-only guess is made. |
| DB interface | Direct `DataBlock.Interface.Members` plus required-on-demand single-block XML for a full interface | Direct API gives member names. Those names alone are explicitly incomplete. Full sections, datatypes, nested schema, start values, remanence, and accessibility come from that block's temporary XML, and completion waits for successful local parsing. |
| FB/FC/OB interface | Single-block temporary XML | V20 exposes no equivalent strongly typed code-block `Interface` property. |
| PLC type/UDT identity and attributes | Direct `PlcType` public getters | Exact object, namespace, dates, consistency, protection, hierarchy, and official identity when available are direct. Full UDT member schema is not yet exported by the live tool and is reported unavailable rather than inferred. |
| Tag table | Direct `PlcTagTable` public getters | Exact table, group, counts, default flag, and timestamp are direct. |
| PLC tag | Direct `PlcTag` public getters | Exact parent table, name, datatype, logical address, external access flags, safety flag, and localized comments are direct. |
| References and access locations | Direct `CrossReferenceService.GetCrossReferences(AllObjects)` | Sources, references, locations, reference type, access kind, and textual location are direct when the service is exposed for the resolved object. |
| Caller/callee | Derived only from direct cross-reference fields | A call edge is labelled only for `Uses`/`UsedBy` with `Call`, `UC`, or `CC` access. Other references remain references; they are not guessed as calls. |
| Resolvable engineering-object identity | `UnderlyingObject`/`ReferencedAs` plus `ObjectIdentifierProvider` when available | Runtime type and official identifier are returned when V20 exposes them. Null member-level objects or unavailable identifiers stay explicit. |
| LAD/FBD/SCL/GRAPH body | Official `PlcBlock.Export` to one unique temporary XML, then existing Simatic ML parsers | Supported for one exact resolved block. It is not a direct body getter and does not export the project. Analyzer output is heuristic and bounded; reported source lines are Simatic ML XML lines, never claimed TIA editor/network line numbers. |
| Open exact object/editor | Explicit `tia_navigate_live_object` using `ShowInEditor` | Supported for blocks, PLC types, and tag tables after `confirmNavigation: true`. A PLC tag opens only its exact parent table and returns partial; no tag-row selection is claimed. |
| Select a visible network/section | Separate opt-in accessibility fallback | Attempted only when official navigation proves the exact requested object was opened, never when a PLC tag merely opened its parent table. It requires an exact ordinal label, exact PID/start/canonical-project identity, complete bounded enumeration, one unique visible match, and verified selection. The exact official session is revalidated before enumeration, immediately before interaction, and after interaction before success is reported. Focus alone is partial. No fuzzy text, coordinates, screenshots, or `Invoke` action. |
| Exact official network/line navigation | No documented public V20 API found | Unsupported. `ReferenceLocation` is returned as evidence and is never treated as a navigation handle. |
| Unsaved editor buffer | Not established by public API documentation or live proof | A block export reflects the engineering object made available to Openness; inclusion of unsaved editor text must not be assumed. |
| Actual PLC values, online status, force, download, or physical feedback | Outside this layer | Unsupported and never attempted by these tools. |
| Complete/repeated PLC program execution analysis | `tia_export_project_index` one-shot official export plus offline execution model | Exports every PLC block, PLC type/UDT, and whole tag table only after exact-session authorization, then preserves guards, effects, order, call/instance contexts, and explicit coverage gaps. The native export creates a verified candidate; `current.json` changes only after manifest/XML revalidation and execution analysis complete. Hardware/network/HMI objects and live PLC values remain outside this snapshot. |

The in-memory object inventory is reused for latency and aged independently by
resource kind. A kind expires after 60 seconds. A cached `not_found` can force
one bounded rebuild, never a loop; `refreshInventory=true` or CLI
`--refresh-inventory` deliberately rebuilds a kind after an add, delete, or
rename. Batch queries suppress repeat full scans after the first miss refresh
and force at most one requested refresh per kind. Attribute and cross-reference
reads on an already resolved object are still performed on demand.

Composite tools publish component completeness for session identity, object
resolution, attributes, cross-references, interface, program body, and
temporary-file cleanup. A requested component that is unavailable, truncated,
failed, or not cleanup-verified makes the overall result `partial`; a top-level
success never hides an incomplete requested evidence layer. A correctly hashed
temporary XML payload that the local Simatic ML parser rejects is also
`partial`, with both top-level and nested completion flags set to false. The
same rule applies when parsing succeeds but `interfaceLimit` or
`bodyEvidenceLimit` truncates returned members, references, or flows; those
local components are reported separately as truncated.

The accessibility fallback has static, parser, and synthetic-boundary
verification only. It was not exercised against the live TIA editor during the
read-only verification run, so actual control-pattern support and exact
network/section selection remain unverified until a user explicitly opts into a
live navigation test. Failure to verify selection must stay `partial`; it must
not be promoted from label or focus evidence alone.

## Cross-Reference Semantics

The direct result shape is:

```text
CrossReferenceResult
└─ Sources
   ├─ SourceObject.UnderlyingObject
   ├─ References
   │  ├─ ReferenceObject.UnderlyingObject
   │  └─ Locations
   │     ├─ Access
   │     ├─ ReferenceType
   │     ├─ ReferenceLocation
   │     └─ ReferencedAs
   └─ Children
```

There are no literal `Caller` and `Callee` properties in the V20 result. The
server preserves the official hierarchy and adds a clearly marked derived call
edge only when direction and call access are both sufficient:

- `Uses` plus `Call`/`UC`/`CC`: source is caller, reference is callee.
- `UsedBy` plus `Call`/`UC`/`CC`: reference is caller, source is callee.

Read/write locations remain direct `Location.Access` evidence. Result, depth,
source, reference, and location bounds are reported with truncation flags.

## Temporary Single-Block XML

Program bodies and complete code-block interfaces require the official export
format; V20 does not expose them as a stable direct object graph.

For an opted-in block query, the core:

1. creates a GUID-named per-request directory and XML file under the process
   temporary directory;
2. calls `PlcBlock.Export(..., ExportOptions.WithDefaults)`;
3. enforces one shared maximum of 25 MB before accepting, hashing, and reading
   the file;
4. deletes the file and per-request directory in `finally` and verifies both
   are absent; and
5. returns XML bytes to the TypeScript parser only after cleanup succeeds.

If deletion cannot be verified, the XML payload is withheld and the operation
returns `cleanup_failed`. No long-lived XML file, full-project export, or
persistent live index is created. The resident core also performs bounded stale
request-directory cleanup at startup: only GUID-named directories under its
private temporary root that are older than 24 hours are eligible, and cleanup
status is reported. This prevents a prior helper crash from silently turning
temporary evidence into an unmanaged export cache.

Know-how protection, inconsistent blocks, access restrictions, unsupported
block kinds, or export failures remain explicit. Raw XML is excluded by default
and must be requested separately.

## Field Provenance

| Returned field | Provenance label |
|---|---|
| `context`, selected/open block, network/section | Official process diagnostics plus bounded accessibility observation |
| `exactLiveIdentity.processId/projectPath` | Exact UI-context PID/path, then direct descriptor and attached `Project.Path` verification |
| object hierarchy and selectors | Direct typed V20 compositions, cached in memory for the exact session |
| `directLive.object.identity` | Typed object properties and `ObjectIdentifierProvider` where available |
| `directLive.object.attributes.*` | Named allowlisted public getter; each field reports its API member |
| `directLive.crossReferences.*` | Official Step7 `CrossReferenceService`; caller/callee is separately marked derived |
| `temporaryBlockEvidence.interface/programBody` | One official temporary block Simatic ML export, then existing parser; body analysis is labelled heuristic and line numbers refer only to XML |
| `officialNavigation` | Explicit public `ShowInEditor` action |
| `uiAutomationFallback` | Separate exact-label accessibility action with its own bounds and verification |
| offline index/cache fields | Not used by live tools; present only in explicitly chosen offline tools |

Do not collapse these layers in explanations. In particular, an exported
network, a command bit, an HMI indication, and actual field feedback are
different kinds of evidence.

## MCP and CLI Entry Points

Pure query tools:

- `tia_get_current_ui_context`
- `tia_get_current_block`
- `tia_query_live_project`

Explicit UI action:

- `tia_navigate_live_object`

The CLI uses the same resident core:

```powershell
node .\dist\index.js --live-core-status
node .\dist\index.js --live-current-block --include-body
node .\dist\index.js --live-query --resource-kind block --name OB1
```

Pass `--process-id` when more than one TIA Portal session is visible. CLI
process exit does not close the resident core or the user's TIA project.
Raw XML is opt-in because it can make a response large; parsed bounded evidence
should be preferred. The structured payload is authoritative and human-facing
text should remain a short summary rather than a second copy of a large XML or
JSON body.

## Performance Verification Worksheet

Use the same PID, canonical project path, and block for each comparison. Record
both wall-clock duration and the core's per-phase `timings`; preserve status,
counts, truncation, and XML hash so a faster failure is not mistaken for a
successful query.

| Scenario | Required measurement |
|---|---|
| Current UI context only | Wall-clock `tia_get_current_ui_context`, status and official `TiaPortal.GetProcesses()` count |
| Cold core | Helper start + exact attach + first in-memory inventory + direct metadata |
| Warm direct query | Same exact object, body and cross-references disabled |
| Warm cross-reference query | Same exact object, cross-references enabled, body disabled |
| Single-block temporary body | Same exact block, body enabled, cleanup verified |
| Existing offline lookup | `tia_get_current_block` (`source: "export"`) against an exactly matched snapshot |

Run at least one cold query and two warm queries. Do not restart TIA, the MCP client, or
the active connector merely to produce timings. Navigation is excluded from the
read-only performance run because it changes visible UI state.

When the bounded official context read exposes no Portal session, do not retry
attach, start/restore/focus Portal, or navigate the UI to obtain a number. A
resident-core status diagnostic is not latency evidence if its outer command
stays alive until helper idle shutdown. Leave live rows unverified rather than
filling them with helper-start or failure timing.

## Mutation and UI Boundaries

The live query core contains no project open/close/save, compile, import,
download, force, online, or arbitrary reflection operation. Query tools do not
click, focus, poll, screenshot, or navigate the UI.

`tia_navigate_live_object` is deliberately separate because it changes visible
UI state. It requires explicit confirmation and never claims project-content
mutation. The optional accessibility fallback requires a second opt-in and can
only select one unique exact accessible label after official navigation proves
the exact requested object opened. It independently rechecks exact PID,
process-start time, and canonical `.ap20` path through
`TiaPortal.GetProcesses()` before enumeration, immediately before its first
action, and after the action before claiming success. A parent-process timeout
is authoritative; no UIA provider call is allowed to turn a bounded request
into unbounded polling.

Project-content mutation is implemented only through the separate
`tia_create_import_plan` and `tia_apply_import` tools. It does not reuse query
authorization. Its gates are:

1. dry-run plan with exact target object and proposed delta;
2. exact PID, process-start identity, canonical project path, candidate XML
   digest, self-tested importer SHA-256, and the selected V20 API canonical
   path, assembly version, and SHA-256;
3. explicit approval tied to that immutable plan;
4. verified backup and rollback path;
5. compile-before-save with complete returned diagnostics; and
6. pre-save verification export plus failure rollback attempt.

Download, force, online access, and PLC runtime operations remain separate and
out of scope.

## Public Implementations and License Decisions

Official V20 documentation and Siemens public API patterns are the primary
design evidence.

- Siemens TIA Openness Explorer and the MIT-licensed official code snippets
  were used as API-discovery/reference material, not as runtime dependencies.
  Their general attach/navigation examples do not replace this implementation's
  exact PID/canonical-path and ownership checks.
- `Czarnak/tia-portal-mcp` (MIT, V21) demonstrates native cross-reference
  queries, a persistent worker, and write guards. `Codyte/tia-cli` (MIT,
  V19-V21) demonstrates JSON/batch use of one session.
  `allanmarum/tia-agent-console` (MIT, V21) demonstrates an Add-In selection
  bridge. Only these architectural patterns were considered; this core is an
  independent local V20 implementation.
- `bulaofen0036-coder/TIA_Portal_Openness_MCP` was reviewed at
  `9f23fd959164800badef7bdf68a196e3ea154ab2` under MIT. Its resident-host,
  cross-reference, and unique temporary-block ideas were useful comparisons.
  Unsafe first-project attachment, broad reflection, lifecycle, and mutation
  patterns were not adopted; no Siemens binaries were copied.
- `chewcw/tia-portal-openness-mcpserver` was reviewed at
  `8756ba4ac4d2f194bcee9f4cef51404115a36cbc`. No reusable repository-wide
  license was confirmed, and its first-process/current-first-project pattern is
  incompatible with exact identity requirements. No code was copied.
- `movioli/TIA_ProjectVersionManager` was reviewed at
  `67af59a9c1f3f8528209b8de2a94da688263ed60`. Its snapshot workflow opens,
  compiles, and exports a whole project and does not implement this live query
  boundary. Its license status was not clear enough for reuse and no code was
  copied.
- `Parozzz/TiaUtilities` and `qamrij/TIA_DB_Parser` are GPL and were comparison
  evidence only. `StaniB88/TIAOpenessManager` is proprietary.
  `caprican/SimaticML` and the reviewed `movioli` repository had unclear reuse
  licensing. No GPL, proprietary, unlicensed, or TIA-internal-database code was
  copied.
- The controlled accessibility helper here is an original, narrow fallback; it
  is not the engineering-data query path.

No reviewed public MCP, CLI, desktop tool, wrapper library, Add-In, official
sample, or parser supplied the complete combination of exact current-session
identity, current external selection, direct V20 cross-references, bounded
single-block body parsing, explicit object navigation, and attached-only
lifecycle. The implementation therefore reuses compatible public design
patterns, not a public product's code.

## Rule for Future Agents

Before declaring a TIA MCP capability unavailable:

1. inspect relevant workspace/memory context;
2. inspect the current source and built `dist`;
3. inspect the active connector's `tools/list`; and
4. if source and active inventory differ, rebuild or reload the registered MCP
   and inspect `tools/list` again.

Memory, handoff notes, source, built artifacts, and active connector inventory
are separate evidence layers. Do not present one as proof of another.
