@echo off
setlocal
cd /d "%~dp0"
echo Core Coach: updating hero catalog and images. STRATZ builds update in the application.
where node >nul 2>nul
if not errorlevel 1 (
  node scripts\update-data.cjs
  pause
  exit /b
)
echo Install Node.js 22.12.0 or newer and run again.
pause
