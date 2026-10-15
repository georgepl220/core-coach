'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { normalizeBuildImport, normalizeSkills, extractObservedSkills, defaultAbilityCatalog, importBuildFile } = require('../src/build-import.cjs');
const catalog = { phase_boots: { id: 50 }, radiance: { id: 137 }, blink: { id: 1 } };
const skills = defaultAbilityCatalog();
const NOW = '2026-10-12T12:00:00.000Z';
const personal = () => ({ kind: 'personal', heroId: 42, patch: { name: '7.41f' }, build: { role: 'carry', items: [{ key: 'phase_boots', phase: 'early' }, { key: 'radiance', phase: 'mid', targetMinutes: 18 }], skills: [{ heroLevel: 1, abilityKey: 'skeleton_king_hellfire_blast' }, { heroLevel: 2, abilityKey: 'skeleton_king_bone_guard' }, { heroLevel: 3, abilityKey: 'skeleton_king_bone_guard' }] } });
const exported = () => ({ heroId: 42, sourceUrl: 'https://dota2protracker.com/hero/Wraith%20King', fetchedAt: NOW, sampleCount: 40, patch: { name: '7.41f' }, license: { applicationUseAllowed: true, permissionReference: 'Permitted test export' }, build: { role: 'carry', items: [{ key: 'radiance', phase: 'mid', timingMinutes: 18, frequency: .8 }], skills: [{ level: 1, key: 'skeleton_king_hellfire_blast' }, { level: 10, key: 'special_bonus_unique_wraith_king_facet_1' }] } });

test('personal build maps to shared item and skill route without statistical or ProTracker attribution', () => {
  const result = normalizeBuildImport(personal(), catalog, { now: NOW });
  assert.equal(result.source, 'Личная сборка');
  assert.equal(result.patchVerified, false);
  assert.equal(result.builds[0].sequence[1].timeSeconds, null);
  assert.equal(result.builds[0].sequence[1].targetMinutes, 18);
  assert.equal(result.builds[0].skills[1].abilityId, 5087);
  assert.equal(result.builds[0].skills[1].label, 'Bone Guard');
  assert.equal(result.sampleCount, null);
  assert.equal(result.builds[0].skills[0].levelVerified, false);
});

test('authorized ProTracker export accepts current hero talents and retains source permission', () => {
  const result = normalizeBuildImport(exported(), catalog, { now: NOW });
  assert.equal(result.builds[0].skills[1].abilityId, 1545);
  assert.equal(result.builds[0].sequence[0].timeSeconds, 1080);
  assert.equal(result.license.permissionReference, 'Permitted test export');
  const denied = exported(); denied.license.applicationUseAllowed = false;
  assert.throws(() => normalizeBuildImport(denied, catalog, { now: NOW }), /permission/);
});

test('unknown source, malformed patch, innate, unknown skill IDs and ineligible skill levels are rejected', () => {
  const unknown = personal(); delete unknown.kind;
  assert.throws(() => normalizeBuildImport(unknown, catalog), /kind/);
  const wrongPatch = personal(); wrongPatch.patch.name = 'latest';
  assert.throws(() => normalizeBuildImport(wrongPatch, catalog), /патч/);
  assert.throws(() => normalizeSkills([{ heroLevel: 1, abilityKey: 'skeleton_king_vampiric_spirit' }], skills), /недоступна/);
  assert.throws(() => normalizeSkills([{ heroLevel: 1, abilityKey: 'skeleton_king_hellfire_blast', abilityId: 999 }], skills), /недоступна/);
  assert.throws(() => normalizeSkills([{ heroLevel: 1, abilityKey: 'skeleton_king_reincarnation' }], skills), /Недоступный/);
  assert.throws(() => normalizeSkills([{ heroLevel: 1, abilityKey: 'skeleton_king_bone_guard' }, { heroLevel: 2, abilityKey: 'skeleton_king_bone_guard' }], skills), /Недоступный/);
  assert.throws(() => normalizeSkills([{ heroLevel: 10, abilityKey: 'special_bonus_attack_speed_50' }], skills), /Недоступный/);
});

test('actual upgrade array retains recorded choices and clearly reconstructs rather than claims exact hero levels', () => {
  const result = extractObservedSkills({ ability_upgrades_arr: [5086,5087,5087,5088,5087,5089,5087,5088,5088,5088,1545,5086,5089,5086,5086,809,5089,6020] }, skills, 9004608046);
  assert.equal(result.kind, 'recorded_upgrade_order_reconstructed_levels');
  assert.equal(result.levelVerified, false);
  assert.equal(result.skills.length, 18);
  assert.equal(result.skills[16].heroLevel, 18);
  assert.equal(result.skills[17].heroLevel, 20);
  assert.equal(result.skills[16].upgradeIndex, 17);
  assert.ok(result.skills.every(entry => entry.sourceMatchId === 9004608046));
  const unknown = extractObservedSkills({ ability_upgrades_arr: [5086,999999,1283] }, skills, 1);
  assert.deepEqual(unknown.unknownAbilityIds, [999999,1283]);
  assert.equal(unknown.skills.length, 1);
});

test('explicit upgrade log preserves observed hero levels', () => {
  const result = extractObservedSkills({ ability_upgrades_log: [{ ability: 5086, level: 1 }, { ability: 5087, level: 4 }] }, skills, 5);
  assert.equal(result.levelVerified, true);
  assert.equal(result.skills[1].heroLevel, 4);
});

test('shipped template and every sampled route use current learnable hero abilities at eligible levels', () => {
  const template = require('../data/personal-build-template.json');
  const items = require('../data/wraith-king.json').items;
  assert.equal(normalizeBuildImport(template, items).builds[0].skills.length, 19);
  const sample = require('../data/d2pt-wraith-king.json');
  for (const build of sample.builds) {
    assert.ok(build.skills.length > 0);
    normalizeSkills(build.skills, sample.currentAbilityCatalog);
    assert.ok(build.skills.every(skill => skill.sourceMatchId === build.representativeMatchId));
    assert.equal(build.skillLevelsVerified, false);
  }
});

test('invalid JSON or build preserves previously imported cache byte for byte', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wk-import-'));
  const destination = path.join(directory, 'imported.json'), source = path.join(directory, 'source.json');
  try {
    await fs.writeFile(destination, '{"valid":"last"}\n');
    await fs.writeFile(source, '{broken');
    await assert.rejects(importBuildFile(source, destination, catalog));
    assert.equal(await fs.readFile(destination, 'utf8'), '{"valid":"last"}\n');
    await fs.writeFile(source, JSON.stringify(personal()));
    const result = await importBuildFile(source, destination, catalog, { now: NOW });
    assert.equal(result.builds[0].skills.length, 3);
    assert.match(result.provenance.importSha256, /^[a-f0-9]{64}$/);
    assert.equal(JSON.parse(await fs.readFile(destination, 'utf8')).source, 'Личная сборка');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
