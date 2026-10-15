'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyzeScreen, defaultCalibration, resolveRect, validateFrame } = require('../src/vision.cjs');

function image(width, height, color = [18, 18, 18, 255]) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = color[2]; data[i + 1] = color[1]; data[i + 2] = color[0]; data[i + 3] = color[3]; }
  return { width, height, data };
}
function putPixel(frame, x, y, r, g, b, a = 255) {
  const p = (y * frame.width + x) * 4;
  frame.data[p] = b; frame.data[p + 1] = g; frame.data[p + 2] = r; frame.data[p + 3] = a;
}
function rectangle(frame, x, y, width, height, color) {
  for (let yy = y; yy < y + height; yy++) for (let xx = x; xx < x + width; xx++) putPixel(frame, xx, yy, ...color);
}
function template(id, variant = false, transparent = false, width = 24, height = 24) {
  const out = { ...image(width, height), id, name: `Hero ${id}` };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const side = variant ? width - x - 1 : x;
    const alpha = transparent && (x < 3 || y < 3 || x >= width - 3 || y >= height - 3) ? 0 : 255;
    const r = 35 + Math.round(side / width * 170);
    const g = 25 + Math.round(y / height * 150);
    const b = x > width / 2 && y < height / 2 ? 210 : 30 + Math.round((x + y) / (width + height) * 70);
    putPixel(out, x, y, r, g, b, alpha);
  }
  return out;
}
function paste(frame, t, x, y, width = t.width, height = t.height) {
  for (let yy = 0; yy < height; yy++) for (let xx = 0; xx < width; xx++) {
    const tx = Math.floor((xx + 0.5) * t.width / width); const ty = Math.floor((yy + 0.5) * t.height / height);
    const p = (ty * t.width + tx) * 4;
    if (t.data[p + 3] >= 160) putPixel(frame, x + xx, y + yy, t.data[p + 2], t.data[p + 1], t.data[p], 255);
  }
}
const mapSettings = { minimapRect: { x: 0, y: 20, width: 100, height: 80, units: 'px' }, rosterRects: [], minimapHeroSizePx: 22 };

test('invalid and incomplete frames return an explicit unusable result', () => {
  assert.match(validateFrame({ width: 100, height: 100, data: Buffer.alloc(2) }), /Incomplete/);
  const result = analyzeScreen({ width: 100, height: 100, data: Buffer.alloc(2) });
  assert.equal(result.quality.usable, false);
  assert.deepEqual(result.minimap.heroes, []);
  assert.equal(result.minimap.enemyCount, null);
});

test('black capture is rejected instead of generating fabricated observations', () => {
  const result = analyzeScreen(image(100, 100, [0, 0, 0, 255]), mapSettings);
  assert.equal(result.quality.usable, false);
  assert.match(result.quality.reason, /black/);
});

test('calibration clips safely and reports invalid or cropped minimaps', () => {
  assert.equal(resolveRect({ x: 120, y: 0, width: 20, height: 20, units: 'px' }, 100, 100), null);
  assert.equal(resolveRect({ x: 0, y: 0, width: -1, height: 1 }, 100, 100), null);
  const cropped = resolveRect({ x: -5, y: 0, width: 20, height: 20, units: 'px' }, 100, 100);
  assert.equal(cropped.clipped, true);
  assert.equal(cropped.width, 15);
  const result = analyzeScreen(image(100, 100), { ...mapSettings, minimapRect: { x: -5, y: 0, width: 60, height: 60, units: 'px' } });
  assert.equal(result.minimap.heroes.length, 0);
  assert.ok(result.diagnostics.warnings.some((s) => /cropped/.test(s)));
});

test('default HUD calibration remains edge-anchored across aspect ratios', () => {
  const wide = defaultCalibration(2560, 1080);
  const normal = defaultCalibration(1920, 1080);
  assert.equal(resolveRect(wide.minimapRect, 2560, 1080).width, resolveRect(normal.minimapRect, 1920, 1080).width);
  const right = resolveRect(defaultCalibration(1920, 1080, true).minimapRect, 1920, 1080);
  assert.ok(right.x > 1500);
  assert.equal(normal.rosterRects.length, 10);
  assert.deepEqual(resolveRect(normal.rosterRects[0],1920,1080),{x:548,y:4,width:58,height:36,clipped:false});
  assert.deepEqual(resolveRect(normal.rosterRects[5],1920,1080),{x:1068,y:4,width:58,height:36,clipped:false});
  assert.deepEqual(resolveRect(normal.minimapRect,1920,1080),{x:8,y:844,width:228,height:236,clipped:false});
});

