'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { draftContract, buildDraftQuery, roleBaselineContract, buildRoleBaselineQuery, normalizeRoleBaselines, createPositionDatasets, latestKnownGameVersion, normalizeRankId, refreshStratzDraft } = require('../src/stratz-draft.cjs');
const { createDraftSources, atomicWrite, validData, RETRY_MS } = require('../src/draft-sources.cjs');
const schema = require('./fixtures/stratz-draft-source-schema.json');
const NOW = Date.parse('2026-10-14T12:00:00Z'), DAY = 86400, IDS = [42, 52, 70];
const response = data => ({ ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ data }) });
const rows = days => Object.fromEntries([1, 2, 3, 4, 5].map(p => [`p${p}`, days.flatMap(day => IDS.map(heroId => ({ heroId, day, games: 100, wins: 50 })))]));
function dataset(rank = null, extra = {}) {
  return { schemaVersion: 1, providerId: 'stratz', updatedAt: new Date(NOW).toISOString(), scope: { patch: null, rank, role: null }, provenance: { schemaVerified: true, advantageMethod: 'stratz_native_synergy', rankFiltered: rank != null }, heroes: IDS.map(heroId => ({ heroId, games: 100, wins: 50, baselineAvailable: true, matchups: IDS.filter(id => id !== heroId).map(heroId => ({ heroId, games: 100, wins: 50, advantage: .01 })), synergies: [] })), ...extra };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-coach-source-context-'));
  const dataDir = path.join(root, 'data'), runtimeDir = path.join(root, 'runtime'); fs.mkdirSync(dataDir); fs.mkdirSync(runtimeDir);
  fs.writeFileSync(path.join(dataDir, 'wraith-king.json'), JSON.stringify({ heroes: Object.fromEntries(IDS.map(id => [id, { id }])) }));
  t.after(() => { assert.ok(root.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('core-coach-source-context-')); fs.rmSync(root, { recursive: true, force: true }); });
  return { dataDir, runtimeDir, now: () => NOW };
}

test('one requested rating cohort maps to verified basic pair and full baseline enums', () => {
  const pairs = buildDraftQuery(draftContract(schema), IDS, { rankId: 'DIVINE_IMMORTAL' });
  const base = buildRoleBaselineQuery(roleBaselineContract(schema), IDS, { rankId: 'DIVINE_IMMORTAL' });
  assert.deepEqual(pairs.variables.brackets, ['DIVINE_IMMORTAL']);
  assert.deepEqual(base.variables.brackets, ['DIVINE', 'IMMORTAL']);
  assert.match(pairs.query, /bracketBasicIds:\$brackets/);
  assert.match(base.query, /bracketIds:\$brackets/);
  const unfilteredPairs = buildDraftQuery(draftContract(schema), IDS, { rankId: 'all' });
  const allRankBase = buildRoleBaselineQuery(roleBaselineContract(schema), IDS, { rankId: 'all' });
  assert.deepEqual(unfilteredPairs.variables.brackets, ['UNCALIBRATED', 'HERALD_GUARDIAN', 'CRUSADER_ARCHON', 'LEGEND_ANCIENT', 'DIVINE_IMMORTAL']); // Enumerate known groups; the special ALL enum returned an empty matrix.
  assert.deepEqual(allRankBase.variables.brackets, ['UNCALIBRATED', 'HERALD', 'GUARDIAN', 'CRUSADER', 'ARCHON', 'LEGEND', 'ANCIENT', 'DIVINE', 'IMMORTAL']);
  assert.throws(() => normalizeRankId('FILTERED'), /рейтинг/);
  const missing = structuredClone(schema); missing.types.find(t => t.name === 'RankBracket').enumValues.pop();
  assert.throws(() => buildRoleBaselineQuery(roleBaselineContract(missing), IDS, { rankId: 'DIVINE_IMMORTAL' }), /рейтинга/);
});

