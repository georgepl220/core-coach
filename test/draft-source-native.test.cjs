'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { IDS, draftContract, buildDraftQuery, normalizePairs, adjustPairEffects, normalizeRoleBaselines, createPositionDatasets, pairPeriodContract, buildPairPeriodProof, normalizePairPeriodProof, refreshStratzDraft } = require('../src/stratz-draft.cjs');
const { createDraftSources, atomicWrite, MAX_RESPONSE_BYTES } = require('../src/draft-sources.cjs');
const NOW = Date.parse('2026-10-14T12:00:00Z'), DAY = 86400;
const LATEST = Date.parse('2026-10-10T00:00:00Z') / 1000;
// Public aggregate types from the authenticated 2026-10-14 STRATZ schema.
const schema = require('./fixtures/stratz-draft-source-schema.json');
const roundtrip = require('./fixtures/stratz-pair-period-roundtrip.json');
const response = value => ({ ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ data: value }) });
const rows = (ids = IDS, days = [LATEST]) => Object.fromEntries([1, 2, 3, 4, 5].map(p => [`p${p}`, days.flatMap(day => ids.map(heroId => ({ heroId, day, games: 100 + p, wins: 50 }))) ]));
const dataset = (extra = {}) => ({ schemaVersion: 1, providerId: 'stratz', updatedAt: new Date(NOW).toISOString(), scope: { patch: null, rank: null, role: null }, provenance: { schemaVerified: true, advantageMethod: 'stratz_native_synergy' }, heroes: IDS.map(heroId => ({ heroId, games: 500000, wins: 250000, baselineAvailable: true, matchups: IDS.filter(id => id !== heroId).map(id => ({ heroId: id, games: 999999, wins: 499999, advantage: -.051955 })), synergies: IDS.filter(id => id !== heroId).map(id => ({ heroId: id, games: 999999, wins: 499999, advantage: -.063155 })) })), ...extra });

test('authenticated schema requests native synergy with the verified orientation and explicitly enumerated all-rank cohort', () => {
  const contract = draftContract(schema), request = buildDraftQuery(contract, [52, 42]);
  assert.ok(request.query.includes('ownHeroId:heroId1'));
  assert.ok(request.query.includes('nativeSynergy:synergy'));
  assert.ok(request.query.includes('sampleWeek:week'));
  assert.match(request.query, /bracketBasicIds:\$brackets/);
  assert.deepEqual(request.variables.brackets, ['UNCALIBRATED', 'HERALD_GUARDIAN', 'CRUSADER_ARCHON', 'LEGEND_ANCIENT', 'DIVINE_IMMORTAL']);
  assert.ok(!request.variables.brackets.includes('ALL'));
  assert.ok(!request.query.includes('positionIds:'));
});

test('native synergy uses percentage-point units and preserves zero and negative effects', () => {
  const fields = draftContract(schema).vsFields;
  const actual = normalizePairs([{ ownHeroId: 52, heroId: 102, games: 388, wins: 179, nativeSynergy: -5.613, sampleWeek: 2962 }, { ownHeroId: 52, heroId: 70, games: 1011, wins: 484, nativeSynergy: 0, sampleWeek: 2962 }], 52, fields);
  assert.equal(actual[0].advantage, -.05613);
  assert.equal(actual[1].advantage, 0);
  assert.throws(() => normalizePairs([{ ownHeroId: 102, heroId: 70, games: 10, wins: 5, nativeSynergy: 1 }], 52, fields), /ориентация/);
  assert.throws(() => normalizePairs([{ heroId: 70, games: 10, wins: 5, nativeSynergy: 1 }], 52, fields), /ориентация/);
  assert.throws(() => normalizePairs([{ ownHeroId: 52, heroId: 70, games: 10, wins: 5, nativeSynergy: '5.6' }], 52, fields), /эффект/);
});

