'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { economyFor, coachingFor } = require('../src/coach.cjs');
const { normalizeGsi, recommend } = require('../src/core.cjs');
const dataset = require('../data/wraith-king.json');
const NOW = 100000;
function state(extra = {}) { return { heroId: 42, heroName: 'npc_dota_hero_skeleton_king', isWraithKing: true, status: 'live', receivedAt: NOW, gameTime: 600, healthPercent: 85, manaPercent: 70, alive: true, level: 7, lastHits: 50, deaths: 0, gold: 1000, dataQuality: { inventory: true }, inventory: [], abilities: [{ name: 'skeleton_king_hellfire_blast', level: 2, cooldown: 0, canCast: true }], ...extra }; }

test('economy distinguishes observed total, approximate inventory total and unknown values', () => {
  const exact = economyFor(state({ netWorth: 4750 }), dataset);
  assert.equal(exact.netWorth, 4750); assert.equal(exact.exact, true); assert.equal(exact.valueSource, 'GSI');
  const approximate = economyFor(state({ inventory: [{ name: 'phase_boots', slot: 'slot0' }] }), dataset);
  assert.equal(approximate.netWorth, 1000 + dataset.items.phase_boots.cost); assert.equal(approximate.exact, false); assert.match(approximate.valueCaveat, /курьера/);
  assert.equal(economyFor(state({ inventory: [] }), dataset).netWorth, null);
  assert.equal(economyFor(state({ inventory: [{ name: 'unknown_item', slot: 'slot0' }] }), dataset).netWorth, null);
  assert.equal(economyFor(state({ inventory: [{ name: 'phase_boots' }], dataQuality: { inventory: false } }), dataset).netWorth, null);
});

test('farm targets are editable personal checkpoints rather than fabricated pro statistics', () => {
  const at10 = economyFor(state(), dataset); assert.equal(at10.targetCs, 50); assert.equal(at10.csDelta, 0); assert.equal(at10.targetsSource, 'personal');
  assert.equal(at10.pace, 'on_track'); assert.equal(at10.benchmark10.lastHits, null);
  const at15 = economyFor(state({ gameTime: 900, lastHits: 90 }), dataset, { farmTargets: { cs10: 60, cs20: 160, cs30: 260 } });
  assert.equal(at15.targetCs, 110); assert.equal(at15.csDelta, -20); assert.equal(at15.pace, 'behind');
  const late = economyFor(state({ gameTime: 2400, lastHits: 250 }), dataset); assert.equal(late.targetCs, null); assert.equal(late.pace, 'unknown');
  const missing = economyFor(state({ gameTime: null, lastHits: null }), dataset); assert.equal(missing.targetCs, null); assert.equal(missing.csDelta, null);
});

test('historical checkpoint requires data close to the actual minute rather than later CS', () => {
  const economy = economyFor(state({ gameTime: 610, lastHits: 55 }), dataset, { history: [{ gameTime: 500, lastHits: 28 }, { gameTime: 600, lastHits: 50 }] });
  assert.equal(economy.checkpoint.minute, 20); assert.equal(economy.checkpoint.actualCs, null);
  const later = economyFor(state({ gameTime: 1801, lastHits: 231 }), dataset, { history: [{ gameTime: 1800, lastHits: 230 }] });
  assert.equal(later.checkpoint.actualCs, 230);
  const longMatch = economyFor(state({ gameTime: 2500, lastHits: 320 }), dataset, { history: [{ gameTime: 600, lastHits: 48 }, { gameTime: 1200, lastHits: 135 }, { gameTime: 1800, lastHits: 220 }] });
  assert.equal(longMatch.checkpoint10.actualCs, 48); assert.equal(longMatch.checkpoint20.actualCs, 135); assert.equal(longMatch.checkpoint30.actualCs, 220); assert.equal(longMatch.checkpoints.length, 3);
  assert.equal(economyFor(state({ gameTime: 700, lastHits: 70 }), dataset, { history: [{ gameTime: 1200, lastHits: 140 }] }).checkpoint20.actualCs, null);
});

