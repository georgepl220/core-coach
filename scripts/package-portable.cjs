'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { PRODUCT } = require('../src/product.cjs');

const ROOT = path.resolve(__dirname, '..');
const releaseRoot = path.resolve(ROOT, 'release');
const destination = path.resolve(releaseRoot, PRODUCT.releaseDirectory);
const legacyDestination = path.resolve(releaseRoot, PRODUCT.legacyReleaseDirectory);
if (!destination.startsWith(releaseRoot + path.sep) || !legacyDestination.startsWith(releaseRoot + path.sep)) {
  throw new Error('Invalid release target');
}

const electronRoot = path.dirname(require('electron'));
if (!fs.existsSync(path.join(electronRoot, 'electron.exe'))) throw new Error('Install Electron first');
fs.mkdirSync(destination, { recursive: true });
fs.cpSync(electronRoot, destination, { recursive: true, dereference: true });
fs.copyFileSync(path.join(electronRoot, 'electron.exe'), path.join(destination, PRODUCT.executableFilename));

// The build helper is pinned to the official Electron rcedit v2.0.0 asset.
// The old release published no digest; this is the hash recorded on download.
const resourceEditor = path.join(__dirname, 'bin', 'rcedit-x64.exe');
const resourceEditorSha256 = '3e7801db1a5edbec91b49a24a094aad776cb4515488ea5a4ca2289c400eade2a';
if (!fs.existsSync(resourceEditor)) throw new Error('Windows branding requires scripts/bin/rcedit-x64.exe; see scripts/bin/rcedit-source.json.');
if (crypto.createHash('sha256').update(fs.readFileSync(resourceEditor)).digest('hex') !== resourceEditorSha256) {
  throw new Error('rcedit checksum mismatch; executable branding was not applied.');
}
const branding = spawnSync(resourceEditor, [
  path.join(destination, PRODUCT.executableFilename),
  '--set-icon', path.join(ROOT, 'data', 'assets', 'core-coach.ico'),
  '--set-file-version', PRODUCT.version,
  '--set-product-version', PRODUCT.version,
  '--set-version-string', 'ProductName', PRODUCT.name,
  '--set-version-string', 'FileDescription', 'Core Coach — Carry Companion',
  '--set-version-string', 'CompanyName', 'Core Coach Project',
  '--set-version-string', 'InternalName', PRODUCT.slug,
  '--set-version-string', 'OriginalFilename', PRODUCT.executableFilename,
], { encoding: 'utf8', windowsHide: true });
if (branding.error || branding.status !== 0) {
  throw new Error('Windows executable branding failed: ' + (branding.error?.message || branding.stderr || branding.stdout || branding.status));
}

const appRoot = path.join(destination, 'resources', 'app');
fs.mkdirSync(appRoot, { recursive: true });
for (const entry of ['src', 'data', 'scripts']) {
  fs.cpSync(path.join(ROOT, entry), path.join(appRoot, entry), { recursive: true, dereference: true });
}

// Preserve the user's token and all other state when introducing the new
// release directory. Existing Core Coach files always take precedence.
function copyMissingRuntime(source, target) {
  if (!fs.existsSync(source)) return 0;
  fs.mkdirSync(target, { recursive: true });
  let copied = 0;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!fs.existsSync(to) || fs.statSync(to).isDirectory()) copied += copyMissingRuntime(from, to);
    } else if (entry.isFile() && !fs.existsSync(to)) {
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      copied++;
    }
  }
  return copied;
}
const migratedFiles = copyMissingRuntime(
  path.join(legacyDestination, 'resources', 'app', 'runtime'),
  path.join(appRoot, 'runtime'),
);

const originalPackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(appRoot, 'package.json'), JSON.stringify({
  name: originalPackage.name,
  version: originalPackage.version,
  description: originalPackage.description,
  main: originalPackage.main,
}, null, 2));

fs.writeFileSync(path.join(destination, 'Update-Data.cmd'), [
  '@echo off',
  'setlocal',
  'cd /d "%~dp0"',
  'echo Core Coach: updating hero catalog and images. STRATZ builds update in the application.',
  'set ELECTRON_RUN_AS_NODE=1',
  `"${PRODUCT.executableFilename}" "resources\\app\\scripts\\update-data.cjs"`,
  'pause',
  '',
].join('\r\n'));

const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(
  'Открой `release/Core Coach/Core Coach.exe`. Либо открой `Start-Coach.cmd` в исходном проекте: он запускает готовую сборку, а при её отсутствии — Electron из `node_modules`.',
  'Открой `Core Coach.exe` в этой папке. Установка Node.js не нужна. Исходники приложения находятся в `resources/app`.',
);
fs.writeFileSync(path.join(destination, 'README.md'), readme);
for (const changelog of ['CHANGES-0.2.md', 'CHANGES-0.3.md', 'CHANGES-0.4.md', 'CHANGES-0.5.md', 'CHANGES-0.5.1.md', 'CHANGES-0.5.2.md', 'CHANGES-0.5.3.md', 'CHANGES-0.5.4.md', 'CHANGES-0.6.0.md', 'CHANGES-0.6.1.md', 'CHANGES-0.7.0.md', 'CHANGES-0.8.0.md', 'CHANGES-0.9.0.md', 'CHANGES-0.9.1.md', 'CHANGES-0.9.2.md', 'PICKER-VALIDATION-0.9.2.md', 'CHANGES-0.9.3.md', 'PICKER-VALIDATION-0.9.3.md', 'DRAFT-EVALUATION.md', 'CHANGES-0.9.4.md', 'CHANGES-0.9.5.md', 'CHANGES-0.9.6.md', 'CHANGES-0.9.7.md']) {
  if (fs.existsSync(path.join(ROOT, changelog))) fs.copyFileSync(path.join(ROOT, changelog), path.join(destination, changelog));
}
console.log('Portable application: ' + path.join(destination, PRODUCT.executableFilename));
console.log('Windows icon and version metadata: Core Coach ' + PRODUCT.version);
console.log(`Preserved legacy runtime files: ${migratedFiles}`);


