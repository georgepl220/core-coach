'use strict';

// Offline normalization of user-authored routes and explicitly permitted
// exports. This module never retrieves or scrapes the ProTracker website.
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { validateImport, validatePersonalImport, SOURCE_URL } = require('../scripts/update-protracker.cjs');
const { providerHero, heroSourceUrls } = require('./provider-hero.cjs');
const MAX_BYTES = 1024 * 1024;
const LEVELS = [10, 15, 20, 25];
const plain = value => value && typeof value === 'object' && !Array.isArray(value);

function talentLabel(talent, hero) {
  return String(talent.name_loc || talent.name).replace(/\{s:([^}]+)\}/g, (_, placeholder) => {
    const special = placeholder.replace(/^bonus_/, '');
    const own = (talent.special_values || []).find(value => value.name === special)?.values_float?.[0];
    if (typeof own === 'number') return String(own);
    for (const ability of hero.abilities || []) {
      const entry = (ability.special_values || []).find(value => value.name === special);
      const bonus = entry?.bonuses?.find(value => value.name === talent.name)?.value;
      if (typeof bonus === 'number') return String(bonus);
    }
    return '?';
  });
}

function abilityCatalogFromValve(heroData, options = {}) {
  const selected = providerHero(options);
  const hero = heroData?.result?.data?.heroes?.find(value => value.id === selected.id) || (heroData?.id === selected.id ? heroData : null);
  if (!hero || !Array.isArray(hero.abilities)) throw new Error(`Invalid Valve ${selected.displayName} ability catalog`);
  const catalog = {};
  const hotkeys = ['Q', 'W', 'E', 'D', 'R'];
  let basicIndex = 0;
  for (let index = 0; index < hero.abilities.length; index++) {
    const ability = hero.abilities[index];
    if (!Number.isInteger(ability.id) || typeof ability.name !== 'string') continue;
    const ultimate = ability.type === 1;
    catalog[ability.name] = {
      abilityId: ability.id, abilityKey: ability.name, label: ability.name_loc || ability.name,
      hotkey: ultimate ? 'R' : hotkeys[basicIndex] || null, maxRank: ability.max_level,
      innate: ability.ability_is_innate === true, isInnate: ability.ability_is_innate === true, kind: ultimate ? 'ultimate' : 'basic',
      granted: ability.ability_is_granted_by_scepter === true || ability.ability_is_granted_by_shard === true,
      learnable: ability.ability_is_innate !== true && ability.ability_is_granted_by_scepter !== true && ability.ability_is_granted_by_shard !== true && ability.max_level > 0,
      minimumLevels: ultimate ? [6, 12, 18] : [1, 3, 5, 7],
    };
    if (!ultimate && ability.ability_is_innate !== true && ability.ability_is_granted_by_scepter !== true && ability.ability_is_granted_by_shard !== true) basicIndex++;
  }
  for (let index = 0; index < (hero.talents || []).length; index++) {
    const talent = hero.talents[index];
    catalog[talent.name] = {
      abilityId: talent.id, abilityKey: talent.name, label: talentLabel(talent, hero),
      hotkey: 'T', maxRank: 1, innate: false, isInnate: false, kind: 'talent',
      minimumLevels: [LEVELS[Math.floor(index / 2)]], talentTier: LEVELS[Math.floor(index / 2)],
    };
  }
  return catalog;
}

function defaultAbilityCatalog(options = {}) {
  // Saved Valve catalog is small, offline, and shipped with the prototype.
  const hero = providerHero(options);
  return abilityCatalogFromValve(require(hero.id === 42 ? '../data/sources/wk-live-abilities.json' : `../data/sources/${hero.slug}-live-abilities.json`), { heroId: hero.id });
}

