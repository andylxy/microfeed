@echo off
REM ============================================================
REM  microfeed dev server launcher (hidden background)
REM  Called by dev-local.bat via wscript (no window).
REM  Logs everything to .microfeed\dev-local-start.log
REM ============================================================
setlocal
cd /d "%~dp0"
set "CODEBUDDY_SAFE_DELETE_ENABLED=0"
.\node_modules\.bin\yarn.cmd manage dev --local --instance ctwh-881019-xyz >> .microfeed\dev-local-start.log 2>&1
exit /b 0
