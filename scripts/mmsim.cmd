@echo off
rem RECORDS ONLY - never places, amends or cancels an order. Public Kalshi endpoints, no auth, no key read.
rem Switch before the title, exe path quoted separately: `start` mis-parses a spaced exe path otherwise,
rem and spawn(detached) returns a pid while running nothing on this box.
start "" /min "C:\Program Files\nodejs\node.exe" "G:\PROJECTS\oracle-trader\scripts\mmsim.mjs"
