'use strict';
const { readResource } = require('./valve-vpk.cjs');
const HEROES = Object.values(require('../data/wraith-king.json').heroes);
const schemaCache = new WeakMap();
const referenceCache = new WeakMap();
const problem = (code, message) => Object.assign(new Error(message), { code });
const values = value => Array.isArray(value) ? value : value == null ? [] : [value];

function parseKeyValues(source) {
  if (typeof source !== 'string' || source.length > 128 * 1024 * 1024) throw problem('SCHEMA_INVALID', 'Unsupported item schema size.');
  let cursor = 0;
  const token = () => {
    while (cursor < source.length) {
      if (/\s/.test(source[cursor])) { cursor++; continue; }
      if (source.startsWith('//', cursor)) { const next = source.indexOf('\n', cursor); cursor = next < 0 ? source.length : next + 1; continue; }
      if (source.startsWith('/*', cursor)) { const next = source.indexOf('*/', cursor + 2); if (next < 0) throw problem('SCHEMA_INVALID', 'Unclosed KeyValues comment.'); cursor = next + 2; continue; }
      break;
    }
    if (cursor >= source.length) return null;
    const first = source[cursor++];
    if (first === '{' || first === '}') return first;
    if (first === '"') {
      let result = '';
      while (cursor < source.length) {
        const value = source[cursor++];
        if (value === '"') return result;
        if (value === '\\' && cursor < source.length) result += source[cursor++]; else result += value;
      }
      throw problem('SCHEMA_INVALID', 'Unclosed KeyValues string.');
    }
    const start = cursor - 1;
    while (cursor < source.length && !/[\s{}]/.test(source[cursor])) cursor++;
    return source.slice(start, cursor);
  };
  const object = (closing, depth) => {
    if (depth > 128) throw problem('SCHEMA_INVALID', 'KeyValues nesting limit exceeded.');
    const result = Object.create(null);
    while (true) {
      const key = token();
      if (key === '}') { if (!closing) throw problem('SCHEMA_INVALID', 'Unexpected KeyValues brace.'); return result; }
      if (key == null) { if (closing) throw problem('SCHEMA_INVALID', 'Missing KeyValues brace.'); return result; }
      const value = token();
      if (value == null || value === '}') throw problem('SCHEMA_INVALID', 'Missing KeyValues value.');
      const parsed = value === '{' ? object(true, depth + 1) : value;
      if (Object.hasOwn(result, key)) result[key] = Array.isArray(result[key]) ? [...result[key], parsed] : [result[key], parsed];
      else result[key] = parsed;
    }
  };
  return object(false, 0);
}

function readItemSchema(index) {
  if (!index || typeof index !== 'object') throw problem('SCHEMA_INVALID', 'Missing VPK index.');
  if (!schemaCache.has(index)) {
    const parsed = parseKeyValues(readResource(index, 'scripts/items/items_game.txt').toString('utf8'));
    if (!parsed.items_game || !parsed.items_game.items || typeof parsed.items_game.items !== 'object') throw problem('SCHEMA_INVALID', 'Missing items_game catalogue.');
    schemaCache.set(index, parsed.items_game);
  }
  return schemaCache.get(index);
}

module.exports = { parseKeyValues, readItemSchema, inspectArcanas, buildArcanaPlan, readResourceReferences };

