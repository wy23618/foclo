param(
  [switch]$LanDebug
)

$ErrorActionPreference = 'Stop'

$serverRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$projectRoot = (Resolve-Path (Join-Path $serverRoot '..')).Path
$privateRoot = Join-Path $env:LOCALAPPDATA 'YoTick\LocalServer'
$dataDir = Join-Path $privateRoot 'postgres-data'
$secretsPath = Join-Path $privateRoot 'secrets.json'
$pidPath = Join-Path $privateRoot 'api.pid'
$apiLog = Join-Path $privateRoot 'api.log'
$apiErrorLog = Join-Path $privateRoot 'api-error.log'
$pgLog = Join-Path $privateRoot 'postgres.log'
$envPath = Join-Path $serverRoot '.env'
$pgPort = 5433
$apiPort = 3000
$apiEntryPoint = Join-Path $serverRoot 'dist\src\index.js'
$listenHost = '127.0.0.1'
$lanNetwork = $null
if ($LanDebug) {
  $profiles = @(Get-NetConnectionProfile | Where-Object { $_.IPv4Connectivity -eq 'Internet' })
  $lanCandidates = @(
    foreach ($profile in $profiles) {
      Get-NetIPAddress -InterfaceIndex $profile.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.AddressState -eq 'Preferred' -and $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' } |
        ForEach-Object { [pscustomobject]@{ Address = $_.IPAddress; Prefix = $_.PrefixLength; Interface = $profile.InterfaceAlias } }
    }
  )
  if ($lanCandidates.Count -ne 1) {
    throw 'LAN debug needs exactly one active private Wi-Fi address. Connect this computer to the phone hotspot, then retry.'
  }
  $listenHost = $lanCandidates[0].Address
  $lanNetwork = "$($lanCandidates[0].Address)/$($lanCandidates[0].Prefix)"
  $environmentPath = Join-Path $projectRoot 'sync\environment.js'
  $environmentText = [System.IO.File]::ReadAllText($environmentPath, [System.Text.Encoding]::UTF8)
  if ($environmentText -notmatch ('LAN_DEBUG_API_HOST\s*=\s*["'']' + [regex]::Escape($listenHost) + '["'']')) {
    throw "The active Wi-Fi address is $listenHost, but sync/environment.js is configured for a different phone-test address. No server or firewall settings were changed."
  }
}

$pgBinCandidates = @(
  $env:YOTICK_POSTGRES_BIN,
  (Join-Path $env:ProgramFiles 'PostgreSQL\17\bin'),
  'D:\PostgreSQL\17\bin'
 ) | Where-Object { $_ }
$pgBin = $pgBinCandidates | Where-Object { Test-Path (Join-Path $_ 'initdb.exe') } | Select-Object -First 1
if (-not $pgBin) {
  throw 'PostgreSQL 17 command-line tools were not found. Install PostgreSQL 17 or set YOTICK_POSTGRES_BIN to its bin folder.'
}
$initdb = Join-Path $pgBin 'initdb.exe'
$pgCtl = Join-Path $pgBin 'pg_ctl.exe'
$psql = Join-Path $pgBin 'psql.exe'

$ownedApi = $null
if (Test-Path $pidPath) {
  $savedApiPid = 0
  if ([int]::TryParse((Get-Content -LiteralPath $pidPath -Raw), [ref]$savedApiPid)) {
    $candidateApi = Get-CimInstance Win32_Process -Filter "ProcessId=$savedApiPid" -ErrorAction SilentlyContinue
    if ($candidateApi -and $candidateApi.Name -eq 'node.exe' -and $candidateApi.CommandLine -like "*$apiEntryPoint*") {
      $ownedApi = $candidateApi
    }
  }
}
if (-not $ownedApi -and (Get-NetTCPConnection -State Listen -LocalPort $apiPort -ErrorAction SilentlyContinue)) {
  throw "Local API port $apiPort is already used by another process. No existing process was stopped."
}

