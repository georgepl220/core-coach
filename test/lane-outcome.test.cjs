'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { newLaneOutcomeTrack, updateLaneOutcome, currentNetWorthBenchmark } = require('../src/lane-outcome.cjs');
const NOW = Date.parse('2026-10-12T16:00:00Z');

function state(gameTime, extra = {}) {
  return { status: 'live', isWraithKing: true, heroId: 42, matchId: 'match-1', gameTime, receivedAt: NOW + gameTime * 1000, lastHits: 50, level: 7, deaths: 0, kills: 0, netWorth: null, ...extra };
}
function update(track, gameTime, extra = {}, options = {}) {
  const current = state(gameTime, extra);
  return updateLaneOutcome(track, { state: current, now: current.receivedAt, ...options });
}
function history(rows, options = {}) {
  return rows.reduce((track, [time, extra]) => update(track, time, extra, options), newLaneOutcomeTrack());
}
const strong = [[360, { lastHits: 35, level: 6 }], [480, { lastHits: 50, level: 7 }], [600, { lastHits: 68, level: 8 }]];
const difficult = [[360, { lastHits: 13, level: 5 }], [480, { lastHits: 20, level: 5, deaths: 1 }], [600, { lastHits: 28, level: 6, deaths: 2 }]];

test('personal tempo supports all five carries without sharing history between heroes',()=>{
  for(const heroId of[8,18,44,48]){
    const result=history(strong.map(([time,extra])=>[time,{...extra,heroId,isWraithKing:false,isSupportedCarry:true}]));
    assert.equal(result.heroId,heroId);assert.equal(result.assessment.result,'won');
    const changed=update(result,605,{heroId:42,isWraithKing:true,isSupportedCarry:true});assert.equal(changed.samples.length,1);assert.equal(changed.assessment.result,'unknown');
  }
});

test('successful carry tempo requires independent farm and progression evidence', () => {
  const result = history(strong).assessment;
  assert.equal(result.result, 'won'); assert.equal(result.label, 'Успешная линия'); assert.equal(result.source, 'auto_metrics');
  assert.equal(result.complete, true); assert.equal(result.provisional, false); assert.ok(result.confidence < .75);
  assert.match(result.reason, /экономика соперников/i); assert.match(result.reason, /личном ориентире/);
  assert.deepEqual(result.evidence.map(point => point.group), ['economy', 'experience']);
});

test('difficult lane is an estimate from observed new deaths plus a farm deficit', () => {
  const result = history(difficult).assessment;
  assert.equal(result.result, 'lost'); assert.equal(result.label, 'Тяжёлая линия');
  assert.equal(result.evidence.find(point => point.type === 'observed_deaths').delta, 2);
  assert.doesNotMatch(result.reason, /враг.*нетвор|проиграл линию/);
});

test('low CS alone and a single kill never determine competitive outcomes', () => {
  const low = history([[360, { lastHits: 10, level: null, deaths: null }], [480, { lastHits: 18, level: null, deaths: null }], [600, { lastHits: 25, level: null, deaths: null, kills: 1 }]]).assessment;
  assert.equal(low.result, 'unknown'); assert.equal(low.supported, false); assert.equal(low.evidence.length, 1);
  const kill = history([[360, { lastHits: null, level: null }], [480, { lastHits: null, level: null }], [600, { lastHits: null, level: null, kills: 1 }]]).assessment;
  assert.equal(kill.result, 'unknown'); assert.equal(kill.evidence.length, 0);
});

test('two agreeing neutral metrics describe even tempo, without asserting an enemy comparison', () => {
  const result = history([[360, { lastHits: 28, level: 4 }], [480, { lastHits: 40, level: 5 }], [600, { lastHits: 50, level: 7 }]]).assessment;
  assert.equal(result.result, 'even'); assert.equal(result.label, 'Ровный темп'); assert.match(result.reason, /вклад саппорта неизвестны/);
});

test('conflicting strong level and repeated deaths abstain from a positive or negative label', () => {
  const result = history(strong.map(([time, row], index) => [time, { ...row, deaths: index }])).assessment;
  assert.equal(result.result, 'unknown'); assert.equal(result.supported, false); assert.equal(result.dataSufficient, true);
  assert.equal(result.label, 'Неоднозначная линия');
});

test('coverage requires three points and at least two observed minutes', () => {
  assert.equal(history(strong.slice(1)).assessment.supported, false);
  assert.equal(history([[520, { lastHits: 55, level: 6 }], [560, { lastHits: 60, level: 7 }], [600, { lastHits: 68, level: 8 }]]).assessment.supported, false);
  assert.equal(update(newLaneOutcomeTrack(), 120).assessment.supported, false);
});

test('health updates, duplicate packets, and frozen game clocks do not inflate coverage', () => {
  let track = update(newLaneOutcomeTrack(), 300, { lastHits: 25, level: 5 });
  const initial = state(300, { lastHits: 25, level: 5 });
  for (let seconds = 1; seconds <= 160; seconds++) track = updateLaneOutcome(track, { state: { ...initial, receivedAt: initial.receivedAt + seconds * 1000, health: 500 + seconds }, now: initial.receivedAt + seconds * 1000 });
  assert.equal(track.samples.length, 1); assert.equal(track.assessment.supported, false);
  track = updateLaneOutcome(track, { state: initial, now: initial.receivedAt });
  assert.equal(track.samples.length, 1);
});

