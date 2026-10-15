'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDraftSources, RETRY_MS } = require('../src/draft-sources.cjs');

const NOW = Date.parse('2026-10-14T12:00:00Z');
const SECRET = 'fixture-token-not-a-real-credential';
const IDS = [42, 52, 70];
const RANK_A = 'HERALD_GUARDIAN', RANK_B = 'CRUSADER_ARCHON', RANK_C = 'DIVINE_IMMORTAL';
function dataset(rankId, now = NOW) {
  return { schemaVersion: 1, providerId: 'stratz', updatedAt: new Date(now).toISOString(), scope: { patch: null, rank: rankId === 'all' ? null : rankId, role: null }, provenance: { schemaVerified: true, rankFiltered: rankId !== 'all', advantageMethod: 'stratz_native_synergy' }, heroes: IDS.map(heroId => ({ heroId, games: 100, wins: 50, matchups: IDS.filter(id => id !== heroId).map(heroId => ({ heroId, games: 100, wins: 50, advantage: .01 })), synergies: [] })) };
}
function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-coach-draft-queue-'));
  const dataDir = path.join(root, 'data'), runtimeDir = path.join(root, 'runtime');
  fs.mkdirSync(dataDir); fs.mkdirSync(runtimeDir);
  fs.writeFileSync(path.join(dataDir, 'wraith-king.json'), JSON.stringify({ heroes: Object.fromEntries(IDS.map(id => [id, { id }])) }));
  t.after(() => { assert.ok(root.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('core-coach-draft-queue-')); fs.rmSync(root, { recursive: true, force: true }); });
  const calls = [];
  const service = createDraftSources({ dataDir, runtimeDir, now: () => NOW, getToken: () => SECRET, refreshStratz: options => new Promise((resolve, reject) => calls.push({ ...options, resolve, reject })), refreshFallback: async () => { throw new Error('no fallback in fixture'); }, ...extra });
  return { service, calls, runtimeDir };
}

test('rating switches keep only the latest queued cohort and run requests sequentially', async t => {
  const { service, calls } = fixture(t);
  const first = service.refresh({ force: true, rankId: RANK_A });
  const superseded = service.refresh({ force: true, rankId: RANK_B });
  const latest = service.refresh({ force: true, rankId: RANK_C, positionId: 2 });
  const duplicate = service.refresh({ force: true, rankId: RANK_C, positionId: 3 });
  assert.equal(await superseded.then(result => result.reason), 'superseded');
  assert.equal(latest, duplicate);
  assert.equal(calls.length, 1);
  assert.equal(service.getState().rankId, RANK_C);
  assert.equal(service.getState().positionId, 3);
  assert.equal(service.getState().status, 'queued');
  assert.equal(service.getState().refreshing, false);
  assert.equal(service.getState().anyRefreshing, true);
  assert.equal(service.getState().refreshingRankId, RANK_A);
  assert.equal(service.getState({ rankId: RANK_A }).status, 'refreshing');
  calls[0].resolve(dataset(RANK_A));
  assert.equal((await first).ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].rankId, RANK_C);
  assert.equal(calls[1].positionId, 3);
  assert.equal(service.getState().status, 'refreshing');
  assert.equal(service.getState().refreshQueued, false);
  calls[1].resolve(dataset(RANK_C));
  assert.equal((await latest).ok, true);
  assert.equal((await duplicate).ok, true);
  assert.equal(service.getState().status, 'ready');
  assert.equal(service.getState({ rankId: RANK_A }).status, 'ready');
  assert.equal(service.getData({ rankId: RANK_B }), null);
  assert.equal(calls.length, 2);
});

test('switching back to the currently loading rating cancels the stale queued target', async t => {
  const { service, calls } = fixture(t);
  const first = service.refresh({ force: true, rankId: RANK_A });
  const unwanted = service.refresh({ force: true, rankId: RANK_B });
  const back = service.refresh({ force: true, rankId: RANK_A });
  assert.deepEqual(await unwanted, { cancelled: true, reason: 'superseded' });
  assert.equal(service.getState().queuedRankId, null);
  assert.equal(service.getState({ rankId: RANK_B }).status, 'unavailable');
  calls[0].resolve(dataset(RANK_A));
  assert.equal((await first).ok, true);
  assert.equal((await back).ok, true);
  assert.equal(calls.length, 1);
});

test('context selection queues a due rating but position switches and passive selection do not add network requests', async t => {
  const { service, calls } = fixture(t);
  service.setContext({ rankId: RANK_A, positionId: 2 });
  assert.equal(calls.length, 0);
  const first = service.refresh({ force: true });
  service.setContext({ rankId: RANK_A, positionId: 5, requestRefresh: true });
  assert.equal(calls.length, 1);
  service.setContext({ rankId: RANK_B, positionId: 4, requestRefresh: true });
  assert.equal(service.getState().refreshQueued, true);
  const latest = service.refresh({ rankId: RANK_B });
  calls[0].resolve(dataset(RANK_A));
  await first;
  assert.equal(calls.length, 2);
  assert.equal(calls[1].rankId, RANK_B);
  assert.equal(calls[1].positionId, 4);
  calls[1].resolve(dataset(RANK_B)); await latest;
  service.setContext({ rankId: RANK_C });
  assert.equal(calls.length, 2);
  assert.equal(service.getState().status, 'unavailable');
});

