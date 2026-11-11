[CmdletBinding()]
param(
    [string]$ApiDll,
    [string]$OutputPath,
    [string]$Version
)

# Kept for existing npm scripts and references; the build lives in Build-TiaNative.ps1.
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'Build-TiaNative.ps1') -Component importer -Version $Version -ApiDll $ApiDll -OutputPath $OutputPath
