'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openVpk, readResource } = require('./valve-vpk.cjs');

const MAP_LIMIT = 128 * 1024 * 1024;
const DEFAULT_MAP = 'dota';
const WATER_TEXTURES = new Set(['maps/dota/water_flow_map.vtex_c', 'maps/dota/fog_opacity_map.vtex_c', 'maps/dota/fog_flow_map.vtex_c']);
const VISUAL_EXTENSIONS = new Set(['vwnod_c', 'vmdl_c', 'vmesh_c', 'vmat_c', 'vtex_c', 'vgrass', 'vrman_c']);
const WALKABLE_RENDER = /^maps\/dota\/worldnodes\/[a-zA-Z0-9_./-]+_dota_nav_walkable\.(?:vmdl|vmesh)_c$/;
const LIMITATIONS = Object.freeze([
  'Меняется оформление основной карты. Демо героя и другие режимы не изменяются.',
  'Погода, звуковые события и стили погоды не включены в локальную замену.',
  'Физика, навигация, видимость и сущности сохранены из текущей обычной карты; визуальную совместимость нужно проверить в локальном матче.',
]);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

function noLinks(filename) {
  let current = path.resolve(filename);
  for (;;) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail('UNSAFE_PATH', 'Ссылки в путях ландшафта не поддерживаются.');
    const parent = path.dirname(current); if (parent === current) return; current = parent;
  }
}
function gamePath(gameDir) {
  if (typeof gameDir !== 'string' || !path.isAbsolute(gameDir)) fail('INSTALL_INVALID', 'Не задана папка игры для ландшафта.');
  const result = path.resolve(gameDir); noLinks(result); return result;
}
function mapPath(gameDir, name) {
  if (name !== DEFAULT_MAP && !/^dota_[a-z][a-z0-9_]*$/.test(name)) fail('INVALID_TERRAIN', 'Некорректное имя ландшафта.');
  const result = path.join(gameDir, 'dota', 'maps', name + '.vpk'); noLinks(result); return result;
}
function fingerprint(filename) {
  noLinks(filename); const before = fs.statSync(filename);
  if (!before.isFile() || before.size > MAP_LIMIT) fail('TERRAIN_SOURCE_INVALID', 'Некорректный исходный файл ландшафта.');
  const bytes = fs.readFileSync(filename), after = fs.statSync(filename);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size) fail('SOURCE_CHANGED', 'Карта изменилась во время подготовки.');
  return { path: filename, size: after.size, mtimeMs: after.mtimeMs, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}
