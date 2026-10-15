'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { validateImport, validatePersonalImport, normalizePopularity, refreshOpenDota, importFile, SOURCE_URL, POPULARITY_URL } = require('../scripts/update-protracker.cjs');

const NOW = '2026-10-12T10:21:54.000Z';
const catalog = { radiance: { id: 137 }, blink: { id: 1 }, armlet: { id: 112 }, tango: { id: 44 }, relic: { id: 54 } };
function popularity(extra = {}) {
  return { start_game_items: { 44: 100 }, early_game_items: { 112: 40 }, mid_game_items: { 137: 80, 1: 60, 54: 90 }, late_game_items: { 1: 30 }, ...extra };
}
function permittedExport(extra = {}) {
  return {
    heroId: 42, sourceUrl: SOURCE_URL, fetchedAt: '2026-10-11T12:00:00.000Z', patch: { name: '7.41f', scope: 'Fixture permitted export' },
    sampleCount: 100, license: { applicationUseAllowed: true, permissionReference: 'Fixture permission reference' },
    build: { role: 'carry', items: [{ key: 'radiance', phase: 'mid', timingMinutes: 18, frequency: 0.8 }], skills: [{ level: 1, key: 'skeleton_king_hellfire_blast' }] },
    benchmarks: [{ minute: 10, lastHits: { p25: 30, median: 40, p75: 50 }, netWorth: null, sampleCount: 80, provenance: 'Fixture direct minute10 observations' }],
    ...extra,
  };
}

test('fresh cache preserves actual phase counts without fabricating role, denominator, timings or benchmarks', () => {
  const data = normalizePopularity(popularity(), catalog, NOW);
  assert.equal(data.build.role, 'unknown');
  assert.equal(data.patchVerified, false);
  assert.equal(data.patch, null);
  assert.equal(data.sampleCount, null);
  assert.deepEqual(data.benchmarks, []);
  assert.deepEqual(data.build.items.filter(item => item.phase === 'mid').map(item => [item.key, item.evidenceCount, item.phaseRank]), [['radiance', 80, 1], ['blink', 60, 2]]);
  assert.ok(data.build.items.every(item => item.frequency === null && item.timingMinutes === null));
  assert.equal(data.sourceUrl, POPULARITY_URL);
  assert.equal(data.externalUrl, SOURCE_URL);
});

test('malformed or empty remote purchase payloads fail validation', () => {
  assert.throws(() => normalizePopularity(popularity({ mid_game_items: { 137: -2 } }), catalog), /Invalid purchase count/);
  assert.throws(() => normalizePopularity(popularity({ early_game_items: [] }), catalog), /Missing OpenDota phase/);
  assert.throws(() => normalizePopularity(popularity({ early_game_items: { 112: 3.5 } }), catalog), /Invalid purchase count/);
  assert.throws(() => normalizePopularity({ start_game_items: {}, early_game_items: {}, mid_game_items: {}, late_game_items: {} }, catalog), /no recognized/);
});

test('new unmapped item IDs remain explicit data quality metadata', () => {
  const data = normalizePopularity(popularity({ mid_game_items: { 137: 80, 999999: 7 } }), catalog, NOW);
  assert.deepEqual(data.validation.unknownItemIds, ['999999']);
  assert.equal(data.build.items.find(item => item.key === 'radiance').evidenceCount, 80);
});

test('ProTracker imports require a permitted export and retain the original freshness timestamp', () => {
  const input = permittedExport();
  const data = validateImport(input, catalog, NOW);
  assert.equal(data.fetchedAt, input.fetchedAt);
  assert.equal(data.importedAt, NOW);
  assert.equal(data.sampleCount, 100);
  assert.equal(data.build.items[0].frequency, .8);
  assert.throws(() => validateImport(permittedExport({ license: {} }), catalog, NOW), /permission/);
  assert.throws(() => validateImport(permittedExport({ sourceUrl: 'https://untrusted.example/builds/x' }), catalog, NOW), /Unexpected source/);
  assert.throws(() => validateImport(permittedExport({ fetchedAt: '2027-01-01T00:00:00Z' }), catalog, NOW), /timestamp/);
  assert.throws(() => validateImport(permittedExport({ build: { role: 'offlane', items: [] } }), catalog, NOW), /carry export/);
});

