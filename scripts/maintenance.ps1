# Headless daily maintenance runner for Oracle Trader.
# Runs from Windows Task Scheduler (OracleTrader-Maintenance), so it works with the
# desktop app closed and needs no permission clicks. The desktop scheduled task
# "oracle-trader-maintenance" only delivers the report this run writes.
$ErrorActionPreference = 'Continue'
$repo = 'G:\PROJECTS\oracle-trader'
$logDir = Join-Path $repo 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$stamp = Get-Date -Format 'yyyy-MM-dd'
$log = Join-Path $logDir "maintenance-$stamp.log"
Set-Location $repo
# Daily-idempotent guard. This task is scheduled TWICE a day on purpose: the 07:00
# primary run and an 11:30 catch-up. An LLM weekly quota resets at 11am, so while the
# quota is exhausted the 07:00 run can only ever fail - that is exactly the incident
# data/sentinel/incidents/2026-09-18T12-05-maintenance-failed.md. The catch-up exists so
# the day's work happens LATE instead of not at all. If today's log already shows a
# successful run, there is nothing to do and we must not re-run the agent.
if (Test-Path $log) {
  if (Select-String -Path $log -Pattern '\] exit 0' -Quiet) {
    "[$(Get-Date -Format o)] skip: today's maintenance already completed (exit 0 in log)" | Tee-Object -FilePath $log -Append
    exit 0
  }
}
# One Claude session at a time: repair sessions (scripts/repair.ps1) hold the same lock.
$lock = Join-Path $repo 'data/sentinel/agent.lock'
New-Item -ItemType Directory -Force (Split-Path $lock) | Out-Null
$waited = 0
while ((Test-Path $lock) -and (((Get-Date) - (Get-Item $lock).LastWriteTime).TotalHours -lt 3) -and ($waited -lt 60)) {
  Start-Sleep -Seconds 60; $waited++
}
"maintenance $PID $(Get-Date -Format o)" | Set-Content $lock
$skill = 'G:/PROJECTS/oracle-trader/docs/MAINTENANCE-PROMPT.md'
$prompt = "You are running HEADLESS from Windows Task Scheduler: no desktop tools (no SendUserFile, no PushNotification, no scheduled-task tools), nobody will answer a question, and permission prompts are off, so every rule in the instructions binds you absolutely. Read the file $skill and follow every step in order. For step 6 write the report to docs\reports\$stamp.md and skip the sending: a separate desktop task delivers that file at 08:30. Finish everything; end by printing DONE and a five-line summary of what changed and what needs the operator (usually nothing)."
"[$(Get-Date -Format o)] start" | Tee-Object -FilePath $log -Append
# The scheduler passes the user environment, where ANTHROPIC_API_KEY (an un-scoped key) overrides the
# claude.ai login and every request fails with 400 (2026-09-08 07:00 run). Use the login.
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue
$null | & "$env:APPDATA\npm\claude.cmd" -p $prompt --dangerously-skip-permissions --output-format text --max-turns 400 2>&1 | Tee-Object -FilePath $log -Append
$code = $LASTEXITCODE
"[$(Get-Date -Format o)] exit $code" | Tee-Object -FilePath $log -Append
Remove-Item $lock -ErrorAction SilentlyContinue
# Propagate the real result. Without this the task wrote no exit code, so Task
# Scheduler reported 0 for EVERY run - a failed maintenance looked exactly like a
# clean one, which is how the 2026-09-18 failure stayed invisible at the scheduler.
exit $code
