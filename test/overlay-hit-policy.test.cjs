'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeHitAreas, normalizeHitAreasForZoom, overlayPointerPolicy } = require('../src/overlay-hit-policy.cjs');

const size = { width: 340, height: 600 };
const bounds = { x: 1200, y: -80, ...size };
const portrait = { x: 16, y: 95, width: 56, height: 56 };
const at = (x, y, extra = {}) => overlayPointerPolicy({
  cursor: { x: bounds.x + x, y: bounds.y + y }, bounds,
  areas: [portrait], visible: true, editing: false, ...extra,
});

test('only small declared overlay controls accept the pointer without taking focus', () => {
  assert.deepEqual(at(20, 100), { interactive: true, focusable: false });
  assert.deepEqual(at(180, 250), { interactive: false, focusable: false });
});

test('hit areas preserve fractional DIP coordinates and do not mutate renderer data', () => {
  const input = [{ x: 3.5, y: 8.25, width: 40.75, height: 42.5 }];
  assert.deepEqual(normalizeHitAreas(input, size), input);
  assert.notEqual(normalizeHitAreas(input, size)[0], input[0]);
  assert.deepEqual(input, [{ x: 3.5, y: 8.25, width: 40.75, height: 42.5 }]);
});

test('negative monitor origin and different display scaling use the same DIP space', () => {
  assert.deepEqual(at(20, 100, { bounds: { ...bounds, x: -340 }, cursor: { x: -320, y: 20 } }), { interactive: true, focusable: false });
});

test('left and top edges are included while right and bottom edges pass to the game', () => {
  assert.equal(at(16, 95).interactive, true);
  assert.equal(at(71.999, 150.999).interactive, true);
  for (const [x, y] of [[72, 100], [20, 151], [15.999, 100], [20, 94.999]]) assert.equal(at(x, y).interactive, false);
});

test('cursor outside the overlay and invalid cursor/window values are never interactive', () => {
  for (const [x, y] of [[-1, 100], [341, 100], [20, -1], [20, 601]]) assert.equal(at(x, y).interactive, false);
  for (const cursor of [null, {}, { x: NaN, y: 0 }, { x: 0, y: Infinity }, { x: '20', y: 100 }]) {
    assert.deepEqual(at(20, 100, { cursor }), { interactive: false, focusable: false });
  }
  for (const invalid of [null, {}, { ...bounds, x: NaN }, { ...bounds, height: 0 }, { ...bounds, width: Infinity }]) {
    assert.deepEqual(at(20, 100, { bounds: invalid }), { interactive: false, focusable: false });
  }
});

test('hidden windows stay passive even if an editing flag was left behind', () => {
  assert.deepEqual(at(20, 100, { visible: false }), { interactive: false, focusable: false });
  assert.deepEqual(at(20, 100, { visible: false, editing: true }), { interactive: false, focusable: false });
});

test('visible move mode is the explicit exception that accepts input and focus', () => {
  assert.deepEqual(at(200, 300, { editing: true }), { interactive: true, focusable: true });
  assert.deepEqual(at(200, 300, { editing: 'true' }), { interactive: false, focusable: false });
});

test('three portraits and an inline picker fit the bounded interaction budget', () => {
  const areas = [portrait, { ...portrait, x: 88 }, { ...portrait, x: 160 }, { x: 20, y: 200, width: 300, height: 260 }];
  assert.deepEqual(normalizeHitAreas(areas, size), areas);
  assert.equal(at(25, 220, { areas }).interactive, true);
  assert.equal(at(10, 220, { areas }).interactive, false);
});

test('malformed dimensions, outside edges and unknown rectangle fields reject the complete update', () => {
  const patches = [
    { x: NaN }, { x: Infinity }, { y: -1 }, { x: -0.01 },
    { width: 0 }, { height: -2 }, { width: '56' }, { height: null },
    { x: 300 }, { y: 580 }, { ignored: true }, { width: 341 }, { height: 601 },
  ];
  for (const patch of patches) assert.deepEqual(normalizeHitAreas([portrait, { ...portrait, ...patch }], size), []);
  for (const value of [null, {}, 'rect', [null], [[]], [{ x: 1, y: 1, width: 5 }]]) assert.deepEqual(normalizeHitAreas(value, size), []);
});

test('full-window and oversized rectangles cannot consume the game input surface', () => {
  assert.deepEqual(normalizeHitAreas([{ x: 0, y: 0, ...size }], size), []);
  assert.deepEqual(normalizeHitAreas([{ x: 0, y: 0, width: 200, height: 200 }], { width: 200, height: 200 }), []);
  assert.deepEqual(normalizeHitAreas([{ x: 10, y: 10, width: 300, height: 301 }], size), []);
  assert.deepEqual(normalizeHitAreas([{ x: 0, y: 0, width: 400, height: 100 }], { width: 1000, height: 1000 }), []);
  assert.deepEqual(normalizeHitAreas([{ x: 0, y: 0, width: 100, height: 601 }], { width: 1000, height: 1000 }), []);
});

