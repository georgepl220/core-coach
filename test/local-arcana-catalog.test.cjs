'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createVpk, openVpk } = require('../src/valve-vpk.cjs');
const { parseKeyValues, readItemSchema, inspectArcanas, buildArcanaPlan, readResourceReferences } = require('../src/local-arcana-catalog.cjs');
const DROW = { id: 6, name: 'npc_dota_hero_drow_ranger', localizedName: 'Drow Ranger' };
const IO = { id: 91, name: 'npc_dota_hero_wisp', localizedName: 'Io' };
const MK = { id: 114, name: 'npc_dota_hero_monkey_king', localizedName: 'Monkey King' };
const quote = value => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
function compiledReferences(names) {
  const strings = names.map(name => Buffer.from(name + '\0')), tableBytes = 12 + names.length * 16;
  const block = Buffer.alloc(tableBytes + strings.reduce((sum, data) => sum + data.length, 0));
  block.writeUInt32LE(12, 0); block.writeUInt32LE(names.length, 4); let cursor = tableBytes;
  for (let i = 0; i < names.length; i++) { const offsetAt = 12 + i * 16 + 8; block.writeBigInt64LE(BigInt(cursor - offsetAt), offsetAt); strings[i].copy(block, cursor); cursor += strings[i].length; }
  const buffer = Buffer.alloc(28 + block.length); buffer.writeUInt32LE(buffer.length, 0); buffer.writeUInt16LE(12, 4);
  buffer.writeUInt32LE(8, 8); buffer.writeUInt32LE(1, 12); buffer.write('RERL', 16); buffer.writeUInt32LE(8, 20); buffer.writeUInt32LE(block.length, 24); block.copy(buffer, 28); return buffer;
}
function keyValues(object) { return Object.entries(object).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map(part => typeof part === 'object' ? `${quote(key)}\n{\n${keyValues(part)}\n}` : `${quote(key)} ${quote(part)}`)).join('\n'); }
function fixture(t, schema, files = {}, npcs = {}) {
  const parent = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'core-coach-arcana-catalog-'));
  t.after(() => { assert.ok(root.startsWith(parent + path.sep) && path.basename(root).startsWith('core-coach-arcana-catalog-')); fs.rmSync(root, { recursive: true, force: true }); });
  const resources = new Map([['scripts/items/items_game.txt', Buffer.from(keyValues({ items_game: schema }))]]);
  for (const [name, data] of Object.entries(files)) resources.set(name, Buffer.from(data));
  for (const [heroKey, model] of Object.entries(npcs)) resources.set(`scripts/npc/heroes/${heroKey}.txt`, Buffer.from(keyValues({ DOTAHeroes: { [heroKey]: { Model: model } } })));
  const filename = path.join(root, 'pak01_dir.vpk'); fs.writeFileSync(filename, createVpk(resources)); return openVpk(filename);
}
function drowFixture() {
  const owner = { [DROW.name]: '1' };
  const schema = { prefabs: { wearable: { item_class: 'dota_item_wearable', item_slot: 'weapon' }, default_item: { prefab: 'wearable' }, arcana_wearable: { prefab: 'wearable', item_rarity: 'arcana' } }, items: {
    1: { name: 'Default Bow', prefab: 'default_item', model_player: 'models/heroes/drow/weapon.vmdl', used_by_heroes: owner },
    10: { name: 'Dread Retribution', prefab: 'arcana_wearable', item_slot: 'hero_base', used_by_heroes: owner, visuals: {
      asset_modifier: [
        { type: 'entity_model', asset: DROW.name, modifier: 'models/items/drow/arcana/body.vmdl' },
        { type: 'model', asset: 'models/heroes/drow/weapon.vmdl', modifier: 'models/heroes/drow/crossbow.vmdl' },
        { type: 'particle', asset: 'particles/units/heroes/hero_drow/drow_attack.vpcf', modifier: 'particles/econ/items/drow/arcana/attack.vpcf' },
        { type: 'particle', asset: 'particles/items_fx/blink.vpcf', modifier: 'particles/econ/items/drow/arcana/blink.vpcf' },
        { type: 'particle', asset: 'particles/units/heroes/hero_axe/axe_hit.vpcf', modifier: 'particles/econ/items/drow/arcana/attack.vpcf' },
        { type: 'particle_create', modifier: 'particles/econ/items/drow/arcana/ambient.vpcf' },
        { type: 'icon_replacement_hero', asset: DROW.name, modifier: DROW.name + '_alt1' },
      ], asset_modifier7: { type: 'ability_icon', asset: 'drow_ranger_frost_arrows', modifier: 'drow_ranger_arcana_frost_arrows' },
    } },
    11: { name: 'Dread Retribution - Weapon', prefab: 'wearable', model_player: 'models/items/drow/arcana/weapon.vmdl', used_by_heroes: owner },
    12: { name: 'Unrelated Set - Weapon', prefab: 'wearable', model_player: 'models/items/drow/other/weapon.vmdl', used_by_heroes: owner },
    20: { name: 'Repackaged Bundle', prefab: 'bundle', item_rarity: 'arcana', used_by_heroes: owner, bundle: { 'Dread Retribution': '1', 'Dread Retribution - Weapon': '1', 'Unrelated Set - Weapon': '1' } },
  } };
  const files = Object.fromEntries([
    'models/heroes/drow/base.vmdl_c', 'models/heroes/drow/weapon.vmdl_c', 'models/heroes/drow/crossbow.vmdl_c', 'models/items/drow/arcana/body.vmdl_c', 'models/items/drow/arcana/weapon.vmdl_c', 'models/items/drow/other/weapon.vmdl_c',
    'particles/units/heroes/hero_drow/drow_attack.vpcf_c', 'particles/econ/items/drow/arcana/attack.vpcf_c', 'particles/items_fx/blink.vpcf_c', 'particles/econ/items/drow/arcana/blink.vpcf_c', 'particles/units/heroes/hero_axe/axe_hit.vpcf_c', 'particles/econ/items/drow/arcana/ambient.vpcf_c',
    'panorama/images/spellicons/drow_ranger_frost_arrows_png.vtex_c', 'panorama/images/spellicons/drow_ranger_arcana_frost_arrows_png.vtex_c', 'panorama/images/heroes/npc_dota_hero_drow_ranger_png.vtex_c', 'panorama/images/heroes/npc_dota_hero_drow_ranger_alt1_png.vtex_c',
  ].map(name => [name, 'fixture bytes for ' + name]));
  return { schema, files };
}

