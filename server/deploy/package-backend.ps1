param([string]$OutputPath)
$ErrorActionPreference = 'Stop'
$serverRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $OutputPath) {
  $OutputPath = Join-Path $serverRoot ('delivery\YoTick-backend-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip')
}
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
if (Test-Path -LiteralPath $OutputPath) { throw 'Output already exists; choose a new filename.' }
$stageRoot = Join-Path $env:TEMP ('YoTick-bundle-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stageRoot | Out-Null
# Explicit allowlist: credentials, live data, tests and dependencies never copied.
foreach ($name in @('package.json','package-lock.json','.env.example','.dockerignore','Dockerfile','tsconfig.json','src','migrations','deploy')) {
  $source = Join-Path $serverRoot $name
  if (-not (Test-Path -LiteralPath $source)) { throw "Required delivery item missing: $name" }
  Copy-Item -LiteralPath $source -Destination (Join-Path $stageRoot $name) -Recurse
}
New-Item -ItemType Directory -Path (Join-Path $stageRoot 'dist') | Out-Null
# Keep deployment self-checks; exclude the backup unit-test file.
Remove-Item -LiteralPath (Join-Path $stageRoot 'deploy\linux\backup\backup-crypto.test.mjs') -ErrorAction SilentlyContinue
Copy-Item -LiteralPath (Join-Path $serverRoot 'dist\src') -Destination (Join-Path $stageRoot 'dist\src') -Recurse
$docsRoot = Join-Path $serverRoot '..\docs'
New-Item -ItemType Directory -Path (Join-Path $stageRoot 'docs') | Out-Null
# Keep repository handoff indexes outside the deployable bundle: their package
# paths and hashes describe the current workspace artifact, not this snapshot.
foreach ($name in @('deployment.md','backup-recovery.md','database-design.md','api.openapi.yaml','api-examples.md','future-app-integration.md','ecs-deployment.md','deletion-ledger.md')) {
  Copy-Item -LiteralPath (Join-Path $docsRoot $name) -Destination (Join-Path (Join-Path $stageRoot 'docs') $name)
}
@'
# YoTick backend delivery

Requires Node.js 24 and a separately configured PostgreSQL database.
Run npm ci --omit=dev to install locked runtime dependencies.
Use the included dist files for npm start and npm run migrate.
Migrations and permissions must run only against an approved target database.
Configure secrets through protected environment variables; no credentials or
database contents are included. Read docs/deployment.md and backup-recovery.md.
The included Dockerfile uses src for its build stage. Container build and
production HTTPS validation remain separate target-environment checks.
'@ | Set-Content -LiteralPath (Join-Path $stageRoot 'README.md') -Encoding utf8
$manifest = Get-ChildItem -LiteralPath $stageRoot -File -Recurse | ForEach-Object {
  [PSCustomObject]@{
    path = $_.FullName.Substring($stageRoot.Length + 1).Replace('\','/')
    bytes = $_.Length
    sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}
$manifest | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $stageRoot 'manifest.json') -Encoding utf8
New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($OutputPath)) | Out-Null
# Store portable POSIX entry names, including dotfiles, on Windows as well.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipArchive = [IO.Compression.ZipFile]::Open($OutputPath, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($bundleFile in (Get-ChildItem -LiteralPath $stageRoot -File -Recurse -Force)) {
    $entryPath = $bundleFile.FullName.Substring($stageRoot.Length + 1).Replace('\','/')
    $zipEntry = $zipArchive.CreateEntry($entryPath, [IO.Compression.CompressionLevel]::Optimal)
    $inputStream = [IO.File]::OpenRead($bundleFile.FullName)
    $outputStream = $zipEntry.Open()
    try { $inputStream.CopyTo($outputStream) }
    finally { $outputStream.Dispose(); $inputStream.Dispose() }
  }
}
finally { $zipArchive.Dispose() }
$archiveHash = (Get-FileHash -LiteralPath $OutputPath).Hash.ToLowerInvariant()
$archiveHash | Set-Content -LiteralPath ($OutputPath + '.sha256') -Encoding ascii
Write-Output ([PSCustomObject]@{ archive=$OutputPath; staging=$stageRoot; files=$manifest.Count; sha256=$archiveHash } | ConvertTo-Json)