test('missing native effects correct both same-corpus hero baselines and never borrow role or absent baselines', () => {
  const heroes = [{ heroId: 52, games: 100, wins: 60, baselineAvailable: true, matchups: [{ heroId: 70, games: 100, wins: 50 }], synergies: [{ heroId: 70, games: 100, wins: 50 }] }, { heroId: 70, games: 100, wins: 40, baselineAvailable: true, matchups: [], synergies: [] }];
  const adjusted = adjustPairEffects(heroes);
  assert.equal(adjusted.provenance.advantageMethod, 'pair_winrate_adjusted_both_hero_baselines');
  assert.equal(adjusted.heroes[0].matchups[0].advantage, -.2);
  assert.equal(adjusted.heroes[0].synergies[0].advantage, 0);
  assert.equal(adjustPairEffects(heroes, { roleFiltered: true }).heroes[0].matchups[0].advantage, undefined);
  heroes[1].baselineAvailable = false;
  assert.equal(adjustPairEffects(heroes).heroes[0].matchups[0].advantage, undefined);
});

test('mixed native and fallback effects retain their distinct methods without re-normalizing native values', () => {
  const value = adjustPairEffects([{ heroId: 52, games: 100, wins: 60, baselineAvailable: true, matchups: [{ heroId: 70, games: 100, wins: 50, advantage: -.0529 }], synergies: [{ heroId: 70, games: 100, wins: 50 }] }, { heroId: 70, games: 100, wins: 40, baselineAvailable: true, matchups: [], synergies: [] }]);
  assert.equal(value.provenance.advantageMethod, 'stratz_native_synergy');
  assert.equal(value.provenance.nativePairCount, 1); assert.equal(value.provenance.fallbackPairCount, 1);
  assert.equal(value.heroes[0].matchups[0].advantage, -.0529);
  assert.equal(value.heroes[0].synergies[0].adjustedFallback, true);
});

test('all 127 heroes and five positions refresh in ten calls with native effects and one common completed date window', async () => {
  const days = [LATEST, LATEST - DAY, LATEST - 2 * DAY], pairRequests = []; let calls = 0;
  const value = await refreshStratzDraft({ token: 'unit-test-only-no-real-token', now: () => NOW, fetch: async (url, init) => {
    calls++; const body = JSON.parse(init.body);
    if (body.query.includes('__schema')) return response({ __schema: schema });
    if (body.query.includes('winDay')) return response({ heroStats: rows(IDS, days) });
    pairRequests.push(body);
    const ids = Object.entries(body.variables).filter(([key]) => /^hero\d+$/.test(key)).map(([, id]) => id);
    return response({ heroStats: Object.fromEntries(ids.map(ownHeroId => [`h${ownHeroId}`, [{ heroId: ownHeroId, matchups: IDS.filter(id => id !== ownHeroId).map(heroId => ({ ownHeroId, heroId, games: 500, wins: 250, nativeSynergy: -5.29, sampleWeek: 2962 })), synergies: IDS.filter(id => id !== ownHeroId).map(heroId => ({ ownHeroId, heroId, games: 500, wins: 250, nativeSynergy: -6.631, sampleWeek: 2962 })) }]])) });
  } });
  assert.equal(calls, 10); assert.equal(value.heroes.length, 127);
  assert.equal(value.provenance.advantageMethod, 'stratz_native_synergy');
  assert.equal(value.provenance.nativePairCount, 2 * 127 * 126);
  assert.deepEqual(value.provenance.pairWeekIds, [2962]);
  assert.ok(pairRequests.every(body => body.variables.snapshotWeek === undefined));
  assert.equal(value.provenance.pairPeriodConsistent, true);
  assert.equal(value.provenance.pairPeriodMethod, 'native_week_id_consistent');
  assert.equal(value.components.pairs.observedThrough, null); // An ID does not establish a date.
  assert.equal(value.positionDatasets[0].components.pairs.scope.patch, null);
  assert.equal(value.scope.rank, null); // Preserve the established cache identity.
  assert.equal(value.provenance.rankFiltered, true);
  assert.equal(value.components.pairs.scope.rank, 'all');
  assert.equal(value.components.pairs.rankFiltered, true);
  assert.deepEqual(value.provenance.pairRankCohorts, pairRequests[0].variables.brackets);
  assert.ok(pairRequests.every(body => JSON.stringify(body.variables.brackets) === JSON.stringify(pairRequests[0].variables.brackets)));
  assert.equal(value.positionDatasets[0].heroes[0].games, 303);
  assert.equal(value.positionDatasets[0].heroes[0].matchups[0].advantage, -.0529);
  assert.equal(value.positionDatasets[0].provenance.advantageMethod, 'stratz_native_synergy');
  assert.equal(value.positionDatasets[0].observedThrough, '2026-10-10T00:00:00.000Z');
  assert.deepEqual(value.positionDatasets[0].provenance.roleSampleDays, [...days].reverse());
  assert.ok(value.positionDatasets.every(data => Buffer.byteLength(JSON.stringify(data)) < MAX_RESPONSE_BYTES));
});

