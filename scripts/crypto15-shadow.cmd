@echo off
rem RECORDS ONLY - never places, amends or cancels an order. Public Kalshi endpoints, no auth, no key read.
rem Switch BEFORE the title, and the exe path quoted separately: `start` mis-parses a spaced exe path
rem otherwise, and spawn(detached) returns a pid while running nothing on this box.
start "" /min "C:\Program Files\nodejs\node.exe" "%~dp0crypto15-shadow.mjs"
rem The sentinel relaunches this through `start`, which runs it under cmd /K: without an exit every relaunch left a window open.
exit
