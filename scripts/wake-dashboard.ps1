param(
  [string]$WakeTime = "07:00",
  [string]$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$TaskName = "ESG Dashboard Wake And Start",
  [int]$WakeInMinutes = 0,
  [switch]$Once,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

if ($WakeInMinutes -lt 0) {
  throw "WakeInMinutes must be 0 or greater."
}

if ($WakeInMinutes -eq 0 -and $WakeTime -notmatch "^([01]\d|2[0-3]):[0-5]\d$") {
  throw "WakeTime must use HH:MM format."
}

$startBoundary = $null
if ($WakeInMinutes -gt 0) {
  $startBoundary = (Get-Date).AddMinutes($WakeInMinutes)
  $Once = $true
} else {
  $parts = $WakeTime.Split(":")
  $startBoundary = (Get-Date).Date.AddHours([int]$parts[0]).AddMinutes([int]$parts[1])
  if ($startBoundary -lt (Get-Date)) {
    $startBoundary = $startBoundary.AddDays(1)
  }
}

$triggerLabel = if ($Once) {
  "once at $($startBoundary.ToString('yyyy-MM-dd HH:mm'))"
} else {
  "daily at $WakeTime"
}

if ($DryRun) {
  Write-Output "DRY RUN: would register task '$TaskName' to wake and start dashboard $triggerLabel."
  exit 0
}

$action = New-ScheduledTaskAction `
  -Execute "cmd.exe" `
  -Argument "/c cd /d `"$ProjectDir`" && npm.cmd run devStart"

$trigger = if ($Once) {
  New-ScheduledTaskTrigger -Once -At $startBoundary
} else {
  New-ScheduledTaskTrigger -Daily -At $startBoundary
}

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

Write-Output "Wake task '$TaskName' registered to wake and start dashboard $triggerLabel."