test('all-rank coverage is claimed only for a complete known enum population and is shared by period proof requests', async () => {
  const complete = draftContract(schema);
  assert.equal(complete.allRanksVerified, true);
  const proof = buildPairPeriodProof(pairPeriodContract(schema), { heroId: 52, sampleWeek: 2962, now: () => NOW });
  assert.deepEqual(proof.variables.pairProofBrackets, buildDraftQuery(complete, [52]).variables.brackets);
  for (const mode of ['missing', 'unknown']) {
    const modified = structuredClone(schema), rankType = modified.types.find(t => t.name === 'RankBracketBasicEnum');
    if (mode === 'missing') rankType.enumValues = rankType.enumValues.filter(value => value.name !== 'UNCALIBRATED');
    else rankType.enumValues.push({ name: 'NEW_POPULATION' });
    const contract = draftContract(modified);
    assert.equal(contract.allRanksVerified, false);
    assert.equal(buildDraftQuery(contract, [52]).variables.brackets, undefined);
    assert.equal(buildPairPeriodProof(pairPeriodContract(modified), { heroId: 52, sampleWeek: 2962, now: () => NOW }).variables.pairProofBrackets, undefined);
    const ids = [42, 52, 70];
    const value = await refreshStratzDraft({ token: 'unit-test-only-no-real-token', heroIds: ids, now: () => NOW, fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.query.includes('__schema')) return response({ __schema: modified });
      if (body.query.includes('winDay')) return response({ heroStats: rows(ids, [LATEST]) });
      return response({ heroStats: Object.fromEntries(ids.map(ownHeroId => [`h${ownHeroId}`, [{ heroId: ownHeroId, matchups: ids.filter(id => id !== ownHeroId).map(heroId => ({ ownHeroId, heroId, games: 100, wins: 50, nativeSynergy: 1, sampleWeek: 2962 })), synergies: [] }]])) });
    } });
    assert.equal(value.components.pairs.scope.rank, null);
    assert.equal(value.components.pairs.rankFiltered, false);
    assert.equal(value.provenance.pairRankCohorts, null);
    assert.match(value.scopeDescription, /фильтр рейтинга пар не задан/);
    assert.equal(value.positionDatasets[0].components.baseline.scope.rank, 'all'); // Independently verified nine-rank base.
    assert.equal(value.positionDatasets[0].components.pairs.scope.rank, null);
  }
});

test('a rolling API week cannot mix pair snapshots across batches or within one response', async () => {
  for (const mode of ['across', 'within']) {
    let pairCalls = 0;
    await assert.rejects(refreshStratzDraft({ token: 'unit-test-only-no-real-token', now: () => NOW, fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.query.includes('__schema')) return response({ __schema: schema });
      pairCalls++;
      const ids = Object.entries(body.variables).filter(([key]) => /^hero\d+$/.test(key)).map(([, id]) => id);
      return response({ heroStats: Object.fromEntries(ids.map((ownHeroId, i) => [`h${ownHeroId}`, [{ heroId: ownHeroId, matchups: IDS.filter(id => id !== ownHeroId).map(heroId => ({ ownHeroId, heroId, games: 100, wins: 50, nativeSynergy: 1, sampleWeek: mode === 'within' && i === 1 || mode === 'across' && pairCalls > 1 ? 2963 : 2962 })), synergies: [] }]])) });
    } }), error => error.code === 'INCONSISTENT_SAMPLE');
    assert.equal(pairCalls, mode === 'within' ? 1 : 2);
  }
});

