# Exercise the actual operator script with an in-memory credential and a fake
# pnpm command. No server, credential store, or external API is contacted.
$ErrorActionPreference = 'Stop'
$script:exitCode = 0
$script:captured = @()
function Read-Host {
    param([string]$Prompt, [switch]$AsSecureString)
    if (-not $AsSecureString) { throw 'The maintenance connection must use a hidden prompt.' }
    return (ConvertTo-SecureString 'postgresql://owner:test@localhost/test' -AsPlainText -Force)
}
function pnpm {
    $script:captured = @($args)
    $global:LASTEXITCODE = $script:exitCode
}
$oldUrl = $env:DATABASE_MIGRATE_URL
$oldEnvironment = $env:ISP_ENV
try {
    $env:DATABASE_MIGRATE_URL = 'original-value'
    $env:ISP_ENV = 'original-environment'
    & "$PSScriptRoot/staging-repair-preflight.ps1"
    if (($script:captured -join ' ') -ne 'db:migrate -- --plan --detect-baseline') {
        throw 'Preflight must only execute read-only baseline detection.'
    }
    if ($env:DATABASE_MIGRATE_URL -ne 'original-value' -or $env:ISP_ENV -ne 'original-environment') {
        throw 'Preflight failed to restore the local environment.'
    }
    $script:exitCode = 23
    $failedSafely = $false
    try { & "$PSScriptRoot/staging-repair-preflight.ps1" } catch { $failedSafely = $true }
    if (-not $failedSafely) { throw 'Preflight must surface a failed migration plan.' }
    if ($env:DATABASE_MIGRATE_URL -ne 'original-value' -or $env:ISP_ENV -ne 'original-environment') {
        throw 'Failed preflight failed to restore the local environment.'
    }
    Write-Host 'PowerShell preflight safety: PASS (read-only arguments, hidden prompt, success/failure restoration).'
} finally {
    $env:DATABASE_MIGRATE_URL = $oldUrl
    $env:ISP_ENV = $oldEnvironment
    $global:LASTEXITCODE = 0
}
