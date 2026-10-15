'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const fixture = require('./fixtures/scene-lane-real.json');
const { findHealthBarHeads } = require('../src/scene-proposals.js');
const { analyzeSceneHeads, qualifiedSelectedSelf } = require('../src/scene-vision.cjs');
const templates = { minimap: fixture.templates.map((t) => ({ ...t, data: Buffer.from(t.data, 'base64') })) };
const regionsFor = (f) => f.regions.map((r) => ({ ...r, data: Buffer.from(r.data, 'base64') }));
const ids = (heroes) => heroes.map((h) => h.id).sort((a, b) => a - b);

for (const f of fixture.frames) {
  test(`real world-head patches at ${f.width}px find all four health/mana pairs automatically`, () => {
    const proposals = findHealthBarHeads({ width: f.width, height: f.height, data: zlib.gunzipSync(Buffer.from(f.patchFrame, 'base64')) });
    assert.equal(proposals.length, 4);
    for (const expected of f.regions) assert.ok(proposals.some((p) => Math.abs(p.anchor.x - expected.anchor.x) <= 1 && Math.abs(p.anchor.y - expected.anchor.y) <= 1));
    assert.ok(proposals.every((p) => p.rect.width < 48 && p.rect.height < 48));
  });
  test(`real world-head pixels at ${f.width}px recognize WK, Lion, Axe and Zeus with strict confidence`, () => {
    const result = analyzeSceneHeads(regionsFor(f), fixture.settings, templates, f.originalSize);
    assert.deepEqual(ids(result.heroes), fixture.expectedIds);
    assert.ok(result.heroes.every((h) => h.confidence >= 0.9 && h.margin >= 0.1));
    assert.equal(result.heroes.find((h) => h.id === 26).team, 'ally');
    assert.equal(result.heroes.find((h) => h.id === 22).team, 'enemy');
    assert.ok(result.heroes.every((h) => h.x >= 0 && h.x <= 1 && h.y >= 0 && h.y <= 1));
  });
}

test('canvas RGBA proposal path matches Electron BGRA at the same positions', () => {
  const f = fixture.frames[1]; const bgra = zlib.gunzipSync(Buffer.from(f.patchFrame, 'base64')); const rgba = Buffer.from(bgra);
  for (let p = 0; p < rgba.length; p += 4) { rgba[p] = bgra[p + 2]; rgba[p + 2] = bgra[p]; }
  assert.deepEqual(findHealthBarHeads({ width: f.width, height: f.height, data: rgba, format: 'rgba' }), findHealthBarHeads({ width: f.width, height: f.height, data: bgra }));
});

test('ordinary green health bars without a blue mana pair never propose hero heads', () => {
  const width = 640; const height = 360; const data = Buffer.alloc(width * height * 4);
  for (let y = 100; y < 104; y++) for (let x = 210; x < 260; x++) { const p = (y * width + x) * 4; data[p + 1] = 210; data[p + 3] = 255; }
  assert.deepEqual(findHealthBarHeads({ width, height, data }), []);
});

test('confirmed team and health-bar color must agree before a head becomes a hero observation', () => {
  const f = fixture.frames[1]; const regions = regionsFor(f).map((r) => ({ ...r, healthColor: r.healthColor === 'ally' ? 'enemy' : 'ally' }));
  const result = analyzeSceneHeads(regions, fixture.settings, templates, f.originalSize);
  assert.deepEqual(result.heroes, []);
  assert.ok(result.observations.every((o) => /conflicts/.test(o.reason)));
});

test('repeated identities in two head crops are ambiguous and never create two real heroes', () => {
  const f = fixture.frames[1]; const regions = regionsFor(f); const result = analyzeSceneHeads([...regions, { ...regions[0], index: 4 }], fixture.settings, templates, f.originalSize);
  assert.deepEqual(ids(result.heroes), [22, 26, 42]);
});

test('flat and clipped head crops abstain rather than guessing a member of the draft', () => {
  const f = fixture.frames[1]; const regions = regionsFor(f).map((r) => ({ ...r, data: Buffer.alloc(r.width * r.height * 4) }));
  assert.deepEqual(analyzeSceneHeads(regions, fixture.settings, templates, f.originalSize).heroes, []);
  assert.deepEqual(analyzeSceneHeads([{ ...regions[0], data: Buffer.alloc(4) }], fixture.settings, templates, f.originalSize).heroes, []);
});

test('without known team identities the detector provides no matchup evidence', () => {
  const f = fixture.frames[1];
  assert.deepEqual(analyzeSceneHeads(regionsFor(f), { selfHeroId: 42 }, templates, f.originalSize).heroes, []);
});

function noisyHead(region, amplitude = 48) {
  const data = Buffer.from(region.data);
  for (let offset = 0; offset < data.length; offset += 4) for (let channel = 0; channel < 3; channel++) {
    const noise = ((offset * 17 + channel * 31) % 107 - 53) / 53 * amplitude;
    data[offset + channel] = Math.max(0, Math.min(255, Math.round(data[offset + channel] + noise)));
  }
  return { ...region, data };
}
const proofTime = 200000;
const freshScreenProof = overrides => ({ ...fixture.settings, frameTimestamp: proofTime, screenPlayer: { heroId: 42, confirmed: true, source: 'selected_hud', team: 'radiant', observedAt: proofTime - 1000, ...overrides } });

