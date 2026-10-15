'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./fixtures/selected-wk-label-real.json');
const { selectedHeroLabelRect, analyzeSelectedHero } = require('../src/screen-identity.cjs');
const unpack = frame => ({ ...frame.region, rect: { ...frame.region.rect }, data: Buffer.from(frame.region.data, 'base64') });

for (const frame of fixture.frames) {
  test(`selected WK lower-HUD proof: ${frame.name}`, () => {
    const result = analyzeSelectedHero([unpack(frame)], frame.originalSize);
    assert.equal(result.heroId, 42);
    assert.ok(result.confidence >= 0.94, result.confidence);
    assert.equal(result.source, 'selected_hero_label');
    assert.equal(result.similarityIsProbability, false);
    assert.ok(result.rect.y > frame.originalSize.height * 0.84);
  });
}

test('selected WK recognition supports transferred native ROI buffers', () => {
  const frame = fixture.frames.find(frame => frame.name.includes('chromium'));
  const region = unpack(frame);
  region.data = Uint8Array.from(region.data).buffer;
  assert.equal(analyzeSelectedHero([region], frame.originalSize).heroId, 42);
});

test('a hero in the top team strip is never proof of the selected hero', () => {
  const frame = fixture.frames[0]; const region = unpack(frame);
  region.kind = 'roster';
  assert.equal(analyzeSelectedHero([region], frame.originalSize).heroId, null);
  region.kind = 'selected_hero_label'; region.rect.y = 0;
  assert.equal(analyzeSelectedHero([region], frame.originalSize).heroId, null);
});

test('blank, black, all-white and bright noise HUD crops abstain', () => {
  const frame = fixture.frames[2];
  for (const fill of [0, 70, 255, 'noise']) {
    const region = unpack(frame);
    for (let offset = 0; offset < region.data.length; offset += 4) {
      const pixel = fill === 'noise' ? ((offset * 47 + 31) % 256) : fill;
      region.data[offset] = pixel; region.data[offset + 1] = pixel; region.data[offset + 2] = pixel; region.data[offset + 3] = 255;
    }
    const result = analyzeSelectedHero([region], frame.originalSize);
    assert.equal(result.heroId, null, `${fill}: ${result.confidence}`);
  }
});

test('a partial phrase cannot establish Wraith King as selected', () => {
  const frame = fixture.frames[0]; const region = unpack(frame);
  const match = analyzeSelectedHero([region], frame.originalSize);
  // Erase KING while preserving the real game font and WRAITH pixels.
  const start = Math.floor(match.rect.x - region.rect.x + match.rect.width * 0.64);
  for (let y = 0; y < region.height; y++) for (let x = start; x < region.width; x++) {
    const offset = (y * region.width + x) * 4;
    region.data[offset] = 35; region.data[offset + 1] = 35; region.data[offset + 2] = 35;
  }
  assert.equal(analyzeSelectedHero([region], frame.originalSize).heroId, null);
});

test('game-world images and other hero faces cannot prove the selected title', () => {
  const sceneFixture = require('./fixtures/scene-lane-real.json');
  const frame = fixture.frames[2];
  for (const template of sceneFixture.templates) {
    const icon = Buffer.from(template.data, 'base64'); const region = unpack(frame);
    for (let y = 0; y < region.height; y++) for (let x = 0; x < region.width; x++) {
      const from = (Math.floor(y * template.height / region.height) * template.width + Math.floor(x * template.width / region.width)) * 4;
      const to = (y * region.width + x) * 4;
      icon.copy(region.data, to, from, from + 4);
    }
    assert.equal(analyzeSelectedHero([region], frame.originalSize).heroId, null, template.name);
  }
});

test('invalid or resized selected-title ROI pixels abstain', () => {
  const frame = fixture.frames[2]; const region = unpack(frame);
  assert.equal(analyzeSelectedHero(null, frame.originalSize).heroId, null);
  assert.equal(analyzeSelectedHero([region], { width: 0, height: 0 }).heroId, null);
  assert.equal(analyzeSelectedHero([region], { width: Infinity, height: 720 }).heroId, null);
  assert.equal(analyzeSelectedHero([{ ...region, data: region.data.subarray(0, 5) }], frame.originalSize).heroId, null);
  assert.equal(analyzeSelectedHero([{ ...region, rect: { ...region.rect, width: region.width * 2 } }], frame.originalSize).heroId, null);
  assert.equal(selectedHeroLabelRect(30, 30), null);
});

test('native selected-title crops keep processing and IPC small at 1280x720', () => {
  const rect = selectedHeroLabelRect(1280, 720);
  assert.ok(rect.width <= 92 && rect.height <= 20);
  assert.ok(rect.width * rect.height * 4 < 7500);
});
