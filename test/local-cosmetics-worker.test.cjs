'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { openVpk, readResource, createVpk } = require('../src/valve-vpk.cjs');
const { inspectCatalog, buildCosmetics, normalizeSelection } = require('../src/local-cosmetics-worker.cjs');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const selection = patch => ({ arcanaMode: 'none', arcanaIds: [], effectsEnabled: false, terrainId: 'default', ...patch });
const code = expected => failure => failure.code === expected;
function keyValues(object) {
  return Object.entries(object).map(([key, value]) => JSON.stringify(key) + (value && typeof value === 'object' ? '\n{\n' + keyValues(value) + '\n}' : ' ' + JSON.stringify(String(value)))).join('\n');
}
function fixture(t) {
  const parent = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'core-coach-cosmetics-worker-')), gameDir = path.join(root, 'game'), runtimeDir = path.join(root, 'runtime'), maps = path.join(gameDir, 'dota', 'maps');
  fs.mkdirSync(maps, { recursive: true });
  t.after(() => { const target = path.resolve(root); assert.ok(target.startsWith(parent + path.sep) && path.basename(target).startsWith('core-coach-cosmetics-worker-')); fs.rmSync(target, { recursive: true, force: true }); });
  const resources = new Map(), items = {}, schema = { prefabs: { wearable: { item_class: 'dota_item_wearable' }, default_item: { prefab: 'wearable' }, terrain: { item_class: 'dota_item_wearable', item_slot: 'terrain' } }, items };
  const aliases = [];
  for (const [hero, number, arcanaId] of [['drow_ranger', 6, 'drow_dread_retribution'], ['lina', 25, 'arcana_25']]) {
    const folder = hero === 'drow_ranger' ? 'drow' : hero, key = 'npc_dota_hero_' + hero;
    const stockBody = `models/heroes/${folder}/${folder}_base.vmdl`, stockWeapon = `models/heroes/${folder}/${folder}_weapon.vmdl`;
    const newBody = `models/items/${folder}/arcana/${folder}_arcana.vmdl`, newWeapon = `models/items/${folder}/arcana/${folder}_arcana_weapon.vmdl`;
    const stockParticle = `particles/units/heroes/hero_${folder}/${folder}_spell.vpcf`, newParticle = `particles/econ/items/${folder}/arcana/${folder}_spell.vpcf`;
    resources.set(`scripts/npc/heroes/${key}.txt`, Buffer.from(keyValues({ [key]: { Model: stockBody } })));
    for (const resource of [stockBody, stockWeapon, newBody, newWeapon, stockParticle, newParticle]) resources.set(resource + '_c', Buffer.from('binary:' + resource));
    items[String(number * 10)] = { name: folder + ' default weapon', prefab: 'default_item', item_slot: 'weapon', used_by_heroes: { [key]: '1' }, model_player: stockWeapon };
    items[String(number * 10 + 1)] = { name: folder + ' Arcana', prefab: 'wearable', item_rarity: 'arcana', item_slot: 'weapon', used_by_heroes: { [key]: '1' }, model_player: newWeapon, visuals: {
      asset_modifier0: { type: 'entity_model', asset: key, modifier: newBody },
      asset_modifier1: { type: 'particle', asset: stockParticle, modifier: newParticle },
    } };
    aliases.push({ id: arcanaId, stockBody: stockBody + '_c', stockWeapon: stockWeapon + '_c', newBody: newBody + '_c', newWeapon: newWeapon + '_c', stockParticle: stockParticle + '_c', newParticle: newParticle + '_c' });
  }
  items['220'] = { name: 'Unavailable Zeus Arcana', prefab: 'wearable', item_rarity: 'arcana', item_slot: 'weapon', used_by_heroes: { npc_dota_hero_zuus: '1' }, model_player: 'models/items/zeus/missing.vmdl' };
  items['590'] = { name: 'Default Terrain', prefab: 'terrain' };
  items['11171'] = { name: 'Seasonal Terrain - Spring', prefab: 'terrain', visuals: {
    asset_modifier0: { type: 'map_override', asset: 'maps/dota.vmap', modifier: 'maps/dota_spring.vmap' },
    asset_modifier1: { type: 'npc_material_override', asset: 'materials/models/creeps/roshan/base.vmat', modifier: 'materials/models/creeps/roshan/spring.vmat' },
  } };
  resources.set('materials/models/creeps/roshan/base.vmat_c', Buffer.from('stock roshan'));
  resources.set('materials/models/creeps/roshan/spring.vmat_c', Buffer.from('spring roshan'));
  resources.set('scripts/items/items_game.txt', Buffer.from(keyValues({ items_game: schema })));
  const sourcePath = path.join(gameDir, 'dota', 'pak01_dir.vpk'); fs.writeFileSync(sourcePath, createVpk(resources));
  const base = new Map([
    ['maps/dota.vmap_c', Buffer.from('stock map root')], ['maps/dota/world.vwrld_c', Buffer.from('stock world root')],
    ['maps/dota/worldnodes/n0.vwnod_c', Buffer.from('stock render graph')], ['maps/dota/worldnodes/ground.vmdl_c', Buffer.from('stock ground')],
    ['maps/dota/worldnodes/dota_nav_walkable.vmdl_c', Buffer.from('stock walkable mesh')], ['maps/dota/world_physics.vmdl_c', Buffer.from('stock physics')],
    ['maps/dota/world_visibility.vvis_c', Buffer.from('stock visibility')], ['maps/dota/entities/default_ents.vents_c', Buffer.from('stock entity positions')],
    ['maps/dota.gnv', Buffer.from('stock nav')], ['maps/dota.trm', Buffer.from('stock trees')], ['maps/dota.vhcg', Buffer.from('stock height grid')],
  ]);
  const variant = new Map([...base].map(([name, bytes]) => [name, Buffer.concat([Buffer.from('spring:'), bytes])]));
  variant.delete('maps/dota.vmap_c'); variant.set('maps/dota_spring.vmap_c', Buffer.from('spring root'));
  const defaultMapPath = path.join(maps, 'dota.vpk'), springMapPath = path.join(maps, 'dota_spring.vpk');
  fs.writeFileSync(defaultMapPath, createVpk(base)); fs.writeFileSync(springMapPath, createVpk(variant));
  const initialFiles = [sourcePath, defaultMapPath, springMapPath], initialHashes = new Map(initialFiles.map(filename => [filename, digest(fs.readFileSync(filename))]));
  const assertUntouched = () => { for (const [filename, hash] of initialHashes) assert.equal(digest(fs.readFileSync(filename)), hash, filename); assert.deepEqual(fs.readdirSync(gameDir), ['dota']); };
  return { root, gameDir, runtimeDir, sourcePath, resources, aliases, base, variant, initialHashes, assertUntouched, defaultMapPath, springMapPath, catalogPath: path.join(runtimeDir, 'local-skins', 'catalog.json') };
}
function builtFile(result, kind) {
  const value = result.files.find(file => file.kind === kind); assert.ok(value, kind);
  const bytes = fs.readFileSync(value.stagedPath); assert.equal(value.bytes, bytes.length); assert.equal(value.sha256, digest(bytes));
  const index = openVpk(value.stagedPath); assert.equal(value.fileCount, index.entries.size); return index;
}
function workerCall(data) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.resolve(__dirname, '../src/local-cosmetics-worker.cjs'), { workerData: data }); let settled = false;
    worker.once('message', result => { settled = true; resolve(result); }); worker.once('error', reject);
    worker.once('exit', value => { if (!settled) reject(new Error('Worker exited before response: ' + value)); });
  });
}

