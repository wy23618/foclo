$ErrorActionPreference = 'Stop'
$privateRoot = Join-Path $env:LOCALAPPDATA 'YoTick\LocalServer'
$keyPath = Join-Path $privateRoot 'backup-key.dpapi'
if (-not (Test-Path -LiteralPath $privateRoot)) { throw 'Start the local server first.' }
if (-not (Test-Path -LiteralPath $keyPath)) {
  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $value = [Convert]::ToBase64String($bytes)
  $protected = ConvertFrom-SecureString (ConvertTo-SecureString $value -AsPlainText -Force)
  # CreateNew prevents concurrent processes from replacing the chosen key.
  try {
    $stream = [IO.File]::Open($keyPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
    try {
      $payload = [Text.Encoding]::UTF8.GetBytes($protected)
      $stream.Write($payload, 0, $payload.Length)
    } finally { $stream.Dispose() }
  } catch [IO.IOException] {
    if (-not (Test-Path -LiteralPath $keyPath)) { throw }
  }
  [Array]::Clear($bytes, 0, $bytes.Length)
}
$secret = ConvertTo-SecureString (Get-Content -LiteralPath $keyPath -Raw)
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try {
  # Called only by backup-crypto.mjs; its caller captures this private pipe.
  Write-Output ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer))
} finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