test('refresh sends the same supported rating cohort to both independently sourced components', async () => {
  const requests = [], day = Date.parse('2026-10-13T00:00:00Z') / 1000;
  const value = await refreshStratzDraft({ token: 'unit-test-only', heroIds: IDS, rankId: 'HERALD_GUARDIAN', now: () => NOW, fetch: async (url, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    if (body.query.includes('__schema')) return response({ __schema: schema });
    if (body.query.includes('winDay')) return response({ heroStats: rows([day]), constants: { gameVersions: [{ id: 190, name: '7.41f', asOfDateTime: day - 20 * DAY }] } });
    return response({ heroStats: Object.fromEntries(IDS.map(heroId => [`h${heroId}`, [{ heroId, matchups: IDS.filter(id => id !== heroId).map(id => ({ ownHeroId: heroId, heroId: id, games: 100, wins: 50, nativeSynergy: 1, sampleWeek: 2962 })), synergies: [] }]])) });
  } });
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[1].variables.brackets, ['HERALD_GUARDIAN']);
  assert.deepEqual(requests[2].variables.brackets, ['HERALD', 'GUARDIAN']);
  assert.match(requests[2].query, /constants\{gameVersions\{id name asOfDateTime\}\}/);
  const positioned = value.positionDatasets[0];
  assert.equal(positioned.components.baseline.scope.rank, 'HERALD_GUARDIAN');
  assert.equal(positioned.components.pairs.scope.rank, 'HERALD_GUARDIAN');
  assert.equal(positioned.components.baseline.observedThrough, '2026-10-14T00:00:00.000Z');
  assert.equal(positioned.components.baseline.observedThroughKind, 'exclusive_period_end');
  assert.equal(positioned.components.baseline.observedUntilExclusive, positioned.components.baseline.observedThrough);
  assert.equal(positioned.components.baseline.scope.patch, '7.41f');
  assert.equal(positioned.components.pairs.observedThrough, null);
  assert.equal(positioned.components.pairs.scope.patch, null);
  assert.equal(positioned.components.pairs.scope.role, null);
});

test('patch attribution requires an entire completed baseline window within a known released version', () => {
  const day = Date.parse('2026-10-10T00:00:00Z') / 1000;
  const base = normalizeRoleBaselines(rows([day, day - DAY]), IDS, { now: () => NOW });
  const versions = [{ id: 189, name: '7.41e', asOfDateTime: day - 20 * DAY }, { id: 190, name: '7.41f', asOfDateTime: day - 2 * DAY }];
  const version = latestKnownGameVersion(versions, { now: () => NOW });
  const current = createPositionDatasets(dataset(), base, { latestKnownGameVersion: version })[0];
  assert.equal(current.components.baseline.scope.patch, '7.41f');
  assert.equal(current.components.baseline.patchMethod, 'daily_window_inside_catalogue_version');
  assert.equal(current.components.baseline.patchMatchesCurrent, undefined);
  assert.equal(current.components.pairs.scope.patch, null);
  const crossing = createPositionDatasets(dataset(), base, { latestKnownGameVersion: { ...version, asOfDateTime: day } })[0];
  assert.equal(crossing.components.baseline.scope.patch, null);
  assert.equal(createPositionDatasets(dataset(), base)[0].components.baseline.scope.patch, null);
  assert.equal(latestKnownGameVersion([{ ...versions[1], asOfDateTime: NOW / 1000 + DAY }], { now: () => NOW }), null);
});

test('unknown or stale pair dates remain independent from a freshly downloaded role baseline', t => {
  const paths = fixture(t), scope = { patch: '7.41f', rank: null, role: 'POSITION_1' };
  const value = dataset(null, { scope, observedThrough: '2026-10-13T00:00:00Z', components: { baseline: { scope, observedThrough: '2026-10-13T00:00:00Z' }, pairs: { scope: { patch: null, rank: null, role: null }, observedThrough: null } } });
  atomicWrite(path.join(paths.dataDir, 'draft-statistics-stratz-position-1.json'), value);
  let service = createDraftSources(paths), state = service.getState(1);
  assert.equal(state.components.baseline.observedThrough, '2026-10-13T00:00:00Z');
  assert.equal(state.components.pairs.observedThrough, null);
  assert.equal(state.components.pairs.status, 'unknown');
  assert.equal(state.freshnessVerified, false);
  value.components.pairs.observedThrough = '2026-08-01T00:00:00Z';
  atomicWrite(path.join(paths.dataDir, 'draft-statistics-stratz-position-1.json'), value);
  service = createDraftSources(paths); state = service.getState(1);
  assert.ok(service.getData(1)); // The engine may still use the fresh base.
  assert.equal(state.components.pairs.status, 'stale');
  assert.equal(state.components.baseline.status, 'known');
  const malformed = structuredClone(value); malformed.components.pairs.observedThrough = 'not-a-date';
  assert.equal(validData(malformed), false);
});

