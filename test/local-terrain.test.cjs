'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createVpk, openVpk, readResource } = require('../src/valve-vpk.cjs');
const { inspectTerrains, terrainPlan, isTerrainVisualPath } = require('../src/local-terrain.cjs');

const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function compiledRender({ material = 'materials/tools/dota_nav_walkable.vmat', mesh = 'CRenderMesh', physicsBlock = false, unknownBlock = false } = {}) {
  const name = Buffer.from(material + '\0'), references = Buffer.alloc(28 + name.length);
  references.writeUInt32LE(12, 0); references.writeUInt32LE(1, 4); references.writeBigInt64LE(8n, 20); name.copy(references, 28);
  const blocks = new Map([['MVTX', Buffer.from('vertices')], ['MIDX', Buffer.from('indices')], ['MDAT', Buffer.from(mesh)], ['CTRL', Buffer.from('embedded_meshes')], ['RERL', references], ['DATA', Buffer.from('model metadata')]]);
  if (physicsBlock) blocks.set('PHYS', Buffer.from('collision'));
  if (unknownBlock) blocks.set('WHAT', Buffer.from('unverified block'));
  const tableSize = blocks.size * 12, total = 16 + tableSize + [...blocks.values()].reduce((sum, bytes) => sum + bytes.length, 0), output = Buffer.alloc(total);
  output.writeUInt32LE(total, 0); output.writeUInt16LE(12, 4); output.writeUInt32LE(8, 8); output.writeUInt32LE(blocks.size, 12);
  let row = 16, offset = 16 + tableSize;
  for (const [type, bytes] of blocks) { output.write(type, row, 4, 'ascii'); output.writeUInt32LE(offset - row - 4, row + 4); output.writeUInt32LE(bytes.length, row + 8); bytes.copy(output, offset); row += 12; offset += bytes.length; }
  return output;
}
function fixture(t) {
  const parent = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'core-coach-terrain-')), gameDir = path.join(root, 'game'), maps = path.join(gameDir, 'dota', 'maps');
  fs.mkdirSync(maps, { recursive: true });
  t.after(() => { const target = path.resolve(root); assert.ok(target.startsWith(parent + path.sep) && path.basename(target).startsWith('core-coach-terrain-')); fs.rmSync(target, { recursive: true, force: true }); });
  const writeMap = (name, resources) => { const filename = path.join(maps, name + '.vpk'); fs.writeFileSync(filename, createVpk(resources)); return filename; };
  const base = new Map([
    ['maps/dota.vmap_c', Buffer.from('default map root')], ['maps/dota/world.vwrld_c', Buffer.from('default world root')],
    ['maps/dota/worldnodes/n0.vwnod_c', Buffer.from('default render graph')], ['maps/dota/worldnodes/ground.vmdl_c', Buffer.from('default ground')],
    ['maps/dota/worldnodes/unused.vmdl_c', Buffer.from('fallback model')], ['maps/dota/worldnodes/navigation.vmdl_c', Buffer.from('default navigation model')],
    ['maps/dota/worldnodes/node_collision.vmdl_c', Buffer.from('default collision')], ['maps/dota/world_physics.vmdl_c', Buffer.from('default physics')],
    ['maps/dota/world_visibility.vvis_c', Buffer.from('default visibility')], ['maps/dota/entities/default_ents.vents_c', Buffer.from('default entity positions')],
    ['maps/dota/entities/neutralcamp.vmdl_c', Buffer.from('default camp mesh')], ['maps/dota.gnv', Buffer.from('default navigation')],
    ['maps/dota.vhcg', Buffer.from('default height grid')], ['maps/dota.trm', Buffer.from('default trees')],
    ['maps/dota/water_flow_map.vtex_c', Buffer.from('default water')],
  ]);
  const variant = new Map([...base].map(([name, bytes]) => [name, Buffer.concat([Buffer.from('variant:'), bytes])]));
  variant.delete('maps/dota.vmap_c'); variant.delete('maps/dota/worldnodes/unused.vmdl_c'); variant.set('maps/dota_spring.vmap_c', Buffer.from('variant map root'));
  variant.set('maps/dota/worldnodes/new_tree.vmdl_c', Buffer.from('variant visual tree')); variant.set('scripts/items/items_game.txt', Buffer.from('forbidden schema'));
  variant.set('maps/dota/worldnodes/new_nav_walkable.vmdl_c', Buffer.from('forbidden new navigation'));
  const defaultPath = writeMap('dota', base), variantPath = writeMap('dota_spring', variant);
  const assetData = new Map([
    ['materials/models/creeps/roshan/base.vmat_c', Buffer.from('default roshan')], ['materials/models/creeps/roshan/spring.vmat_c', Buffer.from('spring roshan')],
    ['particles/econ/world/tower/default.vpcf_c', Buffer.from('default tower')], ['particles/econ/world/tower/spring.vpcf_c', Buffer.from('spring tower')],
    ['particles/units/heroes/hero_winter_wyvern/cold.vpcf_c', Buffer.from('hero particle')], ['particles/econ/world/snow.vpcf_c', Buffer.from('snow')],
  ]);
  const indexPath = path.join(gameDir, 'dota', 'pak01_dir.vpk'); fs.writeFileSync(indexPath, createVpk(assetData)); const index = openVpk(indexPath);
  const schema = { prefabs: { terrain: {}, inherited_terrain: { prefab: 'terrain' } }, items: {
    590: { name: 'Default Terrain', prefab: 'terrain', visuals: {} },
    11171: { name: 'Seasonal Terrain - Spring', prefab: 'inherited_terrain', visuals: {
      asset_modifier0: { type: 'map_override', asset: 'maps/dota.vmap', modifier: 'maps/dota_spring.vmap' },
      asset_modifier1: { type: 'npc_material_override', asset: 'materials/models/creeps/roshan/base.vmat', modifier: 'materials/models/creeps/roshan/spring.vmat' },
      asset_modifier: [
        { type: 'particle_clientside', asset: 'particles/econ/world/tower/default.vpcf', modifier: 'particles/econ/world/tower/spring.vpcf' },
        { type: 'particle', asset: 'particles/units/heroes/hero_winter_wyvern/cold.vpcf', modifier: 'particles/econ/world/snow.vpcf' },
        { type: 'weather_effect', asset: 'particles/econ/world/snow.vpcf' },
      ],
    } },
    12022: { name: 'Missing Cavern', prefab: 'terrain', visuals: { modifier: { type: 'map_override', asset: 'maps/dota.vmap', modifier: 'maps/dota_cavern.vmap' } } },
    999: { name: 'Old gameplay map', prefab: 'terrain', visuals: { modifier: { type: 'map_override', asset: 'maps/dota.vmap', modifier: 'maps/dota_683.vmap' } } },
    1000: { name: 'Traversal', prefab: 'terrain', visuals: { modifier: { type: 'map_override', asset: 'maps/dota.vmap', modifier: 'maps/../../outside.vmap' } } },
    1001: { name: 'Hero demo', prefab: 'terrain', visuals: { modifier: { type: 'map_override', asset: 'maps/hero_demo_main.vmap', modifier: 'maps/hero_demo_spring.vmap' } } },
  } };
  return { root, gameDir, maps, index, schema, base, variant, defaultPath, variantPath, writeMap };
}

