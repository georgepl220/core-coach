'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateDraft, CLOSE_SCORE_THRESHOLD } = require('../src/draft-coach.cjs');
const NOW = Date.UTC(2026, 9, 14, 12), DAY = 86400000;
const date = days => new Date(NOW - days * DAY).toISOString();
const scope = { patch: '7.41', rank: 'DIVINE_IMMORTAL', role: 'POSITION_1' };
const component = (days = 0, overrides = {}) => ({ observedFrom: date(days + 1), observedThrough: date(days),
  scope: { ...scope }, roleFiltered: true, patchFiltered: true, rankFiltered: true, schemaVerified: true, ...overrides });
const pair = (heroId, extra = {}) => ({ heroId, games: 1000, wins: 500, advantage: .04, ...extra });
const row = (heroId, extra = {}) => ({ heroId, games: 10000, wins: 5500, matchups: [pair(35)], synergies: [], ...extra });
function statistics(rows, extra = {}) {
  return { providerId: 'stratz', updatedAt: date(0), scope: { ...scope }, roleFiltered: true, pairRoleFiltered: true,
    provenance: { advantageMethod: 'stratz_native_synergy', roleFiltered: true, patchFiltered: true, rankFiltered: true, schemaVerified: true },
    components: { baseline: component(), pairs: component() }, heroes: rows, ...extra };
}
const evaluate = (stats, extra = {}) => evaluateDraft({ now: NOW, candidateHeroIds: [11], enemyHeroIds: [35], stats, ...extra });

test('a verified old weekly bound rejects pairs even with unknown final match time', () => {
  const stats = statistics([row(11)], { components: { baseline: component(), pairs: component(0, {
    observedThrough: null, periodBoundsVerified: true, periodMethod: 'stratz_unix_week_roundtrip',
    periodStart: date(39), periodEndExclusive: date(32), periodPartial: false,
  }) } });
  const result = evaluate(stats), hero = result.candidates[0];
  assert.ok(hero.scoreBreakdown.baseline > 0);
  assert.equal(hero.scoreBreakdown.enemies, 0);
  assert.equal(hero.dataFreshness.pairs.rejected, true);
  assert.match(result.notes.join(' '), /период закончился более 30 дней/);
});

test('raw reserve pair win rate is not presented as a corrected counterpick or synergy', () => {
  const stats = statistics([row(11, { matchups: [{ heroId:35, games:1000, wins:900 }], synergies: [{ heroId:20, games:1000, wins:900 }] })]);
  stats.providerId = 'opendota'; stats.provenance.advantageMethod = 'raw_pair_winrate';
  const result = evaluate(stats, { allyHeroIds:[20] }), hero = result.candidates[0];
  assert.ok(hero.scoreBreakdown.baseline > 0);
  assert.equal(hero.scoreBreakdown.enemies, 0);
  assert.equal(hero.scoreBreakdown.allies, 0);
  assert.equal(hero.pairCount, 0);
  assert.equal(hero.dataCoverage.enemies.rejected, 1);
  assert.equal(hero.dataCoverage.allies.rejected, 1);
  assert.match(result.notes.join(' '), /не используются как контрпики/);
});

test('fresh role WR cannot make independently stale or wrong-patch pairs current', () => {
  const fresh = evaluate(statistics([row(11)])).candidates[0];
  for (const pairs of [component(31), component(0, { patchMatchesCurrent: false })]) {
    const result = evaluate(statistics([row(11)], { components: { baseline: component(), pairs } })), hero = result.candidates[0];
    assert.equal(hero.baselineGames, 10000);
    assert.equal(hero.scoreBreakdown.baseline, fresh.scoreBreakdown.baseline);
    assert.equal(hero.scoreBreakdown.enemies, 0);
    assert.equal(hero.pairCount, 0);
    assert.equal(hero.dataFreshness.pairs.rejected, true);
    assert.equal(hero.dataFreshness.baseline.rejected, false);
    assert.equal(hero.dataCoverage.enemies.rejected, 1);
    assert.equal(result.statsStatus, 'used');
  }
});