test('catalog inspection identifies supported and unavailable Arcanas plus current terrains while exposing only public metadata', t => {
  const files = fixture(t), result = inspectCatalog(files);
  assert.match(result.catalog.sourceHash, /^[a-f0-9]{64}$/); assert.equal(result.catalog.sourceHash, digest(fs.readFileSync(files.sourcePath)));
  assert.deepEqual(result.catalog.arcanas.filter(row => row.supported).map(row => row.id).sort(), ['arcana_25', 'drow_dread_retribution']);
  assert.equal(result.catalog.arcanas.find(row => row.id === 'arcana_22').supported, false);
  assert.deepEqual(result.catalog.terrains.map(row => row.id), ['default', 'terrain_11171']);
  assert.equal(result.sourceFingerprints[0].relativePath, 'dota/pak01_dir.vpk');
  assert.equal(result.privateCatalogPath, files.catalogPath); assert.ok(fs.existsSync(files.catalogPath));
  const publicText = JSON.stringify(result.catalog); for (const forbidden of ['modelAliases', 'effectAliases', 'mapPath', 'heroKey', files.gameDir]) assert.equal(publicText.includes(forbidden), false, forbidden);
  files.assertUntouched();
});

test('selection normalization supports all, individual, disabled effects and duplicate elimination without unavailable IDs', () => {
  const catalog = { arcanas: [{ id: 'one', supported: true }, { id: 'two', supported: true }, { id: 'missing', supported: false }], terrains: [{ id: 'default', available: true }, { id: 'broken', available: false }] };
  assert.deepEqual(normalizeSelection(selection({ arcanaMode: 'all_available', effectsEnabled: true }), catalog), selection({ arcanaMode: 'all_available', arcanaIds: ['one', 'two'], effectsEnabled: true }));
  assert.deepEqual(normalizeSelection(selection({ arcanaMode: 'selected', arcanaIds: ['two', 'one', 'two'] }), catalog).arcanaIds, ['one', 'two']);
  assert.deepEqual(normalizeSelection(selection({ effectsEnabled: true, arcanaIds: ['one'] }), catalog), selection());
  assert.deepEqual(normalizeSelection(selection({ arcanaMode: 'selected', effectsEnabled: true }), catalog), selection());
  for (const input of [null, [], selection({ extra: true }), selection({ effectsEnabled: 'true' }), selection({ arcanaIds: new Array(201).fill('one') }), selection({ arcanaIds: [1] })]) assert.throws(() => normalizeSelection(input, catalog), code('INVALID_SELECTION'));
  assert.throws(() => normalizeSelection(selection({ arcanaMode: 'selected', arcanaIds: ['missing'] }), catalog), code('UNSUPPORTED_ARCANA'));
  assert.throws(() => normalizeSelection(selection({ terrainId: 'broken' }), catalog), code('UNSUPPORTED_TERRAIN'));
});

