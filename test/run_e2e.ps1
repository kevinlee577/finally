# Run the FinAlly E2E suite (PLAN.md §12) on Windows.
# Idempotent: always tears the stack down afterwards, including the tmpfs DB.

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $PSScriptRoot 'docker-compose.test.yml'

Push-Location $repoRoot
try {
    Write-Host 'Starting E2E stack (app + Playwright)...' -ForegroundColor Cyan

    docker compose -f $composeFile up --build `
        --abort-on-container-exit --exit-code-from playwright
    $testExitCode = $LASTEXITCODE

    if ($testExitCode -eq 0) {
        Write-Host 'E2E suite passed.' -ForegroundColor Green
    }
    else {
        Write-Host "E2E suite failed (exit code $testExitCode)." -ForegroundColor Red
        Write-Host "HTML report: $(Join-Path $PSScriptRoot 'playwright-report')"
    }

    exit $testExitCode
}
finally {
    Write-Host 'Tearing down E2E stack...' -ForegroundColor Cyan
    docker compose -f $composeFile down -v --remove-orphans 2>&1 | Out-Null
    Pop-Location
}
