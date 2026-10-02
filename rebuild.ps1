<#
.SYNOPSIS
    Fully cleans all build artifacts and rebuilds the Pithagoras project from scratch.

.DESCRIPTION
    Switching git branches does not remove previously compiled output, because the
    dist/ directories are gitignored. Running `tsc` / `vite build` only writes changed
    files and never deletes orphaned ones, so code from another branch can linger in
    server/dist and web/dist. This script wipes every build artifact and recompiles
    cleanly so your working branch is what actually gets served.

.PARAMETER Start
    After rebuilding successfully, start the server (production dist build).

.PARAMETER Dev
    After rebuilding successfully, start the server in dev watch mode instead.

.EXAMPLE
    .\rebuild.ps1
    .\rebuild.ps1 -Start
    .\rebuild.ps1 -Start -Dev
#>
[CmdletBinding()]
param(
    [switch]$Start,
    [switch]$Dev,
    [switch]$OpenBrowser
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "        Rebuilding Pithagoras           " -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# 1. Verify Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js is not installed or not in PATH. Please install Node.js 22.19+."
    exit 1
}

# 2. Remove ALL build artifacts and TS build-info caches
function Remove-Artifact($spec) {
    # $spec may be a path or a wildcard pattern
    $items = if ($spec -like '*[*]?*') {
        Get-ChildItem -Path . -Filter $spec -Force -ErrorAction SilentlyContinue
    } else {
        @(Get-ChildItem -Path $spec -Recurse -Force -ErrorAction SilentlyContinue)
    }
    foreach ($item in $items) {
        Remove-Item -Path $item.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-Host "  removed: $spec" -ForegroundColor DarkGray
}
Remove-Artifact 'server/dist'
Remove-Artifact 'web/dist'
Remove-Artifact 'server/tsconfig.tsbuildinfo'
Remove-Artifact 'web/tsconfig.tsbuildinfo'
Remove-Artifact '*.tsbuildinfo'

# 3. Ensure dependencies are installed
if (-not (Test-Path "node_modules")) {
    Write-Host "Dependencies missing. Running npm install..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Error "npm install failed."
        exit $LASTEXITCODE
    }
} else {
    Write-Host "Dependencies present." -ForegroundColor DarkGray
}

# 4. Clean build of server + web
Write-Host "`nBuilding server and web..." -ForegroundColor Yellow
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Error "Build failed."
    exit $LASTEXITCODE
}
Write-Host "Build complete." -ForegroundColor Green

# 5. Optionally start the server via start.ps1
if ($Start -or $Dev) {
    Write-Host "`nStarting server via start.ps1..." -ForegroundColor Cyan
    .\start.ps1 @([ordered]@{ Dev = $Dev; OpenBrowser = $OpenBrowser })
}

Write-Host "Done." -ForegroundColor Green
