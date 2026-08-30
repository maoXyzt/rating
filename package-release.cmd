@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\package-release.ps1"
if errorlevel 1 (
  echo.
  echo Release packaging failed.
  pause
  exit /b 1
)
echo.
echo Release packaging completed.
pause
