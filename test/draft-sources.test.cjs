'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDraftSources, refreshOpenDotaDraft, validData, atomicWrite, DraftSourceError, INTERVAL_MS, RETRY_MS, MAX_RESPONSE_BYTES } = require('../src/draft-sources.cjs');
const { IDS: ALL_IDS, baselineFromPairs, draftContract, buildDraftQuery, refreshStratzDraft } = require('../src/stratz-draft.cjs');
const IDS = [42, 8, 18, 44, 48];
const START = Date.parse('2026-10-13T12:00:00Z');
const SECRET = 'test-only-stratz-draft-secret-no-real-token';
const CATALOG = [...IDS, 99];
const data = (providerId = 'opendota', extra = {}) => ({ schemaVersion: 1, providerId, updatedAt: new Date(START).toISOString(), scope: { patch: null, rank: null, role: null }, provenance: { schemaVerified: providerId === 'stratz' }, heroes: IDS.map(heroId => ({ heroId, games: 10, wins: 5, baselineAvailable: true, matchups: CATALOG.filter(id => id !== heroId).map(id => ({ heroId: id, games: 10, wins: 5 })), synergies: [] })), ...extra });
const response = (value, status = 200, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: key => headers[key] || null }, text: async () => JSON.stringify(value) });
function fixture(t, options = {}) {
  const parent = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'core-coach-draft-'));
  const dataDir = path.join(root, 'data'), runtimeDir = path.join(root, 'runtime'); fs.mkdirSync(dataDir); fs.mkdirSync(runtimeDir);
  fs.writeFileSync(path.join(dataDir, 'draft-statistics.json'), JSON.stringify(data()));
  fs.writeFileSync(path.join(dataDir, 'wraith-king.json'), JSON.stringify({ heroes: Object.fromEntries(IDS.map(id => [id, { id }])) }));
  t.after(() => { assert.ok(root.startsWith(parent + path.sep) && path.basename(root).startsWith('core-coach-draft-')); fs.rmSync(root, { recursive: true, force: true }); });
  const service = createDraftSources({ dataDir, runtimeDir, now: () => START, refreshPositions: async () => { throw new DraftSourceError('UNAVAILABLE', 'Fixture positions unavailable'); }, ...options });
  return { service, dataDir, runtimeDir };
}
function openFetch(extra = {}) {
  const calls = [];
  const request = async (url, init) => {
    calls.push({ url, init });
    if (extra.failAt === calls.length) return response({}, extra.status || 429);
    if (url.endsWith('/heroStats')) return response(CATALOG.map(id => ({ id, pub_pick: 999, pub_win: 1, pro_pick: 1, pro_win: 0 })));
    if (url.includes('/explorer?')) return response({ rows: CATALOG.flatMap(a => CATALOG.filter(b => b !== a).flatMap(b => [false, true].map(s => ({ a, b, s, g: 10, w: 5 })))) });
    const id = Number(url.match(/heroes\/(\d+)/)[1]);
    return response(CATALOG.filter(other => other !== id).map(other => ({ hero_id: other, games_played: 10, wins: 5 })));
  };
  return { calls, request };
}
const scalar = name => ({ kind: 'SCALAR', name });
const object = name => ({ kind: 'OBJECT', name });
const list = type => ({ kind: 'LIST', ofType: type });
const nonnull = type => ({ kind: 'NON_NULL', ofType: type });
function schema(options = {}) {
  const heroArgument = { name: 'heroId', type: scalar('Short') };
  const args = [heroArgument, { name: 'take', type: scalar('Int') }];
  if (options.position) args.push({ name: 'positionIds', type: list({ kind: 'ENUM', name: 'Position' }), description: options.positionDescription || 'Position of the selected hero' });
  if (options.requiredExtra) args.push({ name: 'unknownFilter', type: nonnull(scalar('Int')) });
  const pairFields = [{ name: 'heroId2', type: scalar('Short') }, { name: 'matchCount', type: scalar('Int') }, { name: 'winCount', type: scalar('Int') }];
  return { queryType: { name: 'Query' }, types: [
    { kind: 'OBJECT', name: 'Query', fields: [{ name: 'heroStats', type: object('Stats'), args: [] }] },
    { kind: 'OBJECT', name: 'Stats', fields: [{ name: 'matchUp', type: list(object('Matchup')), args }] },
    { kind: 'OBJECT', name: 'Matchup', fields: [{ name: 'heroId', type: scalar('Short') }, { name: 'vs', type: list(object('Pair')), args: [] }, ...(!options.noSynergy ? [{ name: 'with', type: list(object('Pair')), args: [] }] : [])] },
    { kind: 'OBJECT', name: 'Pair', fields: pairFields },
    { kind: 'ENUM', name: 'Position', enumValues: [{ name: 'POSITION_1' }] },
  ] };
}
function stratzPayload(options = {}) {
  return { heroStats: Object.fromEntries(IDS.map(heroId => [`h${heroId}`, [{ heroId, matchups: CATALOG.filter(id => id !== heroId).map(id => ({ heroId: id, games: 10, wins: 5 })), ...(!options.noSynergy ? { synergies: [{ heroId: 99, games: 10, wins: 5 }] } : {}) }]])) };
}

