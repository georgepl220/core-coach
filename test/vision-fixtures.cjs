'use strict';
// Electron-only, read-only QA utility: electron test/vision-fixtures.cjs
// It creates no windows, changes no dataset files, and is not a unit test.
// A JSON report is written beside this utility (Windows GUI executables may
// not forward console output to a shell's stdout).
const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const assert = require('node:assert/strict');
const { analyzeScreen } = require('../src/vision.cjs');
const Module = require('node:module');
const debugModule = new Module(path.join(__dirname, '../src/vision.cjs'), module);
debugModule.filename = path.join(__dirname, '../src/vision.cjs');
debugModule.paths = module.paths;
debugModule._compile(fs.readFileSync(debugModule.filename, 'utf8') + '\nmodule.exports._debug={sampleRect,prepareTemplate,comparePixels};', debugModule.filename);
const debug = debugModule.exports._debug;
const root = path.join(__dirname, '..', 'data', 'assets');
const mapRect = { x: 13, y: 790, width: 276, height: 276, units: 'px' };

function decode(filename, size = null) {
  let image = nativeImage.createFromPath(filename);
  if (size) image = image.resize({ width: size, height: size, quality: 'best' });
  const dimensions = image.getSize();
  return { ...dimensions, data: image.toBitmap() };
}
function frameFromMap(map) {
  const data = Buffer.alloc(1920 * 1080 * 4, 18);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  for (let y = 0; y < map.height; y++) map.data.copy(data, ((mapRect.y + y) * 1920 + mapRect.x) * 4, y * map.width * 4, (y + 1) * map.width * 4);
  return { width: 1920, height: 1080, data };
}
function pasteIcon(frame, id, x, y, icons) {
  const entry = icons.find((t) => Number(t.heroId) === id);
  const icon = decode(path.join(root, entry.file), 22);
  for (let yy = 0; yy < icon.height; yy++) for (let xx = 0; xx < icon.width; xx++) {
    const source = (yy * icon.width + xx) * 4;
    const target = ((mapRect.y + y + yy) * frame.width + mapRect.x + x + xx) * 4;
    const a = icon.data[source + 3] / 255;
    for (let c = 0; c < 3; c++) frame.data[target + c] = Math.round(icon.data[source + c] + frame.data[target + c] * (1 - a));
  }
}
function pastePortrait(frame, id, x, y, width, height, entries, crop = false) {
  const entry = entries.find((t) => Number(t.heroId) === id);
  let source = nativeImage.createFromPath(path.join(root, entry.file));
  if (crop) {
    const dims = source.getSize();
    const cropWidth = Math.floor(dims.height * width / height);
    source = source.crop({ x: Math.floor((dims.width - cropWidth) / 2), y: 0, width: cropWidth, height: dims.height });
  }
  source = source.resize({ width, height, quality: 'best' });
  const pixels = source.toBitmap();
  for (let yy = 0; yy < height; yy++) pixels.copy(frame.data, ((y + yy) * frame.width + x) * 4, yy * width * 4, (yy + 1) * width * 4);
}
function measure(name, frame, bank, settings = {}) {
  const start = performance.now();
  const result = analyzeScreen(frame, { minimapRect: mapRect, rosterRects: [], ...settings }, bank);
  return { name, milliseconds: Math.round((performance.now() - start) * 10) / 10, fullComparisons: result.diagnostics.fullComparisons, templateCount: result.diagnostics.templateCount, heroes: result.minimap.heroes.map((h) => ({ id: h.id, name: h.name, confidence: Math.round(h.confidence * 1000) / 1000, x: h.x, y: h.y })), roster: result.roster.slots.map((s) => ({ index: s.index, hero: s.hero, bestSimilarity: s.bestSimilarity })), uncertainColorMarkers: result.minimap.uncertainMarkers.length };
}