function schemaFor(index, schema) {
  if (schema) return schema;
  return require('./local-arcana-catalog.cjs').readItemSchema(index);
}
function terrainPrefab(name, prefabs, visited = new Set()) {
  if (name === 'terrain') return true;
  if (visited.has(name) || visited.size > 32) return false;
  visited.add(name);
  return String(prefabs?.[name]?.prefab || '').split(/\s+/).filter(Boolean).some(parent => terrainPrefab(parent, prefabs, visited));
}
function modifiersOf(item) {
  return Object.values(item?.visuals || {}).flat().filter(value => value && typeof value === 'object' && typeof value.type === 'string');
}
function compiledResource(value) {
  if (typeof value !== 'string' || value.length > 512 || !/^(?:materials|particles)\/[a-zA-Z0-9_./-]+\.(?:vmat|vpcf)(?:_c)?$/.test(value) || value.split('/').some(part => part === '..' || part === '.' || !part)) return null;
  if (/\/heroes?\/|\/hero_[^/]+\//i.test(value)) return null;
  return value.endsWith('_c') ? value : value + '_c';
}
function assetAliases(modifiers, index) {
  const result = {}, conflicts = new Set();
  for (const modifier of modifiers) {
    if (!['npc_material_override', 'color_correction_material_override', 'particle', 'particle_clientside'].includes(modifier.type) || modifier.style != null && String(modifier.style) !== '0') continue;
    const target = compiledResource(modifier.asset), source = compiledResource(modifier.modifier);
    if (!target || !source || target === source || !index?.entries?.has(target) || !index.entries.has(source) || target.slice(target.lastIndexOf('.')) !== source.slice(source.lastIndexOf('.'))) continue;
    if (result[target] && result[target] !== source) { conflicts.add(target); continue; }
    result[target] = source;
  }
  for (const target of conflicts) delete result[target];
  return result;
}
function mapAvailable(filename, mapName) {
  if (!fs.existsSync(filename)) return false;
  try {
    const stat = fs.statSync(filename); if (!stat.isFile() || stat.size > MAP_LIMIT) return false;
    const index = openVpk(filename);
    return index.entries.has(`maps/${mapName}.vmap_c`) && index.entries.has('maps/dota/worldnodes/n0.vwnod_c');
  } catch (failure) { if (failure.code === 'UNSAFE_PATH') throw failure; return false; }
}

function inspectTerrains({ gameDir, index, schema } = {}) {
  gameDir = gamePath(gameDir); schema = schemaFor(index, schema);
  if (!schema || typeof schema.items !== 'object' || !schema.items) fail('TERRAIN_SCHEMA_INVALID', 'Не найден каталог ландшафтов текущей игры.');
  const defaultPath = mapPath(gameDir, DEFAULT_MAP), defaultAvailable = mapAvailable(defaultPath, DEFAULT_MAP);
  const rows = [{ id: 'default', name: 'Default Terrain', itemId: '590', mapName: DEFAULT_MAP, mapPath: defaultPath, available: defaultAvailable, limitations: [], assetAliases: {} }];
  for (const [itemId, item] of Object.entries(schema.items)) {
    if (!/^\d+$/.test(itemId) || !item || !String(item.prefab || '').split(/\s+/).some(name => terrainPrefab(name, schema.prefabs))) continue;
    const modifiers = modifiersOf(item), maps = modifiers.filter(value => value.type === 'map_override' && value.asset === 'maps/dota.vmap' && (value.style == null || String(value.style) === '0'));
    const names = [...new Set(maps.map(value => /^maps\/(dota_[a-z][a-z0-9_]*)\.vmap$/.exec(value.modifier || '')?.[1]).filter(Boolean))];
    if (names.length !== 1) continue; // No old numbered maps, demo maps or ambiguous style selection.
    const mapName = names[0], filename = mapPath(gameDir, mapName), available = defaultAvailable && mapAvailable(filename, mapName);
    rows.push({ id: `terrain_${itemId}`, name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : mapName, itemId, mapName, mapPath: filename, available, limitations: available ? [...LIMITATIONS] : ['Файлы текущего ландшафта или обычной карты отсутствуют либо повреждены.', ...LIMITATIONS], assetAliases: assetAliases(modifiers, index) });
  }
  return rows;
}

function renderOnlyWalkable(bytes) {
  // "dota_nav_walkable" is also the material name of compiled floor render
  // meshes. It is not sufficient to classify a resource as navigation data.
  // Admit only the current mesh-only compiled layout, with no physics block or
  // external physics reference. MDAT is a CRenderMesh (VRF Model.GetEmbeddedMeshes).
  if (!Buffer.isBuffer(bytes) || bytes.length < 16 || bytes.length > 8 * 1024 * 1024 || bytes.readUInt16LE(4) !== 12 || bytes.readUInt32LE(0) !== bytes.length) return false;
  const count = bytes.readUInt32LE(12), table = 8 + bytes.readUInt32LE(8), blocks = new Map();
  if (!count || count > 32 || table < 16 || table + count * 12 > bytes.length) return false;
  const allowed = new Set(['MVTX', 'MIDX', 'MDAT', 'CTRL', 'RERL', 'RED2', 'DATA', 'VBIB']), ranges = [];
  for (let row = table; row < table + count * 12; row += 12) {
    const type = bytes.toString('ascii', row, row + 4), offset = row + 4 + bytes.readUInt32LE(row + 4), size = bytes.readUInt32LE(row + 8);
    if (!allowed.has(type) || blocks.has(type) || offset < table + count * 12 || offset + size > bytes.length || ranges.some(range => size && offset < range.end && offset + size > range.start)) return false;
    blocks.set(type, bytes.subarray(offset, offset + size)); ranges.push({ start: offset, end: offset + size });
  }
  if (!blocks.has('DATA') || !blocks.has('RERL') || !(blocks.has('MVTX') && blocks.has('MIDX') || blocks.has('VBIB'))) return false;
  const mesh = blocks.get('MDAT') || blocks.get('DATA');
  if (!mesh?.includes(Buffer.from('CRenderMesh'))) return false;
  for (const type of ['MDAT', 'CTRL', 'DATA']) {
    const block = blocks.get(type);
    if (block && /embedded_physics|phys_data_block|m_refPhysicsData|CPhysAggregateData|m_rnShape|\.vphys(?:_c)?\b/i.test(block.toString('latin1'))) return false;
  }
  const references = blocks.get('RERL'); if (references.length < 8) return false;
  const referenceOffset = references.readUInt32LE(0), referenceCount = references.readUInt32LE(4);
  if (!referenceCount || referenceCount > 64 || referenceOffset < 8 || referenceOffset + referenceCount * 16 > references.length) return false;
  for (let index = 0; index < referenceCount; index++) {
    const row = referenceOffset + index * 16, relative = references.readBigInt64LE(row + 8);
    if (relative < 0n || relative > BigInt(references.length)) return false;
    const start = row + 8 + Number(relative), end = references.indexOf(0, start);
    if (start < referenceOffset + referenceCount * 16 || end < start || end - start > 512) return false;
    const name = references.toString('utf8', start, end);
    if (!/^materials\/[a-zA-Z0-9_./-]+\.vmat$/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..')) return false;
  }
  return true;
}

// The default map remains the authority for gameplay-bearing data. A variant may
// replace its render worldnode and visual assets, never the map root/world root,
// entities, visibility, physics or navigation resources. Default entries that
// the variant does not replace remain present as dependencies/fallbacks.
function isTerrainVisualPath(resource, bytes) {
  if (WATER_TEXTURES.has(resource)) return true;
  if (typeof resource === 'string' && WALKABLE_RENDER.test(resource)) return renderOnlyWalkable(bytes);
  if (typeof resource !== 'string' || !resource.startsWith('maps/dota/worldnodes/') || /(?:nav|phys|collis|visib)/i.test(resource)) return false;
  return VISUAL_EXTENSIONS.has(resource.slice(resource.lastIndexOf('.') + 1));
}
function withMetadata(plan, metadata) {
  for (const [name, value] of Object.entries(metadata)) Object.defineProperty(plan, name, { value, enumerable: false });
  return plan;
}
function terrainPlan({ gameDir, index, terrain, schema } = {}) {
  gameDir = gamePath(gameDir);
  const id = typeof terrain === 'string' ? terrain : terrain?.id;
  if (id === 'default') return withMetadata(new Map(), { terrainId: 'default', sourceFingerprints: null, protectedPaths: [], assetAliases: new Map(), limitations: [] });
  if (!/^terrain_\d+$/.test(id || '')) fail('INVALID_TERRAIN', 'Неизвестный ландшафт.');
  // Rebuild trusted paths/aliases from the current schema. Caller-provided paths
  // and cached availability are never used to read arbitrary files.
  const current = inspectTerrains({ gameDir, index, schema }).find(row => row.id === id);
  if (!current) fail('INVALID_TERRAIN', 'Ландшафт отсутствует в каталоге текущей игры.');
  if (!current.available) fail('TERRAIN_UNAVAILABLE', 'Файлы выбранного ландшафта недоступны.');
  const defaultPath = mapPath(gameDir, DEFAULT_MAP), beforeDefault = fingerprint(defaultPath), beforeTerrain = fingerprint(current.mapPath);
  const base = openVpk(defaultPath), variant = openVpk(current.mapPath), plan = new Map(), renderOverrides = new Set();
  for (const resource of base.entries.keys()) plan.set(resource, { index: base, resource });
  for (const resource of variant.entries.keys()) {
    const walkable = WALKABLE_RENDER.test(resource), bytes = walkable ? readResource(variant, resource) : undefined;
    if (walkable && !isTerrainVisualPath(resource, bytes)) fail('TERRAIN_VISUAL_UNVERIFIED', 'Формат одного из визуальных мешей ландшафта не подтверждён. Замена не подготовлена.');
    if (isTerrainVisualPath(resource, bytes)) { plan.set(resource, { index: variant, resource }); renderOverrides.add(resource); }
  }
  const protectedPaths = [...base.entries.keys()].filter(resource => !isTerrainVisualPath(resource) && !renderOverrides.has(resource)).sort();
  const afterDefault = fingerprint(defaultPath), afterTerrain = fingerprint(current.mapPath);
  if (beforeDefault.sha256 !== afterDefault.sha256 || beforeTerrain.sha256 !== afterTerrain.sha256) fail('SOURCE_CHANGED', 'Карты обновились во время подготовки. Повтори проверку.');
  return withMetadata(plan, {
    terrainId: id, sourceFingerprints: { default: afterDefault, terrain: afterTerrain }, protectedPaths,
    assetAliases: new Map(Object.entries(current.assetAliases).map(([target, resource]) => [target, { index, resource }])),
    limitations: [...current.limitations],
  });
}

module.exports = { inspectTerrains, terrainPlan, isTerrainVisualPath };
