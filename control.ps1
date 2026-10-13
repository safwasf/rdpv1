param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("list","start","stop","restart")]
    [string]$Action
)
$REPO = "safwasf/rdpv1"
$WORKFLOW = "main.yml"
$BRANCH = "main"
$GH = "C:\Program Files\GitHub CLI\gh.exe"
function Show-List {
    Write-Host ""
    Write-Host "=============================="
    & $GH run list --repo $REPO --workflow $WORKFLOW --limit 10
    Write-Host "=============================="
}
function Start-Run {
    Write-Host "[*] Starting new run..." -ForegroundColor Cyan
    & $GH workflow run $WORKFLOW --repo $REPO --ref $BRANCH
    Write-Host "[+] Done." -ForegroundColor Green
}
function Stop-Runs {
    Write-Host "[*] Cancelling runs..." -ForegroundColor Yellow
    $ids = @(& $GH run list --repo $REPO --workflow $WORKFLOW --status in_progress --json databaseId --jq ".[].databaseId" 2>$null)
    $ids += @(& $GH run list --repo $REPO --workflow $WORKFLOW --status queued --json databaseId --jq ".[].databaseId" 2>$null)
    $ids = $ids | Where-Object { $_ }
    if ($ids.Count -eq 0) { Write-Host "  No active runs." -ForegroundColor Gray; return }
    foreach ($id in $ids) { & $GH run cancel $id --repo $REPO; Write-Host "  [-] Cancelled $id" -ForegroundColor Red }
}
switch ($Action) {
    "list"    { Show-List }
    "start"   { Start-Run; Show-List }
    "stop"    { Stop-Runs; Show-List }
    "restart" { Stop-Runs; Start-Sleep -Seconds 5; Start-Run; Show-List }
}