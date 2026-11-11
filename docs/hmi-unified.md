# WinCC Unified V20 authoring

Both Classic and Unified are in the current development scope. Real TIA
project acceptance tests are still pending. This implementation compiles
against the Siemens V20 public API; that is not native
acceptance or runtime evidence.

## Structure and tools

| Component | Responsibility |
| --- | --- |
| src/hmi-unified.ts | Distinct design schema, layout expansion, reference/type validation, creation plans |
| src/hmi-unified-edit.ts | Scoped property diffs, immutable recovery baseline and one-use approvals |
| live-core/TiaHmiUnified.cs | Public native object creation, grouped-screen discovery, scoped setters and readback |
| src/hmi-authoring-tools.ts | MCP registration, exact identities, path checks, companion fingerprint and independent verification |

| Tool | Operation |
| --- | --- |
| tia_generate_unified_hmi_design | Offline public-API creation program; not a native import archive |
| tia_create_unified_hmi_project_plan | Immutable exact new-project plan with catalog identifier and all generated scripts |
| tia_apply_unified_hmi_project | Approved create, device compile, save and independent reopen/readback |
| tia_inspect_unified_hmi | Read-only target/screen/item discovery and scoped property observation |
| tia_create_unified_hmi_edit_plan | Read-only baseline and exact property differences for an existing object |
| tia_apply_unified_hmi_edit | Approved scoped setters, hosting-device compile and independent readback |
| tia_preview_hmi_design | Self-contained offline preview for either adapter |

## New projects

Use adapter `wincc-unified-v20`, exact device model and resolution, `startScreen`,
`language` (zh-CN, en-US or de-DE), optional reusable layouts in `templates`,
`screens`, and `internalTags`. Supported controls are text, rectangle, button and
IO field, alarmView and trendView. Layouts expand into native objects on each screen; they are not native
faceplates. A name collision after expansion is rejected. Device resolution must
exist in the installed V20 ScreenResolution enum; this does not prove a catalog
device supports that resolution.

Internal tags accept Bool, Int, DInt, UInt, UDInt, Word, DWord, Real and WString with optional type/range
checked initial values. IO fields bind ProcessValue through TagDynamization,
with explicit Output/InputOutput and ReadOnly mapping. A unit must currently be
an adjacent text object; nonempty implicit unit formatting is rejected.

Buttons use Tapped for navigation and Down/Up for an explicitly writable Bool press/release
command. Screen Unloaded also resets that screen's momentary tags. Script
arguments use JSON string encoding. Script bodies are assigned through IHmiScript;
native script syntax and behavior still require the deferred TIA acceptance test.
These events are not safety logic or a guarantee against a lost release event,
runtime crash or communications loss. Connections are only created when explicitly
included in the plan; no PLC is contacted by this engineering tool.

## Connections, external tags and alarms (0.19)

`connections` contains exact name, communicationDriver, initialAddress,
disabledAtStartup (required), and named driverProperties. The adapter does not
guess driver IDs or property names. The named property must exist after setting
the selected native driver, or creation fails. Do not include credential fields
in reviewable engineering plans; they are rejected.

`externalTags` binds the exact connection and datatype to AbsoluteAccess with
address, or SymbolicAccess with plcTag. Both address modes at once are rejected.
Every external tag declares writeEnabled. InputOutput controls and command
buttons require true. This is an authoring validation rule; it is not a PLC
permission or runtime access-control mechanism. Initial values are configured
only for internal tags. The HTML preview uses local placeholder values for
external tags and never contacts their configured endpoints.

`alarmClasses` declares name, priority and an explicit native acknowledgement
state machine. `discreteAlarms` declares a unique ID/name, class, priority,
triggerTag/triggerBit, rising/falling trigger, text and infoText. Trigger width is
validated against the exact tag datatype. Native acknowledgement state-machine
semantics, drivers and addresses still require deferred native validation.

