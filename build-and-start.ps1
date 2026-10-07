<#
.SYNOPSIS
    Cleanly rebuilds every part of Pithagoras and then starts the server, in one step.

.DESCRIPTION
    Combines rebuild.ps1 and start.ps1 into a single command. It wipes all build
    artifacts and TS build-info caches, installs dependencies if needed, runs a
    full clean build of both the server and the web frontend, and then launches
    the server from the freshly built dist. Because it always rebuilds from
    scratch, the bundle that gets served always reflects the current source —
    there is no way to start against an old or half-built server/dist or
    web/dist. This is the script to use whenever you have changed source and
    want a guaranteed-fresh app, rather than the two-step
    .\rebuild.ps1 followed by .\start.ps1.

.PARAMETER Dev
    Start the server in dev watch mode (tsx) instead of the production dist build.

.PARAMETER OpenBrowser
    After starting, open the default browser to the portal URL.

.EXAMPLE
    .\build-and-start.ps1
    .\build-and-start.ps1 -Dev
    .\build-and-start.ps1 -OpenBrowser
#>
[CmdletBinding()]
param(
    [switch]$Dev,
    [switch]$OpenBrowser
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Building and Starting Pithagoras     " -ForegroundColor Cyan
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

# 4. Full clean build of server + web
Write-Host "`nBuilding server and web..." -ForegroundColor Yellow
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Error "Build failed."
    exit $LASTEXITCODE
}
Write-Host "Build complete." -ForegroundColor Green

# 5. Start the server via start.ps1
Write-Host "`nStarting server via start.ps1..." -ForegroundColor Cyan
$startParams = [ordered]@{ Dev = $Dev; OpenBrowser = $OpenBrowser }
.\start.ps1 @startParams

Write-Host "Done." -ForegroundColor Green