test('real carry benchmark metadata remains separate from the personal target', () => {
  const proBuild = { heroId: 42, role: 'carry', source: 'Fixture parsed matches', sourceUrl: 'https://api.opendota.com/api', benchmarks: { lastHits: [{ minute: 10, p25: 40, p50: 65, p75: 75, sampleSize: 9 }], netWorth: [{ minute: 10, p50: 4800, sampleSize: 9 }] } };
  const economy = economyFor(state(), dataset, { proBuild }); assert.equal(economy.targetCs, 50); assert.equal(economy.benchmark10.lastHits.p50, 65); assert.equal(economy.benchmark10.lastHits.sampleSize, 9);
  assert.equal(economyFor(state(), dataset, { proBuild: { ...proBuild, role: 'offlane' } }).benchmark10.lastHits, null);
  assert.equal(economyFor(state(), dataset, { proBuild: { ...proBuild, benchmarks: { lastHits: [{ minute: 10, p50: 99 }] } } }).benchmark10.lastHits, null);
});

test('a single farm snapshot is insufficient; automatic outcome requires a completed timeline', () => {
  const recovery = coachingFor(state({ gameTime: 700, lastHits: 15, deaths: 3 }), dataset, { laneEnemyHeroIds: [2, 101], laneSnapshot: { gameTime: 600, deaths: 3, farmAssessment: 'behind' } });
  assert.equal(recovery.lane.outcome, 'unknown'); assert.equal(recovery.postLane.result, 'unknown'); assert.equal(recovery.postLane.economicPace, 'behind'); assert.match(recovery.postLane.title, /Темп ниже/);
  const won = coachingFor(state({ gameTime: 700, lastHits: 15, deaths: 3 }), dataset, { laneEnemyHeroIds: [2, 101], laneResult: 'won' });
  assert.equal(won.lane.outcome, 'won'); assert.equal(won.postLane.result, 'won'); assert.match(won.postLane.title, /успешной/);
  const lost = coachingFor(state({ gameTime: 700, lastHits: 70 }), dataset, { laneEnemyHeroIds: [2, 101], laneResult: 'lost' });
  assert.match(lost.postLane.reason, /Axe/); assert.match(lost.postLane.priorities[0], /T2/);
});

test('completed automatic assessment drives estimated post-lane plan; optional correction takes priority', () => {
  const assessment = { result: 'lost', label: 'Тяжёлая линия', confidence: .58, source: 'auto_metrics', supported: true, complete: true, provisional: false, reason: 'Наблюдались низкий фарм и две новых смерти; экономика соперников неизвестна.' };
  const result = coachingFor(state({ gameTime: 700 }), dataset, { laneResult: 'auto', laneEnemyHeroIds: [2, 101], laneOutcomeAssessment: assessment });
  assert.equal(result.lane.outcome, 'lost'); assert.equal(result.lane.outcomeSource, 'auto_metrics'); assert.equal(result.postLane.result, 'lost');
  assert.equal(result.postLane.estimated, true); assert.match(result.postLane.reason, /По доступным признакам/); assert.match(result.postLane.priorities[0], /T2/);
  const corrected = coachingFor(state({ gameTime: 700 }), dataset, { laneResult: 'won', laneOutcomeAssessment: assessment });
  assert.equal(corrected.lane.outcomeSource, 'manual'); assert.equal(corrected.postLane.result, 'won'); assert.equal(corrected.postLane.estimated, false);
  const provisional = coachingFor(state({ gameTime: 700, lastHits: 15, deaths: 3 }), dataset, { laneResult: 'auto', laneOutcomeAssessment: { ...assessment, provisional: true, complete: false } });
  assert.equal(provisional.postLane.result, 'unknown'); assert.equal(provisional.lane.outcome, 'unknown'); assert.match(provisional.postLane.reason, /не хватает истории/);
  const changedMatch = coachingFor(state({ gameTime: 700, matchId: 'new-match' }), dataset, { laneResult: 'auto', laneOutcomeAssessment: { ...assessment, matchId: 'old-match' } });
  assert.equal(changedMatch.postLane.result, 'unknown'); assert.equal(changedMatch.lane.outcome, 'unknown');
});