test('rating cache identity survives reload and never silently uses another rating or a broad backup', async t => {
  const paths = fixture(t), snapshots = [];
  atomicWrite(path.join(paths.dataDir, 'draft-statistics-stratz.json'), dataset());
  const service = createDraftSources({ ...paths, getToken: () => 'unit-test-only', refreshStratz: async options => dataset(options.rankId), onSnapshot: value => snapshots.push(value.scope.rank) });
  assert.equal(service.getData({ rankId: 'DIVINE_IMMORTAL' }), null);
  assert.equal((await service.refresh({ force: true, rankId: 'DIVINE_IMMORTAL' })).ok, true);
  assert.equal(service.getData({ rankId: 'DIVINE_IMMORTAL' }).scope.rank, 'DIVINE_IMMORTAL');
  assert.equal(service.getData({ rankId: 'all' }).scope.rank, null);
  assert.deepEqual(snapshots, ['DIVINE_IMMORTAL']);
  const reload = createDraftSources(paths);
  assert.equal(reload.getData({ rankId: 'DIVINE_IMMORTAL' }).scope.rank, 'DIVINE_IMMORTAL');
  assert.equal(reload.getData({ rankId: 'LEGEND_ANCIENT' }), null);
});

test('failed filtered refresh has independent backoff and never downloads an incompatible broad fallback', async t => {
  const paths = fixture(t); let fallbackCalls = 0;
  const service = createDraftSources({ ...paths, getToken: () => 'unit-test-only', refreshStratz: async () => { throw new Error('unavailable'); }, refreshFallback: async () => { fallbackCalls++; return dataset(); } });
  assert.equal((await service.refresh({ rankId: 'DIVINE_IMMORTAL', force: true })).ok, false);
  assert.equal(fallbackCalls, 0);
  assert.equal(service.shouldRefresh({ rankId: 'DIVINE_IMMORTAL' }), false);
  assert.equal(service.shouldRefresh({ rankId: 'HERALD_GUARDIAN' }), true);
  assert.equal(Date.parse(service.getState({ rankId: 'DIVINE_IMMORTAL' }).nextRefreshAt), NOW + RETRY_MS);
  assert.equal(service.getData({ rankId: 'DIVINE_IMMORTAL' }), null);
});

test('newest verified catalogue discovered in another cohort invalidates only known old component patches', t => {
  const paths = fixture(t), oldScope = { role: 'POSITION_1', rank: null, patch: '7.41e' };
  const old = dataset(null, { scope: oldScope, components: { baseline: { scope: oldScope, observedThrough: '2026-10-13T00:00:00Z' }, pairs: { scope: { patch: null, rank: null, role: null }, observedThrough: null } } });
  const latest = { id: 190, name: '7.41f', asOfDateTime: Date.parse('2026-09-15T00:00:00Z') / 1000, authority: 'stratz_constants_catalogue' };
  atomicWrite(path.join(paths.dataDir, 'draft-statistics-stratz-position-1.json'), old);
  atomicWrite(path.join(paths.runtimeDir, 'draft-statistics-stratz-rank-divine_immortal.json'), dataset('DIVINE_IMMORTAL', { provenance: { schemaVerified: true, advantageMethod: 'stratz_native_synergy', latestKnownGameVersion: latest } }));
  const service = createDraftSources(paths), annotated = service.getData({ positionId: 1, rankId: 'all' });
  assert.equal(annotated.components.baseline.patchMatchesCurrent, false);
  assert.equal(annotated.components.baseline.scope.patch, '7.41e');
  assert.equal(annotated.components.pairs.scope.patch, null);
  assert.equal(annotated.components.pairs.patchMatchesCurrent, undefined);
  assert.equal(old.components.baseline.patchMatchesCurrent, undefined); // Cached evidence stays immutable.
  old.components.baseline.scope.patch = '7.41f'; old.components.pairs.scope.patch = '7.41e';
  atomicWrite(path.join(paths.dataDir, 'draft-statistics-stratz-position-1.json'), old);
  const switched = createDraftSources(paths).getData({ positionId: 1, rankId: 'all' });
  assert.equal(switched.components.baseline.patchMatchesCurrent, undefined);
  assert.equal(switched.components.pairs.patchMatchesCurrent, false);
});

