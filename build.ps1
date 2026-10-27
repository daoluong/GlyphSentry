# Packs the extension into dist/glyphsentry.xpi
# Usage: powershell -ExecutionPolicy Bypass -File .\build.ps1
$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$dist = Join-Path $root "dist"
$xpi = Join-Path $dist "glyphsentry.xpi"

New-Item -ItemType Directory -Force -Path $dist | Out-Null
if (Test-Path $xpi) { Remove-Item $xpi -Force }

$include = @("manifest.json", "background.js", "content", "options", "icons")

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$zip = [System.IO.Compression.ZipFile]::Open($xpi, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($item in $include) {
        $path = Join-Path $root $item
        if (-not (Test-Path $path)) { throw "Missing: $item" }
        if (Test-Path $path -PathType Container) {
            Get-ChildItem $path -Recurse -File | ForEach-Object {
                $relative = $_.FullName.Substring($root.Length + 1).Replace('\', '/')
                [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $relative) | Out-Null
            }
        } else {
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $path, $item) | Out-Null
        }
    }
} finally {
    $zip.Dispose()
}

Write-Host "Built $xpi"
