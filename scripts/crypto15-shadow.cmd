@echo off
rem RECORDS ONLY - never places, amends or cancels an order. Public Kalshi endpoints, no auth, no key read.
rem Switch BEFORE the title, and the exe path quoted separately: `start` mis-parses a spaced exe path
rem otherwise, and spawn(detached) returns a pid while running nothing on this box.
start "" /min "C:\Program Files\nodejs\node.exe" "G:\PROJECTS\oracle-trader\scripts\crypto15-shadow.mjs"
