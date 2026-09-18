@echo off
title Oracle Trader Launcher
cd /d "%~dp0"

echo [Oracle Trader] Building latest code...
call npx electron-vite build
if errorlevel 1 (
  echo.
  echo [Oracle Trader] BUILD FAILED - the app was not started.
  echo Fix the error shown above, then run this launcher again.
  pause
  exit /b 1
)

echo [Oracle Trader] Launching...
start "Oracle Trader" "%~dp0node_modules\electron\dist\electron.exe" .
exit /b 0
