param(
  [ValidateSet("app", "database")]
  [string]$Target,

  [ValidateSet("status", "start", "stop", "restart")]
  [string]$Action,

  [string]$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [int]$Port = 3000
)

$ErrorActionPreference = "Stop"

function Get-EnvValue {
  param(
    [string]$Name,
    [string]$Fallback = ""
  )

  $envValue = [Environment]::GetEnvironmentVariable($Name)
  if (-not [string]::IsNullOrWhiteSpace($envValue)) { return $envValue }

  $envPath = Join-Path $ProjectDir "databaseinfo.env"
  if (Test-Path $envPath) {
    $line = Get-Content $envPath | Where-Object { $_ -match "^\s*$Name\s*=" } | Select-Object -First 1
    if ($line) {
      $value = ($line -split "=", 2)[1].Trim()
      return $value.Trim("'").Trim('"')
    }
  }

  return $Fallback
}

function Get-AppListener {
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Get-DatabaseStatus {
  $mysqladmin = "C:\xampp\mysql\bin\mysqladmin.exe"
  if (Test-Path $mysqladmin) {
    $dbHost = Get-EnvValue -Name "DB_HOST" -Fallback "localhost"
    $dbUser = Get-EnvValue -Name "DB_USER" -Fallback "ESGAdmin"
    $dbPassword = Get-EnvValue -Name "DB_PASSWORD" -Fallback "12345678"
    & $mysqladmin -h $dbHost -u $dbUser "-p$dbPassword" ping 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
  }
  return [bool](Get-Process mysqld -ErrorAction SilentlyContinue)
}

function Start-App {
  if (Get-AppListener) { return "Application already running on port $Port." }
  Start-Process -FilePath "cmd.exe" -ArgumentList '/c "npm.cmd run devStart"' -WorkingDirectory $ProjectDir -WindowStyle Hidden | Out-Null
  Start-Sleep -Seconds 3
  if (Get-AppListener) { return "Application started on port $Port." }
  return "Application start was requested, but port $Port is not listening yet."
}

function Stop-App {
  $listener = Get-AppListener
  if (-not $listener) { return "Application is not listening on port $Port." }
  Stop-Process -Id $listener.OwningProcess -Force
  Start-Sleep -Seconds 2
  return "Application stop requested for process $($listener.OwningProcess)."
}

function Start-Database {
  if (Get-DatabaseStatus) { return "Database is already running." }
  $script = "C:\xampp\mysql_start.bat"
  if (-not (Test-Path $script)) { throw "Cannot find $script." }
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$script`"" -WindowStyle Hidden | Out-Null
  Start-Sleep -Seconds 4
  if (Get-DatabaseStatus) { return "Database started." }
  return "Database start was requested, but MySQL did not respond yet."
}

function Stop-Database {
  $script = "C:\xampp\mysql_stop.bat"
  if (Test-Path $script) {
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$script`"" -WindowStyle Hidden -Wait | Out-Null
    return "Database stop requested through XAMPP."
  }
  $process = Get-Process mysqld -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $process) { return "Database is not running." }
  Stop-Process -Id $process.Id -Force
  return "Database process stop requested."
}

if ($Target -eq "app") {
  if ($Action -eq "status") {
    $listener = Get-AppListener
    if ($listener) { "Application is running on port $Port. PID: $($listener.OwningProcess)." } else { "Application is not listening on port $Port." }
  } elseif ($Action -eq "start") {
    Start-App
  } elseif ($Action -eq "stop") {
    Stop-App
  } elseif ($Action -eq "restart") {
    Stop-App | Out-Null
    Start-App
  }
} elseif ($Target -eq "database") {
  if ($Action -eq "status") {
    if (Get-DatabaseStatus) { "Database is running." } else { "Database is not responding." }
  } elseif ($Action -eq "start") {
    Start-Database
  } elseif ($Action -eq "stop") {
    Stop-Database
  } elseif ($Action -eq "restart") {
    Stop-Database | Out-Null
    Start-Sleep -Seconds 2
    Start-Database
  }
}
