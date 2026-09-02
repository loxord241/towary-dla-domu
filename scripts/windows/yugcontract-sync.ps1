# Windows launcher for the existing Yugcontract sync (OPS: scheduled sync on home PC).
#
# Runs the UNCHANGED canonical importer command:
#   node scripts/yugcontract-import-run.ts --run
# Credentials come ONLY from the repo-local .env.local, which the importer
# itself reads. No secrets are passed as arguments and none are printed.
#
# Exit codes:
#   0                    sync completed successfully
#   1                    importer exited with its own non-zero code (propagated)
#   2                    Node.js not found in PATH
#   3                    Node.js version too old (need v24+, TS strip-types)
#   4                    .env.local not found in repo root
#   5                    importer script missing
#   10                   log file could not be created
#Requires -Version 5.1

$ErrorActionPreference = 'Stop'

# --- repo root: parent of scripts\windows ------------------------------------
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent (Split-Path -Parent $scriptDir)
Set-Location -LiteralPath $root

function Fail([int]$code, [string]$message) {
    Write-Output ("[yugcontract-sync] FAILED: " + $message)
    exit $code
}

# --- preflight: node, env, importer ------------------------------------------
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { Fail 2 "Node.js not found in PATH. Install Node 24 LTS (https://nodejs.org)" }

$nodeVersion = & node --version
Write-Output ("[yugcontract-sync] node " + $nodeVersion)
if ($nodeVersion -notmatch '^v(2[4-9]|[3-9][0-9])\.') {
    Fail 3 ("Node v24+ required, found " + $nodeVersion)
}

$envFile = Join-Path $root '.env.local'
if (-not (Test-Path -LiteralPath $envFile)) {
    Fail 4 ".env.local not found in repo root: $envFile"
}

$importer = Join-Path $root 'scripts\yugcontract-import-run.ts'
if (-not (Test-Path -LiteralPath $importer)) {
    Fail 5 "Importer script missing: $importer"
}

# --- logs: create dir, rotate old files (keep ~14 days) -----------------------
$logsDir = Join-Path $root 'logs'
try {
    New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
} catch {
    Fail 10 ("Cannot create logs dir: " + $_.Exception.Message)
}
$logPath = Join-Path $logsDir ("yugcontract-sync-{0}.log" -f (Get-Date -Format 'yyyyMMdd'))
try {
    Get-ChildItem -LiteralPath $logsDir -Filter 'yugcontract-sync-*.log' |
        Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } |
        Remove-Item -Force -ErrorAction SilentlyContinue
} catch {
    # rotation failure must never block the sync itself
    Write-Output "[yugcontract-sync] log rotation skipped (non-fatal)"
}

Write-Output ("[yugcontract-sync] start " + (Get-Date -Format o))
Write-Output ("[yugcontract-sync] log: " + $logPath)

# --- exclusive lock + 48h interval gate (mirrors scripts/wsl/yugcontract-sync.sh) ---
# Without the lock, the Windows scheduled task can run in parallel with the
# WSL launcher (its flock is invisible to Windows processes) or with a manual
# run. The stamp check enforces the documented 48h interval between
# SUCCESSFUL syncs; the importer additionally gates on the DB (last 'done'
# batch), so CI/WSL/Windows share one interval contract.
$Force = $args -contains '--force'
$lockPath = Join-Path $logsDir '.yugcontract-sync.lock'
$stampPath = Join-Path $logsDir '.yugcontract-last-success'
$lockStream = $null
try {
    $lockStream = [System.IO.File]::Open(
        $lockPath,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::None)
} catch {
    Write-Output "[yugcontract-sync] another sync is already running (lock held) - skipping"
    exit 0
}

if (-not $Force -and (Test-Path -LiteralPath $stampPath)) {
    $ageH = ((Get-Date) - (Get-Item -LiteralPath $stampPath).LastWriteTime).TotalHours
    if ($ageH -lt 47) {
        Write-Output ("[yugcontract-sync] last success {0:N1}h ago - skipping (< 48h interval; use --force to override)" -f $ageH)
        $lockStream.Close()
        exit 0
    }
}

# --- canonical sync -----------------------------------------------------------
# Native stderr is merged for logging; ErrorActionPreference is relaxed here so
# stderr lines never abort the run — the importer's exit code is the truth.
try {
$ErrorActionPreference = 'Continue'
$importerArgs = @('--run')
if ($Force) { $importerArgs += '--force' }
& node $importer @importerArgs 2>&1 |
    ForEach-Object {
        $line = "$_"
        # defensive scrub: never let env-like or token-bearing lines reach the log
        if ($line -match '^\s*[A-Z0-9_]+\s*=') { '[redacted env-like line]' }
        elseif ($line -match '(?i)requestToken|authToken|Authorization|bearer\s|token=|bot\d+:') { '[redacted token-bearing line]' }
        else { $line }
    } | Tee-Object -FilePath $logPath -Append | Out-String -Width 4096 |
    Write-Output

$importerExit = $LASTEXITCODE
$ErrorActionPreference = 'Stop'

if ($importerExit -ne 0) {
    Write-Output ("[yugcontract-sync] importer exited with code " + $importerExit)
    Write-Output "[yugcontract-sync] if the failure is a crashed run, resume manually with:"
    Write-Output "    node scripts/yugcontract-import-run.ts --run --resume <RUN_ID from log>"
} else {
    # Stamp the success time for the 48h gate (wall-clock based).
    Set-Content -LiteralPath $stampPath -Value ([DateTimeOffset]::Now.ToUnixTimeSeconds())
    Write-Output "[yugcontract-sync] done OK"
}
} finally {
    if ($lockStream) { $lockStream.Close() }
}
exit $importerExit
