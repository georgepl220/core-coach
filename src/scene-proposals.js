(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SceneProposals = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  // Only proposes visible health/mana pairs. No colors are hero identities.
  // A full video frame stays in the capture renderer; only these tiny crops
  // need to cross IPC. BGRA is the test/worker format, canvas uses RGBA.
  function findHealthBarHeads(frame) {
    const width = frame?.width; const height = frame?.height;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 320 || height < 180 || !frame.data || frame.data.length < width * height * 4) return [];
    const original = frame.originalSize || { width, height };
    const scale = original.height / 1080 * width / original.width;
    const rgba = frame.format === 'rgba'; const data = frame.data;
    const minLength = Math.max(8, Math.round(24 * scale));
    const maxLength = Math.max(minLength + 1, Math.round(130 * scale));
    const maxGap = Math.max(1, Math.round(scale));
    const pixel = (x, y) => {
      if (x < 0 || y < 0 || x >= width || y >= height) return [0, 0, 0];
      const p = (y * width + x) * 4;
      return rgba ? [data[p], data[p + 1], data[p + 2]] : [data[p + 2], data[p + 1], data[p]];
    };
    const isBlueAt = (x, y) => {
      const p = (y * width + x) * 4;
      const b = data[p + (rgba ? 2 : 0)];
      if (b <= 90) return false;
      const r = data[p + (rgba ? 0 : 2)]; const g = data[p + 1];
      return b > r * 1.4 && b > g * 1.1 && g > 30;
    };
    const isDark = (p) => Math.max(...p) < 70;
    const health = (p) => p[1] > 85 && p[1] > p[0] * 1.08 && p[1] > p[2] * 1.2 ? 'ally' : p[0] > 100 && p[0] > p[1] * 1.12 && p[0] > p[2] * 1.7 ? 'enemy' : null;
    const proposals = [];
    const top = Math.round(original.height * width / original.width * 0.07);
    const bottom = Math.min(height, Math.round(original.height * width / original.width * 0.78));
    for (let y = top; y < bottom; y++) {
      let x = Math.round(35 * scale);
      while (x < width - minLength) {
        if (!isBlueAt(x, y)) { x++; continue; }
        const start = x; let last = x; let gap = 0;
        while (++x < width) {
          if (isBlueAt(x, y)) { last = x; gap = 0; }
          else if (++gap > maxGap) break;
        }
        const length = last - start + 1;
        if (length < minLength || length > maxLength) continue;
        if (!isDark(pixel(start - 2, y)) && !isDark(pixel(start - 1, y))) continue;
        let bestHealth = null; let bestCount = 0;
        for (let dy = Math.max(2, Math.round(3 * scale)); dy <= Math.ceil(15 * scale); dy++) {
          let friendly = 0; let hostile = 0;
          const end = Math.min(last, start + Math.round(70 * scale));
          for (let hx = start; hx <= end; hx++) {
            const team = health(pixel(hx, y - dy));
            if (team === 'ally') friendly++; else if (team === 'enemy') hostile++;
          }
          const count = Math.max(friendly, hostile);
          if (count > bestCount) { bestCount = count; bestHealth = friendly > hostile ? 'ally' : 'enemy'; }
        }
        if (bestCount < Math.max(7, Math.round(15 * scale))) continue;
        if (proposals.some((p) => Math.abs(p.anchor.x - start) <= 5 * scale && Math.abs(p.anchor.y - y) <= 6 * scale)) continue;
        const base = 30 * scale; const padding = Math.max(4, Math.ceil(6 * scale));
        const rect = { x: Math.max(0, Math.floor(start - base - padding)), y: Math.max(0, Math.floor(y - base / 2 - padding)), width: Math.ceil(base + padding * 2), height: Math.ceil(base + padding * 2) };
        if (rect.x + rect.width > width || rect.y + rect.height > height) continue;
        proposals.push({ kind: 'scene_head', index: proposals.length, rect, anchor: { x: start, y }, healthColor: bestHealth, scale, evidence: 'visible_health_mana_pair', barPixels: bestCount });
      }
    }
    return proposals.sort((a, b) => b.barPixels - a.barPixels).slice(0, 10).map((p, index) => ({ ...p, index }));
  }
  return { findHealthBarHeads };
});
