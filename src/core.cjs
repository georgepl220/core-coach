'use strict';

// Player-perspective GSI + visible image detections. Item popularity is a small
// OpenDota prior, not a trained recommendation model. Missing facts stay unknown.
const WK_ID = 42;
const { coachingFor } = require('./coach.cjs');
const { stageFor, skillsFor } = require('./stages.cjs');
const { identifyCarry, carryRuleFor, abilityFor } = require('./carry-rules.cjs');
const { normalizeDraft } = require('./draft-state.cjs');
const WK_NAMES = new Set(['npc_dota_hero_skeleton_king', 'npc_dota_hero_wraith_king']);
const PHASES = ['start_game_items', 'early_game_items', 'mid_game_items', 'late_game_items'];
const BOOTS = new Set(['power_treads', 'phase_boots', 'travel_boots', 'travel_boots_2', 'guardian_greaves', 'arcane_boots', 'tranquil_boots', 'boots_of_bearing']);
const BLINKS = new Set(['blink', 'overwhelming_blink', 'swift_blink', 'arcane_blink']);
const NON_ITEMS = new Set(['empty', 'none', '']);
const CONSUMABLES = new Set(['tango', 'flask', 'clarity', 'enchanted_mango', 'faerie_fire', 'blood_grenade', 'tpscroll', 'smoke_of_deceit', 'dust', 'ward_observer', 'ward_sentry', 'tome_of_knowledge', 'cheese', 'refresher_shard', 'aghanims_shard', 'ultimate_scepter_2']);
const THREAT_KEYS = ['magic', 'control', 'illusions', 'armor', 'physical', 'manaDrain'];
const THREAT_LABELS = { magic: 'магический урон', control: 'контроль', illusions: 'иллюзии', armor: 'снижение брони', physical: 'физический урон', manaDrain: 'потеря маны' };
// Coarse, hand-authored hero capabilities. These do not assert the skill build,
// enemy items, immunity interactions or current positions of an opponent.
const HERO_TAGS = {
  1: ['physical', 'manaDrain'], 2: ['control', 'physical'], 3: ['control'],
  4: ['physical'], 5: ['magic', 'control'], 6: ['physical'], 8: ['physical'],
  9: ['magic', 'control'], 10: ['physical'], 11: ['magic', 'physical', 'armor'],
  12: ['illusions', 'physical'], 13: ['magic', 'control'],
  14: ['magic', 'control'], 15: ['magic', 'physical', 'armor'],
  16: ['magic', 'control'], 17: ['magic', 'control'], 18: ['physical'],
  19: ['physical', 'control'], 20: ['control', 'armor'], 21: ['physical', 'control'],
  22: ['magic'], 23: ['magic', 'control'], 25: ['magic', 'control', 'physical'],
  26: ['magic', 'control', 'manaDrain'], 27: ['magic', 'control'],
  28: ['physical', 'control', 'armor'], 29: ['magic', 'control'],
  30: ['magic', 'control'], 31: ['magic'], 32: ['physical', 'control'],
  33: ['control'], 34: ['magic'], 35: ['physical'], 36: ['magic'],
  37: ['magic', 'control'], 38: ['physical', 'control'], 39: ['magic'],
  40: ['magic'], 41: ['physical', 'control'], 43: ['magic', 'physical'],
  44: ['physical'], 45: ['magic'], 46: ['physical', 'armor'], 47: ['magic'],
  48: ['physical', 'magic'], 49: ['physical', 'control'], 51: ['magic', 'control'],
  52: ['magic', 'control'], 53: ['physical'], 54: ['physical'],
  55: ['magic', 'illusions'], 56: ['physical'], 58: ['physical'],
  59: ['physical', 'magic'], 60: ['physical', 'control'], 61: ['physical'],
  62: ['physical'], 63: ['physical', 'armor'], 64: ['magic', 'control'],
  65: ['magic', 'control'], 67: ['physical'], 68: ['magic'],
  69: ['control', 'magic'], 70: ['physical'], 71: ['control'],
  72: ['magic', 'physical'], 73: ['physical', 'armor'],
  74: ['magic', 'control', 'manaDrain'], 75: ['control', 'magic'],
  76: ['magic', 'control'], 77: ['physical'], 78: ['magic', 'control'],
  79: ['magic', 'control', 'illusions'], 80: ['physical', 'control'],
  81: ['physical', 'control', 'illusions'], 82: ['physical', 'control'],
  83: ['magic', 'control'], 84: ['magic', 'control'], 85: ['magic'],
  86: ['magic', 'control'], 87: ['magic', 'control'], 88: ['magic', 'control'],
  89: ['physical', 'control', 'illusions'], 90: ['magic', 'control'],
  91: ['magic'], 92: ['magic', 'physical', 'control'], 93: ['physical', 'control'],
  94: ['magic', 'physical', 'control'], 95: ['physical', 'control'],
  96: ['magic', 'physical', 'control'], 97: ['physical', 'control'],
  // Timbersaw has slows; do not mislabel his main pure damage as magic.
  98: ['control'],
  99: ['physical', 'armor'], 100: ['physical', 'control'],
  101: ['magic', 'control'], 102: ['magic', 'physical', 'control'],
  103: ['magic', 'physical', 'control', 'armor'], 104: ['physical', 'control'],
  105: ['magic', 'control'], 106: ['magic', 'physical', 'control'],
  107: ['magic', 'control'], 108: ['magic', 'control'], 109: ['illusions', 'physical'],
  110: ['magic', 'control'], 111: ['magic', 'control'], 112: ['magic', 'control'],
  113: ['magic', 'physical', 'control'], 114: ['physical', 'control'],
  119: ['magic', 'control'], 120: ['magic', 'physical', 'control'],
  121: ['magic', 'control'], 123: ['magic', 'physical', 'control'],
  126: ['magic', 'control'], 128: ['magic', 'physical', 'control'],
  129: ['physical', 'control'], 131: ['magic', 'control'],
  135: ['physical', 'control'], 136: ['physical', 'control'],
  137: ['magic', 'physical', 'control'], 138: ['magic', 'physical', 'control'],
  145: ['physical', 'control'],
};

