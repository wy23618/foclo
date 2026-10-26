param(
  [ValidateSet('health', 'ecs', 'cloudflare', 'logs')]
  [string]$Target = 'health',
  [string]$Command
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent

switch ($Target) {
  'health' {
    foreach ($endpoint in @('https://api.foclo.hellovian.com/health/live', 'https://api.foclo.hellovian.com/health/ready')) {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $endpoint -TimeoutSec 20
      [pscustomobject]@{ Endpoint = $endpoint; Status = $response.StatusCode; Body = $response.Content }
    }
  }
  'ecs' {
    # Uses the existing per-user SSH key and verified known_hosts file.
    # Historical API remains stopped; never start it as part of connection setup.
    if ($Command) { & ssh -o BatchMode=yes -o ConnectTimeout=15 my-server $Command }
    else { & ssh -o BatchMode=yes -o ConnectTimeout=15 my-server }
    if ($LASTEXITCODE -ne 0) { throw "SSH exited with code $LASTEXITCODE" }
  }
  'cloudflare' {
    Push-Location (Join-Path $projectRoot 'server')
    try {
      & node node_modules/wrangler/bin/wrangler.js deployments list
      if ($LASTEXITCODE -ne 0) { throw "Wrangler exited with code $LASTEXITCODE" }
    } finally { Pop-Location }
  }
  'logs' {
    Push-Location (Join-Path $projectRoot 'server')
    try {
      & node node_modules/wrangler/bin/wrangler.js tail --format pretty
      if ($LASTEXITCODE -ne 0) { throw "Wrangler exited with code $LASTEXITCODE" }
    } finally { Pop-Location }
  }
}
