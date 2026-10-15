$ErrorActionPreference = 'Stop'
$serverRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$privateRoot = Join-Path $env:LOCALAPPDATA 'YoTick\LocalServer'
$pidFile = Join-Path $privateRoot 'backup-daemon.pid'
$entry = Join-Path $PSScriptRoot 'backup-daemon.mjs'
if (Test-Path -LiteralPath $pidFile) {
  $backupProcessId = [int](Get-Content -LiteralPath $pidFile)
  $info = Get-CimInstance Win32_Process -Filter "ProcessId=$backupProcessId" -ErrorAction SilentlyContinue
  if ($info -and $info.Name -eq 'node.exe' -and $info.CommandLine -like "*$entry*") { return }
}
$node = (Get-Command node.exe).Source
$arguments = '--env-file=.env ' + [char]34 + $entry + [char]34
$child = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $serverRoot -WindowStyle Hidden -PassThru
$child.Id | Set-Content -LiteralPath $pidFile -Encoding ascii
