# No server, credential store, or external API is contacted. The target guard
# uses Node core only. pnpm is replaced so the tested script cannot open a DB.
$ErrorActionPreference = 'Stop'
node --test "$PSScriptRoot/staging-target-check.test.mjs"
if ($LASTEXITCODE -ne 0) { throw 'Maintenance target unit tests failed.' }
$stateVariable = Get-Variable -Name IspPreflightTestState -Scope Global -ErrorAction SilentlyContinue
$previousState = if ($stateVariable) { $stateVariable.Value } else { $null }
$global:IspPreflightTestState = @{ ExitCode = 0; Captured = @(); Calls = 0 }
function Read-Host {
    param([string]$Prompt, [switch]$AsSecureString)
    if (-not $AsSecureString) { throw 'The maintenance connection must use a hidden prompt.' }
    return (ConvertTo-SecureString 'postgresql://owner:test@localhost/test' -AsPlainText -Force)
}
function pnpm {
    $global:IspPreflightTestState.Captured = @($args)
    $global:IspPreflightTestState.Calls += 1
    Set-Variable -Name LASTEXITCODE -Value $global:IspPreflightTestState.ExitCode -Scope 1
    if ($env:ISP_ENV -ne 'staging' -or $env:DATABASE_MIGRATE_URL -ne 'postgresql://owner:test@localhost/test') {
        throw 'Preflight did not scope the maintenance environment correctly.'
    }
}
$oldUrl = $env:DATABASE_MIGRATE_URL
$oldEnvironment = $env:ISP_ENV
try {
    $env:DATABASE_MIGRATE_URL = 'original-value'
    $env:ISP_ENV = 'original-environment'
    & "$PSScriptRoot/staging-repair-preflight.ps1"
    if (($global:IspPreflightTestState.Captured -join ' ') -ne 'db:migrate -- --plan --detect-baseline') {
        throw 'Preflight must only execute read-only baseline detection.'
    }
    if ($env:DATABASE_MIGRATE_URL -ne 'original-value' -or $env:ISP_ENV -ne 'original-environment') {
        throw 'Preflight failed to restore the local environment.'
    }
    & "$PSScriptRoot/staging-repair-preflight.ps1" -IncludeNeonSample
    if (($global:IspPreflightTestState.Captured -join ' ') -ne 'db:migrate -- --plan --detect-baseline --include-neon-sample') {
        throw 'The explicit sample profile must preserve both read-only plan arguments.'
    }
    if ($env:DATABASE_MIGRATE_URL -ne 'original-value' -or $env:ISP_ENV -ne 'original-environment') {
        throw 'Profile preflight failed to restore the local environment.'
    }
    $global:IspPreflightTestState.ExitCode = 23
    $failedSafely = $false
    try { & "$PSScriptRoot/staging-repair-preflight.ps1" -IncludeNeonSample } catch {
        $failedSafely = $_.Exception.Message -like 'Preflight did not pass.*'
    }
    if (-not $failedSafely -or $global:IspPreflightTestState.Calls -ne 3) {
        throw 'Preflight must surface the failed migration plan, not an unrelated test error.'
    }
    if ($env:DATABASE_MIGRATE_URL -ne 'original-value' -or $env:ISP_ENV -ne 'original-environment') {
        throw 'Failed preflight failed to restore the local environment.'
    }

    # The real Node guard sees only a local fixture URL and never connects.
    $global:IspPreflightTestState.ExitCode = 0
    & "$PSScriptRoot/staging-repair-preflight.ps1" -IncludeNeonSample -ExpectedTarget 'bb970ad3f47bccf7'
    if ($global:IspPreflightTestState.Calls -ne 4 -or ($global:IspPreflightTestState.Captured -join ' ') -ne 'db:migrate -- --plan --detect-baseline --include-neon-sample') {
        throw 'Matching target must continue with the unchanged read-only migration command.'
    }
    if ($env:DATABASE_MIGRATE_URL -ne 'original-value' -or $env:ISP_ENV -ne 'original-environment') {
        throw 'Matching-target preflight failed to restore the local environment.'
    }
    $mismatchRefused = $false
    try { & "$PSScriptRoot/staging-repair-preflight.ps1" -IncludeNeonSample -ExpectedTarget '0000000000000000' } catch {
        $mismatchRefused = $_.Exception.Message -like 'Target verification did not pass.*'
    }
    if (-not $mismatchRefused -or $global:IspPreflightTestState.Calls -ne 4) {
        throw 'A target mismatch must stop before pnpm or any database inspection.'
    }
    if ($env:DATABASE_MIGRATE_URL -ne 'original-value' -or $env:ISP_ENV -ne 'original-environment') {
        throw 'Mismatched-target preflight failed to restore the local environment.'
    }
    Write-Host 'PowerShell preflight safety: PASS (target match/refusal, read-only arguments, sample profile, hidden prompt, environment restoration).'
} finally {
    $env:DATABASE_MIGRATE_URL = $oldUrl
    $env:ISP_ENV = $oldEnvironment
    if ($stateVariable) {
        $global:IspPreflightTestState = $previousState
    } else {
        Remove-Variable -Name IspPreflightTestState -Scope Global -ErrorAction SilentlyContinue
    }
}
# Reached only after every assertion passed. The intentional negative guard
# probe leaves LASTEXITCODE=1; report the suite result, not that child result.
exit 0
