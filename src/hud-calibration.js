'use strict';

// One geometry definition for the capture renderer, calibration UI and worker.
// Dota's standard HUD is centered/edge-anchored and scales with screen height.
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HudCalibration = api;
})(typeof window === 'object' ? window : globalThis, () => {
  function defaultCalibration(width, height, mapOnRight = false) {
    const scale = height / 1080;
    const mapWidth = 228 * scale, mapHeight = 236 * scale;
    const mapX = mapOnRight ? width - mapWidth - 8 * scale : 8 * scale;
    const mapY = height - mapHeight;
    const slotW = 58 * scale, slotH = 36 * scale, stride = 62 * scale;
    const rosterRects = Array.from({ length: 10 }, (_, index) => ({
      x: (width / 2 + (index < 5 ? -412 * scale + index * stride : 108 * scale + (index - 5) * stride)) / width,
      y: 4 / 1080,
      width: slotW / width,
      height: slotH / height,
      team: index < 5 ? 'radiant' : 'dire'
    }));
    return {
      minimapRect: { x: mapX / width, y: mapY / height, width: mapWidth / width, height: mapHeight / height },
      rosterRects
    };
  }
  function selectedHeroLabelRect(width,height){
    if(![width,height].every(Number.isFinite)||width<320||height<240)return null;
    const rect={x:Math.round(width/2-height*.372),y:Math.round(height*.846),width:Math.round(height*.126),height:Math.round(height*.026),units:'px'};
    return rect.x>=0&&rect.y>=0&&rect.x+rect.width<=width&&rect.y+rect.height<=height?rect:null;
  }
  function draftCalibration(width, height) {
    if (![width, height].every(Number.isFinite) || width < 320 || height < 240) return { rosterRects: [] };
    const scale = height / 1080;
    // Draft/strategy cards are substantially larger than the in-game HUD.
    // Opposite rows slant in opposite directions. The inner image bounds omit
    // player names, coloured top strips and outer card borders.
    const rosterRects = Array.from({ length: 10 }, (_, index) => ({
      x: (width / 2 + (index < 5 ? -750 + index * 124 : 142 + (index - 5) * 124) * scale) / width,
      y: 6 / 1080,
      width: (index < 5 ? 116 : 108) * scale / width,
      height: 66 / 1080,
      team: index < 5 ? 'radiant' : 'dire'
    }));
    return { rosterRects };
  }
  return { defaultCalibration, draftCalibration, selectedHeroLabelRect };
});
