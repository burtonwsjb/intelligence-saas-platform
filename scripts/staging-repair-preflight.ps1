# Read-only inspection. Does not change credentials, grants, ownership, or schema.
# Run from the repository root after checking out the reviewed repair revision.
param(
    [switch]$IncludeNeonSample,
    [ValidatePattern('^[a-f0-9]{16}$')][string]$ExpectedTarget
)
$ErrorActionPreference = 'Stop'
# Handle native exit codes explicitly in this script scope (PowerShell 7).
$PSNativeCommandUseErrorActionPreference = $false
if (-not (Test-Path 'packages/db/src/migrate.ts')) {
    throw 'Run this script from the intelligence-saas-platform repository root.'
}
$previousUrl = $env:DATABASE_MIGRATE_URL
$previousEnvironment = $env:ISP_ENV
$secureUrl = $null
try {
    $secureUrl = Read-Host 'Paste the EXISTING staging schema-owner connection URL (hidden)' -AsSecureString
    $env:DATABASE_MIGRATE_URL = [System.Net.NetworkCredential]::new('', $secureUrl).Password
    $env:ISP_ENV = 'staging'
    if ($ExpectedTarget) {
        # Local hashing only. The URL stays in this process environment, never
        # command-line arguments or stdout. A mismatch stops BEFORE pnpm/SQL.
        node "$PSScriptRoot/staging-target-check.mjs" '--expected-target' $ExpectedTarget
        if ($LASTEXITCODE -ne 0) {
            throw 'Target verification did not pass. No database was contacted. Do not run migrations or change runtime credentials.'
        }
    }
    if ($IncludeNeonSample) {
        pnpm 'db:migrate' '--' '--plan' '--detect-baseline' '--include-neon-sample'
    } else {
        pnpm 'db:migrate' '--' '--plan' '--detect-baseline'
    }
    if ($LASTEXITCODE -ne 0) {
        throw 'Preflight did not pass. No migrations were applied. Do not change privileges or force a baseline.'
    }
    Write-Host 'Read-only preflight finished. No schema or migration-history writes were made.'
} finally {
    $env:DATABASE_MIGRATE_URL = $previousUrl
    $env:ISP_ENV = $previousEnvironment
    if ($secureUrl) { $secureUrl.Dispose() }
}