test('an independent selected HUD qualifies a noisy own WK icon at its actual 87.8% similarity', () => {
  const frame = fixture.frames[1]; const regions = regionsFor(frame);
  const selfIndex = regions.findIndex(region => analyzeSceneHeads([region], fixture.settings, templates, frame.originalSize).heroes[0]?.id === 42);
  regions[selfIndex] = noisyHead(regions[selfIndex]);
  const unqualified = analyzeSceneHeads(regions, fixture.settings, templates, frame.originalSize);
  const before = unqualified.observations.find(observation => observation.bestHeroId === 42);
  assert.ok(before.bestSimilarity > 0.87 && before.bestSimilarity < 0.89);
  assert.equal(before.accepted, false);
  const qualified = analyzeSceneHeads(regions, freshScreenProof(), templates, frame.originalSize);
  assert.deepEqual(ids(qualified.heroes), fixture.expectedIds);
  const self = qualified.heroes.find(hero => hero.id === 42);
  assert.equal(self.confidence, before.bestSimilarity);
  assert.equal(self.qualifiedBySelectedHud, true);
  assert.equal(self.type, 'visible_scene_head');
  assert.equal(self.source, 'visible_scene_head');
  assert.ok(qualified.heroes.filter(hero => hero.id !== 42).every(hero => !hero.qualifiedBySelectedHud && hero.confidence >= 0.90));
});

test('noisy WK head requires a fresh confirmed selected-HUD identity and matching friendly bar', () => {
  const frame = fixture.frames[1];
  const region = noisyHead(regionsFor(frame).find(region => analyzeSceneHeads([region], fixture.settings, templates, frame.originalSize).heroes[0]?.id === 42));
  for (const override of [{ confirmed: false }, { heroId: 26 }, { source: 'screen_roster' }, { team: 'unknown' }, { observedAt: proofTime - 8001 }, { observedAt: proofTime + 1001 }, { observedAt: NaN }]) {
    assert.deepEqual(analyzeSceneHeads([region], freshScreenProof(override), templates, frame.originalSize).heroes, [], JSON.stringify(override));
  }
  assert.deepEqual(analyzeSceneHeads([{ ...region, healthColor: 'enemy' }], freshScreenProof(), templates, frame.originalSize).heroes, []);
  assert.deepEqual(analyzeSceneHeads([{ ...region, kind: 'minimap' }], freshScreenProof(), templates, frame.originalSize).heroes, []);
  assert.deepEqual(analyzeSceneHeads([region, { ...region, index: 9 }], freshScreenProof(), templates, frame.originalSize).heroes, []);
  assert.deepEqual(analyzeSceneHeads([noisyHead(region, 48)], freshScreenProof(), templates, frame.originalSize).heroes, []);
});

test('qualified self evidence keeps strict similarity, distance, margin and type limits', () => {
  const best = { id: 42, score: 0.878, distance: 0.074 }; const margin = 0.229;
  const region = { kind: 'scene_head', healthColor: 'ally' }; const settings = freshScreenProof();
  assert.equal(qualifiedSelectedSelf(best, margin, 'ally', region, settings), true);
  for (const candidate of [{ ...best, id: 26 }, { ...best, score: 0.859 }, { ...best, score: 0.90 }, { ...best, distance: 0.121 }]) assert.equal(qualifiedSelectedSelf(candidate, margin, 'ally', region, settings), false);
  assert.equal(qualifiedSelectedSelf(best, 0.159, 'ally', region, settings), false);
  assert.equal(qualifiedSelectedSelf(best, margin, 'enemy', region, settings), false);
  assert.equal(qualifiedSelectedSelf(best, margin, 'unknown', region, settings), false);
  assert.equal(qualifiedSelectedSelf(best, margin, 'ally', { ...region, kind: 'visible_template_match' }, settings), false);
  assert.equal(qualifiedSelectedSelf(best, margin, 'ally', region, { ...settings, playerTeam: 'dire' }), false);
});

test('a selected WK title cannot relax recognition of another hero', () => {
  const frame = fixture.frames[1]; const regions = regionsFor(frame);
  const lion = regions.find(region => analyzeSceneHeads([region], fixture.settings, templates, frame.originalSize).heroes[0]?.id === 26);
  // Controlled raster noise takes the real Lion head below 90% while leaving
  // its identity ahead of alternatives. A selected WK proof cannot help Lion.
  let noisyLion;
  for (const amplitude of [48, 60, 72, 84, 96, 108, 120]) {
    const candidate = noisyHead(lion, amplitude);
    const observation = analyzeSceneHeads([candidate], fixture.settings, templates, frame.originalSize).observations[0];
    if (observation.bestHeroId === 26 && observation.bestSimilarity >= 0.86 && observation.bestSimilarity < 0.90) { noisyLion = candidate; break; }
  }
  assert.ok(noisyLion, 'Fixture must actually fall into the relaxed numerical band');
  const result = analyzeSceneHeads([noisyLion], freshScreenProof(), templates, frame.originalSize);
  assert.deepEqual(result.heroes, []);
  assert.ok(result.observations.every(observation => !observation.qualifiedBySelectedHud));
});
