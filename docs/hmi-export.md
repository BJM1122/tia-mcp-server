# HMI configuration export

1. Prepare the exact open project with `tia_prepare_live_session`.
2. Call `tia_list_hmi_targets` with its PID. Select the returned software name and hardware path; do not infer the main panel from its name.
3. Call `tia_export_hmi_configuration` with `projectPath`, `hmiName`, `hmiPath`, and that PID. This reads the selected HMI only and writes a JSON observation under the workspace's `tia-exports/hmi` directory.

Subsequent calls with the same identity reuse the validated file without requiring TIA to be open. Pass `refresh: true` after a program change. Keep the selector path consistent across calls. The deterministic filename separates projects and duplicate HMI names; it does not contain timestamps. Content hashes detect damaged or mismatched observations. Replacement uses a temporary file and atomic rename. A partial read preserves the previous usable export. When no usable export exists, a partial file is saved with `partial_export` and cannot be reused as a successful result.

The JSON includes object IDs, parent relationships, readable attributes, collection names, and explicit coverage/issues. Script source is read when the installed public API exposes it; it is never executed. Password, credential, certificate and user-administration fields are excluded. No project save, compile, import, PLC access, or PLC source export is performed.

This is an analysis observation, not an importable WinCC backup. API coverage varies between Unified and classic HMI and installed TIA versions. An unavailable alarm collection does not mean no alarms exist. Missing bindings, unreadable attributes and truncated text must be considered before assessing reset-button behavior or PLC mappings. An identity check is performed before and after the read; concurrent engineering edits are not an atomic snapshot. A cached observation does not establish the current project's freshness or PLC runtime state.

Unified reads use an explicit allowlist of public CLR properties and child collections, including for shared multilingual and script children. They do not call generic attribute/composition discovery or enumerate arbitrary scalar properties: `GetAttributeInfos()` can terminate Portal V20 inside Siemens' `ConfirmationType` property adapter before a caller can catch the error. Unified observations report `unified_property_coverage_limited` and `explicit_public_property_allowlist`; unlisted properties are not inspected, and these partial observations never replace a usable cached export. Classic reads retain their existing behavior. Offline regression tests exercise the actual C# reader with metadata methods and unlisted getters that throw; a successful offline run is not live Portal acceptance.

After updating the server and rebuilding the native core, use a fresh MCP connection to expose the new tool names. Existing connections retain their loaded server version.
