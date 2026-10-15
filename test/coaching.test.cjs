'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeGsi, recommend } = require('../src/core.cjs');
const { laneAdvice, postLaneAdvice } = require('../src/coaching.cjs');
const dataset = require('../data/wraith-king.json');
const NOW = 100000;
function state(extra = {}) {
  return { heroId: 42, heroName: 'npc_dota_hero_skeleton_king', isWraithKing: true, status: 'live', receivedAt: NOW, gameTime: 300, healthPercent: 85, manaPercent: 70, alive: true, level: 5, lastHits: 28, deaths: 0, inventory: [], abilities: [{ name: 'skeleton_king_hellfire_blast', level: 2, cooldown: 0, canCast: true }], ...extra };
}

test('GSI economy is actual observed net worth, never wallet gold or previous data', () => {
  const payload = { hero: { name: 'npc_dota_hero_skeleton_king', xpos: -123, ypos: 234 }, player: { gold: 500, net_worth: 4600, last_hits: 52, denies: 4, gpm: 450, xpm: 370, kills: 2, deaths: 1 } };
  const actual = normalizeGsi(payload);
  assert.equal(actual.netWorth, 4600); assert.equal(actual.lastHits, 52); assert.equal(actual.xpos, -123); assert.equal(actual.deaths, 1);
  const missing = normalizeGsi({ hero: payload.hero, player: { gold: 500 } }, actual);
  for (const key of ['netWorth', 'lastHits', 'denies', 'gpm', 'xpm', 'kills', 'deaths']) assert.equal(missing[key], null);
  const invalid = normalizeGsi({ hero: payload.hero, player: { net_worth: NaN, last_hits: '52', deaths: Infinity } });
  assert.equal(invalid.netWorth, null); assert.equal(invalid.lastHits, null); assert.equal(invalid.deaths, null);
  assert.equal(normalizeGsi({ ...payload, player: { ...payload.player, activity: 'spectating' } }).netWorth, null);
});

test('draft portraits never guess which heroes are the lane opponents', () => {
  const advice = laneAdvice(state(), dataset, { enemyHeroIds: [2, 101, 47, 26, 1] });
  assert.deepEqual(advice.opponents, []); assert.equal(advice.confidence, 0);
  const result = recommend(state(), dataset, { now: NOW, enemyHeroIds: [2, 101] });
  assert.notEqual(result.action.source, 'lane');
});

test('Axe plus Skywrath receives defensive advice explaining their combination', () => {
  const result = recommend(state(), dataset, { now: NOW, laneEnemyHeroIds: [2, 101], laneAllyHeroId: 26 });
  assert.equal(result.lane.style, 'defensive'); assert.equal(result.action.source, 'lane');
  assert.match(result.lane.reason, /Counter Helix/); assert.match(result.lane.reason, /Ancient Seal/);
  assert.match(result.lane.tips.join(' '), /Call/); assert.match(result.lane.tips.join(' '), /здоровье/);
});

test('Timbersaw rule avoids feeding Reactive Armor and unsupported skeleton instructions', () => {
  const result = laneAdvice(state(), dataset, { laneEnemyHeroIds: [98] });
  assert.equal(result.style, 'defensive'); assert.match(result.reason, /Reactive Armor/);
  assert.doesNotMatch(JSON.stringify(result), /скелет|заряд.*[246]/i);
});

test('Slardar offers only a conditional short aggression window with confirmed allied control and own resources', () => {
  const context = { laneEnemyHeroIds: [28], laneAllyHeroId: 26 };
  const result = laneAdvice(state({ kills: 2 }), dataset, context);
  assert.equal(result.style, 'aggressive'); assert.match(result.tips[0], /Если Lion рядом/); assert.match(result.tips[0], /готов/);
  assert.match(result.reason, /Bash of the Deep/);
  for (const modified of [{ healthPercent: 50 }, { manaPercent: null }, { abilities: [] }, { abilities: [{ name: 'skeleton_king_hellfire_blast', level: 1, cooldown: 0, canCast: null }] }]) assert.notEqual(laneAdvice(state(modified), dataset, context).style, 'aggressive');
  assert.notEqual(laneAdvice(state(), dataset, { laneEnemyHeroIds: [28] }).style, 'aggressive');
});

