[CmdletBinding()]
param(
    [string]$ApiDll,
    [string]$Version
)

# Kept for existing npm scripts and references; the build lives in Build-TiaNative.ps1.
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'Build-TiaNative.ps1') -Component hmi -Version $Version -ApiDll $ApiDll