app.whenReady().then(() => {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    const fixturesPath = path.join(root, 'dota2-vis-test');
    const fixtures = JSON.parse(fs.readFileSync(path.join(fixturesPath, 'manifest.json'), 'utf8'));
    const bank = { minimap: manifest.minimap.map((entry) => ({ id: entry.heroId, name: entry.localizedName || entry.name, ...decode(path.join(root, entry.file)) })), portraits: manifest.portraits.map((entry) => ({ id: entry.heroId, name: entry.localizedName || entry.name, ...decode(path.join(root, entry.file)) })) };
    const results = [];
    for (const sample of fixtures.samples) results.push(measure(sample.image, frameFromMap(decode(path.join(fixturesPath, sample.image), 276)), bank));
    const blank = { width: 276, height: 276, data: Buffer.alloc(276 * 276 * 4, 18) };
    for (let p = 3; p < blank.data.length; p += 4) blank.data[p] = 255;
    const controlled = frameFromMap(blank);
    pasteIcon(controlled, 42, 35, 47, manifest.minimap);
    pasteIcon(controlled, 1, 155, 169, manifest.minimap);
    const exactScores = [42, 1].map((id, i) => {
      const target = debug.prepareTemplate(bank.minimap.find((t) => Number(t.id) === id), 12, 12, null, 22);
      const actual = debug.sampleRect(controlled, { x: mapRect.x + (i ? 155 : 35), y: mapRect.y + (i ? 169 : 47), width: 22, height: 22 }, 12, 12);
      const neighbors = [-2, -1, 0, 1, 2].map((dx) => {
        const a = debug.sampleRect(controlled, { x: mapRect.x + (i ? 155 : 35) + dx, y: mapRect.y + (i ? 169 : 47) + dx, width: 22, height: 22 }, 12, 12);
        return { dx, ...debug.comparePixels(a, target), anchorDistance: target.anchors.reduce((sum, p) => sum + Math.abs(a[p] - target.pixels[p]) + Math.abs(a[p + 1] - target.pixels[p + 1]) + Math.abs(a[p + 2] - target.pixels[p + 2]), 0) / target.anchors.length / 3 / 255 };
      });
      return { id, ...debug.comparePixels(actual, target), neighbors };
    });
    const controlResult = measure('controlled-real-Valve-icons-at-22px', controlled, bank);
    results.push(controlResult);
    assert.deepEqual(controlResult.heroes.map((h) => h.id).sort((a, b) => a - b), [1, 42], 'Real Valve icons should both be detected, without extra identities');
    assert.ok(controlResult.heroes.every((h) => h.confidence > 0.95));
    const restrictedResult = measure('controlled-restricted-10-heroes', controlled, bank, { enemyHeroIds: [1, 2, 3, 4, 5], allyHeroIds: [42, 8, 9, 10, 11] });
    results.push(restrictedResult);
    assert.deepEqual(restrictedResult.heroes.map((h) => h.id).sort((a, b) => a - b), [1, 42]);
    const duplicate = { ...bank.minimap.find((h) => h.id === 42), id: 999, name: 'Deliberately identical test template' };
    const ambiguousResult = measure('controlled-identical-WK-template-ambiguity', controlled, { minimap: [...bank.minimap, duplicate] });
    results.push(ambiguousResult);
    assert.deepEqual(ambiguousResult.heroes.map((h) => h.id), [1], 'Identical WK templates should cause abstention while AM remains recognized');
    const portraitFrame = frameFromMap(blank);
    pastePortrait(portraitFrame, 42, 680, 8, 47, 32, manifest.portraits);
    pastePortrait(portraitFrame, 1, 1100, 8, 44, 28, manifest.portraits, true);
    const portraitRects = [{ x: 680, y: 8, width: 47, height: 32, units: 'px', team: 'radiant' }, { x: 1100, y: 8, width: 44, height: 28, units: 'px', team: 'dire' }];
    const portraitResult = measure('controlled-real-Valve-portraits-stretched47x32-cropped44x28', portraitFrame, { portraits: bank.portraits }, { rosterRects: portraitRects });
    results.push(portraitResult);
    assert.deepEqual(portraitResult.roster.map((s) => s.hero?.id), [42, 1], JSON.stringify(portraitResult.roster));
    const duplicatePortrait = { ...bank.portraits.find((h) => h.id === 42), id: 999 };
    const ambiguousPortrait = measure('controlled-identical-WK-portrait-ambiguity', portraitFrame, { portraits: [...bank.portraits, duplicatePortrait] }, { rosterRects: portraitRects });
    results.push(ambiguousPortrait);
    assert.deepEqual(ambiguousPortrait.roster.map((s) => s.hero?.id || null), [null, 1]);
    const report = JSON.stringify({ regressionAssertions: 'passed', results, exactScores, caveat: 'Dota2-Vis annotations contain player colors/clones, not hero IDs; these measurements do not establish hero recognition accuracy.' }, null, 2);
    fs.writeFileSync(path.join(__dirname, 'vision-fixtures-results.json'), report);
    console.log(report);
    app.exit(0);
  } catch (error) { fs.writeFileSync(path.join(__dirname, 'vision-fixtures-results.json'), JSON.stringify({ error: error.stack })); console.error(error.stack); app.exit(1); }
});
