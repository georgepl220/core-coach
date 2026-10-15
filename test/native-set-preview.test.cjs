'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { NativeSetPreview, launchNativeSetPreview, getNativeSetMetadata, SET_ID } = require('../src/native-set-preview.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-coach-native-preview-')), gameDir = path.join(root, 'game');
  const executable = path.join(gameDir, 'bin', 'win64', 'dota2.exe'), source = path.join(gameDir, 'dota', 'pak01_dir.vpk'), info = path.join(gameDir, 'dota', 'gameinfo.gi');
  fs.mkdirSync(path.dirname(executable), { recursive: true }); fs.mkdirSync(path.dirname(source), { recursive: true });
  const pe = Buffer.alloc(256); pe.writeUInt16LE(0x5a4d); pe.writeUInt32LE(128, 0x3c); pe.writeUInt32LE(0x00004550, 128); pe.writeUInt16LE(0x8664, 132); pe.writeUInt16LE(0x20b, 152); fs.writeFileSync(executable, pe);
  const vpk = Buffer.alloc(32); vpk.writeUInt32LE(0x55aa1234); vpk.writeUInt32LE(2, 4); vpk.writeUInt32LE(4, 8); fs.writeFileSync(source, vpk); fs.writeFileSync(info, '"GameInfo" { GameData "dota.fgd" }');
  const before = [executable, source, info].map(filename => fs.readFileSync(filename));
  t.after(() => { const resolved = path.resolve(root); assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('core-coach-native-preview-')); fs.rmSync(resolved, { recursive: true, force: true }); });
  return { root, gameDir, executable, source, info, before, options: { gameDir, setId: SET_ID } };
}
function spawnFixture(action = 'spawn') {
  const calls = [];
  const spawn = (...args) => { const child = new EventEmitter(); child.pid = 4321; child.unref = () => { child.unreferenced = true; }; calls.push({ args, child }); queueMicrotask(() => child.emit(action, ...(action === 'error' ? [new Error('Synthetic error')] : []))); return child; };
  return { spawn, calls };
}

