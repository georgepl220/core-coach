'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { stageFor, skillsFor } = require('../src/stages.cjs');
const { recommend, normalizeGsi } = require('../src/core.cjs');
const { coachingFor } = require('../src/coach.cjs');
const dataset = require('../data/wraith-king.json');
const NOW = 100000;
const Q = 'skeleton_king_hellfire_blast', W = 'skeleton_king_bone_guard', E = 'skeleton_king_mortal_strike', R = 'skeleton_king_reincarnation';
function state(extra = {}) { return { heroId: 42, heroName: 'npc_dota_hero_skeleton_king', isWraithKing: true, status: 'live', gameTime: 300, matchId: '123', alive: true, level: 3, abilityPoints: 1, healthPercent: 80, manaPercent: 70, mana: 200, gold: 1000, inventory: [], dataQuality: { abilities: true, inventory: true }, receivedAt: NOW, abilities: [
  { name: Q, level: 1, cooldown: 0, canCast: true, manaCost: 95 }, { name: W, level: 1, cooldown: 0 }, { name: E, level: 0, cooldown: 0 }, { name: R, level: 0, cooldown: 0 },
], ...extra }; }
const skills = [
  { heroLevel: 1, abilityKey: Q, abilityId: 5086 }, { heroLevel: 2, abilityKey: W, abilityId: 5087 },
  { heroLevel: 3, abilityKey: W, abilityId: 5087 }, { heroLevel: 4, abilityKey: E, abilityId: 5088 },
  { heroLevel: 5, abilityKey: W, abilityId: 5087 }, { heroLevel: 6, abilityKey: R, abilityId: 5089 },
  { heroLevel: 7, abilityKey: W, abilityId: 5087 }, { heroLevel: 8, abilityKey: E, abilityId: 5088 },
];
const provider = { heroId: 42, role: 'carry', source: 'Fixture real recorded upgrades', sourceUrl: 'https://api.opendota.com/api/matches/123', builds: [{ id: 'farm', skillSourceMatchId: 123, skills, sequence: [{ key: 'radiance' }] }] };

test('stages use explicit clock boundaries, not transient health or spell cooldowns', () => {
  const cases = [[-1, 'pregame'], [0, 'laning'], [599, 'laning'], [600, 'transition'], [899, 'transition'], [900, 'midgame'], [1799, 'midgame'], [1800, 'lategame']];
  for (const [gameTime, expected] of cases) assert.equal(stageFor(state({ gameTime })).id, expected);
  assert.equal(stageFor(state({ gameTime: null })).id, 'pregame');
  assert.equal(stageFor(state({ gameTime: 400, healthPercent: 1, abilities: [{ name: R, cooldown: 0 }] })).id, 'laning');
  assert.equal(stageFor(state({ gameState: 'DOTA_GAMERULES_STATE_PRE_GAME' })).id, 'pregame');
});

test('manual stage override wins and previous automatic stage only persists within same match', () => {
  assert.equal(stageFor(state({ gameTime: 2000 }), { stageOverride: 'laning' }).id, 'laning');
  assert.equal(stageFor(state({ gameTime: 400 }), { stageOverride: 'nonsense' }).id, 'laning');
  const early = stageFor(state({ gameTime: 490, level: 8, inventory: [{ name: 'armlet' }] }));
  assert.equal(early.id, 'transition');
  assert.equal(stageFor(state({ gameTime: 500, level: 8 }), { previousStage: early }).id, 'transition');
  assert.equal(stageFor(state({ gameTime: 500, matchId: 'another' }), { previousStage: early }).id, 'laning');
});

test('saved points choose an earlier missing rank rather than blindly level plus one', () => {
  const result = skillsFor(state({ level: 5, abilityPoints: 3 }), dataset, { proBuild: provider });
  assert.equal(result.next.abilityKey, W); assert.equal(result.next.desiredRank, 2); assert.equal(result.next.heroLevel, 3); assert.equal(result.next.ready, true); assert.equal(result.status, 'upgrade_available');
  assert.equal(result.sourceMatchId, 123); assert.equal(result.levelsVerified, false); assert.match(result.levelCaveat, /минимальные допустимые/);
  const spent = skillsFor(state({ abilityPoints: 0, abilities: state().abilities.map(ability => ability.name === W ? { ...ability, level: 2 } : ability) }), dataset, { proBuild: provider });
  assert.equal(spent.next.abilityKey, E); assert.equal(spent.next.heroLevel, 4); assert.equal(spent.next.ready, false);
});