test('absent week identifiers remain unverified and never acquire a download date or current patch', async () => {
  const ids = [42, 52, 70];
  const value = await refreshStratzDraft({ token: 'unit-test-only-no-real-token', heroIds: ids, now: () => NOW, fetch: async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.query.includes('__schema')) return response({ __schema: schema });
    if (body.query.includes('winDay')) return response({ heroStats: rows(ids, [LATEST]) });
    return response({ heroStats: Object.fromEntries(ids.map(ownHeroId => [`h${ownHeroId}`, [{ heroId: ownHeroId, matchups: ids.filter(id => id !== ownHeroId).map(heroId => ({ ownHeroId, heroId, games: 100, wins: 50, nativeSynergy: 1 })), synergies: [] }]])) });
  } });
  assert.deepEqual(value.provenance.pairWeekIds, []);
  assert.equal(value.provenance.pairPeriodConsistent, false);
  assert.equal(value.provenance.pairPeriodMethod, null);
  assert.equal(value.components.pairs.observedThrough, null);
  assert.equal(value.components.pairs.scope.patch, null);
});

test('authenticated public Unix-date roundtrip verifies the bucket boundaries without inventing the latest observed match', () => {
  const proof = buildPairPeriodProof(pairPeriodContract(schema), { heroId: 52, sampleWeek: 2962, rankId: 'HERALD_GUARDIAN', now: () => NOW });
  assert.deepEqual(proof.expected, roundtrip.expected);
  assert.equal(proof.variables.pairProofCurrentTime, 1791417600); // A Unix argument, never the returned Int bucket2962.
  assert.deepEqual(proof.variables.pairProofBrackets, ['HERALD_GUARDIAN']);
  assert.match(proof.fields, /pairProofRecent:winWeek/);
  const value = normalizePairPeriodProof(roundtrip.records, proof.expected, { now: () => NOW });
  assert.equal(value.periodStart, '2026-10-08T00:00:00.000Z');
  assert.equal(value.periodEndExclusive, '2026-10-15T00:00:00.000Z');
  assert.equal(value.periodPartial, true);
  assert.equal(value.periodBoundsVerified, true);
  assert.equal(value.periodMethod, 'stratz_unix_week_roundtrip');
  assert.equal(value.observedThrough, undefined);
  assert.equal(buildPairPeriodProof(pairPeriodContract(schema), { heroId: 52, sampleWeek: 5000, now: () => NOW }), null);
  const missingSchema = structuredClone(schema); missingSchema.types.find(t => t.name === 'HeroStatsQuery').fields = missingSchema.types.find(t => t.name === 'HeroStatsQuery').fields.filter(f => f.name !== 'winWeek');
  assert.equal(pairPeriodContract(missingSchema), null);
});

test('unverified or inconsistent period roundtrips cannot promote a native bucket to dates', () => {
  for (const change of [records => records.pairProofCurrent = [], records => records.pairProofBefore[0].matchups[0].sampleWeek = 2962, records => records.pairProofInside[0].matchups[0].ownHeroId = 42, records => records.pairProofRecent[0].week++, records => records.pairProofRecent.splice(1, 1)]) {
    const records = structuredClone(roundtrip.records); change(records);
    assert.equal(normalizePairPeriodProof(records, roundtrip.expected, { now: () => NOW }), null);
  }
  assert.equal(normalizePairPeriodProof({}, roundtrip.expected, { now: () => NOW }), null);
});

test('runtime proof shares the existing role request and attributes pair patch independently of its still unknown actual end', async () => {
  const ids = [42, 52, 70], requests = [], day = Date.parse('2026-10-10T00:00:00Z') / 1000;
  const value = await refreshStratzDraft({ token: 'unit-test-only-no-real-token', heroIds: ids, rankId: 'HERALD_GUARDIAN', now: () => NOW, fetch: async (url, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    if (body.query.includes('__schema')) return response({ __schema: schema });
    if (body.query.includes('winDay')) {
      const heroId = body.variables.pairProofHero;
      const proofRecords = structuredClone(roundtrip.records);
      for (const [key, values] of Object.entries(proofRecords)) {
        for (const entry of values) {
          entry.heroId = heroId;
          if (key !== 'pairProofRecent') for (const pair of [...entry.matchups, ...entry.synergies]) pair.ownHeroId = heroId;
        }
      }
      return response({ heroStats: { ...rows(ids, [day]), ...proofRecords }, constants: { gameVersions: [{ id: 190, name: '7.41f', asOfDateTime: day - 25 * DAY }] } });
    }
    return response({ heroStats: Object.fromEntries(ids.map(ownHeroId => [`h${ownHeroId}`, [{ heroId: ownHeroId, matchups: ids.filter(id => id !== ownHeroId).map(heroId => ({ ownHeroId, heroId, games: 100, wins: 50, nativeSynergy: 1, sampleWeek: 2962 })), synergies: [] }]])) });
  } });
  assert.equal(requests.length, 3);
  assert.match(requests[2].query, /pairProofCurrent:matchUp/);
  assert.match(requests[2].query, /pairProofRecent:winWeek/);
  const pairs = value.positionDatasets[0].components.pairs;
  assert.equal(pairs.periodBoundsVerified, true);
  assert.equal(pairs.periodPartial, true);
  assert.equal(pairs.periodStart, '2026-10-08T00:00:00.000Z');
  assert.equal(pairs.observedFrom, pairs.periodStart);
  assert.equal(pairs.observedThrough, null);
  assert.equal(pairs.scope.patch, '7.41f');
  assert.equal(pairs.scope.rank, 'HERALD_GUARDIAN');
  assert.equal(pairs.scope.role, null);
  assert.equal(pairs.patchMethod, 'verified_pair_period_inside_catalogue_version');
  assert.equal(value.positionDatasets[0].provenance.pairPeriodProof.authority, 'stratz_live_graphql_roundtrip');
  assert.equal(value.heroes[0].matchups[0].advantage, .01);
});

