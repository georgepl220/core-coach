'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { providerHero, parseProviderArgs } = require('../src/provider-hero.cjs');
const { defaultAbilityCatalog, normalizeSkills, normalizeBuildImport } = require('../src/build-import.cjs');
const { extractCarry, aggregate } = require('../scripts/update-d2pt.cjs');

test('all five carry catalogs contain their own learnable abilities and correct ultimate keys', () => {
  for (const [id, ultimate] of [[42, 'skeleton_king_reincarnation'], [8, 'juggernaut_omni_slash'], [18, 'sven_gods_strength'], [44, 'phantom_assassin_coup_de_grace'], [48, 'luna_eclipse']]) {
    const hero = providerHero({ heroId: id }), catalog = defaultAbilityCatalog({ profile: { id } });
    assert.equal(catalog[ultimate].kind, 'ultimate', hero.displayName);
    assert.equal(catalog[ultimate].hotkey, 'R', hero.displayName);
    assert.deepEqual(catalog[ultimate].minimumLevels, [6, 12, 18]);
    assert.ok(Object.values(catalog).filter(ability => ability.kind === 'basic' && ability.learnable).length >= 2);
    for (const ability of Object.values(catalog).filter(ability => ability.innate || ability.granted)) {
      assert.throws(() => normalizeSkills([{ heroLevel: 1, abilityKey: ability.abilityKey }], catalog), /недоступна/i);
    }
  }
});

test('additional heroes have attributable parsed carry builds and same-match legal skill orders', () => {
  for (const id of [8, 18, 44, 48]) {
    const hero = providerHero({ heroId: id });
    const data = require(`../data/${hero.slug}.json`), sample = require(`../data/opendota-${hero.slug}.json`);
    assert.equal(data.heroId, id); assert.equal(sample.heroId, id);
    assert.ok(sample.sampleCount > 0); assert.ok(sample.builds.length > 0);
    assert.equal(sample.provenance.kind, 'existing_public_parsed_match_sample');
    assert.ok(sample.sourceUrl.includes(`/heroes/${id}/matches`));
    assert.equal(sample.patch.minorPatchVerified, false);
    assert.ok(!Object.keys(data.abilities).some(key => key.startsWith('skeleton_king_')));
    for (const route of sample.builds) {
      assert.ok(route.skills.length >= 6, `${hero.displayName}/${route.id}`);
      normalizeSkills(route.skills, sample.currentAbilityCatalog);
      assert.ok(route.skills.every(skill => skill.sourceMatchId === route.representativeMatchId));
      assert.ok(route.sequence.every(item => data.items[item.key]));
    }
    assert.ok(sample.provenance.observations.every(observation => observation.heroId === id));
    const template = require(`../data/personal-build-template-${id}.json`);
    assert.equal(normalizeBuildImport(template, data.items, { heroId: id }).heroId, id);
    const manifest = require('../data/assets/manifest.json');
    assert.ok(sample.builds.every(route => route.sequence.every(item => manifest.items.some(image => image.key === item.key))));
  }
});

test('provider command arguments select one implemented hero and reject invalid IDs', () => {
  assert.deepEqual(parseProviderArgs(['--hero', '18', '--enrich-skills']), { heroId: 18, args: ['--enrich-skills'] });
  assert.deepEqual(parseProviderArgs([]), { heroId: 42, args: [] });
  for (const args of [['--hero'], ['--hero', '../42'], ['--hero', '1'], ['--hero', '8', '--hero', '42']]) assert.throws(() => parseProviderArgs(args));
});

test('new-hero personal imports require matching hero and reject a WK skill route', () => {
  const data = require('../data/juggernaut.json');
  const input = { kind: 'personal', heroId: 8, build: { role: 'carry', items: [{ key: 'manta', phase: 'mid' }], skills: [{ heroLevel: 1, abilityKey: 'juggernaut_blade_fury' }] } };
  assert.throws(() => normalizeBuildImport(input, data.items), /Wraith King/);
  const imported = normalizeBuildImport(input, data.items, { profile: { id: 8 } });
  assert.equal(imported.heroId, 8);
  assert.equal(imported.builds[0].skills[0].abilityId, 5028);
  const wrongSkills = structuredClone(input); wrongSkills.build.skills[0].abilityKey = 'skeleton_king_hellfire_blast';
  assert.throws(() => normalizeBuildImport(wrongSkills, data.items, { heroId: 8 }), /недоступна/i);
});

test('OpenDota ingestion cannot combine different hero observations', () => {
  const data = require('../data/juggernaut.json');
  const match = { match_id: 1234567890, patch: 60, start_time: Date.parse('2026-10-12T12:00:00Z') / 1000, duration: 2000, players: [{ hero_id: 8, player_slot: 0, lane_role: 1, position_est: 1, purchase_log: [{ key: 'power_treads', time: 300 }, { key: 'manta', time: 1200 }] }] };
  assert.equal(extractCarry(match, data.items), null);
  const observation = extractCarry(match, data.items, { heroId: 8 });
  assert.equal(observation.heroId, 8);
  assert.equal(aggregate([observation], { heroId: 8 }).heroId, 8);
  assert.throws(() => aggregate([observation], { heroId: 18 }), /Sven/);
  assert.throws(() => providerHero({ heroId: 999999 }), /Unsupported/);
});