test('fresh same-position native pairs remain independent from rejected old base WR', () => {
  const result = evaluate(statistics([row(11)], { components: { baseline: component(31), pairs: component() } }));
  const hero = result.candidates[0];
  assert.equal(hero.baselineWinRate, null);
  assert.equal(hero.baselineGames, 0);
  assert.equal(hero.scoreBreakdown.baseline, 0);
  assert.ok(hero.scoreBreakdown.enemies > 0);
  assert.equal(hero.dataCoverage.baseline.available, true);
  assert.equal(hero.dataCoverage.baseline.status, 'rejected');
  assert.equal(hero.dataFreshness.baseline.rejected, true);
  assert.equal(hero.dataFreshness.pairs.rejected, false);
  assert.equal(result.statsStatus, 'used');
});

test('general pairs do not establish selected-position suitability when its base is rejected', () => {
  const stats = statistics([row(11)], { pairRoleFiltered: false,
    components: { baseline: component(31), pairs: component(0, { roleFiltered: false, scope: { ...scope, role: null } }) } });
  const hero = evaluate(stats).candidates[0];
  assert.equal(hero.dataUsed, false);
  assert.equal(hero.score, null);
  assert.equal(hero.dataCoverage.enemies.rejected, 1);
});

test('fresh download never proves an unknown baseline or pair observation window fresh', () => {
  const stats = statistics([row(11)], { components: { baseline: component(0, { observedThrough: null }), pairs: component(0, { observedThrough: null }) } });
  const hero = evaluate(stats).candidates[0];
  for (const name of ['baseline', 'pairs']) {
    assert.equal(hero.dataFreshness[name].status, 'unknown');
    assert.equal(hero.dataFreshness[name].observedThrough, null);
    assert.equal(hero.dataFreshness[name].ageDays, null);
    assert.equal(hero.dataFreshness[name].weight, .5);
  }
  assert.equal(hero.confidence, 'low');
  const legacy = structuredClone(stats);
  delete legacy.components;
  const legacyHero = evaluate(legacy).candidates[0];
  assert.equal(legacyHero.dataFreshness.baseline.status, 'unknown');
  assert.equal(legacyHero.dataFreshness.pairs.status, 'unknown');
});

test('legacy role-day freshness belongs only to base WR, not unrelated pair weeks', () => {
  const stats = statistics([row(11)]);
  delete stats.components;
  stats.observedThrough = date(0);
  stats.provenance.roleSampleDay = Math.floor(NOW / 1000);
  stats.provenance.pairWeekIds = [2962];
  const hero = evaluate(stats).candidates[0];
  assert.equal(hero.dataFreshness.baseline.status, 'fresh');
  assert.equal(hero.dataFreshness.baseline.ageDays, 0);
  assert.equal(hero.dataFreshness.pairs.status, 'unknown');
  assert.equal(hero.dataFreshness.pairs.ageDays, null);
  assert.equal(hero.confidence, 'low');
});

test('currentPatch metadata never fills an unknown component patch or confirms its filters', () => {
  const unknown = { scope: { patch: null, rank: null, role: 'POSITION_1' }, patchFiltered: false, rankFiltered: false };
  const stats = statistics([row(11)], { currentPatch: '7.41',
    components: { baseline: component(0, unknown), pairs: component(0, unknown) } });
  const hero = evaluate(stats).candidates[0];
  assert.equal(hero.dataFreshness.baseline.scope.patch, null);
  assert.equal(hero.dataFreshness.pairs.scope.patch, null);
  assert.equal(hero.dataFreshness.baseline.patchFiltered, false);
  assert.equal(hero.dataFreshness.pairs.patchFiltered, false);
  assert.equal(hero.confidence, 'low');
});

