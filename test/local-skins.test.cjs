'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { LocalSkinManager, bootAudio, replaceBootAudio } = require('../src/local-skins.cjs');
const { SKIN_ID, RESOURCE_MAP, buildPackage } = require('../src/local-skins-worker.cjs');
const { createVpk, openVpk, readResource } = require('../src/valve-vpk.cjs');
const BOOT = '// keep this comment\r\n"boot"\r\n{\r\n\t"UILanguage" "ukrainian"\r\n\t"AudioLanguage" "english"\r\n\t"Volume" "0.45"\r\n}\r\n';
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
function sourceData(suffix = '') { return createVpk(new Map([...new Set(Object.values(RESOURCE_MAP))].map(name => [name, Buffer.from('compiled-resource:' + name + suffix)]))); }
function fixture(t, options = {}) {
  const parent = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'core-coach-local-skins-'));
  const gameDir = path.join(root, 'installation', 'game'), runtimeDir = path.join(root, 'runtime'), sourcePath = path.join(gameDir, 'dota', 'pak01_dir.vpk'), bootPath = path.join(gameDir, 'dota', 'cfg', 'boot.vcfg');
  fs.mkdirSync(path.dirname(bootPath), { recursive: true }); fs.mkdirSync(runtimeDir);
  fs.writeFileSync(sourcePath, sourceData()); fs.writeFileSync(bootPath, options.boot ?? BOOT);
  for (const language of ['russian', 'koreana', 'schinese']) { const folder = path.join(gameDir, `dota_${language}`); fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, 'gameinfo.gi'), 'original-language-layer'); }
  fs.writeFileSync(path.join(gameDir, 'dota', 'gameinfo.gi'), 'original-game-info');
  const managers = [], changes = [];
  const manager = (extra = {}) => { const value = new LocalSkinManager({ runtimeDir, installCandidates: () => [path.dirname(gameDir)], isGameRunning: async () => false, onChange: state => changes.push(state), ...extra }); managers.push(value); return value; };
  t.after(async () => { for (const value of managers) await value.stop(); const resolved = path.resolve(root); assert.ok(resolved.startsWith(parent + path.sep) && path.basename(resolved).startsWith('core-coach-local-skins-')); fs.rmSync(resolved, { recursive: true, force: true }); });
  return { root, gameDir, runtimeDir, sourcePath, bootPath, manager, changes, voice: language => path.join(gameDir, `dota_${language}`) };
}
const manifest = manager => JSON.parse(fs.readFileSync(manager.manifestPath, 'utf8'));
const target = (files, value) => path.join(files.voice(value.language), value.targetName);

test('boot patch changes only the direct AudioLanguage value and preserves unrelated blocks and comments', () => {
  const text = BOOT + '"other" { "AudioLanguage" "koreana" "Path" "E:\\Games" }\n';
  const changed = replaceBootAudio(text, 'russian');
  assert.equal(changed, text.replace('"AudioLanguage" "english"', '"AudioLanguage" "russian"'));
  assert.equal(replaceBootAudio(changed, 'english'), text);
  assert.equal(bootAudio(changed).value, 'russian');
  assert.throws(() => bootAudio('"boot" {"AudioLanguage" "english" "AudioLanguage" "russian"}'), /несколько/);
  assert.throws(() => replaceBootAudio(text, '../mods'), /Некорректный/);
  assert.throws(() => bootAudio('"boot" {"AudioLanguage" "english"'), /Некорректные|единственный/);
});

test('a missing audio key can be inserted and later removed without changing other fields', () => {
  const text = '"boot"\n{\n\t"UILanguage" "ukrainian"\n}\n';
  assert.equal(bootAudio(text).present, false);
  const changed = replaceBootAudio(text, 'russian'); assert.equal(bootAudio(changed).value, 'russian');
  assert.equal(replaceBootAudio(changed, null), text);
});