test('a partially known draft does not exclude an unrecognized hero from minimap matching', () => {
  const frame=image(100,100),t=template(99,false,true);
  paste(frame,t,35,45,22,22);
  const result=analyzeScreen(frame,{...mapSettings,enemyHeroIds:[1,2,3,4,5]},{minimap:[t]});
  assert.equal(result.minimap.heroes.length,1);
  assert.equal(result.minimap.heroes[0].id,99);
  assert.equal(result.minimap.heroes[0].team,'unknown');
});

test('creep-size red dots and structures never become enemy hero observations', () => {
  const frame = image(100, 100);
  rectangle(frame, 10, 35, 3, 3, [245, 25, 25]);
  rectangle(frame, 30, 35, 30, 25, [245, 25, 25]);
  rectangle(frame, 70, 65, 7, 7, [245, 25, 25]);
  const result = analyzeScreen(frame, { ...mapSettings, playerTeam: 'radiant' }, { minimap: [template(42, false, true), template(1, true, true)] });
  assert.equal(result.minimap.heroes.length, 0);
  assert.equal(result.minimap.enemyCount, 0);
  assert.equal(result.minimap.uncertainMarkers.length, 1);
  assert.equal(result.minimap.uncertainMarkers[0].type, 'unclassified_color_marker');
  assert.equal(result.minimap.uncertainMarkers[0].confidence, null);
});

test('a portrait match requires both similarity and a distinct runner-up', () => {
  const frame = image(100, 100);
  const t = template(42, false, false, 30, 20);
  paste(frame, t, 10, 0);
  const settings = { ...mapSettings, rosterRects: [{ x: 10, y: 0, width: 30, height: 20, units: 'px', team: 'radiant' }] };
  const result = analyzeScreen(frame, settings, { portraits: [t, template(1, true, false, 30, 20)] });
  assert.equal(result.roster.slots[0].hero.id, 42);
  assert.ok(result.roster.slots[0].hero.confidence > 0.99);
  const ambiguous = analyzeScreen(frame, settings, { portraits: [t, { ...t, id: 99 }] });
  assert.equal(ambiguous.roster.slots[0].hero, null);
  assert.match(ambiguous.roster.slots[0].reason, /uncertain/);
});

test('transparent minimap hero icon is identified, with unknown team unless supplied', () => {
  const frame = image(100, 100);
  const t = template(42, false, true);
  paste(frame, t, 35, 45, 22, 22);
  const result = analyzeScreen(frame, mapSettings, { minimap: [t, template(1, true, true)] });
  assert.equal(result.minimap.heroes.length, 1);
  assert.equal(result.minimap.heroes[0].id, 42);
  assert.equal(result.minimap.heroes[0].team, 'unknown');
  // Screenshot resizing and the source icon use different nearest-neighbor grids.
  assert.ok(result.minimap.heroes[0].confidence > 0.90, JSON.stringify(result.minimap.heroes));
  assert.equal(result.minimap.enemyCount, null);
  assert.ok(result.minimap.heroes[0].x > 0.44 && result.minimap.heroes[0].x < 0.48);
});

test('last-seen history preserves observations without inventing current visibility', () => {
  const t = template(42, false, true);
  const frame = image(100, 100); frame.timestamp = 10000;
  paste(frame, t, 35, 45, 22, 22);
  const settings = { ...mapSettings, enemyHeroIds: [42] };
  const first = analyzeScreen(frame, settings, { minimap: [t] });
  assert.equal(first.minimap.enemyCount, 1);
  const blank = image(100, 100); blank.timestamp = 12000;
  const next = analyzeScreen(blank, settings, { minimap: [t] }, first);
  assert.equal(next.minimap.heroes.length, 0);
  assert.equal(next.minimap.lastSeenHeroes[0].currentlyVisible, false);
  assert.equal(next.minimap.lastSeenHeroes[0].ageMs, 2000);
  assert.equal(next.minimap.lastSeenHeroes[0].x, first.minimap.heroes[0].x);
});

test('identical minimap templates are not assigned a hero identity', () => {
  const frame = image(100, 100); const t = template(42, false, true);
  paste(frame, t, 35, 45, 22, 22);
  const result = analyzeScreen(frame, mapSettings, { minimap: [t, { ...t, id: 99 }] });
  assert.equal(result.minimap.heroes.length, 0);
});
