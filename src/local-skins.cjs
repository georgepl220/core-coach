'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const { SKIN_ID } = require('./local-skins-worker.cjs');
const VOICE_FOLDERS = new Set(['russian', 'koreana', 'schinese']);
const MAX_MANIFEST_BYTES = 32768, MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const fileIdentity = filename => { const value = fs.statSync(filename, { bigint: true }); return { dev: String(value.dev), ino: String(value.ino) }; };
const sameIdentity = (filename, expected) => { if (!expected) return false; const actual = fileIdentity(filename); return actual.dev === expected.dev && actual.ino === expected.ino; };
const error = (code, message) => Object.assign(new Error(message), { code });
const inside = (parent, filename) => { const relative = path.relative(path.resolve(parent), path.resolve(filename)); return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
function noLinks(filename) {
  let current = path.resolve(filename);
  for (;;) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw error('UNSAFE_PATH', 'Ссылки в путях локальной замены не поддерживаются.');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
function atomicWrite(filename, text) {
  noLinks(filename); const temporary = path.join(path.dirname(filename), `.core-coach-${crypto.randomUUID()}.tmp`);
  const descriptor = fs.openSync(temporary, 'wx');
  try { fs.writeFileSync(descriptor, text); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  try { fs.renameSync(temporary, filename); } catch (failure) { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); throw failure; }
}
// Locate only direct fields in the boot block. Token offsets let us preserve
// unrelated settings, comments, formatting and later external edits.
function bootAudio(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024) throw error('BOOT_INVALID', 'Некорректные настройки языка Dota 2.');
  const tokens = [], expression = /\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|[{}]|[^\s{}"]+/g; let last = 0;
  for (const match of text.matchAll(expression)) {
    if (text.slice(last, match.index).trim()) throw error('BOOT_INVALID', 'Некорректные настройки языка Dota 2.');
    last = match.index + match[0].length;
    if (match[0].startsWith('//') || match[0].startsWith('/*')) continue;
    const raw = match[0]; let value = raw;
    if (raw.startsWith('"')) value = raw.slice(1, -1).replace(/\\(["\\])/g, '$1');
    tokens.push({ value, start: match.index, end: match.index + raw.length });
  }
  if (text.slice(last).trim()) throw error('BOOT_INVALID', 'Некорректные настройки языка Dota 2.');
  let depth = 0, start = -1, end = -1, matchCount = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (depth === 0 && String(token.value).toLowerCase() === 'boot' && tokens[index + 1]?.value === '{') { start = index + 1; matchCount++; }
    if (token.value === '{') depth++;
    else if (token.value === '}') { depth--; if (depth < 0) throw error('BOOT_INVALID', 'Некорректные настройки языка Dota 2.'); if (depth === 0 && start >= 0 && end < 0) end = index; }
  }
  if (depth || matchCount !== 1 || start < 0 || end < start) throw error('BOOT_INVALID', 'Не найден единственный блок boot в настройках Dota 2.');
  depth = 0; const found = [];
  for (let index = start + 1; index < end; index++) {
    const token = tokens[index];
    if (token.value === '{') depth++; else if (token.value === '}') depth--;
    else if (depth === 0 && String(token.value).toLowerCase() === 'audiolanguage') {
      const value = tokens[++index]; if (!value || ['{', '}'].includes(value.value) || !/^[a-z_]{1,30}$/i.test(value.value)) throw error('BOOT_INVALID', 'Некорректный язык озвучки Dota 2.');
      found.push({ key: token, token: value, value: value.value });
    }
  }
  if (found.length > 1) throw error('BOOT_INVALID', 'Язык озвучки указан несколько раз. Автоматическое изменение отключено.');
  return { present: found.length === 1, value: found[0]?.value || 'english', field: found[0] || null, close: tokens[end].start };
}
function replaceBootAudio(text, value) {
  const audio = bootAudio(text);
  if (value != null && !/^[a-z_]{1,30}$/i.test(value)) throw error('BOOT_INVALID', 'Некорректный язык озвучки Dota 2.');
  if (audio.field) {
    if (value != null) return text.slice(0, audio.field.token.start) + JSON.stringify(value) + text.slice(audio.field.token.end);
    let from = audio.field.key.start, to = audio.field.token.end;
    const lineStart = text.lastIndexOf('\n', from - 1) + 1, nextBreak = text.indexOf('\n', to), lineEnd = nextBreak < 0 ? text.length : nextBreak + 1;
    if (!text.slice(lineStart, from).trim() && !text.slice(to, lineEnd).trim()) { from = lineStart; to = lineEnd; }
    return text.slice(0, from) + text.slice(to);
  }
  return value == null ? text : text.slice(0, audio.close) + `\t"AudioLanguage"\t\t${JSON.stringify(value)}\n` + text.slice(audio.close);
}
async function fileFingerprint(filename, maximum = MAX_PACKAGE_BYTES) {
  noLinks(filename); const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.size > maximum) throw error('FILE_INVALID', 'Не удалось проверить файл локальной замены.');
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) digest.update(chunk);
  const after = fs.statSync(filename);
  if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw error('SOURCE_CHANGED', 'Файлы изменились во время проверки. Повтори попытку.');
  return { size: stat.size, mtimeMs: stat.mtimeMs, sha256: digest.digest('hex') };
}
function defaultGameRunning() {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(error('PROCESS_CHECK_FAILED', 'Не удалось проверить, закрыта ли Dota 2.'));
    execFile('tasklist.exe', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 }, (failure, stdout) => {
      if (failure) return reject(error('PROCESS_CHECK_FAILED', 'Не удалось проверить, закрыта ли Dota 2.'));
      const rows = String(stdout).trim().split(/\r?\n/).filter(Boolean);
      if (!rows.length || rows.some(row => !/^"[^"]+","\d+",/.test(row))) return reject(error('PROCESS_CHECK_FAILED', 'Не удалось проверить, закрыта ли Dota 2.'));
      resolve(rows.some(row => /^"dota2\.exe",/i.test(row)));
    });
  });
}
class LocalSkinManager {
  constructor(options = {}) {
    if (!path.isAbsolute(options.runtimeDir || '')) throw error('RUNTIME_INVALID', 'Не задан каталог локальных замен.');
    this.runtimeDir = path.resolve(options.runtimeDir); this.directory = path.join(this.runtimeDir, 'local-skins'); this.manifestPath = path.join(this.directory, 'manifest.json');
    this.installCandidates = options.installCandidates || (() => []); this.onChange = options.onChange || (() => {}); this.isGameRunning = options.isGameRunning || defaultGameRunning;
    this.operation = null; this.worker = null; this.stopped = false; this.install = null;
    this.state = { status: 'idle', busy: false, installPath: null, language: null, originalLanguage: null, requiresAudioLanguageChange: false, appliedId: null, message: 'Нажми «Проверить», чтобы найти Dota 2.', canApply: false, canRemove: false, fileCount: 0, bytes: 0 };
  }
  getState() { return { ...this.state, canApply: this.state.canApply && !this.state.busy && !this.stopped, canRemove: this.state.canRemove && !this.state.busy && !this.stopped }; }
  set(patch) { this.state = { ...this.state, ...patch }; try { this.onChange(this.getState()); } catch {} }
  active() { if (this.stopped) throw error('STOPPED', 'Операция отменена.'); }
  async guard() { this.active(); const running = await this.isGameRunning(); this.active(); if (typeof running !== 'boolean') throw error('PROCESS_CHECK_FAILED', 'Не удалось проверить, закрыта ли Dota 2.'); if (running) throw error('GAME_RUNNING', 'Закрой Dota 2 перед изменением локального облика.'); }
  async run(status, action) {
    if (this.operation) return { ok: false, code: 'BUSY', error: 'Другая операция уже выполняется.', state: this.getState() };
    this.set({ status, busy: true, message: status === 'building' ? 'Подготавливаю модели из файлов Dota 2…' : 'Проверяю локальную замену…' });
    const task = Promise.resolve().then(async () => {
      let result;
      try { this.active(); result = { ok: true, ...(await action()) }; }
      catch (failure) { this.set({ status: failure.code === 'SOURCE_CHANGED' ? 'needs_update' : failure.code === 'CONFLICT' || failure.code === 'UNSAFE_PATH' ? 'conflict' : 'error', message: failure.message || 'Операция не выполнена.', canApply: false, canRemove: false }); result = { ok: false, code: failure.code || 'LOCAL_SKIN_FAILED', error: this.state.message }; }
      finally { this.set({ busy: false }); this.operation = null; }
      return { ...result, state: this.getState() };
    });
    this.operation = task; return task;
  }
  ensurePrivate() { noLinks(this.directory); fs.mkdirSync(this.directory, { recursive: true }); noLinks(this.directory); }
  async findInstall() {
    const candidates = await this.installCandidates();
    if (!Array.isArray(candidates) || candidates.length > 100) throw error('INSTALL_INVALID', 'Не удалось определить папку Dota 2.');
    for (const candidate of candidates) {
      if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) continue;
      for (const gameDir of [path.resolve(candidate), path.resolve(candidate, 'game')]) {
        const sourcePath = path.join(gameDir, 'dota', 'pak01_dir.vpk'), bootPath = path.join(gameDir, 'dota', 'cfg', 'boot.vcfg');
        if (!fs.existsSync(sourcePath) || !fs.existsSync(bootPath)) continue;
        noLinks(sourcePath); noLinks(bootPath);
        if (inside(gameDir, this.runtimeDir) || gameDir === this.runtimeDir) throw error('UNSAFE_PATH', 'Каталог подготовки должен находиться вне папки игры.');
        return { gameDir, sourcePath, bootPath };
      }
    }
    return null;
  }
  readManifest() {
    noLinks(this.manifestPath); if (!fs.existsSync(this.manifestPath)) return null;
    if (fs.statSync(this.manifestPath).size > MAX_MANIFEST_BYTES) throw error('CONFLICT', 'Некорректная запись установленной замены.');
    let value; try { value = JSON.parse(fs.readFileSync(this.manifestPath, 'utf8')); } catch { throw error('CONFLICT', 'Некорректная запись установленной замены.'); }
    if (value.schemaVersion !== 1 || value.skinId !== SKIN_ID || !['installed', 'pending_apply', 'pending_disable'].includes(value.phase) || value.gameDir !== this.install?.gameDir || !VOICE_FOLDERS.has(value.language) || !/^pak(?:0[2-9]|1\d|2\d)_dir\.vpk$/.test(value.targetName) || !/^\.core-coach-skin-[a-f0-9-]+\.tmp$/.test(value.temporaryName || '') || !/^[a-f0-9]{64}$/.test(value.sha256 || '') || !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > MAX_PACKAGE_BYTES || value.fileCount !== 9 || !/^[a-z_]{1,30}$/i.test(value.originalLanguage || '') || typeof value.originalLanguagePresent !== 'boolean' || typeof value.languageChanged !== 'boolean' || !/^[a-f0-9]{64}$/.test(value.sourceFingerprint?.sha256 || '') || value.fileIdentity != null && (!/^\d+$/.test(value.fileIdentity.dev || '') || !/^\d+$/.test(value.fileIdentity.ino || '')) || value.phase === 'installed' && !value.fileIdentity) throw error('CONFLICT', 'Запись замены не соответствует найденной игре. Файлы не изменены.');
    return value;
  }
  writeManifest(value) { this.ensurePrivate(); atomicWrite(this.manifestPath, JSON.stringify(value, null, 2) + '\n'); }
  target(manifest) { const directory = path.join(this.install.gameDir, `dota_${manifest.language}`); noLinks(directory); return path.join(directory, manifest.targetName); }
  readBoot() { noLinks(this.install.bootPath); const text = fs.readFileSync(this.install.bootPath, 'utf8'); return { text, ...bootAudio(text) }; }
  async restoreLanguage(manifest) {
    if (!manifest.languageChanged) return;
    await this.guard(); const boot = this.readBoot();
    if (!boot.present || boot.value.toLowerCase() !== manifest.language) return; // A later user/game change wins.
    atomicWrite(this.install.bootPath, replaceBootAudio(boot.text, manifest.originalLanguagePresent ? manifest.originalLanguage : null));
  }
  async removeOwned(manifest) {
    const target = this.target(manifest); if (!fs.existsSync(target)) return;
    if (!sameIdentity(target, manifest.fileIdentity)) throw error('CONFLICT', 'Пакет заменён другим файлом. Автоматическое удаление остановлено.');
    const fingerprint = await fileFingerprint(target);
    if (fingerprint.sha256 !== manifest.sha256 || fingerprint.size !== manifest.bytes) throw error('CONFLICT', 'Файл замены изменён извне. Автоматическое удаление остановлено.');
    await this.guard(); noLinks(target);
    if (!sameIdentity(target, manifest.fileIdentity) || hash(fs.readFileSync(target)) !== manifest.sha256) throw error('CONFLICT', 'Файл замены изменён извне. Он сохранён.');
    fs.unlinkSync(target);
  }
  async reconcile(manifest) {
    if (!manifest || manifest.phase === 'installed') return manifest;
    await this.guard(); await this.removeOwned(manifest); await this.restoreLanguage(manifest);
    const temporary = path.join(path.dirname(this.target(manifest)), manifest.temporaryName); noLinks(temporary);
    if (fs.existsSync(temporary)) {
      const fingerprint = await fileFingerprint(temporary);
      if (fingerprint.sha256 !== manifest.sha256 || fingerprint.size !== manifest.bytes) throw error('CONFLICT', 'Промежуточный файл изменён или записан не полностью. Он сохранён.');
      await this.guard(); if (hash(fs.readFileSync(temporary)) !== manifest.sha256) throw error('CONFLICT', 'Промежуточный файл изменён извне.'); fs.unlinkSync(temporary);
    }
    noLinks(this.manifestPath); fs.unlinkSync(this.manifestPath); return null;
  }
  async scanCore() {
    this.ensurePrivate(); this.install = await this.findInstall();
    if (!this.install) { this.set({ status: 'not_found', installPath: null, appliedId: null, canApply: false, canRemove: false, message: 'Dota 2 не найдена в известных папках Steam.' }); return null; }
    let manifest = this.readManifest(); manifest = await this.reconcile(manifest);
    const source = await fileFingerprint(this.install.sourcePath, 64 * 1024 * 1024), boot = this.readBoot(), audio = boot.value.toLowerCase();
    const language = audio === 'english' ? 'russian' : audio;
    const realFolder = VOICE_FOLDERS.has(language) && fs.existsSync(path.join(this.install.gameDir, `dota_${language}`, 'gameinfo.gi'));
    if (realFolder) noLinks(path.join(this.install.gameDir, `dota_${language}`, 'gameinfo.gi'));
    let running; try { running = await this.isGameRunning(); } catch { throw error('PROCESS_CHECK_FAILED', 'Не удалось проверить, закрыта ли Dota 2.'); }
    if (typeof running !== 'boolean') throw error('PROCESS_CHECK_FAILED', 'Не удалось проверить, закрыта ли Dota 2.');
    const common = { installPath: this.install.gameDir, language: manifest?.language || language, originalLanguage: manifest?.originalLanguage || boot.value, requiresAudioLanguageChange: manifest?.languageChanged || audio === 'english', appliedId: manifest?.skinId || null, fileCount: manifest?.fileCount || 0, bytes: manifest?.bytes || 0 };
    if (manifest) {
      const target = this.target(manifest);
      if (!fs.existsSync(target)) { this.writeManifest({ ...manifest, phase: 'pending_disable' }); await this.reconcile({ ...manifest, phase: 'pending_disable' }); return this.scanCore(); }
      const installed = await fileFingerprint(target);
      if (!sameIdentity(target, manifest.fileIdentity) || installed.sha256 !== manifest.sha256 || installed.size !== manifest.bytes) throw error('CONFLICT', 'Установленный файл изменён извне. Он сохранён.');
      const stale = source.sha256 !== manifest.sourceFingerprint.sha256;
      const externallyChanged = audio !== manifest.language;
      this.set({ ...common, status: stale ? 'needs_update' : externallyChanged ? 'conflict' : 'installed', canApply: false, canRemove: !running, message: stale ? 'Dota 2 обновилась. Отключи старую замену перед повторной подготовкой.' : externallyChanged ? 'Язык озвучки изменён извне. Замена может быть неактивна; новый язык будет сохранён.' : running ? 'Облик установлен. Для отключения сначала закрой Dota 2.' : 'Локальный облик установлен. Его видит только твой клиент.' });
    } else this.set({ ...common, status: 'idle', canApply: realFolder && !running, canRemove: false, message: !realFolder ? 'Не найдена штатная папка нужного языка озвучки. Автоматическое подключение отключено.' : running ? 'Закрой Dota 2 перед установкой локального облика.' : 'Готово к установке. Предметы инвентаря не изменяются.' });
    return { manifest, source, boot, language, realFolder, running };
  }
  scan() { return this.run('checking', () => this.scanCore()); }
  build() {
    return new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'local-skins-worker.cjs'), { workerData: { runtimeDir: this.runtimeDir, sourcePath: this.install.sourcePath, skinId: SKIN_ID } }); this.worker = worker; let delivered = false;
      worker.once('message', message => { delivered = true; this.worker = null; message.ok ? resolve(message.result) : reject(error(message.code || 'BUILD_FAILED', message.message)); });
      worker.once('error', () => { this.worker = null; reject(error('BUILD_FAILED', 'Не удалось подготовить модели Dota 2.')); });
      worker.once('exit', code => { if (this.worker === worker) this.worker = null; if (!delivered) reject(error(this.stopped ? 'STOPPED' : 'BUILD_FAILED', this.stopped ? 'Операция отменена.' : `Подготовка моделей завершилась с ошибкой (${code}).`)); });
    });
  }
  apply(options = {}) {
    return this.run('building', async () => {
      if (options.skinId !== SKIN_ID) throw error('INVALID_SKIN', 'Неизвестный локальный облик.');
      await this.guard(); const scan = await this.scanCore();
      if (!scan || !scan.realFolder) throw error('INSTALL_INVALID', 'Не найдена штатная папка для локальной замены.');
      if (scan.manifest) { if (this.state.status === 'needs_update') throw error('SOURCE_CHANGED', 'Сначала отключи замену, собранную до обновления Dota 2.'); return {}; }
      this.set({ status: 'building', message: 'Подготавливаю девять моделей Drow Ranger…' });
      const built = await this.build(); this.active();
      const stagingDir = path.join(this.directory, 'staging');
      if (!inside(stagingDir, built.stagedPath) || path.dirname(built.stagedPath) !== stagingDir || !/^[a-f0-9-]+\.vpk$/.test(path.basename(built.stagedPath)) || built.skinId !== SKIN_ID || built.fileCount !== 9 || !/^[a-f0-9]{64}$/.test(built.sha256) || built.bytes <= 0 || built.bytes > MAX_PACKAGE_BYTES) throw error('BUILD_FAILED', 'Некорректный результат подготовки моделей.');
      const prepared = await fileFingerprint(built.stagedPath), source = await fileFingerprint(this.install.sourcePath, 64 * 1024 * 1024);
      if (prepared.sha256 !== built.sha256 || prepared.size !== built.bytes || source.sha256 !== built.sourceFingerprint.sha256 || source.sha256 !== scan.source.sha256) throw error('SOURCE_CHANGED', 'Dota 2 обновилась во время подготовки. Файлы игры не изменены.');
      await this.guard(); const boot = this.readBoot();
      if (boot.present !== scan.boot.present || boot.value !== scan.boot.value) throw error('CONFLICT', 'Язык озвучки изменился во время подготовки. Повтори проверку.');
      const directory = path.join(this.install.gameDir, `dota_${scan.language}`); noLinks(directory);
      let targetName;
      for (let slot = 2; slot <= 29; slot++) { const name = `pak${String(slot).padStart(2, '0')}_dir.vpk`; if (!fs.existsSync(path.join(directory, name)) && !fs.existsSync(path.join(directory, name.replace('_dir.vpk', '_000.vpk')))) { targetName = name; break; } }
      if (!targetName) throw error('NO_FREE_SLOT', 'Нет свободного места среди локальных пакетов 02–29. Чужие файлы не изменены.');
      const temporaryName = `.core-coach-skin-${crypto.randomUUID()}.tmp`;
      const manifest = { schemaVersion: 1, phase: 'pending_apply', skinId: SKIN_ID, gameDir: this.install.gameDir, language: scan.language, targetName, temporaryName, fileIdentity: null, originalLanguage: boot.value, originalLanguagePresent: boot.present, languageChanged: boot.value.toLowerCase() !== scan.language, sourceFingerprint: source, sha256: built.sha256, bytes: built.bytes, fileCount: 9 };
      this.writeManifest(manifest);
      const temporary = path.join(directory, temporaryName);
      try {
        await this.guard(); fs.copyFileSync(built.stagedPath, temporary, fs.constants.COPYFILE_EXCL);
        await this.guard(); noLinks(directory);
        if (hash(fs.readFileSync(this.install.sourcePath)) !== source.sha256) throw error('SOURCE_CHANGED', 'Dota 2 обновилась перед установкой.');
        // A same-directory hard link publishes a complete archive atomically
        // and fails if another application occupied the selected slot.
        manifest.fileIdentity = fileIdentity(temporary); this.writeManifest(manifest);
        try { fs.linkSync(temporary, this.target(manifest)); }
        catch (failure) { if (failure.code === 'EEXIST') throw error('CONFLICT', 'Свободное место заняла другая программа. Чужой файл сохранён.'); throw error('FILE_WRITE_FAILED', 'Не удалось атомарно подключить локальный пакет.'); }
        fs.unlinkSync(temporary);
        if (manifest.languageChanged) { await this.guard(); if (hash(fs.readFileSync(this.install.sourcePath)) !== source.sha256) throw error('SOURCE_CHANGED', 'Dota 2 обновилась перед включением замены.'); const current = this.readBoot(); if (current.present !== boot.present || current.value !== boot.value) throw error('CONFLICT', 'Язык озвучки изменён извне.'); atomicWrite(this.install.bootPath, replaceBootAudio(current.text, scan.language)); }
        this.writeManifest({ ...manifest, phase: 'installed' });
      } catch (failure) {
        try { if (fs.existsSync(temporary) && hash(fs.readFileSync(temporary)) === manifest.sha256) { await this.guard(); fs.unlinkSync(temporary); } await this.reconcile(manifest); } catch { /* Write-ahead record remains for recovery after the game is closed. */ }
        throw failure;
      }
      if (fs.existsSync(built.stagedPath) && hash(fs.readFileSync(built.stagedPath)) === built.sha256) fs.unlinkSync(built.stagedPath);
      await this.scanCore(); return {};
    });
  }
  disable() {
    return this.run('checking', async () => {
      await this.guard(); this.ensurePrivate(); this.install = await this.findInstall();
      if (!this.install) throw error('INSTALL_INVALID', 'Dota 2 не найдена. Файлы не изменены.');
      const manifest = this.readManifest();
      if (manifest) { const pending = { ...manifest, phase: 'pending_disable' }; this.writeManifest(pending); await this.reconcile(pending); }
      await this.scanCore(); this.set({ status: 'disabled', appliedId: null, message: 'Локальная замена отключена. Остальные настройки сохранены.' }); return {};
    });
  }
  async stop() { this.stopped = true; if (this.worker) { const worker = this.worker; this.worker = null; await worker.terminate(); } if (this.operation) await this.operation; this.set({ busy: false, canApply: false, canRemove: false }); }
}
module.exports = { LocalSkinManager, bootAudio, replaceBootAudio, defaultGameRunning };