test('unknown automatic lane composition does not ask for mandatory manual entry', () => {
  const result = coachingFor(state({ gameTime: 300 }), dataset, { laneSource: 'unknown' });
  assert.equal(result.lane.title, 'Наблюдаю состав линии'); assert.doesNotMatch(result.lane.reason, /укажи|вручную|подтверди/i);
});

test('current visible group does not become the original lane or inherit its outcome', () => {
  const result = coachingFor(state({ gameTime: 1800 }), dataset, { laneSource: 'screen_current', laneEnemyHeroIds: [2, 22], laneAllyHeroId: 26, laneConfidence: .9, laneResult: 'won', laneOutcomeAssessment: { result: 'lost', source: 'auto_metrics', supported: true, complete: true, provisional: false } });
  assert.equal(result.lane.detectionSource, 'screen_current'); assert.equal(result.lane.outcome, 'unknown'); assert.equal(result.lane.outcomeSource, 'unknown'); assert.deepEqual(result.lane.outcomeAssessment, {});
  assert.equal(result.postLane, null); assert.equal(result.lane.planAfterLane, null);
  assert.match(result.lane.source, /исходный состав линии неизвестен/); assert.doesNotMatch(result.lane.source, /наблюдения миникарты/);
  assert.equal(result.stage.id, 'lategame'); assert.equal(result.stageAdvice.source, 'screen_current');
  assert.match(result.stageAdvice.mainReason, /Axe.*Zeus/); assert.match(result.stageAdvice.skillUseReason, /Lion.*станом/);
  assert.doesNotMatch(result.stageAdvice.mainReason, /успешной линии|тяжёлой линии/);
  assert.equal(result.economy.lastHits, 50);
});

test('demonstration lane explicitly labels sample heroes without claiming manual or screen confirmation', () => {
  const result = coachingFor(state({ gameTime: 300 }), dataset, { laneSource: 'demo', laneEnemyHeroIds: [28], laneAllyHeroId: 26, enemyHeroIds: [2, 101] });
  assert.equal(result.lane.detectionSource, 'demo'); assert.equal(result.lane.detectionStatus, 'demo');
  assert.match(result.lane.source, /Демонстрационный/); assert.doesNotMatch(result.lane.source, /Твой выбор|наблюдения миникарты/);
  assert.deepEqual(result.lane.opponents.map(hero => hero.id), [28]); assert.equal(result.lane.ally.id, 26);
  assert.equal(result.lane.evidence.find(point => point.type === 'lane_detection').source, 'demo');
  assert.equal(result.lane.evidence.find(point => point.type === 'ally_control').source, 'demo');
});

test('confirmed lane pair gives a concrete interaction while full draft never guesses the lane', () => {
  const combo = coachingFor(state({ gameTime: 300 }), dataset, { laneEnemyHeroIds: [2, 101], laneAllyHeroId: 26 });
  assert.equal(combo.lane.stance, 'defensive'); assert.match(combo.lane.reason, /Call.*Skywrath/); assert.match(combo.lane.reason, /Ancient Seal/);
  assert.match(combo.lane.tips[0], /один Call/);
  const draftOnly = coachingFor(state(), dataset, { enemyHeroIds: [2, 101, 47, 26, 1] }); assert.equal(draftOnly.lane.stance, 'unknown'); assert.deepEqual(draftOnly.lane.opponents, []);
  const unsupported = coachingFor(state(), dataset, { laneEnemyHeroIds: [2, 99999], laneAllyHeroId: 26 }); assert.equal(unsupported.lane.stance, 'unknown');
});