test('KeyValues retains repeated and numbered asset modifiers and refuses malformed schemas', () => {
  const parsed = parseKeyValues('// comment\n "visuals" { "asset_modifier" { "type" "one" } "asset_modifier" { "type" "two" } "asset_modifier3" { "type" "three" } }');
  assert.deepEqual(parsed.visuals.asset_modifier.map(value => value.type), ['one', 'two']);
  assert.equal(parsed.visuals.asset_modifier3.type, 'three');
  assert.throws(() => parseKeyValues('"root" { "key"'), /Missing/);
  assert.throws(() => parseKeyValues('/* unclosed'), /Unclosed/);
});

test('catalogue resolves prefab rarity and inherited slots, bundle names and exact hero base paths', t => {
  const { schema, files } = drowFixture(), index = fixture(t, schema, files, { [DROW.name]: 'models/heroes/drow/base.vmdl' });
  assert.equal(readItemSchema(index), readItemSchema(index));
  const rows = inspectArcanas(index, { heroes: [DROW] }); assert.equal(rows.length, 1);
  const row = rows[0]; assert.equal(row.id, 'drow_dread_retribution'); assert.equal(row.supported, true);
  assert.equal(row.modelAliases['models/heroes/drow/base.vmdl_c'], 'models/items/drow/arcana/body.vmdl_c');
  assert.equal(row.modelAliases['models/heroes/drow/weapon.vmdl_c'], 'models/items/drow/arcana/weapon.vmdl_c');
  assert.equal(row.modelAliases['models/heroes/drow/crossbow.vmdl_c'], 'models/items/drow/arcana/weapon.vmdl_c');
  assert.equal(row.modelCount, 3);
  assert.ok(!row.itemIds.includes('12')); // Repackage's unrelated set cannot override the Arcana's weapon.
  assert.ok(!row.itemIds.includes('20')); // A bundle is not a second playable Arcana.
});

test('effect aliases include only existing hero-specific particles and ability icons', t => {
  const { schema, files } = drowFixture(), index = fixture(t, schema, files, { [DROW.name]: 'models/heroes/drow/base.vmdl' });
  const [row] = inspectArcanas(index, { heroes: [DROW] });
  assert.equal(row.effectAliases['particles/units/heroes/hero_drow/drow_attack.vpcf_c'], 'particles/econ/items/drow/arcana/attack.vpcf_c');
  assert.equal(row.effectAliases['panorama/images/spellicons/drow_ranger_frost_arrows_png.vtex_c'], 'panorama/images/spellicons/drow_ranger_arcana_frost_arrows_png.vtex_c');
  assert.equal(row.effectCount, 2);
  assert.ok(Object.keys(row.effectAliases).every(name => !name.startsWith('panorama/images/heroes/')));
  assert.ok(!Object.hasOwn(row.effectAliases, 'particles/items_fx/blink.vpcf_c'));
  assert.ok(!Object.hasOwn(row.effectAliases, 'particles/units/heroes/hero_axe/axe_hit.vpcf_c'));
  assert.equal(row.fullEffectsSupported, false);
  assert.ok(row.limitations.some(text => text.includes('частицы')));
  assert.equal(buildArcanaPlan([row], [row.id], false).size, row.modelCount);
  assert.equal(buildArcanaPlan([row], [row.id], true).size, row.modelCount + row.effectCount);
});

