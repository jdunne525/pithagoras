<#
.SYNOPSIS
    Starts the Pithagoras server natively on Windows without Docker.

.DESCRIPTION
    Ensures dependencies and dist builds exist, loads environment configuration,
    and starts the Pithagoras backend server serving the web frontend.

.PARAMETER OpenBrowser
    Automatically opens default browser to http://localhost:<port>.

.PARAMETER Dev
    Runs the server in development watch mode instead of production dist.

.EXAMPLE
    .\start.ps1
    .\start.ps1 -OpenBrowser
    .\start.ps1 -Dev
#>
[CmdletBinding()]
param(
    [switch]$OpenBrowser,
    [switch]$Dev
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "         Starting Pithagoras            " -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# 1. Verify Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js is not installed or not in PATH. Please install Node.js 22.19+."
    exit 1
}

# 2. Check for .env file
if (-not (Test-Path ".env")) {
    if (Test-Path ".env.example") {
        Write-Warning "No .env found. Copying .env.example to .env..."
        Copy-Item ".env.example" ".env"
    } else {
        Write-Warning "No .env or .env.example found. The server will use default settings."
    }
}

# 3. Check node_modules
if (-not (Test-Path "node_modules")) {
    Write-Host "Dependencies missing. Running npm install..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Error "npm install failed."
        exit $LASTEXITCODE
    }
}

# 4. Check build artifacts
$serverBuilt = Test-Path "server/dist/index.js"
$webBuilt = Test-Path "web/dist/index.html"

if (-not $Dev -and (-not $serverBuilt -or -not $webBuilt)) {
    Write-Host "Build artifacts missing. Running npm run build..." -ForegroundColor Yellow
    npm run build
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Build failed."
        exit $LASTEXITCODE
    }
}

# 5. Determine Port from .env or default to 4100
$port = "4100"
if (Test-Path ".env") {
    $envLines = Get-Content ".env"
    foreach ($line in $envLines) {
        if ($line -match '^\s*PORT\s*=\s*(\d+)') {
            $port = $matches[1]
            break
        }
    }
}

$url = "http://localhost:$port"
Write-Host "`nPithagoras will be available at: " -NoNewline
Write-Host $url -ForegroundColor Green
Write-Host "Press Ctrl+C to stop the server.`\n" -ForegroundColor Gray

if ($OpenBrowser) {
    Start-Job -ScriptBlock {
        param($targetUrl)
        Start-Sleep -Seconds 2
        Start-Process $targetUrl
    } -ArgumentList $url | Out-Null
}

# 6. Start the server
if ($Dev) {
    Write-Host "Starting server in dev mode (tsx watch)..." -ForegroundColor Cyan
    npm run dev:server
} else {
    Write-Host "Starting server..." -ForegroundColor Cyan
    node server/dist/index.js
}
