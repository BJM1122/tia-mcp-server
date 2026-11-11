[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('live-core', 'importer', 'hmi', 'v15-snapshot')]
    [string]$Component,
    # Portal version id from portal-versions.json; defaults to the component's own version.
    [string]$Version,
    [string]$ApiDll,
    [string]$OutputPath,
    [switch]$SkipSelfTest,
    [string]$InstallFrom,
    [switch]$RequireSelfTest,
    # Build for a version of a family this component serves even though the row
    # does not allow its capability yet, to test it before enabling it. The server
    # never probes or launches such a build until the row allows the capability.
    [switch]$Preview
)

# One build path for every native companion and TIA Portal version. The version
# row (API assembly, project extension) comes from portal-versions.json and is
# compiled in as TiaBuildTarget, so a binary built for one version rejects all
# others. Compiler flags per component match their historical build scripts.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($RequireSelfTest -and $SkipSelfTest) { throw 'RequireSelfTest cannot be combined with SkipSelfTest.' }

$serverRoot = Split-Path $PSScriptRoot -Parent
$liveCoreDir = Join-Path $serverRoot 'live-core'
$framework64 = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $framework64 'csc.exe'
$strictFlags = @('/optimize+', '/checked+', '/warn:4', '/langversion:5')

# Compiler details per component. Name, output directory, sources, adapter and
# build capability come from the shared component table in portal-versions.json.
$compileSpecs = @{
    'live-core' = @{
        flags = $strictFlags; needsApi = $true
        references = @((Join-Path $framework64 'System.Web.Extensions.dll'), 'System.dll', 'System.Core.dll', 'System.Security.dll', 'System.Xml.dll')
    }
    'importer' = @{
        flags = $strictFlags; needsApi = $true
        references = @('System.dll', 'System.Core.dll', 'System.Xml.dll', 'System.Xml.Linq.dll', 'System.Web.Extensions.dll')
    }
    'hmi' = @{
        flags = @(); needsApi = $true
        references = @('System.Web.Extensions.dll', 'System.Core.dll', 'System.Xml.Linq.dll', 'System.Drawing.dll')
    }
    'v15-snapshot' = @{
        flags = $strictFlags; needsApi = $false
        references = @((Join-Path $framework64 'System.Web.Extensions.dll'), 'System.Core.dll')
    }
}

