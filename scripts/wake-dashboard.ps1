param(
  [string]$WakeTime = "07:00",
  [string]$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$TaskName = "ESG Dashboard Wake And Start",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

if ($WakeTime -notmatch "^([01]\d|2[0-3]):[0-5]\d$") {
  throw "WakeTime must use HH:MM format."
}

if ($DryRun) {
  Write-Output "DRY RUN: would register task '$TaskName' to wake and start dashboard daily at $WakeTime."
  exit 0
}

$parts = $WakeTime.Split(":")
$startBoundary = (Get-Date).Date.AddHours([int]$parts[0]).AddMinutes([int]$parts[1])
if ($startBoundary -lt (Get-Date)) {
  $startBoundary = $startBoundary.AddDays(1)
}

$action = New-ScheduledTaskAction `
  -Execute "cmd.exe" `
  -Argument "/c cd /d `"$ProjectDir`" && npm.cmd run devStart"

$trigger = New-ScheduledTaskTrigger -Daily -At $startBoundary

$settings = New-ScheduledTaskSettingsSet `
  -WakeToRun `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "Wake this Windows device and start the ESG Dashboard." `
  -Force | Out-Null

Write-Output "Wake task '$TaskName' registered for daily $WakeTime."