test('daily aggregation excludes partial today, stops at date gaps, and never counts duplicates or incomplete pages', () => {
  const today = Math.floor(NOW / 86400000) * DAY;
  const records = rows(IDS, [today, LATEST, LATEST - DAY, LATEST - 3 * DAY, LATEST - 20 * DAY]);
  const result = normalizeRoleBaselines(records, IDS, { now: () => NOW });
  assert.deepEqual(result[1].sampleDays, [LATEST - DAY, LATEST]);
  assert.equal(result[1].heroes[0].games, 202);
  const truncated = rows(IDS, [LATEST, LATEST - DAY]);
  truncated.p3 = truncated.p3.filter(row => row.day !== LATEST || row.heroId !== IDS[0]);
  const fallback = normalizeRoleBaselines(truncated, IDS, { now: () => NOW });
  assert.deepEqual(fallback[1].sampleDays, [LATEST - DAY]);
  const duplicate = rows(); duplicate.p1.push(duplicate.p1[0]);
  assert.throws(() => normalizeRoleBaselines(duplicate, IDS, { now: () => NOW }), /некорректная/);
  const none = rows(); none.p2.pop();
  assert.throws(() => normalizeRoleBaselines(none, IDS, { now: () => NOW }), /полного/);
});

test('daily window is limited to twelve common completed days and contains no mixed role periods', () => {
  const days = Array.from({ length: 15 }, (_, offset) => LATEST - offset * DAY);
  const value = normalizeRoleBaselines(rows(IDS, days), IDS, { now: () => NOW });
  assert.equal(value[1].sampleDays.length, 12);
  assert.equal(value[1].heroes[0].games, 1212);
  assert.ok([1, 2, 3, 4, 5].every(p => JSON.stringify(value[p].sampleDays) === JSON.stringify(value[1].sampleDays)));
});

test('verified latest patch boundaries trim old and crossing daily buckets rather than retaining a mixed patch base', () => {
  const records = rows(IDS, [LATEST, LATEST - DAY, LATEST - 2 * DAY, LATEST - 3 * DAY]);
  const value = normalizeRoleBaselines(records, IDS, { now: () => NOW, latestKnownGameVersion: { asOfDateTime: LATEST - 2 * DAY + DAY / 2 } });
  assert.deepEqual(value[1].sampleDays, [LATEST - DAY, LATEST]);
  assert.equal(value[1].heroes[0].games, 202);
  const midnight = normalizeRoleBaselines(records, IDS, { now: () => NOW, latestKnownGameVersion: { asOfDateTime: LATEST - 2 * DAY } });
  assert.deepEqual(midnight[1].sampleDays, [LATEST - 2 * DAY, LATEST - DAY, LATEST]);
  assert.throws(() => normalizeRoleBaselines(records, IDS, { now: () => NOW, latestKnownGameVersion: { asOfDateTime: LATEST + DAY } }), error => error.code === 'INCOMPLETE_SAMPLE');
});