$table = Get-Content -LiteralPath (Join-Path $serverRoot 'portal-versions.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$tableIds = @($table.components | ForEach-Object { [string]$_.id } | Sort-Object)
if (($tableIds -join ',') -ne ((@($compileSpecs.Keys) | Sort-Object) -join ',')) {
    throw "portal-versions.json components ($($tableIds -join ', ')) do not match this script's compile specs."
}
$entry = $table.components | Where-Object { $_.id -eq $Component } | Select-Object -First 1
$fromRoot = { param([string]$relative) [IO.Path]::GetFullPath((Join-Path $serverRoot $relative)) }
$spec = $compileSpecs[$Component]
$spec.adapters = @($entry.adapters | ForEach-Object { [string]$_ })
$spec.capability = [string]$entry.buildCapability
$spec.baseName = [string]$entry.baseName
$spec.outputDir = & $fromRoot ([string]$entry.outputDir)
$spec.sources = @($entry.sources | ForEach-Object { & $fromRoot ([string]$_) })

# --- Version row -----------------------------------------------------------
# Same rule as componentAllowed() in src/tia-version.ts: the row's adapter family
# is one this component serves, and the row allows the component's capability.
function Test-ComponentAllowed($candidateRow) {
    return $null -ne $candidateRow.adapter -and ($spec.adapters -contains [string]$candidateRow.adapter) -and
        (@($candidateRow.capabilities) -contains $spec.capability)
}
$candidates = @($table.versions | Where-Object { Test-ComponentAllowed $_ })
if ($candidates.Count -eq 0) { throw "No portal version in portal-versions.json allows $Component ($($spec.capability) through $($spec.adapters -join '/'))." }
# The component's own version keeps the historical, unsuffixed file name.
$homeVersion = if (@($candidates.id) -contains $table.defaultVersion) { $table.defaultVersion } else { $candidates[0].id }
if ([string]::IsNullOrWhiteSpace($Version)) { $Version = $homeVersion }
$row = $table.versions | Where-Object { $_.id -eq $Version } | Select-Object -First 1
if ($null -eq $row) { throw "Unknown portal version '$Version'." }
if (-not (Test-ComponentAllowed $row)) {
    $familyServed = $null -ne $row.adapter -and ($spec.adapters -contains [string]$row.adapter)
    if (-not ($Preview -and $familyServed)) {
        throw "Portal version $Version does not allow $Component ($($spec.capability) through $($spec.adapters -join '/')); add it to portal-versions.json first, or use -Preview to test a build."
    }
    Write-Warning "Preview build: $Version does not allow $($spec.capability) yet, so the server will not use this $Component build."
}
# Feature names must come from the declared vocabulary; same rules as src/tia-version.ts
# (snake_case, unique, case-sensitive), so the build and the server agree.
$featureNames = @($table.apiFeatureNames | ForEach-Object { [string]$_ })
$rowFeatures = @($row.apiFeatures | ForEach-Object { [string]$_ })
foreach ($name in $featureNames) { if ($name -cnotmatch '^[a-z][a-z0-9_]*$') { throw "portal-versions.json has an invalid apiFeatureNames entry '$name'." } }
if (@($featureNames | Select-Object -Unique).Count -ne $featureNames.Count) { throw 'portal-versions.json has duplicate apiFeatureNames.' }
if (@($rowFeatures | Select-Object -Unique).Count -ne $rowFeatures.Count) { throw "Version $Version lists an API feature twice." }
foreach ($feature in $rowFeatures) { if (-not ($featureNames -ccontains $feature)) { throw "Version $Version lists unknown API feature '$feature'." } }

# --- API assembly ----------------------------------------------------------
function Resolve-ApiDll {
    if (-not [string]::IsNullOrWhiteSpace($ApiDll)) { return $ApiDll }
    $names = @($row.apiDllEnv)
    if ($row.PSObject.Properties['legacyApiDllEnv']) { $names += $row.legacyApiDllEnv }
    foreach ($name in $names) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if (-not [string]::IsNullOrWhiteSpace($value) -and (Test-Path -LiteralPath $value.Trim() -PathType Leaf)) { return $value.Trim() }
    }
    $roots = @()
    foreach ($subkey in 'Global', 'EditionMain') {
        $key = "HKLM:\SOFTWARE\Siemens\Automation\_InstalledSW\$($row.registryKey)\$subkey"
        $root = (Get-ItemProperty -LiteralPath $key -Name Path -ErrorAction SilentlyContinue).Path
        if ($root) { $roots += ([string]$root).TrimEnd('\'); break }
    }
    $roots += @($row.installRoots)
    foreach ($root in $roots) {
        $candidate = Join-Path $root "PublicAPI\$($row.apiFolder)\Siemens.Engineering.dll"
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return $null
}

# A component that does not reference the API (v15-snapshot) ignores env and
# registry DLLs, so an unrelated DLL there cannot break its build.
$resolvedApi = if ($spec.needsApi -or -not [string]::IsNullOrWhiteSpace($ApiDll)) { Resolve-ApiDll } else { $null }
if (-not [string]::IsNullOrWhiteSpace($ApiDll) -and -not (Test-Path -LiteralPath $ApiDll -PathType Leaf)) { throw "Siemens $Version API assembly was not found: $ApiDll" }
if ($spec.needsApi -and -not $resolvedApi) { throw "Siemens.Engineering.dll for $Version was not found. Install its Openness component or pass -ApiDll." }
if ($resolvedApi) {
    $resolvedApi = (Resolve-Path -LiteralPath $resolvedApi).Path
    if (-not [string]::Equals([IO.Path]::GetFileName($resolvedApi), 'Siemens.Engineering.dll', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'ApiDll must point to Siemens.Engineering.dll.'
    }
    $apiVersion = [Reflection.AssemblyName]::GetAssemblyName($resolvedApi).Version
    if ($null -eq $apiVersion -or $apiVersion.Major -ne $row.apiAssembly.major -or $apiVersion.Minor -ne $row.apiAssembly.minor) {
        throw "ApiDll must be the Siemens.Engineering $Version public API assembly; found version $apiVersion."
    }
}

# --- Compile ---------------------------------------------------------------
if (-not [Environment]::Is64BitOperatingSystem) { throw 'TIA native companions require 64-bit Windows.' }
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw "64-bit .NET Framework C# compiler was not found: $compiler" }
if (-not (Test-Path -LiteralPath (Join-Path $framework64 'System.Web.Extensions.dll') -PathType Leaf)) { throw "System.Web.Extensions.dll was not found: $framework64" }
foreach ($source in $spec.sources) { if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Source was not found: $source" } }

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $suffix = if ($Version -eq $homeVersion) { '' } else { '.' + $Version.ToLowerInvariant().Replace('.', '_') }
    $OutputPath = Join-Path $spec.outputDir ($spec.baseName + $suffix + '.exe')
}
$resolvedOutput = [IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path $resolvedOutput -Parent
if (-not (Test-Path -LiteralPath $outputDirectory -PathType Container)) { New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null }
$stagingDirectory = Join-Path $outputDirectory ('.tia-native-build-' + $PID + '-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stagingDirectory -ErrorAction Stop | Out-Null
$stagedOutput = Join-Path $stagingDirectory ([IO.Path]::GetFileName($resolvedOutput))
$backupOutput = Join-Path $outputDirectory (([IO.Path]::GetFileName($resolvedOutput)) + '.backup-' + $PID + '-' + [Guid]::NewGuid().ToString('N') + '.exe')

function CSharpString([string]$value) { return '"' + $value.Replace('\', '\\').Replace('"', '\"') + '"' }
$targetSource = Join-Path $stagingDirectory 'TiaBuildTarget.g.cs'
@(
    '// <auto-generated> by tools/Build-TiaNative.ps1 from portal-versions.json. Do not edit.'
    'internal static class TiaBuildTarget'
    '{'
    "    public const string PortalVersion = $(CSharpString $row.id);"
    "    public const int ApiMajor = $([int]$row.apiAssembly.major);"
    "    public const int ApiMinor = $([int]$row.apiAssembly.minor);"
    "    public const string ProjectExtension = $(CSharpString $row.projectExtension);"
    "    public static readonly string[] ApiFeatures = { $(($rowFeatures | ForEach-Object { CSharpString $_ }) -join ', ') };"
    '}'
) | Set-Content -LiteralPath $targetSource -Encoding UTF8

$arguments = @('/nologo', '/target:exe', '/platform:x64') + $spec.flags + @("/out:$stagedOutput")
# TIA_API_<FEATURE> for each feature the version has; sources fall back without it.
if ($rowFeatures.Count -gt 0) { $arguments += '/define:' + (($rowFeatures | ForEach-Object { 'TIA_API_' + $_.ToUpperInvariant() }) -join ';') }
if ($spec.needsApi) { $arguments += "/reference:$resolvedApi" }
$arguments += @($spec.references | ForEach-Object { "/reference:$_" })
$arguments += @($spec.sources) + @((Join-Path $liveCoreDir 'Common\TiaNativeTarget.cs'), $targetSource)

# --- Self-tests (offline; no project or PLC access) ------------------------
# Every self-test reports the version it was built for and the capabilities it
# implements; the server enables a capability for a version only on that report.
function Assert-SelfTestTarget($json) {
    if ($json.ok -ne $true -or ($json.PSObject.Properties['status'] -and $json.status -ne 'self_test_passed')) {
        throw "The staged $Component did not report a successful offline self-test."
    }
    $expected = "$([int]$row.apiAssembly.major).$([int]$row.apiAssembly.minor)"
    $target = if ($json.PSObject.Properties['target']) { $json.target } else { $null }
    if ($null -eq $target -or -not $target.PSObject.Properties['portalVersion'] -or -not $target.PSObject.Properties['apiAssembly'] -or
        [string]$target.portalVersion -ne $Version -or [string]$target.apiAssembly -ne $expected) {
        throw "The staged $Component self-test does not report its build target $Version (API $expected)."
    }
    $compiled = @(if ($target.PSObject.Properties['apiFeatures']) { $target.apiFeatures | ForEach-Object { [string]$_ } })
    if ((($compiled | Sort-Object) -join ',') -cne (($rowFeatures | Sort-Object) -join ',')) {
        throw "The staged $Component self-test reports API features [$($compiled -join ', ')], not $Version's [$($rowFeatures -join ', ')]."
    }
    $reported = @(if ($json.PSObject.Properties['capabilities']) { $json.capabilities | ForEach-Object { [string]$_ } })
    if ($reported.Count -eq 0 -or -not ($reported -contains $spec.capability)) {
        throw "The staged $Component self-test does not report its capability $($spec.capability)."
    }
}

function Invoke-SelfTest {
    switch ($Component) {
        'live-core' {
            $out = & $stagedOutput --api $resolvedApi --self-test
            if ($LASTEXITCODE -ne 0) { throw "Offline live-core self-test failed with exit code $LASTEXITCODE. Output: $out" }
            $json = $out | ConvertFrom-Json
            if (-not $json.ok -or $json.status -ne 'self_test_passed') { throw "Offline live-core self-test returned an invalid result: $out" }
            Assert-SelfTestTarget $json
            Write-Output $out
        }
        'importer' {
            $lines = @(& $stagedOutput --self-test --api $resolvedApi 2>&1)
            $exit = $LASTEXITCODE
            $last = $lines | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Last 1
            if ($exit -ne 0 -or [string]::IsNullOrWhiteSpace($last)) { throw "The staged importer did not pass its bounded offline --self-test (exit $exit)." }
            try { $test = $last | ConvertFrom-Json -ErrorAction Stop }
            catch { throw "The staged importer returned an invalid --self-test JSON envelope: $($_.Exception.Message)" }
            $reported = [Version]'0.0'
            if ($null -ne $test.apiAssemblyVersion) { [void][Version]::TryParse([string]$test.apiAssemblyVersion, [ref]$reported) }
            $reportedPath = if ($null -eq $test.apiPath) { '' } else { [IO.Path]::GetFullPath([string]$test.apiPath) }
            $safe = $test.ok -eq $true -and [string]$test.status -eq 'self_test_passed' -and [int]$test.protocolVersion -eq 1 -and
                $reported.Major -eq $row.apiAssembly.major -and $reported.Minor -eq $row.apiAssembly.minor -and
                [string]::Equals($reportedPath, $resolvedApi, [StringComparison]::OrdinalIgnoreCase) -and
                $test.safety.selfTestOnly -eq $true -and $test.safety.projectOpened -eq $false -and $test.safety.projectModified -eq $false -and
                $test.safety.plcAccessed -eq $false -and $test.safety.import -eq $false -and $test.safety.download -eq $false
            if (-not $safe) { throw "The staged importer --self-test did not satisfy the protocol, API $Version identity, and no-project/no-PLC safety contract." }
            Assert-SelfTestTarget $test
        }
        'hmi' {
            $out = & $stagedOutput $resolvedApi --self-test
            if ($LASTEXITCODE -ne 0) { throw 'HMI companion API self-test failed.' }
            Assert-SelfTestTarget ($out | ConvertFrom-Json)
            Write-Output $out
        }
        'v15-snapshot' {
            $contract = & $stagedOutput --snapshot-candidate-contract-v1 | ConvertFrom-Json
            if ($LASTEXITCODE -ne 0 -or -not $contract.candidateOnly -or $contract.currentPointerWrittenByNative) { throw 'Snapshot companion contract check failed.' }
            # The compile does not need the API, but its self-test does. Use the
            # version's DLL when one is found with the right version; a missing or
            # unrelated DLL skips the check here (the server's probe still runs it).
            $selfTestApi = $resolvedApi
            if (-not $selfTestApi) {
                $candidate = Resolve-ApiDll
                if ($candidate) {
                    $candidateVersion = [Reflection.AssemblyName]::GetAssemblyName($candidate).Version
                    if ($null -ne $candidateVersion -and $candidateVersion.Major -eq $row.apiAssembly.major -and $candidateVersion.Minor -eq $row.apiAssembly.minor) { $selfTestApi = $candidate }
                }
            }
            if ($selfTestApi) {
                $out = & $stagedOutput --api $selfTestApi --self-test
                if ($LASTEXITCODE -ne 0) { throw 'Snapshot companion API self-test failed.' }
                Assert-SelfTestTarget ($out | ConvertFrom-Json)
            }
            elseif ($RequireSelfTest) { throw "No $Version Siemens.Engineering.dll found; production installation requires its offline self-test." }
            else { Write-Warning "No $Version Siemens.Engineering.dll found; the snapshot self-test target check was skipped." }
        }
    }
}

# Install-time helpers (live-core shutdown, old-core marker, image replacement).
# They live in their own file so that changing them does not make every native
# component stale: this script is a native staleness input, TiaNativeInstall.ps1 is not.
. (Join-Path $PSScriptRoot 'TiaNativeInstall.ps1')

try {
    if ($InstallFrom) { Copy-Item -LiteralPath $InstallFrom -Destination $stagedOutput }
    else {
        & $compiler $arguments
        if ($LASTEXITCODE -ne 0) { throw "Framework64 csc failed with exit code $LASTEXITCODE." }
    }
    if (-not (Test-Path -LiteralPath $stagedOutput -PathType Leaf) -or (Get-Item -LiteralPath $stagedOutput).Length -le 0) {
        throw "Compiler returned success but did not create a usable staged executable: $stagedOutput"
    }
    if (-not $SkipSelfTest) { Invoke-SelfTest }

    Install-NativeImage $Component $stagedOutput $resolvedOutput $backupOutput
}
finally {
    if (Test-Path -LiteralPath $stagedOutput -PathType Leaf) { Remove-Item -LiteralPath $stagedOutput -Force }
    if (Test-Path -LiteralPath $backupOutput -PathType Leaf) { [void](Remove-FileWithRetry $backupOutput) }
    if (Test-Path -LiteralPath $stagingDirectory -PathType Container) { Remove-Item -LiteralPath $stagingDirectory -Recurse -Force }
}

$outputFile = Get-Item -LiteralPath $resolvedOutput
[pscustomobject]@{
    component = $Component
    portalVersion = $Version
    output = $resolvedOutput
    bytes = $outputFile.Length
    fileVersion = $outputFile.VersionInfo.FileVersion
    compiler = $compiler
    platform = 'x64'
    apiDll = $resolvedApi
    selfTest = -not $SkipSelfTest
} | ConvertTo-Json -Depth 2 -Compress
