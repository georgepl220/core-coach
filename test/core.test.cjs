'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeGsi, recommend } = require('../src/core.cjs');
const NOW = 100000;
const dataset = {
  heroId: 42,
  source: 'Fixture OpenDota counts',
  items: {
    power_treads: { id: 63, dname: 'Power Treads', cost: 1400, components: ['boots', 'gloves', 'belt'] },
    boots: { id: 29, cost: 500 }, gloves: { id: 25, cost: 450 }, belt: { id: 12, cost: 450 },
    armlet: { id: 112, dname: 'Armlet', cost: 2500 },
    radiance: { id: 137, dname: 'Radiance', cost: 4700, components: ['relic', 'talisman_of_evasion'] },
    relic: { id: 54, cost: 3400 }, talisman_of_evasion: { id: 32, cost: 1300 },
    desolator: { id: 168, dname: 'Desolator', cost: 3500, components: ['mithril_hammer', 'mithril_hammer', 'blight_stone'] },
    mithril_hammer: { id: 8, cost: 1600 }, blight_stone: { id: 240, cost: 300 },
    black_king_bar: { id: 116, dname: 'Black King Bar', cost: 4050 },
    blink: { id: 1, dname: 'Blink Dagger', cost: 2250 },
    assault: { id: 112, dname: 'Assault Cuirass', cost: 5125 },
    abyssal_blade: { id: 208, dname: 'Abyssal Blade', cost: 6250 },
    quelling_blade: { id: 11, cost: 100 }, tango: { id: 44, cost: 90 }, branches: { id: 16, cost: 50 },
  },
  heroes: { 1: { id: 1, localizedName: 'Anti-Mage' }, 12: { id: 12, localized_name: 'Phantom Lancer' }, 26: { id: 26, localizedName: 'Lion' }, 28: { id: 28, localizedName: 'Slardar' }, 35: { id: 35, localizedName: 'Sniper' }, 42: { id: 42, localizedName: 'Wraith King' }, 57: { id: 57, localizedName: 'Omniknight' } },
  popularity: { start_game_items: {}, early_game_items: {}, mid_game_items: { 137: 63, 168: 12 }, late_game_items: {} },
};
function raw(extra = {}) { return { map: { clock_time: 1200, game_state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS' }, player: { team_name: 'radiant', gold: 1000 }, hero: { id: 42, name: 'npc_dota_hero_skeleton_king', alive: true, health_percent: 80, mana_percent: 70 }, items: { slot0: { name: 'item_power_treads', cooldown: 0 } }, abilities: {}, ...extra }; }
function state(extra = {}) { return { ...normalizeGsi(raw()), receivedAt: NOW, ...extra }; }
function advice(extraState = {}, context = {}, data = dataset) { return recommend(state(extraState), data, { now: NOW, ...context }); }
function vision(heroes, extra = {}) { return { capturedAt: NOW, quality: { usable: true }, minimap: { heroes }, ...extra }; }
function screenContext(extra = {}) { return { now: NOW, laneSource: 'screen_current', laneEnemyHeroIds: [2, 22], laneAllyHeroId: 26, laneConfidence: .9, laneObservedAt: NOW, screenPlayer: { heroId: 42, team: 'radiant', confirmed: true, source: 'selected_hud', observedAt: NOW }, ...extra }; }
const SELF = { id: 42, x: .5, y: .5, confidence: .95 };
const ENEMY = { id: 26, x: .6, y: .6, confidence: .95 };
const ALLY = { id: 57, x: .45, y: .5, confidence: .95 };

test('normalizes name-only WK identity and incomplete percentages safely', () => {
  const s = normalizeGsi(raw({ hero: { name: 'npc_dota_hero_skeleton_king', health: 250, max_health: 1000, mana: 0, max_mana: 0 } }));
  assert.equal(s.heroId, 42); assert.equal(s.isWraithKing, true); assert.equal(s.healthPercent, 25); assert.equal(s.manaPercent, null);
});
test('uses the displayed match clock for stages rather than engine elapsed time', () => {
  const s = normalizeGsi(raw({ map: { clock_time: 519, game_time: 709, game_state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS' } }));
  assert.equal(s.gameTime, 519);
  assert.equal(recommend({ ...s, receivedAt: NOW }, dataset, { now: NOW }).stage.id, 'laning');
});
test('preserves zero and negative match clocks and falls back only when clock is absent or invalid', () => {
  for (const clock_time of [0, -35]) {
    const s = normalizeGsi(raw({ map: { clock_time, game_time: 900 } }));
    assert.equal(s.gameTime, clock_time);
  }
  for (const clock_time of [undefined, null, '519', Infinity, NaN]) {
    assert.equal(normalizeGsi(raw({ map: { clock_time, game_time: 519 } })).gameTime, 519);
  }
  assert.equal(normalizeGsi(raw({ map: {} })).gameTime, null);
});
test('different selected-unit object or string is never treated as WK', () => {
  for (const selected_unit of [{ id: 35, name: 'npc_dota_hero_sniper' }, 'npc_dota_hero_sniper']) {
    const s = normalizeGsi(raw({ hero: { id: 42, name: 'npc_dota_hero_skeleton_king', selected_unit } }));
    assert.equal(s.isWraithKing, false); assert.equal(s.status, 'wrong_hero');
    assert.equal(recommend({ ...s, receivedAt: NOW }, dataset, { now: NOW }).item, null);
  }
});
test('contradictory ID/name and externally inconsistent WK flag are rejected', () => {
  assert.equal(normalizeGsi(raw({ hero: { id: 42, name: 'npc_dota_hero_sniper' } })).isWraithKing, false);
  assert.equal(advice({ heroId: 35, isWraithKing: true }).item, null);
});
test('previous complete payload does not fill missing fields in new snapshot', () => {
  const previous = normalizeGsi(raw());
  const s = normalizeGsi({ hero: { name: 'npc_dota_hero_skeleton_king' } }, previous);
  assert.equal(s.gold, null); assert.equal(s.alive, null); assert.equal(s.healthPercent, null); assert.deepEqual(s.inventory, []);
  assert.equal(recommend({ ...s, receivedAt: NOW }, dataset, { now: NOW }).item, null);
});
test('unknown, missing-inventory and unknown-time states omit item advice', () => {
  assert.equal(recommend({}, dataset, { now: NOW }).item, null);
  assert.equal(advice({ inventory: undefined }).item, null);
  assert.equal(advice({ dataQuality: { inventory: false } }).item, null);
  assert.equal(advice({ gameTime: null }).item, null);
});
test('spectator activity and nested observer shape block all advice', () => {
  for (const payload of [raw({ player: { activity: 'spectating' } }), raw({ hero: { team2: { player0: { id: 42 } } } })]) {
    const s = normalizeGsi(payload), result = recommend({ ...s, receivedAt: NOW }, dataset, { now: NOW });
    assert.equal(s.isSpectator, true); assert.equal(result.item, null); assert.match(result.action.title, /наблюдателя/);
  }
});
test('stale, future-timestamp, paused and pregame states cannot drive item purchases', () => {
  for (const changed of [{ receivedAt: NOW - 15001 }, { receivedAt: NOW + 1001 }, { isPaused: true }, { gameState: 'DOTA_GAMERULES_STATE_HERO_SELECTION' }]) assert.equal(advice(changed).item, null);
});
test('wrong dataset cannot drive item advice', () => {
  assert.equal(advice({}, {}, { ...dataset, heroId: 35 }).item, null);
  assert.equal(advice({}, {}, { heroId: 42, items: {} }).item, null);
});

test('confirmed selected HUD preserves static nearby matchup without inventing personal state', () => {
  const result = recommend({}, require('../data/wraith-king.json'), screenContext({ history: [{ gameTime: 600, lastHits: 80 }], laneResult: 'won', laneSnapshot: { gameTime: 600, lastHits: 80 } }));
  assert.deepEqual(result.lane.opponents.map(hero => hero.id), [2, 22]);
  assert.equal(result.lane.ally.id, 26); assert.equal(result.lane.detectionSource, 'screen_current');
  assert.match(result.stageAdvice.skillUseReason, /Lion.*Hex.*станом/);
  assert.match(result.stageAdvice.skillUseReason, /проверь в игре/);
  assert.equal(result.stage.id, 'unknown'); assert.equal(result.phase, 'unknown'); assert.equal(result.screenOnly, true);
  assert.equal(result.item, null); assert.deepEqual(result.alternatives, []); assert.equal(result.skills.next, null); assert.equal(result.skills.status, 'unavailable');
  for (const key of ['netWorth', 'lastHits', 'deaths', 'gpm', 'xpm', 'targetCs', 'csDelta']) assert.equal(result.economy[key], null, key);
  assert.equal(result.economy.checkpoint10.actualCs, null); assert.equal(result.lane.outcome, 'unknown'); assert.equal(result.postLane, null);
  assert.equal(result.action.source, 'screen_current'); assert.doesNotMatch(result.action.reason, /Вернись к своему герою/);
});

test('stale or paused personal packets cannot supply resources to static screen advice', () => {
  for (const changed of [{ receivedAt: NOW - 15001 }, { isPaused: true }]) {
    const result = recommend(state({ ...changed, lastHits: 80, netWorth: 5000, healthPercent: 20, abilities: [{ name: 'skeleton_king_hellfire_blast', level: 2, cooldown: 0, canCast: true }] }), require('../data/wraith-king.json'), screenContext());
    assert.deepEqual(result.lane.opponents.map(hero => hero.id), [2, 22]);
    assert.equal(result.item, null); assert.equal(result.skills.next, null); assert.equal(result.economy.netWorth, null); assert.equal(result.economy.lastHits, null);
    assert.doesNotMatch(result.lane.tips.join(' '), /здоровье 20%/);
    assert.equal(result.action.tone, 'neutral');
  }
});

test('screen fallback needs current verified own HUD and respects fresh contradictory GSI', () => {
  const proof = screenContext().screenPlayer;
  const invalidContexts = [
    { laneSource: 'screen_scene' }, { screenPlayer: null },
    { screenPlayer: { ...proof, source: 'minimap' } }, { screenPlayer: { ...proof, confirmed: false } },
    { screenPlayer: { ...proof, heroId: 35 } }, { screenPlayer: { ...proof, team: 'enemy' } },
    { screenPlayer: { ...proof, observedAt: NOW - 8001 } }, { screenPlayer: { ...proof, observedAt: NOW + 1001 } },
  ];
  for (const invalid of invalidContexts) assert.equal(recommend({}, dataset, screenContext(invalid)).lane, undefined);
  for (const changed of [{ heroId: 35, heroName: 'npc_dota_hero_sniper', isWraithKing: false }, { isSpectator: true, status: 'spectator' }, { team: 'dire' }]) {
    const result = recommend(state(changed), dataset, screenContext());
    assert.equal(result.screenOnly, undefined);
    // A team contradiction with otherwise valid GSI may keep personal advice,
    // but cannot activate the screen-only identity fallback.
    if (changed.team === undefined) assert.equal(result.lane, undefined);
  }
  const waitingPacket = recommend({ receivedAt: NOW, status: 'waiting', isWraithKing: false }, dataset, screenContext());
  assert.equal(waitingPacket.screenOnly, true);
  const oldOtherHero = recommend(state({ receivedAt: NOW - 15001, heroId: 35, heroName: 'npc_dota_hero_sniper', isWraithKing: false }), dataset, screenContext());
  assert.equal(oldOtherHero.screenOnly, true);
});
test('draft matchup changes priority ahead of the small purchase-frequency prior', () => {
  const before = advice(); assert.equal(before.item.key, 'radiance');
  const after = advice({}, { enemyHeroIds: [26], draftSource: 'manual' });
  assert.equal(after.item.key, 'black_king_bar'); assert.equal(after.matchup.threats.control, true); assert.equal(after.matchup.threats.magic, true);
  assert.match(after.matchup.source, /вручную/); assert.equal(after.matchup.details[0].name, 'Lion'); assert.ok(after.matchup.confidence <= .8);
  const skewed = { ...dataset, popularity: { mid_game_items: { 137: 1000000000 } } };
  assert.equal(advice({}, { enemyHeroIds: [26] }, skewed).item.key, 'black_king_bar');
});
test('unknown heroes lower draft coverage rather than generating capabilities', () => {
  const result = advice({}, { enemyHeroIds: [26, 99999] });
  assert.equal(result.matchup.details.length, 1); assert.equal(result.matchup.confidence, .4);
  const unknown = advice({}, { enemyHeroIds: [99999] }); assert.equal(unknown.matchup.confidence, 0); assert.equal(unknown.matchup.threats.magic, false);
});
test('physical matchup raises armor option in late game and illusions raise area damage', () => {
  const late = advice({ gameTime: 1900, inventory: [{ name: 'power_treads' }, { name: 'radiance' }, { name: 'black_king_bar' }] }, { enemyHeroIds: [28, 35] });
  assert.equal(late.item.key, 'assault'); assert.equal(late.matchup.threats.armor, true); assert.match(late.item.reason, /брон/);
  const illusions = advice({}, { enemyHeroIds: [12] }); assert.equal(illusions.item.key, 'radiance'); assert.match(illusions.item.reason, /иллюзии/);
});
test('dataset capability tags and manual threats are explainable additions', () => {
  const tagged = { ...dataset, heroes: { ...dataset.heroes, 999: { id: 999, localizedName: 'Fixture', tags: ['magic', 'unsupported'] } } };
  const result = advice({}, { enemyHeroIds: [999] }, tagged); assert.equal(result.matchup.threats.magic, true); assert.equal(result.item.key, 'black_king_bar');
  const manual = advice({}, { threats: { control: true } }); assert.equal(manual.item.key, 'black_king_bar'); assert.match(manual.matchup.source, /Твои отметки/);
});
test('confident roster detection identifies draft but weak/unknown-side slots do not', () => {
  const result = advice({}, { draftSource: 'vision', vision: vision([], { roster: { slots: [{ id: 26, relation: 'enemy', confidence: .95 }, { id: 1, relation: 'enemy', confidence: .89 }, { id: 35, confidence: .99 }] } }) });
  assert.deepEqual(result.matchup.enemyHeroIds, [26]); assert.match(result.matchup.source, /распознаны/);
});
test('owned upgrades and stash purchases are not recommended again', () => {
  const result = advice({ gameTime: 120, inventory: [{ name: 'phase_boots', slot: 'slot0' }, { name: 'armlet', slot: 'stash0' }] });
  for (const item of [result.item, ...result.alternatives]) assert.ok(!['power_treads', 'armlet'].includes(item.key));
});
test('remaining price consumes duplicate recipe components only once per copy', () => {
  for (const [hammers, expected] of [[1, 1900], [2, 300]]) {
    const result = advice({ inventory: [{ name: 'power_treads' }, { name: 'armlet' }, ...Array.from({ length: hammers }, () => ({ name: 'mithril_hammer' }))] }, { plan: 'fight' });
    const desolator = [result.item, ...result.alternatives].find(item => item.key === 'desolator'); assert.equal(desolator.remainingGold, expected);
  }
});
test('a partially assembled subcomponent is discounted recursively without inventing gold', () => {
  const result = advice({ gameTime: 120, inventory: [{ name: 'boots', slot: 'stash0' }] });
  assert.equal(result.item.key, 'power_treads'); assert.equal(result.item.remainingGold, 900);
});
test('healing resources are actionable only in usable active slots with charges', () => {
  for (const slot of ['stash0', 'slot6', 'slot8']) {
    const result = advice({ healthPercent: 20, inventory: [{ name: 'magic_wand', slot, cooldown: 0, charges: 10 }] });
    assert.doesNotMatch(result.action.reason, /Magic Wand/);
  }
  assert.match(advice({ healthPercent: 20, inventory: [{ name: 'magic_wand', slot: 'slot0', cooldown: 0, charges: 10 }] }).action.reason, /Magic Wand/);
  assert.doesNotMatch(advice({ healthPercent: 20, inventory: [{ name: 'magic_wand', slot: 'slot0', cooldown: 0, charges: 0 }] }).action.reason, /Magic Wand/);
  assert.doesNotMatch(advice({ healthPercent: 20, inventory: [{ name: 'magic_wand', slot: 'slot0', cooldown: 0, charges: 10, canCast: false }] }).action.reason, /Magic Wand/);
});
test('passive can_cast never overrides Reincarnation cooldown or invents mana cost', () => {
  const ready = advice({ abilities: [{ name: 'skeleton_king_reincarnation', level: 1, cooldown: 0, canCast: false }] });
  assert.match(ready.action.reason, /Таймер Reincarnation равен нулю/); assert.match(ready.action.reason, /ресурсы/);
  assert.doesNotMatch(ready.action.reason, /220|110|готова|гарант/);
  const cooling = advice({ abilities: [{ name: 'skeleton_king_reincarnation', level: 3, cooldown: 100, canCast: true }] }); assert.match(cooling.action.reason, /100 с/);
});
test('unknown cooldown does not claim readiness', () => {
  const result = advice({ abilities: [{ name: 'skeleton_king_reincarnation', level: 3, cooldown: null }] });
  assert.match(result.action.reason, /не подтверждена/);
});
test('confirmed nearby enemy produces a conservative screen warning', () => {
  const result = advice({}, { enemyHeroIds: [26], alliedHeroIds: [57], vision: vision([SELF, ENEMY]) });
  assert.equal(result.action.source, 'screen'); assert.match(result.action.reason, /не подтверждены/); assert.match(result.action.reason, /не подтверждение атаки/);
});
test('map warnings require identity, confidence, screen quality, freshness and actual proximity', () => {
  const cases = [
    vision([{ ...SELF, confidence: .86 }, ENEMY]), vision([SELF, { ...ENEMY, confidence: .89 }]),
    vision([SELF, { ...ENEMY, id: 35 }]), vision([SELF, { ...ENEMY, x: .9, y: .9 }]),
    vision([SELF, ENEMY], { quality: { usable: false } }), vision([SELF, ENEMY], { capturedAt: NOW - 5001 }),
    vision([SELF, ENEMY], { capturedAt: null }), vision([SELF, ENEMY], { capturedAt: NOW + 1001 }),
    vision([SELF, ENEMY, { ...SELF, x: .7 }]), vision([SELF, { ...ENEMY, x: 12 }]),
    vision([], { minimap: { markers: [{ color: 'red', x: .5, y: .5 }] } }),
  ];
  for (const screenshot of cases) assert.notEqual(advice({}, { enemyHeroIds: [26], vision: screenshot }).action.source, 'screen');
});
test('confirmed nearby ally suppresses isolation warning, unconfirmed colored allies do not count', () => {
  assert.notEqual(advice({}, { enemyHeroIds: [26], alliedHeroIds: [57], vision: vision([SELF, ENEMY, ALLY]) }).action.source, 'screen');
  assert.equal(advice({}, { enemyHeroIds: [26], alliedHeroIds: [57], vision: vision([SELF, ENEMY, { ...ALLY, confidence: .7 }]) }).action.source, 'screen');
});
test('manual draft alone never makes claims about hidden enemy locations', () => {
  const result = advice({}, { enemyHeroIds: [1, 26, 28, 35], vision: vision([]) });
  assert.notEqual(result.action.source, 'screen'); assert.doesNotMatch(result.action.reason, /внизу|сверху|нападут|идут к тебе|рядом.*противн/);
});

test('actual OpenDota IDs distinguish illusion heroes from Meepo clones and Slark', () => {
  const actual = require('../data/wraith-king.json');
  assert.equal(actual.heroes[81].name, 'npc_dota_hero_chaos_knight');
  assert.equal(actual.heroes[89].name, 'npc_dota_hero_naga_siren');
  for (const id of [81, 89, 109]) assert.equal(advice({}, { enemyHeroIds: [id] }, actual).matchup.threats.illusions, true);
  for (const id of [82, 93]) assert.equal(advice({}, { enemyHeroIds: [id] }, actual).matchup.threats.illusions, false);
  assert.equal(advice({}, { enemyHeroIds: [12] }, actual).matchup.threats.manaDrain, false);
});
test('actual nested roster slots use confirmed player team to resolve sides', () => {
  const screenshot = vision([SELF, ENEMY], { roster: { slots: [{ team: 'dire', hero: { id: 26, confidence: .95 } }, { team: 'radiant', hero: { id: 57, confidence: .95 } }] } });
  const result = advice({}, { vision: screenshot });
  assert.deepEqual(result.matchup.enemyHeroIds, [26]); assert.equal(result.action.source, 'screen');
});