test('bundled daily cache is synchronous, requests only when due', async t => {
  let now = START; const mock = openFetch(); const { service } = fixture(t, { now: () => now, fetch: mock.request });
  assert.equal(service.getData().providerId, 'opendota'); assert.equal(service.shouldRefresh(), false);
  assert.equal((await service.refresh()).skipped, true); assert.equal(mock.calls.length, 0);
  now += INTERVAL_MS; assert.equal(service.shouldRefresh(), true); assert.equal((await service.refresh()).ok, true);
  assert.equal(mock.calls.length, 2); assert.equal(service.shouldRefresh(), false); assert.equal(service.getState().tokenConfigured, false);
});
test('configured STRATZ is due once at startup despite fresh fallback, then respects daily and failure backoff', async t => {
  let calls = 0;
  const { service } = fixture(t, { getToken: () => SECRET, refreshStratz: async () => { calls++; return data('stratz'); } });
  assert.equal(service.getData().providerId, 'opendota'); assert.equal(service.shouldRefresh(), true);
  assert.equal((await service.refresh()).provider, 'stratz'); assert.equal(calls, 1);
  assert.equal(service.shouldRefresh(), false); assert.equal((await service.refresh()).skipped, true); assert.equal(calls, 1);
  const failed = fixture(t, { getToken: () => SECRET, refreshStratz: async () => { throw new Error('unavailable'); }, refreshFallback: async () => { throw new Error('unavailable'); } }).service;
  assert.equal(failed.shouldRefresh(), true); assert.equal((await failed.refresh()).ok, false);
  assert.equal(failed.shouldRefresh(), false); assert.equal((await failed.refresh()).skipped, true);
  assert.equal(Date.parse(failed.getState().nextRefreshAt), START + RETRY_MS);
});
test('OpenDota uses exact one-year pair baseline, never recent public totals', async () => {
  const mock = openFetch(); const value = await refreshOpenDotaDraft({ fetch: mock.request, now: () => START, heroIds: IDS, individualEndpoints: true });
  assert.equal(value.heroes.length, 5); assert.ok(value.heroes.every(hero => hero.games === 10 && hero.wins === 5));
  assert.equal(value.scope.patch, null); assert.equal(value.scope.rank, null); assert.equal(value.scope.role, null);
  assert.equal(value.provenance.matchupWindow, 'past_year'); assert.equal(value.provenance.paginated, false); assert.equal(value.provenance.opponentSlotsPerMatch, 5);
  assert.ok(value.heroes.every(hero => hero.synergies.length === 0 && hero.matchups.every(row => row.advantage == null || row.advantage === 0)));
  assert.equal(value.provenance.advantageMethod, 'pair_winrate_adjusted_both_hero_baselines');
  assert.ok(mock.calls.every(call => call.init.signal instanceof AbortSignal && !call.init.headers.Authorization));
});
test('failed partial OpenDota download never overwrites atomic cache and backs off', async t => {
  const mock = openFetch({ failAt: 2 }); const { service, runtimeDir } = fixture(t, { fetch: mock.request });
  const before = service.getData(); const result = await service.refresh({ force: true });
  assert.equal(result.ok, false); assert.equal(result.code, 'RATE_LIMIT'); assert.equal(service.getData(), before);
  assert.equal(mock.calls.length, 2); assert.equal(fs.existsSync(path.join(runtimeDir, 'draft-statistics.json')), false);
  assert.equal(Date.parse(service.getState().nextRefreshAt), START + RETRY_MS);
});
test('malformed/duplicate/inconsistent counters and wrong hero catalog are rejected', async () => {
  for (const value of [[], [{ hero_id: 99, games_played: 2, wins: 3 }], [{ hero_id: 99, games_played: 2, wins: 1 }, { hero_id: 99, games_played: 2, wins: 1 }], [{ hero_id: 42, games_played: 2, wins: 1 }]]) {
    await assert.rejects(refreshOpenDotaDraft({ heroIds: IDS, individualEndpoints: true, fetch: async url => response(url.endsWith('/heroStats') ? CATALOG.map(id => ({ id })) : value) }), /таблица|таблиц/);
  }
  await assert.rejects(refreshOpenDotaDraft({ fetch: async () => response([{ id: 42 }]) }), /каталог/);
});
test('invalid JSON and oversized responses do not reach normalization', async () => {
  await assert.rejects(refreshOpenDotaDraft({ fetch: async () => ({ ok: true, text: async () => '{invalid' }) }), /некорректный/);
  await assert.rejects(refreshOpenDotaDraft({ fetch: async () => response([], 200, { 'content-length': String(MAX_RESPONSE_BYTES + 1) }) }), /большой/);
});
test('baseline requires integer five-opponent counts; general partial matrices have no baseline', () => {
  const full = CATALOG.filter(id => id !== 42).map(heroId => ({ heroId, games: 10, wins: 5 }));
  assert.equal(baselineFromPairs(full, 42, CATALOG).games, 10);
  assert.equal(baselineFromPairs(full.slice(1), 42, CATALOG).baselineAvailable, false);
  assert.equal(baselineFromPairs([{ heroId: 99, games: 3, wins: 2 }], 42, [42, 99]).baselineAvailable, false);
  assert.equal(baselineFromPairs(full.slice(1), 42, CATALOG, { completeUnpaginatedEndpoint: true }).games, 8);
});
test('cache validation rejects missing/duplicated candidate heroes and invalid advantage', () => {
  assert.equal(validData(data()), true);
  assert.equal(validData(data('opendota', { heroes: data().heroes.slice(1) })), true); // Older partial caches are valid, visibly partial backups.
  const repeated = data(); repeated.heroes[1].heroId = repeated.heroes[0].heroId; assert.equal(validData(repeated), false);
  const invalid = data(); invalid.heroes[0].matchups[0].advantage = 15; assert.equal(validData(invalid), false);
  const self = data(); self.heroes[0].matchups[0].heroId = 42; assert.equal(validData(self), false);
});
test('malformed runtime cache falls back to bundle; atomic write validates first', t => {
  const { runtimeDir, dataDir } = fixture(t); fs.writeFileSync(path.join(runtimeDir, 'draft-statistics.json'), '{broken');
  const service = createDraftSources({ runtimeDir, dataDir, now: () => START }); assert.equal(service.getData().providerId, 'opendota');
  assert.throws(() => atomicWrite(path.join(runtimeDir, 'draft-statistics.json'), {}), /совместимую/);
  assert.equal(fs.readFileSync(path.join(runtimeDir, 'draft-statistics.json'), 'utf8'), '{broken');
});
test('concurrent refreshes share one download; stop/defer cancels late result', async t => {
  let resolve, calls = 0; const { service, runtimeDir } = fixture(t, { refreshFallback: () => { calls++; return new Promise(done => { resolve = done; }); } });
  const first = service.refresh({ force: true }), second = service.refresh({ force: true }); assert.equal(calls, 1); assert.equal(service.getState().refreshing, true);
  service.deferForMatch(); resolve(data()); assert.equal((await first).cancelled, true); assert.equal((await second).cancelled, true);
  assert.equal(fs.existsSync(path.join(runtimeDir, 'draft-statistics.json')), false); assert.equal(service.getState().refreshing, false);
  service.stop(); assert.equal(service.shouldRefresh(), false); assert.equal((await service.refresh({ force: true })).skipped, true);
});
test('STRATZ primary shares callback credentials and preserves verified cache on auth outage', async t => {
  let primary = 0, fallback = 0; const { service, runtimeDir } = fixture(t, {
    getToken: () => SECRET,
    refreshStratz: async input => { primary++; assert.equal(input.token, SECRET); return data('stratz'); },
    refreshFallback: async () => { fallback++; return data(); },
  });
  assert.equal((await service.refresh({ force: true })).provider, 'stratz'); assert.equal(primary, 1); assert.equal(fallback, 0);
  assert.equal(service.getState().schemaVerified, true); assert.ok(!JSON.stringify(service.getState()).includes(SECRET));
  const saved = fs.readFileSync(path.join(runtimeDir, 'draft-statistics.json'), 'utf8'); assert.ok(!saved.includes(SECRET));
  const down = createDraftSources({ runtimeDir, dataDir: path.dirname(path.join(runtimeDir, '..', 'data', 'x')), now: () => START, getToken: () => SECRET, refreshStratz: async () => { const error = new Error('Forbidden Authorization: Bearer ' + SECRET); error.name = 'StratzError'; throw error; }, refreshFallback: async () => data() });
  assert.equal((await down.refresh({ force: true })).provider, 'stratz_cache'); assert.equal(down.getData().providerId, 'stratz');
  assert.ok(!JSON.stringify(down.getState()).includes(SECRET)); assert.equal(fs.readFileSync(path.join(runtimeDir, 'draft-statistics.json'), 'utf8'), saved);
});
test('unverified exception messages stay private; replacing credentials cancels stale results', async t => {
  const { service } = fixture(t, { getToken: () => SECRET, refreshStratz: async () => { throw new Error('Failed: ' + SECRET); }, refreshFallback: async () => { throw new Error('network details ' + SECRET); } });
  const result = await service.refresh({ force: true }); assert.equal(result.ok, false); assert.ok(!JSON.stringify(result).includes(SECRET)); assert.ok(!JSON.stringify(service.getState()).includes(SECRET));
  let current = SECRET, resolve; const next = fixture(t, { getToken: () => current, refreshStratz: () => new Promise(done => { resolve = done; }) }).service;
  const pending = next.refresh({ force: true }); current = null; resolve(data('stratz')); assert.equal((await pending).cancelled, true); assert.equal(next.getData().providerId, 'opendota');
});
test('STRATZ dynamically verifies draft fields and never fabricates unknown filters', () => {
  const contract = draftContract(schema()), request = buildDraftQuery(contract, IDS);
  assert.ok(request.query.includes('matchUp')); assert.equal(Object.keys(request.variables).length, 10);
  assert.ok(!request.query.includes('position')); assert.ok(!request.query.includes('patch')); assert.ok(!request.query.includes('bracket'));
  assert.equal(draftContract(schema({ position: true, positionDescription: 'Filter positions' })).position, null);
  const verified = buildDraftQuery(draftContract(schema({ position: true })), IDS); assert.deepEqual(verified.variables.position42, ['POSITION_1']);
  assert.throws(() => draftContract(schema({ requiredExtra: true })), /обязательный/);
  const missing = schema(); missing.types[3].fields.pop(); assert.throws(() => draftContract(missing), /winCount/);
});
test('STRATZ bounded two-call refresh normalizes real pair counts, optional synergy and role evidence', async () => {
  const calls = [];
  const value = await refreshStratzDraft({ token: SECRET, heroIds: IDS, now: () => START, fetch: async (url, init) => { calls.push({ url, init }); return response({ data: calls.length === 1 ? { __schema: schema({ position: true }) } : stratzPayload() }); } });
  assert.equal(calls.length, 2); assert.equal(value.providerId, 'stratz'); assert.equal(value.scope.role, 'POSITION_1'); assert.equal(value.provenance.schemaVerified, true);
  assert.ok(value.heroes.every(hero => hero.baselineAvailable === false && hero.synergies.length === 1)); assert.ok(!JSON.stringify(value).includes(SECRET));
  const without = await refreshStratzDraft({ token: SECRET, heroIds: IDS, fetch: async (url, init) => response({ data: JSON.parse(init.body).query.includes('__schema') ? { __schema: schema({ noSynergy: true }) } : stratzPayload({ noSynergy: true }) }) });
  assert.ok(without.heroes.every(hero => hero.synergies.length === 0));
});
test('STRATZ missing hero/ambiguous groups/malformed pairs reject entire refresh', async () => {
  for (const mutation of [value => delete value.heroStats.h48, value => value.heroStats.h42.push(value.heroStats.h42[0]), value => value.heroStats.h42[0].heroId = 8, value => value.heroStats.h42[0].matchups[0].wins = 99]) {
    const payload = stratzPayload(); mutation(payload);
    await assert.rejects(refreshStratzDraft({ token: SECRET, heroIds: IDS, fetch: async (url, init) => response({ data: JSON.parse(init.body).query.includes('__schema') ? { __schema: schema() } : payload }) }), /статистик/);
  }
});
test('STRATZ auth/rate/GraphQL errors stop before data request and never include secrets', async () => {
  for (const status of [401, 403, 429, 500]) {
    let calls = 0;
    try { await refreshStratzDraft({ token: SECRET, fetch: async () => { calls++; return response({}, status); } }); assert.fail('must reject'); }
    catch (error) { assert.ok(!error.message.includes(SECRET)); assert.equal(error.code, status === 429 ? 'RATE_LIMIT' : [401, 403].includes(status) ? 'AUTH_FAILED' : 'HTTP_ERROR'); }
    assert.equal(calls, 1);
  }
  await assert.rejects(refreshStratzDraft({ token: SECRET, fetch: async () => response({ data: {}, errors: [{ message: SECRET }] }) }), /GraphQL/);
});
