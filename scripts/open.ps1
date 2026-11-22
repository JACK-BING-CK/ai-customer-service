param([ValidateSet("Customer", "Agent", "Debug", "Merchant", "Hub")][string]$View = "Hub")
$ErrorActionPreference = "Stop"
$project = Split-Path -Parent $PSScriptRoot
$portNumber = if ($env:PORT) { [int]$env:PORT } else { 4873 }
$baseUrl = "http://127.0.0.1:$portNumber"
function Test-Ready {
    try {
        $health = Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 2
        return ($health.app -eq 'support-handoff')
    } catch { return $false }
}
if (-not (Test-Ready)) {
    if (-not (Test-Path -LiteralPath (Join-Path $project 'dist/client/index.html'))) {
        Push-Location $project
        try {
            & npm.cmd run build
            if ($LASTEXITCODE -ne 0) { throw 'Build failed. See npm run build.' }
        } finally { Pop-Location }
    }
    $nodeExe = (Get-Command node.exe).Source
    [void](Start-Process -FilePath $nodeExe -ArgumentList 'server/main.ts' -WorkingDirectory $project -WindowStyle Hidden -PassThru)
    $deadline = [DateTime]::UtcNow.AddSeconds(12)
    do {
        Start-Sleep -Milliseconds 200
        $ready = Test-Ready
    } until ($ready -or [DateTime]::UtcNow -gt $deadline)
    if (-not $ready) { throw 'Service did not start. Check data/service.jsonl or run npm start.' }
}
$url = switch ($View) {
    'Hub' { "$baseUrl/hub" }
    'Agent' { "$baseUrl/agent" }
    'Debug' { "$baseUrl/debug" }
    'Merchant' { "$baseUrl/merchant" }
    default { "$baseUrl/" }
}
Start-Process $url