function normalizeSkills(input, catalog, options = {}) {
  if (input == null) return [];
  if (!Array.isArray(input) || input.length > 30) throw new Error('Ожидается не более 30 строк прокачки');
  const skills = [], ranks = new Map(), levels = new Set(), talents = new Set();
  for (const entry of [...input].sort((a, b) => (a?.heroLevel ?? a?.level ?? 0) - (b?.heroLevel ?? b?.level ?? 0))) {
    if (!plain(entry)) throw new Error('Некорректная строка прокачки');
    const heroLevel = entry.heroLevel ?? entry.level;
    const abilityKey = entry.abilityKey ?? entry.key;
    const ability = typeof abilityKey === 'string' && Object.hasOwn(catalog, abilityKey) ? catalog[abilityKey] : null;
    if (!Number.isInteger(heroLevel) || heroLevel < 1 || heroLevel > 30 || levels.has(heroLevel)) throw new Error('Уровень героя должен быть уникальным числом от 1 до 30');
    if (!ability || ability.innate === true || ability.granted === true || ability.learnable === false || (entry.abilityId != null && entry.abilityId !== ability.abilityId)) throw new Error(`Способность недоступна для прокачки: ${abilityKey || '(нет имени)'}`);
    const rank = (ranks.get(abilityKey) || 0) + 1;
    if (rank > ability.maxRank || heroLevel < ability.minimumLevels[rank - 1]) throw new Error(`Недоступный ранг способности на уровне ${heroLevel}`);
    if (ability.kind === 'talent') {
      // The second talent at a tier is only unlocked after level 25.
      if (talents.has(ability.talentTier) && heroLevel <= 25) throw new Error('Оба таланта одного уровня недоступны до уровня 26');
      talents.add(ability.talentTier);
    }
    levels.add(heroLevel); ranks.set(abilityKey, rank);
    skills.push({ heroLevel, abilityKey, abilityId: ability.abilityId, label: ability.label, hotkey: ability.hotkey, rank, levelVerified: options.levelVerified !== false });
  }
  return skills.sort((a, b) => a.heroLevel - b.heroLevel);
}

function extractObservedSkills(player, catalog, sourceMatchId) {
  const byId = new Map(Object.values(catalog).map(ability => [ability.abilityId, ability]));
  const logs = player?.ability_upgrades_log || player?.ability_upgrades;
  if (Array.isArray(logs) && logs.length && logs.every(entry => plain(entry) && Number.isInteger(entry.level))) {
    try {
      const skills = normalizeSkills(logs.map(entry => ({ heroLevel: entry.level, abilityKey: byId.get(entry.ability)?.abilityKey, abilityId: entry.ability })), catalog);
      return { skills: skills.map(skill => ({ ...skill, sourceMatchId })), kind: 'recorded_upgrade_log_with_hero_levels', levelVerified: true, unknownAbilityIds: [] };
    } catch { /* Retain the array order below if logs are incomplete. */ }
  }
  const upgrades = player?.ability_upgrades_arr;
  if (!Array.isArray(upgrades)) return { skills: [], kind: 'unavailable', levelVerified: false, unknownAbilityIds: [] };
  const skills = [], ranks = new Map(), unknownAbilityIds = [];
  let previousLevel = 0;
  for (let index = 0; index < Math.min(upgrades.length, 30); index++) {
    const abilityId = upgrades[index], ability = byId.get(abilityId);
    if (!ability || ability.innate || ability.granted || ability.learnable === false) { unknownAbilityIds.push(abilityId); continue; }
    const rank = (ranks.get(ability.abilityKey) || 0) + 1;
    const minimum = ability.minimumLevels[rank - 1];
    if (rank > ability.maxRank || !Number.isInteger(minimum)) { unknownAbilityIds.push(abilityId); continue; }
    // An omitted unknown upgrade still consumed a skill point. Preserve its
    // position when establishing a lower bound for subsequent hero levels.
    const heroLevel = Math.max(previousLevel + 1, index + 1, minimum);
    if (heroLevel > 30) break;
    skills.push({ heroLevel, abilityKey: ability.abilityKey, abilityId, label: ability.label, hotkey: ability.hotkey, rank, upgradeIndex: index + 1, sourceMatchId, levelVerified: false });
    previousLevel = heroLevel; ranks.set(ability.abilityKey, rank);
  }
  return { skills, kind: 'recorded_upgrade_order_reconstructed_levels', levelVerified: false, unknownAbilityIds };
}

