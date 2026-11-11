[CmdletBinding()]
param(
    [string]$ApiDll,
    [string]$OutputPath,
    [switch]$SkipSelfTest,
    [string]$Version
)

# Kept for existing npm scripts and references; the build lives in Build-TiaNative.ps1.
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'Build-TiaNative.ps1') -Component live-core -Version $Version -ApiDll $ApiDll -OutputPath $OutputPath -SkipSelfTest:$SkipSelfTest
