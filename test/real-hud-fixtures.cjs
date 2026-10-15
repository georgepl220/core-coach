'use strict';
// Offline Electron regression: only the two HUD crops retained from a user's
// real screenshot. The game world/account information is not stored or shipped.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, nativeImage, BrowserWindow } = require('electron');
const { defaultCalibration, resolveRect } = require('../src/vision.cjs');
const { analyzeRegions } = require('../src/vision-regions.cjs');
const ROOT = path.resolve(__dirname, '..');
const expected = [42, 26, 20, 22, 6, 37, 18, 7, 43, 30];
app.whenReady().then(async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/assets/manifest.json'), 'utf8'));
  const templates = { portraits: [], minimap: [] };
  for (const kind of Object.keys(templates)) for (const entry of manifest[kind]) {
    const image = nativeImage.createFromPath(path.join(ROOT, 'data/assets', entry.file));
    assert.equal(image.isEmpty(), false, entry.file);
    templates[kind].push({ id: entry.heroId, name: entry.localizedName, ...image.getSize(), data: image.toBitmap() });
  }
  const width = 1919, height = 1079;
  const pixels = Buffer.alloc(width * height * 4, 18);
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  for (const fixture of [{ file: 'wk-hud-strip.png', x: 518, y: 0 }, { file: 'wk-minimap.png', x: 8, y: 843 }]) {
    const image = nativeImage.createFromPath(path.join(__dirname, 'fixtures', fixture.file));
    assert.equal(image.isEmpty(), false, fixture.file);
    const size = image.getSize(), data = image.toBitmap();
    for (let row = 0; row < size.height; row++) data.copy(pixels, ((fixture.y + row) * width + fixture.x) * 4, row * size.width * 4, (row + 1) * size.width * 4);
  }
  const native = nativeImage.createFromBitmap(pixels, { width, height });
  const browser = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
  await browser.loadURL('about:blank');
  const chromiumRgba = await browser.webContents.executeJavaScript(`(async()=>{
    const image=new Image();image.src=${JSON.stringify(native.toDataURL())};await image.decode();
    const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;
    const context=canvas.getContext('2d',{alpha:false});context.drawImage(image,0,0,1280,720);
    return Buffer.from(context.getImageData(0,0,1280,720).data).toString('base64');
  })()`);
  browser.destroy();
  const chromiumPixels = Buffer.from(chromiumRgba, 'base64');
  for (let offset = 0; offset < chromiumPixels.length; offset += 4) { const red = chromiumPixels[offset]; chromiumPixels[offset] = chromiumPixels[offset + 2]; chromiumPixels[offset + 2] = red; }
  const chromium = nativeImage.createFromBitmap(chromiumPixels, { width: 1280, height: 720 });
  const report = [];
  for (const [rendering, image] of [['native',native],['area-downsample',native.resize({ width: 1280, height: 720, quality: 'best' })],['chromium-canvas',chromium]]) {
    const size = image.getSize(), defaults = defaultCalibration(size.width, size.height);
    const packet = { timestamp: 100000, originalSize: size, regions: [] };
    function region(kind, definition, index) {
      const rect = resolveRect(definition, size.width, size.height);
      const crop = image.crop(rect);
      const factor = kind === 'minimap' ? Math.min(1, 352 / rect.width, 352 / rect.height) : Math.min(1, 64 / rect.width, 48 / rect.height);
      const bitmap = crop.resize({ width: Math.round(rect.width * factor), height: Math.round(rect.height * factor), quality: 'best' });
      return { kind, rect, index, team: definition.team, ...bitmap.getSize(), data: bitmap.toBitmap() };
    }
    packet.regions.push(region('minimap', defaults.minimapRect));
    defaults.rosterRects.forEach((definition, index) => packet.regions.push(region('roster', definition, index)));
    const elapsed = [], settings = { playerTeam: 'radiant', selfHeroId: 42 };
    let result;
    for (let i = 0; i < 4; i++) {
      const start = performance.now();
      result = analyzeRegions(packet, settings, templates);
      elapsed.push(Math.round((performance.now() - start) * 10) / 10);
      assert.deepEqual(result.roster.slots.map(slot => slot.hero?.id), expected);
      assert.ok(result.roster.slots.every(slot => slot.hero.confidence >= 0.90 && slot.hero.margin >= 0.035));
    }
    assert.equal(result.state.roster.slots.length, 10);
    const mapOnly = { ...packet, timestamp: 110000, regions: packet.regions.filter(region => region.kind === 'minimap') };
    const retained = analyzeRegions(mapOnly, settings, templates, result.state);
    assert.deepEqual(retained.roster.slots.map(slot => slot.hero?.id), expected);
    assert.equal(retained.diagnostics.rosterRefreshed, false);
    assert.equal(retained.diagnostics.templateCount, 10);
    report.push({ rendering, size, ids: expected, similarities: result.roster.slots.map(slot => Math.round(slot.hero.confidence * 1000) / 1000), elapsedMs: elapsed, minimap: result.minimap.heroes.map(hero => ({ id: hero.id, similarity: hero.confidence })) });
  }
  const filename = path.join(ROOT, 'artifacts/real-hud-fixtures-results.json');
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, report }, null, 2));
  app.exit(0);
}).catch(error => { console.error(error.stack); app.exit(1); });