test('worker builds only nine model aliases and both weapon paths use the arcana weapon', t => {
  const files = fixture(t), before = fs.readFileSync(files.sourcePath);
  const built = buildPackage({ runtimeDir: files.runtimeDir, sourcePath: files.sourcePath, skinId: SKIN_ID });
  assert.equal(built.fileCount, 9); assert.equal(sha(fs.readFileSync(built.stagedPath)), built.sha256);
  assert.ok(built.stagedPath.startsWith(path.join(files.runtimeDir, 'local-skins', 'staging') + path.sep));
  const source = openVpk(files.sourcePath), output = openVpk(built.stagedPath);
  assert.deepEqual([...output.entries.keys()].sort(), Object.keys(RESOURCE_MAP).sort());
  for (const [destination, original] of Object.entries(RESOURCE_MAP)) assert.deepEqual(readResource(output, destination), readResource(source, original));
  assert.equal(RESOURCE_MAP['models/heroes/drow/drow_weapon.vmdl_c'], RESOURCE_MAP['models/heroes/drow/drow_crossbow.vmdl_c']);
  assert.match(RESOURCE_MAP['models/heroes/drow/drow_weapon.vmdl_c'], /drow_arcana_weapon\.vmdl_c$/);
  assert.deepEqual(fs.readFileSync(files.sourcePath), before);
  assert.deepEqual(fs.readdirSync(files.voice('russian')), ['gameinfo.gi']);
});

test('state access is cached and install, disable, restart preserve original game archives and UI language', async t => {
  const files = fixture(t); let scans = 0;
  const service = files.manager({ installCandidates: () => { scans++; return [path.dirname(files.gameDir)]; } });
  assert.equal(service.getState().status, 'idle'); assert.equal(scans, 0); assert.equal(service.getState().canApply, false);
  const originalSource = sha(fs.readFileSync(files.sourcePath)), originalInfo = fs.readFileSync(path.join(files.gameDir, 'dota', 'gameinfo.gi'), 'utf8');
  assert.equal((await service.scan()).ok, true); assert.equal(service.getState().canApply, true); assert.equal(service.getState().requiresAudioLanguageChange, true);
  assert.equal((await service.apply({ skinId: SKIN_ID })).ok, true);
  const record = manifest(service); assert.equal(record.phase, 'installed'); assert.equal(record.originalLanguage, 'english');
  assert.equal(bootAudio(fs.readFileSync(files.bootPath, 'utf8')).value, 'russian'); assert.match(fs.readFileSync(files.bootPath, 'utf8'), /"UILanguage" "ukrainian"/);
  assert.equal(service.getState().appliedId, SKIN_ID); assert.equal(service.getState().fileCount, 9); assert.equal(service.getState().busy, false);
  const restarted = files.manager(); await restarted.scan(); assert.equal(restarted.getState().status, 'installed');
  assert.equal((await restarted.disable()).ok, true); assert.equal(restarted.getState().status, 'disabled');
  assert.equal(fs.existsSync(target(files, record)), false); assert.equal(fs.existsSync(service.manifestPath), false);
  assert.equal(fs.readFileSync(files.bootPath, 'utf8'), BOOT);
  assert.equal(sha(fs.readFileSync(files.sourcePath)), originalSource);
  assert.equal(fs.readFileSync(path.join(files.gameDir, 'dota', 'gameinfo.gi'), 'utf8'), originalInfo);
  assert.ok(files.changes.some(state => state.status === 'building' && state.busy));
});

test('disable preserves a later external language and unrelated settings', async t => {
  const files = fixture(t), service = files.manager(); assert.equal((await service.apply({ skinId: SKIN_ID })).ok, true);
  const changed = replaceBootAudio(fs.readFileSync(files.bootPath, 'utf8'), 'koreana').replace('"Volume" "0.45"', '"Volume" "0.8"'); fs.writeFileSync(files.bootPath, changed);
  await service.scan(); assert.equal(service.getState().status, 'conflict'); assert.equal(service.getState().canRemove, true);
  assert.equal((await service.disable()).ok, true); assert.equal(fs.readFileSync(files.bootPath, 'utf8'), changed);
});

test('an originally missing AudioLanguage is restored as missing', async t => {
  const original = '"boot"\n{\n\t"UILanguage" "ukrainian"\n}\n', files = fixture(t, { boot: original }), service = files.manager();
  assert.equal((await service.apply({ skinId: SKIN_ID })).ok, true); assert.equal(manifest(service).originalLanguagePresent, false);
  assert.equal((await service.disable()).ok, true); assert.equal(fs.readFileSync(files.bootPath, 'utf8'), original);
});

