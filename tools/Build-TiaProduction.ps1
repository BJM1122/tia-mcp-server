[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$serverRoot = Split-Path $PSScriptRoot -Parent
$binRoot = [IO.Path]::GetFullPath((Join-Path $serverRoot 'live-core/bin'))
$stage = Join-Path $binRoot ('paired-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
$build = Join-Path $PSScriptRoot 'Build-TiaNative.ps1'
$items = @(
    @{ component='importer'; version='V20'; name='TiaOpennessImportBlock.exe'; target=(Join-Path $serverRoot 'tools/TiaOpennessImportBlock.exe') },
    @{ component='live-core'; version='V20'; name='TiaLiveReadCore.exe'; target=(Join-Path $serverRoot 'tools/TiaLiveReadCore.exe') },
    @{ component='v15-snapshot'; version='V15.1'; name='TiaV15Snapshot.exe'; target=(Join-Path $serverRoot 'tools/TiaV15Snapshot.exe') },
    @{ component='importer'; version='V15.1'; name='TiaOpennessImportBlock.v15_1.exe'; target=(Join-Path $serverRoot 'tools/TiaOpennessImportBlock.v15_1.exe') },
    @{ component='hmi'; version='V20'; name='TiaHmiNative.exe'; target=(Join-Path $serverRoot 'tools/TiaHmiNative.exe') }
)
$attempted = [Collections.Generic.List[object]]::new()
$preserveBackups = $false
try {
    # Every component must compile and pass its version's offline self-test before any installation.
    foreach ($item in $items) {
        $item.staged = Join-Path $stage $item.name
        & $build -Component $item.component -Version $item.version -OutputPath $item.staged -RequireSelfTest
        if (Test-Path -LiteralPath $item.target -PathType Leaf) {
            $item.backup = Join-Path $stage ('previous-' + $item.name)
            Copy-Item -LiteralPath $item.target -Destination $item.backup
            $item.previousWriteTime = [IO.File]::GetLastWriteTimeUtc($item.target)
        }
    }
    # Keep the V20 importer/core adjacent; all five belong to the same rollback set.
    foreach ($item in $items) {
        $attempted.Add($item) # Include a helper that throws after replacing its destination.
        & $build -Component $item.component -Version $item.version -OutputPath $item.target -InstallFrom $item.staged -RequireSelfTest
    }
}
catch {
    $failure = $_
    $rollbackErrors = @()
    for ($i = $attempted.Count - 1; $i -ge 0; $i--) {
        $item = $attempted[$i]
        try {
            if ($item.ContainsKey('backup')) {
                # Atomic replacement can restore a file even if a process still holds the retired image.
                $rollback = Join-Path $stage ('rollback-' + $item.name)
                Copy-Item -LiteralPath $item.backup -Destination $rollback
                [IO.File]::SetLastWriteTimeUtc($rollback, $item.previousWriteTime)
                if (Test-Path -LiteralPath $item.target -PathType Leaf) {
                    [IO.File]::Replace($rollback, $item.target, (Join-Path $stage ('failed-' + $item.name)))
                } else { [IO.File]::Move($rollback, $item.target) }
            } elseif (Test-Path -LiteralPath $item.target -PathType Leaf) {
                [IO.File]::Delete($item.target)
            }
        } catch { $rollbackErrors += "$($item.target): $($_.Exception.Message)" }
    }
    if ($rollbackErrors.Count) {
        $preserveBackups = $true
        throw "Production build failed: $failure. Rollback incomplete: $($rollbackErrors -join '; '). Recovery copies preserved in $stage."
    }
    throw $failure
}
finally {
    $resolvedStage = [IO.Path]::GetFullPath($stage)
    if ([IO.Path]::GetDirectoryName($resolvedStage) -ne $binRoot -or [IO.Path]::GetFileName($resolvedStage) -notmatch '^paired-[0-9a-f]{32}$') { throw 'Unsafe staging cleanup path.' }
    if (-not $preserveBackups -and (Test-Path -LiteralPath $resolvedStage)) {
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    }
}
