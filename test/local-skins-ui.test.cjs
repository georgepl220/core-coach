'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = filename => fs.readFileSync(path.join(root, filename), 'utf8');
const main = source('src/main.cjs');

test('removed cosmetic commands cannot reach an installer through the normal IPC handler', async () => {
  let handler, unexpected = 0;
  const context = {
    ipcMain: { handle(channel, callback) { assert.equal(channel, 'coach:command'); handler = callback; } },
    trustedEvent: () => true, trustedDraftEvent: () => false,
    note() { unexpected++; }, showControl() { unexpected++; },
  };
  vm.createContext(context);
  vm.runInContext(main.slice(main.indexOf("ipcMain.handle('coach:command'"), main.indexOf('app.setName(PRODUCT.name)')), context);
  for (const name of ['skins-refresh', 'skins-apply', 'skins-disable']) {
    const result = await handler({}, { name, value: { arcanaMode: 'all_available', effectsEnabled: true, terrainId: 'terrain_11316', arcanaIds: [] } });
    assert.equal(result.error, 'Неизвестная команда');
  }
  assert.equal(unexpected, 0);
});

test('the active application no longer exposes or starts VPK cosmetic controls', () => {
  assert.doesNotMatch(source('src/index.html'), /local-skin|local-cosmetics|inventory-changer/);
  assert.doesNotMatch(source('src/renderer.js'), /localSkinChoice|localSkins|renderLocalSkins|skins-apply/);
  assert.doesNotMatch(source('src/style.css'), /\.local-skin|\.local-cosmetics/);
  assert.doesNotMatch(main, /LocalCosmeticsManager|localSkins|localSkinCommand/);
  assert.ok(fs.existsSync(path.join(root, 'src/local-cosmetics.cjs')), 'Recovery helper remains available for existing owned installations');
});

test('Steam install discovery still supports the original and current local libraries for GSI setup', () => {
  const expected = ['D:\\SteamLibrary', 'E:\\SteamLibrary'].map(base => path.join(base, 'steamapps', 'common', 'dota 2 beta'));
  const context = { path, fs: { readFileSync() { throw new Error('No VDF'); }, existsSync: value => expected.some(base => ['game/dota/cfg','game/dota/pak01_dir.vpk','game/bin/win64/dota2.exe'].some(relative => value === path.join(base,...relative.split('/')))) } };
  vm.createContext(context);
  vm.runInContext(main.slice(main.indexOf('function possibleDotaPaths('), main.indexOf('async function installGsi(')), context);
  assert.deepEqual([...context.possibleDotaPaths()].sort(), expected.sort());
});

test('a moved installation ignores an old cfg-only E library and selects the complete D installation', () => {
  const current=path.join('D:\\SteamLibrary','steamapps','common','dota 2 beta'),old=path.join('E:\\SteamLibrary','steamapps','common','dota 2 beta');
  const present=new Set([path.join(old,'game','dota','cfg'),...['game/dota/cfg','game/dota/pak01_dir.vpk','game/bin/win64/dota2.exe'].map(relative=>path.join(current,...relative.split('/')))]);
  const context={path,fs:{readFileSync(){throw Error('No VDF');},existsSync:value=>present.has(value)}};
  vm.createContext(context);vm.runInContext(main.slice(main.indexOf('function possibleDotaPaths('),main.indexOf('async function installGsi(')),context);
  assert.deepEqual([...context.possibleDotaPaths()],[current]);
});
