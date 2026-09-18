@echo off
rem Launcher for the 15-minute commodity ladder shadow recorder.
rem
rem Exists because neither direct launch form works on this box: spawn(..., {detached:true}) returns a pid
rem and runs nothing (round 61 found this for powershell.exe; it is true of node.exe too), and
rem `cmd /c start` mis-parses a node path containing spaces. This wrapper lives at a space-free path so
rem `cmd /c start "" /min <this>` is unambiguous, and does its own quoting internally.
rem
rem The recorder RECORDS ONLY - it never places, amends or cancels an order.
start "" /min "C:\Program Files\nodejs\node.exe" "G:\PROJECTS\oracle-trader\scripts\ladder15-shadow.mjs"
