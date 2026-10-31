param(
    [ValidateSet('mock', 'live')][string]$Mode = 'mock',
    [switch]$Install
)
$ErrorActionPreference = 'Stop'
$repoRoot = $PSScriptRoot
$runtimePath = Join-Path $repoRoot '.runtime'
New-Item -ItemType Directory -Force -Path $runtimePath | Out-Null
$bunCommand = (Get-Command bun -ErrorAction Stop).Source
if ($Install) {
    foreach ($moduleName in @('glue', 'web')) {
        Push-Location (Join-Path $repoRoot $moduleName)
        try { & $bunCommand install; if ($LASTEXITCODE -ne 0) { throw "Install failed: $moduleName" } }
        finally { Pop-Location }
    }
}
if ($Mode -eq 'live' -and -not $env:ACTOR_API_URL) {
    throw 'Live mode needs ACTOR_API_URL. Configure integration settings from glue/HANDOFF.md first.'
}
$env:GLUE_MODE = $Mode
$services = @(
    @{ Name = 'glue'; Port = 7200; Arguments = @('run', 'server.ts') },
    @{ Name = 'web'; Port = 3000; Arguments = @('run', 'dev') }
)
foreach ($service in $services) {
    $listener = Get-NetTCPConnection -LocalPort $service.Port -State Listen -ErrorAction SilentlyContinue
    if ($listener) {
        Write-Host "$($service.Name): port $($service.Port) is already occupied; existing process left running."
        continue
    }
    $process = Start-Process -FilePath $bunCommand -ArgumentList $service.Arguments -WorkingDirectory (Join-Path $repoRoot $service.Name) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimePath "$($service.Name).out.log") -RedirectStandardError (Join-Path $runtimePath "$($service.Name).err.log")
    Write-Host "$($service.Name): launched process $($process.Id). Logs in .runtime/."
}
Write-Host 'Dashboard: http://127.0.0.1:3000'
Write-Host 'API health: http://127.0.0.1:7200/health (verify reported mode)'
Write-Host 'Mock checks: bun run glue/e2e.ts --mock-journey'