function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function number(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function nonnegative(value) { const n = number(value); return n === null ? null : Math.max(0, n); }
function itemKey(value) { return typeof value === 'string' ? value.replace(/^item_/, '') : ''; }
function heroId(value) { const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : number(value); return n !== null && Number.isInteger(n) && n > 0 ? n : null; }
function ids(value) { return [...new Set((Array.isArray(value) ? value : []).map(heroId).filter(id => id !== null))]; }
function percent(hero, key) {
  const direct = number(hero[`${key}_percent`]);
  if (direct !== null) return Math.max(0, Math.min(100, direct));
  const current = number(hero[key]); const maximum = number(hero[`max_${key}`]);
  return current !== null && maximum !== null && maximum > 0 ? Math.max(0, Math.min(100, current / maximum * 100)) : null;
}
function hasObserverShape(value) { return Object.keys(object(value)).some(key => /^(team|player)\d+$/.test(key)); }
function heroIdentity(hero) {
  const selected = hero.selected_unit;
  const unit = selected && typeof selected === 'object' ? selected : hero;
  const name = typeof selected === 'string' && selected.startsWith('npc_dota_') ? selected : (typeof unit.name === 'string' ? unit.name : null);
  // A string selected-unit name cannot inherit the original hero's ID.
  let id = typeof selected === 'string' && selected.startsWith('npc_dota_') ? null : heroId(unit.id);
  const carry = identifyCarry(id, name);
  if (carry && id === null) id = carry.id;
  return { id, name, isWraithKing: carry?.id === WK_ID, isSupportedCarry: Boolean(carry) };
}
function normalizeGsi(payload, previousState = null) {
  payload = object(payload);
  const map = object(payload.map), player = object(payload.player), hero = object(payload.hero);
  const activity = typeof player.activity === 'string' ? player.activity.toLowerCase() : '';
  const isSpectator = /spectat|watch|observ/.test(activity) || ['player', 'hero', 'items', 'abilities'].some(key => hasObserverShape(payload[key]));
  const identity = isSpectator ? { id: null, name: null, isWraithKing: false, isSupportedCarry: false } : heroIdentity(hero);
  const parentIdentity = heroIdentity({ ...hero, selected_unit: undefined });
  const selectedOtherUnit = hero.selected_unit != null && (parentIdentity.id !== null && identity.id !== null ? parentIdentity.id !== identity.id : parentIdentity.name !== null && identity.name !== null && parentIdentity.name !== identity.name);
  const inventory = isSpectator ? [] : Object.entries(object(payload.items)).filter(([slot, entry]) => /^(slot|stash|neutral|teleport)\d*$/.test(slot) && entry && typeof entry === 'object').map(([slot, entry]) => ({
    name: itemKey(entry.name), cooldown: nonnegative(entry.cooldown), slot,
    charges: nonnegative(entry.charges), canCast: typeof entry.can_cast === 'boolean' ? entry.can_cast : null,
    activeSlot: /^slot[0-5]$/.test(slot),
  })).filter(entry => !NON_ITEMS.has(entry.name));
  const abilities = isSpectator ? [] : Object.entries(object(payload.abilities)).filter(([slot, entry]) => /^ability\d+$/.test(slot) && entry && typeof entry === 'object' && typeof entry.name === 'string').map(([slot, entry]) => ({
    name: entry.name, level: nonnegative(entry.level), cooldown: nonnegative(entry.cooldown),
    canCast: typeof entry.can_cast === 'boolean' ? entry.can_cast : null,
    manaCost: nonnegative(entry.mana_cost), charges: nonnegative(entry.charges),
    slot, id: heroId(entry.id), canUpgrade: typeof entry.can_upgrade === 'boolean' ? entry.can_upgrade : null,
    passive: typeof entry.passive === 'boolean' ? entry.passive : null,
    isInnate: typeof entry.is_innate === 'boolean' ? entry.is_innate : null,
  }));
  const directGold = nonnegative(player.gold), reliable = nonnegative(player.gold_reliable), unreliable = nonnegative(player.gold_unreliable);
  const gold = isSpectator ? null : directGold !== null ? directGold : reliable !== null && unreliable !== null ? reliable + unreliable : null;
  const hasHero = identity.id !== null || identity.name !== null;
  return {
    heroId: identity.id, heroName: identity.name, isWraithKing: identity.isWraithKing && !isSpectator && !selectedOtherUnit,
    isSupportedCarry: identity.isSupportedCarry && !isSpectator && !selectedOtherUnit, carryHeroId: identity.isSupportedCarry && !isSpectator && !selectedOtherUnit ? identity.id : null,
    selectedOtherUnit,
    gameTime: number(map.clock_time) ?? number(map.game_time), gameState: typeof map.game_state === 'string' ? map.game_state : null,
    healthPercent: isSpectator ? null : percent(hero, 'health'), manaPercent: isSpectator ? null : percent(hero, 'mana'),
    health: isSpectator ? null : nonnegative(hero.health), maxHealth: isSpectator ? null : nonnegative(hero.max_health),
    mana: isSpectator ? null : nonnegative(hero.mana), maxMana: isSpectator ? null : nonnegative(hero.max_mana),
    alive: isSpectator ? null : typeof hero.alive === 'boolean' ? hero.alive : null,
    level: isSpectator ? null : nonnegative(hero.level), gold, inventory, abilities,
    abilityPoints: isSpectator ? null : nonnegative(hero.ability_points),
    buybackCost: isSpectator ? null : nonnegative(player.buyback_cost) ?? nonnegative(hero.buyback_cost),
    buybackCooldown: isSpectator ? null : nonnegative(player.buyback_cooldown) ?? nonnegative(hero.buyback_cooldown),
    netWorth: isSpectator ? null : nonnegative(player.net_worth) ?? nonnegative(player.networth) ?? nonnegative(hero.net_worth),
    lastHits: isSpectator ? null : nonnegative(player.last_hits), denies: isSpectator ? null : nonnegative(player.denies),
    gpm: isSpectator ? null : nonnegative(player.gpm), xpm: isSpectator ? null : nonnegative(player.xpm),
    kills: isSpectator ? null : nonnegative(player.kills), deaths: isSpectator ? null : nonnegative(player.deaths),
    xpos: isSpectator ? null : number(hero.xpos), ypos: isSpectator ? null : number(hero.ypos),
    team: isSpectator ? null : (typeof player.team_name === 'string' ? player.team_name : null),
    receivedAt: Date.now(), isSpectator, isPaused: map.paused === true,
    status: isSpectator ? 'spectator' : !hasHero ? 'waiting' : !identity.isSupportedCarry || selectedOtherUnit ? 'wrong_hero' : 'live',
    matchId: map.matchid == null ? null : String(map.matchid),
    draft: isSpectator ? normalizeDraft(null) : normalizeDraft(payload.draft),
    dataQuality: {
      inventory: !isSpectator && Object.hasOwn(payload, 'items'), abilities: !isSpectator && Object.hasOwn(payload, 'abilities'),
      player: !isSpectator && Object.hasOwn(payload, 'player'), hero: !isSpectator && hasHero,
    },
    sameHero: Boolean(previousState && previousState.heroId === identity.id && previousState.heroName === identity.name),
  };
}

function phaseFor(time) { return time === null ? 'unknown' : time < 0 ? 'start' : time < 600 ? 'early' : time < 1500 ? 'mid' : 'late'; }
function ownedItems(state) { return new Set((state.inventory || []).map(item => itemKey(item.name))); }
function isOwned(key, owned) {
  if (key === 'boots' && [...owned].some(name => BOOTS.has(name))) return true;
  if (BOOTS.has(key) && [...owned].some(name => BOOTS.has(name))) return true;
  if (key === 'blink' && [...owned].some(name => BLINKS.has(name))) return true;
  return owned.has(key);
}
function proItems(state, dataset, context, matchup, phase) {
  const provider = object(context.proBuild ?? dataset.proTracker);
  const rule = carryRuleFor(state, dataset, context);
  if (!rule || provider.heroId !== rule.id || provider.heroId !== dataset.heroId || provider.role !== 'carry' || !Array.isArray(provider.builds) || !provider.builds.length) return null;
  if (['manual_only', 'unavailable', 'error'].includes(provider.status)) return null;
  const explicitBuild = provider.builds.find(entry => entry.id === context.buildId);
  const keysFor = entry => (Array.isArray(entry.sequence) ? entry.sequence : []).map(item => itemKey(typeof item === 'string' ? item : item?.key));
  const fightBuild = context.plan === 'fight' ? provider.builds.find(entry => { const keys = keysFor(entry); return rule.id === WK_ID ? keys.includes('armlet') && keys.includes('desolator') && !keys.includes('radiance') : entry.plan === 'fight' || rule.fightItems.some(item => keys.includes(item)); }) : null;
  const farmBuild = context.plan === 'farm' ? provider.builds.find(entry => keysFor(entry).some(key => rule.farmItems.includes(key))) : null;
  const build = explicitBuild || fightBuild || farmBuild || provider.builds[0];
  if (!Array.isArray(build.sequence) || !build.sequence.length) return null;
  const catalog = object(dataset.items), owned = ownedItems(state), inventory = (state.inventory || []).map(item => itemKey(item.name));
  const sequence = build.sequence.map((entry, index) => typeof entry === 'string' ? { key: itemKey(entry), index } : { ...object(entry), key: itemKey(entry?.key), index });
  function contained(component, target, seen = new Set()) {
    if (seen.has(target)) return false;
    seen.add(target);
    return (Array.isArray(catalog[target]?.components) ? catalog[target].components : []).some(part => itemKey(part) === component || contained(component, itemKey(part), new Set(seen)));
  }
  function usable(entry) {
    if (!catalog[entry.key] || CONSUMABLES.has(entry.key) || isOwned(entry.key, owned)) return false;
    if (state.gameTime >= 900 && nonnegative(catalog[entry.key]?.cost) !== null && catalog[entry.key].cost < 1000) return false;
    // Owned upgrades subsume their old components. Likewise, recommending the
    // finished item incorporates component gold without suggesting each piece.
    if ([...owned].some(item => contained(entry.key, item))) return false;
    const isStart = ['start', 'starting', 'start_game'].includes(entry.stage) || typeof entry.timeSeconds === 'number' && entry.timeSeconds < 0;
    if (phase !== 'start' && isStart) return false;
    if (phase !== 'start' && sequence.some(later => later.index > entry.index && catalog[later.key] && !CONSUMABLES.has(later.key) && contained(entry.key, later.key))) return false;
    return true;
  }
  const candidates = sequence.filter(usable).filter((entry, index, array) => array.findIndex(other => other.key === entry.key) === index);
  const manualProtection = (context.threats?.magic === true || context.threats?.control === true) && state.gameTime >= 720;
  const hasDamageItem = rule.damageItems.some(item => owned.has(item));
  const controlledBy = matchup.details.filter(hero => hero.tags.includes('control'));
  const magicFrom = matchup.details.filter(hero => hero.tags.includes('magic'));
  const physicalFrom = matchup.details.filter(hero => hero.tags.includes('physical'));
  const armorFrom = matchup.details.filter(hero => hero.tags.includes('armor'));
  const repeatedDeaths = nonnegative(state.deaths) !== null && state.deaths >= 2;
  const lostLane = context.laneResult === 'lost' || context.laneOutcome === 'lost';
  const fighting = context.plan === 'fight';
  const currentReason = repeatedDeaths ? `По GSI уже ${Math.floor(state.deaths)} смертей; их причина неизвестна, поэтому перед новым входом стоит закрыть известные угрозы состава.` : lostLane ? 'Ты отметил проигранную линию: перед выходом в драки нужна защита, а восстановление фарма остаётся приоритетом.' : fighting ? 'Выбран план участия в драках; сначала закрой известные угрозы перед следующим уроном.' : '';
  // A draft capability does not describe the current fight. Adapt only after
  // a damage item and a contextual trigger, not for any single magic hero.
  const contextualProtection = state.gameTime >= 900 && hasDamageItem && controlledBy.length >= 2 && magicFrom.length >= 1 && (repeatedDeaths || lostLane || fighting);
  const contextualArmor = state.gameTime >= 1500 && hasDamageItem && physicalFrom.length >= 2 && armorFrom.length >= 1 && (repeatedDeaths || lostLane || fighting);
  const urgentProtection = manualProtection || contextualProtection;
  function prioritize(target, reason, type) {
    if (!catalog[target] || isOwned(target, owned)) return;
    const existing = candidates.findIndex(entry => entry.key === target);
    const entry = existing >= 0 ? candidates.splice(existing, 1)[0] : { key: target };
    candidates.unshift({ ...entry, reason, override: true, overrideType: type });
  }
  if (contextualArmor && [42, 18].includes(rule.id)) prioritize('assault', `${armorFrom.map(hero => hero.name).join(', ')} снижают броню; ${physicalFrom.map(hero => hero.name).join(', ')} дают физический урон. ${currentReason} Assault Cuirass — вариант защиты и командной ауры; проверь, не купил ли её союзник.`, 'physical_protection');
  if (urgentProtection) prioritize('black_king_bar', `${manualProtection ? 'Ты отметил актуальную угрозу магии/контроля.' : currentReason} ${controlledBy.map(hero => hero.name).join(', ')}: возможна цепочка контроля; ${magicFrom.map(hero => hero.name).join(', ') || 'в составе отмечена магия'}: магический урон.`, 'spell_protection');
  return candidates.map((entry, index) => {
    const item = catalog[entry.key], sample = nonnegative(build.matches) ?? nonnegative(provider.sampleCount);
    const timing = nonnegative(entry.timeSeconds);
    const timingText = timing === null ? '' : ` В выбранной последовательности покупка была примерно на ${Math.floor(timing / 60)}:${String(Math.floor(timing % 60)).padStart(2, '0')}; это наблюдение, не обязательный срок.`;
    const threatNames = matchup.details.filter(hero => hero.tags.includes('magic') || hero.tags.includes('control')).slice(0, 2).map(hero => hero.name).join(', ');
    const bypassNames = matchup.details.filter(hero => [2, 3, 28, 41, 69, 104, 112].includes(hero.id)).map(hero => hero.name).join(', ');
    const reason = entry.key === 'black_king_bar' ? `${urgentProtection ? `${entry.reason} Порядок сборки изменён правилом по матчапу. ` : 'Защита в выбранной последовательности. '}${threatNames ? `${threatNames}: возможны магия и контроль. ` : ''}Проверь реальные заклинания перед входом.${bypassNames ? ` ${bypassNames}: важный контроль может проходить через невосприимчивость к эффектам; BKB не гарантирует безопасный вход.` : ''}${timingText}` : `${entry.reason || (index === 0 ? 'Следующий недостающий предмет выбранной carry-сборки.' : 'Следующий шаг выбранной carry-сборки.')}${timingText}`;
    return { key: entry.key, name: item.dname || entry.key, cost: nonnegative(item.cost), remainingGold: remainingCost(entry.key, catalog, inventory),
      reason, source: `${entry.override ? 'Правило по подтверждённому матчапу + ' : ''}${provider.source || 'Наблюдаемая carry-сборка'}`, sourceUrl: provider.sourceUrl || null,
      evidenceCount: sample || 0, sampleCount: sample, timingSeconds: timing, buildId: build.id || null,
      patch: provider.patch || null, override: entry.override === true,
      overrideType: entry.overrideType || null,
    };
  });
}
function observations(key, dataset, phase) {
  const id = object(dataset.items)[key]?.id;
  if (id == null) return 0;
  const index = phase === 'start' ? 0 : phase === 'early' ? 1 : phase === 'mid' ? 2 : 3;
  return nonnegative(object(object(dataset.popularity)[PHASES[index]])[String(id)]) ?? 0;
}
function allObservations(key, dataset) {
  const id = object(dataset.items)[key]?.id;
  return id == null ? 0 : PHASES.reduce((sum, phase) => sum + (nonnegative(object(object(dataset.popularity)[phase])[String(id)]) ?? 0), 0);
}
function remainingCost(key, catalog, inventoryNames) {
  const target = catalog[key];
  if (!target || nonnegative(target.cost) === null) return null;
  const available = new Map();
  for (const name of inventoryNames) available.set(name, (available.get(name) || 0) + 1);
  function credit(component, trail) {
    if (trail.has(component)) return 0;
    const data = catalog[component];
    if (!data) return 0;
    if ((available.get(component) || 0) > 0) {
      available.set(component, available.get(component) - 1);
      return nonnegative(data.cost) ?? 0;
    }
    const next = new Set(trail).add(component);
    return (Array.isArray(data.components) ? data.components : []).reduce((sum, part) => sum + credit(itemKey(part), next), 0);
  }
  const discount = (Array.isArray(target.components) ? target.components : []).reduce((sum, part) => sum + credit(itemKey(part), new Set([key])), 0);
  return Math.max(0, target.cost - discount);
}
function emptyThreats() { return Object.fromEntries(THREAT_KEYS.map(key => [key, false])); }
function visibleRosterIds(vision, relation, ownTeam) {
  const roster = Array.isArray(vision.roster) ? vision.roster : vision.roster?.slots;
  ownTeam = typeof ownTeam === 'string' ? ownTeam.toLowerCase() : null;
  return ids((Array.isArray(roster) ? roster : []).filter(slot => {
    let side = slot.relation || slot.side || slot.team;
    if (['radiant', 'dire'].includes(ownTeam) && ['radiant', 'dire'].includes(side)) side = side === ownTeam ? 'ally' : 'enemy';
    return side === relation && number(slot.hero?.confidence ?? slot.confidence) >= .9;
  }).map(slot => slot.hero?.id ?? slot.heroId ?? slot.id));
}
function heroTags(hero, dataset) {
  const explicit = Array.isArray(hero.tags) ? hero.tags : [];
  const abilities = Array.isArray(hero.abilities) ? hero.abilities : [];
  const abilityTags = abilities.flatMap(key => Array.isArray(object(dataset.abilities)[key]?.tags) ? dataset.abilities[key].tags : []);
  return [...new Set([...explicit, ...abilityTags, ...(HERO_TAGS[hero.id] || [])])].filter(key => THREAT_KEYS.includes(key));
}
function matchupFor(dataset, context) {
  const vision = object(context.vision);
  // Confirming a lane opponent also confirms that hero is in the enemy draft;
  // the reverse implication never holds in coachingFor.
  const manualIds = ids([...(Array.isArray(context.enemyHeroIds) ? context.enemyHeroIds : []), ...(Array.isArray(context.laneEnemyHeroIds) ? context.laneEnemyHeroIds : [])]);
  const inferredIds = vision.quality?.usable === true ? visibleRosterIds(vision, 'enemy', context.playerTeam) : [];
  const enemies = manualIds.length ? manualIds : inferredIds;
  const manual = context.draftSource === 'manual' || (manualIds.length > 0 && context.draftSource !== 'vision');
  const threatOverrides = object(context.threats), threats = emptyThreats();
  const details = []; let recognized = 0;
  for (const id of enemies) {
    const catalogHero = object(object(dataset.heroes)[id]);
    if (!Object.keys(catalogHero).length) continue;
    const hero = { ...catalogHero, id };
    const tags = heroTags(hero, dataset);
    if (tags.length) recognized++;
    for (const key of tags) threats[key] = true;
    details.push({ id, name: hero.localizedName || hero.localized_name || hero.name || `Герой ${id}`, tags });
  }
  for (const key of THREAT_KEYS) if (threatOverrides[key] === true) threats[key] = true;
  // Support the previous UI's manaDrain spelling, without silently treating any
  // omitted or false manual checkbox as proof that a hero lacks that capability.
  const extra = THREAT_KEYS.some(key => threatOverrides[key] === true);
  const labels = THREAT_KEYS.filter(key => threats[key]).map(key => THREAT_LABELS[key]);
  const declaredConfidence = number(context.draftConfidence);
  const identityConfidence = declaredConfidence === null ? (manual ? 1 : .9) : Math.max(0, Math.min(1, declaredConfidence));
  const coverage = enemies.length ? recognized / enemies.length : 0;
  return {
    threats,
    summary: labels.length ? `Возможные угрозы состава: ${labels.join(', ')}. Это оценка возможностей героев; уровни, предметы и позиции врагов нужно подтвердить.` : enemies.length ? 'Для выбранного состава пока нет достаточных данных о конкретных угрозах.' : 'Состав противника не подтверждён. Выбери героев или дождись уверенного распознавания портретов.',
    confidence: Math.min(.8, identityConfidence * coverage * .8) || (extra ? .5 : 0),
    source: enemies.length ? `${manual ? 'Герои выбраны вручную' : 'Герои распознаны на экране'} + OpenDota: имена героев + вручную заданные категории угроз${extra ? '; твои отметки угроз' : ''}` : extra ? 'Твои отметки угроз; состав не подтверждён' : 'Состав не подтверждён',
    details, enemyHeroIds: enemies,
  };
}
function chooseItems(state, dataset, context, phase, matchup) {
  const observed = proItems(state, dataset, context, matchup, phase);
  if (observed !== null) return observed;
  const carry = carryRuleFor(state, dataset, context);
  if (carry && carry.id !== WK_ID) {
    // Offline rules are explicitly labelled and never inherit WK's popularity
    // or imply that the sequence is an up-to-date professional build.
    return proItems(state, dataset, { ...context, buildId: null, proBuild: {
      heroId: carry.id, role: 'carry', status: 'authored', sourceKind: 'authored',
      source: `Авторский резервный план ${carry.name}; статистика сборок недоступна`,
      builds: [{ id: `authored-${carry.id}`, sequence: carry.fallback.map(key => ({ key })) }],
    } }, matchup, phase) || [];
  }
  const catalog = object(dataset.items), owned = ownedItems(state), threats = matchup.threats;
  const minutes = (state.gameTime ?? 0) / 60;
  const plan = ['farm', 'fight', 'balanced'].includes(context.plan) ? context.plan : 'balanced';
  const candidates = [];
  function add(key, score, reason) {
    if (!catalog[key] || isOwned(key, owned)) return;
    const evidenceCount = observations(key, dataset, phase);
    candidates.push({ key, score: score + Math.min(8, Math.log1p(evidenceCount)), reason, evidenceCount });
  }
  if (phase === 'start') {
    add('quelling_blade', 120, 'Для добивания крипов на линии; сначала проверь стартовую закупку.');
    add('tango', 110, 'Для восстановления на линии. Количество зависит от уже купленных расходников.');
    add('branches', 100, 'Недорогие характеристики для старта; учти свободные слоты.');
  }
  add('power_treads', minutes < 12 ? 105 : 88, 'Ботинки и скорость атаки помогают фармить и перемещаться. Учтены уже купленные компоненты.');
  add('armlet', minutes < 18 ? 90 : 40, 'Ранняя боевая сборка: урон и выживаемость. Активная часть требует контроля здоровья.');
  const hasDamageItem = owned.has('radiance') || owned.has('desolator');
  const protectionNeeded = threats.magic || threats.control;
  const spellThreats = matchup.details.filter(hero => hero.tags.includes('magic') || hero.tags.includes('control')).slice(0, 2).map(hero => hero.name).join(', ');
  const bypassNames = matchup.details.filter(hero => [2, 3, 28, 41, 69, 104, 112].includes(hero.id)).map(hero => hero.name).join(', ');
  const bkbReason = `${spellThreats ? `${spellThreats}: возможны магия и контроль. ` : 'В составе отмечены магия или контроль. '}BKB помогает выбрать окно для драки перед новым уроном.${bypassNames ? ` ${bypassNames}: важный контроль может проходить через невосприимчивость к эффектам — BKB не гарантирует безопасный вход.` : ' Проверь конкретные способности: не каждый контроль блокируется BKB.'}`;
  if (protectionNeeded) add('black_king_bar', minutes >= 12 ? 115 : 60, bkbReason);
  else add('black_king_bar', minutes >= 20 && hasDamageItem ? 90 : 35, 'Вариант для участия в драках. Проверь конкретные способности врагов перед покупкой.');
  if (!hasDamageItem) {
    const farmRoute = plan === 'farm' || plan === 'balanced' && allObservations('radiance', dataset) >= allObservations('desolator', dataset);
    const illusionNames = matchup.details.filter(hero => hero.tags.includes('illusions')).slice(0, 2).map(hero => hero.name).join(', ');
    add('radiance', owned.has('relic') ? 104 : minutes > 24 ? 20 : threats.illusions ? 89 : farmRoute ? 83 : 52, threats.illusions ? `${illusionNames ? `${illusionNames}: ` : ''}у выбранных героев есть иллюзии. Radiance даёт дополнительный урон по площади. Сначала оцени время на сборку и темп матча.` : 'Вариант для продолжительного фарма. Покупай, если есть безопасное время на сборку; учитывай темп матча.');
    add('desolator', plan === 'fight' || !farmRoute || minutes > 24 ? 84 : 55, 'Вариант для раннего давления и физического урона. Цели выбирай вместе с командой.');
  }
  add('blink', hasDamageItem || minutes >= 22 ? 80 : 30, 'Позволяет выбирать момент входа. Перед прыжком проверь видимых врагов и готовность союзников.');
  const armorNames = matchup.details.filter(hero => hero.tags.includes('armor') || hero.tags.includes('physical')).slice(0, 2).map(hero => hero.name).join(', ');
  add('assault', minutes >= 27 ? (threats.armor || threats.physical ? 98 : 76) : 24, threats.armor || threats.physical ? `${armorNames ? `${armorNames}: ` : ''}физический урон или снижение брони повышают ценность Assault Cuirass. Проверь, есть ли эта аура у союзника.` : 'Поздний вариант для брони и физического давления. Проверь, есть ли уже эта аура у союзника.');
  add('abyssal_blade', minutes >= 30 ? 75 : 20, 'Поздний вариант для удержания выбранной цели; зависит от нехватки контроля у команды.');
  const unique = new Map();
  for (const candidate of candidates) if (!unique.has(candidate.key) || unique.get(candidate.key).score < candidate.score) unique.set(candidate.key, candidate);
  return [...unique.values()].sort((a, b) => b.score - a.score || a.key.localeCompare(b.key)).map(candidate => {
    const data = catalog[candidate.key];
    return { key: candidate.key, name: data.dname || candidate.key, cost: nonnegative(data.cost),
      remainingGold: remainingCost(candidate.key, catalog, (state.inventory || []).map(item => itemKey(item.name))),
      reason: candidate.reason, source: 'Объяснимые правила + OpenDota: частота покупок', evidenceCount: candidate.evidenceCount,
    };
  });
}
function mapEvidence(state, context, matchup) {
  const vision = object(context.vision), now = number(context.now) ?? Date.now();
  const stamp = number(vision.capturedAt) ?? number(vision.receivedAt) ?? number(vision.timestamp);
  const staleAfterMs = number(context.screenStaleAfterMs) ?? 5000;
  if (vision.quality?.usable !== true || stamp === null || now - stamp > staleAfterMs || stamp - now > 1000) return null;
  const markers = Array.isArray(vision.minimap?.heroes) ? vision.minimap.heroes : [];
  const valid = markers.filter(marker => heroId(marker.id ?? marker.heroId) !== null && number(marker.x) !== null && number(marker.y) !== null && marker.x >= 0 && marker.x <= 1 && marker.y >= 0 && marker.y <= 1 && number(marker.confidence) !== null);
  const ownId = heroId(state.heroId) ?? WK_ID;
  const selves = valid.filter(marker => heroId(marker.id ?? marker.heroId) === ownId && marker.confidence >= .87);
  // Multiple own markers may be illusions or false matches: do not select one.
  if (selves.length !== 1) return null;
  const self = selves[0], enemies = new Set(matchup.enemyHeroIds), allies = new Set(ids(context.alliedHeroIds));
  for (const id of visibleRosterIds(vision, 'ally', context.playerTeam ?? state.team)) allies.add(id);
  const distance = marker => Math.hypot(marker.x - self.x, marker.y - self.y);
  const nearbyEnemies = valid.filter(marker => heroId(marker.id ?? marker.heroId) !== ownId && enemies.has(heroId(marker.id ?? marker.heroId)) && marker.confidence >= .9 && distance(marker) <= .23);
  const nearbyAllies = valid.filter(marker => heroId(marker.id ?? marker.heroId) !== ownId && allies.has(heroId(marker.id ?? marker.heroId)) && marker.confidence >= .9 && distance(marker) <= .23);
  return { nearbyEnemies: [...new Set(nearbyEnemies.map(marker => heroId(marker.id ?? marker.heroId)))], nearbyAllies: [...new Set(nearbyAllies.map(marker => heroId(marker.id ?? marker.heroId)))], selfConfidence: self.confidence };
}
function healthResources(state) {
  const available = (state.inventory || []).filter(item => (item.activeSlot === true || /^slot[0-5]$/.test(item.slot || '')) && item.cooldown === 0 && item.canCast !== false);
  const stick = available.find(item => ['magic_wand', 'magic_stick'].includes(itemKey(item.name)) && item.charges > 0);
  if (stick) return `В активном слоте есть ${itemKey(stick.name) === 'magic_wand' ? 'Magic Wand' : 'Magic Stick'} с ${stick.charges} зарядами; используй восстановление, если оно доступно в текущей ситуации.`;
  if (available.some(item => itemKey(item.name) === 'satanic')) return 'Satanic готов по таймеру в активном слоте; восстановление требует возможности атаковать.';
  return '';
}
function actionFor(state, context, matchup, coaching = {}) {
  if (state.isPaused) return { title: 'Матч на паузе', reason: 'Подсказки по действиям возобновятся после снятия паузы.', tone: 'neutral' };
  if (state.gameState && /POST_GAME|DISCONNECT|INIT|WAIT_FOR_PLAYERS|HERO_SELECTION|STRATEGY_TIME|TEAM_SHOWCASE|CUSTOM_GAME_SETUP/.test(state.gameState)) return { title: 'Подготовка к матчу', reason: 'Советы появятся, когда будет состояние своего героя в игре.', tone: 'neutral' };
  if (state.alive === false) return { title: 'Подготовь следующий выход', reason: 'Проверь закупку и безопасный путь к фарму. Решение о выкупе требует оценки карты.', tone: 'neutral' };
  if (state.alive !== true || state.healthPercent === null) return { title: 'Ожидаю состояние героя', reason: 'В GSI пока нет данных о жизни или здоровье; совет по действиям будет ненадёжным.', tone: 'neutral' };
  if (state.healthPercent <= 35) return { title: 'Снизь риск и восстановись', reason: `Здоровье ниже 35%. Отойди в безопасное место, если это возможно. ${healthResources(state) || 'Положение врагов нужно проверить по карте.'}`, tone: 'danger' };
  const map = mapEvidence(state, context, matchup);
  if (map?.nearbyEnemies.length > 0 && map.nearbyAllies.length === 0) return { title: 'Проверь угрозу рядом на карте', reason: `Миникарта: рядом с твоей уверенно распознанной иконкой видны ${map.nearbyEnemies.length} противн. из известного состава; союзники рядом не подтверждены. Снизь риск и проверь основной экран. Это расстояние на миникарте, не подтверждение атаки.`, tone: 'warning', source: 'screen', confidence: Math.min(map.selfConfidence, .9) };
  const carry = carryRuleFor(state, {}, { ...context, heroId: context.heroId ?? state.heroId }), ultimate = abilityFor(state, carry?.ultimate);
  if (!carry?.ultimatePassive && ultimate?.level > 0 && ultimate.cooldown > 0) return { title: 'Играй осторожнее без ультимейта', reason: `${carry.ultimateLabel} на перезарядке: ${Math.ceil(ultimate.cooldown)} с. Не начинай рискованную драку без оценки союзников и карты.`, tone: 'warning' };
  if (state.manaPercent !== null && state.manaPercent < 20) return { title: 'Проверь запас ресурсов', reason: `Маны меньше 20%. Проверь стоимость доступных способностей в текущем патче.${matchup.threats.manaDrain ? ' У выбранных противников возможна потеря маны.' : ''}${carry?.ultimatePassive ? ' Не рассчитывай на активные способности без запаса маны.' : ' Таймер ультимейта сам по себе не подтверждает возможность его срабатывания.'}`, tone: 'warning' };
  if (coaching.stage?.id === 'laning' && coaching.lane?.opponents.length) return { title: coaching.lane.title, reason: `${coaching.lane.reason} ${coaching.lane.tips[0] || ''}`, tone: coaching.lane.style === 'defensive' ? 'warning' : 'neutral', source: 'lane', confidence: coaching.lane.confidence };
  if (coaching.stage?.id === 'transition' && coaching.postLane) return { title: coaching.postLane.title, reason: `${coaching.postLane.reason} ${coaching.postLane.priorities[0]}`, tone: coaching.postLane.result === 'lost' ? 'warning' : 'neutral', source: 'post_lane', confidence: coaching.postLane.confidence };
  if (coaching.stageAdvice) return { title: coaching.stageAdvice.mainTitle, reason: `${coaching.stageAdvice.mainReason} ${coaching.stageAdvice.skillUseReason}`, tone: 'neutral', source: 'stage', confidence: coaching.stageAdvice.confidence };
  return { title: 'Проверь карту перед следующим шагом', reason: `Продолжай безопасный фарм или присоединяйся к команде при видимой возможности. ${carry?.ultimatePassive ? 'Оцени защиту и возможность безопасного входа.' : `Готовность ${carry?.ultimateLabel || 'ультимейта'} не подтверждена.`}`, tone: 'neutral' };
}
function recommend(state, dataset, context = {}) {
  state = object(state); dataset = object(dataset); context = object(context);
  const carry = carryRuleFor(state, dataset, context), observedCarry = identifyCarry(state.heroId, state.heroName);
  const now = number(context.now) ?? Date.now(), staleAfterMs = number(context.staleAfterMs) ?? 15000;
  const receivedAt = number(state.receivedAt);
  const freshGsi = receivedAt !== null && now - receivedAt <= staleAfterMs && receivedAt - now <= 1000;
  const screenPlayer = object(context.screenPlayer), observedAt = number(screenPlayer.observedAt);
  const screenCurrent = carry?.id === WK_ID && context.laneSource === 'screen_current' && screenPlayer.source === 'selected_hud' && screenPlayer.confirmed === true && screenPlayer.heroId === WK_ID && ['radiant', 'dire'].includes(screenPlayer.team) && observedAt !== null && now - observedAt <= 8000 && observedAt - now <= 1000;
  const spectator = state.isSpectator || state.status === 'spectator';
  const otherHero = !carry || !observedCarry || observedCarry.id !== carry.id || carry.id === WK_ID && state.isWraithKing === false || state.isSupportedCarry === false;
  const knownOtherHero = otherHero && (state.heroId != null || state.heroName != null || state.status === 'wrong_hero');
  // A verified selected-HUD label can identify a visible WK while GSI is
  // absent. A fresh contradictory personal packet remains authoritative.
  const screenAllowed = screenCurrent && !(freshGsi && (spectator || knownOtherHero || state.team != null && state.team !== screenPlayer.team));
  const manualAllowed = context.laneSource === 'manual' && carry && dataset.heroId === carry.id && ids(context.laneEnemyHeroIds).length > 0 && !(freshGsi && (spectator || knownOtherHero));
  const phase = phaseFor(number(state.gameTime)), matchup = matchupFor(dataset, { ...context, playerTeam: context.playerTeam ?? state.team });
  const unavailable = (title, reason) => {
    // A sourced build's public skill sequence remains useful in preview. It
    // cannot establish the current player's ranks, points or next upgrade.
    const publicSkills = skillsFor({}, dataset, context);
    const skills = { ...publicSkills, next: null, status: 'unavailable', publicPlanStatus: publicSkills.status, previewOnly: publicSkills.order.length > 0, pointsKnown: false, confidence: 0,
      reason: publicSkills.order.length ? `Показан план выбранной carry-сборки. ${publicSkills.levelCaveat || publicSkills.reason} Текущее состояние героя и свободные очки не подтверждены; следующий навык не предлагается.` : reason };
    const result = { item: null, alternatives: [], action: { title, reason, tone: 'neutral' }, phase, stage: stageFor(state, context), stageAdvice: null, skills, matchup: { ...matchup, confidence: 0 } };
    if (!screenAllowed && !manualAllowed) return result;
    // Never reuse stale hero resources, economy checkpoints or a remembered
    // lane outcome as facts about this newly observed nearby group.
    const coaching = coachingFor({}, dataset, { ...context, staticMatchup: manualAllowed, history: [], laneSnapshot: {}, laneOutcomeAssessment: {}, laneResult: 'auto', laneOutcome: 'unknown', stageOverride: null, previousStage: null });
    const screenReason = !freshGsi || otherHero ? 'Нет свежего состояния своего героя из GSI. Данные о предметах, здоровье и готовности навыков ожидают подключения.' : reason;
    const staticSource = manualAllowed ? 'manual_matchup' : 'screen_current';
    return { ...result, ...coaching, phase: 'unknown', ...(manualAllowed ? { manualOnly: true } : { screenOnly: true }),
      stage: { id: 'unknown', title: manualAllowed ? 'План выбранной линии' : 'Видимые герои', source: staticSource, automatic: !manualAllowed, matchId: null, reason: manualAllowed ? 'Состав выбран тобой; показаны условные правила без оценки состояния игрока.' : 'Герои рядом с WK подтверждены по экрану; стадия матча и состояние игрока не подтверждены.' },
      skills: result.skills, matchup,
      action: { title: coaching.lane.opponents.length ? coaching.lane.title : 'Наблюдаю героев рядом с WK', reason: `${coaching.lane.reason} ${screenReason} Показаны условные правила по ${manualAllowed ? 'выбранному составу' : 'видимым героям'}; собственные ресурсы и перезарядки неизвестны.`, tone: 'neutral', source: staticSource, confidence: coaching.lane.confidence },
    };
  };
  if (spectator) return unavailable('Режим наблюдателя не поддерживается', 'Этот помощник использует только данные игрока.');
  if (otherHero) return unavailable(state.heroName || state.heroId ? 'Выбран другой герой' : `Ожидаю ${carry?.name || 'поддерживаемого керри'}`, `Рекомендации настроены для ${carry?.name || 'поддерживаемого керри'}. Вернись к своему герою, если выбрана другая единица.`);
  if (!freshGsi) return unavailable('Данные устарели', 'Свежие сообщения GSI не приходят. Советы по собственным предметам и ресурсам появятся после восстановления связи.');
  const coaching = coachingFor(state, dataset, context);
  const action = actionFor(state, context, matchup, coaching);
  if (state.isPaused || state.gameState && /POST_GAME|DISCONNECT|INIT|WAIT_FOR_PLAYERS|HERO_SELECTION|STRATEGY_TIME|TEAM_SHOWCASE|CUSTOM_GAME_SETUP/.test(state.gameState)) return unavailable(action.title, action.reason);
  if (!carry || dataset.heroId !== carry.id || !Object.keys(object(dataset.items)).length) return { ...unavailable(`Нет датасета ${carry?.name || 'выбранного героя'}`, 'Обнови локальные данные OpenDota.'), action };
  if (state.dataQuality?.inventory === false || !Array.isArray(state.inventory) || phase === 'unknown') return { item: null, alternatives: [], action, phase, matchup, ...coaching };
  const items = chooseItems(state, dataset, context, phase, matchup);
  return { item: items[0] || null, alternatives: items.slice(1, 3), action, phase, matchup, ...coaching };
}
module.exports = { normalizeGsi, recommend, HERO_TAGS };



