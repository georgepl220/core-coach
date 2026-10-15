'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateDraft } = require('../src/draft-coach.cjs');
const NOW = Date.parse('2026-10-15T12:00:00Z');
const scope = { patch: '7.41f', rank: 'DIVINE_IMMORTAL', role: null };
function component(overrides = {}) {
  return { observedFrom: '2026-10-13T00:00:00Z', observedThrough: '2026-10-14T00:00:00Z',
    scope: { ...scope }, roleFiltered: false, patchFiltered: true, rankFiltered: true, schemaVerified: true, ...overrides };
}
function statistics(overrides = {}) {
  return { providerId: 'stratz', updatedAt: '2026-10-15T00:00:00Z', scope: { ...scope },
    components: { baseline: component(), pairs: component() },
    provenance: { roleFiltered: false, pairRoleFiltered: false, advantageMethod: 'stratz_native_synergy' },
    heroes: [{ heroId: 42, games: 0, wins: 0, baselineAvailable: false,
      matchups: [{ heroId: 35, games: 2000, wins: 1700, advantage: .1 }], synergies: [] }], ...overrides };
}
function evaluate(stats, extra = {}) { return evaluateDraft({ stats, now: NOW, positionId: 2, enemyHeroIds: [35], ...extra }); }
const wk = result => result.candidates.find(row => row.heroId === 42);

test('generic diagnostics keep broad native effects without claiming selected-position observations', () => {
  const result = evaluate(statistics());
  assert.equal(result.requirePositionData, false);
  assert.ok(wk(result).score > 50);
  assert.equal(wk(result).pairCount, 1);
  assert.equal(wk(result).hasPositionData, false);
  assert.equal(wk(result).roleFiltered, false);
  assert.equal(wk(result).matchupEvidence[0].scopeWeight, 1);
});

test('strict selected-position picker keeps entire catalog but no recommendation from broad-only effects', () => {
  for (const positionId of [1, 2, 3, 4, 5]) {
    const result = evaluate(statistics(), { positionId, requirePositionData: true });
    assert.equal(result.requirePositionData, true);
    assert.equal(result.catalogCount, 127);
    assert.equal(result.candidateCount, 126); // Sniper already picked.
    assert.equal(result.recommendations.length, 0);
    assert.equal(result.coverageCount, 0);
    assert.equal(result.statsStatus, 'no_data');
    assert.equal(wk(result).score, null);
    assert.equal(wk(result).rawScore, null);
    assert.equal(wk(result).scoreBreakdown, null);
    assert.equal(wk(result).dataCoverage.enemies.used, 0);
    assert.equal(wk(result).dataCoverage.enemies.rejected, 1);
    assert.equal(wk(result).hasPositionData, false);
    assert.match(wk(result).reasons[0], new RegExp(`позиции ${positionId}`));
    assert.match(result.summary, new RegExp(`статистику позиции ${positionId}`));
  }
});

test('a global hero WR is not position evidence even with ample wins and a large native counter', () => {
  const stats = statistics();
  stats.heroes[0] = { ...stats.heroes[0], games: 10000, wins: 6500, baselineAvailable: true };
  const strict = evaluate(stats, { requirePositionData: true }), generic = evaluate(stats);
  assert.ok(wk(generic).score > 50);
  assert.equal(wk(strict).score, null);
  assert.equal(wk(strict).baselineWinRate, null);
  assert.equal(wk(strict).dataCoverage.baseline.available, true);
  assert.equal(wk(strict).dataCoverage.baseline.used, false);
  assert.equal(wk(strict).dataCoverage.baseline.status, 'position_unverified');
  assert.equal(wk(strict).dataCoverage.enemies.rejected, 1);
});

test('verified selected-position base keeps the current formula and quarter-weight broad pairs', () => {
  const stats = statistics();
  stats.scope.role = 'POSITION_2';
  stats.components.baseline = component({ scope: { ...scope, role: 'POSITION_2' }, roleFiltered: true });
  stats.heroes[0] = { ...stats.heroes[0], games: 10000, wins: 5500, baselineAvailable: true };
  const strict = wk(evaluate(stats, { requirePositionData: true })), generic = wk(evaluate(stats));
  assert.equal(strict.hasPositionData, true);
  assert.equal(strict.dataUsed, true);
  assert.equal(strict.rawScore, generic.rawScore);
  assert.deepEqual(strict.scoreBreakdown, generic.scoreBreakdown);
  assert.equal(strict.baselineGames, 10000);
  assert.equal(strict.matchupEvidence[0].scopeWeight, .25);
});

test('verified same-position native effects can support a recommendation without a base WR', () => {
  const stats = statistics();
  stats.components.pairs = component({ scope: { ...scope, role: 'POSITION_2' }, roleFiltered: true });
  stats.provenance.pairRoleFiltered = true;
  const result = evaluate(stats, { requirePositionData: true }), rec = wk(result);
  assert.equal(rec.hasPositionData, true);
  assert.equal(rec.dataUsed, true);
  assert.ok(rec.score > 50);
  assert.equal(rec.baselineGames, 0);
  assert.equal(rec.scoreBreakdown.baseline, 0);
  assert.equal(rec.pairCount, 1);
  assert.equal(rec.pairRoleFiltered, true);
  assert.equal(rec.matchupEvidence[0].roleFiltered, true);
  assert.equal(rec.roleFitLabel, 'Есть статистика выбранной позиции');
});

test('generic pair rows cannot borrow a position flag from their surrounding dataset', () => {
  const stats = statistics();
  stats.components.pairs = component({ scope: { ...scope, role: 'POSITION_2' }, roleFiltered: true });
  stats.provenance.pairRoleFiltered = true;
  stats.heroes[0].matchups[0].roleFiltered = false;
  const rec = wk(evaluate(stats, { requirePositionData: true }));
  assert.equal(rec.score, null);
  assert.equal(rec.pairCount, 0);
  assert.equal(rec.dataCoverage.enemies.rejected, 1);
});

test('observed estimated-position counts remain usable with an explicit estimated label', () => {
  const stats = statistics({ providerId: 'opendota' });
  stats.scope.role = 'POSITION_2';
  stats.components.baseline = component({ scope: { ...scope, role: 'POSITION_2' }, roleFiltered: false, positionEstimated: true });
  stats.heroes[0] = { ...stats.heroes[0], games: 1000, wins: 550, baselineAvailable: true };
  const rec = wk(evaluate(stats, { requirePositionData: true }));
  assert.equal(rec.dataUsed, true);
  assert.equal(rec.hasPositionData, true);
  assert.equal(rec.positionEstimated, true);
  assert.equal(rec.roleFiltered, false);
  assert.equal(rec.confidence, 'low');
  assert.equal(rec.matchupEvidence[0].scopeWeight, .25);
});