test('an explicit token change queues the correct same-cohort request instead of joining cancelled credentials', async t => {
  const paths = fixture(t), calls = [];
  let credential = 'fixture-old-not-real';
  const service = createDraftSources({ ...paths, getToken: () => credential, refreshStratz: input => new Promise(resolve => calls.push({ ...input, resolve })) });
  const initial = service.refresh({ force: true, rankId: 'DIVINE_IMMORTAL' });
  credential = 'fixture-new-not-real';
  const authorised = service.refresh({ force: true, rankId: 'DIVINE_IMMORTAL' });
  const joined = service.refresh({ force: true, rankId: 'DIVINE_IMMORTAL' });
  assert.equal(authorised, joined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].signal.aborted, true);
  const queuedState = service.getState();
  assert.equal(queuedState.requestedRankId, 'DIVINE_IMMORTAL');
  assert.equal(queuedState.refreshingRankId, 'DIVINE_IMMORTAL');
  assert.equal(queuedState.pendingRankId, 'DIVINE_IMMORTAL');
  assert.ok(!JSON.stringify(queuedState).includes('fixture-'));
  calls[0].resolve(dataset('DIVINE_IMMORTAL'));
  assert.equal((await initial).cancelled, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].token, credential);
  calls[1].resolve(dataset('DIVINE_IMMORTAL'));
  assert.equal((await authorised).ok, true);
  assert.equal((await joined).ok, true);
  assert.equal(service.getState().status, 'ready');
  assert.equal(service.getState().pendingRankId, null);
});

test('clearing credentials cancels the queued cohort and starts no fallback under the old request', async t => {
  const paths = fixture(t), calls = [];
  let credential = 'fixture-only-not-real', fallbackCalls = 0;
  const service = createDraftSources({ ...paths, getToken: () => credential, refreshStratz: input => new Promise(resolve => calls.push({ ...input, resolve })), refreshFallback: async () => { fallbackCalls++; return dataset(); } });
  const initial = service.refresh({ force: true, rankId: 'DIVINE_IMMORTAL' });
  const pending = service.refresh({ force: true, rankId: 'all' });
  credential = null;
  calls[0].resolve(dataset('DIVINE_IMMORTAL'));
  assert.equal((await initial).cancelled, true);
  assert.deepEqual(await pending, { cancelled: true, reason: 'credentials_changed' });
  assert.equal(calls.length, 1);
  assert.equal(fallbackCalls, 0);
  assert.deepEqual(fs.readdirSync(paths.runtimeDir), []);
  assert.equal(service.getState().tokenConfigured, false);
  assert.equal(service.getState().anyRefreshing, false);
  assert.equal(service.getState().pendingRankId, null);
});

test('a second token replacement supersedes the earlier queued credentials without parallel requests', async t => {
  const paths = fixture(t), calls = [];
  let credential = 'fixture-first-not-real';
  const service = createDraftSources({ ...paths, getToken: () => credential, refreshStratz: input => new Promise(resolve => calls.push({ ...input, resolve })) });
  const initial = service.refresh({ rankId: 'HERALD_GUARDIAN', force: true });
  credential = 'fixture-second-not-real';
  const replaced = service.refresh({ rankId: 'HERALD_GUARDIAN', force: true });
  credential = 'fixture-latest-not-real';
  const latest = service.refresh({ rankId: 'HERALD_GUARDIAN', force: true });
  assert.deepEqual(await replaced, { cancelled: true, reason: 'credentials_changed' });
  assert.equal(calls.length, 1);
  calls[0].resolve(dataset('HERALD_GUARDIAN'));
  assert.equal((await initial).cancelled, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].token, credential);
  calls[1].resolve(dataset('HERALD_GUARDIAN'));
  assert.equal((await latest).ok, true);
  assert.equal(service.getState().anyRefreshing, false);
});
