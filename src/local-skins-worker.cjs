'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isMainThread, parentPort, workerData } = require('node:worker_threads');
const { openVpk, readResource, createVpk } = require('./valve-vpk.cjs');
const SKIN_ID = 'drow_dread_retribution';
const RESOURCE_MAP = Object.freeze(Object.fromEntries([
  ['drow_base', 'drow_arcana'], ['drow_bracer', 'drow_arcana_arms'],
  ['drow_cape', 'drow_arcana_back'], ['drow_weapon', 'drow_arcana_weapon'],
  ['drow_legs', 'drow_arcana_legs'], ['drow_quiver', 'drow_arcana_quiver'],
  ['drow_armor', 'drow_arcana_shoulder'], ['drow_haircowl', 'drow_arcana_head'],
  ['drow_crossbow', 'drow_arcana_weapon'],
].map(([target, source]) => [`models/heroes/drow/${target}.vmdl_c`, `models/items/drow/drow_arcana/${source}.vmdl_c`])));
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
function noLinks(filename) {
  let current = path.resolve(filename);
  for (;;) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw Object.assign(new Error('Ссылки в путях локальной замены не поддерживаются.'), { code: 'UNSAFE_PATH' });
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
function sourceFingerprint(filename) {
  noLinks(filename); const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw Object.assign(new Error('Не удалось проверить каталог ресурсов Dota 2.'), { code: 'SOURCE_INVALID' });
  return { size: stat.size, mtimeMs: stat.mtimeMs, sha256: digest(fs.readFileSync(filename)) };
}
function buildPackage(options = {}) {
  if (options.skinId !== SKIN_ID || !path.isAbsolute(options.runtimeDir || '') || !path.isAbsolute(options.sourcePath || '')) throw Object.assign(new Error('Неизвестная локальная замена.'), { code: 'INVALID_SKIN' });
  const stagingDir = path.resolve(options.runtimeDir, 'local-skins', 'staging'); noLinks(stagingDir);
  const before = sourceFingerprint(options.sourcePath), index = openVpk(options.sourcePath), resources = new Map(), read = new Map();
  for (const [target, source] of Object.entries(RESOURCE_MAP)) {
    if (!read.has(source)) read.set(source, readResource(index, source));
    resources.set(target, read.get(source));
  }
  const after = sourceFingerprint(options.sourcePath);
  if (before.sha256 !== after.sha256 || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Object.assign(new Error('Dota 2 обновилась во время подготовки. Повтори проверку.'), { code: 'SOURCE_CHANGED' });
  const data = createVpk(resources), sha256 = digest(data);
  fs.mkdirSync(stagingDir, { recursive: true }); noLinks(stagingDir);
  const filename = path.join(stagingDir, `${crypto.randomUUID()}.vpk`), temporary = `${filename}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx');
  try { fs.writeFileSync(descriptor, data); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, filename);
  return { skinId: SKIN_ID, stagedPath: filename, fileCount: resources.size, bytes: data.length, sha256, sourceFingerprint: after };
}
if (!isMainThread) {
  try { parentPort.postMessage({ ok: true, result: buildPackage(workerData) }); }
  catch (error) { parentPort.postMessage({ ok: false, code: error.code || 'BUILD_FAILED', message: 'Не удалось подготовить модели из установленной Dota 2.' }); }
  finally { parentPort.close(); }
}
module.exports = { SKIN_ID, RESOURCE_MAP, buildPackage };
