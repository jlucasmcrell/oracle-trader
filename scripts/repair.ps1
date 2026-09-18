# Headless repair session for one sentinel incident.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\repair.ps1 <incident.md>
# Started by scripts/sentinel.mjs (detached). Shares data/sentinel/agent.lock with the daily
# maintenance runner so two Claude sessions never edit the tree at once.
param([Parameter(Mandatory = $true)][string]$Incident)
$ErrorActionPreference = 'Continue'
$repo = 'G:\PROJECTS\oracle-trader'
$lock = Join-Path $repo 'data/sentinel/agent.lock'
# Open the log FIRST. The busy path used to exit 0 having written nothing anywhere, which is
# indistinguishable from the session never starting at all -- the state the detached-spawn bug left us in
# for a day and a half.
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$logDir = Join-Path $repo 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir "repair-$stamp.log"
"[$(Get-Date -Format o)] launched for $Incident" | Tee-Object -FilePath $log -Append
if (Test-Path $lock) {
  $age = (Get-Date) - (Get-Item $lock).LastWriteTime
  if ($age.TotalHours -lt 3) { "busy: $lock is $([int]$age.TotalMinutes) min old" | Tee-Object -FilePath $log -Append; exit 0 }
}
New-Item -ItemType Directory -Force (Split-Path $lock) | Out-Null
"repair $PID $(Get-Date -Format o) $Incident" | Set-Content $lock
try {
  Set-Location $repo
  $incidentPath = $Incident -replace '\\', '/'
  $prompt = "You are running HEADLESS from Windows Task Scheduler as an on-call repair session: no desktop tools (no SendUserFile, no PushNotification, no scheduled-task tools), nobody will answer a question, and permission prompts are off, so every rule in the instructions binds you absolutely. Read G:/PROJECTS/oracle-trader/docs/REPAIR-PROMPT.md first, then the incident file $incidentPath, and follow the prompt to the end. Finish by printing DONE and the incident's outcome line."
  "[$(Get-Date -Format o)] start $Incident" | Tee-Object -FilePath $log -Append
  # The scheduler passes the user environment, where ANTHROPIC_API_KEY (an un-scoped key) overrides the
  # claude.ai login and every request fails with 400 (2026-09-08 07:00 run). Use the login.
  Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue
  $null | & "$env:APPDATA\npm\claude.cmd" -p $prompt --dangerously-skip-permissions --output-format text --max-turns 250 2>&1 | Tee-Object -FilePath $log -Append
  "[$(Get-Date -Format o)] exit $LASTEXITCODE" | Tee-Object -FilePath $log -Append
} finally {
  Remove-Item $lock -ErrorAction SilentlyContinue
}
