<#
  Sets up Sentiment's nightly podcast transcription on this computer.

  - Writes sentiment-whisper.json (Sentiment API address and token) if it is missing.
  - Registers a Windows Task Scheduler task that starts sentiment_whisper.py at
    03:00 Arizona time every night (converted to this computer's clock), wakes
    the computer if it is asleep, runs at below-normal priority and is stopped
    by Windows after 4 hours 10 minutes at the latest. The script itself stops
    claiming work at 07:00 Arizona time.

  Run from PowerShell in this folder:
    powershell -ExecutionPolicy Bypass -File .\install-nightly-task.ps1

  Remove later with:
    Unregister-ScheduledTask -TaskName "Sentiment Whisper (nightly)" -Confirm:$false
#>
param(
  [string]$Python = "$env:USERPROFILE\Documents\Business\Transcriber\venv\Scripts\python.exe",
  [string]$ArizonaStart = "03:00"
)
$ErrorActionPreference = "Stop"

$script = Join-Path $PSScriptRoot "sentiment_whisper.py"
$config = Join-Path $PSScriptRoot "sentiment-whisper.json"

if (-not (Test-Path $Python)) {
  throw "Python not found at $Python. Pass -Python with the Transcriber venv's python.exe."
}
& $Python -c "import faster_whisper" 2>$null
if ($LASTEXITCODE -ne 0) {
  throw "faster-whisper is not installed in $Python."
}

if (-not (Test-Path $config)) {
  $api = Read-Host "Sentiment API address (for example https://isp-staging-api-production.up.railway.app)"
  $token = Read-Host "LOCAL_TRANSCRIBER_TOKEN (the same value set on Sentiment's API service)"
  @{ api_url = $api.Trim(); token = $token.Trim(); model = "large-v3-turbo"; language = "en"; window_start = "03:00"; window_end = "07:00" } |
    ConvertTo-Json | Set-Content -Path $config -Encoding UTF8
  Write-Host "Saved $config"
}

# 03:00 Arizona time (no daylight saving) on this computer's clock.
$arizona = [System.TimeZoneInfo]::FindSystemTimeZoneById("US Mountain Standard Time")
$parts = $ArizonaStart.Split(":")
$azToday = [datetime]::SpecifyKind((Get-Date).Date.AddHours([int]$parts[0]).AddMinutes([int]$parts[1]), [System.DateTimeKind]::Unspecified)
$localStart = [System.TimeZoneInfo]::ConvertTime($azToday, $arizona, [System.TimeZoneInfo]::Local)

$action = New-ScheduledTaskAction -Execute $Python -Argument "`"$script`"" -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -Daily -At $localStart
$settings = New-ScheduledTaskSettingsSet -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 4 -Minutes 10) -MultipleInstances IgnoreNew -Priority 7
Register-ScheduledTask -TaskName "Sentiment Whisper (nightly)" -Action $action -Trigger $trigger -Settings $settings `
  -Description "Transcribes podcast episodes for Sentiment between 03:00 and 07:00 Arizona time." -Force | Out-Null

Write-Host ("Scheduled daily at {0:HH:mm} on this computer's clock (03:00 Arizona time)." -f $localStart)
Write-Host "Test it now, outside the window, with:"
Write-Host "  & `"$Python`" `"$script`" --ignore-window --max-jobs 1"