test('Dragon Knight, Magnus and PA produce distinct current-mechanic plans', () => {
  const dk = coachingFor(state(), dataset, { laneEnemyHeroIds: [49] }); assert.match(dk.lane.reason, /Breathe Fire/); assert.match(dk.lane.tips[0], /восстановление.*DK/);
  const magnus = coachingFor(state(), dataset, { laneEnemyHeroIds: [97] }); assert.match(magnus.lane.tips[0], /Skewer.*башне/);
  const pa = coachingFor(state(), dataset, { laneEnemyHeroIds: [44] }); assert.match(pa.lane.reason, /Immaterial/); assert.doesNotMatch(pa.lane.reason, /Blur.*уклонение/);
  const lowHp = coachingFor(state({ healthPercent: 40 }), dataset, { laneEnemyHeroIds: [44] }); assert.equal(lowHp.lane.stance, 'defensive'); assert.match(lowHp.lane.tips[0], /40%/);
});

test('actual current hero IDs do not mistake Muerta for Primal Beast', () => {
  assert.equal(dataset.heroes[137].name, 'npc_dota_hero_primal_beast'); assert.equal(dataset.heroes[138].name, 'npc_dota_hero_muerta');
  const primal = coachingFor(state(), dataset, { laneEnemyHeroIds: [137] }); assert.match(primal.lane.reason, /Onslaught/); assert.equal(primal.lane.stance, 'defensive');
  const muerta = coachingFor(state(), dataset, { laneEnemyHeroIds: [138] }); assert.match(muerta.lane.reason, /Dead Shot/); assert.doesNotMatch(muerta.lane.reason, /Trample|Primal/);
});

test('live GSI keeps actual resource amounts and does not invent ability mana costs', () => {
  const raw = { hero: { name: 'npc_dota_hero_skeleton_king', health: 700, max_health: 1000, mana: 120, max_mana: 300 }, player: { net_worth: 4200, last_hits: 49 }, abilities: { ability0: { name: 'skeleton_king_hellfire_blast', level: 2, mana_cost: 100 }, ability1: { name: 'skeleton_king_reincarnation', level: 1 } } };
  const normalized = normalizeGsi(raw); assert.equal(normalized.health, 700); assert.equal(normalized.mana, 120); assert.equal(normalized.abilities[0].manaCost, 100); assert.equal(normalized.abilities[1].manaCost, null);
});

const observedBuild = { heroId: 42, role: 'carry', status: 'available', source: 'Fixture current carry matches', sourceUrl: 'https://api.opendota.com/api/matches', sampleCount: 12, patch: { id: 60, name: '7.41' }, builds: [{ id: 'carry-route', matches: 4, sequence: [
  { key: 'tango', stage: 'start', timeSeconds: -50 }, { key: 'quelling_blade', stage: 'start', timeSeconds: -50 }, { key: 'boots', timeSeconds: 130 }, { key: 'phase_boots', timeSeconds: 300 }, { key: 'armlet', timeSeconds: 510 }, { key: 'radiance', timeSeconds: 1020 }, { key: 'black_king_bar', timeSeconds: 1450 }, { key: 'blink', timeSeconds: 1700 },
] }] };

test('observed carry sequence replaces outdated forced Power Treads and removes consumables/components', () => {
  const result = recommend(state({ gameTime: 120, lastHits: 10 }), dataset, { now: NOW, proBuild: observedBuild });
  assert.equal(result.item.key, 'phase_boots'); assert.equal(result.item.buildId, 'carry-route'); assert.equal(result.item.timingSeconds, 300);
  assert.match(result.item.source, /carry/); assert.equal(result.item.sampleCount, 4); assert.ok([result.item, ...result.alternatives].every(item => !['tango', 'quelling_blade', 'boots', 'power_treads'].includes(item.key)));
  const owned = recommend(state({ inventory: [{ name: 'phase_boots' }, { name: 'armlet' }] }), dataset, { now: NOW, proBuild: observedBuild });
  assert.equal(owned.item.key, 'radiance');
});

test('draft capability alone does not reorder sampled route, confirmed current threat can', () => {
  const s = state({ gameTime: 1000, inventory: [{ name: 'phase_boots' }, { name: 'armlet' }] });
  const context = { now: NOW, proBuild: observedBuild, enemyHeroIds: [2, 101] };
  assert.equal(recommend(s, dataset, context).item.key, 'radiance');
  const currentThreat = recommend(s, dataset, { ...context, threats: { magic: true } }); assert.equal(currentThreat.item.key, 'black_king_bar'); assert.equal(currentThreat.item.override, true); assert.match(currentThreat.item.reason, /Axe/); assert.match(currentThreat.item.reason, /Skywrath/);
  const laneOnly = recommend(s, dataset, { now: NOW, proBuild: observedBuild, laneEnemyHeroIds: [2, 101], threats: { magic: true } }); assert.match(laneOnly.item.reason, /Skywrath/);
});