test('failed uncached rating keeps its sanitized real error while the next rating succeeds', async t => {
  const { service, calls } = fixture(t);
  const failed = service.refresh({ force: true, rankId: RANK_A });
  const next = service.refresh({ force: true, rankId: RANK_B });
  const error = new Error('STRATZ: нет доступа. Bearer ' + SECRET); error.name = 'StratzError'; error.code = 'AUTH_FAILED';
  calls[0].reject(error);
  assert.equal((await failed).code, 'AUTH_FAILED');
  const failedState = service.getState({ rankId: RANK_A });
  assert.equal(failedState.status, 'error');
  assert.equal(failedState.errorCode, 'AUTH_FAILED');
  assert.match(failedState.message, /нет доступа/);
  assert.ok(!JSON.stringify(failedState).includes(SECRET));
  assert.equal(Date.parse(failedState.nextRefreshAt), NOW + RETRY_MS);
  assert.equal(calls.length, 2);
  calls[1].resolve(dataset(RANK_B)); await next;
  assert.equal(service.getState({ rankId: RANK_A }).status, 'error');
  assert.equal(service.getState({ rankId: RANK_B }).status, 'ready');
  assert.deepEqual(await service.refresh({ rankId: RANK_A }), { skipped: true });
  assert.equal(service.getState().status, 'error');
  assert.equal(calls.length, 2);
});

test('an uncached filtered rating explains the missing token instead of hiding the failure', async t => {
  let fallbackCalls = 0;
  const { service } = fixture(t, { getToken: () => null, refreshFallback: async () => { fallbackCalls++; return dataset('all'); } });
  assert.equal((await service.refresh({ rankId: RANK_B, force: true })).code, 'TOKEN_REQUIRED');
  const state = service.getState();
  assert.equal(state.status, 'error');
  assert.equal(state.errorCode, 'TOKEN_REQUIRED');
  assert.match(state.message, /добавь API-токен STRATZ/);
  assert.equal(fallbackCalls, 0);
});

test('unknown error codes are not exposed as public source status', async t => {
  const error = new Error('Private network payload ' + SECRET); error.code = SECRET;
  const { service } = fixture(t, { refreshStratz: async () => { throw error; } });
  const result = await service.refresh({ rankId: RANK_C, force: true });
  assert.equal(result.code, 'UNAVAILABLE');
  assert.equal(service.getState().errorCode, 'UNAVAILABLE');
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.ok(!JSON.stringify(service.getState()).includes(SECRET));
});

test('cancelled queued refresh restores an earlier error and retry backoff remains cohort-specific', async t => {
  let clock = NOW;
  const { service, calls } = fixture(t, { now: () => clock });
  const initial = service.refresh({ force: true, rankId: RANK_B });
  const error = new Error('STRATZ: лимит API.'); error.name = 'StratzError'; error.code = 'RATE_LIMIT';
  calls[0].reject(error); await initial;
  const active = service.refresh({ force: true, rankId: RANK_A });
  assert.deepEqual(await service.refresh({ rankId: RANK_B }), { skipped: true });
  const queued = service.refresh({ rankId: RANK_B, force: true });
  assert.equal(service.refresh({ rankId: RANK_B }), queued); // Join an explicit retry already queued, despite the ordinary retry deadline.
  service.setContext({ rankId: RANK_A });
  assert.equal((await queued).cancelled, true);
  assert.equal(service.getState({ rankId: RANK_B }).errorCode, 'RATE_LIMIT');
  calls[1].resolve(dataset(RANK_A)); await active;
  assert.equal(service.shouldRefresh({ rankId: RANK_B }), false);
  clock += RETRY_MS;
  assert.equal(service.shouldRefresh({ rankId: RANK_B }), true);
  const retry = service.refresh({ rankId: RANK_B });
  assert.equal(calls.length, 3);
  calls[2].resolve(dataset(RANK_B, clock)); assert.equal((await retry).ok, true);
});

for (const method of ['deferForMatch', 'stop']) {
  test(`${method} aborts the active request and clears the queue before any new cohort download`, async t => {
    const { service, calls, runtimeDir } = fixture(t);
    const active = service.refresh({ force: true, rankId: RANK_A });
    const pending = service.refresh({ force: true, rankId: RANK_B });
    service[method]();
    assert.equal(calls[0].signal.aborted, true);
    assert.equal((await pending).cancelled, true);
    assert.equal(service.getState().queuedRankId, null);
    calls[0].resolve(dataset(RANK_A));
    assert.equal((await active).cancelled, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(fs.readdirSync(runtimeDir), []);
    assert.equal(service.getState().anyRefreshing, false);
    if (method === 'stop') assert.deepEqual(await service.refresh({ force: true, rankId: RANK_B }), { skipped: true });
  });
}