test('missing ranks and incompatible facet abstain while keeping sourced plan', () => {
  assert.equal(skillsFor(state({ abilities: [] }), dataset, { proBuild: provider }).status, 'waiting');
  const unknownRank = state().abilities.map(ability => ability.name === W ? { ...ability, level: null } : ability);
  assert.equal(skillsFor(state({ abilities: unknownRank }), dataset, { proBuild: provider }).next, null);
  const alternateFacet = state().abilities.map(ability => ability.name === W ? { ...ability, name: 'skeleton_king_spectral_blade' } : ability);
  const result = skillsFor(state({ abilities: alternateFacet }), dataset, { proBuild: provider });
  assert.equal(result.status, 'incompatible'); assert.equal(result.next, null); assert.equal(result.order.length, skills.length);
  const contradictoryId = state().abilities.map(ability => ability.name === W ? { ...ability, id: 999 } : ability);
  assert.equal(skillsFor(state({ abilities: contradictoryId }), dataset, { proBuild: provider }).status, 'incompatible');
});

test('unknown skill points permit only a conditional plan from observed ranks, never inferred availability', () => {
  const result = skillsFor(state({ abilityPoints: null }), dataset, { proBuild: provider });
  assert.equal(result.next.abilityKey, W); assert.equal(result.next.desiredRank, 2);
  assert.equal(result.status, 'conditional_plan'); assert.equal(result.pointsKnown, false);
  assert.equal(result.next.pointsKnown, false); assert.equal(result.next.ready, false);
  assert.match(result.reason, /Если в игре есть свободное очко/); assert.match(result.reason, /GSI не подтвердил/);
  assert.equal(skillsFor(state({ level: null, abilityPoints: null }), dataset, { proBuild: provider }).next, null);
  const unknownRank = state().abilities.map(ability => ability.name === W ? { ...ability, level: null } : ability);
  assert.equal(skillsFor(state({ abilityPoints: null, abilities: unknownRank }), dataset, { proBuild: provider }).next, null);
  const prematureUlt = { ...provider, builds: [{ skills: [{ heroLevel: 6, abilityKey: R, abilityId: 5089 }] }] };
  assert.equal(skillsFor(state({ abilityPoints: null, level: 5 }), dataset, { proBuild: prematureUlt }).next, null);
  const talentOnly = { ...provider, abilities: { special_bonus_fixture: { maxRank: 1, minimumLevels: [10] } }, builds: [{ skills: [{ heroLevel: 10, abilityKey: 'special_bonus_fixture', abilityId: 1545 }] }] };
  assert.equal(skillsFor(state({ abilityPoints: null, level: 10 }), dataset, { proBuild: talentOnly }).next, null);
});

test('innates are never upgraded and unknown talents do not masquerade as rank zero', () => {
  const innate = { ...provider, builds: [{ skills: [{ heroLevel: 1, abilityKey: 'skeleton_king_vampiric_spirit', abilityId: 1283 }] }] };
  assert.equal(skillsFor(state(), dataset, { proBuild: innate }).status, 'incompatible');
  const talentProvider = { ...provider, abilities: { special_bonus_fixture: { label: 'Fixture talent', maxRank: 1, minimumLevels: [10] } }, builds: [{ skills: [{ heroLevel: 10, abilityKey: 'special_bonus_fixture', abilityId: 1545 }] }] };
  assert.equal(skillsFor(state({ level: 10 }), dataset, { proBuild: talentProvider }).next, null);
  const observed = skillsFor(state({ level: 10, abilities: [{ name: 'special_bonus_fixture', level: 0 }] }), dataset, { proBuild: talentProvider });
  assert.equal(observed.next.abilityKey, 'special_bonus_fixture');
});

test('legal rank requirements prevent premature ultimate and provider mismatch is not accepted', () => {
  const prematurelyTimed = { ...provider, builds: [{ skills: [{ heroLevel: 3, abilityKey: R, abilityId: 5089 }] }] };
  assert.equal(skillsFor(state({ level: 3 }), dataset, { proBuild: prematurelyTimed }).next, null);
  assert.equal(skillsFor(state(), dataset, { proBuild: { ...provider, role: 'offlane' } }).status, 'unavailable');
  assert.equal(skillsFor(state(), dataset, { proBuild: { ...provider, status: 'manual_only' } }).status, 'unavailable');
});