test('a foreign slot is never overwritten and an externally replaced managed file is never deleted', async t => {
  const files = fixture(t), foreign = path.join(files.voice('russian'), 'pak02_dir.vpk'); fs.writeFileSync(foreign, 'foreign-package');
  const service = files.manager(); assert.equal((await service.apply({ skinId: SKIN_ID })).ok, true);
  const record = manifest(service); assert.equal(record.targetName, 'pak03_dir.vpk'); assert.equal(fs.readFileSync(foreign, 'utf8'), 'foreign-package');
  fs.writeFileSync(target(files, record), 'replaced-by-another-application');
  const disabled = await service.disable(); assert.equal(disabled.ok, false); assert.equal(disabled.code, 'CONFLICT');
  assert.equal(fs.readFileSync(target(files, record), 'utf8'), 'replaced-by-another-application'); assert.equal(fs.readFileSync(foreign, 'utf8'), 'foreign-package');
});

test('a racing foreign package is preserved even when its bytes are identical to the prepared package', async t => {
  const files = fixture(t); let checks = 0, foreign;
  const service = files.manager({ isGameRunning: async () => {
    if (++checks === 5) {
      const temporary = fs.readdirSync(files.voice('russian')).find(name => name.startsWith('.core-coach-skin-'));
      foreign = path.join(files.voice('russian'), 'pak02_dir.vpk'); fs.copyFileSync(path.join(files.voice('russian'), temporary), foreign);
    }
    return false;
  } });
  const result = await service.apply({ skinId: SKIN_ID }); assert.equal(result.ok, false); assert.equal(result.code, 'CONFLICT');
  assert.equal(fs.existsSync(foreign), true); assert.equal(fs.readFileSync(files.bootPath, 'utf8'), BOOT);
  const record = manifest(service); assert.equal(sha(fs.readFileSync(foreign)), record.sha256); assert.equal(record.phase, 'pending_apply');
  const restarted = files.manager(); assert.equal((await restarted.scan()).code, 'CONFLICT'); assert.equal(fs.existsSync(foreign), true);
});

test('running or unverified game status fails closed before game mutations', async t => {
  for (const running of [true, undefined]) {
    const files = fixture(t), service = files.manager({ isGameRunning: async () => running });
    const result = await service.apply({ skinId: SKIN_ID }); assert.equal(result.ok, false); assert.equal(result.code, running ? 'GAME_RUNNING' : 'PROCESS_CHECK_FAILED');
    assert.equal(fs.readFileSync(files.bootPath, 'utf8'), BOOT); assert.deepEqual(fs.readdirSync(files.voice('russian')), ['gameinfo.gi']);
  }
});

test('a game starting during commit leaves recoverable ownership metadata and startup rolls back after closure', async t => {
  for (const startAt of [5, 6]) {
    const files = fixture(t); let checks = 0;
    const service = files.manager({ isGameRunning: async () => ++checks >= startAt });
    const result = await service.apply({ skinId: SKIN_ID }); assert.equal(result.ok, false); assert.equal(result.code, 'GAME_RUNNING');
    assert.equal(manifest(service).phase, 'pending_apply'); assert.equal(fs.readFileSync(files.bootPath, 'utf8'), BOOT);
    const restarted = files.manager(); assert.equal((await restarted.scan()).ok, true);
    assert.equal(fs.existsSync(service.manifestPath), false); assert.deepEqual(fs.readdirSync(files.voice('russian')), ['gameinfo.gi']);
  }
});

test('write-ahead recovery handles crashes after installation or while disabling', async t => {
  for (const phase of ['pending_apply', 'pending_disable']) {
    const files = fixture(t), service = files.manager(); assert.equal((await service.apply({ skinId: SKIN_ID })).ok, true);
    const record = { ...manifest(service), phase }; fs.writeFileSync(service.manifestPath, JSON.stringify(record));
    const restarted = files.manager(); assert.equal((await restarted.scan()).ok, true);
    assert.equal(fs.existsSync(target(files, record)), false); assert.equal(fs.readFileSync(files.bootPath, 'utf8'), BOOT); assert.equal(fs.existsSync(service.manifestPath), false);
  }
});

