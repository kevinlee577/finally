<#
.SYNOPSIS
    FinAlly - stop and remove the app container (Windows / PowerShell).

.DESCRIPTION
    See planning/PLAN.md section 11. Idempotent: safe to run when nothing is
    running. The SQLite database lives in the bind-mounted db\ directory on the
    host and is NOT touched by this script - your portfolio survives a
    stop/start cycle.

.EXAMPLE
    .\scripts\stop_windows.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$ContainerName = 'finally'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Error "docker is not installed or not on PATH."
}

docker info *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Docker daemon is not running - nothing to stop."
    exit 0
}

docker container inspect $ContainerName *> $null
if ($LASTEXITCODE -eq 0) {
    Write-Host "==> Stopping and removing container '$ContainerName'..."
    docker rm -f $ContainerName *> $null
    Write-Host "Stopped. Database preserved in .\db (delete db\finally.db to reset)."
} else {
    Write-Host "Container '$ContainerName' is not present - nothing to stop."
}

# Explicit success. Without this the script inherits $LASTEXITCODE from the
# `docker container inspect` probe above, which is 1 on the "nothing to stop"
# path — so an idempotent no-op run would report failure to a CI job or any
# caller that checks the exit code.
exit 0