test('unavailable/offlane build falls back without presenting it as carry data and complete route stops', () => {
  const unavailable = recommend(state(), dataset, { now: NOW, proBuild: { ...observedBuild, status: 'manual_only' } }); assert.doesNotMatch(unavailable.item.source, /Fixture current/);
  const offlane = recommend(state(), dataset, { now: NOW, proBuild: { ...observedBuild, role: 'offlane' } }); assert.doesNotMatch(offlane.item.source, /Fixture current/);
  const complete = recommend(state({ inventory: [{ name: 'phase_boots' }, { name: 'armlet' }, { name: 'radiance' }, { name: 'black_king_bar' }, { name: 'blink' }] }), dataset, { now: NOW, proBuild: observedBuild }); assert.equal(complete.item, null);
});

test('real carry dataset skips obsolete early wand and selects an existing fight route', () => {
  const actual = require('../data/d2pt-wraith-king.json');
  const baseline = recommend(state({ gameTime: 2100, inventory: [{ name: 'phase_boots' }, { name: 'radiance' }, { name: 'blink' }] }), dataset, { now: NOW, proBuild: actual });
  assert.equal(baseline.item.buildId, 'radiance-blink'); assert.equal(baseline.item.key, 'desolator'); assert.notEqual(baseline.item.key, 'magic_wand');
  const fighting = recommend(state({ gameTime: 800, inventory: [{ name: 'phase_boots' }] }), dataset, { now: NOW, proBuild: actual, plan: 'fight' });
  assert.equal(fighting.item.buildId, 'armlet-desolator'); assert.ok(actual.builds.some(build => build.id === fighting.item.buildId));
  const explicit = recommend(state(), dataset, { now: NOW, proBuild: actual, plan: 'fight', buildId: 'radiance-blink' }); assert.equal(explicit.item.buildId, 'radiance-blink');
});

test('contextual matchup rule moves protection before more damage after repeated deaths, not from draft alone', () => {
  const s = state({ gameTime: 1500, inventory: [{ name: 'phase_boots' }, { name: 'armlet' }, { name: 'radiance' }] });
  const context = { now: NOW, proBuild: observedBuild, enemyHeroIds: [2, 101] };
  assert.equal(recommend(s, dataset, context).item.override, false);
  const protection = recommend({ ...s, deaths: 2 }, dataset, context); assert.equal(protection.item.key, 'black_king_bar'); assert.equal(protection.item.overrideType, 'spell_protection');
  assert.match(protection.item.reason, /2 смерт/); assert.match(protection.item.reason, /причина неизвестна/); assert.match(protection.item.reason, /Axe/); assert.match(protection.item.reason, /Skywrath/);
  assert.match(protection.item.source, /Правило/);
  const singleHero = recommend({ ...s, deaths: 2 }, dataset, { ...context, enemyHeroIds: [101] }); assert.equal(singleHero.item.override, false);
  const early = recommend({ ...s, gameTime: 500, deaths: 2 }, dataset, context); assert.equal(early.item.override, false);
});

test('Slardar and a physical carry change late protection with a concrete contextual explanation', () => {
  const s = state({ gameTime: 1700, deaths: 2, inventory: [{ name: 'phase_boots' }, { name: 'armlet' }, { name: 'radiance' }, { name: 'black_king_bar' }] });
  const armor = recommend(s, dataset, { now: NOW, proBuild: observedBuild, enemyHeroIds: [28, 35] }); assert.equal(armor.item.key, 'assault'); assert.equal(armor.item.overrideType, 'physical_protection');
  assert.match(armor.item.reason, /Slardar/); assert.match(armor.item.reason, /Sniper/); assert.match(armor.item.reason, /союзник/);
});
