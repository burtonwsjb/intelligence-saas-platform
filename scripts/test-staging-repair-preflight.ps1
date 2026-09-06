# Exercise the actual operator script with an in-memory credential and a fake
# pnpm command. No server, credential store, or external API is contacted.
$ErrorActionPreference = 'Stop'
$stateVariable = Get-Variable -Name IspPreflightTestState -Scope Global -ErrorAction SilentlyContinue
$previousState = if ($stateVariable) { $stateVariable.Value } else { $null }
$global:IspPreflightTestState = @{ ExitCode = 0; Captured = @(); Calls = 0 }
function Read-Host {
    param([string]$Prompt, [switch]$AsSecureString)
    if (-not $AsSecureString) { throw 'The maintenance connection must use a hidden prompt.' }
    return (ConvertTo-SecureString 'postgresql://owner:test@localhost/test' -AsPlainText -Force)
}
function pnpm {
    # A function invoked by another script has a different script scope. Keep
    # this mock's state explicit and emulate the native exit code in its caller.
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
    Write-Host 'PowerShell preflight safety: PASS (read-only arguments, explicit sample profile, hidden prompt, success/failure restoration).'
} finally {
    $env:DATABASE_MIGRATE_URL = $oldUrl
    $env:ISP_ENV = $oldEnvironment
    if ($stateVariable) {
        $global:IspPreflightTestState = $previousState
    } else {
        Remove-Variable -Name IspPreflightTestState -Scope Global -ErrorAction SilentlyContinue
    }
}
