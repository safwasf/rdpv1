#!/usr/bin/env pwsh
# ============================================================
#  ONE-TIME SETUP SCRIPT
#  Run this once. After this, just click "Run workflow" in GitHub Actions.
# ============================================================

Write-Host ""
Write-Host "=========================================="
Write-Host "       RDP GITHUB ACTIONS SETUP"
Write-Host "=========================================="
Write-Host ""

# ── Step 1: Check gh CLI ─────────────────────────────────────
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Host "[!] GitHub CLI not found. Installing..." -ForegroundColor Yellow
    winget install --id GitHub.cli -e --silent
    $env:PATH += ";$env:LOCALAPPDATA\Microsoft\WinGet\Packages\GitHub.cli_Microsoft.Winget.Source_8wekyb3d8bbwe\tools"
}

# ── Step 2: gh login check ───────────────────────────────────
$authStatus = gh auth status 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "[*] Logging into GitHub..." -ForegroundColor Cyan
    gh auth login
}

# ── Step 3: Get repo info ────────────────────────────────────
$repoUrl = git remote get-url origin 2>$null
if (-not $repoUrl) {
    $repoUrl = Read-Host "[?] GitHub repo URL (e.g. https://github.com/yourname/yourrepo)"
}
Write-Host "[+] Repo: $repoUrl" -ForegroundColor Green

# ── Step 4: Get Tailscale Auth Key ───────────────────────────
Write-Host ""
Write-Host "Go to: https://login.tailscale.com/admin/settings/keys"
Write-Host "Click 'Generate auth key' → enable Reusable + Ephemeral → Copy the key"
Write-Host ""
$tsKey = Read-Host "[?] Paste your Tailscale Auth Key here"

if (-not $tsKey -or $tsKey.Length -lt 10) {
    Write-Host "[!] Invalid key. Exiting." -ForegroundColor Red
    exit 1
}

# ── Step 5: Set GitHub Secret ────────────────────────────────
Write-Host "[*] Setting TAILSCALE_AUTH_KEY secret in GitHub..." -ForegroundColor Cyan
$tsKey | gh secret set TAILSCALE_AUTH_KEY --repo $repoUrl

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "=========================================="
    Write-Host "  [OK] Secret set successfully!"
    Write-Host "  Now go to GitHub Actions and click:"
    Write-Host "  Actions → RDP → Run workflow"
    Write-Host "=========================================="
} else {
    Write-Host "[!] Failed to set secret. Check repo URL and gh login." -ForegroundColor Red
}
