'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDraftSources, validData, completeData, atomicWrite, normalizeExplorerMatrix, normalizePositionMatrices, draftMatrixSql, draftPositionMatrixSql, MAX_RESPONSE_BYTES } = require('../src/draft-sources.cjs');
const { IDS, BATCH_SIZE, draftContract, buildDraftQuery, roleBaselineContract, buildRoleBaselineQuery, normalizeRoleBaselines, createPositionDatasets, refreshStratzDraft } = require('../src/stratz-draft.cjs');
const NOW = Date.parse('2026-10-14T12:00:00Z'), DAY = 86400000;
const DAY_SECONDS = (Math.floor(NOW / DAY) - 1) * 86400, SECRET = 'not-a-real-stratz-api-token';
const scalar = name => ({ kind: 'SCALAR', name }), object = name => ({ kind: 'OBJECT', name }), list = type => ({ kind: 'LIST', ofType: type });
function schema(withRoles = true) {
  const fields = [{ name: 'matchUp', args: [{ name: 'heroId', type: scalar('Short') }, { name: 'take', type: scalar('Int') }], type: list(object('Dryad')) }];
  if (withRoles) fields.push({ name: 'winDay', description: 'Returns the last 12 days by day showing matches and wins by hero id.', args: [{ name: 'heroIds', type: list(scalar('Short')) }, { name: 'positionIds', type: list({ kind: 'ENUM', name: 'MatchPlayerPositionType' }) }, { name: 'groupBy', type: { kind: 'ENUM', name: 'Groups' } }, { name: 'take', type: scalar('Int') }], type: list(object('Daily')) });
  return { queryType: { name: 'Query' }, types: [
    { name: 'Query', fields: [{ name: 'heroStats', type: object('Stats'), args: [] }] }, { name: 'Stats', fields },
    { name: 'Dryad', fields: [{ name: 'heroId', type: scalar('Short') }, { name: 'vs', type: list(object('Pair')), args: [] }, { name: 'with', type: list(object('Pair')), args: [] }] },
    { name: 'Pair', fields: [{ name: 'heroId2', type: scalar('Short') }, { name: 'matchCount', type: scalar('Long') }, { name: 'winCount', type: scalar('Long') }] },
    { name: 'Daily', fields: [{ name: 'day', type: scalar('Long') }, { name: 'heroId', type: scalar('Short') }, { name: 'matchCount', type: scalar('Int') }, { name: 'winCount', type: scalar('Int') }] },
    { name: 'MatchPlayerPositionType', kind: 'ENUM', enumValues: [1, 2, 3, 4, 5].map(id => ({ name: `POSITION_${id}` })) }, { name: 'Groups', kind: 'ENUM', enumValues: [{ name: 'HERO_ID' }] },
  ] };
}
function full(providerId = 'opendota', extra = {}) {
  return { schemaVersion: 1, providerId, updatedAt: new Date(NOW).toISOString(), scope: { patch: null, rank: null, role: null }, provenance: { schemaVerified: providerId === 'stratz' }, heroes: IDS.map(heroId => ({ heroId, games: 12600, wins: 6300, baselineAvailable: true, matchups: IDS.filter(id => id !== heroId).map(id => ({ heroId: id, games: 500, wins: 250 })), synergies: [] })), ...extra };
}
function baselineRecords() { return Object.fromEntries([1, 2, 3, 4, 5].map(position => [`p${position}`, IDS.flatMap(heroId => [{ day: DAY_SECONDS, heroId, games: 100 + position * 10 + heroId, wins: 30 + position * 5 }, { day: DAY_SECONDS - 20 * 86400, heroId, games: 999, wins: 999 }]) ])); }
function fixture(t) {
  const parent = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'core-coach-all-draft-'));
  const dataDir = path.join(root, 'data'), runtimeDir = path.join(root, 'runtime'); fs.mkdirSync(dataDir); fs.mkdirSync(runtimeDir);
  fs.writeFileSync(path.join(dataDir, 'wraith-king.json'), JSON.stringify({ heroes: Object.fromEntries(IDS.map(id => [id, { id }])) }));
  t.after(() => { assert.ok(root.startsWith(parent + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  return { dataDir, runtimeDir };
}
const response = data => ({ ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ data }) });

test('draft catalogue covers every one of the 127 heroes and query batches are bounded', () => {
  assert.equal(IDS.length, 127); assert.equal(new Set(IDS).size, 127); assert.ok(IDS.includes(5) && IDS.includes(3));
  const query = buildDraftQuery(draftContract(schema(false)), IDS.slice(0, BATCH_SIZE), { positionId: 3 });
  assert.equal(Object.keys(query.variables).length, BATCH_SIZE * 2); assert.ok(!query.query.includes('position'));
  assert.throws(() => buildDraftQuery(draftContract(schema(false)), IDS.slice(0, BATCH_SIZE + 1)), /список/);
});

test('all 127 STRATZ pair tables and all five real role baselines use ten bounded calls', async () => {
  const calls = [];
  const value = await refreshStratzDraft({ token: SECRET, heroIds: IDS, now: () => NOW, fetch: async (url, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    if (body.query.includes('__schema')) return response({ __schema: schema() });
    if (body.query.includes('winDay')) return response({ heroStats: baselineRecords() });
    const ids = Object.entries(body.variables).filter(([key]) => /^hero\d+$/.test(key)).map(([, value]) => value);
    assert.ok(ids.length <= BATCH_SIZE);
    return response({ heroStats: Object.fromEntries(ids.map(heroId => [`h${heroId}`, [{ heroId, matchups: IDS.filter(id => id !== heroId).map(heroId => ({ heroId, games: 500, wins: 250 })), synergies: [] }]])) });
  } });
  assert.equal(calls.length, 10); assert.equal(value.heroes.length, 127); assert.ok(value.heroes.every(hero => hero.baselineAvailable));
  assert.equal(value.positionDatasets.length, 5); assert.equal(JSON.stringify(value).includes('positionDatasets'), false);
  assert.ok(value.positionDatasets.every(row => completeData(row) && row.provenance.roleFiltered && row.provenance.pairRoleFiltered === false));
  assert.equal(value.positionDatasets[1].heroes[0].games, 120 + IDS[0]);
  assert.equal(value.positionDatasets[1].heroes[0].matchups[0].baselineCompatible, false);
  assert.equal(value.positionDatasets[1].heroes[0].matchups[0].advantage, 0);
  assert.ok(!JSON.stringify(value).includes(SECRET));
});

test('role query verifies current enum and fields and requests all five positions in one operation', () => {
  const contract = roleBaselineContract(schema()), query = buildRoleBaselineQuery(contract);
  assert.equal(query.variables.heroes.length, 127); assert.equal(query.variables.take, 2000);
  assert.deepEqual(query.variables.position2, ['POSITION_2']); assert.deepEqual(query.variables.position5, ['POSITION_5']);
  assert.equal((query.query.match(/:winDay/g) || []).length, 5);
  const changed = schema(); changed.types.find(row => row.name === 'MatchPlayerPositionType').enumValues.pop();
  assert.equal(roleBaselineContract(changed), null); assert.equal(roleBaselineContract(schema(false)), null);
});

test('latest complete day is isolated from older and truncated rows; invalid counts are rejected', () => {
  const input = baselineRecords(), result = normalizeRoleBaselines(input, IDS);
  assert.equal(result[1].heroes[0].games, 110 + IDS[0]);
  input.p1.push(input.p1[0]); assert.throws(() => normalizeRoleBaselines(input, IDS), /некорректная/);
  const incomplete = baselineRecords(); incomplete.p2 = incomplete.p2.slice(0, 100); assert.throws(() => normalizeRoleBaselines(incomplete, IDS), /полного/);
  const impossible = baselineRecords(); impossible.p3[0].wins = 999999; assert.throws(() => normalizeRoleBaselines(impossible, IDS), /некорректная/);
});

test('real baseline-only role rows are accepted; adjusted broad pairs never borrow the role baseline', () => {
  const data = full('stratz'); const samples = normalizeRoleBaselines(baselineRecords(), IDS);
  data.heroes[0].wins = 7560; // The broad baseline is 60%, not the role sample rate.
  const positions = createPositionDatasets(data, samples);
  assert.equal(positions[0].heroes[0].matchups[0].advantage, -.1);
  assert.equal(positions[0].provenance.advantageMethod, 'pair_winrate_adjusted_both_hero_baselines');
  const onlyBaseline = full('stratz', { heroes: full().heroes.map(hero => ({ ...hero, matchups: [], synergies: [] })), scope: { role: 'POSITION_2' } });
  assert.equal(validData(onlyBaseline), true); assert.equal(completeData(onlyBaseline), true);
});

test('complete bulk SQL matrix has genuine baseline and ally pairs, malformed rows never enter cache', () => {
  const ids = [1, 2, 3, 4, 5, 6], rows = ids.flatMap(a => ids.filter(b => b !== a).flatMap(b => [false, true].map(s => ({ a, b, s, g: '10', w: '5' }))));
  const normalized = normalizeExplorerMatrix({ rows }, ids);
  assert.ok(normalized.every(hero => hero.games === 10 && hero.wins === 5 && hero.synergies.length === 5));
  assert.throws(() => normalizeExplorerMatrix({ rows: [...rows, rows[0]] }, ids), /некорректная/);
  assert.throws(() => normalizeExplorerMatrix({ rows: [{ ...rows[0], w: '11' }] }, ids), /некорректная/);
  assert.ok(draftMatrixSql().includes('365*86400')); assert.ok(draftPositionMatrixSql().includes('90*86400'));
  assert.ok(draftPositionMatrixSql().includes('gold_t[11]')); assert.throws(() => draftMatrixSql(10000), /Некорректный/);
});

test('inferred OpenDota roles retain exact corpus counts and disclose inference for every role', () => {
  const ids = [1, 2, 3, 4, 5, 6], rows = [1, 2, 3, 4, 5].flatMap(p => ids.flatMap(a => ids.filter(b => b !== a).map(b => ({ a, b, p, s: false, g: 10 * p, w: 5 * p }))));
  const datasets = normalizePositionMatrices({ rows }, ids, { now: () => NOW });
  assert.deepEqual(datasets.map(data => data.heroes[0].games), [10, 20, 30, 40, 50]);
  assert.ok(datasets.every(data => data.provenance.positionEstimated && data.provenance.roleFiltered === false && data.scopeDescription.includes('90 дней')));
});

test('all five cached roles switch locally and stale primary cannot outrank a fresh full backup', t => {
  const paths = fixture(t), broad = full(); atomicWrite(path.join(paths.dataDir, 'draft-statistics.json'), broad);
  const positions = createPositionDatasets(full('stratz'), normalizeRoleBaselines(baselineRecords(), IDS));
  for (const row of positions) atomicWrite(path.join(paths.dataDir, `draft-statistics-stratz-position-${row.scope.role.slice(-1)}.json`), row);
  const service = createDraftSources({ ...paths, now: () => NOW });
  for (const positionId of [1, 2, 3, 4, 5]) {
    assert.equal(service.getData({ positionId }).scope.role, `POSITION_${positionId}`);
    assert.equal(service.getState({ positionId }).coverageCount, 127); assert.equal(service.getState({ positionId }).totalHeroes, 127);
  }
  positions[0].updatedAt = new Date(NOW - 31 * DAY).toISOString();
  atomicWrite(path.join(paths.dataDir, 'draft-statistics-stratz-position-1.json'), positions[0]);
  const stale = createDraftSources({ ...paths, now: () => NOW });
  assert.equal(stale.getData(1).providerId, 'opendota'); assert.equal(stale.getData(1).scope.role, null);
});

test('one update saves every verified role cache and subsequent picks make no requests', async t => {
  const paths = fixture(t); let calls = 0;
  const value = full('stratz'), positions = createPositionDatasets(value, normalizeRoleBaselines(baselineRecords(), IDS));
  Object.defineProperty(value, 'positionDatasets', { value: positions });
  const service = createDraftSources({ ...paths, now: () => NOW, getToken: () => SECRET, refreshStratz: async () => { calls++; return value; } });
  assert.equal((await service.refresh({ force: true })).ok, true); assert.equal(calls, 1);
  for (const positionId of [1, 2, 3, 4, 5]) {
    assert.equal(service.getData(positionId).scope.role, `POSITION_${positionId}`);
    assert.ok(fs.existsSync(path.join(paths.runtimeDir, `draft-statistics-stratz-position-${positionId}.json`)));
    assert.ok(!fs.readFileSync(path.join(paths.runtimeDir, `draft-statistics-stratz-position-${positionId}.json`), 'utf8').includes(SECRET));
  }
  assert.equal(calls, 1); assert.equal((await service.refresh()).skipped, true);
});

test('full adjusted cache stays within the 3 MiB limit without duplicated pair provenance', () => {
  const value = full('stratz'); value.heroes.forEach(hero => { hero.synergies = hero.matchups; });
  const positioned = createPositionDatasets(value, normalizeRoleBaselines(baselineRecords(), IDS))[0];
  assert.ok(Buffer.byteLength(JSON.stringify(positioned)) < MAX_RESPONSE_BYTES);
  assert.ok(positioned.heroes.every(hero => hero.matchups.every(pair => pair.provenance === undefined)));
});