test('game update detection prevents reuse of the enabled old package while allowing owned removal', async t => {
  const files = fixture(t), service = files.manager(); assert.equal((await service.apply({ skinId: SKIN_ID })).ok, true);
  const record = manifest(service), before = fs.readFileSync(target(files, record)); fs.writeFileSync(files.sourcePath, sourceData('-new-build'));
  await service.scan(); assert.equal(service.getState().status, 'needs_update'); assert.equal(service.getState().canApply, false); assert.equal(service.getState().canRemove, true);
  const result = await service.apply({ skinId: SKIN_ID }); assert.equal(result.ok, false); assert.equal(result.code, 'SOURCE_CHANGED'); assert.deepEqual(fs.readFileSync(target(files, record)), before);
  assert.equal((await service.disable()).ok, true); assert.equal(fs.readFileSync(files.bootPath, 'utf8'), BOOT);
});

test('manifest traversal is rejected without following or deleting its target', async t => {
  const files = fixture(t), service = files.manager(); assert.equal((await service.apply({ skinId: SKIN_ID })).ok, true);
  const record = manifest(service), foreign = path.join(files.root, 'keep.vpk'); fs.writeFileSync(foreign, 'leave-this-file');
  fs.writeFileSync(service.manifestPath, JSON.stringify({ ...record, targetName: '../../keep.vpk' }));
  const result = await service.disable(); assert.equal(result.ok, false); assert.equal(result.code, 'CONFLICT'); assert.equal(fs.readFileSync(foreign, 'utf8'), 'leave-this-file');
  assert.equal(fs.existsSync(target(files, record)), true);
});

test('linked folders are rejected and runtime cannot be located inside the game', async t => {
  const files = fixture(t), external = path.join(files.root, 'external'), voice = files.voice('russian'); fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'gameinfo.gi'), 'external-layer');
  fs.unlinkSync(path.join(voice, 'gameinfo.gi')); fs.rmdirSync(voice);
  try { fs.symlinkSync(external, voice, process.platform === 'win32' ? 'junction' : 'dir'); } catch (failure) { if (failure.code === 'EPERM') return t.skip('Creating filesystem links is unavailable.'); throw failure; }
  const service = files.manager(), result = await service.apply({ skinId: SKIN_ID }); assert.equal(result.ok, false); assert.equal(result.code, 'UNSAFE_PATH'); assert.deepEqual(fs.readdirSync(external), ['gameinfo.gi']);
  const invalid = files.manager({ runtimeDir: path.join(files.gameDir, 'runtime') }); assert.equal((await invalid.scan()).ok, false); assert.equal(invalid.getState().status, 'conflict');
});

test('missing model data fails before changing boot settings or adding a game package', async t => {
  const files = fixture(t); fs.writeFileSync(files.sourcePath, createVpk(new Map([['unrelated/file.txt', Buffer.from('test')]])));
  const service = files.manager(), result = await service.apply({ skinId: SKIN_ID }); assert.equal(result.ok, false); assert.equal(result.code, 'VPK_NOT_FOUND');
  assert.equal(fs.readFileSync(files.bootPath, 'utf8'), BOOT); assert.deepEqual(fs.readdirSync(files.voice('russian')), ['gameinfo.gi']);
});

test('other boot settings changed during preparation survive application and rollback', async t => {
  const files = fixture(t); let checks = 0;
  const service = files.manager({ isGameRunning: async () => { if (++checks === 3) fs.writeFileSync(files.bootPath, BOOT.replace('"Volume" "0.45"', '"Volume" "0.9"')); return false; } });
  assert.equal((await service.apply({ skinId: SKIN_ID })).ok, true); assert.equal((await service.disable()).ok, true);
  assert.equal(fs.readFileSync(files.bootPath, 'utf8'), BOOT.replace('"Volume" "0.45"', '"Volume" "0.9"'));
});

test('concurrent operations are rejected and stop cancels a pending operation before mutation', async t => {
  const files = fixture(t); let resume; const gate = new Promise(resolve => { resume = resolve; });
  const service = files.manager({ isGameRunning: async () => { await gate; return false; } });
  const applying = service.apply({ skinId: SKIN_ID }); assert.equal((await service.apply({ skinId: SKIN_ID })).code, 'BUSY');
  const stopping = service.stop(); resume(); await stopping;
  assert.equal((await applying).code, 'STOPPED'); assert.equal(fs.readFileSync(files.bootPath, 'utf8'), BOOT); assert.deepEqual(fs.readdirSync(files.voice('russian')), ['gameinfo.gi']);
});