test('terrain catalog derives current official items, inheritance and map availability without admitting old or demo maps', t => {
  const files = fixture(t), rows = inspectTerrains(files);
  assert.deepEqual(rows.map(row => row.id), ['default', 'terrain_11171', 'terrain_12022']);
  assert.equal(rows[0].available, true); assert.equal(rows[1].name, 'Seasonal Terrain - Spring'); assert.equal(rows[1].mapName, 'dota_spring'); assert.equal(rows[1].mapPath, files.variantPath); assert.equal(rows[1].available, true);
  assert.equal(rows[2].available, false); assert.match(rows[2].limitations[0], /отсутствуют|повреждены/);
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), rows); assert.match(rows[1].limitations.join(' '), /Погода.*не включены/);
});

test('strict visual merge preserves every protected default resource byte for byte and keeps fallback dependencies', t => {
  const files = fixture(t), before = hash(fs.readFileSync(files.defaultPath)), plan = terrainPlan({ ...files, terrain: 'terrain_11171' });
  assert.ok(plan instanceof Map); assert.equal(plan.terrainId, 'terrain_11171');
  for (const resource of plan.protectedPaths) {
    const reference = plan.get(resource); assert.equal(reference.index.filename, files.defaultPath); assert.equal(reference.resource, resource);
    assert.equal(hash(readResource(reference.index, reference.resource)), hash(files.base.get(resource)), resource);
  }
  assert.deepEqual(readResource(plan.get('maps/dota/worldnodes/n0.vwnod_c').index, 'maps/dota/worldnodes/n0.vwnod_c'), files.variant.get('maps/dota/worldnodes/n0.vwnod_c'));
  assert.equal(plan.get('maps/dota/worldnodes/new_tree.vmdl_c').index.filename, files.variantPath);
  assert.equal(plan.has('maps/dota/worldnodes/new_nav_walkable.vmdl_c'), false); assert.equal(plan.has('maps/dota_spring.vmap_c'), false); assert.equal(plan.has('scripts/items/items_game.txt'), false);
  assert.equal(plan.get('maps/dota/world.vwrld_c').index.filename, files.defaultPath); assert.equal(plan.get('maps/dota/worldnodes/unused.vmdl_c').index.filename, files.defaultPath);
  assert.equal(plan.sourceFingerprints.default.sha256, before); assert.equal(plan.sourceFingerprints.terrain.sha256, hash(fs.readFileSync(files.variantPath))); assert.equal(hash(fs.readFileSync(files.defaultPath)), before);
  const outputPath = path.join(files.root, 'planned.vpk'); fs.writeFileSync(outputPath, createVpk(new Map([...plan].map(([resource, ref]) => [resource, readResource(ref.index, ref.resource)]))));
  const output = openVpk(outputPath); for (const resource of plan.protectedPaths) assert.deepEqual(readResource(output, resource), files.base.get(resource), resource);
});