test('metadata describes only the fixed native test set and returns independent objects', () => {
  const first = getNativeSetMetadata(); assert.equal(first.setId, 'sepulchral_stalker'); assert.equal(first.bundleId, 34595); assert.equal(first.baseItemId, 19090); assert.equal(first.heroId, 6); assert.deepEqual(first.pieces.map(row => row.itemId), [34588, 34589, 34590, 34591, 34592, 34593, 34594]); assert.equal(first.inventoryModified, false); first.pieces[0].itemId = 1; assert.equal(getNativeSetMetadata().pieces[0].itemId, 34588);
});
test('launch uses only the checked executable, fixed argv and detached hidden spawn without writes', async t => {
  const files = fixture(t), fake = spawnFixture(); let checks = 0;
  const result = await launchNativeSetPreview(files.options, { isGameRunning: async () => { checks++; return false; }, spawn: fake.spawn });
  assert.equal(result.ok, true); assert.equal(result.status, 'launch_requested'); assert.equal(result.pid, 4321); assert.equal(checks, 2); assert.equal(fake.calls.length, 1); assert.equal(fake.calls[0].args[0], files.executable); assert.deepEqual(fake.calls[0].args[1], ['-novid', '+dota_show_test_item_set_page', SET_ID]); assert.deepEqual(fake.calls[0].args[2], { cwd: path.dirname(files.executable), detached: true, windowsHide: true, stdio: 'ignore', shell: false }); assert.equal(fake.calls[0].child.unreferenced, true); assert.match(result.message, /тестовой страницы/); assert.doesNotMatch(result.message, /успешно экипирован|добавлены в инвентарь/); [files.executable, files.source, files.info].forEach((filename, i) => assert.deepEqual(fs.readFileSync(filename), files.before[i]));
});
test('insecure is opt-in only and arbitrary command, set, path and option payloads are rejected', async t => {
  const files = fixture(t), fake = spawnFixture(), launcher = new NativeSetPreview({ isGameRunning: async () => false, spawn: fake.spawn });
  assert.equal((await launcher.launch({ ...files.options, insecure: true })).ok, true); assert.deepEqual(fake.calls[0].args[1], ['-novid', '-insecure', '+dota_show_test_item_set_page', SET_ID]);
  for (const bad of [{ ...files.options, setId: 'other_set' }, { ...files.options, setId: 'sepulchral_stalker;+quit' }, { ...files.options, argv: ['+quit'] }, { ...files.options, insecure: 'true' }, { ...files.options, gameDir: 'relative/game' }, { ...files.options, gameDir: path.dirname(files.gameDir) }]) assert.equal((await launcher.launch(bad)).ok, false);
  assert.equal(fake.calls.length, 1);
});
test('an open game or failed process check rejects without spawning or terminating any process', async t => {
  const files = fixture(t), fake = spawnFixture();
  for (const [check, code] of [[async () => true, 'GAME_RUNNING'], [async () => null, 'PROCESS_CHECK_FAILED'], [async () => { throw new Error('Tasklist failed'); }, 'PROCESS_CHECK_FAILED']]) assert.equal((await launchNativeSetPreview(files.options, { isGameRunning: check, spawn: fake.spawn })).code, code);
  let checks = 0; assert.equal((await launchNativeSetPreview(files.options, { isGameRunning: async () => ++checks === 2, spawn: fake.spawn })).code, 'GAME_RUNNING'); assert.equal(fake.calls.length, 0);
});
test('malformed or missing stock game files fail closed', async t => {
  for (const which of ['executable', 'source', 'info']) {
    const files = fixture(t), fake = spawnFixture(); fs.writeFileSync(files[which], 'invalid'); assert.equal((await launchNativeSetPreview(files.options, { isGameRunning: async () => false, spawn: fake.spawn })).code, 'INSTALL_INVALID'); assert.equal(fake.calls.length, 0);
  }
  const files = fixture(t), fake = spawnFixture(); fs.unlinkSync(files.executable); assert.equal((await launchNativeSetPreview(files.options, { isGameRunning: async () => false, spawn: fake.spawn })).code, 'INSTALL_INVALID'); assert.equal(fake.calls.length, 0);
});
test('file replacement during validation is detected before spawning', async t => {
  const files = fixture(t), fake = spawnFixture(); let checks = 0;
  const result = await launchNativeSetPreview(files.options, { isGameRunning: async () => { if (++checks === 2) fs.appendFileSync(files.source, 'external-update'); return false; }, spawn: fake.spawn }); assert.equal(result.code, 'INSTALL_CHANGED'); assert.equal(fake.calls.length, 0);
});
test('directory links and file links are rejected', async t => {
  const files = fixture(t), fake = spawnFixture(), alias = path.join(files.root, 'alias');
  try { fs.symlinkSync(files.root, alias, process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return; throw error; }
  assert.equal((await launchNativeSetPreview({ gameDir: path.join(alias, 'game'), setId: SET_ID }, { isGameRunning: async () => false, spawn: fake.spawn })).code, 'UNSAFE_PATH');
  const target = path.join(files.root, 'copy.exe'); fs.renameSync(files.executable, target); try { fs.symlinkSync(target, files.executable, process.platform === 'win32' ? 'file' : undefined); } catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return; throw error; } assert.equal((await launchNativeSetPreview(files.options, { isGameRunning: async () => false, spawn: fake.spawn })).code, 'UNSAFE_PATH'); assert.equal(fake.calls.length, 0);
});
test('spawn errors are reported and a second simultaneous launch cannot duplicate the process', async t => {
  const files = fixture(t);
  for (const action of ['error', 'close']) { const fake = spawnFixture(action); assert.equal((await launchNativeSetPreview(files.options, { isGameRunning: async () => false, spawn: fake.spawn })).code, 'LAUNCH_FAILED'); }
  assert.equal((await launchNativeSetPreview(files.options, { isGameRunning: async () => false, spawn: () => { throw new Error('Synthetic error'); } })).code, 'LAUNCH_FAILED');
  let proceed; const gate = new Promise(resolve => { proceed = resolve; }), fake = spawnFixture(), launcher = new NativeSetPreview({ isGameRunning: async () => { await gate; return false; }, spawn: fake.spawn }); const pending = launcher.launch(files.options); assert.equal((await launcher.launch(files.options)).code, 'BUSY'); proceed(); assert.equal((await pending).ok, true); assert.equal(fake.calls.length, 1);
});
