'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeGsi, recommend } = require('../src/core.cjs');
const { coachingFor } = require('../src/coach.cjs');
const { skillsFor, stageFor } = require('../src/stages.cjs');
const { RULES } = require('../src/carry-rules.cjs');
const NOW = 200000;
const slugs = { 42: 'wraith-king', 8: 'juggernaut', 18: 'sven', 44: 'phantom-assassin', 48: 'luna' };
const data = id => require(`../data/${slugs[id]}.json`);
const provider = id => require(`../data/${id === 42 ? 'd2pt' : 'opendota'}-${slugs[id]}.json`);
function state(id, extra = {}) {
  const rule = RULES[id], catalog = data(id).currentAbilityCatalog || data(id).abilities;
  const abilities = Object.entries(catalog).filter(([, detail]) => detail.learnable === true && !detail.isInnate && !detail.granted && detail.kind !== 'talent').map(([name, detail]) => ({ name, id: detail.abilityId ?? detail.id, level: detail.kind === 'ultimate' ? 0 : 1, cooldown: 0, canCast: detail.behavior === 'passive' ? false : true, manaCost: 90 }));
  const raw = { map: { clock_time: 300, game_state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS', matchid: 'carry-test' }, player: { team_name: 'radiant', gold: 1000, last_hits: 20, net_worth: 2500 }, hero: { id, name: rule.names[0], alive: true, level: 3, ability_points: 1, health_percent: 80, mana_percent: 75, mana: 300 }, items: {}, abilities: Object.fromEntries(abilities.map((ability, index) => [`ability${index}`, { ...ability, can_cast: ability.canCast, mana_cost: ability.manaCost }])) };
  return { ...normalizeGsi(raw), receivedAt: NOW, ...extra };
}

test('all five carries normalize both numeric and name-only identities and reject contradictory identities', () => {
  for (const id of Object.keys(slugs).map(Number)) {
    const s = normalizeGsi({ hero: { id, name: RULES[id].names[0] } });
    assert.equal(s.heroId, id); assert.equal(s.carryHeroId, id); assert.equal(s.isSupportedCarry, true); assert.equal(s.status, 'live');
    assert.equal(s.isWraithKing, id === 42);
    assert.equal(normalizeGsi({ hero: { name: RULES[id].names[0] } }).heroId, id);
    const conflict = normalizeGsi({ hero: { id, name: 'npc_dota_hero_sniper' } });
    assert.equal(conflict.isSupportedCarry, false); assert.equal(conflict.status, 'wrong_hero');
  }
  assert.equal(normalizeGsi({ hero: { id: 35, name: 'npc_dota_hero_sniper' } }).isSupportedCarry, false);
});

test('selecting another supported hero never relabels the original players inventory as that hero', () => {
  for (const selected_unit of [{ id: 18, name: RULES[18].names[0] }, RULES[18].names[0]]) {
    const s = normalizeGsi({ hero: { id: 42, name: RULES[42].names[0], selected_unit } });
    assert.equal(s.isSupportedCarry, false); assert.equal(s.selectedOtherUnit, true); assert.equal(s.status, 'wrong_hero');
    assert.equal(recommend({ ...s, receivedAt: NOW }, data(18), { heroId: 18, now: NOW }).item, null);
  }
});

test('each added carry receives its own observed build and hero abilities without WK suggestions', () => {
  for (const id of [8, 18, 44, 48]) {
    const result = recommend(state(id), data(id), { now: NOW, heroId: id, proBuild: provider(id), laneEnemyHeroIds: [2, 22], laneAllyHeroId: 26, laneSource: 'manual' });
    assert.ok(result.item, `item for ${id}`); assert.ok(provider(id).builds.some(build => build.id === result.item.buildId));
    assert.equal(result.lane.ally.id, 26); assert.deepEqual(result.lane.opponents.map(hero => hero.id), [2, 22]);
    assert.equal(result.stage.id, 'laning'); assert.match(result.stageAdvice.skillUseReason, new RegExp(RULES[id].primaryLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const advice = JSON.stringify({ lane: result.lane, stageAdvice: result.stageAdvice, postLane: result.postLane });
    assert.doesNotMatch(advice, /Wraithfire Blast|Reincarnation|Bone Guard|Mortal Strike|\bWK\b/);
    assert.equal(result.economy.netWorth, 2500); assert.equal(result.economy.lastHits, 20);
  }
});

test('selected profile and provider must match observed player rather than borrowing another carry build', () => {
  assert.equal(recommend(state(8), data(18), { now: NOW, heroId: 18, proBuild: provider(18) }).item, null);
  assert.equal(recommend(state(8), data(8), { now: NOW, heroId: 18, proBuild: provider(18) }).item, null);
  assert.equal(skillsFor(state(8), data(8), { heroId: 8, proBuild: provider(18) }).status, 'unavailable');
  const fallback = recommend(state(8), data(8), { now: NOW, heroId: 8, proBuild: { ...provider(18), status: 'unavailable' } });
  assert.match(fallback.item.source, /Авторский резервный план Juggernaut/);
  assert.doesNotMatch(fallback.item.source, /наблюдаем|OpenDota|STRATZ/i);
});

test('skill upgrades use actual hero catalogs and ultimate legal ranks for every added carry', () => {
  for (const id of [8, 18, 44, 48]) {
    const rule = RULES[id], raw = provider(id), firstRoute = raw.builds[0];
    const s = state(id, { level: 1, abilityPoints: 1 });
    s.abilities = s.abilities.map(ability => ({ ...ability, level: 0 }));
    const result = skillsFor(s, data(id), { heroId: id, proBuild: raw, buildId: firstRoute.id });
    assert.ok(result.order.length); assert.ok(result.next, `${id}: ${result.reason}`); assert.equal(result.next.ready, true);
    assert.ok(result.next.abilityKey.startsWith(slugs[id].replace(/-/g, '_')));
    const premature = { ...raw, builds: [{ skills: [{ heroLevel: 3, abilityKey: rule.ultimate[0] }] }] };
    assert.equal(skillsFor({ ...s, level: 5 }, data(id), { heroId: id, proBuild: premature }).next, null);
    assert.equal(skillsFor({ ...s, level: 6 }, data(id), { heroId: id, proBuild: premature }).next.requiredLevel, 6);
  }
});

test('PA and Luna do not upgrade present-day innates or item-granted abilities', () => {
  for (const [id, key] of [[44, 'phantom_assassin_blur'], [48, 'luna_lunar_blessing'], [8, 'juggernaut_swift_slash']]) {
    const raw = { ...provider(id), builds: [{ skills: [{ heroLevel: 1, abilityKey: key }] }] };
    const result = skillsFor(state(id), data(id), { heroId: id, proBuild: raw });
    assert.equal(result.status, 'incompatible'); assert.equal(result.next, null);
  }
});

test('PA passive ultimate never emits an active ultimate or resurrection instruction', () => {
  for (const gameTime of [650, 1200, 2000]) {
    const s = state(44, { gameTime });
    s.abilities = s.abilities.map(ability => ability.name === 'phantom_assassin_coup_de_grace' ? { ...ability, level: 1, cooldown: 80, canCast: false } : ability);
    const result = recommend(s, data(44), { now: NOW, heroId: 44, proBuild: provider(44), laneResult: 'won', plan: 'fight' });
    assert.match(result.stageAdvice.skillUseReason, /пассивный/);
    assert.doesNotMatch(result.action.title, /без ультимейта/);
    for (const field of Object.values(result.stageAdvice).filter(value => typeof value === 'string')) assert.doesNotMatch(field, /Reincarnation|возрожд|(?:используй|кастуй|включи) Coup de Grace|Coup de Grace на перезарядке/);
  }
});

test('own spell cooldown and low mana block aggressive recipe rather than promising a cast', () => {
  for (const id of [8, 18, 44, 48]) {
    const s = state(id);
    s.abilities = s.abilities.map(ability => RULES[id].primary.includes(ability.name) ? { ...ability, cooldown: 5 } : ability);
    const cooling = coachingFor(s, data(id), { heroId: id, laneEnemyHeroIds: [28], laneAllyHeroId: 26, laneSource: 'manual' });
    assert.notEqual(cooling.lane.style, 'aggressive'); assert.match(cooling.stageAdvice.skillUseTitle, /5 с/);
    s.abilities = s.abilities.map(ability => ({ ...ability, cooldown: 0 }));
    const dry = coachingFor({ ...s, mana: 0 }, data(id), { heroId: id, laneEnemyHeroIds: [28], laneAllyHeroId: 26, laneSource: 'manual' });
    assert.match(dry.stageAdvice.skillUseTitle, /недоступен/);
  }
});

test('early progression uses the active carrys core item and keeps previous match stage isolated', () => {
  for (const id of [8, 18, 44, 48]) {
    const s = state(id, { level: 8, gameTime: 490, inventory: [{ name: RULES[id].progressItems[0] }] });
    assert.equal(stageFor(s, { heroId: id }).id, 'transition');
    assert.equal(stageFor({ ...s, inventory: [{ name: 'armlet' }] }, { heroId: id }).id, 'laning');
  }
});

test('manual matchup preview works without GSI but never imports old resources, economy or outcome', () => {
  for (const id of [42, 8, 18, 44, 48]) {
    const context = { now: NOW, heroId: id, laneEnemyHeroIds: [2, 22], laneAllyHeroId: 26, laneSource: 'manual', laneResult: 'won', history: [{ gameTime: 600, lastHits: 70 }] };
    for (const s of [{}, state(id, { receivedAt: NOW - 16000 }), state(id, { isPaused: true })]) {
      const result = recommend(s, data(id), context);
      assert.equal(result.manualOnly, true); assert.equal(result.stage.id, 'unknown'); assert.equal(result.stageAdvice.source, 'manual_matchup');
      assert.equal(result.lane.detectionSource, 'manual'); assert.equal(result.lane.ally.id, 26); assert.equal(result.lane.outcome, 'unknown'); assert.equal(result.postLane, null);
      assert.equal(result.item, null); assert.equal(result.skills.next, null); assert.equal(result.economy.netWorth, null); assert.equal(result.economy.lastHits, null);
      assert.doesNotMatch(result.lane.source, /Повторные наблюдения|героев рядом/);
    }
    for (const s of [state(id, { isSpectator: true, status: 'spectator' }), state(id === 42 ? 8 : 42)]) assert.equal(recommend(s, data(id), context).manualOnly, undefined);
  }
});

test('author-written fallback skills disclose authorship rather than claim a parsed match', () => {
  const id = 8, raw = { ...provider(id), builds: [{ skills: [{ heroLevel: 1, abilityKey: RULES[id].primary[0] }], skillOrderKind: 'authored_heuristic_level_plan' }] };
  const result = skillsFor(state(id), data(id), { heroId: id, proBuild: raw });
  assert.match(result.levelCaveat, /Авторский резервный порядок/); assert.doesNotMatch(result.reason, /наблюдаемого carry|взяты из записи/);
});

test('public selected build skill order remains visible without personal GSI or an upgrade recommendation', () => {
  for (const id of [42, 8, 18, 44, 48]) {
    const raw = provider(id), build = raw.builds.find(entry => entry.skills?.length);
    const context = { now: NOW, heroId: id, proBuild: raw, buildId: build.id };
    const publicPlan = skillsFor({}, data(id), context);
    assert.ok(publicPlan.order.length, `public plan ${id}`);
    for (const s of [{}, state(id, { receivedAt: NOW - 16000 }), state(id, { isPaused: true }), state(id, { isSpectator: true, status: 'spectator' }), state(id === 42 ? 8 : 42)]) {
      const result = recommend(s, data(id), context);
      assert.deepEqual(result.skills.order, publicPlan.order);
      assert.equal(result.skills.sourceMatchId, publicPlan.sourceMatchId);
      assert.equal(result.skills.orderKind, publicPlan.orderKind);
      assert.equal(result.skills.levelsVerified, publicPlan.levelsVerified);
      assert.equal(result.skills.next, null); assert.equal(result.skills.status, 'unavailable'); assert.equal(result.skills.pointsKnown, false); assert.equal(result.skills.previewOnly, true);
      assert.match(result.skills.reason, /свободные очки не подтверждены/);
      if (id !== 42) assert.doesNotMatch(JSON.stringify(result.skills), /skeleton_king|wraith_king|Wraithfire|Reincarnation/);
    }
  }
  assert.deepEqual(recommend({}, data(8), { now: NOW, heroId: 8, proBuild: provider(18) }).skills.order, []);
});
