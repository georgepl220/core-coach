@echo off
setlocal
cd /d "%~dp0"
if exist "release\Core Coach\Core Coach.exe" (
  start "" "release\Core Coach\Core Coach.exe"
  exit /b
)
if exist "node_modules\electron\dist\electron.exe" (
  start "" "node_modules\electron\dist\electron.exe" .
  exit /b
)
echo Core Coach is not packaged and Electron is missing. Run Setup-Coach.ps1 in PowerShell first.
pause
