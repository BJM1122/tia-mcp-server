# Install-time helpers for tools/Build-TiaNative.ps1: stopping a resident live core,
# recording old cores that are still running, and replacing an installed image.
# This file does not affect any compiled image, so it is deliberately not one of
# the native staleness inputs (nativeCommonMtimeMs, componentSources, the HMI
# runtime fingerprint). Changing it does not force a rebuild or a new Openness prompt.
# Written for Windows PowerShell 5.1; see docs/powershell-5.1.md.

Set-StrictMode -Version Latest

# Writes every valid { processId, processStartTimeUtc } row found in $Value to the
# pipeline. Earlier builds wrote arrays as {"value":[...],"Count":n}; those wrappers
# are unwrapped. Anything else is dropped, never fatal.
function ConvertTo-StaleCoreEntry($Value, [int]$Depth = 0) {
    if ($null -eq $Value -or $Depth -gt 32) { return }
    if ($Value -is [System.Array]) {
        foreach ($item in $Value) { ConvertTo-StaleCoreEntry $item ($Depth + 1) }
        return
    }
    if ($Value -isnot [System.Management.Automation.PSCustomObject]) { return }
    $names = @($Value.PSObject.Properties | ForEach-Object { $_.Name })
    if ($names -contains 'processId' -and $names -contains 'processStartTimeUtc') {
        $processId = 0
        $start = [DateTime]::MinValue
        if ([int]::TryParse([string]$Value.processId, [ref]$processId) -and $processId -gt 0 -and
            [DateTime]::TryParse([string]$Value.processStartTimeUtc, [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::RoundtripKind, [ref]$start)) {
            [pscustomobject]@{ processId = $processId; processStartTimeUtc = $start.ToUniversalTime().ToString('o') }
        }
        return
    }
    if ($names -contains 'value') { ConvertTo-StaleCoreEntry $Value.value ($Depth + 1) }
}

function Read-StaleCoreMarker([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
    try {
        $raw = [IO.File]::ReadAllText($Path)
        if ([string]::IsNullOrWhiteSpace($raw)) { return }
        ConvertTo-StaleCoreEntry (ConvertFrom-Json -InputObject $raw)
    }
    catch { Write-Warning "Ignoring unreadable old-core marker ${Path}: $($_.Exception.Message)" }
}

# True only while the same OS process (PID and start time) is still running.
function Test-StaleCoreAlive($Entry) {
    $process = Get-Process -Id ([int]$Entry.processId) -ErrorAction SilentlyContinue
    if ($null -eq $process) { return $false }
    try { $actual = $process.StartTime.ToUniversalTime() } catch { return $false }
    $recorded = [DateTime]::Parse([string]$Entry.processStartTimeUtc, [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
    # Doctor compares at millisecond resolution; use the same rule here.
    return [Math]::Floor($actual.Ticks / 10000) -eq [Math]::Floor($recorded.Ticks / 10000)
}

# Writes the marker as one flat JSON array: unique by PID and start time, only
# processes that are still running, UTF-8 without BOM. Empty means [].
function Write-StaleCoreMarker([string]$Path, [object[]]$Entries) {
    $seen = @{}
    $list = New-Object System.Collections.Generic.List[object]
    foreach ($entry in @(ConvertTo-StaleCoreEntry $Entries)) {
        $key = [string]$entry.processId + '|' + [string]$entry.processStartTimeUtc
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        if (Test-StaleCoreAlive $entry) { $list.Add($entry) }
    }
    $json = ConvertTo-Json -InputObject ([object[]]$list.ToArray()) -Depth 3 -Compress
    if ($list.Count -eq 0) { $json = '[]' }
    [IO.File]::WriteAllText($Path, $json, (New-Object Text.UTF8Encoding($false)))
}

function Update-StaleCoreMarker([string]$Path, [object[]]$Current) {
    $previous = @(Read-StaleCoreMarker $Path)
    Write-StaleCoreMarker $Path (@($previous) + @($Current))
}

# Ask a resident live core built from this image to exit before replacing it, and
# record any that are still running afterwards so doctor can report them.
function Request-LiveCoreShutdown([string]$ExecutablePath) {
    $targetPath = [IO.Path]::GetFullPath($ExecutablePath)
    $targetName = [IO.Path]::GetFileName($targetPath).Replace("'", "''")
    try { $workers = @(Get-CimInstance Win32_Process -Filter "Name='$targetName'" -ErrorAction Stop) }
    catch { Write-Warning "Could not enumerate existing TIA live-core workers before replacement: $($_.Exception.Message)"; return }
    $markerPath = Join-Path (Split-Path $targetPath -Parent) 'stale-live-core-processes.json'
    $current = New-Object System.Collections.Generic.List[object]
    foreach ($worker in $workers) {
        if ([string]::IsNullOrWhiteSpace([string]$worker.ExecutablePath) -or
            -not [string]::Equals([IO.Path]::GetFullPath([string]$worker.ExecutablePath), $targetPath, [StringComparison]::OrdinalIgnoreCase)) { continue }
        # Same start-time source as doctor (Get-Process), not the CIM CreationDate.
        $process = Get-Process -Id ([int]$worker.ProcessId) -ErrorAction SilentlyContinue
        if ($null -ne $process) {
            $current.Add([pscustomobject]@{ processId = [int]$worker.ProcessId; processStartTimeUtc = $process.StartTime.ToUniversalTime().ToString('o') })
        }
        $match = [regex]::Match([string]$worker.CommandLine, '(?:^|\s)--pipe\s+"?([^"\s]+)')
        if (-not $match.Success) {
            Write-Warning "Existing TIA live-core PID $($worker.ProcessId) has no readable --pipe argument; its old image may remain until the process exits."
            continue
        }
        $pipe = $match.Groups[1].Value
        $client = $null; $writer = $null; $reader = $null
        try {
            $client = New-Object IO.Pipes.NamedPipeClientStream('.', $pipe, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::None)
            $client.Connect(2000)
            $writer = New-Object IO.StreamWriter($client, (New-Object Text.UTF8Encoding($false)), 1024, $true)
            $reader = New-Object IO.StreamReader($client, [Text.Encoding]::UTF8, $false, 1024, $true)
            $request = [pscustomobject]@{ protocolVersion = 1; requestId = 'build-shutdown-' + [Guid]::NewGuid().ToString('N'); operation = 'shutdown'; timeoutMs = 5000 }
            $writer.WriteLine((ConvertTo-Json -InputObject $request -Depth 2 -Compress))
            $writer.Flush()
            if (-not $reader.ReadLineAsync().Wait(5000)) { Write-Warning "TIA live-core PID $($worker.ProcessId) did not acknowledge graceful shutdown within 5 seconds." }
        }
        catch { Write-Warning "Could not gracefully stop TIA live-core PID $($worker.ProcessId): $($_.Exception.Message)" }
        finally { foreach ($d in $reader, $writer, $client) { if ($null -ne $d) { $d.Dispose() } } }
        try { if ($null -ne $process) { [void]$process.WaitForExit(5000) } }
        catch { Write-Warning "Could not wait for TIA live-core PID $($worker.ProcessId) to exit: $($_.Exception.Message)" }
    }
    # Exited workers are pruned; doctor rechecks PID and start time again.
    Update-StaleCoreMarker $markerPath ([object[]]$current.ToArray())
}

function Remove-FileWithRetry([string]$LiteralPath) {
    for ($attempt = 1; $attempt -le 10; $attempt++) {
        if (-not (Test-Path -LiteralPath $LiteralPath -PathType Leaf)) { return $true }
        try { Remove-Item -LiteralPath $LiteralPath -Force -ErrorAction Stop; return $true }
        catch { if ($attempt -lt 10) { Start-Sleep -Milliseconds 200 } }
    }
    Write-Warning "Could not remove retired companion image after bounded retries: $LiteralPath"
    return $false
}

# Replace (or create) the installed image from a staged, self-tested one.
function Install-NativeImage([string]$Component, [string]$StagedOutput, [string]$ResolvedOutput, [string]$BackupOutput) {
    $outputDirectory = Split-Path $ResolvedOutput -Parent
    if (Test-Path -LiteralPath $ResolvedOutput -PathType Leaf) {
        if ($Component -eq 'live-core') { Request-LiveCoreShutdown $ResolvedOutput }
        # A running image cannot be deleted after File.Replace renames it; sweep earlier leftovers now.
        foreach ($retired in @(Get-ChildItem -LiteralPath $outputDirectory -Filter (([IO.Path]::GetFileName($ResolvedOutput)) + '.backup-*.exe') -File -ErrorAction SilentlyContinue)) {
            [void](Remove-FileWithRetry $retired.FullName)
        }
        [IO.File]::Replace($StagedOutput, $ResolvedOutput, $BackupOutput, $true)
        [void](Remove-FileWithRetry $BackupOutput)
    }
    else { [IO.File]::Move($StagedOutput, $ResolvedOutput) }
}