test('selected item route selects its own sourced skill order', () => {
  const two = { ...provider, builds: [...provider.builds, { id: 'fight', skillSourceMatchId: 124, sequence: [{ key: 'armlet' }, { key: 'desolator' }], skills: [{ heroLevel: 1, abilityKey: E, abilityId: 5088 }] }] };
  assert.equal(skillsFor(state(), dataset, { proBuild: two, plan: 'fight' }).sourceMatchId, 124);
  assert.equal(skillsFor(state(), dataset, { proBuild: two, plan: 'fight', buildId: 'farm' }).sourceMatchId, 123);
});

test('partial skill sequences preserve displayed rows but never recommend an upgrade', () => {
  for (const flags of [{ skillOrderComplete: false }, { skillUnknownAbilityIds: [730] }, { unknownSkillAbilityIds: [730] }, { unknownAbilityIds: [730] }]) {
    const partial = { ...provider, builds: [{ ...provider.builds[0], ...flags }] };
    const result = skillsFor(state(), dataset, { proBuild: partial });
    assert.equal(result.status, 'incomplete'); assert.equal(result.next, null); assert.equal(result.order.length, skills.length); assert.equal(result.confidence, 0);
  }
  const actual = require('../data/d2pt-wraith-king.json');
  const route = actual.builds.find(build => build.id === 'radiance-sange_and_yasha');
  assert.equal(route.skillOrderComplete, false); assert.ok(route.skillUnknownAbilityIds.includes(730));
  const observed = skillsFor(state(), dataset, { proBuild: actual, buildId: route.id });
  assert.equal(observed.status, 'incomplete'); assert.equal(observed.next, null); assert.equal(observed.order.length, route.skills.length);
  assert.match(observed.reason, /неполной последовательности/);
});

test('personal and authorized exported plans never claim to be recorded match observations', () => {
  const personal = { ...provider, source: 'Личная сборка', builds: [{ skills, skillOrderKind: 'personal_authored_level_plan' }] };
  const authored = skillsFor(state(), dataset, { proBuild: personal });
  assert.match(authored.levelCaveat, /заданы тобой/); assert.doesNotMatch(authored.reason, /взят из матча|записи матча|наблюдаемого carry/);
  const exported = { ...provider, builds: [{ skills, skillOrderKind: 'authorized_export_level_plan', skillLevelsVerified: true }] };
  const permissioned = skillsFor(state(), dataset, { proBuild: exported });
  assert.match(permissioned.levelCaveat, /разрешённом экспорте/); assert.doesNotMatch(permissioned.reason, /взят из матча|наблюдаемого carry/);
});

test('opposite talent must be observed unlearned unless GSI confirms candidate can upgrade', () => {
  const left = 'special_bonus_unique_wraith_king_2', right = 'special_bonus_unique_wraith_king_facet_1';
  const actual = require('../data/d2pt-wraith-king.json');
  const talentPlan = { ...actual, builds: [{ skills: [{ heroLevel: 10, abilityKey: right, abilityId: 1545 }] }] };
  const choose = peers => skillsFor(state({ level: 12, abilities: peers }), dataset, { proBuild: talentPlan });
  assert.equal(choose([{ name: right, level: 0 }, { name: left, level: 1 }]).next, null);
  assert.equal(choose([{ name: right, level: 0 }]).next, null);
  assert.equal(choose([{ name: right, level: 0 }, { name: left, level: 0 }]).next?.abilityKey, right);
  assert.equal(choose([{ name: right, level: 0, canUpgrade: true }, { name: left, level: 1 }]).next?.abilityKey, right);
});

test('laning bundle names matchup mechanics, ally setup and a separate useful tip', () => {
  const result = coachingFor(state(), dataset, { laneEnemyHeroIds: [2, 101], laneAllyHeroId: 26, laneSource: 'screen', laneConfidence: .7 });
  assert.equal(result.stage.id, 'laning'); assert.match(result.stageAdvice.mainReason, /Call.*Skywrath/);
  assert.match(result.stageAdvice.skillUseReason, /Call.*Ancient Seal/); assert.match(result.stageAdvice.extraReason, /Lion.*Earth Spike/);
  assert.match(result.stageAdvice.skillUseReason, /Bone Guard.*Counter Helix/);
  assert.match(result.stageAdvice.skillUseTitle, /стан.*Axe/); assert.match(result.stageAdvice.extraTitle, /саппортом.*Call/);
  assert.equal(result.lane.detectionSource, 'screen'); assert.ok(result.lane.confidence <= .7);
  const historical = coachingFor(state(), dataset, { laneEnemyHeroIds: [2, 101], laneSource: 'screen_history', laneConfidence: .5 });
  assert.match(historical.lane.source, /Ранее наблюдавшийся/); assert.equal(historical.lane.detectionSource, 'screen_history'); assert.ok(historical.lane.confidence <= .5);
  const unknown = coachingFor(state(), dataset, { enemyHeroIds: [2, 101, 26] });
  assert.match(unknown.stageAdvice.mainTitle, /Наблюдаю состав линии/); assert.deepEqual(unknown.lane.opponents, []);
});

