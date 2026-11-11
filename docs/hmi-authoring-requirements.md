# HMI authoring requirements and implementation boundary

Status: classic WinCC and WinCC Unified are both in scope; other vendors are
deferred. Functions are implemented first; real TIA acceptance tests come later.
Version 0.20.0 implements classic native batch export, screen/template/control candidates,
named/range/text edits, guarded replacement import and isolated project creation
with native resources, compile/save/reopen verification orchestration; see
[implementation checkpoint](hmi-authoring.md). New paths are offline-tested only;
native acceptance and complete dependency coverage remain open. Unified now has
separate public-API generation, guarded isolated project creation and scoped
existing-object editing; it does not reuse classic XML or claim native archive export.
Unified creation also includes explicit connections/external tags, alarm classes,
discrete alarms and a native alarm view. Driver/catalog compatibility remains
unverified until native acceptance.
Unified realtime trends map exact numeric tag sources, time windows and value axes.
The PLC single-block import tools do not import HMI objects.

## Required workflows

1. Create a complete native HMI project from requirements. AI creates the design
   system, templates, reusable components, screens, navigation, bindings and
   supported supporting resources. No existing visual template is required.
2. Export an existing editable native project, make scoped changes, and import
   the changes back. Preserve all untouched native objects and dependencies.
3. Support multiple engineering products through separate adapters, initially
   classic TIA WinCC, WinCC Unified, McgsPro, and MCGS Embedded (MCGSE).
   Do not treat the two Siemens families or two MCGS families as interchangeable.

## Shared model and native preservation

The shared model describes device profile, resolution, screens, component
geometry, typography, assets, navigation, tags, connections, events, animations,
alarms, text/graphic lists, scripts and recipes where the adapter supports them.
Every binding includes its exact connection, tag identity, datatype, direction,
units/scaling, event semantics and applicable operator permission requirement.

Native extensions remain attached to their original object identities. Preserve
unrecognized native data as original artifacts with hashes; do not deserialize
an incomplete observation and overwrite a complete project with that subset.
Unsupported edited objects or unresolved dependencies block application.
Shared concepts are reusable across brands; native scripts, event functions,
drivers and object behavior require explicit per-adapter mappings.

An image, SVG, HTML preview or JSON observation is not a native HMI deliverable.
Never rename a generated file to a vendor extension and report successful native
project creation without opening, compiling and verifying it in that vendor tool.

## Adapter contract

Each adapter must report capabilities per engineering-software version and panel
profile. Report unverified, unsupported and unavailable states distinctly from
verified capability. The planned operations are:

- Discover engineering software, exact project/target identity and panel profile.
- Inspect public object schema and version compatibility.
- Export editable native objects and all referenced dependencies with a manifest.
- Validate a new design or an edit against that device and existing interfaces.
- Generate native candidate artifacts and an offline preview.
- Plan a precise diff with create/update/remove operations, original/candidate
  hashes, dependency order, compile scope and save choice.
- Apply an explicitly approved, immutable, single-use plan to the exact target.
- Compile, re-export and compare results; report warnings and verification gaps.
- Recover original objects on failure where the adapter can verify recovery.
- Start isolated simulation and inspect rendered screens and functional behavior
  only where a documented, tested execution route exists.

These are contract operations, not currently callable MCP tool names.

## Original-project edits

Retain screen numbers/names, object identities, hierarchy and ordering where
possible. Display unchanged, added, changed and removed objects separately in
the review. Include changes to resources referenced by screens, not just pixels.

Copy native baseline artifacts before application. A failed or partial export
must not replace the last usable baseline. An uncertain write is followed by
fresh readback and a new plan; never replay its token. A compile or readback
failure is not success even if a window appeared in the editor.

Respect installed-version and device compatibility. For classic WinCC, validate
screen dimensions, device type, unique screen numbers, template links, layer
ordering and library-type behavior against the V20 public API restrictions.

## Backend evidence and boundaries

Classic WinCC has documented V20 public import methods for screens, templates,
tag tables, scripts and text/graphic lists. Implement and test the corresponding
adapter operations; API existence alone is not implementation or compatibility
proof. The existing JSON HMI observation is not an importable WinCC archive.

WinCC Unified needs its own public API/type and version verification; do not
reuse the classic HmiTarget serializer or event syntax blindly.

MCGS authoring is not implemented. Confirm the required McgsPro/MCGSE version,
panel model, editable native project format and vendor-supported engineering
interfaces before enabling its adapter. A runtime download/upload or PLC data
protocol does not establish editable-screen export/import capability.
If a vendor lacks a supported engineering API, explicitly evaluate a versioned
vendor-editor automation workflow and its verification limits; do not write an
undocumented project database or promise lossless conversion.

## Acceptance evidence

For each enabled adapter, exercise both workflows in an isolated test project:

- AI-created template and at least two screens, with navigation and native
  controls, open correctly without a user-supplied visual template.
- Bind display values and explicit press/release actions to isolated test tags;
  verify units, limits, state feedback and action semantics.
- Re-export/import an unchanged project and preserve native semantics.
- Edit selected objects and verify untouched objects/dependencies remain intact.
- Reject wrong project, version, panel dimensions, stale baseline, changed
  candidate, reused token, duplicate identities and unresolved dependencies.
- Compile and re-export successfully. Inspect native rendered results and
  behavior in simulation; never report a preview as runtime verification.
- Record backup, compile diagnostics, readback comparison and recovery evidence.

Deployment to a physical HMI and machine commands are separate operations.
The present implementation work does not authorize them or PLC/robot changes.

## Initial sequence

Build the common capability/identity/manifest/diff contracts, then prove the
classic WinCC native creation and round-trip path using an installed V20.
Implement Unified against its own public interfaces in the same round. MCGS is
deferred. Add automation of compilation, rendering and simulation per adapter.
This sequence does not drop the from-scratch or original-project-edit workflows.

References:

- Siemens V20 screen import and compatibility restrictions:
  https://docs.tia.siemens.cloud/r/en-us/v20/tia-portal-openness-api-for-automation-of-engineering-workflows/export/import/importing/exporting-data-of-an-hmi-device/screens/importing-screens-to-an-hmi-device
- Current read-only observation scope: [HMI export](hmi-export.md).
