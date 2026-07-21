# ESG Dashboard auto-hibernate hook.
#
# This script is intentionally small and Windows-friendly. The dashboard stores
# the ON/OFF toggle in config/dashboardRuntimeConfig.json. Only call this script
# from trusted operational code after confirming autoHibernateEnabled is true.
#
# Dry-run test:
#   powershell -ExecutionPolicy Bypass -File .\scripts\hibernate.ps1 -DryRun
#
# Actual hibernate command, when approved:
#   shutdown.exe /h /f

param(
  [switch]$DryRun,
  [switch]$ExecuteHibernate,
  [switch]$CapabilityCheck,
  [switch]$Force
)

if ($CapabilityCheck) {
  powercfg /a
  exit $LASTEXITCODE
}

if ($DryRun) {
  Write-Output "DRY RUN: Auto-hibernate hook reached. No OS hibernate command executed."
  exit 0
}

if ($ExecuteHibernate) {
  $args = @("/h")
  if ($Force) { $args += "/f" }
  Write-Output "Executing Windows hibernate now with shutdown.exe."
  & shutdown.exe @args
  if ($LASTEXITCODE -eq 0) {
    exit 0
  }

  Write-Output "shutdown.exe hibernate failed with exit code $LASTEXITCODE. Trying Windows power API fallback."
  Add-Type -Namespace Win32 -Name PowerState -MemberDefinition @"
    [System.Runtime.InteropServices.DllImport("powrprof.dll", SetLastError=true)]
    public static extern bool SetSuspendState(bool hibernate, bool forceCritical, bool disableWakeEvent);
"@
  $ok = [Win32.PowerState]::SetSuspendState($true, [bool]$Force, $false)
  if (-not $ok) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "Windows hibernate fallback failed. LastWin32Error=$errorCode."
  }
  exit 0
}

Write-Output "Auto-hibernate hook reached. Add -ExecuteHibernate to run Windows hibernate."