test('all-available build emits exact per-hero model and eligible effect aliases only in runtime staging', t => {
  const files = fixture(t); inspectCatalog(files);
  const result = buildCosmetics({ ...files, selection: selection({ arcanaMode: 'all_available', effectsEnabled: true }) });
  assert.equal(result.files.length, 1); assert.equal(result.counts.heroes, 2); assert.equal(result.counts.models, 4); assert.equal(result.counts.effects, 2); assert.equal(result.counts.terrainResources, 0);
  const output = builtFile(result, 'assets'); assert.equal(output.entries.size, 6);
  for (const row of files.aliases) for (const [target, original] of [[row.stockBody, row.newBody], [row.stockWeapon, row.newWeapon], [row.stockParticle, row.newParticle]]) assert.deepEqual(readResource(output, target), files.resources.get(original));
  assert.equal(output.entries.has('scripts/items/items_game.txt'), false); assert.ok(result.files[0].stagedPath.startsWith(path.join(files.runtimeDir, 'local-skins', 'staging') + path.sep));
  assert.equal(result.sourceFingerprints.length, 1); files.assertUntouched();
});

test('individual selection and effect switch do not alter unselected hero assets', t => {
  const files = fixture(t); inspectCatalog(files);
  const result = buildCosmetics({ ...files, selection: selection({ arcanaMode: 'selected', arcanaIds: ['arcana_25'], effectsEnabled: false }) }), output = builtFile(result, 'assets');
  assert.equal(result.counts.heroes, 1); assert.equal(result.counts.models, 2); assert.equal(result.counts.effects, 0); assert.equal(output.entries.size, 2);
  assert.ok([...output.entries.keys()].every(key => key.startsWith('models/heroes/lina/'))); files.assertUntouched();
  const empty = buildCosmetics({ ...files, selection: selection() }); assert.deepEqual(empty.files, []); assert.equal(empty.counts.heroes, 0);
});

test('terrain build is a separate map archive and preserves the current default mechanics byte for byte', t => {
  const files = fixture(t); inspectCatalog(files);
  const result = buildCosmetics({ ...files, selection: selection({ terrainId: 'terrain_11171' }) }), terrain = builtFile(result, 'terrain'), assets = builtFile(result, 'assets');
  assert.equal(result.files.length, 2); assert.equal(result.counts.heroes, 0); assert.equal(result.counts.terrainResources, files.base.size);
  for (const resource of ['maps/dota.vmap_c', 'maps/dota/world.vwrld_c', 'maps/dota/entities/default_ents.vents_c', 'maps/dota/world_physics.vmdl_c', 'maps/dota/world_visibility.vvis_c', 'maps/dota/worldnodes/dota_nav_walkable.vmdl_c', 'maps/dota.gnv', 'maps/dota.trm', 'maps/dota.vhcg']) assert.deepEqual(readResource(terrain, resource), files.base.get(resource), resource);
  assert.deepEqual(readResource(terrain, 'maps/dota/worldnodes/n0.vwnod_c'), files.variant.get('maps/dota/worldnodes/n0.vwnod_c'));
  assert.equal(terrain.entries.has('maps/dota_spring.vmap_c'), false); assert.equal(assets.entries.size, 1); assert.deepEqual(readResource(assets, 'materials/models/creeps/roshan/base.vmat_c'), files.resources.get('materials/models/creeps/roshan/spring.vmat_c'));
  assert.deepEqual(result.sourceFingerprints.map(row => row.relativePath).sort(), ['dota/maps/dota.vpk', 'dota/maps/dota_spring.vpk', 'dota/pak01_dir.vpk']);
  assert.ok(result.limitations.some(text => /Погода/.test(text))); files.assertUntouched();
});

