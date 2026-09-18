@echo off
setlocal
for /f "tokens=2,*" %%A in ('reg query "HKCU\Environment" /v SPORTSGAMEODDS_API_KEY 2^>nul') do set "SPORTSGAMEODDS_API_KEY=%%B"
for /f "tokens=2,*" %%A in ('reg query "HKCU\Environment" /v BRIGHTDATA_API_KEY 2^>nul') do set "BRIGHTDATA_API_KEY=%%B"
for /f "tokens=2,*" %%A in ('reg query "HKCU\Environment" /v OPENROUTER_API_KEY 2^>nul') do set "OPENROUTER_API_KEY=%%B"
npm start