test('freshness, pause, spectator and wrong hero suppress estimates without adding samples', () => {
  const original = history(strong);
  for (const extra of [{ isPaused: true }, { isSpectator: true }, { status: 'spectator' }, { isWraithKing: false }, { dataQuality: { hero: false } }]) {
    const next = update(original, 700, extra);
    assert.equal(next.assessment.result, 'unknown'); assert.equal(next.samples.length, original.samples.length);
  }
  const stale = updateLaneOutcome(original, { state: state(300), now: state(300).receivedAt + 16000 });
  assert.equal(stale.assessment.result, 'unknown'); assert.equal(stale.samples.length, 3); assert.equal(stale.finalizedAssessment.result, 'won');
  assert.equal(update(stale, 700).assessment.result, 'won');
  const future = updateLaneOutcome(original, { state: state(700), now: state(700).receivedAt - 1001 });
  assert.equal(future.assessment.result, 'unknown');
});

test('late attachment or missing ten-minute endpoint never reconstructs lane from late farm', () => {
  const late = update(newLaneOutcomeTrack(), 1500, { lastHits: 200, level: 18 });
  assert.equal(late.assessment.result, 'unknown'); assert.equal(late.assessment.complete, true); assert.match(late.assessment.reason, /поздний фарм/);
  const missing = update(history(strong.slice(0, 2)), 700, { lastHits: 95, level: 9 });
  assert.equal(missing.assessment.result, 'unknown'); assert.equal(missing.assessment.complete, true);
});

test('minute-ten conclusion remains stable after rotations and additional midgame deaths', () => {
  const initial = history(strong);
  const later = update(initial, 1800, { lastHits: 100, level: 12, deaths: 6 });
  assert.deepEqual(later.assessment, initial.assessment); assert.equal(later.samples.length, 3);
});

test('match change and real clock rewind reset the timeline including zero-to-live match IDs', () => {
  let track = history(strong);
  track = update(track, 60, { matchId: 'match-2', lastHits: 1, level: 1 });
  assert.equal(track.matchId, 'match-2'); assert.equal(track.samples.length, 1); assert.equal(track.assessment.result, 'unknown');
  const rewind = update(history(strong), 100, { lastHits: 7, level: 2 });
  assert.equal(rewind.samples.length, 1); assert.equal(rewind.finalizedAssessment, null);
  const newId = update(update(newLaneOutcomeTrack(), 300, { matchId: '0' }), 350, { matchId: 999 });
  assert.equal(newId.samples.length, 1); assert.equal(newId.matchId, '999');
});

test('pre-existing deaths do not become new laning losses and missing endpoint values do not carry forward', () => {
  const existing = history([[360, { lastHits: 10, level: null, deaths: 4 }], [480, { lastHits: 18, level: null, deaths: 4 }], [600, { lastHits: 25, level: null, deaths: 4 }]]).assessment;
  assert.equal(existing.result, 'unknown'); assert.ok(!existing.evidence.some(point => point.type === 'observed_deaths'));
  const missing = history([strong[0], strong[1], [600, { lastHits: null, level: null }]]).assessment;
  assert.equal(missing.result, 'unknown'); assert.equal(missing.evidence.length, 0);
});

test('personal targets are distinct from pro statistics and alter only the farm comparison', () => {
  const adjusted = history(strong, { farmTargets: { cs10: 80 } }).assessment;
  assert.equal(adjusted.result, 'unknown'); assert.equal(adjusted.evidence[0].target10, 80); assert.equal(adjusted.evidence[0].comparisonSource, 'personal_target');
});

test('net worth requires sufficient fresh carry metadata and a real total from GSI', () => {
  const provider = { heroId: 42, role: 'carry', status: 'available', patch: { verified: true }, fetchedAt: new Date(NOW).toISOString(), source: 'Fixture current carry sample', benchmarks: { netWorth: [{ minute: 10, p50: 4500, sampleSize: 12 }] } };
  assert.ok(currentNetWorthBenchmark(provider, NOW));
  for (const invalid of [{ ...provider, role: 'offlane' }, { ...provider, fetchedAt: new Date(NOW - 8 * 86400000).toISOString() }, { ...provider, patch: { verified: false } }, { ...provider, benchmarks: { netWorth: [{ minute: 10, p50: 4500, sampleSize: 3 }] } }]) assert.equal(currentNetWorthBenchmark(invalid, NOW), null);
  const noExact = history(strong.map(([time, row]) => [time, { ...row, gold: 6000, inventory: [{ name: 'radiance' }] }]), { proBuild: provider }).assessment;
  assert.ok(!noExact.evidence.some(point => point.type === 'exact_net_worth'));
  const sampled = history(strong.map(([time, row]) => [time, { ...row, netWorth: time === 600 ? 6100 : null }]), { proBuild: provider }).assessment;
  assert.equal(sampled.evidence.find(point => point.type === 'exact_net_worth').actual, 6100);
});

test('two farm measures remain one evidence group and cannot claim success without another signal', () => {
  const provider = { heroId: 42, role: 'carry', status: 'available', patch: { verified: true }, fetchedAt: new Date(NOW).toISOString(), source: 'Fixture', benchmarks: { netWorth: [{ minute: 10, p50: 4500, sampleSize: 12 }] } };
  const result = history(strong.map(([time, row]) => [time, { ...row, level: null, netWorth: 6500 }]), { proBuild: provider }).assessment;
  assert.equal(result.evidence.length, 2); assert.equal(result.result, 'unknown');
});

test('provisional direction can inform tempo but is not a finalized post-lane verdict', () => {
  const result = history([[240, { lastHits: 25, level: 3 }], [360, { lastHits: 40, level: 5 }], [480, { lastHits: 60, level: 7 }]]).assessment;
  assert.equal(result.result, 'won'); assert.equal(result.provisional, true); assert.equal(result.complete, false); assert.match(result.reason, /Предварительно/);
});
