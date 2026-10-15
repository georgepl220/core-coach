'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { extractCarry, aggregate, refreshBuilds, SOURCE_URL, D2PT_REFERENCE } = require('../scripts/update-d2pt.cjs');
const NOW = '2026-10-12T12:00:00.000Z';
const START = Date.parse('2026-10-11T12:00:00.000Z') / 1000;
const catalog = Object.fromEntries(['tango', 'boots', 'phase_boots', 'relic', 'radiance', 'blink', 'black_king_bar', 'desolator'].map(key => [key, { id: key, components: [] }]));
function fixture(extra = {}, playerExtra = {}) {
  return { match_id: 9000000001, start_time: START, patch: 60, duration: 2400, radiant_win: true, players: [
    { hero_id: 42, player_slot: 0, lane: 1, lane_role: 1, position_est: 1, times: [0, 300, 600, 900], lh_t: [0, 20, 50, 90], networth_t: [600, 2000, 4000, 7000], gold_t: [0, 1200, 3000, 9000], purchase_log: [{ key: 'tango', time: -80 }, { key: 'boots', time: 100 }, { key: 'phase_boots', time: 300 }, { key: 'relic', time: 650 }, { key: 'radiance', time: 950 }, { key: 'blink', time: 1200 }, { key: 'black_king_bar', time: 1800 }], ...playerExtra },
    { hero_id: 2, player_slot: 128, lane: 1, lane_role: 3, position_est: 3, times: [0, 600], networth_t: [600, 3500], lh_t: [0, 40] },
    { hero_id: 3, player_slot: 129, lane: 3, lane_role: 1, position_est: 1, times: [0, 600], networth_t: [600, 4000] },
  ], ...extra };
}

test('only a parsed safelane carry becomes a build observation', () => {
  assert.equal(extractCarry(fixture({}, { lane_role: 3, position_est: 3 }), catalog), null);
  assert.equal(extractCarry(fixture({}, { position_est: 5 }), catalog), null);
  assert.equal(extractCarry(fixture({}, { is_roaming: true }), catalog), null);
  assert.equal(extractCarry(fixture({}, { purchase_log: null }), catalog), null);
  const carry = extractCarry(fixture(), catalog);
  assert.deepEqual(carry.sequence.map(item => item.key), ['tango', 'phase_boots', 'radiance', 'blink', 'black_king_bar']);
  assert.equal(carry.sequence.find(item => item.key === 'radiance').timeSeconds, 950);
  assert.deepEqual(carry.enemies.map(enemy => enemy.enemyHeroId), [2]);
});

test('benchmark uses exact replay times and explicit networth_t, never gold_t', () => {
  const carry = extractCarry(fixture(), catalog);
  assert.equal(carry.timelines.netWorth.find(point => point.minute === 10).value, 4000);
  const missingNetWorth = extractCarry(fixture({}, { networth_t: null }), catalog);
  assert.deepEqual(missingNetWorth.timelines.netWorth, []);
  const missingMinute10 = extractCarry(fixture({}, { times: [0, 300, 599, 900] }), catalog);
  assert.equal(missingMinute10.timelines.lastHits.some(point => point.minute === 10), false);
});

test('aggregate reports actual route, sample dates, base patch and small-sample empirical benchmarks', () => {
  const observations = [0, 1, 2].map(index => extractCarry(fixture({ match_id: 9000000001 + index, start_time: START - index * 86400 }, { lh_t: [0, 20, 40 + index * 10, 90], networth_t: [600, 2000, 3000 + index * 1000, 7000] }), catalog));
  const result = aggregate(observations, { now: NOW, patches: [{ id: 60, name: '7.41' }] });
  assert.equal(result.source, 'OpenDota recent parsed carry matches');
  assert.equal(result.sourceUrl, SOURCE_URL);
  assert.equal(result.d2ptReference, D2PT_REFERENCE);
  assert.equal(result.patch.minorPatchVerified, false);
  assert.equal(result.sampleCount, 3);
  assert.equal(result.builds[0].matches, 3);
  assert.equal(result.builds[0].representativeMatchId, 9000000001);
  assert.equal(result.builds[0].sequence.find(item => item.key === 'radiance').timeSeconds, 950);
  assert.deepEqual(result.benchmarks.lastHits.find(point => point.minute === 10), { minute: 10, p25: 45, p50: 50, p75: 55, sampleSize: 3 });
  assert.deepEqual(result.benchmarks.netWorth.find(point => point.minute === 10), { minute: 10, p25: 3500, p50: 4000, p75: 4500, sampleSize: 3 });
  assert.equal(result.laneMatchups[0].laneOutcome.metric, 'observed_carry_minus_opposing_offlane_net_worth_at_10');
});

test('old patch observations are not mixed into latest base patch sample; tiny sample has no normative benchmark', () => {
  const latest = extractCarry(fixture(), catalog);
  const older = extractCarry(fixture({ match_id: 9000000002, patch: 59, start_time: START - 86400 }), catalog);
  const result = aggregate([latest, older], { now: NOW });
  assert.equal(result.sampleCount, 1);
  assert.deepEqual(result.provenance.sampleMatchIds, [9000000001]);
  assert.deepEqual(result.benchmarks.lastHits, []);
  assert.deepEqual(result.benchmarks.netWorth, []);
});

test('failed or challenged request preserves the last valid cache byte for byte', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'wk-build-cache-'));
  const destination = path.join(folder, 'build.json');
  await fs.writeFile(destination, '{"valid":"previous"}\n');
  const fakeFetch = async url => url === SOURCE_URL ? { ok: true, json: async () => [{ match_id: 9000000001, start_time: START, duration: 2400 }] } : { ok: false, status: 429 };
  await assert.rejects(refreshBuilds({ now: NOW, catalog, patches: [{ id: 60, name: '7.41' }], fetch: fakeFetch, destination, delayMs: 0 }), /existing build cache preserved/);
  assert.equal(await fs.readFile(destination, 'utf8'), '{"valid":"previous"}\n');
  await fs.rm(folder, { recursive: true, force: true });
});

test('refresh excludes stale/future candidates and only writes a fully parsed carry sample', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'wk-build-refresh-'));
  const destination = path.join(folder, 'build.json');
  const called = [];
  const fakeFetch = async url => {
    called.push(url);
    return { ok: true, json: async () => url === SOURCE_URL ? [
      { match_id: 9000000001, start_time: START, duration: 2400 },
      { match_id: 9000000002, start_time: START - 100 * 86400, duration: 2400 },
      { match_id: 9000000003, start_time: START + 5 * 86400, duration: 2400 },
    ] : fixture() };
  };
  const result = await refreshBuilds({ now: NOW, catalog, patches: [{ id: 60, name: '7.41' }], fetch: fakeFetch, destination, delayMs: 0 });
  assert.equal(result.sampleCount, 1);
  assert.deepEqual(called, [SOURCE_URL, 'https://api.opendota.com/api/matches/9000000001']);
  assert.equal(JSON.parse(await fs.readFile(destination, 'utf8')).builds[0].sequence.find(item => item.key === 'radiance').timeSeconds, 950);
  await fs.rm(folder, { recursive: true, force: true });
});