test('unknown lane hero does not inherit invented threats or an aggressive call', () => {
  const result = laneAdvice(state(), dataset, { laneEnemyHeroIds: [99999], laneAllyHeroId: 26 });
  assert.equal(result.style, 'balanced'); assert.equal(result.confidence, 0); assert.match(result.reason, /нет проверенного правила/);
});

test('immediate health, visible map danger and unavailable ultimate outrank lane plans', () => {
  const context = { now: NOW, enemyHeroIds: [2], laneEnemyHeroIds: [2], laneAllyHeroId: 26 };
  assert.match(recommend(state({ healthPercent: 20 }), dataset, context).action.title, /восстановись/);
  const vision = { capturedAt: NOW, quality: { usable: true }, minimap: { heroes: [{ id: 42, x: .5, y: .5, confidence: .95 }, { id: 2, x: .55, y: .55, confidence: .95 }] } };
  assert.equal(recommend(state(), dataset, { ...context, vision }).action.source, 'screen');
  assert.match(recommend(state({ abilities: [{ name: 'skeleton_king_reincarnation', level: 1, cooldown: 50 }] }), dataset, context).action.title, /без ультимейта/);
});

test('lost lane guides recovery at T2 without promising that unknown jungle is safe', () => {
  const result = postLaneAdvice(state({ gameTime: 700 }), dataset, { laneResult: 'lost', laneEnemyHeroIds: [2, 101], plan: 'farm' });
  assert.equal(result.result, 'lost'); assert.equal(result.confidence, 1); assert.match(result.reason, /Axe/);
  assert.match(result.priorities[0], /T2/); assert.match(result.priorities[0], /видимым врагам/); assert.match(result.priorities[1], /Доведи фармящий/);
  assert.equal(postLaneAdvice(state({ gameTime: 300 }), dataset, { laneResult: 'lost' }), null);
});

test('won lane avoids blind tower pressure and respects Radiance completion', () => {
  const result = postLaneAdvice(state({ gameTime: 700 }), dataset, { laneResult: 'won', plan: 'farm' });
  assert.match(result.priorities[0], /только вместе с командой и обзором/);
  assert.match(result.priorities[1], /Доведи Radiance/);
  const completed = postLaneAdvice(state({ gameTime: 700, inventory: [{ name: 'radiance' }] }), dataset, { laneResult: 'won', plan: 'farm' });
  assert.doesNotMatch(completed.priorities.join(' '), /Доведи Radiance/);
});

test('last-hit deficit alone never labels the lane as lost; valid ten-minute snapshot remains stable', () => {
  const result = postLaneAdvice(state({ gameTime: 700, deaths: 0 }), dataset, { farmAssessment: 'behind' });
  assert.equal(result.result, 'unknown'); assert.match(result.reason, /сам по себе не доказывает/);
  const context = { farmAssessment: 'ahead', laneSnapshot: { gameTime: 600, deaths: 3, farmAssessment: 'behind' } };
  const later = postLaneAdvice(state({ gameTime: 1500, deaths: 3 }), dataset, context);
  assert.equal(later.result, 'lost'); assert.ok(later.confidence < .6); assert.match(later.reason, /не доказательство/);
  assert.equal(postLaneAdvice(state({ gameTime: 1500, deaths: 0 }), dataset, { farmAssessment: 'ahead' }).result, 'unknown');
  assert.equal(postLaneAdvice(state({ gameTime: 700, deaths: 3 }), dataset, { ...context, laneResult: 'won' }).result, 'won');
});

test('specific item reasons name observed draft threats and BKB limitations', () => {
  const result = recommend(state({ gameTime: 1800, inventory: [{ name: 'phase_boots' }, { name: 'armlet' }, { name: 'radiance' }] }), dataset, { now: NOW, enemyHeroIds: [2, 101] });
  const bkb = [result.item, ...result.alternatives].find(item => item?.key === 'black_king_bar');
  assert.ok(bkb); assert.match(bkb.reason, /Skywrath Mage/); assert.match(bkb.reason, /Axe/); assert.match(bkb.reason, /проходить/);
});
