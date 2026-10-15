'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { IDS, RANK_COHORTS, normalizeRankId, latestKnownGameVersion, baselineFromPairs, adjustPairEffects, refreshStratzDraft } = require('./stratz-draft.cjs');
const INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;
const OPEN_DOTA = 'https://api.opendota.com/api';
class DraftSourceError extends Error { constructor(code, message) { super(message); this.name = 'DraftSourceError'; this.code = code; } }
const failure = (code, message) => new DraftSourceError(code, message);
const validCounts = (games, wins) => Number.isSafeInteger(games) && games >= 0 && Number.isSafeInteger(wins) && wins >= 0 && wins <= games;
function readJson(file) { try { const value = fs.readFileSync(file, 'utf8'); return Buffer.byteLength(value) <= MAX_RESPONSE_BYTES ? JSON.parse(value) : null; } catch { return null; } }
function validData(value) {
  if (!value || value.schemaVersion !== 1 || !['stratz', 'opendota'].includes(value.providerId) || !Number.isFinite(Date.parse(value.updatedAt)) || value.observedThrough != null && !Number.isFinite(Date.parse(value.observedThrough)) || value.provenance?.observedThrough != null && !Number.isFinite(Date.parse(value.provenance.observedThrough)) || !value.scope || value.scope.role != null && !/^POSITION_[1-5]$/.test(value.scope.role) || !Array.isArray(value.heroes) || !value.heroes.length || value.heroes.length > 300 || new Set(value.heroes.map(row => row?.heroId)).size !== value.heroes.length) return false;
  if (value.components != null && (!value.components || typeof value.components !== 'object' || ['baseline', 'pairs'].some(key => {
    const component = value.components[key];
    return !component || typeof component !== 'object' || !component.scope || ['observedFrom', 'observedThrough', 'observedUntilExclusive', 'periodStart', 'periodEndExclusive'].some(name => component[name] != null && !Number.isFinite(Date.parse(component[name]))) || component.observedFrom && component.observedThrough && Date.parse(component.observedFrom) > Date.parse(component.observedThrough) || component.observedUntilExclusive && component.observedThroughKind === 'exclusive_period_end' && Date.parse(component.observedUntilExclusive) !== Date.parse(component.observedThrough) || component.periodBoundsVerified === true && (!component.periodStart || !component.periodEndExclusive || Date.parse(component.periodStart) >= Date.parse(component.periodEndExclusive));
  }))) return false;
  // Older five-hero caches remain valid backups, but coverage is reported and
  // a refresh must cover the entire current catalogue before becoming active.
  return value.heroes.every(hero => Number.isInteger(hero?.heroId) && hero.heroId > 0 && hero.heroId <= 10000 && validCounts(hero.games, hero.wins) && ['matchups', 'synergies'].every(key => Array.isArray(hero[key]) && hero[key].length <= 300 && new Set(hero[key].map(row => row?.heroId)).size === hero[key].length && hero[key].every(row => Number.isInteger(row?.heroId) && row.heroId > 0 && row.heroId <= 10000 && row.heroId !== hero.heroId && validCounts(row.games, row.wins) && (row.advantage == null || typeof row.advantage === 'number' && Number.isFinite(row.advantage) && Math.abs(row.advantage) <= 1)))) && value.heroes.some(hero => hero.games > 0 || hero.matchups.length > 0);
}
function completeData(value, heroIds = IDS) { return validData(value) && heroIds.every(id => value.heroes.some(hero => hero.heroId === id)); }
function atomicWrite(destination, value) {
  if (!validData(value)) throw failure('INVALID_RESPONSE', 'Источник не вернул совместимую статистику героев.');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = destination + '.tmp';
  try {
    const compact = JSON.stringify(value);
    if (Buffer.byteLength(compact) > MAX_RESPONSE_BYTES) throw failure('RESPONSE_TOO_LARGE', 'Кеш статистики превышает допустимый размер.');
    fs.writeFileSync(temporary, compact.length > 500000 ? compact + '\n' : JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(temporary, destination);
  }
  finally { if (fs.existsSync(temporary)) fs.rmSync(temporary); }
}
async function getJson(url, options = {}) {
  let response;
  const maximumBytes = Math.min(12 * 1024 * 1024, options.maxResponseBytes || MAX_RESPONSE_BYTES);
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(Math.min(20000, options.timeoutMs || 12000))]) : AbortSignal.timeout(Math.min(20000, options.timeoutMs || 12000));
  try { response = await (options.fetch || fetch)(url, { signal, redirect: 'error', headers: { Accept: 'application/json', 'User-Agent': 'CoreCoach/1.0' } }); }
  catch { throw failure('NETWORK', 'OpenDota: запрос не завершён. Сохранённый кеш доступен.'); }
  if (!response.ok) throw failure(response.status === 429 ? 'RATE_LIMIT' : 'HTTP_ERROR', response.status === 429 ? 'OpenDota: лимит API. Следующее обновление отложено.' : 'OpenDota: ошибка API. Сохранённый кеш доступен.');
  if (Number(response.headers?.get?.('content-length')) > maximumBytes) throw failure('RESPONSE_TOO_LARGE', 'OpenDota: слишком большой ответ.');
  try {
    if (typeof response.text === 'function') { const raw = await response.text(); if (Buffer.byteLength(raw) > maximumBytes) throw new Error('size'); return JSON.parse(raw); }
    const value = await response.json(); if (Buffer.byteLength(JSON.stringify(value)) > maximumBytes) throw new Error('size'); return value;
  } catch { throw failure('INVALID_RESPONSE', 'OpenDota: некорректный ответ API. Сохранённый кеш доступен.'); }
}
const EXPLORER_IMPLEMENTATION = 'https://github.com/odota/core/blob/master/svc/api/spec.ts';
function draftMatrixSql(windowDays = 365) {
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 365) throw failure('INVALID_REQUEST', 'Некорректный период статистики.');
  // One public, read-only aggregation replaces 127 individual requests. It
  // uses the same corpus and time condition as the documented matchup route,
  // and also obtains real ally pairs from that identical set of matches.
  return `WITH recent AS (SELECT pm.match_id,pm.hero_id,pm.player_slot,m.radiant_win,m.start_time FROM matches m JOIN player_matches pm USING(match_id) WHERE m.start_time > extract(epoch from now())-${windowDays}*86400 AND pm.hero_id>0) SELECT a.hero_id AS a,b.hero_id AS b,((a.player_slot<128)=(b.player_slot<128)) AS s,count(*) AS g,sum(CASE WHEN (a.player_slot<128)=a.radiant_win THEN 1 ELSE 0 END) AS w,max(a.start_time) AS t FROM recent a JOIN recent b ON a.match_id=b.match_id AND a.hero_id<>b.hero_id GROUP BY a.hero_id,b.hero_id,((a.player_slot<128)=(b.player_slot<128))`;
}
function normalizeExplorerMatrix(value, heroIds) {
  if (!value || value.err || !Array.isArray(value.rows) || !value.rows.length || value.rows.length > 2 * 300 * 299) throw failure('INVALID_RESPONSE', 'OpenDota: некорректная таблица пар героев.');
  const records = new Map(heroIds.map(heroId => [heroId, { heroId, matchups: [], synergies: [] }])), seen = new Set();
  const numeric = number => typeof number === 'number' ? number : typeof number === 'string' && /^\d+$/.test(number) ? Number(number) : NaN;
  for (const raw of value.rows) {
    const heroId = numeric(raw?.a), other = numeric(raw?.b), games = numeric(raw?.g), wins = numeric(raw?.w);
    const key = `${heroId}:${other}:${raw?.s}`;
    if (!records.has(heroId) || !heroIds.includes(other) || heroId === other || typeof raw?.s !== 'boolean' || !validCounts(games, wins) || seen.has(key)) throw failure('INVALID_RESPONSE', 'OpenDota: некорректная таблица пар героев.');
    seen.add(key); records.get(heroId)[raw.s ? 'synergies' : 'matchups'].push({ heroId: other, games, wins });
  }
  return heroIds.map(heroId => {
    const row = records.get(heroId);
    row.matchups.sort((a, b) => a.heroId - b.heroId); row.synergies.sort((a, b) => a.heroId - b.heroId);
    return { ...row, ...baselineFromPairs(row.matchups, heroId, heroIds, { completeUnpaginatedEndpoint: true }) };
  });
}
function draftPositionMatrixSql(windowDays = 90) {
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 365) throw failure('INVALID_REQUEST', 'Некорректный период статистики.');
  // OpenDota lane_role means safe/mid/off lane, not player position. Position
  // below is explicitly an estimate from lane and early farm within a team.
  // Minute 10-12 averages avoid calling a late-game support with high GPM core.
  // Missing parsed arrays or an incomplete team exclude that team's candidates.
  return `WITH recent AS (SELECT pm.match_id,pm.hero_id,pm.player_slot,pm.lane_role,m.radiant_win,(pm.gold_t[11]+pm.gold_t[12]+pm.gold_t[13])/3.0 AS early_gold,(pm.lh_t[11]+pm.lh_t[12]+pm.lh_t[13])/3.0 AS early_lh FROM matches m JOIN player_matches pm USING(match_id) WHERE m.start_time > extract(epoch from now())-${windowDays}*86400 AND pm.hero_id>0), ranked AS (SELECT *,row_number() OVER(PARTITION BY match_id,(player_slot<128) ORDER BY early_gold DESC NULLS LAST,early_lh DESC NULLS LAST,player_slot) AS farm_rank,count(*) OVER(PARTITION BY match_id,(player_slot<128)) AS team_count,count(early_gold) OVER(PARTITION BY match_id,(player_slot<128)) AS parsed_count FROM recent), positioned AS (SELECT *,CASE WHEN team_count=5 AND parsed_count=5 AND early_lh IS NOT NULL THEN CASE WHEN farm_rank<=3 AND lane_role IN(1,2,3) THEN lane_role WHEN farm_rank>3 AND lane_role=1 THEN 5 WHEN farm_rank>3 AND lane_role IN(2,3) THEN 4 ELSE NULL END ELSE NULL END AS p FROM ranked) SELECT a.hero_id AS a,b.hero_id AS b,a.p,((a.player_slot<128)=(b.player_slot<128)) AS s,count(*) AS g,sum(CASE WHEN (a.player_slot<128)=a.radiant_win THEN 1 ELSE 0 END) AS w FROM positioned a JOIN recent b ON a.match_id=b.match_id AND a.hero_id<>b.hero_id WHERE a.p IS NOT NULL GROUP BY a.hero_id,b.hero_id,a.p,((a.player_slot<128)=(b.player_slot<128))`;
}
function normalizePositionMatrices(value, heroIds, options = {}) {
  if (!value || value.err || !Array.isArray(value.rows) || !value.rows.length || value.rows.some(row => !Number.isInteger(row?.p) || row.p < 1 || row.p > 5)) throw failure('INVALID_RESPONSE', 'OpenDota: некорректная таблица позиций.');
  return [1, 2, 3, 4, 5].map(positionId => {
    const rows = value.rows.filter(row => row.p === positionId);
    const heroes = rows.length ? normalizeExplorerMatrix({ rows }, heroIds) : heroIds.map(heroId => ({ heroId, games: 0, wins: 0, baselineAvailable: false, matchups: [], synergies: [] }));
    return {
      schemaVersion: 1, providerId: 'opendota', updatedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
      scope: { patch: null, rank: null, role: `POSITION_${positionId}` },
      scopeDescription: `OpenDota: позиция ${positionId} оценена по линии и раннему фарму; пары за 90 дней, без фильтра патча и ранга`,
      positionEstimated: true, positionMethod: 'lane_role_and_early_team_farm_rank', catalogHeroIds: heroIds,
      provenance: { sourceUrl: 'https://docs.opendota.com/', implementationUrl: EXPLORER_IMPLEMENTATION, positionImplementationUrl: 'https://github.com/odota/core/blob/master/svc/util/compute.ts', schemaVerified: false, roleFiltered: false, positionEstimated: true, positionMethod: 'lane_role_and_early_team_farm_rank', patchFiltered: false, rankFiltered: false, matchupWindow: 'past_90_days', corpus: 'opendota_match_database', completeQuery: true, paginated: false, opponentSlotsPerMatch: 5, zeroObservationRowsOmitted: true, baselineKind: 'complete_opponent_pairs_divided_by_five', synergyAvailable: true, advantageMethod: 'raw_pair_winrate', calls: 1, bulkQuery: true },
      heroes,
    };
  });
}
async function refreshOpenDotaPositionDraft(options = {}) {
  const heroIds = Array.isArray(options.heroIds) && options.heroIds.length ? [...options.heroIds] : [...IDS];
  if (heroIds.length > 300 || new Set(heroIds).size !== heroIds.length || heroIds.some(id => !Number.isInteger(id) || id <= 0 || id > 10000)) throw failure('INVALID_REQUEST', 'Некорректный каталог героев.');
  const value = await getJson(`${OPEN_DOTA}/explorer?sql=${encodeURIComponent(draftPositionMatrixSql())}`, { ...options, timeoutMs: 20000, maxResponseBytes: 12 * 1024 * 1024 });
  return normalizePositionMatrices(value, heroIds, options);
}
async function refreshOpenDotaDraft(options = {}) {
  // heroStats provides current hero identities, not the matchup baseline: its
  // recent-public totals have a different corpus from the one-year pair table.
  const meta = await getJson(`${OPEN_DOTA}/heroStats`, options);
  const candidates = Array.isArray(options.heroIds) && options.heroIds.length ? [...options.heroIds] : [...IDS];
  if (!Array.isArray(meta) || meta.length < 5 || meta.length > 300 || new Set(meta.map(row => row?.id)).size !== meta.length || meta.some(row => !Number.isInteger(row?.id) || row.id <= 0 || row.id > 10000) || new Set(candidates).size !== candidates.length || candidates.some(id => !meta.some(row => row.id === id))) throw failure('INVALID_RESPONSE', 'OpenDota: неполный каталог героев.');
  const heroIds = meta.map(row => row.id), heroes = [];
  if (!options.individualEndpoints) {
    const matrix = await getJson(`${OPEN_DOTA}/explorer?sql=${encodeURIComponent(draftMatrixSql())}`, { ...options, timeoutMs: 20000 });
    const adjusted = adjustPairEffects(normalizeExplorerMatrix(matrix, heroIds));
    const latestMatch = matrix.rows.reduce((latest, row) => { const epoch = Number(row?.t); return Number.isSafeInteger(epoch) && epoch >= 1000000000 && epoch <= (options.now?.() ?? Date.now()) / 1000 ? Math.max(latest, epoch) : latest; }, 0);
    const observedThrough = latestMatch ? new Date(latestMatch * 1000).toISOString() : null;
    return {
      schemaVersion: 1, providerId: 'opendota', updatedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
      scope: { patch: null, rank: null, role: null },
      scopeDescription: 'OpenDota: пары союзников и соперников за год; без фильтра по патчу, рангу и роли',
      catalogHeroIds: candidates,
      observedThrough,
      provenance: { sourceUrl: 'https://docs.opendota.com/', implementationUrl: EXPLORER_IMPLEMENTATION, schemaVerified: false, roleFiltered: false, patchFiltered: false, rankFiltered: false, matchupWindow: 'past_year', corpus: 'opendota_match_database', completeQuery: true, paginated: false, opponentSlotsPerMatch: 5, zeroObservationRowsOmitted: true, baselineKind: 'complete_opponent_pairs_divided_by_five', synergyAvailable: true, calls: 2, bulkQuery: true, ...adjusted.provenance, observedThrough, observedThroughKind: observedThrough ? 'latest_match_start' : null },
      heroes: adjusted.heroes.filter(hero => candidates.includes(hero.heroId)),
    };
  }
  // Optional compatibility mode is sequential and never bursts anonymous API.
  for (const heroId of candidates) {
    if (options.signal?.aborted) throw failure('CANCELLED', 'Обновление отменено.');
    const rows = await getJson(`${OPEN_DOTA}/heroes/${heroId}/matchups`, options);
    if (!Array.isArray(rows) || !rows.length || rows.length > 300 || new Set(rows.map(row => row?.hero_id)).size !== rows.length || rows.some(row => !Number.isInteger(row?.hero_id) || row.hero_id === heroId || !heroIds.includes(row.hero_id) || !validCounts(row.games_played, row.wins))) throw failure('INVALID_RESPONSE', 'OpenDota: некорректная таблица матчапов.');
    const matchups = rows.map(row => ({ heroId: row.hero_id, games: row.games_played, wins: row.wins }));
    const baseline = baselineFromPairs(matchups, heroId, heroIds, { completeUnpaginatedEndpoint: true });
    heroes.push({ heroId, ...baseline, matchups, synergies: [] });
  }
  const adjusted = adjustPairEffects(heroes);
  return {
    schemaVersion: 1, providerId: 'opendota', updatedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
    scope: { patch: null, rank: null, role: null },
    scopeDescription: 'Общие матчапы OpenDota за год; без фильтра по патчу, рангу и роли',
    catalogHeroIds: candidates,
    provenance: { sourceUrl: 'https://docs.opendota.com/', implementationUrl: EXPLORER_IMPLEMENTATION, schemaVerified: false, roleFiltered: false, patchFiltered: false, rankFiltered: false, matchupWindow: 'past_year', completeQuery: true, paginated: false, opponentSlotsPerMatch: 5, zeroObservationRowsOmitted: true, baselineKind: 'complete_opponent_pairs_divided_by_five', synergyAvailable: false, calls: candidates.length + 1, ...adjusted.provenance },
    heroes: adjusted.heroes,
  };
}

