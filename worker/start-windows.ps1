$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Here

function Find-Python {
    $candidates = @(
        @{ Cmd = 'py'; Args = @('-3.11') },
        @{ Cmd = 'py'; Args = @('-3') },
        @{ Cmd = 'python'; Args = @() }
    )
    foreach ($candidate in $candidates) {
        try {
            & $candidate.Cmd @($candidate.Args) --version *> $null
            if ($LASTEXITCODE -eq 0) { return $candidate }
        } catch {}
    }
    throw 'Python 3.11+ was not found. Install Python from python.org, then run this file again.'
}

$Python = Find-Python
$Venv = Join-Path $Here '.venv'
$VenvPython = Join-Path $Venv 'Scripts\python.exe'
$VenvUvicorn = Join-Path $Venv 'Scripts\uvicorn.exe'

if (-not (Test-Path $VenvPython)) {
    Write-Host 'Creating TTT Python environment...'
    & $Python.Cmd @($Python.Args) -m venv $Venv
}

Write-Host 'Installing/updating TTT worker packages...'
& $VenvPython -m pip install --upgrade pip
& $VenvPython -m pip install -r (Join-Path $Here 'requirements.txt')

Write-Host 'Installing Playwright Chromium...'
& $VenvPython -m playwright install chromium

$WorkerLog = Join-Path $Here 'worker.log'
$WorkerErr = Join-Path $Here 'worker-error.log'
Remove-Item $WorkerLog,$WorkerErr -ErrorAction SilentlyContinue

Write-Host 'Starting TTT TikTok Worker on port 8080...'
$Worker = Start-Process -FilePath $VenvUvicorn -ArgumentList @('main:app','--host','127.0.0.1','--port','8080') -WorkingDirectory $Here -RedirectStandardOutput $WorkerLog -RedirectStandardError $WorkerErr -PassThru

$Ready = $false
for ($i=0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/health' -TimeoutSec 2
        if ($health.ok) { $Ready = $true; break }
    } catch {}
    if ($Worker.HasExited) { break }
}

if (-not $Ready) {
    Write-Host 'Worker did not start. Last error:' -ForegroundColor Red
    if (Test-Path $WorkerErr) { Get-Content $WorkerErr -Tail 30 }
    throw 'TTT worker startup failed.'
}

$Cloudflared = Join-Path $Here 'cloudflared.exe'
if (-not (Test-Path $Cloudflared)) {
    Write-Host 'Downloading Cloudflare Tunnel...'
    Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $Cloudflared
}

$TunnelLog = Join-Path $Here 'tunnel.log'
$TunnelErr = Join-Path $Here 'tunnel-error.log'
Remove-Item $TunnelLog,$TunnelErr -ErrorAction SilentlyContinue

Write-Host 'Opening a free public tunnel...'
$Tunnel = Start-Process -FilePath $Cloudflared -ArgumentList @('tunnel','--url','http://127.0.0.1:8080','--no-autoupdate') -WorkingDirectory $Here -RedirectStandardOutput $TunnelLog -RedirectStandardError $TunnelErr -PassThru

$PublicUrl = $null
for ($i=0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 1
    $all = ''
    if (Test-Path $TunnelLog) { $all += (Get-Content $TunnelLog -Raw -ErrorAction SilentlyContinue) }
    if (Test-Path $TunnelErr) { $all += "`n" + (Get-Content $TunnelErr -Raw -ErrorAction SilentlyContinue) }
    $m = [regex]::Match($all, 'https://[a-z0-9-]+\.trycloudflare\.com')
    if ($m.Success) { $PublicUrl = $m.Value; break }
    if ($Tunnel.HasExited) { break }
}

if (-not $PublicUrl) {
    Write-Host 'Tunnel did not start. Last output:' -ForegroundColor Red
    if (Test-Path $TunnelErr) { Get-Content $TunnelErr -Tail 40 }
    Stop-Process -Id $Worker.Id -Force -ErrorAction SilentlyContinue
    throw 'Cloudflare tunnel startup failed.'
}

Set-Content -Path (Join-Path $Here 'worker-url.txt') -Value $PublicUrl
Write-Host ''
Write-Host '==============================================' -ForegroundColor Cyan
Write-Host 'TTT WORKER IS RUNNING' -ForegroundColor Green
Write-Host $PublicUrl -ForegroundColor Yellow
Write-Host '==============================================' -ForegroundColor Cyan
Write-Host ''
Write-Host 'Keep this window open while you use TTT.'
Write-Host 'The public URL is also saved in worker-url.txt.'
Write-Host 'Press Ctrl+C to stop the tunnel and worker.'

try {
    Wait-Process -Id $Tunnel.Id
} finally {
    Stop-Process -Id $Tunnel.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $Worker.Id -Force -ErrorAction SilentlyContinue
}