test('skill-use advice handles channels and known own spell availability conservatively', () => {
  const lion = coachingFor(state(), dataset, { laneEnemyHeroIds: [26, 49] });
  assert.match(lion.stageAdvice.skillUseReason, /Mana Drain.*прерви/);
  assert.match(lion.stageAdvice.skillUseTitle, /Если стан доступен.*Mana Drain/);
  const shaman = coachingFor(state(), dataset, { laneEnemyHeroIds: [27, 49] });
  assert.match(shaman.stageAdvice.skillUseReason, /союзника Shackles/); assert.match(shaman.stageAdvice.skillUseReason, /держит тебя/);
  const lowMana = coachingFor(state({ mana: 50 }), dataset, { laneEnemyHeroIds: [2, 101] });
  assert.match(lowMana.stageAdvice.skillUseTitle, /недоступен/); assert.doesNotMatch(lowMana.stageAdvice.skillUseReason, /готов/);
  const cooling = coachingFor(state({ abilities: [{ name: Q, level: 1, cooldown: 5, canCast: true }] }), dataset, { laneEnemyHeroIds: [26] });
  assert.match(cooling.stageAdvice.skillUseTitle, /5 с/);
});

test('transition uses manual outcome; midgame and late are different plans with honest resource limits', () => {
  const transition = coachingFor(state({ gameTime: 650 }), dataset, { laneResult: 'lost', laneEnemyHeroIds: [49, 26] });
  assert.equal(transition.stage.id, 'transition'); assert.match(transition.stageAdvice.mainTitle, /восстанови/); assert.match(transition.stageAdvice.mainReason, /T2/);
  assert.match(transition.stageAdvice.skillUseTitle, /проверь Reincarnation/);
  const mid = coachingFor(state({ gameTime: 1200 }), dataset, { plan: 'fight' });
  assert.equal(mid.stage.id, 'midgame'); assert.match(mid.stageAdvice.mainReason, /боевым предметом/); assert.match(mid.stageAdvice.extraReason, /не подтверждает состояние Roshan/);
  const late = coachingFor(state({ gameTime: 2000, buybackCost: 1400, buybackCooldown: 60, gold: 1000, abilities: [{ name: R, level: 3, cooldown: 0, canCast: false }] }), dataset);
  assert.equal(late.stage.id, 'lategame'); assert.match(late.stageAdvice.extraReason, /ещё 400/); assert.match(late.stageAdvice.extraReason, /60 с/);
  assert.match(late.stageAdvice.extraTitle, /перезарядке: 60/);
  assert.match(late.stageAdvice.skillUseReason, /Таймер Reincarnation равен нулю/); assert.match(late.stageAdvice.skillUseReason, /ресурсы/);
  const unknown = coachingFor(state({ gameTime: 2000 }), dataset); assert.match(unknown.stageAdvice.extraReason, /не передал/);
});

test('GSI records observed skill points and buyback resources without filling missing fields', () => {
  const observed = normalizeGsi({ hero: { name: 'npc_dota_hero_skeleton_king', ability_points: 2, buyback_cost: 1300, buyback_cooldown: 20 }, abilities: { ability0: { name: Q, id: 5086, level: 1, can_upgrade: true } } });
  assert.equal(observed.abilityPoints, 2); assert.equal(observed.buybackCost, 1300); assert.equal(observed.buybackCooldown, 20); assert.equal(observed.abilities[0].canUpgrade, true);
  const missing = normalizeGsi({ hero: { name: 'npc_dota_hero_skeleton_king' } }, observed);
  assert.equal(missing.abilityPoints, null); assert.equal(missing.buybackCost, null); assert.equal(missing.buybackCooldown, null);
});

test('stale and spectator recommendations cannot display a ready skill upgrade or coaching bundle', () => {
  for (const extra of [{ receivedAt: NOW - 16000 }, { isSpectator: true }, { isPaused: true }]) {
    const result = recommend(state(extra), dataset, { now: NOW, proBuild: provider });
    assert.equal(result.skills.next, null); assert.equal(result.stageAdvice, null);
  }
  const overridden = recommend(state(), dataset, { now: NOW, stageOverride: 'midgame' });
  assert.equal(overridden.stage.id, 'midgame'); assert.equal(overridden.action.source, 'stage');
});