if ($ownedApi) {
  $configuredHost = (Get-Content -LiteralPath $envPath -ErrorAction SilentlyContinue | Where-Object { $_ -match '^HOST=' } | Select-Object -First 1) -replace '^HOST=', ''
  $configuredLoopback = [string]((Get-Content -LiteralPath $envPath -ErrorAction SilentlyContinue | Where-Object { $_ -match '^LOCAL_DEV_LOOPBACK=' } | Select-Object -First 1) -replace '^LOCAL_DEV_LOOPBACK=', '')
  $desiredLoopback = if ($LanDebug) { 'true' } else { 'false' }
  $hasLoopbackListener = Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort $apiPort -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq $ownedApi.ProcessId }
  if ($configuredHost -ne $listenHost -or $configuredLoopback -ne $desiredLoopback -or ($LanDebug -and -not $hasLoopbackListener)) {
    Stop-Process -Id $ownedApi.ProcessId -Force
    Wait-Process -Id $ownedApi.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    $ownedApi = $null
  }
}

if (-not (Test-Path $dataDir)) {
  $busyPort = Get-NetTCPConnection -State Listen -LocalPort $pgPort -ErrorAction SilentlyContinue
  if ($busyPort) { throw "Local PostgreSQL port $pgPort is already in use. No new database files were created." }
}

New-Item -ItemType Directory -Force -Path $privateRoot | Out-Null

if ((Test-Path $envPath) -and -not (Test-Path $secretsPath)) {
  throw 'server/.env already exists but this local server has no matching private database credentials. Keeping both untouched.'
}

$newCluster = -not (Test-Path (Join-Path $dataDir 'PG_VERSION'))
if ($newCluster -and (Test-Path $dataDir)) {
  throw "The local database folder exists without PG_VERSION; refusing to reuse or remove it: $dataDir"
}

if (-not (Test-Path $secretsPath)) {
  if (-not $newCluster) {
    throw 'The local database already exists but its private credentials are missing. No files were changed.'
  }
  function New-LocalSecret {
    $bytes = [byte[]]::new(32)
    $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($bytes) } finally { $random.Dispose() }
    return [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
  }
  $secrets = [ordered]@{
    adminPassword = New-LocalSecret
    migratorPassword = New-LocalSecret
    appPassword = New-LocalSecret
    tokenPepper = New-LocalSecret
    cursorSecret = New-LocalSecret
  }
  $secrets | ConvertTo-Json | Set-Content -LiteralPath $secretsPath -Encoding utf8
} else {
  $secrets = Get-Content -LiteralPath $secretsPath -Raw | ConvertFrom-Json
}

if ($newCluster) {
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  $passwordFile = Join-Path $privateRoot 'initdb-password.tmp'
  [System.IO.File]::WriteAllText($passwordFile, [string]$secrets.adminPassword, [System.Text.UTF8Encoding]::new($false))
  try {
    & $initdb -D $dataDir -U yotick_admin "--pwfile=$passwordFile" --auth-local=scram-sha-256 --auth-host=scram-sha-256 --encoding=UTF8 --locale=C
    if ($LASTEXITCODE -ne 0) { throw "PostgreSQL initialization failed with exit code $LASTEXITCODE" }
  } finally {
    Remove-Item -LiteralPath $passwordFile -Force -ErrorAction SilentlyContinue
  }
}

$pgStatus = & $pgCtl -D $dataDir status 2>$null
if ($LASTEXITCODE -ne 0) {
  & $pgCtl -D $dataDir -l $pgLog -o "-h 127.0.0.1 -p $pgPort" start
  if ($LASTEXITCODE -ne 0) { throw "The isolated PostgreSQL server did not start. Check $pgLog" }
}

