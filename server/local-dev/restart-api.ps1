param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'

# Restart only this project's API. Leave PostgreSQL and the backup daemon running.
$serverRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$entryPath = Join-Path $serverRoot 'dist\src\index.js'
$privateRoot = Join-Path $env:LOCALAPPDATA 'YoTick\LocalServer'
$apiPidFile = Join-Path $privateRoot 'api.pid'

if (!(Test-Path -LiteralPath $entryPath)) { throw 'Build the backend first with npm run build.' }
if (!(Test-Path -LiteralPath (Join-Path $serverRoot '.env'))) { throw 'The local server configuration is missing. Use start.ps1.' }
function Test-OwnedApi($processInfo) {
  return $processInfo -and $processInfo.Name -eq 'node.exe' -and $processInfo.CommandLine -like "*$entryPath*"
}
$owner = $null
$apiOwnerId = 0
if (Test-Path -LiteralPath $apiPidFile) {
  $savedId = 0
  if ([int]::TryParse((Get-Content -LiteralPath $apiPidFile -Raw).Trim(), [ref]$savedId)) {
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId=$savedId" -ErrorAction SilentlyContinue
    if (Test-OwnedApi $candidate) { $owner = $candidate; $apiOwnerId = $savedId }
  }
}
if (!$owner) {
  # A missing/stale PID file must not prevent recognizing the actual owned API.
  $listeners = @(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)
  $found = @()
  foreach ($listenerId in @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)) {
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId=$listenerId" -ErrorAction SilentlyContinue
    if (!(Test-OwnedApi $candidate)) { throw 'Port 3000 belongs to another program. No process was stopped.' }
    $found += $candidate
  }
  if ($found.Count -ne 1) { throw 'No unique running YoTick API was found. No process was stopped. Use start.ps1.' }
  $owner = $found[0]
  $apiOwnerId = [int]$owner.ProcessId
}
if ($CheckOnly) {
  Write-Output "Verified the running YoTick API (process $apiOwnerId). No changes made."
  return
}

# Recheck ownership immediately before stopping to avoid a reused process ID.
if (!(Test-OwnedApi (Get-CimInstance Win32_Process -Filter "ProcessId=$apiOwnerId"))) {
  throw 'The API process changed during inspection. No process was stopped.'
}
Stop-Process -Id $apiOwnerId
Wait-Process -Id $apiOwnerId -Timeout 5 -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $privateRoot -Force | Out-Null
$newApi = Start-Process -FilePath 'node' -ArgumentList @('--env-file=.env', ('"' + $entryPath + '"')) `
  -WorkingDirectory $serverRoot -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput (Join-Path $privateRoot 'api.log') `
  -RedirectStandardError (Join-Path $privateRoot 'api-error.log')
Set-Content -LiteralPath $apiPidFile -Value $newApi.Id -NoNewline

for ($attempt = 0; $attempt -lt 20; $attempt++) {
  if ($newApi.HasExited) { throw 'The API exited. Check the private api-error.log.' }
  try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/health/ready' -TimeoutSec 1
    if ($health.status -eq 'ready' -or $health.status -eq 'ok') {
      Write-Output 'YoTick API restarted. Database ready. Your records were kept.'
      return
    }
  } catch {}
  Start-Sleep -Milliseconds 400
}
throw 'The restarted API did not pass its readiness check. Check the private API logs.'
