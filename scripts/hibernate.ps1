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
#   shutdown.exe /h
#
# Keep the command commented until the team is ready to allow OS-level power
# actions on the kiosk machine. This avoids accidental hibernation during
# development or demos.

param(
  [switch]$DryRun
)

if ($DryRun) {
  Write-Output "DRY RUN: Auto-hibernate hook reached. No OS hibernate command executed."
  exit 0
}

Write-Output "Auto-hibernate hook reached. Real hibernate remains disabled until approved."
# shutdown.exe /h
