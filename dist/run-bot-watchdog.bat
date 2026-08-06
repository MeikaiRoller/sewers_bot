@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d %~dp0
set "EXE=sewers-bot.exe"
set "ARGS="
set "MAX_RESTARTS=20"
set "RESTART_DELAY=5"
set "ATTEMPT=0"
:loop
if not exist "%EXE%" (
  echo Missing %EXE%.
  exit /b 1
)
echo Starting %EXE% (attempt !ATTEMPT! of %MAX_RESTARTS%)
"%EXE%" %ARGS%
set "EXIT_CODE=%ERRORLEVEL%"
if "%EXIT_CODE%" == "0" (
  echo Bot exited cleanly.
  exit /b 0
)
set /a ATTEMPT+=1
if !ATTEMPT! GTR %MAX_RESTARTS% (
  echo Max restarts reached (%MAX_RESTARTS%). Exiting.
  exit /b %EXIT_CODE%
)
echo Restarting in %RESTART_DELAY%s...
timeout /t %RESTART_DELAY% /nobreak >nul
goto loop
