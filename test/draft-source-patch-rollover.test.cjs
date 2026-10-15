'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDraftSources, atomicWrite, validData } = require('../src/draft-sources.cjs');

const NOW = Date.parse('2026-10-14T12:00:00Z'), IDS = [42, 52, 70];
const version = { id: 191, name: '7.41g', asOfDateTime: NOW / 1000 - 600, authority: 'stratz_constants_catalogue' };
function dataset(extra = {}) {
  return { schemaVersion: 1, providerId: 'stratz', updatedAt: new Date(NOW).toISOString(), scope: { patch: null, rank: null, role: null }, provenance: { schemaVerified: true, advantageMethod: 'stratz_native_synergy' }, heroes: IDS.map(heroId => ({ heroId, games: 100, wins: 50, matchups: IDS.filter(id => id !== heroId).map(heroId => ({ heroId, games: 100, wins: 50, advantage: .01 })), synergies: [] })), ...extra };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-coach-source-patch-rollover-'));
  const dataDir = path.join(root, 'data'), runtimeDir = path.join(root, 'runtime'); fs.mkdirSync(dataDir); fs.mkdirSync(runtimeDir);
  fs.writeFileSync(path.join(dataDir, 'wraith-king.json'), JSON.stringify({ heroes: Object.fromEntries(IDS.map(id => [id, { id }])) }));
  t.after(() => { assert.ok(root.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('core-coach-source-patch-rollover-')); fs.rmSync(root, { recursive: true, force: true }); });
  return { dataDir, runtimeDir, now: () => NOW };
}
const pairs = { scope: { patch: null, rank: null, role: null }, observedFrom: '2026-10-11T00:00:00Z', observedThrough: null, periodStart: '2026-10-11T00:00:00Z', periodEndExclusive: '2026-10-18T00:00:00Z', periodBoundsVerified: true, periodPartial: true, periodMethod: 'stratz_unix_week_roundtrip' };

test('a patch with no completed role day keeps new pairs and catalogue and cannot reactivate an old role cache', async t => {
  const paths = fixture(t), scope = { patch: '7.41f', rank: null, role: 'POSITION_1' };
  const old = dataset({ scope, components: { baseline: { scope, observedFrom: '2026-10-12T00:00:00Z', observedThrough: '2026-10-14T00:00:00Z' }, pairs: { ...pairs } }, provenance: { schemaVerified: true, roleFiltered: true, advantageMethod: 'stratz_native_synergy' } });
  const oldFile = path.join(paths.dataDir, 'draft-statistics-stratz-position-1.json');
  atomicWrite(oldFile, old);
  const oldBytes = fs.readFileSync(oldFile, 'utf8');
  const otherScope = { ...scope, rank: 'DIVINE_IMMORTAL' };
  atomicWrite(path.join(paths.dataDir, 'draft-statistics-stratz-position-1-rank-divine_immortal.json'), dataset({ scope: otherScope, components: { baseline: { scope: otherScope, observedThrough: '2026-10-14T00:00:00Z' }, pairs: { scope: { patch: null, role: null, rank: 'DIVINE_IMMORTAL' }, observedThrough: null } } }));
  const current = dataset({ provenance: { schemaVerified: true, advantageMethod: 'stratz_native_synergy', latestKnownGameVersion: version, roleBaselineError: 'NO_COMPLETE_CURRENT_PATCH_SAMPLE' }, components: { baseline: { scope: { patch: null, rank: null, role: null }, observedThrough: null, targetPatch: version.name, unavailableReason: 'NO_COMPLETE_CURRENT_PATCH_SAMPLE' }, pairs: { ...pairs } }, heroes: dataset().heroes.map(hero => ({ ...hero, games: 0, wins: 0, baselineAvailable: false, matchups: hero.matchups.map(pair => ({ ...pair, advantage: .025 })) })) });
  let backupRoleCalls = 0;
  const service = createDraftSources({ ...paths, getToken: () => 'fixture-token-not-real', refreshStratz: async () => current, refreshPositions: async () => { backupRoleCalls++; throw new Error('must not substitute a broad role estimate'); } });
  assert.equal(service.getData(1).scope.patch, '7.41f');
  assert.equal((await service.refresh({ force: true })).partial, true);
  assert.equal(backupRoleCalls, 0);
  const active = service.getData(1), state = service.getState(1);
  assert.equal(active.scope.patch, null);
  assert.equal(active.components.baseline.unavailableReason, 'NO_COMPLETE_CURRENT_PATCH_SAMPLE');
  assert.equal(active.provenance.latestKnownGameVersion.name, '7.41g');
  assert.equal(active.heroes[0].matchups[0].advantage, .025);
  assert.equal(active.heroes[0].baselineAvailable, false);
  assert.equal(state.status, 'partial');
  assert.equal(state.errorCode, 'NO_COMPLETE_CURRENT_PATCH_SAMPLE');
  assert.match(state.message, /нет полного дня/);
  assert.match(state.message, /7\.41g/);
  assert.equal(state.components.baseline.status, 'missing');
  assert.equal(state.components.baseline.freshnessVerified, false);
  assert.equal(fs.readFileSync(oldFile, 'utf8'), oldBytes);
  const other = service.getState({ positionId: 1, rankId: 'DIVINE_IMMORTAL' });
  assert.equal(other.components.baseline.patchMatchesCurrent, false);
  assert.equal(other.components.baseline.status, 'old_patch');
  assert.equal(other.components.baseline.freshnessVerified, false);
  assert.equal(other.baselineUnavailableReason, 'OUTDATED_PATCH');
  assert.match(other.message, /не используется/);
  const reload = createDraftSources(paths);
  assert.equal(reload.getData(1).components.baseline.unavailableReason, 'NO_COMPLETE_CURRENT_PATCH_SAMPLE');
  assert.equal(reload.getState(1).status, 'partial');
  assert.equal(reload.getState({ positionId: 1, rankId: 'DIVINE_IMMORTAL' }).components.baseline.status, 'old_patch');
});

test('verified partial period bounds are exposed independently and never count as observed freshness', t => {
  const paths = fixture(t), scope = { patch: null, rank: null, role: 'POSITION_1' };
  const value = dataset({ scope, components: { baseline: { scope, observedThrough: '2026-10-14T00:00:00Z' }, pairs: { ...pairs } } });
  atomicWrite(path.join(paths.dataDir, 'draft-statistics-stratz-position-1.json'), value);
  const state = createDraftSources(paths).getState(1);
  assert.equal(state.components.pairs.periodBoundsVerified, true);
  assert.equal(state.components.pairs.periodVerified, true);
  assert.equal(state.components.pairs.periodStart, pairs.periodStart);
  assert.equal(state.components.pairs.periodEndExclusive, pairs.periodEndExclusive);
  assert.equal(state.components.pairs.periodPartial, true);
  assert.equal(state.components.pairs.observedThrough, null);
  assert.equal(state.components.pairs.freshnessVerified, false);
  assert.equal(state.freshnessVerified, false);
  const malformed = structuredClone(value); malformed.components.pairs.periodEndExclusive = 'not-a-date';
  assert.equal(validData(malformed), false);
  malformed.components.pairs.periodEndExclusive = pairs.periodStart;
  assert.equal(validData(malformed), false);
});
