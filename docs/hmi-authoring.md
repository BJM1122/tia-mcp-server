# HMI authoring implementation

Version 0.20.1. Classic WinCC and Unified are both included in the current scope.
New implementation is compiled and tested offline. Actual TIA
import/compile/save acceptance tests are still pending. Earlier single
screen/template export succeeded; this does not verify the new bundle/import paths.

See the [current capability matrix](hmi-authoring-status.md) and the separate
[Unified workflow](hmi-unified.md). Development gaps and deferred real tests are
listed separately.

## Structure

| Layer | Source | Responsibility |
| --- | --- | --- |
| Native preservation | src/hmi-authoring.ts | Hashes, range edits, named geometry/color edits |
| Design and dependencies | src/hmi-design.ts | Device bounds, XML generation, external references |
| Approval gate | src/hmi-import-plan.ts | Immutable payload, exact diff, expiry, single-use tokens |
| MCP orchestration | src/hmi-authoring-tools.ts | Schemas, runtime fingerprints, process limits, independent readback |
| Siemens adapter | live-core/TiaHmiNative.cs | Official export/import, exclusive access, baseline checks, compile/readback |

Classic V20, Unified V20, McgsPro and MCGSE remain distinct adapters. Classic and
Unified have separate implementations; MCGS development is deferred.

## Callable tools

| Tool | Behavior |
| --- | --- |
| tia_hmi_authoring_capabilities | Explicit implemented/unverified/unsupported states |
| tia_export_hmi_native | Discover targets, list screen/template paths, export one XML |
| tia_export_hmi_bundle | Export screens, templates, tag tables, VB scripts, text/graphic lists with hashes and reference inventory |
| tia_edit_hmi_native | Explicit UTF-16 range edits; preserve untouched native text |
| tia_update_hmi_object | Unique ObjectName; edit existing geometry or RGB colors |
| tia_generate_hmi_design | Classic XML candidates with text, rectangles, buttons, events and IO fields |
| tia_create_hmi_import_plan | Live read-only baseline and exact replacement plan |
| tia_apply_hmi_import | Approved single-use import, compile and independent readback |

Bundle export fails if an included export fails or exceeds 25 MB aggregate. It
returns artifacts without overwriting a saved canonical export. Alarms, recipes and library types are excluded. External
reference inventory is not verified dependency closure.

## Structured generation

Supply a design with adapter wincc-classic-v20, device {model,width,height},
templates and screens. Every screen has name, number, optional template, background
and elements. Each element has name, type (text, rectangle, button or ioField), x, y, width, height,
optional text, foreground/background RGB hex colors, transparent and fontSize.
Templates have the same layout fields but no number/template reference.

Templates precede screens in output. Duplicate names/numbers, out-of-bounds
objects and missing templates fail. Dimensions are caller-specified, not verified
against a vendor device table. No visual template is required. These are XML
candidates, not a created .ap20 project or runtime proof. Buttons, navigation, press/release tag commands and IO fields are generated as unverified native candidates.

## Exact import flow

1. Supply PID, process start, canonical allowed project path, exact target/object
   path, kind, candidate XML and save choice to the read-only plan tool.
2. Review the full exact changed range, baseline/candidate hashes, compile/save
   scope, 10-minute expiry, plan hash and single-use token.
3. Obtain explicit user approval for that exact plan. Apply with confirmToken,
   planSha256 and approval: APPLY_EXACT_HMI_PLAN.
4. The token is consumed before asynchronous checks. Binaries are fingerprinted;
   the helper rechecks baseline under exclusive access, then saves original.xml
   and candidate.xml under tia-openness-import/hmi/<token> outside the repository.
5. Official import, HMI software compile, re-export and strict native comparison
   run before optional save. A second connection independently reads back.

Only replacement of an existing screen/template is supported. Object identity,
screen number, dimensions and external references must remain unchanged.
Creation/deletion and dependency-changing imports are refused. PLC import tools
remain separate and do not accept HMI XML.

Comparison excludes document-level export metadata and formatting-only whitespace;
it retains native IDs, object content and ordering. Vendor ID/default normalization
can produce conservative verification failure; no heuristic equivalence is claimed.
Default saveProject is false. If true, the plan explicitly states that saving also
saves other existing unsaved changes in the attached project.

Compile/readback failure, exception or timeout may leave engineering changes.
There is no automatic rollback. Original-object files are not whole-project
backups. Read back and create a new plan; never replay a consumed token.
No download, force, runtime writes, motion or simulation start is exposed.

## Validation and remaining work

Run npm run build:hmi-native and npm run build. The native self-test checks V20
API availability without project access. npm test covers offline generation,
preservation, identity/dependency checks, plan lifetime/replay, transport and
existing regressions. New tools require a fresh MCP connection.

Still open: actual native acceptance, device capability tables, complete dependency
coverage, advanced controls and official simulation. The matrix below distinguishes
implemented functions from remaining development. MCGS is deferred.

## Version 0.17 creation and editing additions

This checkpoint added classic WinCC V20 project creation. Version 0.18 adds Unified
below. This is implementation progress, not full acceptance.

- tia_create_hmi_project_plan: offline immutable plan for a new isolated project.
- tia_apply_hmi_project: exact approved plan only; never overwrites an existing
  destination. Creates its own TIA process and HMI device from a caller-supplied
  catalog identifier. Imports resources, creates screen/template skeletons, then
  imports full candidates to resolve cyclic navigation. Compiles, checks requested
  values, saves, and independently reopens the project to check values again.
- tia_edit_hmi_text: change one ObjectName/culture/composition (Text/TextOn/TextOff)
  without rewriting other languages, bindings, event handlers or vendor payloads.
- tia_preview_hmi_design: self-contained offline HTML with local IO and button
  state. It cannot contact equipment and is not WinCC simulation.

Project spec: outputParent (existing allowed project directory), projectName,
deviceName, exact typeIdentifier, design, optional resources, internalTagTable and
internalTags. Internal tags accept name and dataType (Bool/Int/DInt/Real/String).
Device defaults determine initial values. Candidates require native acceptance.

Resources accept kind, name, xml and sha256. Supported kinds are projectGraphic,
connection, tagTable, vbScript, textList and graphicList. Preserve original XML;
resource identity, V20, digest and named references are checked. Missing references
block the plan. IO bindings require typed native tags; momentary commands require
Boolean tags. This is name/type checking, not proof of full vendor semantics.

Design elements now also accept button or ioField. navigateTo targets another
screen. momentaryTag emits separate Press/Release SetTag events; valueTag binds an
IO field. ioMode defaults to Output; InputOutput must be explicit. unit is optional.
Action XML uses documented system functions but parameter serialization and native
control defaults still require TIA import/compile testing. Function reference:
https://docs.tia.siemens.cloud/r/en-us/v20/system-functions-panels-comfort-panels-rt-advanced-rt-professional/activatescreen-panels-comfort-panels-rt-advanced-rt-professional

Creation readback checks every requested value, allowing vendor-generated IDs and
additional defaults. Existing-object replacement retains strict whole-root checks.
Failed creation retains partial files and compile/readback evidence under the new
project's hmi-authoring-evidence directory. It never deletes existing projects.
An interrupted run can retain its .hmi-build.lock and must not be blindly replayed.

Batch export now also includes native project graphic and connection XML. It still
reports incomplete dependency closure because alarms, recipes and library types
are excluded. No new live exports, imports, project creations or runtime tests were
performed while developing 0.17.0.