An `alarmView` control creates HmiAlarmControl with ActiveAlarms or AlarmDefinition,
an optional exact native filter, alarm colors, and unsuppressed alarms. It uses
native grid typography; unsupported text/font/foreground overrides are rejected.
The offline preview only lists configured alarms, explicitly without runtime
states or native filtering. Alarm acknowledgement from runtime is not tested.
Creation checks all these requested resources both before save and after reopen.

## Realtime trends (0.20)

`trendView` creates a native HmiTrendControl with one area, bottom time axis and
left value axis. Supply one to eight trendSeries entries with exact numeric tag,
label and RGB color, trendWindowSeconds, trendMin and trendMax. Duplicate or
unknown sources, Bool/string sources and inverted ranges are rejected. The native
adapter sets Online, an interpolated line, exact DataSourceY.Source, axis range
and time window, and checks these values after independent reopen. New-control
defaults may be reused, but unexpected extra default areas/trends cause refusal
instead of silent deletion. History logging is not configured by this control.

The HTML preview lists configured sources and ranges, explicitly without live
sampling. It is not a simulated native trend. Source support is defined by the
installed V20 public documentation for HmiDataSourcePart.Source (HmiTag or
HmiLoggingTag); this generator currently accepts its exact declared numeric tags.

The plan binds an existing allowed output parent, safe project name, explicit
Siemens catalog typeIdentifier, device name, generated program, and helper/API
fingerprint. Approval is `CREATE_EXACT_UNIFIED_HMI_PROJECT` with the exact plan hash
and one-time token. The token expires after ten minutes and is consumed before
asynchronous preflight. It cannot be replayed after failure.

Apply opens an owned TIA process, creates an unused destination, creates the
requested device and exactly one Unified software target, activates the selected
project/runtime language, creates tags/screens/items, sets startup screen and
resolution, compiles the created device, verifies requested properties, saves,
then opens the saved project in a second owned TIA process and verifies again.
Native defaults are permitted. Failure retains partial output and diagnostics;
no existing project directory is overwritten or deleted.

## Existing project edits

Identity includes PID, process-start timestamp, canonical project path, exact
target path, screen path including groups, object name and language. Discover in
stages with empty targetPath, screenPath and objectName respectively.

The observation covers supported primitive geometry, ARGB colors, selected
language text, font size, direct binding identities and event script content.
It is neither a complete native export nor a whole-project backup. Unknown native
properties are preserved by leaving their objects in place and calling only the
selected public setters. The tool does not reconstruct objects from observations.

Editable fields are Left, Top, Width, Height, BackColor/ForeColor (`#AARRGGBB`),
Text and FontSize. Unavailable, dynamic, out-of-bounds and unchanged edits fail.
Text changes affect one existing language only. Script/event editing, creation,
deletion and rebinding in existing projects are not enabled by this tool.

Approval is `APPLY_EXACT_UNIFIED_HMI_EDIT`. Under exclusive access, apply checks
the fresh scoped baseline hash, saves recovery values, writes exact properties,
compiles the entire hosting device and verifies the observed unchanged fields
and requested changes. This compile can include other software on that device;
the plan discloses this scope. A second helper independently reads back. Save
defaults false; if true it saves all other unsaved changes in the attached project.
There is no automatic rollback. An uncertain result requires readback and a new
plan. No runtime, network probing, download or force action is performed.

## References

- Installed V20 Siemens.Engineering.dll and matching XML API documentation:
  HmiSoftware, HmiScreenComposition.Create, HmiScreenItemBaseComposition.Create,
  TagDynamization, IHmiScript, RuntimeSettings.StartScreen and LanguageAndFonts.
- [Siemens ChangeScreen V20](https://docs.tia.siemens.cloud/r/en-us/v20/using-system-functions-rt-unified/system-functions-rt-unified/changescreen-rt-unified).
- [Siemens Unified screen-object import/export example](https://cache.industry.siemens.com/dl/files/619/109792619/att_1108377/v3/109792619_Excel_Importer_Exporter_V2_DOC_en.pdf).

See [the status matrix](hmi-authoring-status.md) for remaining development and
acceptance work. Nothing in this document means the active chat's older MCP
connection has loaded the new implementation.