test('eligible terrain aliases are explicit compiled world assets and do not activate weather or replace hero resources', t => {
  const files = fixture(t), row = inspectTerrains(files)[1], plan = terrainPlan({ ...files, terrain: row });
  assert.deepEqual(row.assetAliases, {
    'materials/models/creeps/roshan/base.vmat_c': 'materials/models/creeps/roshan/spring.vmat_c',
    'particles/econ/world/tower/default.vpcf_c': 'particles/econ/world/tower/spring.vpcf_c',
  });
  assert.equal(plan.assetAliases.size, 2); assert.equal(plan.assetAliases.get('materials/models/creeps/roshan/base.vmat_c').index, files.index);
  assert.equal([...plan.assetAliases.keys()].some(resource => resource.includes('/heroes/')), false);
});

test('default needs no override and cached arbitrary paths cannot affect the build plan', t => {
  const files = fixture(t); assert.equal(terrainPlan({ ...files, terrain: 'default' }).size, 0);
  const plan = terrainPlan({ ...files, terrain: { id: 'terrain_11171', mapPath: path.join(files.root, 'outside.vpk'), assetAliases: { outside: 'bad' } } });
  assert.equal(plan.sourceFingerprints.terrain.path, files.variantPath); assert.equal(plan.assetAliases.size, 2);
  assert.throws(() => terrainPlan({ ...files, terrain: 'terrain_12022' }), failure => failure.code === 'TERRAIN_UNAVAILABLE');
  for (const terrain of ['../dota_spring', 'terrain_999', 'terrain_1000', 'terrain_1001', null]) assert.throws(() => terrainPlan({ ...files, terrain }), failure => failure.code === 'INVALID_TERRAIN');
});

test('missing default and malformed variants are unavailable instead of silently using a whole alternate map', t => {
  const files = fixture(t); fs.writeFileSync(files.variantPath, 'not a map'); assert.equal(inspectTerrains(files)[1].available, false);
  assert.throws(() => terrainPlan({ ...files, terrain: 'terrain_11171' }), failure => failure.code === 'TERRAIN_UNAVAILABLE');
  fs.unlinkSync(files.defaultPath); const rows = inspectTerrains(files); assert.equal(rows[0].available, false); assert.ok(rows.every(row => row.available === false));
});