test('conflicting default-style effects are omitted and alternate styles cannot win by array order', t => {
  const { schema, files } = drowFixture();
  schema.items[10].visuals.asset_modifier.push(
    { type: 'particle', asset: 'particles/units/heroes/hero_drow/drow_attack.vpcf', modifier: 'particles/econ/items/drow/arcana/other.vpcf' },
    { type: 'particle', asset: 'particles/units/heroes/hero_drow/drow_attack.vpcf', modifier: 'particles/econ/items/drow/arcana/alternate.vpcf', style: '1' },
  );
  files['particles/econ/items/drow/arcana/other.vpcf_c'] = 'other'; files['particles/econ/items/drow/arcana/alternate.vpcf_c'] = 'alternate';
  const [row] = inspectArcanas(fixture(t, schema, files, { [DROW.name]: 'models/heroes/drow/base.vmdl' }), { heroes: [DROW] });
  assert.ok(!Object.hasOwn(row.effectAliases, 'particles/units/heroes/hero_drow/drow_attack.vpcf_c'));
  assert.equal(row.omittedAmbiguousTargets.length, 1);
  assert.ok(row.limitations.some(text => text.includes('Неоднозначные')));
  assert.equal(row.effectCount, 1);
});

test('dependency guard omits direct recursive particles and model aliases and updates their displayed counts', t => {
  const { schema, files } = drowFixture();
  const particle = 'particles/units/heroes/hero_drow/drow_attack.vpcf_c';
  files['particles/econ/items/drow/arcana/attack.vpcf_c'] = compiledReferences([particle.replace(/_c$/, '')]);
  files['models/items/drow/arcana/body.vmdl_c'] = compiledReferences(['models/heroes/drow/base.vmdl']);
  const [row] = inspectArcanas(fixture(t, schema, files, { [DROW.name]: 'models/heroes/drow/base.vmdl' }), { heroes: [DROW] });
  assert.equal(row.effectAliases[particle], undefined);
  assert.equal(row.modelAliases['models/heroes/drow/base.vmdl_c'], undefined);
  assert.equal(row.modelCount, 2); assert.equal(row.effectCount, 1); assert.equal(row.supported, true);
  assert.deepEqual(new Set(row.omittedCyclicTargets), new Set([particle, 'models/heroes/drow/base.vmdl_c']));
  assert.ok(row.limitations.some(text => /циклическими зависимостями.*2/.test(text)));
  assert.equal(buildArcanaPlan([row], [row.id], true).size, 3);
});

test('dependency guard follows transitive stock dependencies and preserves unrelated native cycles', t => {
  for (const recursive of [true, false]) {
    const { schema, files } = drowFixture();
    const target = 'particles/units/heroes/hero_drow/drow_attack.vpcf_c';
    files['particles/econ/items/drow/arcana/attack.vpcf_c'] = compiledReferences(['particles/econ/items/drow/arcana/helper_a.vpcf']);
    files['particles/econ/items/drow/arcana/helper_a.vpcf_c'] = compiledReferences(['particles/econ/items/drow/arcana/helper_b.vpcf']);
    files['particles/econ/items/drow/arcana/helper_b.vpcf_c'] = compiledReferences([recursive ? target : 'particles/econ/items/drow/arcana/helper_a.vpcf']);
    const [row] = inspectArcanas(fixture(t, schema, files, { [DROW.name]: 'models/heroes/drow/base.vmdl' }), { heroes: [DROW] });
    assert.equal(Object.hasOwn(row.effectAliases, target), !recursive);
    assert.equal(row.omittedCyclicTargets.length, recursive ? 1 : 0);
  }
});

test('dependency guard detects cycles formed by multiple aliases and rechecks restored stock edges', t => {
  for (const restoredCycle of [false, true]) {
    const { schema, files } = drowFixture();
    const first = 'particles/units/heroes/hero_drow/drow_attack.vpcf_c', second = 'particles/units/heroes/hero_drow/drow_secondary.vpcf_c';
    schema.items[10].visuals.asset_modifier.push({ type: 'particle', asset: second.replace(/_c$/, ''), modifier: 'particles/econ/items/drow/arcana/secondary.vpcf' });
    files['particles/econ/items/drow/arcana/attack.vpcf_c'] = compiledReferences([second]);
    files['particles/econ/items/drow/arcana/secondary.vpcf_c'] = compiledReferences([restoredCycle ? second : first]);
    files[second] = restoredCycle ? compiledReferences([first]) : Buffer.from('stock secondary');
    const [row] = inspectArcanas(fixture(t, schema, files, { [DROW.name]: 'models/heroes/drow/base.vmdl' }), { heroes: [DROW] });
    assert.equal(row.effectAliases[first], undefined); assert.equal(row.effectAliases[second], undefined);
    assert.deepEqual(new Set(row.omittedCyclicTargets), new Set([first, second])); assert.equal(row.effectCount, 1);
  }
});