test('duplicates and excess interaction surfaces fail closed', () => {
  assert.deepEqual(normalizeHitAreas([portrait, { ...portrait }], size), []);
  const tooMany = Array.from({ length: 9 }, (_, index) => ({ x: 1 + index * 12, y: 1, width: 10, height: 10 }));
  assert.deepEqual(normalizeHitAreas(tooMany, size), []);
  assert.equal(normalizeHitAreas(tooMany.slice(0, 8), size).length, 8);
  assert.deepEqual(normalizeHitAreas([{ x: 1, y: 1, width: 300, height: 260 }, { x: 1, y: 300, width: 300, height: 50 }], size), []);
});

test('invalid viewport sizes and malformed policies leave mouse events with the game', () => {
  for (const viewport of [null, {}, { width: 0, height: 600 }, { width: 340, height: NaN }, { width: '340', height: 600 }]) {
    assert.deepEqual(normalizeHitAreas([portrait], viewport), []);
  }
  assert.deepEqual(overlayPointerPolicy(), { interactive: false, focusable: false });
  assert.deepEqual(at(20, 100, { areas: [portrait, { ...portrait, x: -1 }] }), { interactive: false, focusable: false });
});

test('browser zoom converts CSS areas to DIP before applying native size limits', () => {
  const native = { x: 16, y: 200, width: 290, height: 245 };
  for (const zoom of [0.8, 1.25]) {
    const css = Object.fromEntries(Object.entries(native).map(([key, value]) => [key, value / zoom]));
    assert.deepEqual(normalizeHitAreasForZoom([css], size, zoom), [native]);
    assert.equal(at(20, 220, { areas: normalizeHitAreasForZoom([css], size, zoom) }).interactive, true);
    assert.equal(at(308, 220, { areas: normalizeHitAreasForZoom([css], size, zoom) }).interactive, false);
  }
  assert.deepEqual(normalizeHitAreasForZoom([native], size), [native]);
});

test('zoom conversion rejects malformed raw coordinates without coercing strings or dropping extra fields', () => {
  for (const patch of [{ x: '16' }, { width: '290' }, { y: NaN }, { height: Infinity }, { width: -20 }, { extra: true }]) {
    assert.deepEqual(normalizeHitAreasForZoom([portrait, { x: 16, y: 200, width: 290, height: 245, ...patch }], size, 0.8), []);
  }
  const extraHidden = { ...portrait };
  Object.defineProperty(extraHidden, 'extra', { value: true, enumerable: false });
  assert.deepEqual(normalizeHitAreasForZoom([extraHidden], size, 0.8), []);
  const extraSymbol = { ...portrait, [Symbol('extra')]: true };
  assert.deepEqual(normalizeHitAreasForZoom([extraSymbol], size, 0.8), []);
  for (const value of [null, {}, 'rect', [null], [[]], [{ x: 0, y: 0, width: 5 }], Array(9).fill(portrait)]) {
    assert.deepEqual(normalizeHitAreasForZoom(value, size, 0.8), []);
  }
});

test('invalid zoom factors always fail closed', () => {
  for (const zoom of [NaN, Infinity, 0, -1, null, '0.8', false]) {
    assert.deepEqual(normalizeHitAreasForZoom([portrait], size, zoom), []);
  }
});

test('zoom conversion retains native full-window, edge, duplicate and interaction budget safeguards', () => {
  for (const zoom of [0.8, 1.25]) {
    const css = (rect) => Object.fromEntries(Object.entries(rect).map(([key, value]) => [key, value / zoom]));
    const smallBounds = { width: 200, height: 200 };
    assert.deepEqual(normalizeHitAreasForZoom([css({ x: 0, y: 0, ...smallBounds })], smallBounds, zoom), []);
    assert.deepEqual(normalizeHitAreasForZoom([css({ x: 60, y: 200, width: 290, height: 245 })], size, zoom), []);
    assert.deepEqual(normalizeHitAreasForZoom([css(portrait), css(portrait)], size, zoom), []);
    assert.deepEqual(normalizeHitAreasForZoom([css({ x: 1, y: 1, width: 300, height: 260 }), css({ x: 1, y: 300, width: 300, height: 50 })], size, zoom), []);
  }
  assert.deepEqual(normalizeHitAreasForZoom([{ x: 0, y: 0, width: Number.MAX_VALUE, height: 1 }], size, 1.25), []);
});

