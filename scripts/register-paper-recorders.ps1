# Registers and starts the two paper recorders of 2026-11-12 as logon tasks, like OracleTrader-InplayBooks.
# Both read public data only and place no orders (docs/PREREGISTERED-lategame.md, -newmarket-bid.md).
#   powershell -ExecutionPolicy Bypass -File scripts\register-paper-recorders.ps1
$repo = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node.exe).Source
foreach ($p in @(@('OracleTrader-LateGame', 'scripts\lategame-shadow.mjs'), @('OracleTrader-NewMarkets', 'scripts\newmarket-shadow.mjs'))) {
  $action = New-ScheduledTaskAction -Execute $node -Argument ('"' + $p[1] + '"') -WorkingDirectory $repo
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $trigger.Delay = 'PT1M'
  $settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden
  Register-ScheduledTask -TaskName $p[0] -Action $action -Trigger $trigger -Settings $settings -Description 'Oracle Trader paper recorder. Public data only; places no orders.' -Force | Out-Null
  Start-ScheduledTask -TaskName $p[0]
}
Start-Sleep -Seconds 3
Get-ScheduledTask -TaskName 'OracleTrader-LateGame', 'OracleTrader-NewMarkets' | Select-Object TaskName, State