test('scope explanation distinguishes verified all-rank role base from unknown pair filters', () => {
  const stats = statistics([row(11)], { scope: { patch: null, rank: null, role: 'POSITION_1' },
    pairRoleFiltered: false, components: {
      baseline: component(0, { scope: { patch: '7.41', rank: 'all', role: 'POSITION_1' },
        observedThroughKind: 'exclusive_period_end', observedUntilExclusive: date(0) }),
      pairs: component(0, { observedFrom: null, observedThrough: null, scope: { patch: null, rank: null, role: null },
        roleFiltered: false, patchFiltered: false, rankFiltered: false }),
    } });
  const result = evaluate(stats);
  assert.match(result.scopeLabel, /патч 7\.41 \(база\)/);
  assert.match(result.scopeLabel, /все рейтинги \(база\)/);
  assert.match(result.scopeLabel, /патч пар не подтверждён/);
  assert.match(result.scopeLabel, /рейтинг пар не подтверждён/);
  assert.doesNotMatch(result.scopeLabel, /патч null|рейтинг null/);
  assert.equal(result.candidates[0].dataFreshness.baseline.weight, 1);
  assert.equal(result.candidates[0].dataFreshness.baseline.observedThroughKind, 'exclusive_period_end');
  assert.equal(result.candidates[0].dataFreshness.baseline.observedUntilExclusive, date(0));
  assert.equal(result.candidates[0].dataFreshness.pairs.weight, .2);
});

test('each candidate distinguishes used, absent, small and invalid pair samples', () => {
  const stats = statistics([row(11, { matchups: [pair(35), pair(75, { games: 29, wins: 15 }), pair(99, { wins: 1001 })],
    synergies: [pair(5, { games: 40, wins: 20 })] })]);
  const hero = evaluate(stats, { enemyHeroIds: [35, 75, 99, 102], allyHeroIds: [5, 26] }).candidates[0];
  assert.deepEqual(hero.dataCoverage.enemies, { known: 4, used: 1, missing: 1, lowSample: 1, rejected: 1 });
  assert.deepEqual(hero.dataCoverage.allies, { known: 2, used: 1, missing: 1, lowSample: 0, rejected: 0 });
  assert.equal(hero.dataCoverage.baseline.used, true);
  assert.equal(hero.dataCoverage.baseline.games, 10000);
  assert.equal(hero.dataCoverage.knownPairs, 6);
  assert.equal(hero.dataCoverage.usedPairs, 2);
  assert.equal(hero.draftCoverage, 2 / 6);
  assert.equal(hero.sampleCount, 40);
});

test('rounded display ties sort by full precision rather than hero ID', () => {
  const result = evaluate(statistics([row(2, { wins: 5001, matchups: [] }), row(11, { wins: 5002, matchups: [] })]),
    { candidateHeroIds: [2, 11], enemyHeroIds: [] });
  const [better, next] = result.candidates;
  assert.equal(better.heroId, 11);
  assert.equal(next.heroId, 2);
  assert.equal(better.score, next.score);
  assert.ok(better.rawScore > next.rawScore);
  assert.equal(better.scoreBreakdown.total, better.rawScore);
  assert.ok(better.comparison.nearestGap > 0);
  assert.ok(better.comparison.nearestGap <= CLOSE_SCORE_THRESHOLD);
  assert.equal(better.comparison.status, 'unproven');
  assert.equal(better.comparison.method, 'score_gap_heuristic');
  assert.equal(better.comparison.closeScore, true);
  assert.ok(result.notes.some(note => /не доверительный интервал/.test(note)));
});

test('display saturation at 100 cannot erase underlying ordering precision', () => {
  const enemyHeroIds = [35, 75, 99, 102, 70];
  const rows = [2, 11].map(heroId => row(heroId, { games: 1000000, wins: heroId === 11 ? 901000 : 900000,
    matchups: enemyHeroIds.map(other => pair(other, { games: 1000000, wins: 500000, advantage: .15 })) }));
  const result = evaluate(statistics(rows), { candidateHeroIds: [2, 11], enemyHeroIds });
  assert.deepEqual(result.candidates.map(hero => hero.heroId), [11, 2]);
  assert.deepEqual(result.candidates.map(hero => hero.score), [100, 100]);
  assert.ok(result.candidates[0].rawScore > result.candidates[1].rawScore);
  assert.ok(result.candidates[0].scoreBreakdown.total > 100);
});
