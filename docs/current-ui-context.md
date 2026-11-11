# Current TIA Portal UI context

## Purpose and boundary

`tia_get_current_ui_context` performs one bounded, on-demand observation of a
running TIA Portal V20 window. It reports these evidence layers separately:

- Siemens Openness diagnostic process metadata: process ID and exact open
  `.ap20` project path.
- The current Project tree selection, when TIA's Windows accessibility surface
  exposes it.
- The visible PLC editor/block breadcrumb, when exposed.
- A uniquely selected LAD/FBD network or section, when exposed.
- Existing export/index candidates whose recorded source project path exactly
  matches the open project.

The probe never attaches to the project, invokes an accessible control, changes
focus, clicks, types, captures the screen, polls continuously, or calls a TIA
command. It does not identify mouse hover. An absent, split, unsupported, or
ambiguous UI state is returned explicitly instead of guessed.

When the selected Portal window is minimized, the tool still returns Siemens'
diagnostic project identity and marks `isMinimized: true`, but it does not
report hidden editor/selection/network frames because that accessibility state
may be stale.

`tia_get_current_block` with `source: "export"` composes that observation with the existing
offline export/query surface. It uses the Project tree selection first and the
visible editor second, reports any disagreement, requires an exact recorded
project-path match, and refuses ambiguous block matches. It can return block
metadata, direct callers/callees, same-number companions, interface members,
and existing non-stale reference-index results. It never creates or refreshes
an export or reference index.

The selected network is UI context only. Rich block details come from an
offline snapshot, and the snapshot timestamp does not prove that it includes
unsaved edits or matches PLC runtime state.

## Deterministic resolution

1. The companion reads `TiaPortal.GetProcesses()` without `Attach()`.
2. A requested process ID selects one diagnostic session. Without one, exactly
   one visible session is required.
3. The helper performs targeted, bounded MSAA reads of the Project tree,
   visible editor frame, and network container.
4. The server compares canonical Windows `.ap20` paths recorded in
   `export-cs.json` or `probe-cs.json`. Project name alone is only a candidate
   hint and is never enough for automatic enrichment.
5. A block label such as `MotorControl [FB42]` is matched by name, kind, and
   number. Zero or multiple matches remain explicit.

This flow is generic across projects and CPU families. It contains no fixed
project name, project path, block family, S7-1200/S7-1500 choice, or CPU model.

## Tool inventory

When working with an existing integration, first check project/memory context
and then inspect the active MCP `tools/list` result. Source code on disk does
not prove that the currently registered long-running server has reloaded. If
the two current-context tools are absent, rebuild/restart the registered server
and inspect `tools/list` again before declaring the capability unavailable.

## Public implementation review

The design reviewed these mature public implementations:

- `https://github.com/bulaofen0036-coder/TIA_Portal_Openness_MCP`
  (reviewed at `9f23fd959164800badef7bdf68a196e3ea154ab2`, MIT)
- `https://github.com/chewcw/tia-portal-openness-mcpserver`
  (reviewed at `8756ba4ac4d2f194bcee9f4cef51404115a36cbc`;
  no repository license file was visible at that revision)

Reusable ideas were dynamic project traversal, explicit session metadata,
typed result envelopes, bounded operations, read-only MCP annotations,
tool-inventory self-checks, and unit/integration separation. Neither reviewed
implementation provided passive ordinary left-click selection plus active
editor/network discovery. No source code was copied.

Their auto-launch, first-process fallback, project ownership/closing, and broad
mutation surfaces were deliberately not adopted. TIA V20's documented Add-In
selection provider is limited to an invoked shortcut-menu handler; it is not a
passive ordinary-click getter. The verified gap is therefore bridged with
read-only diagnostic metadata plus bounded Windows accessibility reads.

| Capability | Existing local MCP before this change | bulaofen implementation | chewcw implementation | This extension |
| --- | --- | --- | --- | --- |
| Generic project/block queries | Existing S7-1200/S7-1500 export, call, interface, reference, flow, and note tools | Openness hierarchy and project tools | Project/device/block tool groups | Reuses the existing local query core |
| Running TIA/project identity | No live UI-context tool | Manages its own attached/open project session | Exposes managed project/session information | Non-attaching Siemens diagnostic process snapshot |
| Ordinary current left-click selection | Not exposed | Not found; editor helper is one-way | Not found; editor helper is one-way | Bounded MSAA Project tree selection when exposed |
| Current visible block/network | Not exposed | No passive getter found | No passive getter found | Bounded MSAA editor/network evidence with explicit unavailable/ambiguous states |
| Mutation surface | Import apply was disabled; export/cache writes separately annotated | Broad create/edit/compile/project operations | Includes create/edit/compile operations | Context/query tools remain read-only; v0.8 adds a separate exact-plan block-import tool and still has no PLC download |

## Offline mutation boundary

Mutation execution remains separate from this read-only context feature.
Version 0.8 implements one bounded block-import path that:

1. Generate an exact dry-run change plan and diff without changing TIA.
2. Bind that plan to project identity, TIA/project version, source hashes, and
   a short validity window.
3. Recheck those identities immediately before execution and require explicit
   user approval for that exact plan at that time.
4. State backup and recovery/rollback handling before execution.
5. Compile before saving and return the available diagnostics.
6. Verify the post-change result and report any partial application.

The plan token binds import, compile scope, and optional save as one exact
operation. PLC download, force, live PLC writes, going online, or
safety-related mutation are not implemented. Approval for an offline project
edit never implies approval for any PLC-side action.

## Focused verification

From the server directory:

```powershell
npm run test:ui-context
npm run list-tools
npm run validate-config
```

The focused test uses synthetic generic project/export data and a bounded MCP
smoke. The smoke calls each new tool once; when TIA is running, that produces
two independent on-demand read-only observations. It also accepts the explicit
no-session state when TIA is closed. A successful offline test does not imply
that every TIA editor/version exposes the same undocumented accessibility
metadata.
