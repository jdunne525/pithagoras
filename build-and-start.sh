#!/usr/bin/env bash
#
# Wrapper around build-and-start.ps1 so the project can be launched from
# git-bash / POSIX shells without needing PowerShell syntax.
#
# Usage:
#   ./build-and-start.sh            # clean rebuild + start (production dist)
#   ./build-and-start.sh -Dev       # rebuild and start in dev watch mode
#   ./build-and-start.sh -OpenBrowser   # rebuild, start, open the browser
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Resolve a PowerShell launcher: prefer pwsh (PowerShell 7), fall back to the
# legacy Windows powershell (5.x) cmdlet.
if command -v pwsh >/dev/null 2>&1; then
    PS=pwsh
elif command -v powershell >/dev/null 2>&1; then
    PS=powershell
else
    echo "Error: no PowerShell runtime found. Install PowerShell 7 or later." >&2
    exit 1
fi

exec "$PS" -File "$SCRIPT_DIR/build-and-start.ps1" "$@"