test('import does not confuse percent frequency with fraction or accept unknown items', () => {
  assert.throws(() => validateImport(permittedExport({ build: { role: 'carry', items: [{ key: 'radiance', frequency: 80 }] } }), catalog, NOW), /frequency/);
  assert.throws(() => validateImport(permittedExport({ build: { role: 'carry', items: [{ key: 'nonexistent_item' }] } }), catalog, NOW), /Unknown item/);
  assert.throws(() => validateImport(permittedExport({ build: { role: 'carry', items: [{ key: 'radiance' }, { key: 'radiance' }] } }), catalog, NOW), /Duplicate item/);
});

test('checkpoint import requires observed data, ordered quantiles and genuine per-checkpoint sample sizes', () => {
  const checkpoint = permittedExport().benchmarks[0];
  assert.throws(() => validateImport(permittedExport({ benchmarks: [{ ...checkpoint, provenance: '' }] }), catalog, NOW), /provenance/);
  assert.throws(() => validateImport(permittedExport({ benchmarks: [{ ...checkpoint, lastHits: { p25: 60, median: 40, p75: 50 } }] }), catalog, NOW), /Unordered/);
  assert.throws(() => validateImport(permittedExport({ benchmarks: [{ ...checkpoint, sampleCount: 101 }] }), catalog, NOW), /sample count/);
  assert.throws(() => validateImport(permittedExport({ benchmarks: [{ ...checkpoint, lastHits: null }] }), catalog, NOW), /Empty/);
});

test('personal route retains user targets and never masquerades as empirical source data', () => {
  const data = validatePersonalImport({ heroId: 42, build: { role: 'carry', items: [{ key: 'radiance', phase: 'mid', targetMinutes: 18 }] } }, catalog, NOW);
  assert.equal(data.source, 'Personal build');
  assert.equal(data.provenance.kind, 'personal_preference');
  assert.equal(data.build.items[0].targetMinutes, 18);
  assert.equal(data.build.items[0].frequency, undefined);
  assert.equal(data.patchVerified, false);
  assert.equal(data.sampleCount, null);
  assert.deepEqual(data.benchmarks, []);
});

test('failed remote refresh preserves the previously saved cache', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wk-cache-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const destination = path.join(dir, 'fresh-build.json');
  await fs.writeFile(destination, 'previous valid cache');
  await assert.rejects(refreshOpenDota({ catalog, now: NOW, destination, fetch: async () => ({ ok: true, json: async () => ({}) }) }), /Missing OpenDota/);
  assert.equal(await fs.readFile(destination, 'utf8'), 'previous valid cache');
  await assert.rejects(refreshOpenDota({ catalog, now: NOW, destination, fetch: async () => ({ ok: false, status: 429 }) }), /HTTP 429/);
  assert.equal(await fs.readFile(destination, 'utf8'), 'previous valid cache');
});

test('import validates before atomically replacing cache and accepts UTF8 BOM exports', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wk-import-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'export.json'), destination = path.join(dir, 'cache.json');
  await fs.writeFile(destination, 'previous cache');
  await fs.writeFile(source, JSON.stringify(permittedExport({ license: {} })));
  await assert.rejects(importFile(source, { catalog, now: NOW, destination }), /permission/);
  assert.equal(await fs.readFile(destination, 'utf8'), 'previous cache');
  await fs.writeFile(source, `\uFEFF${JSON.stringify(permittedExport())}`);
  const imported = await importFile(source, { catalog, now: NOW, destination });
  assert.match(imported.provenance.importSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(await fs.readFile(destination, 'utf8')).build.items[0].key, 'radiance');
});