test('separate draft surfaces permit a wider picker without relaxing the side coach limits', () => {
  const draftSize = { width: 900, height: 620 };
  const panel = { x: 20, y: 80, width: 860, height: 280 };
  assert.deepEqual(normalizeHitAreas([panel], draftSize), []);
  assert.deepEqual(normalizeHitAreas([panel], draftSize, { surface: 'coach' }), []);
  assert.deepEqual(normalizeHitAreas([panel], draftSize, { surface: 'draft' }), [panel]);
  const draftBounds = { ...draftSize, x: 100, y: 200 };
  assert.deepEqual(overlayPointerPolicy({ bounds: draftBounds, cursor: { x: 130, y: 300 }, areas: [panel], visible: true, surface: 'draft' }), { interactive: true, focusable: false });
  assert.deepEqual(overlayPointerPolicy({ bounds: draftBounds, cursor: { x: 110, y: 300 }, areas: [panel], visible: true, surface: 'draft' }), { interactive: false, focusable: false });
});

test('draft windows retain full-window shape count edge and combined area safeguards', () => {
  const draftSize = { width: 900, height: 620 };
  const options = { surface: 'draft' };
  for (const value of [
    [{ x: 0, y: 0, ...draftSize }],
    [{ x: 0, y: 0, width: 900, height: 467 }],
    [{ x: 0, y: 0, width: 901, height: 10 }],
    [{ x: 0, y: 0, width: 10, height: 621 }],
    [{ x: 0, y: 0, width: 700, height: 300 }, { x: 0, y: 310, width: 701, height: 300 }],
    [{ x: 800, y: 10, width: 101, height: 10 }],
    [{ x: 1, y: -1, width: 10, height: 10 }],
    [{ x: 1, y: 1, width: 10, height: 10, extra: true }],
    Array.from({ length: 9 }, (_, index) => ({ x: 1 + index * 12, y: 1, width: 10, height: 10 })),
  ]) assert.deepEqual(normalizeHitAreas(value, draftSize, options), []);
  assert.deepEqual(normalizeHitAreas([{ x: 0, y: 0, width: 200, height: 200 }], { width: 200, height: 200 }, options), []);
});

test('draft hit areas apply their larger native DIP budget after browser zoom conversion', () => {
  const draftSize = { width: 900, height: 620 };
  const native = { x: 20, y: 80, width: 860, height: 280 };
  for (const zoom of [0.8, 1.25]) {
    const css = Object.fromEntries(Object.entries(native).map(([key, value]) => [key, value / zoom]));
    assert.deepEqual(normalizeHitAreasForZoom([css], draftSize, zoom, { surface: 'draft' }), [native]);
    assert.deepEqual(normalizeHitAreasForZoom([css], draftSize, zoom), []);
    assert.deepEqual(normalizeHitAreasForZoom([{ ...css, extra: true }], draftSize, zoom, { surface: 'draft' }), []);
  }
});

test('explicit visible draft search accepts keyboard focus while retaining only declared mouse areas', () => {
  const draftBounds = { width: 900, height: 620, x: -900, y: 100 };
  const areas = [{ x: 20, y: 80, width: 860, height: 280 }];
  const input = { bounds: draftBounds, areas, visible: true, surface: 'draft', searching: true };
  assert.deepEqual(overlayPointerPolicy({ ...input, cursor: { x: -870, y: 200 } }), { interactive: true, focusable: true });
  assert.deepEqual(overlayPointerPolicy({ ...input, cursor: { x: -890, y: 200 } }), { interactive: false, focusable: true });
  assert.deepEqual(overlayPointerPolicy({ ...input, cursor: { x: 1000, y: 200 } }), { interactive: false, focusable: true });
  assert.deepEqual(overlayPointerPolicy({ ...input, cursor: { x: -870, y: 200 }, searching: 'true' }), { interactive: true, focusable: false });
  assert.deepEqual(at(20, 100, { searching: true }), { interactive: true, focusable: false });
});

test('hidden and malformed search policies cannot gain mouse or keyboard focus', () => {
  const draftBounds = { width: 900, height: 620, x: 100, y: 100 };
  const input = { bounds: draftBounds, cursor: { x: 140, y: 200 }, areas: [{ x: 20, y: 80, width: 860, height: 280 }], visible: true, surface: 'draft', searching: true };
  for (const patch of [
    { visible: false }, { visible: false, editing: true }, { cursor: null },
    { bounds: { ...draftBounds, x: NaN } }, { areas: [] },
    { areas: [{ x: 0, y: 0, width: 900, height: 620 }] },
  ]) assert.deepEqual(overlayPointerPolicy({ ...input, ...patch }), { interactive: false, focusable: false });
});