function createDraftSources(options = {}) {
  const dataDir = path.resolve(options.dataDir), runtimeDir = path.resolve(options.runtimeDir);
  const destination = path.join(runtimeDir, 'draft-statistics.json');
  const now = options.now || Date.now, getToken = options.getToken || (() => null), onUpdate = options.onUpdate || (() => {});
  const catalog = readJson(path.join(dataDir, 'wraith-king.json'))?.heroes;
  const heroIds = [...new Set(Object.values(catalog || {}).map(hero => Number(hero?.id)).filter(id => Number.isInteger(id) && id > 0))];
  if (!heroIds.length) heroIds.push(...IDS);
  const candidates = [], positionCandidates = new Map();
  let catalogVersion = null;
  const cohortId = value => value?.scope?.rank || 'all';
  const cacheSuffix = rankId => rankId === 'all' ? '' : `-rank-${rankId.toLowerCase()}`;
  const cacheName = value => `draft-statistics-${value.providerId}${value.scope.role ? `-position-${value.scope.role.slice(-1)}` : ''}${cacheSuffix(cohortId(value))}.json`;
  const methodQuality = value => value?.provenance?.advantageMethod === 'stratz_native_synergy' ? 3 : value?.provenance?.advantageMethod === 'pair_winrate_adjusted_both_hero_baselines' ? 2 : value?.provenance?.advantageMethod === 'pair_winrate_minus_same_corpus_hero_baseline' ? 0 : 1;
  const observedAt = value => {
    if (value?.components?.baseline) return value.components.baseline.observedThrough || null;
    if (value?.observedThrough || value?.provenance?.observedThrough) return value.observedThrough || value.provenance.observedThrough;
    const date = Number.isSafeInteger(value?.provenance?.roleSampleDay) ? new Date(value.provenance.roleSampleDay * 1000) : null;
    return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
  };
  const add = value => {
    if (!validData(value)) return;
    const suppliedVersion = value.provenance?.latestKnownGameVersion;
    const version = suppliedVersion?.authority === 'stratz_constants_catalogue' ? latestKnownGameVersion([{ id: suppliedVersion.id, name: suppliedVersion.name, asOfDateTime: suppliedVersion.asOfDateTime }], { now }) : null;
    if (value.providerId === 'stratz' && version && (!catalogVersion || version.asOfDateTime > catalogVersion.asOfDateTime || version.asOfDateTime === catalogVersion.asOfDateTime && version.id > catalogVersion.id)) catalogVersion = version;
    const merge = list => {
      const existing = list.findIndex(row => row.providerId === value.providerId && row.heroes.length === value.heroes.length && cohortId(row) === cohortId(value));
      if (existing >= 0) {
        if (methodQuality(value) > methodQuality(list[existing]) || methodQuality(value) === methodQuality(list[existing]) && Date.parse(value.updatedAt) > Date.parse(list[existing].updatedAt)) list[existing] = value;
      } else list.push(value);
    };
    if (value.scope.role) {
      const key = Number(value.scope.role.slice(-1)), list = positionCandidates.get(key) || [];
      merge(list); positionCandidates.set(key, list);
    } else merge(candidates);
  };
  for (const directory of [dataDir, runtimeDir]) {
    for (const name of ['draft-statistics.json', 'draft-statistics-stratz.json', 'draft-statistics-opendota.json']) add(readJson(path.join(directory, name)));
    for (const positionId of [1, 2, 3, 4, 5]) {
      for (const provider of ['stratz', 'opendota']) add(readJson(path.join(directory, `draft-statistics-${provider}-position-${positionId}.json`)));
    }
    for (const rankId of Object.keys(RANK_COHORTS)) {
      add(readJson(path.join(directory, `draft-statistics-stratz${cacheSuffix(rankId)}.json`)));
      for (const positionId of [1, 2, 3, 4, 5]) add(readJson(path.join(directory, `draft-statistics-stratz-position-${positionId}${cacheSuffix(rankId)}.json`)));
    }
  }
  const coverage = value => value ? heroIds.filter(id => value.heroes.some(hero => hero.heroId === id)).length : 0;
  const usable = value => { const age = now() - Date.parse(value.updatedAt), observed = observedAt(value), observationAge = observed ? now() - Date.parse(observed) : null; return age >= -300000 && age <= 30 * INTERVAL_MS && (value.components || observationAge === null || observationAge >= -300000 && observationAge <= 30 * INTERVAL_MS) && value.mixedScope !== true && value.provenance?.mixedScope !== true && (value.components || value.patchMatchesCurrent !== false && value.provenance?.patchMatchesCurrent !== false); };
  const cohortMatches = (value, rankId) => cohortId(value) === rankId && (!value.components || ['baseline', 'pairs'].every(key => (value.components[key].scope.rank || 'all') === rankId));
  const preferred = (list, rankId) => [...list].filter(value => usable(value) && cohortMatches(value, rankId)).sort((a, b) => coverage(b) - coverage(a) || methodQuality(b) - methodQuality(a) || Number(b.provenance?.roleFiltered === true) - Number(a.provenance?.roleFiltered === true) || Number(b.providerId === 'stratz') - Number(a.providerId === 'stratz') || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] || null;
  const positionNumber = input => { const number = Number(typeof input === 'object' ? input?.positionId : input || 1); return Number.isInteger(number) && number >= 1 && number <= 5 ? number : 1; };
  let selectedPosition = 1, selectedRank = 'all';
  const rankForInput = input => normalizeRankId(typeof input === 'object' && input?.rankId != null ? input.rankId : selectedRank);
  const getData = input => {
    const rankId = rankForInput(input);
    const positioned = preferred(positionCandidates.get(positionNumber(input)) || [], rankId), broad = preferred(candidates, rankId);
    // An old five-hero role cache must not hide the full catalogue backup.
    let value = positioned && (!broad || coverage(positioned) >= coverage(broad) && methodQuality(positioned) >= methodQuality(broad)) ? positioned : broad || positioned;
    if (positioned && broad?.providerId === 'stratz' && broad.provenance?.roleBaselineError === 'NO_COMPLETE_CURRENT_PATCH_SAMPLE') {
      const patch = positioned.components?.baseline?.scope?.patch ?? positioned.scope.patch;
      const version = catalogVersion || broad.provenance?.latestKnownGameVersion;
      // The just-released patch may have fresh pairs but no complete role day.
      // Keep those pairs and the new catalogue. An old or unknown role cache
      // must not hide the explicitly unavailable CURRENT-patch role baseline.
      if (!version || patch !== version.name && Number(patch) !== version.id) value = broad;
    }
    if (!value || value.providerId !== 'stratz' || !catalogVersion) return value;
    const components = value.components || {
      baseline: { observedThrough: observedAt(value), scope: { ...value.scope }, roleFiltered: value.provenance?.roleFiltered === true, patchFiltered: value.provenance?.patchFiltered === true, rankFiltered: value.provenance?.rankFiltered === true, schemaVerified: value.provenance?.schemaVerified === true },
      pairs: { observedThrough: value.provenance?.pairObservedThrough || null, scope: { ...value.scope, role: value.provenance?.pairRoleFiltered === true ? value.scope.role : null, patch: value.provenance?.pairPatchFiltered === true ? value.scope.patch : null }, roleFiltered: value.provenance?.pairRoleFiltered === true, patchFiltered: value.provenance?.pairPatchFiltered === true, rankFiltered: value.provenance?.rankFiltered === true, schemaVerified: value.provenance?.schemaVerified === true },
    };
    let changed = false;
    const annotated = Object.fromEntries(['baseline', 'pairs'].map(key => {
      const component = components[key], patch = component?.scope?.patch;
      // Compare known labels only. Discovering a newer catalogue version must
      // invalidate the OLD component, never invent a patch for unknown data.
      if (patch != null && patch !== catalogVersion.name && Number(patch) !== catalogVersion.id) {
        changed = true;
        return [key, { ...component, patchMatchesCurrent: false, patchMatchesLatestKnownVersion: false, latestKnownGameVersion: catalogVersion }];
      }
      return [key, component];
    }));
    return changed ? { ...value, components: annotated } : value;
  };
  let data = getData(1);
  let inflight = null, controller = null, stopped = false, generation = 0, activeRank = null, activeRequestToken = null, queued = null;
  let nextAttemptAt = data ? Math.max(now(), Date.parse(data.updatedAt) + INTERVAL_MS) : now();
  const cohortDeadlines = new Map([['all', nextAttemptAt]]);
  const cohortStates = new Map([['all', { status: data ? 'cached' : 'unavailable', message: data ? 'Статистика пика загружена из кеша.' : 'Статистика пика пока не загружена.', errorCode: null }]]);
  const setStatus = (rankId, nextStatus, nextMessage, errorCode = null) => {
    cohortStates.set(rankId, { status: nextStatus, message: nextMessage, errorCode });
  };
  const stateFor = (rankId, value) => cohortStates.get(rankId) || { status: value ? 'cached' : 'unavailable', message: value ? 'Статистика пика загружена из кеша.' : rankId === 'all' ? 'Статистика пика пока не загружена.' : 'Нет статистики выбранного рейтинга. Обнови STRATZ: общий кеш не подменяет эту выборку.', errorCode: null };
  const token = () => { try { const value = getToken(); return typeof value === 'string' && value.trim() ? value.trim().replace(/^Bearer\s+/i, '') : null; } catch { return null; } };
  // A fresh bundled backup must not defer the already configured primary.
  // This one startup attempt still advances the normal daily/retry deadline.
  if (token() && data?.providerId !== 'stratz') { nextAttemptAt = now(); cohortDeadlines.set('all', nextAttemptAt); }
  const cleanCode = error => ['DraftSourceError', 'StratzError'].includes(error?.name) && ['NETWORK', 'RATE_LIMIT', 'HTTP_ERROR', 'AUTH_FAILED', 'TOKEN_REQUIRED', 'TOKEN_INVALID', 'REQUEST_LIMIT', 'RESPONSE_TOO_LARGE', 'INVALID_RESPONSE', 'GRAPHQL_ERROR', 'SCHEMA_UNSUPPORTED', 'INCOMPLETE_SAMPLE', 'INCONSISTENT_SAMPLE', 'FILTER_UNAVAILABLE', 'CANCELLED', 'CACHE_WRITE', 'INVALID_REQUEST', 'UNAVAILABLE'].includes(error?.code) ? error.code : 'UNAVAILABLE';
  const cleanError = (error, requestSecret = null) => {
    // Never forward raw network exceptions or unknown errors, which can contain
    // a request URL/header. Only our provider error codes are user-visible.
    let value = ['DraftSourceError', 'StratzError'].includes(error?.name) ? error.message : 'Источник статистики недоступен. Сохранённый кеш доступен.';
    for (const secret of [token(), requestSecret]) if (secret) value = value.split(secret).join('[скрыт]');
    return String(value).replace(/Bearer\s+[^\s"']+/gi, 'Bearer [скрыт]').slice(0, 420);
  };
  const getState = input => {
    const positionId = positionNumber(input || selectedPosition), rankId = rankForInput(input), value = getData({ positionId, rankId });
    const observedThrough = observedAt(value);
    const component = key => {
      const supplied = value?.components?.[key];
      // Legacy position caches carry only a baseline day. It says nothing
      // about when the separate native matchup matrix was observed.
      const observation = supplied ? supplied.observedThrough || null : key === 'baseline' || !value?.provenance?.roleSampleDay && value?.provenance?.roleFiltered !== true ? observedThrough : null;
      const scope = supplied?.scope || { ...(value?.scope || { patch: null, rank: null, role: null }), ...(key === 'pairs' && value?.provenance?.pairRoleFiltered !== true ? { role: null, patch: null } : {}) };
      const age = observation ? (now() - Date.parse(observation)) / INTERVAL_MS : null;
      const unavailable = supplied?.unavailableReason, patchRejected = supplied?.patchMatchesCurrent === false || supplied?.patchMatchesLatestKnownVersion === false;
      const componentStatus = !value || unavailable ? 'missing' : patchRejected ? 'old_patch' : !observation ? 'unknown' : age < -300000 / INTERVAL_MS ? 'future' : age > 30 ? 'stale' : 'known';
      return { ...(supplied || {}), observedFrom: supplied?.observedFrom || null, observedThrough: observation || null, scope, ageDays: age, periodVerified: supplied?.periodBoundsVerified === true, periodStart: supplied?.periodStart || null, periodEndExclusive: supplied?.periodEndExclusive || null, periodPartial: supplied?.periodPartial === true, freshnessVerified: componentStatus === 'known', status: componentStatus };
    };
    const components = { baseline: component('baseline'), pairs: component('pairs') };
    const deadline = cohortDeadlines.get(rankId) ?? now();
    const baselineUnavailableReason = components.baseline.unavailableReason || (components.baseline.status === 'old_patch' ? 'OUTDATED_PATCH' : null);
    const baselineStatusMessage = baselineUnavailableReason === 'NO_COMPLETE_CURRENT_PATCH_SAMPLE' ? `Ещё нет полного дня статистики позиции для патча ${components.baseline.targetPatch || catalogVersion?.name || 'актуальной версии'}.` : baselineUnavailableReason === 'OUTDATED_PATCH' ? `Сохранённая база WR относится к патчу ${components.baseline.scope.patch}; она не используется как база актуального патча.` : null;
    let cohortState = stateFor(rankId, value);
    if (baselineStatusMessage && !['error', 'refreshing', 'queued'].includes(cohortState.status)) cohortState = { status: 'partial', message: baselineStatusMessage, errorCode: baselineUnavailableReason };
    return { preferred: 'stratz', active: value?.providerId || null, ...cohortState, baselineUnavailableReason, baselineStatusMessage, tokenConfigured: Boolean(token()), requestedRankId: rankId, refreshing: Boolean(inflight) && activeRank === rankId, anyRefreshing: Boolean(inflight), refreshingRankId: activeRank, refreshQueued: queued?.rankId === rankId, pendingRankId: queued?.rankId || null, queuedRankId: queued?.rankId || null, updatedAt: value?.updatedAt || null, observedThrough, observedThroughKind: components.baseline.observedThroughKind || value?.provenance?.observedThroughKind || (value?.provenance?.roleSampleDay ? 'completed_day' : null), observationAgeDays: observedThrough ? Math.max(0, (now() - Date.parse(observedThrough)) / INTERVAL_MS) : null, freshnessVerified: components.baseline.freshnessVerified && components.pairs.freshnessVerified, components, advantageMethod: value?.provenance?.advantageMethod || null, roleSampleStart: value?.provenance?.roleSampleStart || null, roleSampleDay: value?.provenance?.roleSampleDay || null, roleSampleDays: value?.provenance?.roleSampleDays || [], pairWeekIds: value?.provenance?.pairWeekIds || [], nextRefreshAt: Number.isFinite(deadline) ? new Date(deadline).toISOString() : null, schemaVerified: value?.provenance?.schemaVerified === true, scope: value?.scope || { patch: null, rank: rankId === 'all' ? null : rankId, role: null }, scopeDescription: value?.scopeDescription || 'Нет статистической выборки', positionId, rankId, latestKnownGameVersion: value?.provenance?.latestKnownGameVersion || null, positionEstimated: value?.provenance?.positionEstimated === true, positionMethod: value?.provenance?.positionMethod || null, coverageCount: coverage(value), totalHeroes: heroIds.length, completeCatalog: coverage(value) === heroIds.length, stale: !value || !components.baseline.freshnessVerified || !components.pairs.freshnessVerified || Math.max(components.baseline.ageDays || 0, components.pairs.ageDays || 0) >= 1 };
  };
  const notify = () => { try { onUpdate(getState()); } catch {} };
  const due = input => {
    const rankId = rankForInput(input);
    if (!cohortDeadlines.has(rankId)) {
      const existing = getData({ positionId: positionNumber(input || selectedPosition), rankId });
      cohortDeadlines.set(rankId, existing ? Date.parse(existing.updatedAt) + INTERVAL_MS : now());
    }
    return !stopped && now() >= cohortDeadlines.get(rankId);
  };
  const shouldRefresh = input => !inflight && due(input);
  const cancelQueued = reason => {
    if (!queued) return;
    const cancelled = queued; queued = null;
    if (cancelled.previousState) cohortStates.set(cancelled.rankId, cancelled.previousState);
    else cohortStates.delete(cancelled.rankId);
    cancelled.resolve({ cancelled: true, reason });
  };
  const selectContext = ({ positionId = selectedPosition, rankId = selectedRank } = {}) => {
    selectedPosition = positionNumber(positionId); selectedRank = normalizeRankId(rankId);
    if (queued && queued.rankId !== selectedRank) cancelQueued('superseded');
  };
  const runRefresh = async ({ force = false, positionId, rankId }) => {
    activeRank = rankId;
    const setDeadline = value => { nextAttemptAt = value; cohortDeadlines.set(rankId, value); };
    const currentGeneration = generation, secret = token();
    activeRequestToken = secret;
    controller = new AbortController(); const signal = controller.signal;
    let status = 'refreshing', message = secret ? 'Обновляю статистику пика через STRATZ.' : 'Обновляю резервную статистику пика OpenDota.';
    setStatus(rankId, status, message);
    inflight = (async () => {
      let primaryError = null, primaryErrorCode = null, value = null;
      if (secret) {
        try {
          value = await (options.refreshStratz || refreshStratzDraft)({ token: secret, heroIds, positionId, rankId, fetch: options.fetch, signal, now, timeoutMs: options.timeoutMs });
          if (!completeData(value, heroIds) || value.providerId !== 'stratz' || !cohortMatches(value, rankId)) throw failure('INVALID_RESPONSE', 'STRATZ: неполная статистика каталога или несовместимый рейтинг.');
        } catch (error) { primaryError = cleanError(error, secret); primaryErrorCode = cleanCode(error); }
      }
      if (stopped || signal.aborted || currentGeneration !== generation || token() !== secret) return { cancelled: true };
      if (!value || primaryError) {
        try {
          if (rankId !== 'all') throw failure(secret ? 'FILTER_UNAVAILABLE' : 'TOKEN_REQUIRED', secret ? 'Для выбранного рейтинга нужен совместимый кеш STRATZ. Общая статистика не используется вместо него.' : 'Для выбранного рейтинга добавь API-токен STRATZ в настройках. Общая статистика не используется вместо него.');
          value = await (options.refreshFallback || refreshOpenDotaDraft)({ heroIds, fetch: options.fetch, signal, now, timeoutMs: options.timeoutMs });
          if (!completeData(value, heroIds) || value.providerId !== 'opendota') throw failure('INVALID_RESPONSE', 'OpenDota: неполная статистика каталога героев.');
        } catch (error) {
          if (stopped || signal.aborted || currentGeneration !== generation || token() !== secret) return { cancelled: true };
          setDeadline(now() + RETRY_MS); status = 'error'; message = [primaryError, cleanError(error, secret)].filter(Boolean).join(' ').slice(0, 600);
          const errorCode = rankId !== 'all' && primaryErrorCode ? primaryErrorCode : cleanCode(error);
          setStatus(rankId, status, message, errorCode); notify();
          return { ok: false, code: errorCode, error: message };
        }
      }
      if (stopped || signal.aborted || currentGeneration !== generation || token() !== secret) return { cancelled: true };
      // Keep primary and fallback files independently. A failed primary never
      // overwrites its cache, even when a full-catalogue fallback is available.
      const valueFile = rankId !== 'all' || value.scope.role ? path.join(runtimeDir, cacheName(value)) : value.providerId === 'opendota' ? path.join(runtimeDir, 'draft-statistics-opendota.json') : destination;
      try { atomicWrite(valueFile, value); }
      catch { setDeadline(now() + RETRY_MS); status = 'error'; message = 'Не удалось сохранить статистику пика. Предыдущий кеш доступен.'; setStatus(rankId, status, message, 'CACHE_WRITE'); return { ok: false, code: 'CACHE_WRITE', error: message }; }
      add(value);
      const snapshot = row => { try { options.onSnapshot?.(row); } catch {} };
      snapshot(value);
      let roleError = null;
      if (Array.isArray(value.positionDatasets)) {
        try {
          const positions = value.positionDatasets;
          if (positions.length !== 5 || new Set(positions.map(row => row.scope?.role)).size !== 5 || positions.some(row => !completeData(row, heroIds) || row.providerId !== 'stratz' || row.provenance?.roleFiltered !== true || !cohortMatches(row, rankId))) throw failure('INVALID_RESPONSE', 'STRATZ: неполная статистика пяти позиций или несовместимый рейтинг.');
          for (const row of positions) {
            atomicWrite(path.join(runtimeDir, cacheName(row)), row); add(row); snapshot(row);
          }
        } catch (error) { roleError = cleanError(error, secret); }
      }
      // The five inferred role matrices arrive in one bounded SQL request.
      // They are a transparent backup when STRATZ cannot filter the selected
      // hero's position; a verified role-specific STRATZ cache stays preferred.
      if (rankId === 'all' && !value.provenance?.roleFiltered && !value.positionDatasets && value.provenance?.roleBaselineError !== 'NO_COMPLETE_CURRENT_PATCH_SAMPLE' && (!options.refreshFallback || options.refreshPositions)) {
        try {
          const positions = await (options.refreshPositions || refreshOpenDotaPositionDraft)({ heroIds, fetch: options.fetch, signal, now, timeoutMs: options.timeoutMs });
          if (!Array.isArray(positions) || positions.length !== 5 || positions.some(row => !completeData(row, heroIds) || row.providerId !== 'opendota' || row.provenance?.positionEstimated !== true)) throw failure('INVALID_RESPONSE', 'OpenDota: неполная статистика позиций.');
          if (stopped || signal.aborted || currentGeneration !== generation || token() !== secret) return { cancelled: true };
          for (const row of positions) {
            atomicWrite(path.join(runtimeDir, `draft-statistics-opendota-position-${row.scope.role.slice(-1)}.json`), row); add(row); snapshot(row);
          }
        } catch (error) { roleError = cleanError(error, secret); }
      }
      data = getData({ positionId, rankId }); setDeadline(now() + (primaryError ? RETRY_MS : INTERVAL_MS)); status = primaryError ? data?.providerId === 'stratz' ? 'cached' : 'fallback' : 'ready';
      message = primaryError ? `${primaryError} Загружен резерв OpenDota.`.slice(0, 600) : value.providerId === 'stratz' ? 'Статистика пика STRATZ обновлена.' : 'Резерв OpenDota обновлён. Для основного источника добавь токен STRATZ.';
      if (roleError) message = `${message} Оценка позиций пока недоступна; используется общий резерв.`.slice(0, 600);
      if (value.provenance?.roleBaselineError === 'NO_COMPLETE_CURRENT_PATCH_SAMPLE') {
        status = 'partial'; message = `Пары STRATZ загружены. Ещё нет полного дня статистики позиции для патча ${value.components?.baseline?.targetPatch || catalogVersion?.name || 'актуальной версии'}.`;
        setStatus(rankId, status, message, value.provenance.roleBaselineError);
        return { ok: true, provider: data?.providerId || value.providerId, partial: true, code: value.provenance.roleBaselineError, coverageCount: coverage(data), totalHeroes: heroIds.length };
      }
      if (primaryError && data?.providerId === 'stratz') { message = `${primaryError} Сохранённая статистика STRATZ остаётся активной.`.slice(0, 600); setStatus(rankId, status, message); return { ok: true, provider: 'stratz_cache', fallback: true }; }
      setStatus(rankId, status, message);
      return { ok: true, provider: data?.providerId || value.providerId, fallback: Boolean(primaryError), coverageCount: coverage(data), totalHeroes: heroIds.length };
    })();
    notify();
    try { return await inflight; }
    finally {
      inflight = null; controller = null; activeRank = null; activeRequestToken = null;
      if (cohortStates.get(rankId)?.status === 'refreshing') {
        setStatus(rankId, getData({ positionId, rankId }) ? 'cached' : 'unavailable', 'Обновление отложено. Сохранённый кеш доступен.'); setDeadline(now() + RETRY_MS);
      }
      const pending = queued; queued = null;
      if (pending) {
        const sameCredentials = pending.requestToken === token();
        if (!stopped && pending.generation === generation && selectedRank === pending.rankId && sameCredentials) pending.resolve(refresh(pending));
        else { if (pending.previousState) cohortStates.set(pending.rankId, pending.previousState); else cohortStates.delete(pending.rankId); pending.resolve({ cancelled: true, reason: sameCredentials ? 'deferred' : 'credentials_changed' }); }
      }
      notify();
    }
  };
  const refresh = (input = {}) => {
    selectContext(input);
    const request = { force: input.force === true, positionId: selectedPosition, rankId: selectedRank };
    if (stopped) return Promise.resolve({ skipped: true });
    const requestToken = token();
    // Setting a new token explicitly starts a new authorised request; it
    // cannot join work which will be cancelled because it used the old token.
    if (inflight && activeRequestToken !== requestToken && (controller?.signal.aborted !== true || queued && queued.requestToken !== requestToken)) {
      generation++; cancelQueued('credentials_changed'); controller?.abort();
    }
    if (inflight && activeRank === request.rankId && activeRequestToken === requestToken) return inflight;
    if (queued?.rankId === request.rankId) { queued.force ||= request.force; queued.positionId = request.positionId; return queued.promise; }
    if (!request.force && !due(request)) return Promise.resolve({ skipped: true });
    if (inflight) {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      queued = { ...request, promise, resolve, generation, requestToken, previousState: cohortStates.get(request.rankId) };
      setStatus(request.rankId, 'queued', 'Статистика выбранного рейтинга будет загружена после текущего запроса.'); notify();
      return promise;
    }
    return runRefresh(request);
  };
  const setContext = (input = {}) => {
    selectContext(input);
    if (input.requestRefresh === true) refresh({ positionId: selectedPosition, rankId: selectedRank }).catch(() => {});
    notify(); return getState();
  };
  return { getState, getData, shouldRefresh, refresh, setContext, stop() { stopped = true; generation++; cancelQueued('stopped'); controller?.abort(); }, deferForMatch() { generation++; cancelQueued('deferred'); controller?.abort(); nextAttemptAt = now() + RETRY_MS; cohortDeadlines.set(selectedRank, nextAttemptAt); notify(); } };
}

module.exports = { createDraftSources, refreshOpenDotaDraft, refreshOpenDotaPositionDraft, draftMatrixSql, draftPositionMatrixSql, normalizeExplorerMatrix, normalizePositionMatrices, validData, completeData, atomicWrite, DraftSourceError, INTERVAL_MS, RETRY_MS, MAX_RESPONSE_BYTES };
