@echo off
cd /d %~dp0
sewers-bot.exe --ui
if errorlevel 1 (
  echo.
  echo Bot exited with an error. Press any key to close...
  pause >nul
)