if (-not (Test-Path $envPath)) {
  $env:PGPASSWORD = [string]$secrets.adminPassword
  try {
    $roles = & $psql -h 127.0.0.1 -p $pgPort -U yotick_admin -d postgres -At -c 'SELECT rolname FROM pg_roles WHERE rolname IN (''yotick_migrator'', ''yotick_app'');'
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the isolated local database roles.' }
    if ($roles -contains 'yotick_migrator') {
      $migratorSql = "ALTER ROLE yotick_migrator WITH LOGIN PASSWORD '$($secrets.migratorPassword)' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;"
    } else {
      $migratorSql = "CREATE ROLE yotick_migrator LOGIN PASSWORD '$($secrets.migratorPassword)' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;"
    }
    & $psql -h 127.0.0.1 -p $pgPort -U yotick_admin -d postgres -v ON_ERROR_STOP=1 -c $migratorSql
    if ($LASTEXITCODE -ne 0) { throw 'Local migration database role could not be created.' }

    if ($roles -contains 'yotick_app') {
      $appSql = "ALTER ROLE yotick_app WITH LOGIN PASSWORD '$($secrets.appPassword)' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;"
    } else {
      $appSql = "CREATE ROLE yotick_app LOGIN PASSWORD '$($secrets.appPassword)' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;"
    }
    & $psql -h 127.0.0.1 -p $pgPort -U yotick_admin -d postgres -v ON_ERROR_STOP=1 -c $appSql
    if ($LASTEXITCODE -ne 0) { throw 'Local application database role could not be created.' }

    $databaseExists = & $psql -h 127.0.0.1 -p $pgPort -U yotick_admin -d postgres -At -c "SELECT 1 FROM pg_database WHERE datname='yotick';"
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the isolated local database.' }
    if (-not ($databaseExists -match '1')) {
      & (Join-Path $pgBin 'createdb.exe') -h 127.0.0.1 -p $pgPort -U yotick_admin --owner=yotick_migrator yotick
      if ($LASTEXITCODE -ne 0) { throw 'The isolated local database could not be created.' }
    }

    & $psql -h 127.0.0.1 -p $pgPort -U yotick_admin -d postgres -v ON_ERROR_STOP=1 -c 'GRANT CONNECT ON DATABASE yotick TO yotick_app;'
    if ($LASTEXITCODE -ne 0) { throw 'The application role could not be granted database access.' }
  } finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  }
}

if (-not (Test-Path $envPath)) {
  $projectConfigPath = Join-Path $projectRoot 'project.config.json'
  $wechatAppId = ''
  if (Test-Path $projectConfigPath) {
    $projectConfigText = [System.IO.File]::ReadAllText($projectConfigPath, [System.Text.Encoding]::UTF8)
    $projectConfig = $projectConfigText | ConvertFrom-Json
    $wechatAppId = [string]$projectConfig.appid
  }
  if (-not $wechatAppId -or $wechatAppId -eq 'touristappid') { $wechatAppId = 'local-development' }
  $envLines = @(
    'NODE_ENV=development',
    "HOST=$listenHost",
    "PORT=$apiPort",
    "DATABASE_URL=postgresql://yotick_app:$($secrets.appPassword)@127.0.0.1:$pgPort/yotick",
    "MIGRATION_DATABASE_URL=postgresql://yotick_migrator:$($secrets.migratorPassword)@127.0.0.1:$pgPort/yotick",
    'DATABASE_SSL=false',
    'DATABASE_CA=',
    "WECHAT_APP_ID=$wechatAppId",
    'WECHAT_APP_SECRET=local-development-not-configured',
    "TOKEN_PEPPER=$($secrets.tokenPepper)",
    "CURSOR_SECRET=$($secrets.cursorSecret)",
    'ACCESS_TOKEN_TTL_SECONDS=900',
    'REFRESH_TOKEN_TTL_SECONDS=2592000',
    'REFRESH_GRACE_SECONDS=30',
    'DB_POOL_MAX=5'
  )
  [System.IO.File]::WriteAllLines($envPath, $envLines, [System.Text.UTF8Encoding]::new($false))
}

$envLines = [System.Collections.Generic.List[string]]::new()
$envLines.AddRange([string[]](Get-Content -LiteralPath $envPath -Encoding UTF8))
$hostLineIndex = -1
for ($i = 0; $i -lt $envLines.Count; $i++) { if ($envLines[$i] -match '^HOST=') { $hostLineIndex = $i; break } }
if ($hostLineIndex -ge 0) { $envLines[$hostLineIndex] = "HOST=$listenHost" }
else { $envLines.Insert(0, "HOST=$listenHost") }
[System.IO.File]::WriteAllLines($envPath, $envLines, [System.Text.UTF8Encoding]::new($false))

