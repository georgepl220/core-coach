'use strict';

const MAX_AREAS = 8;
const COACH_LIMITS = Object.freeze({ width: 380, height: 600, area: 90000 });
const DRAFT_LIMITS = Object.freeze({ width: 900, height: 620, area: 420000 });
const RECT_KEYS = ['x', 'y', 'width', 'height'];

function validSize(value) {
  return value && Number.isFinite(value.width) && value.width > 0 &&
    Number.isFinite(value.height) && value.height > 0;
}

function validRectShape(rect) {
  return rect && typeof rect === 'object' && !Array.isArray(rect) &&
    Reflect.ownKeys(rect).length === RECT_KEYS.length &&
    RECT_KEYS.every((key) => Object.hasOwn(rect, key) &&
      typeof rect[key] === 'number' && Number.isFinite(rect[key]));
}

// Normalized rectangles and Electron cursor/window coordinates are all DIP.
// Reject the entire update if it is malformed, leaving the game clickable.
function normalizeHitAreas(value, size, options = {}) {
  if (!validSize(size) || !Array.isArray(value) || value.length > MAX_AREAS) return [];
  const limits = options?.surface === 'draft' ? DRAFT_LIMITS : COACH_LIMITS;
  const areas = [];
  const seen = new Set();
  let combinedArea = 0;
  for (const rect of value) {
    if (!validRectShape(rect)) return [];
    const { x, y, width, height } = rect;
    const area = width * height;
    if (x < 0 || y < 0 || width <= 0 || height <= 0 ||
      width > limits.width || height > limits.height || area > limits.area ||
      x + width > size.width || y + height > size.height ||
      (x === 0 && y === 0 && width === size.width && height === size.height)) return [];
    const key = [x, y, width, height].join(':');
    if (seen.has(key)) return [];
    seen.add(key);
    combinedArea += area;
    if (combinedArea > limits.area) return [];
    areas.push({ x, y, width, height });
  }
  return areas;
}

// Browser zoom scales DOM CSS pixels. Validate their shape before conversion,
// then apply geometry and interaction limits to the native DIP rectangles.
function normalizeHitAreasForZoom(value, bounds, zoomFactor = 1, options = {}) {
  if (!Array.isArray(value) || value.length > MAX_AREAS ||
    typeof zoomFactor !== 'number' || !Number.isFinite(zoomFactor) || zoomFactor <= 0 ||
    !value.every(validRectShape)) return [];
  const areas = value.map(({ x, y, width, height }) => ({
    x: x * zoomFactor, y: y * zoomFactor,
    width: width * zoomFactor, height: height * zoomFactor,
  }));
  return normalizeHitAreas(areas, bounds, options);
}

function overlayPointerPolicy({ cursor, bounds, areas, visible, editing, searching, surface } = {}) {
  if (!visible) return { interactive: false, focusable: false };
  if (editing === true) return { interactive: true, focusable: true };
  if (!validSize(bounds) || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) ||
    !cursor || !Number.isFinite(cursor.x) || !Number.isFinite(cursor.y)) {
    return { interactive: false, focusable: false };
  }
  const x = cursor.x - bounds.x;
  const y = cursor.y - bounds.y;
  const validAreas = normalizeHitAreas(areas, bounds, { surface });
  const interactive = validAreas.some((rect) =>
    x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height);
  // Main only sets searching after explicit input in the draft renderer. Keep
  // keyboard focus available until search closes, without expanding hit areas.
  const focusable = surface === 'draft' && searching === true && validAreas.length > 0;
  return { interactive, focusable };
}

module.exports = { normalizeHitAreas, normalizeHitAreasForZoom, overlayPointerPolicy };
