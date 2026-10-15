'use strict';

// Keep discovery cheap and never silently broaden Dota capture to the desktop.
const DISCOVERY_INTERVAL_MS = 15000;
const MAX_FRAME_BYTES = 700000;
const MIN_FRAME_INTERVAL_MS = 2000;
const MAX_MAP_EDGE = 352;
const MAX_PORTRAIT_WIDTH = 64;
const MAX_PORTRAIT_HEIGHT = 48;
const MAX_DRAFT_BYTES = 120000;

function normalizeCaptureConfig(value = {}) {
  const requestedInterval = Number(value.intervalMs);
  return {
    enabled: value.enabled === true,
    sourceMode: value.sourceMode === 'monitor' ? 'monitor' : 'dota',
    monitorId: value.monitorId === undefined || value.monitorId === null ? null : String(value.monitorId),
    intervalMs: Number.isFinite(requestedInterval) ? Math.min(15000, Math.max(MIN_FRAME_INTERVAL_MS, Math.round(requestedInterval))) : 2500,
    rosterConfirmed: value.rosterConfirmed === true,
    capturePhase: value.capturePhase === 'draft' || value.drafting === true ? 'draft' : 'game',
    calibration: value.calibration && typeof value.calibration === 'object' ? value.calibration : {},
  };
}

function isDotaWindow(source) {
  return !!source && String(source.id || '').startsWith('window:') && /^dota\s*2(?:\s*(?:-\s*)?(?:vulkan|directx(?:\s*\d+)?|dx\d+))?$/i.test(String(source.name || '').trim());
}

function selectCaptureSource(sources, config, primaryDisplayId) {
  if (!config.enabled || !Array.isArray(sources)) return null;
  if (config.sourceMode !== 'monitor') return sources.find(isDotaWindow) || null;
  const screens = sources.filter((source) => String(source.id || '').startsWith('screen:'));
  const target = config.monitorId ?? (primaryDisplayId === undefined ? null : String(primaryDisplayId));
  if (target !== null) return screens.find((source) => String(source.display_id) === target || source.id === target) || null;
  return screens[0] || null;
}

function validateRegionFrame(frame) {
  if (!frame || typeof frame !== 'object') return 'Missing capture packet';
  if (frame.capturePhase !== undefined && !['draft', 'game'].includes(frame.capturePhase)) return 'Invalid capture phase';
  const draft = frame.capturePhase === 'draft';
  const size = frame.originalSize;
  if (!size || !Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width < 8 || size.height < 8 || size.width > 16384 || size.height > 16384) return 'Invalid source dimensions';
  if (!Array.isArray(frame.regions) || frame.regions.length < 1 || frame.regions.length > 22) return 'Invalid region count';
  let bytes = 0; let maps = 0;let labels=0;
  const slots = new Set();
  const sceneSlots = new Set();
  for (const region of frame.regions) {
    if (!region || !['minimap', 'roster', 'scene', 'selected_hero_label'].includes(region.kind)) return 'Unknown capture region';
    if (draft && region.kind !== 'roster') return 'Draft capture accepts portrait regions only';
    if (!Number.isInteger(region.width) || !Number.isInteger(region.height) || region.width < 4 || region.height < 4) return 'Invalid crop dimensions';
    if (region.kind === 'minimap') {
      maps++;
      if (maps > 1 || region.width > MAX_MAP_EDGE || region.height > MAX_MAP_EDGE) return 'Oversized minimap crop';
    } else if(region.kind==='selected_hero_label'){
      if(++labels>1||region.width>160||region.height>48)return 'Invalid selected hero title crop';
      if(region.width!==region.rect?.width||region.height!==region.rect?.height)return 'Selected hero title must retain native pixels';
    } else if (region.kind === 'scene') {
      if (!Number.isInteger(region.index) || region.index < 0 || region.index > 9 || sceneSlots.has(region.index)) return 'Invalid scene slot';
      sceneSlots.add(region.index);
      if (region.width > 64 || region.height > 64) return 'Oversized scene crop';
      if (!['ally','enemy'].includes(region.healthColor)||!region.anchor||![region.anchor.x,region.anchor.y].every(Number.isInteger)||region.anchor.x<0||region.anchor.y<0||region.anchor.x>=size.width||region.anchor.y>=size.height) return 'Invalid scene anchor';
    } else {
      if (!Number.isInteger(region.index) || region.index < 0 || region.index > 9 || slots.has(region.index)) return 'Invalid portrait slot';
      slots.add(region.index);
      if (region.width > MAX_PORTRAIT_WIDTH || region.height > MAX_PORTRAIT_HEIGHT) return 'Oversized portrait crop';
    }
    const rect = region.rect;
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isInteger) || rect.x < 0 || rect.y < 0 || rect.width < 4 || rect.height < 4 || rect.x + rect.width > size.width || rect.y + rect.height > size.height) return 'Invalid source rectangle';
    const expected = region.width * region.height * 4;
    const actualBytes = region.data instanceof ArrayBuffer ? region.data.byteLength : ArrayBuffer.isView(region.data) && region.data.BYTES_PER_ELEMENT === 1 ? region.data.byteLength : -1;
    if (actualBytes !== expected) return 'Invalid BGRA crop buffer';
    bytes += expected;
    if (bytes > MAX_FRAME_BYTES) return 'Capture packet exceeds pixel budget';
    if (draft && bytes > MAX_DRAFT_BYTES) return 'Draft packet exceeds portrait budget';
  }
  if (!draft && maps !== 1) return 'Missing minimap crop';
  if (draft && slots.size === 0) return 'Missing draft portraits';
  return null;
}

module.exports = { DISCOVERY_INTERVAL_MS, MAX_FRAME_BYTES, MAX_DRAFT_BYTES, MIN_FRAME_INTERVAL_MS, MAX_MAP_EDGE, MAX_PORTRAIT_WIDTH, MAX_PORTRAIT_HEIGHT, normalizeCaptureConfig, isDotaWindow, selectCaptureSource, validateRegionFrame };