function normalizeBuildImport(input, itemCatalog, options = {}) {
  if (!plain(input)) throw new Error('Файл должен содержать JSON-объект сборки');
  const hero = providerHero(options);
  const kind = options.kind || input.kind || (input.license ? 'authorized-protracker' : null);
  if (!['personal', 'authorized-protracker'].includes(kind)) throw new Error('Укажи kind: personal для своей сборки или предоставь разрешённый экспорт');
  const now = options.now || new Date().toISOString();
  const abilityCatalog = options.abilityCatalog || defaultAbilityCatalog({ heroId: hero.id });
  // Existing item/provenance validation remains the single authority for each
  // source. Talent keys receive stricter live-hero validation separately.
  const itemInput = { ...input, build: { ...input.build, skills: [] } };
  const original = kind === 'authorized-protracker' ? validateImport(itemInput, itemCatalog, now, { heroId: hero.id }) : validatePersonalImport(itemInput, itemCatalog, now, { heroId: hero.id });
  const skills = normalizeSkills(input.build.skills, abilityCatalog, { levelVerified: kind !== 'personal' });
  let patch = original.patch || null;
  if (kind === 'personal' && input.patch != null) {
    if (!plain(input.patch) || typeof input.patch.name !== 'string' || !/^\d+\.\d+[a-z]?$/.test(input.patch.name)) throw new Error('Некорректный патч личной сборки');
    patch = { name: input.patch.name, verified: false, minorPatchVerified: false, scope: 'Указан пользователем; принадлежность патчу не проверена' };
  }
  const sequence = original.build.items.map(item => ({ key: item.key, stage: item.phase || 'situational', timeSeconds: item.timingMinutes == null ? null : Math.round(item.timingMinutes * 60), targetMinutes: item.targetMinutes ?? null }));
  return {
    ...original, role: 'carry', source: kind === 'personal' ? 'Личная сборка' : original.source,
    patch, patchVerified: false, currentAbilityCatalog: abilityCatalog, abilities: abilityCatalog,
    externalUrl: heroSourceUrls(hero).d2pt, build: { ...original.build, skills },
    builds: [{ id: kind === 'personal' ? 'personal' : 'authorized-protracker', matches: original.sampleCount, frequency: null, winRate: null, sequence, skills, skillOrderKind: kind === 'personal' ? 'personal_authored_level_plan' : 'authorized_export_level_plan', skillLevelsVerified: kind !== 'personal', skillSourceMatchId: null, sourceMatchIds: [], timingKind: kind === 'personal' ? 'personal_target_or_unspecified' : 'authorized_export' }],
    itemStats: original.build.items.map(item => ({ key: item.key, frequency: item.frequency ?? null, medianTimeSeconds: item.timingMinutes == null ? null : item.timingMinutes * 60 })),
    benchmarkCheckpoints: original.benchmarks, benchmarks: { lastHits: [], netWorth: [] },
    importedAt: now,
  };
}

async function importBuildFile(file, destination, itemCatalog, options = {}) {
  const stat = await fs.stat(file);
  if (stat.size > MAX_BYTES) throw new Error('Файл сборки превышает 1 МБ');
  const bytes = await fs.readFile(file);
  const input = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  const result = normalizeBuildImport(input, itemCatalog, options);
  result.provenance.importSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  await require('../scripts/update-d2pt.cjs').writeAtomic(destination, result);
  return result;
}

module.exports = { MAX_BYTES, abilityCatalogFromValve, defaultAbilityCatalog, normalizeSkills, extractObservedSkills, normalizeBuildImport, importBuildFile };
