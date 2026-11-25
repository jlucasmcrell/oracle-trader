# Makes every Oracle scheduled task that runs a console program (node, python, cmd, a .bat) start with no window,
# by running it through `conhost.exe --headless`. Without this each run opens a terminal window: the 15-minute
# sentinel and the hourly jobs flash one, and the logon recorders keep one open all day. The app itself (electron,
# a GUI program) is left alone so its window still opens.
#
# Run it once from an elevated PowerShell (the tasks were registered elevated, so a normal one cannot change them):
#   powershell -ExecutionPolicy Bypass -File scripts\hide-task-windows.ps1
# It is safe to run again: a task already going through conhost is skipped. -RestartRunning also restarts the
# recorders that are running right now, so their open window closes (a few seconds' gap in public-data recording).
param([switch]$RestartRunning)
$ErrorActionPreference = 'Stop'
$conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
$gui = @('electron.exe')

# A copy of the output goes to data\hide-task-windows.log, readable without admin rights.
$logFile = Join-Path (Split-Path -Parent $PSScriptRoot) 'data\hide-task-windows.log'
function Say($msg) { Write-Host $msg; Add-Content -Path $logFile -Value $msg }
Say "--- $(Get-Date -Format o)  elevated: $(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))"

$tasks = @(Get-ScheduledTask | Where-Object { $_.TaskName -like 'Oracle*' })
if (-not $tasks.Count) { Say 'No Oracle* scheduled tasks are visible. Run this from an elevated PowerShell.'; exit 1 }
$failed = 0
foreach ($t in $tasks) {
 try {
  $changed = $false
  $actions = foreach ($a in $t.Actions) {
    $exe = $a.Execute.Trim('"')
    if ((Split-Path $exe -Leaf) -in $gui -or (Split-Path $exe -Leaf) -ieq 'conhost.exe') { $a; continue }
    $changed = $true
    # -WorkingDirectory only when the task has one: an empty value is rejected (the IB Gateway task has none).
    $spec = @{ Execute = $conhost; Argument = ("--headless `"$exe`" " + $a.Arguments).TrimEnd() }
    if ($a.WorkingDirectory) { $spec.WorkingDirectory = $a.WorkingDirectory }
    New-ScheduledTaskAction @spec
  }
  if (-not $changed) { Say "  unchanged  $($t.TaskName)"; continue }
  $wasRunning = $t.State -eq 'Running'
  Set-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -Action $actions | Out-Null
  Say "  hidden     $($t.TaskName)"
  if ($wasRunning -and $RestartRunning) {
    Stop-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath
    # A recorder started some other way is not stopped by the task, and its recorder lock would make the new
    # copy exit at once, leaving the old window up: stop any process still running the same script.
    $script = ($t.Actions | Select-Object -First 1).Arguments
    if ($script) {
      $needle = $script.Trim().Trim('"')
      Get-CimInstance Win32_Process -Filter "Name='node.exe' or Name='python.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    }
    Start-Sleep -Seconds 2
    Start-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath
    Say "             restarted without a window"
  }
 } catch {
  $failed++
  Say "  FAILED     $($t.TaskName): $($_.Exception.Message)"
 }
}
Say "done, $failed failed"
