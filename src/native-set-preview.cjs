'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn: defaultSpawn } = require('node:child_process');
const { defaultGameRunning } = require('./local-skins.cjs');

const SET_ID = 'sepulchral_stalker';
const SET_METADATA = Object.freeze({
  setId: SET_ID, name: 'Sepulchral Stalker', heroId: 6, heroName: 'Drow Ranger',
  bundleId: 34595, baseItemId: 19090,
  pieces: Object.freeze([
    { itemId: 34588, slot: 'arms', name: 'Arms' },
    { itemId: 34589, slot: 'back', name: 'Back' },
    { itemId: 34590, slot: 'head', name: 'Head' },
    { itemId: 34591, slot: 'legs', name: 'Legs' },
    { itemId: 34592, slot: 'misc', name: 'Misc' },
    { itemId: 34593, slot: 'shoulder', name: 'Shoulder' },
    { itemId: 34594, slot: 'weapon', name: 'Weapon' }
  ].map(Object.freeze)),
  mode: 'native_test_page', inventoryModified: false
});
const getNativeSetMetadata = () => JSON.parse(JSON.stringify(SET_METADATA));
const failure = (code, message) => Object.assign(new Error(message), { code });

async function noLinks(filename) {
  for (let current = path.resolve(filename);;) {
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw failure('UNSAFE_PATH', 'Ссылки в пути игры не поддерживаются. Укажи обычную папку Dota 2.');
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function fileSnapshot(filename, maximum = Infinity) {
  await noLinks(filename);
  const stat = await fs.stat(filename), exact = await fs.stat(filename, { bigint: true });
  if (!stat.isFile() || stat.size < 1 || stat.size > maximum) throw failure('INSTALL_INVALID', 'Файлы Dota 2 отсутствуют или повреждены. Проверь папку игры.');
  return { filename, size: stat.size, mtimeMs: stat.mtimeMs, dev: String(exact.dev), ino: String(exact.ino) };
}

async function readHeader(filename, length, offset = 0) {
  const handle = await fs.open(filename, 'r');
  try {
    const buffer = Buffer.alloc(length), { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead !== length) throw failure('INSTALL_INVALID', 'Не удалось проверить файлы Dota 2.');
    return buffer;
  } finally { await handle.close(); }
}

async function validateInstall(gameDir) {
  if (typeof gameDir !== 'string' || !path.isAbsolute(gameDir) || gameDir.includes('\0') || /^[/\\]{2}/.test(gameDir)) throw failure('INSTALL_INVALID', 'Укажи абсолютный путь к папке game установленной Dota 2.');
  const directory = path.resolve(gameDir);
  if (path.basename(directory).toLowerCase() !== 'game') throw failure('INSTALL_INVALID', 'Нужна папка game установленной Dota 2.');
  await noLinks(directory);
  const executable = path.join(directory, 'bin', 'win64', 'dota2.exe');
  const source = path.join(directory, 'dota', 'pak01_dir.vpk');
  const info = path.join(directory, 'dota', 'gameinfo.gi');
  const records = await Promise.all([fileSnapshot(executable), fileSnapshot(source), fileSnapshot(info, 1024 * 1024)]);
  const dos = await readHeader(executable, 64);
  const peOffset = dos.readUInt32LE(0x3c);
  if (dos.readUInt16LE(0) !== 0x5a4d || peOffset < 64 || peOffset > 1024 * 1024 || peOffset + 26 > records[0].size) throw failure('INSTALL_INVALID', 'Не удалось проверить 64-битный исполняемый файл Dota 2.');
  const pe = await readHeader(executable, 26, peOffset);
  if (pe.readUInt32LE(0) !== 0x00004550 || pe.readUInt16LE(4) !== 0x8664 || pe.readUInt16LE(24) !== 0x20b) throw failure('INSTALL_INVALID', 'Нужна установленная 64-битная версия Dota 2.');
  const vpk = await readHeader(source, 12), version = vpk.readUInt32LE(4), treeSize = vpk.readUInt32LE(8), headerSize = version === 2 ? 28 : 12;
  if (vpk.readUInt32LE(0) !== 0x55aa1234 || ![1, 2].includes(version) || treeSize < 1 || treeSize > 64 * 1024 * 1024 || headerSize + treeSize > records[1].size) throw failure('INSTALL_INVALID', 'Не удалось проверить основной архив Dota 2.');
  const text = await fs.readFile(info, 'utf8');
  if (!/\bGameInfo\b/i.test(text) || !/\bGameData\s+"?dota\.fgd"?/i.test(text)) throw failure('INSTALL_INVALID', 'В выбранной папке не найдены настройки Dota 2.');
  return { gameDir: directory, executable, records };
}

class NativeSetPreview {
  constructor(options = {}) {
    this.isGameRunning = options.isGameRunning || defaultGameRunning;
    this.spawn = options.spawn || defaultSpawn;
    this.busy = false;
  }
  getMetadata() { return getNativeSetMetadata(); }
  async requireClosed() {
    let running;
    try { running = await this.isGameRunning(); }
    catch { throw failure('PROCESS_CHECK_FAILED', 'Не удалось проверить, закрыта ли Dota 2. Попробуй ещё раз.'); }
    if (typeof running !== 'boolean') throw failure('PROCESS_CHECK_FAILED', 'Не удалось проверить, закрыта ли Dota 2. Попробуй ещё раз.');
    if (running) throw failure('GAME_RUNNING', 'Закрой Dota 2, чтобы открыть тестовую страницу комплекта.');
  }
  async launch(options = {}) {
    if (this.busy) return { ok: false, code: 'BUSY', error: 'Запуск тестовой страницы уже выполняется.', message: 'Запуск тестовой страницы уже выполняется.' };
    this.busy = true;
    try {
      if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['gameDir', 'setId', 'insecure'].includes(key)) || options.setId !== SET_ID || options.insecure !== undefined && typeof options.insecure !== 'boolean') throw failure('INVALID_OPTIONS', 'Для прототипа доступен только комплект Sepulchral Stalker.');
      await this.requireClosed();
      const install = await validateInstall(options.gameDir);
      await this.requireClosed();
      for (const record of install.records) {
        const current = await fileSnapshot(record.filename);
        if (current.dev !== record.dev || current.ino !== record.ino || current.size !== record.size || current.mtimeMs !== record.mtimeMs) throw failure('INSTALL_CHANGED', 'Файлы игры изменились во время проверки. Повтори запуск.');
      }
      const args = ['-novid'];
      if (options.insecure === true) args.push('-insecure');
      args.push('+dota_show_test_item_set_page', SET_ID);
      const pid = await new Promise((resolve, reject) => {
        let child, settled = false;
        const rejectOnce = () => { if (!settled) { settled = true; reject(failure('LAUNCH_FAILED', 'Не удалось запустить тестовую страницу Dota 2.')); } };
        try { child = this.spawn(install.executable, args, { cwd: path.dirname(install.executable), detached: true, windowsHide: true, stdio: 'ignore', shell: false }); }
        catch { rejectOnce(); return; }
        if (!child || typeof child.once !== 'function') { rejectOnce(); return; }
        child.once('error', rejectOnce);
        child.once('close', rejectOnce);
        child.once('spawn', () => {
          if (settled) return;
          if (!Number.isInteger(child.pid) || child.pid < 1 || typeof child.unref !== 'function') { rejectOnce(); return; }
          try { child.unref(); } catch { rejectOnce(); return; }
          settled = true; resolve(child.pid);
        });
      });
      return { ok: true, status: 'launch_requested', pid, set: this.getMetadata(), insecure: options.insecure === true, message: 'Dota 2 запущена с командой тестовой страницы Sepulchral Stalker. Предметы в инвентарь не добавлялись.' };
    } catch (error) {
      const code = error.code && ['INVALID_OPTIONS', 'INSTALL_INVALID', 'INSTALL_CHANGED', 'UNSAFE_PATH', 'GAME_RUNNING', 'PROCESS_CHECK_FAILED', 'LAUNCH_FAILED'].includes(error.code) ? error.code : 'INSTALL_INVALID';
      const message = code === error.code ? error.message : 'Не удалось проверить папку Dota 2. Проверь путь и доступ к файлам.';
      return { ok: false, code, error: message, message };
    } finally { this.busy = false; }
  }
}

const launchNativeSetPreview = (options, dependencies) => new NativeSetPreview(dependencies).launch(options);
module.exports = { NativeSetPreview, launchNativeSetPreview, getNativeSetMetadata, SET_ID };
