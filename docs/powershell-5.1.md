# PowerShell inside the tool: Windows PowerShell 5.1 only

The server and the native build always invoke `powershell.exe`, i.e. Windows
PowerShell 5.1. They never call PowerShell 7 (`pwsh`), and installing 7 does not
change that. Reasons:

- 5.1 ships with every Windows engineering station; 7 is a separate install.
- 5.1 runs on .NET Framework, the same runtime as TIA Openness and the UI
  Automation components loaded by the UI-context scripts.
- One interpreter means tests and troubleshooting face a single environment.

Using PowerShell 7 in your own terminal is fine, but every script in this
repository must run under 5.1.

## Rules

They apply to `tools/*.ps1` and to inline scripts that `src` passes to
`powershell.exe`. `scripts/powershell51.test.mjs` checks them with the real 5.1
interpreter.

1. **Every `ConvertTo-Json` states `-Depth`.** 5.1 converts only two levels by
   default and silently turns deeper objects into type names.
2. **Convert arrays with `-InputObject ([object[]]...)`, never through the pipeline.**
   - Piped, a one-element array becomes a single object and an empty array
     produces no output.
   - A wrapped array serializes as `{"value":[...],"Count":n}`.
   - When an empty result must be `[]`, write `[]` explicitly.
3. **Put `[pscustomobject]` in collections, not hashtables.** `Sort-Object`,
   `-Unique` and property access do not see hashtable keys.
4. **Every file write states its encoding.** Use
   `[IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding($false)))`,
   or pass `-Encoding` to `Set-Content` / `Out-File`. The 5.1 default is ANSI or UTF-16.
5. **No PowerShell 7-only syntax or parameters:**
   - operators `&&`, `||`, `??`, ternary `?:`;
   - parameters `-AsArray`, `ForEach-Object -Parallel`, `ConvertFrom-Json -AsHashtable`.

   The test parses every script with the 5.1 parser and checks for these parameters.
6. **Data files that Node can write are written by Node.** PowerShell writes a
   file only when the script itself produces the data (for example the stale
   resident-core marker written during installation).
7. **Text in code is English.** This covers prompts, errors, logs, comments and
   identifiers. Non-ASCII text belongs only in data (TIA object names, project
   paths) and operator-facing UI strings. On systems whose non-Unicode code page
   is not UTF-8, non-ASCII text written through the 5.1 console is easily garbled.

## Staleness inputs of native components

These files are build inputs:

- `tools/Build-TiaNative.ps1`
- `live-core/Common/TiaNativeTarget.cs`
- `portal-versions.json`
- each component's own sources

Changing any of them makes the installed executables "older than source"; they
stay disabled until `npm run build:production` (or the matching
`npm run build:native` call) rebuilds them. Each rebuilt executable triggers the
Openness authorization prompt again on its first attach to TIA Portal.

Installation-only logic therefore lives in `tools/TiaNativeInstall.ps1`, which
is not a build input:

- stop old resident cores;
- write the stale-core marker;
- replace the installed executables.

Do not add code that does not affect the compiled result to `Build-TiaNative.ps1`.