$desiredLoopback = if ($LanDebug) { 'true' } else { 'false' }
$loopbackLineIndex = -1
for ($i = 0; $i -lt $envLines.Count; $i++) { if ($envLines[$i] -match '^LOCAL_DEV_LOOPBACK=') { $loopbackLineIndex = $i; break } }
if ($loopbackLineIndex -ge 0) { $envLines[$loopbackLineIndex] = "LOCAL_DEV_LOOPBACK=$desiredLoopback" }
else { $envLines.Add("LOCAL_DEV_LOOPBACK=$desiredLoopback") }
[System.IO.File]::WriteAllLines($envPath, $envLines, [System.Text.UTF8Encoding]::new($false))

Push-Location $serverRoot
try {
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw 'Backend build failed.' }
  & node --env-file=.env dist/src/migrate.js
  if ($LASTEXITCODE -ne 0) { throw 'Local PostgreSQL migrations failed.' }
  $env:PGPASSWORD = [string]$secrets.adminPassword
  try {
    & $psql -h 127.0.0.1 -p $pgPort -U yotick_admin -d yotick -v ON_ERROR_STOP=1 -f (Join-Path $serverRoot 'deploy\permissions.sql')
    if ($LASTEXITCODE -ne 0) { throw 'The application database permissions could not be applied.' }
  } finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  }

  try {
    $live = Invoke-RestMethod -Uri "http://${listenHost}:$apiPort/health/live" -TimeoutSec 2
    $ready = Invoke-RestMethod -Uri "http://${listenHost}:$apiPort/health/ready" -TimeoutSec 2
    if ($ownedApi) {
      Write-Output "YoTick local server is already running. Live: $($live.status); database ready: $($ready.status)."
      & (Join-Path $PSScriptRoot 'start-backup.ps1')
      if ($LanDebug) {
        Write-Output "Temporary phone-debug address: http://${listenHost}:$apiPort; intended Wi-Fi network: $lanNetwork."
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = [Security.Principal.WindowsPrincipal]::new($identity)
        if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
          Write-Output 'Windows Firewall was not changed. If the phone cannot connect, Windows may require a one-time private-network permission for node.exe.'
        }
      }
      return
    }
  } catch {
    if ($ownedApi) { throw "The existing YoTick process is unhealthy. Check $apiLog and $apiErrorLog before restarting it." }
  }

  $apiProcess = Start-Process -FilePath 'node' -ArgumentList @('--env-file=.env', "`"$apiEntryPoint`"") -WorkingDirectory $serverRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $apiLog -RedirectStandardError $apiErrorLog
  Set-Content -LiteralPath $pidPath -Value $apiProcess.Id -NoNewline
  $deadline = (Get-Date).AddSeconds(30)
  do {
    Start-Sleep -Milliseconds 500
    try {
      $live = Invoke-RestMethod -Uri "http://${listenHost}:$apiPort/health/live" -TimeoutSec 2
      $ready = Invoke-RestMethod -Uri "http://${listenHost}:$apiPort/health/ready" -TimeoutSec 2
      Write-Output "YoTick local server is ready. API: http://${listenHost}:$apiPort; database: $($ready.status)."
      if ($LanDebug) {
        Write-Output "Temporary phone-debug address: http://${listenHost}:$apiPort; intended Wi-Fi network: $lanNetwork."
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = [Security.Principal.WindowsPrincipal]::new($identity)
        if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
          Write-Output 'Windows Firewall was not changed. If the phone cannot connect, Windows may require a one-time private-network permission for node.exe.'
        }
      }
      Write-Output "Private local files are under $privateRoot."
      & (Join-Path $PSScriptRoot 'start-backup.ps1')
      $configuredSecretLine = Get-Content -LiteralPath $envPath -Encoding UTF8 | Where-Object { $_ -like 'WECHAT_APP_SECRET=*' } | Select-Object -First 1
      if (-not $configuredSecretLine -or $configuredSecretLine -match 'not-configured|replace-me|placeholder') {
        Write-Output 'The WeChat AppSecret still needs configuration before real login testing.'
      } else {
        Write-Output 'The WeChat AppSecret is present. Real login still requires a fresh wx.login code from the mini-program.'
      }
      return
    } catch {
      if ($apiProcess.HasExited) { break }
    }
  } while ((Get-Date) -lt $deadline)

  Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
  throw "The API did not become ready. Check the local log at $apiLog"
} finally {
  Pop-Location
}