test('a new patch without a complete role day still returns catalogue and native pair evidence with the baseline unavailable', async () => {
  const ids = [42, 52, 70], currentDay = Math.floor(NOW / 86400000) * DAY;
  const version = { id: 190, name: '7.41f', asOfDateTime: currentDay };
  const value = await refreshStratzDraft({ token: 'unit-test-only-no-real-token', heroIds: ids, now: () => NOW, fetch: async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.query.includes('__schema')) return response({ __schema: schema });
    if (body.query.includes('winDay')) return response({ heroStats: rows(ids, [currentDay, currentDay - DAY]), constants: { gameVersions: [version] } });
    return response({ heroStats: Object.fromEntries(ids.map(ownHeroId => [`h${ownHeroId}`, [{ heroId: ownHeroId, matchups: ids.filter(id => id !== ownHeroId).map(heroId => ({ ownHeroId, heroId, games: 100, wins: 50, nativeSynergy: 1, sampleWeek: 2962 })), synergies: [] }]])) });
  } });
  assert.equal(value.provenance.latestKnownGameVersion.name, '7.41f');
  assert.equal(value.provenance.roleBaselineError, 'NO_COMPLETE_CURRENT_PATCH_SAMPLE');
  assert.equal(value.components.baseline.unavailableReason, 'NO_COMPLETE_CURRENT_PATCH_SAMPLE');
  assert.equal(value.components.baseline.targetPatch, '7.41f');
  assert.equal(value.components.baseline.scope.patch, null);
  assert.equal(value.positionDatasets, undefined);
  assert.ok(value.heroes.every(hero => hero.games === 0 && hero.wins === 0 && !hero.baselineAvailable));
  assert.equal(value.heroes[0].matchups[0].advantage, .01);
  assert.equal(value.components.pairs.observedThrough, null);
  assert.equal(value.components.pairs.scope.patch, null);
});

test('native full catalogue caches stay below 3 MiB with realistic six-digit counters and retain source units', () => {
  const value = dataset(), samples = normalizeRoleBaselines(rows(), IDS, { now: () => NOW });
  const positioned = createPositionDatasets(value, samples)[0];
  assert.equal(positioned.heroes[0].matchups[0].advantage, -.051955);
  assert.equal(positioned.provenance.advantageMethod, 'stratz_native_synergy');
  assert.ok(Buffer.byteLength(JSON.stringify(positioned)) < MAX_RESPONSE_BYTES);
});

test('observed data date controls freshness and corrected caches outrank later legacy downloads', async t => {
  const parent = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'core-coach-native-source-'));
  const dataDir = path.join(root, 'data'), runtimeDir = path.join(root, 'runtime'); fs.mkdirSync(dataDir); fs.mkdirSync(runtimeDir);
  t.after(() => { assert.ok(root.startsWith(parent + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(dataDir, 'wraith-king.json'), JSON.stringify({ heroes: Object.fromEntries(IDS.map(id => [id, { id }])) }));
  const scope = { role: 'POSITION_1', rank: null, patch: null };
  const native = dataset({ updatedAt: new Date(NOW - 86400000).toISOString(), observedThrough: '2026-10-10T00:00:00.000Z', scope });
  const legacy = dataset({ scope, provenance: { roleFiltered: true, advantageMethod: 'pair_winrate_minus_same_corpus_hero_baseline' } });
  const saved = path.join(dataDir, 'draft-statistics-stratz-position-1.json');
  atomicWrite(saved, native); atomicWrite(path.join(runtimeDir, 'draft-statistics-stratz-position-1.json'), legacy);
  const service = createDraftSources({ dataDir, runtimeDir, now: () => NOW, getToken: () => 'unit-test-only-no-real-token', refreshStratz: async () => { throw new Error('outage'); }, refreshFallback: async () => { throw new Error('outage'); } });
  assert.equal(service.getData(1).provenance.advantageMethod, 'stratz_native_synergy');
  assert.equal(service.getState(1).observedThrough, native.observedThrough);
  assert.equal(service.getState(1).stale, true);
  assert.equal(service.getState(1).observationAgeDays, 4.5);
  const before = fs.readFileSync(saved, 'utf8'); assert.equal((await service.refresh({ force: true })).ok, false);
  assert.equal(fs.readFileSync(saved, 'utf8'), before);
  assert.equal(service.getData(1).provenance.advantageMethod, 'stratz_native_synergy');
});
