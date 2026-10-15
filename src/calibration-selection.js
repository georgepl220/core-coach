'use strict';
(function (root) {
  const hud = typeof module === 'object' && module.exports ? require('./hud-calibration.js') : root.HudCalibration;
  function validRect(r) {
    return ['x', 'y', 'width', 'height'].every(key => Number.isFinite(r?.[key])) && r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0 && r.x + r.width <= 1.001 && r.y + r.height <= 1.001;
  }
  function selectRosterRow({ size, slots = [], saved = [], team, row, mapOnRight = false, capturePhase = 'game' } = {}) {
    if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0 || !['radiant', 'dire'].includes(team) || !validRect(row)) return null;
    const fallback = (capturePhase === 'draft' ? hud.draftCalibration(size.width, size.height) : hud.defaultCalibration(size.width, size.height, mapOnRight)).rosterRects;
    const rects = Array.from({ length: 10 }, (_, index) => {
      // Preserve explicit calibration first. Live detections can be absent,
      // including while a new preview is waiting for its first analysis.
      if (validRect(saved?.[index])) return { ...saved[index] };
      const s = slots?.[index]?.rect;
      const observed = s && { x: s.x / size.width, y: s.y / size.height, width: s.width / size.width, height: s.height / size.height };
      return validRect(observed) ? observed : { ...fallback[index] };
    });
    const start = team === 'radiant' ? 0 : 5;
    for (let index = 0; index < 5; index++) rects[start + index] = { x: row.x + index * row.width / 5, y: row.y, width: row.width / 5, height: row.height };
    return rects.map((rect, index) => ({ ...rect, team: index < 5 ? 'radiant' : 'dire' }));
  }
  function repairLegacyPortraitCalibration(settings) {
    if (settings.hudCalibrationVersion === 1) return false;
    settings.hudCalibrationVersion = 1;
    // Earlier selections included the upper health strip or cut off the face.
    // Migrate only those incompatible bounds; keep correctly cropped rows.
    const incompatible = Array.isArray(settings.rosterRects) && settings.rosterRects.some(r => !validRect(r) || r.y > 6 / 1080 || r.y + r.height > 41 / 1080);
    if (incompatible) settings.rosterRects = null;
    return incompatible;
  }
  const api = { validRect, selectRosterRow, repairLegacyPortraitCalibration };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CalibrationSelection = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
