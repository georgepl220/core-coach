'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getHeroProfile } = require('./product.cjs');
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RETRY_INTERVAL_MS = 15 * 60 * 1000;
const validBuild = (value, heroId) => value?.heroId === heroId && value.role === 'carry' && value.status === 'available' && Array.isArray(value.builds) && value.builds.some(build => Array.isArray(build.sequence) && build.sequence.length);
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function activeMatch(state, now = Date.now()) {
  return Boolean(state && !state.isSpectator && Number.isFinite(state.receivedAt) && now - state.receivedAt >= -1000 && now - state.receivedAt < 15000 && ['DOTA_GAMERULES_STATE_GAME_IN_PROGRESS', 'DOTA_GAMERULES_STATE_PRE_GAME'].includes(state.gameState));
}

class BuildSourceManager {
  constructor(options) {
    this.runtimeDir = path.resolve(options.runtimeDir);
    this.dataDir = path.resolve(options.dataDir);
    this.profile = options.profile || getHeroProfile(42);
    this.now = options.now || Date.now;
    this.codec = options.secretCodec;
    this.onChange = options.onChange || (() => {});
    this.refreshStratz = options.refreshStratz || (input => require('../scripts/update-stratz.cjs').refreshStratz(input));
    this.refreshFallback = options.refreshFallback || (input => require('../scripts/update-d2pt.cjs').refreshBuilds(input));
    this.checkConnection = options.testConnection || (input => require('./stratz-client.cjs').testConnection(input));
    this.credentialsPath = path.join(this.runtimeDir, 'stratz-credentials.json');
    this.stratzPath = path.join(this.runtimeDir, this.profile.stratzBuildFile);
    this.fallbackPath = path.join(this.runtimeDir, 'opendota-' + this.profile.dataFile);
    this.token = null;
    this.inflight = null;
    this.controller = null;
    this.generation = 0;
    this.nextAttemptAt = null;
    this.details = { preferred: 'stratz', active: 'opendota', status: 'needs_token', message: 'Добавь токен STRATZ в настройках. Пока доступны резервные данные OpenDota.', lastSuccessAt: null };
    const secret = readJson(this.credentialsPath);
    if (secret && this.codec) {
      try { this.token = this.normalizeToken(this.codec.decode(secret)); }
      catch { this.details.message = 'Сохранённый токен STRATZ не удалось прочитать. Введи его заново; используются резервные данные.'; }
    }
    this.reload();
  }
  normalizeToken(value) {
    const token = typeof value === 'string' ? value.trim().replace(/^Bearer\s+/i, '') : '';
    if (token.length < 16 || token.length > 4096 || /\s|[\x00-\x1f\x7f]/.test(token)) throw new Error('Введи личный API-токен STRATZ без лишнего текста.');
    return token;
  }
  cleanError(error) {
    let message = typeof error?.message === 'string' ? error.message : 'Источник данных недоступен.';
    if (this.token) message = message.split(this.token).join('[токен скрыт]');
    return message.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [скрыт]').slice(0, 360);
  }
  reload() {
    const candidate = readJson(this.stratzPath);
    this.stratz = validBuild(candidate, this.profile.id) && (candidate.providerId === 'stratz' || /^STRATZ\b/i.test(candidate.source || '')) ? candidate : null;
    const localFallback=readJson(this.fallbackPath),bundledFallback=readJson(path.join(this.dataDir,this.profile.observedBuildFile));
    const fallback=validBuild(localFallback,this.profile.id)?localFallback:bundledFallback;
    this.fallback = validBuild(fallback, this.profile.id) ? fallback : null;
    this.details.lastSuccessAt = this.stratz?.fetchedAt || null;
    if (this.token && this.details.status === 'needs_token') {
      this.details.status = this.stratz ? 'cached' : 'configured';
      this.details.message = this.stratz ? 'Используется сохранённая выборка STRATZ.' : 'Токен сохранён. Подключение к STRATZ ещё не проверено.';
    }
    if (!this.nextAttemptAt && this.stratz?.fetchedAt) this.nextAttemptAt = Date.parse(this.stratz.fetchedAt) + REFRESH_INTERVAL_MS;
  }
  select(custom = null) {
    const personal = validBuild(custom, this.profile.id) ? custom : null;
    this.details.active = personal ? 'personal' : this.stratz ? 'stratz' : 'opendota';
    return personal || this.stratz || this.fallback || {};
  }
  getState() {
    return { ...this.details, heroId: this.profile.id, tokenConfigured: Boolean(this.token), refreshing: Boolean(this.inflight), nextRefreshAt: this.token && Number.isFinite(this.nextAttemptAt) ? new Date(this.nextAttemptAt).toISOString() : null, schemaVerified: this.stratz?.provenance?.schemaVerified === true || this.stratz?.validation?.schemaVerified === true || this.stratz?.schemaVerified === true };
  }
  notify() { this.onChange(this.getState()); }
  setToken(value) {
    const token = this.normalizeToken(value);
    if (!this.codec) throw new Error('Защищённое хранилище токена сейчас недоступно.');
    const record = this.codec.encode(token);
    fs.mkdirSync(this.runtimeDir, { recursive: true });
    const temporary = this.credentialsPath + '.tmp';
    try { fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 }); fs.renameSync(temporary, this.credentialsPath); }
    finally { if (fs.existsSync(temporary)) fs.rmSync(temporary); }
    this.generation++; this.controller?.abort(); this.token = token; this.nextAttemptAt = null;
    this.details.status = 'configured'; this.details.message = 'Токен сохранён. Проверка и загрузка выполняются вне активного матча.';
    this.notify();
  }
  clearToken() {
    this.generation++; this.controller?.abort(); this.token = null; this.nextAttemptAt = null;
    if (fs.existsSync(this.credentialsPath)) fs.rmSync(this.credentialsPath);
    this.details.status = 'needs_token'; this.details.message = this.stratz ? 'Токен удалён. Сохранённая выборка STRATZ доступна без обновления.' : 'Токен удалён. Используются резервные данные OpenDota.';
    this.notify();
  }
  async test(state) {
    if (activeMatch(state, this.now())) throw new Error('Проверь API вне активного матча.');
    if (!this.token) throw new Error('Сначала добавь личный API-токен STRATZ.');
    if (this.inflight) throw new Error('Дождись завершения обновления сборки.');
    const generation = this.generation;
    try {
      const result = await this.checkConnection({ token: this.token });
      if (generation !== this.generation) return { cancelled: true };
      if (result?.connected !== true) throw new Error('STRATZ не подтвердил подключение.');
      this.details.status = 'connected'; this.details.message = 'Подключение к STRATZ подтверждено. Сборку можно обновить.'; this.notify();
      return { ok: true, schemaVerified: result.schemaVerified === true };
    } catch (error) {
      if (generation === this.generation) { this.details.status = 'error'; this.details.message = this.cleanError(error); this.notify(); }
      throw new Error(this.cleanError(error));
    }
  }
  async tick({ state, enabled = true, custom = false, catalog } = {}) {
    if (!enabled || custom || !this.token || this.inflight || activeMatch(state, this.now()) || this.nextAttemptAt && this.now() < this.nextAttemptAt) return { skipped: true };
    return this.refresh({ state, manual: false, catalog });
  }
  async refresh({ state, manual = true, catalog } = {}) {
    if (activeMatch(state, this.now())) throw new Error('Обновляй сборки вне активного матча.');
    if (this.inflight) return this.inflight;
    const generation = this.generation, token = this.token;
    this.controller = new AbortController();
    this.details.status = 'refreshing'; this.details.message = token ? 'STRATZ: проверяю схему API и свежие carry-матчи.' : 'Токен STRATZ не задан. Обновляю резервную выборку OpenDota.';
    this.inflight = this.performRefresh({ token, manual, catalog, generation, signal: this.controller.signal });
    this.notify();
    try { return await this.inflight; }
    finally { this.inflight = null; this.controller = null; this.notify(); }
  }
  async performRefresh({ token, manual, catalog, generation, signal }) {
    let sourceError = null;
    if (token) {
      try {
        const value = await this.refreshStratz({ token, catalog, profile: this.profile, heroId: this.profile.id, destination: this.stratzPath, signal, lookbackDays: 7, maxMatches: 24 });
        if (generation !== this.generation) return { cancelled: true };
        if (!validBuild(value, this.profile.id)) throw new Error('STRATZ не вернул совместимую carry-выборку.');
        this.reload(); this.stratz = value; this.details.status = 'ready';
        this.details.lastSuccessAt = value.fetchedAt; this.details.message = 'Свежая выборка STRATZ загружена. Предметы и навыки доступны из одного источника.';
        this.nextAttemptAt = this.now() + REFRESH_INTERVAL_MS;
        return { ok: true, provider: 'stratz' };
      } catch (error) {
        if (generation !== this.generation || signal.aborted) return { cancelled: true };
        sourceError = this.cleanError(error);
        this.nextAttemptAt = this.now() + RETRY_INTERVAL_MS;
      }
    }
    if (manual) {
      try {
        const value = await this.refreshFallback({ profile: this.profile, heroId: this.profile.id, destination: this.fallbackPath, lookbackDays: 14, maxMatches: 30,signal });
        if (generation !== this.generation) return { cancelled: true };
        if (!validBuild(value, this.profile.id)) throw new Error('Нет совместимой резервной carry-выборки.');
        this.reload(); this.fallback = value;
        this.details.status = token ? 'fallback' : 'needs_token';
        this.details.message = sourceError ? `STRATZ: ${sourceError} Резерв OpenDota обновлён.` : 'Резерв OpenDota обновлён. Для основного источника добавь токен STRATZ.';
        return { ok: true, provider: this.stratz ? 'stratz_cache' : 'opendota', fallback: true };
      } catch (error) {
        if (generation !== this.generation) return { cancelled: true };
        this.details.status = 'error'; this.details.message = `${sourceError ? `STRATZ: ${sourceError} ` : ''}Кеш сохранён. ${this.cleanError(error)}`.slice(0, 480);
        return { ok: false, error: this.details.message };
      }
    }
    this.details.status = 'error'; this.details.message = `STRATZ: ${sourceError || 'Токен не задан.'} Сохранённая сборка остаётся доступной.`;
    return { ok: false, error: this.details.message };
  }
  deferForMatch(){
    if(!this.inflight)return;
    this.generation++;this.controller?.abort();this.nextAttemptAt=this.now()+60000;
    this.details.status='paused_match';this.details.message='Матч начался. Обновление отложено; используется сохранённая сборка.';this.notify();
  }
  stop() { this.generation++; this.controller?.abort(); }
}

module.exports = { BuildSourceManager, activeMatch, validBuild, REFRESH_INTERVAL_MS, RETRY_INTERVAL_MS };
