<#
Copies player assets from .\src to Anki's collection.media.

Usage:
  .\scripts\deploy-windows.ps1
  # or override destination:
  .\scripts\deploy-windows.ps1 -AnkiMedia "C:\Users\<YOU>\AppData\Roaming\Anki2\User 1\collection.media"
#>

param(
  [string]$AnkiMedia
)

# --- CONFIG ---
if (-not $AnkiMedia -or -not (Test-Path $AnkiMedia)) {
  $default1 = Join-Path $env:APPDATA "Anki2\User 1\collection.media"
  if (Test-Path $default1) {
    $AnkiMedia = $default1
  } else {
    Write-Error "Could not auto-detect Anki media folder. Pass -AnkiMedia explicitly."
    Write-Host 'Example:'
    Write-Host '  .\scripts\deploy-windows.ps1 -AnkiMedia "C:\Users\<YOU>\AppData\Roaming\Anki2\User 1\collection.media"'
    exit 1
  }
}

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path (Join-Path $root "..")
$src = Join-Path $projectRoot "src"

$files = @(
  "_player.js",
  "_player.css",
  "_7.10.1_wavesurfer.esm.min.js",
  "_7.10.1-regions.esm.min.js"
)

Write-Host "→ Source: $src"
Write-Host "→ Dest:   $AnkiMedia"
Write-Host ""

if (-not (Test-Path $src)) {
  Write-Error "Missing src folder: $src"
  exit 1
}
if (-not (Test-Path $AnkiMedia)) {
  Write-Error "Missing Anki media folder: $AnkiMedia"
  exit 1
}

foreach ($f in $files) {
  $from = Join-Path $src $f
  $to = Join-Path $AnkiMedia $f
  if (-not (Test-Path $from)) {
    Write-Error "Missing file: $from"
    exit 1
  }
  Copy-Item -Force $from $to
  Write-Host "✓ Copied $f"
}

Write-Host ""
Write-Host "✔ Deployed $($files.Count) files to:"
Write-Host "  $AnkiMedia"
Write-Host "Tip: Refresh Anki's preview (or sync on mobile) to pick up changes."
