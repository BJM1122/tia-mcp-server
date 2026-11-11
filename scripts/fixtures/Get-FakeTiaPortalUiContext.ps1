[CmdletBinding()]
param(
    [string]$ApiDll,
    [int]$MaxNodes,
    [int]$MaxDepth,
    [int]$ProcessId
)

$contextFile = $env:TIA_MCP_TEST_UI_CONTEXT_FILE
if ([string]::IsNullOrWhiteSpace($contextFile) -or -not [IO.File]::Exists($contextFile)) {
    [Console]::Error.WriteLine("TIA_MCP_TEST_UI_CONTEXT_FILE is missing or unreadable.")
    exit 3
}

[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::Write([IO.File]::ReadAllText($contextFile, [Text.Encoding]::UTF8))
