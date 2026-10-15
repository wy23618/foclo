$ErrorActionPreference = 'Stop'

$serverRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$privateRoot = Join-Path $env:LOCALAPPDATA 'YoTick\LocalServer'
$dataDir = Join-Path $privateRoot 'postgres-data'
$pidPath = Join-Path $privateRoot 'api.pid'
$backupPidPath = Join-Path $privateRoot 'backup-daemon.pid'
if (Test-Path -LiteralPath $backupPidPath) {
  $backupProcessId = [int](Get-Content -LiteralPath $backupPidPath)
  $backupInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$backupProcessId" -ErrorAction SilentlyContinue
  $backupEntry = Join-Path $PSScriptRoot 'backup-daemon.mjs'
  if ($backupInfo -and $backupInfo.Name -eq 'node.exe' -and $backupInfo.CommandLine -like "*$backupEntry*") { Stop-Process -Id $backupProcessId }
  Remove-Item -LiteralPath $backupPidPath
}
$pgBinCandidates = @(
  $env:YOTICK_POSTGRES_BIN,
  (Join-Path $env:ProgramFiles 'PostgreSQL\17\bin'),
  'D:\PostgreSQL\17\bin'
 ) | Where-Object { $_ }
$pgBin = $pgBinCandidates | Where-Object { Test-Path (Join-Path $_ 'pg_ctl.exe') } | Select-Object -First 1

if (Test-Path $pidPath) {
  $apiProcessId = [int](Get-Content -LiteralPath $pidPath -Raw)
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$apiProcessId" -ErrorAction SilentlyContinue
  $expectedEntryPoint = Join-Path $serverRoot 'dist\src\index.js'
  if ($processInfo -and $processInfo.Name -eq 'node.exe' -and $processInfo.CommandLine -like "*$expectedEntryPoint*") {
    Stop-Process -Id $apiProcessId
  }
  Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
}

if ($pgBin -and (Test-Path (Join-Path $dataDir 'PG_VERSION'))) {
  & (Join-Path $pgBin 'pg_ctl.exe') -D $dataDir -m fast stop
  if ($LASTEXITCODE -ne 0) { throw 'The isolated YoTick PostgreSQL instance did not stop cleanly.' }
}

Write-Output 'YoTick local API and its isolated PostgreSQL instance are stopped. Database files were kept.'
