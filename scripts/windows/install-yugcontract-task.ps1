# Registers the daily Windows Task Scheduler job for Yugcontract sync.
#
# Idempotent: re-running replaces the existing task (no duplicates).
# Stores NO secrets: the task action only points at yugcontract-sync.ps1;
# credentials live exclusively in the repo-local .env.local.
# "Run whether user is logged on or not" requires the Windows account
# password, entered interactively via Get-Credential and kept only in
# Windows LSA (never in files or command line).
#
# Usage (regular PowerShell, from anywhere):
#   powershell -ExecutionPolicy Bypass -File scripts\windows\install-yugcontract-task.ps1
#Requires -Version 5.1

$ErrorActionPreference = 'Stop'

$taskName = 'YugcontractSync'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent (Split-Path -Parent $scriptDir)
$launcher = Join-Path $scriptDir 'yugcontract-sync.ps1'

if (-not (Test-Path -LiteralPath $launcher)) {
    throw "Launcher not found: $launcher"
}

$runTime = '10:00'   # daily, local time

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ("-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`"") `
    -WorkingDirectory $root

$trigger = New-ScheduledTaskTrigger -Daily -At $runTime

# StartWhenAvailable: run ASAP after a missed start (PC was off).
# MultipleInstances IgnoreNew: never run two syncs in parallel.
# DisallowStartIfOnBatteries/StopIfGoingOnBatteries: skip on battery power.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -DisallowStartIfOnBatteries `
    -StopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
    -WakeToRun

# Replaces the previous instance if it exists (idempotent install).
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Output "[install] task '$taskName' already exists — replacing it"
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

$credential = Get-Credential -UserName $env:USERNAME -Message (
    "Windows password for '$env:USERNAME' — needed so the task can run " +
    "whether you are logged on or not. Stored only in Windows LSA."
)

$principal = New-ScheduledTaskPrincipal -UserId $credential.UserName `
    -LogonType Password -RunLevel Limited

Register-ScheduledTask -TaskName $taskName `
    -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal -Password $credential.GetNetworkCredential().Password | Out-Null

Write-Output "[install] task '$taskName' registered: daily at $runTime, launcher: $launcher"
Write-Output "[install] verify with:  Get-ScheduledTask -TaskName $taskName | Format-List *"
Write-Output "[install] manual run:   Start-ScheduledTask -TaskName $taskName"
