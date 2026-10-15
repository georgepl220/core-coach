$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw 'Install Node.js 22 or newer, then run this script again.'
}
npm install
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
node node_modules/electron/install.js
if ($LASTEXITCODE -ne 0) { throw 'Electron download failed.' }
node scripts/update-data.cjs
if ($LASTEXITCODE -ne 0) { throw 'Dataset update failed.' }
Write-Host 'Core Coach is ready. Open Start-Coach.cmd. Configure a personal STRATZ token in the application settings to update builds.'
