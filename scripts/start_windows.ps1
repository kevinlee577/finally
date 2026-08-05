<#
.SYNOPSIS
    FinAlly - start the app container (Windows / PowerShell).

.DESCRIPTION
    See planning/PLAN.md section 11. Idempotent: safe to run repeatedly.

.EXAMPLE
    .\scripts\start_windows.ps1
    .\scripts\start_windows.ps1 -Build
    .\scripts\start_windows.ps1 -NoBrowser
#>
[CmdletBinding()]
param(
    [switch]$Build,
    [switch]$NoBrowser,
    [int]$Port = 8000
)

$ErrorActionPreference = 'Stop'

$ImageName     = 'finally'
$ContainerName = 'finally'
$HealthTimeout = 90

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$DbDir    = Join-Path $RepoRoot 'db'
$EnvFile  = Join-Path $RepoRoot '.env'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Error "docker is not installed or not on PATH."
}

docker info *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Error "The Docker daemon is not running. Start Docker Desktop and retry."
}

# Bind-mount target for the SQLite file. Created here so a fresh clone works.
if (-not (Test-Path $DbDir)) { New-Item -ItemType Directory -Path $DbDir | Out-Null }

docker image inspect $ImageName *> $null
$imageExists = ($LASTEXITCODE -eq 0)

if ($Build -or -not $imageExists) {
    Write-Host "==> Building image '$ImageName' (this takes a few minutes the first time)..."
    docker build -t $ImageName $RepoRoot
    if ($LASTEXITCODE -ne 0) { Write-Error "docker build failed." }
} else {
    Write-Host "==> Image '$ImageName' already exists (use -Build to rebuild)."
}

# Idempotency: replace any previous container of this name. The database lives
# in the bind-mounted db\ directory, so nothing is lost by recreating it.
docker container inspect $ContainerName *> $null
if ($LASTEXITCODE -eq 0) {
    Write-Host "==> Removing existing container '$ContainerName'..."
    docker rm -f $ContainerName *> $null
}

# .env is passed at run time and never baked into the image.
$envArgs = @()
if (Test-Path $EnvFile) {
    $envArgs = @('--env-file', $EnvFile)
} else {
    Write-Warning "No .env found at $EnvFile - copy .env.example to .env and add your OPENROUTER_API_KEY."
    Write-Warning "The app will still start, but AI chat will be disabled."
}

Write-Host "==> Starting container '$ContainerName' on port $Port..."
docker run -d --name $ContainerName -p "${Port}:8000" -v "${DbDir}:/app/db" @envArgs $ImageName *> $null
if ($LASTEXITCODE -ne 0) { Write-Error "docker run failed." }

$url = "http://localhost:$Port"

Write-Host "==> Waiting for the app to become healthy..."
$healthy = $false
for ($i = 0; $i -lt $HealthTimeout; $i++) {
    try {
        Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 2 -ErrorAction Stop | Out-Null
        $healthy = $true
        break
    } catch {
        # Surface a crash immediately instead of waiting out the full timeout.
        $running = (docker inspect -f '{{.State.Running}}' $ContainerName 2>$null)
        if ($running -ne 'true') {
            Write-Host "ERROR: the container exited during startup. Recent logs:" -ForegroundColor Red
            docker logs --tail 50 $ContainerName
            Write-Error "Container failed to start."
        }
        Start-Sleep -Seconds 1
    }
}

if (-not $healthy) {
    Write-Host "ERROR: /api/health did not respond within ${HealthTimeout}s. Recent logs:" -ForegroundColor Red
    docker logs --tail 50 $ContainerName
    Write-Error "Startup health check timed out."
}

Write-Host ""
Write-Host "  FinAlly is running:  $url"
Write-Host "  Logs:                docker logs -f $ContainerName"
Write-Host "  Stop:                .\scripts\stop_windows.ps1"
Write-Host ""

if (-not $NoBrowser) {
    Start-Process $url | Out-Null
}

# Explicit success. The health-poll loop's last native call is a `docker inspect`
# probe whose $LASTEXITCODE would otherwise become this script's exit code, so a
# fully successful start could still report failure to a caller.
exit 0