test('source changes invalidate a cached catalog before any package is staged', t => {
  const files = fixture(t); inspectCatalog(files); files.resources.set('new-resource.txt', Buffer.from('game update')); fs.writeFileSync(files.sourcePath, createVpk(files.resources));
  assert.throws(() => buildCosmetics({ ...files, selection: selection({ arcanaMode: 'all_available' }) }), code('SOURCE_CHANGED'));
  assert.equal(fs.existsSync(path.join(files.runtimeDir, 'local-skins', 'staging')), false);
});

test('malformed catalogs and arbitrary catalog/source/runtime paths fail before packaging game files', t => {
  const files = fixture(t); inspectCatalog(files);
  assert.throws(() => buildCosmetics({ ...files, catalogPath: path.join(files.root, 'other.json'), selection: selection() }), code('UNSAFE_PATH'));
  assert.throws(() => inspectCatalog({ ...files, sourcePath: files.defaultMapPath }), code('UNSAFE_PATH'));
  assert.throws(() => inspectCatalog({ ...files, runtimeDir: path.join(files.gameDir, 'private') }), code('UNSAFE_PATH'));
  assert.equal(fs.existsSync(path.join(files.gameDir, 'private')), false);
  fs.writeFileSync(files.catalogPath, JSON.stringify({ schemaVersion: 1, sourceHash: 'not a hash', arcanas: [], terrains: [] }));
  assert.throws(() => buildCosmetics({ ...files, selection: selection() }), code('CATALOG_INVALID'));
  files.assertUntouched();
});

test('Windows path casing cannot hide a runtime directory inside the game installation', { skip: process.platform !== 'win32' }, t => {
  const files = fixture(t), runtimeDir = path.join(files.gameDir.toUpperCase(), 'temporary');
  assert.throws(() => inspectCatalog({ ...files, runtimeDir }), code('UNSAFE_PATH'));
  assert.equal(fs.existsSync(path.join(files.gameDir, 'temporary')), false); files.assertUntouched();
});

test('modified cached aliases cannot add a global item schema to an otherwise valid hero package', t => {
  const files = fixture(t); inspectCatalog(files); const catalog = JSON.parse(fs.readFileSync(files.catalogPath, 'utf8'));
  const row = catalog.arcanas.find(item => item.id === 'arcana_25'); row.modelAliases['scripts/items/items_game.txt'] = row.modelAliases[files.aliases[1].stockBody]; row.modelCount = 999;
  fs.writeFileSync(files.catalogPath, JSON.stringify(catalog));
  const result = buildCosmetics({ ...files, selection: selection({ arcanaMode: 'selected', arcanaIds: ['arcana_25'] }) }), output = builtFile(result, 'assets');
  assert.equal(output.entries.has('scripts/items/items_game.txt'), false); assert.equal(output.entries.size, 2); assert.equal(result.counts.models, 2);
  files.assertUntouched();
});

test('catalog and build actions work through actual worker messages and invalid actions fail explicitly', async t => {
  const files = fixture(t); const catalog = await workerCall({ ...files, resources: undefined, base: undefined, variant: undefined, initialHashes: undefined, assertUntouched: undefined, action: 'catalog' });
  assert.equal(catalog.ok, true); assert.equal(catalog.result.catalog.arcanas.filter(row => row.supported).length, 2);
  const built = await workerCall({ runtimeDir: files.runtimeDir, gameDir: files.gameDir, action: 'build', selection: selection({ arcanaMode: 'selected', arcanaIds: ['drow_dread_retribution'] }) });
  assert.equal(built.ok, true); assert.equal(built.result.files[0].kind, 'assets'); assert.equal(built.result.files[0].fileCount, 2);
  const invalid = await workerCall({ runtimeDir: files.runtimeDir, gameDir: files.gameDir, action: 'unknown' }); assert.equal(invalid.ok, false); assert.equal(invalid.code, 'INVALID_ACTION'); files.assertUntouched();
});