test('RERL inspection rejects malformed offsets instead of treating unverified references as safe', t => {
  const resource = 'particles/econ/items/drow/arcana/attack.vpcf_c', data = compiledReferences(['particles/units/heroes/hero_drow/drow_attack.vpcf']);
  data.writeBigInt64LE(0n, 28 + 12 + 8);
  const { schema, files } = drowFixture(); files[resource] = data;
  const index = fixture(t, schema, files, { [DROW.name]: 'models/heroes/drow/base.vmdl' });
  assert.throws(() => readResourceReferences(index, resource), error => error.code === 'RESOURCE_DEPENDENCY_INVALID');
  assert.throws(() => inspectArcanas(index, { heroes: [DROW] }), error => error.code === 'RESOURCE_DEPENDENCY_INVALID');
});

test('Io remains unavailable when an Arcana head needs a wearable entity absent from the stock slot', t => {
  const owner = { [IO.name]: '1' };
  const schema = { prefabs: { wearable: { item_class: 'dota_item_wearable', item_slot: 'weapon' } }, items: {
    1: { name: 'Io Head', prefab: 'default_item', item_slot: 'head', used_by_heroes: owner },
    2: { name: 'Benevolent Companion', prefab: 'wearable', item_rarity: 'arcana', item_slot: 'head', model_player: 'models/items/io/cube.vmdl', used_by_heroes: owner },
  } };
  const [row] = inspectArcanas(fixture(t, schema, { 'models/heroes/wisp/wisp.vmdl_c': 'orb', 'models/items/io/cube.vmdl_c': 'cube' }, { [IO.name]: 'models/heroes/wisp/wisp.vmdl' }), { heroes: [IO] });
  assert.equal(row.supported, false); assert.equal(row.modelCount, 0);
  assert.equal(row.modelAliases['models/heroes/wisp/wisp.vmdl_c'], undefined); // No unverified wearable-to-base fallback.
  assert.throws(() => buildArcanaPlan([row], [row.id], true), error => error.code === 'UNSUPPORTED_ARCANA');
});

test('a visible Monkey King crown is partial support and does not pretend to apply the Arcana body skin', t => {
  const owner = { [MK.name]: '1' };
  const schema = { prefabs: { wearable: { item_class: 'dota_item_wearable', item_slot: 'weapon' } }, items: {
    1: { name: 'Default Hair', prefab: 'default_item', item_slot: 'head', model_player: 'models/heroes/monkey_king/hair.vmdl', used_by_heroes: owner },
    2: { name: 'Great Sage', prefab: 'wearable', item_rarity: 'arcana', item_slot: 'hero_base', used_by_heroes: owner, visuals: { asset_modifier: { type: 'model_skin', skin: '1', style: '0' } } },
    3: { name: 'Great Sage - Head', prefab: 'wearable', item_slot: 'head', model_player: 'models/items/monkey_king/crown.vmdl', used_by_heroes: owner },
    4: { name: 'Great Sage Bundle', prefab: 'bundle', bundle: { 'Great Sage': '1', 'Great Sage - Head': '1' } },
  } };
  const [row] = inspectArcanas(fixture(t, schema, { 'models/heroes/monkey_king/hair.vmdl_c': 'hair', 'models/items/monkey_king/crown.vmdl_c': 'crown' }, { [MK.name]: 'models/heroes/monkey_king/body.vmdl' }), { heroes: [MK] });
  assert.equal(row.supported, true); assert.equal(row.modelCount, 1);
  assert.ok(row.limitations.some(text => text.includes('групп материалов')));
  assert.equal(row.fullEffectsSupported, false);
});

test('package planning refuses unknown recipes and conflicting resource targets', () => {
  const first = { id: 'a', supported: true, modelAliases: { 'models/heroes/a/body.vmdl_c': 'models/items/a/one.vmdl_c' }, effectAliases: {} };
  const second = { id: 'b', supported: true, modelAliases: { 'models/heroes/a/body.vmdl_c': 'models/items/a/two.vmdl_c' }, effectAliases: {} };
  assert.throws(() => buildArcanaPlan([first], ['unknown']), error => error.code === 'INVALID_ARCANA');
  assert.throws(() => buildArcanaPlan([first, second], ['a', 'b']), error => error.code === 'ARCANA_CONFLICT');
  assert.equal(buildArcanaPlan([first], ['a', 'a']).size, 1);
});