test('render whitelist excludes roots, mechanics, entity geometry and unknown resource types', () => {
  for (const resource of ['maps/dota.vmap_c', 'maps/dota/world.vwrld_c', 'maps/dota/entities/default_ents.vents_c', 'maps/dota/entities/tree.vmdl_c', 'maps/dota/worldnodes/nav.vmdl_c', 'maps/dota/worldnodes/mesh.vphys_c', 'maps/dota/worldnodes/physics.vmdl_c', 'maps/dota/worldnodes/a.bin', 'maps/dota/worldnodes/visibility.vtex_c', 'maps/dota/world_physics.vmdl_c']) assert.equal(isTerrainVisualPath(resource), false, resource);
  for (const resource of ['maps/dota/worldnodes/n0.vwnod_c', 'maps/dota/worldnodes/render.vmdl_c', 'maps/dota/worldnodes/n0.vgrass', 'maps/dota/water_flow_map.vtex_c']) assert.equal(isTerrainVisualPath(resource), true, resource);
});

test('nav_walkable material render meshes are admitted by compiled contents, never by their name alone', () => {
  const name = 'maps/dota/worldnodes/n0_lr0_c0_s_cb_nomerge592_dota_nav_walkable.vmdl_c';
  assert.equal(isTerrainVisualPath(name), false); assert.equal(isTerrainVisualPath(name, Buffer.from('not compiled')), false);
  assert.equal(isTerrainVisualPath(name, compiledRender()), true);
  assert.equal(isTerrainVisualPath(name.replace('.vmdl_c', '.vmesh_c'), compiledRender()), true);
  for (const options of [{ physicsBlock: true }, { unknownBlock: true }, { mesh: 'CRenderMesh CPhysAggregateData' }, { mesh: 'CRenderMesh embedded_physics' }, { mesh: 'CRenderMesh m_refPhysicsData' }, { material: 'models/map/collision.vphys' }, { material: 'materials/../physics.vmat' }]) assert.equal(isTerrainVisualPath(name, compiledRender(options)), false, JSON.stringify(options));
  const truncated = compiledRender().subarray(0, -1); assert.equal(isTerrainVisualPath(name, truncated), false);
  const badOffset = compiledRender(); badOffset.writeUInt32LE(0xfffffff0, 20); assert.equal(isTerrainVisualPath(name, badOffset), false);
});

test('complete variant render graph keeps safe nav_walkable models while actual navigation and physics remain exact', t => {
  const files = fixture(t), existing = 'maps/dota/worldnodes/n0_lr0_c0_s_cb_nomerge111_dota_nav_walkable.vmdl_c', added = 'maps/dota/worldnodes/n0_lr0_c0_s_cb_nomerge592_dota_nav_walkable.vmdl_c';
  files.base.set(existing, compiledRender({ mesh: 'CRenderMesh default visual mesh' })); files.variant.set(existing, compiledRender({ mesh: 'CRenderMesh updated visual mesh' })); files.variant.set(added, compiledRender());
  files.writeMap('dota', files.base); files.writeMap('dota_spring', files.variant);
  const plan = terrainPlan({ ...files, terrain: 'terrain_11171' });
  assert.equal(plan.get(existing).index.filename, files.variantPath); assert.equal(plan.get(added).index.filename, files.variantPath); assert.equal(plan.protectedPaths.includes(existing), false);
  for (const resource of ['maps/dota.gnv', 'maps/dota.trm', 'maps/dota.vhcg', 'maps/dota/world_physics.vmdl_c', 'maps/dota/world_visibility.vvis_c', 'maps/dota/entities/default_ents.vents_c']) {
    assert.ok(plan.protectedPaths.includes(resource)); const reference = plan.get(resource); assert.deepEqual(readResource(reference.index, reference.resource), files.base.get(resource));
  }
});

test('an unverified nav_walkable dependency aborts the plan instead of silently emitting an incomplete terrain', t => {
  const files = fixture(t), dependency = 'maps/dota/worldnodes/n0_lr0_c0_s_cb_nomerge592_dota_nav_walkable.vmdl_c';
  files.variant.set(dependency, compiledRender({ physicsBlock: true })); files.writeMap('dota_spring', files.variant);
  assert.throws(() => terrainPlan({ ...files, terrain: 'terrain_11171' }), failure => failure.code === 'TERRAIN_VISUAL_UNVERIFIED');
});

test('linked map directories are rejected before inspecting or planning resources', t => {
  const files = fixture(t), real = path.join(files.root, 'real-maps'); fs.renameSync(files.maps, real); fs.symlinkSync(real, files.maps, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => inspectTerrains(files), failure => failure.code === 'UNSAFE_PATH'); assert.throws(() => terrainPlan({ ...files, terrain: 'terrain_11171' }), failure => failure.code === 'UNSAFE_PATH');
});