// RERL stores names independently of compressed resource DATA. Follow the
// actual relative string offsets, rather than searching arbitrary binary text.
function readResourceReferences(index, resource) {
  if (/\.(?:vtex|vsnd)_c$/.test(resource) || !index.entries.has(resource)) return [];
  if (!referenceCache.has(index)) referenceCache.set(index, new Map());
  const cache = referenceCache.get(index);
  if (cache.has(resource)) return cache.get(resource);
  const buffer = readResource(index, resource), references = [];
  if (buffer.length >= 16 && buffer.readUInt16LE(4) === 12) {
    const table = 8 + buffer.readUInt32LE(8), count = buffer.readUInt32LE(12);
    if (count > 100 || table + count * 12 > buffer.length) throw problem('RESOURCE_DEPENDENCY_INVALID', 'Invalid compiled-resource block table.');
    for (let i = 0; i < count; i++) {
      const at = table + i * 12, start = at + 4 + buffer.readUInt32LE(at + 4), size = buffer.readUInt32LE(at + 8);
      if (start + size > buffer.length) throw problem('RESOURCE_DEPENDENCY_INVALID', 'Invalid compiled-resource block.');
      if (buffer.toString('ascii', at, at + 4) !== 'RERL') continue;
      const block = buffer.subarray(start, start + size);
      if (block.length < 8) throw problem('RESOURCE_DEPENDENCY_INVALID', 'Truncated RERL block.');
      const entries = block.readUInt32LE(0), total = block.readUInt32LE(4);
      if (total > 100000 || entries + total * 16 > block.length) throw problem('RESOURCE_DEPENDENCY_INVALID', 'Invalid RERL table.');
      for (let j = 0; j < total; j++) {
        const offsetAt = entries + j * 16 + 8, offset = Number(block.readBigInt64LE(offsetAt)), nameAt = offsetAt + offset;
        if (!Number.isSafeInteger(offset) || nameAt < entries + total * 16 || nameAt >= block.length) throw problem('RESOURCE_DEPENDENCY_INVALID', 'Invalid RERL name offset.');
        const end = block.indexOf(0, nameAt);
        if (end < nameAt || end - nameAt > 4096) throw problem('RESOURCE_DEPENDENCY_INVALID', 'Invalid RERL name.');
        const name = block.toString('utf8', nameAt, end);
        if (!name || /[\\\x00-\x1f\x7f:]/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..')) throw problem('RESOURCE_DEPENDENCY_INVALID', 'Unsafe RERL resource path.');
        references.push(name.endsWith('_c') ? name : name + '_c');
      }
    }
  }
  const result = [...new Set(references)]; cache.set(resource, result); return result;
}

function omitRecursiveAliases(index, rows) {
  const aliases = new Map(rows.filter(row => row.supported).flatMap(row => Object.entries({ ...row.modelAliases, ...row.effectAliases })));
  const omitted = new Set();
  // Removing an alias restores the stock resource and its dependencies. Repeat
  // until those restored edges also have been checked against remaining aliases.
  for (;;) {
    const graph = new Map(), pending = [...aliases.keys()];
    while (pending.length) {
      const file = pending.pop(); if (graph.has(file)) continue;
      if (graph.size >= 30000) throw problem('RESOURCE_DEPENDENCY_LIMIT', 'Resource dependency graph exceeds the inspection limit.');
      const next = readResourceReferences(index, aliases.get(file) || file); graph.set(file, next);
      for (const dependency of next) if (!graph.has(dependency)) pending.push(dependency);
    }
    const cyclic = [];
    for (const target of aliases.keys()) {
      const stack = [...(graph.get(target) || [])], visited = new Set();
      while (stack.length) {
        const file = stack.pop();
        if (file === target) { cyclic.push(target); break; }
        if (visited.has(file)) continue; visited.add(file);
        for (const dependency of graph.get(file) || []) stack.push(dependency);
      }
    }
    if (!cyclic.length) break;
    for (const target of cyclic) { aliases.delete(target); omitted.add(target); }
  }
  for (const row of rows) {
    row.omittedCyclicTargets = Object.keys({ ...row.modelAliases, ...row.effectAliases }).filter(target => omitted.has(target));
    for (const target of row.omittedCyclicTargets) { delete row.modelAliases[target]; delete row.effectAliases[target]; }
    if (!row.omittedCyclicTargets.length) continue;
    row.modelCount = Object.keys(row.modelAliases).length; row.effectCount = Object.keys(row.effectAliases).length;
    row.supported = row.modelCount > 0; row.readiness = row.supported ? 'partial_visuals' : 'missing_stock_model';
    row.limitations.push(`Замены с циклическими зависимостями пропущены: ${row.omittedCyclicTargets.length}.`);
  }
}

const modifiers = item => Object.entries(item.visuals || {}).filter(([key]) => /^asset_modifier\d*$/.test(key)).flatMap(([, value]) => values(value)).filter(value => value && typeof value === 'object');
const defaultStyle = modifier => (modifier.style == null || modifier.style === '0') && !modifier.criteria;
const modelPath = value => typeof value === 'string' && /^models\/.+\.vmdl(?:_c)?$/.test(value) ? value.endsWith('_c') ? value : value + '_c' : null;

function resolveItems(schema) {
  const prefabCache = new Map();
  const merge = (base, item) => ({ ...base, ...item, visuals: { ...(base.visuals || {}), ...(item.visuals || {}) }, used_by_heroes: { ...(base.used_by_heroes || {}), ...(item.used_by_heroes || {}) } });
  const prefab = (name, visited = new Set()) => {
    if (prefabCache.has(name)) return prefabCache.get(name);
    if (visited.has(name) || visited.size > 64) throw problem('SCHEMA_INVALID', 'Cyclic item prefab.');
    const item = schema.prefabs?.[name] || {}; let result = {};
    for (const parent of String(item.prefab || '').split(/\s+/).filter(Boolean)) result = merge(result, prefab(parent, new Set([...visited, name])));
    result = merge(result, item); prefabCache.set(name, result); return result;
  };
  return Object.entries(schema.items || {}).map(([id, raw]) => {
    let item = {};
    for (const parent of String(raw.prefab || '').split(/\s+/).filter(Boolean)) item = merge(item, prefab(parent));
    return { id, ...merge(item, raw), declaredPrefab: raw.prefab || '' };
  });
}

function inspectArcanas(index, options = {}) {
  const schema = options.schema || readItemSchema(index), items = resolveItems(schema);
  const sourceHeroes = options.heroes || HEROES;
  const heroes = Array.isArray(sourceHeroes) ? sourceHeroes : Object.values(sourceHeroes);
  const heroByKey = new Map(heroes.filter(hero => Number.isInteger(hero?.id) && typeof hero.name === 'string').map(hero => [hero.name, hero]));
  const wearable = item => /(?:^|\s)wearable(?:\s|$)/.test(item.declaredPrefab) || item.item_class === 'dota_item_wearable';
  const arcanaItems = items.filter(item => item.item_rarity === 'arcana' && wearable(item));
  const grouped = new Map(), names = new Map();
  for (const item of items) { const list = names.get(item.name) || []; list.push(item); names.set(item.name, list); }
  for (const item of arcanaItems) for (const [heroKey, enabled] of Object.entries(item.used_by_heroes || {})) {
    if (enabled !== '1' || !heroByKey.has(heroKey)) continue;
    const list = grouped.get(heroKey) || []; list.push(item); grouped.set(heroKey, list);
  }
  const exists = resource => typeof resource === 'string' && index.entries.has(resource);
  const rows = [];
  for (const [heroKey, candidates] of grouped) {
    const hero = heroByKey.get(heroKey), heroName = hero.localizedName || hero.localized_name || heroKey.replace('npc_dota_hero_', '');
    const limitations = [], short = heroKey.replace(/^npc_dota_hero_/, '');
    let npc = {};
    const npcPath = `scripts/npc/heroes/${heroKey}.txt`;
    if (exists(npcPath)) {
      const parsed = parseKeyValues(readResource(index, npcPath).toString('utf8'));
      npc = parsed[heroKey] || parsed.DOTAHeroes?.[heroKey] || {};
    }
    const defaultHeroModels = values(npc.Model).filter(value => typeof value === 'string');
    const heroAliases = new Set([short, short.replace(/_/g, ''), ...defaultHeroModels.map(value => value.split('/').slice(-2, -1)[0])]);
    if (short === 'legion_commander') heroAliases.add('legion');
    if (short === 'skeleton_king') { heroAliases.add('skeletonking'); heroAliases.add('wraith_king'); }
    if (short === 'nevermore') heroAliases.add('shadow_fiend');
    if (short === 'queenofpain') heroAliases.add('queen_of_pain');
    const owned = value => typeof value === 'string' && [...heroAliases].some(alias => new RegExp(`(?:^|[/_.])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[/_.]|$)`, 'i').test(value));
    const score = item => modifiers(item).some(mod => mod.type === 'entity_model' && mod.asset === heroKey) ? 100 : item.item_slot === 'hero_base' ? 80 : item.model_player ? 50 : 0;
    const main = [...candidates].sort((a, b) => score(b) - score(a) || Number(a.id) - Number(b.id))[0];
    const bundles = items.filter(item => item.bundle && Object.hasOwn(item.bundle, main.name) && !item.is_arcana_repackage);
    const bundle = bundles.sort((a, b) => Object.keys(a.bundle).length - Object.keys(b.bundle).length || Number(b.id) - Number(a.id))[0];
    const pieces = [main], mainEntity = modifiers(main).find(mod => defaultStyle(mod) && mod.type === 'entity_model' && mod.asset === heroKey)?.modifier;
    const anchor = mainEntity || main.model_player;
    const arcanaDirectory = typeof anchor === 'string' ? anchor.split('/').slice(0, -1).join('/') + '/' : null;
    const familyName = main.name.split(' - ')[0];
    for (const name of Object.keys(bundle?.bundle || {})) {
      const piece = (names.get(name) || []).filter(item => item.used_by_heroes?.[heroKey] === '1' && wearable(item)).sort((a, b) => Number(b.id) - Number(a.id))[0];
      if (!piece || pieces.some(item => item.id === piece.id)) continue;
      // Repackaged bundles can contain a second, unrelated cosmetic set.
      if (piece.model_player && piece.name !== familyName && !piece.name.startsWith(familyName + ' - ') && !(arcanaDirectory && piece.model_player.startsWith(arcanaDirectory))) continue;
      pieces.push(piece);
    }
    for (const candidate of candidates) if (!pieces.some(item => item.id === candidate.id)) pieces.push(candidate);
    const defaults = items.filter(item => item.used_by_heroes?.[heroKey] === '1' && /(?:^|\s)default_item(?:\s|$)/.test(item.declaredPrefab) && !item.persona && !item.persona_id);
    const allMods = pieces.flatMap(modifiers), activeMods = allMods.filter(defaultStyle), modelMods = activeMods.filter(mod => mod.type === 'model' && typeof mod.asset === 'string' && typeof mod.modifier === 'string');
    const resolveModel = start => {
      let model = start; const seen = new Set();
      while (model && !seen.has(model)) { seen.add(model); const next = modelMods.find(mod => mod.asset === model)?.modifier; if (!next) break; model = next; }
      return model;
    };
    const modelAliases = {}, effectAliases = {}, ambiguous = new Set(), missing = new Set();
    const add = (destination, target, source, replace = false) => {
      if (!target || !source || target === source) return;
      if (!exists(target) || !exists(source)) { missing.add(target || source); return; }
      if (Object.hasOwn(destination, target) && destination[target] !== source && !replace) { ambiguous.add(target); return; }
      destination[target] = source;
    };
    const addModel = (target, source) => {
      if (!owned(target)) return;
      add(modelAliases, modelPath(target), modelPath(resolveModel(source)));
    };
    const body = activeMods.find(mod => mod.type === 'entity_model' && mod.asset === heroKey && typeof mod.modifier === 'string');
    if (body) for (const target of defaultHeroModels) addModel(target, body.modifier);
    for (const item of pieces) if (item.model_player) {
      const targets = defaults.filter(stock => (stock.item_slot || 'weapon') === (item.item_slot || 'weapon') && stock.model_player);
      for (const target of targets) addModel(target.model_player, item.model_player);
    }
    for (const mod of modelMods) if (owned(mod.asset) && defaults.some(item => item.model_player === mod.asset)) {
      const existing = modelAliases[modelPath(mod.asset)];
      if (existing && mod.modifier.startsWith('models/heroes/') && owned(mod.modifier)) addModel(mod.modifier, existing.replace(/_c$/, ''));
      else if (!existing) addModel(mod.asset, mod.modifier);
    }
    let skippedGlobalEffects = 0, unsupportedTriggers = 0;
    for (const mod of allMods) {
      if (!defaultStyle(mod)) { unsupportedTriggers++; continue; }
      if (mod.type === 'particle') {
        if (!owned(mod.asset) || typeof mod.modifier !== 'string') { skippedGlobalEffects++; continue; }
        // A null emitter only suppresses an effect and cannot supply the
        // Arcana-only emitter which normally replaces it through item logic.
        if (/(?:error\/null|arcana_null)\.vpcf$/.test(mod.modifier)) { unsupportedTriggers++; continue; }
        if (!/^particles\/.+\.vpcf$/.test(mod.asset) || !/^particles\/.+\.vpcf$/.test(mod.modifier)) continue;
        add(effectAliases, mod.asset + '_c', mod.modifier + '_c');
      } else if (mod.type === 'ability_icon') {
        if (!owned(mod.asset) || typeof mod.modifier !== 'string') { skippedGlobalEffects++; continue; }
        add(effectAliases, `panorama/images/spellicons/${mod.asset}_png.vtex_c`, `panorama/images/spellicons/${mod.modifier}_png.vtex_c`);
      } else if (!['model', 'entity_model'].includes(mod.type)) unsupportedTriggers++;
    }
    for (const target of ambiguous) { delete modelAliases[target]; delete effectAliases[target]; }
    if (ambiguous.size) limitations.push(`Неоднозначные замены пропущены: ${ambiguous.size}.`);
    if (missing.size) limitations.push(`Часть путей отсутствует в установленной версии: ${missing.size}.`);
    if (allMods.some(mod => defaultStyle(mod) && mod.type === 'model_skin' && String(mod.skin) !== String(npc.ModelSkin || '0'))) limitations.push('Изменение цвета и групп материалов через состояние Arcana не применяется; доступные модели могут иметь стандартную расцветку.');
    if (unsupportedTriggers) limitations.push('Эффекты, требующие активации предмета — прикреплённые частицы, специальные анимации, звук, HUD и прогресс — отдельно не включаются.');
    if (skippedGlobalEffects) limitations.push('Общие эффекты предметов и эффекты других героев пропущены.');
    const modelCount = Object.keys(modelAliases).length, effectCount = Object.keys(effectAliases).length;
    if (hero.id === 114 && !body && modelCount === 1) limitations.unshift('Доступна модель короны. Цвет тела и переключение форм Arcana не применяются.');
    if (!modelCount) limitations.push('У стандартного предмета нет модели для замены: появление модели Arcana требует отдельной проверки и пока недоступно.');
    limitations.push('Используются стандартные слоты героя; надетая другая косметика может потребовать переключения на стандартные предметы.');
    rows.push({ id: hero.id === 6 ? 'drow_dread_retribution' : `arcana_${hero.id}`, heroId: hero.id, heroKey, heroName, name: main.name, itemId: main.id, itemIds: pieces.map(item => item.id), supported: modelCount > 0, modelAliases, effectAliases, modelCount, effectCount, fullEffectsSupported: false, readiness: modelCount ? 'partial_visuals' : 'missing_stock_model', limitations, skippedGlobalEffects, unsupportedTriggers, omittedAmbiguousTargets: [...ambiguous] });
  }
  omitRecursiveAliases(index, rows);
  return rows.sort((a, b) => a.heroName.localeCompare(b.heroName, 'en'));
}

function buildArcanaPlan(rows, ids, effects = false) {
  if (!Array.isArray(rows) || !Array.isArray(ids) || ids.length > 127) throw problem('INVALID_ARCANA', 'Некорректный выбор обликов.');
  const plan = new Map();
  for (const id of new Set(ids)) {
    const row = rows.find(value => value.id === id);
    if (!row) throw problem('INVALID_ARCANA', 'Неизвестный облик.');
    if (!row.supported) throw problem('UNSUPPORTED_ARCANA', `Локальная модель ${row.heroName} пока не поддерживается.`);
    for (const [target, resource] of Object.entries({ ...row.modelAliases, ...(effects === true ? row.effectAliases : {}) })) {
      if (plan.has(target) && plan.get(target).resource !== resource) throw problem('ARCANA_CONFLICT', 'Выбранные облики конфликтуют по файлам.');
      plan.set(target, { resource });
    }
  }
  return plan;
}
