#!/usr/bin/env pwsh
# ============================================================
#  RDP Auto-Connect Script
#  Run this on YOUR machine after the GitHub workflow is running.
#  Paste the Tailscale IP from the workflow log when prompted.
# ============================================================

param(
    [string]$IP = ""
)

if (-not $IP) {
    $IP = Read-Host "Tailscale IP (from workflow log)"
}

$user = "RDP"
$pass = "rakib123"

# Store credentials so RDP auto-logins without password prompt
cmdkey /add:TERMSRV/$IP /user:$user /pass:$pass | Out-Null

Write-Host "[+] Credentials saved. Connecting to $IP..." -ForegroundColor Green

# Launch RDP fullscreen with auto-login
mstsc /v:$IP /f

# Clean up saved credentials after session ends (optional security)
# cmdkey /delete:TERMSRV/$IP
