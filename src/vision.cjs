'use strict';

/**
 * Visible-screen analysis only. All images are Electron nativeImage.toBitmap()
 * BGRA buffers. templateBank is {portraits: [{id,name,width,height,data}],
 * minimap: [{id,name,width,height,data}]}; alpha masks are kept for map icons.
 * Similarity scores are NOT probabilities. Color blobs are never hero claims.
 * Rectangles are normalized unless units:'px' is specified. Calibration is
 * required if HUD scaling, map side, resolution or custom HUD changes.
 */

const compiled = new WeakMap();
const { defaultCalibration, draftCalibration } = require('./hud-calibration.js');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const finite = (v) => Number.isFinite(Number(v));

function validateFrame(frame) {
  if (!frame || !Number.isInteger(frame.width) || !Number.isInteger(frame.height)) return 'Missing image dimensions';
  if (frame.width < 8 || frame.height < 8 || frame.width > 16384 || frame.height > 16384) return 'Unsupported image dimensions';
  if (!frame.data || typeof frame.data.length !== 'number' || frame.data.length < frame.width * frame.height * 4) return 'Incomplete BGRA pixel buffer';
  return null;
}

function resolveRect(rect, width, height) {
  if (!rect) return null;
  const rw = rect.width ?? rect.w;
  const rh = rect.height ?? rect.h;
  if (![rect.x, rect.y, rw, rh].every(finite) || Number(rw) <= 0 || Number(rh) <= 0) return null;
  const normalized = rect.units !== 'px' && Math.abs(Number(rect.x)) <= 1 && Math.abs(Number(rect.y)) <= 1 && Number(rw) <= 1 && Number(rh) <= 1;
  const raw = { x: Math.round(Number(rect.x) * (normalized ? width : 1)), y: Math.round(Number(rect.y) * (normalized ? height : 1)), width: Math.round(Number(rw) * (normalized ? width : 1)), height: Math.round(Number(rh) * (normalized ? height : 1)) };
  const x = clamp(raw.x, 0, width);
  const y = clamp(raw.y, 0, height);
  const x2 = clamp(raw.x + raw.width, 0, width);
  const y2 = clamp(raw.y + raw.height, 0, height);
  if (x2 - x < 4 || y2 - y < 4) return null;
  return { x, y, width: x2 - x, height: y2 - y, clipped: raw.x !== x || raw.y !== y || raw.width !== x2 - x || raw.height !== y2 - y };
}

function rgbAt(frame, x, y, out, offset) {
  const p = (clamp(Math.floor(y), 0, frame.height - 1) * frame.width + clamp(Math.floor(x), 0, frame.width - 1)) * 4;
  out[offset] = frame.data[p + 2];
  out[offset + 1] = frame.data[p + 1];
  out[offset + 2] = frame.data[p];
}

function sampleRect(frame, rect, sw, sh) {
  const result = new Float32Array(sw * sh * 3);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) rgbAt(frame, rect.x + (x + 0.5) * rect.width / sw, rect.y + (y + 0.5) * rect.height / sh, result, (y * sw + x) * 3);
  return result;
}

function resizeRegion(source, width, height, crop = { x: 0, y: 0, width: source.width, height: source.height }) {
  // Area filtering prevents aliasing when 32px Valve icons are rendered at
  // 18–26px. BGRA pixels are premultiplied already, so filter alpha too.
  const data = new Uint8Array(width * height * 4);
  const scaleX = crop.width / width; const scaleY = crop.height / height;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const x0 = crop.x + x * scaleX; const x1 = crop.x + (x + 1) * scaleX;
    const y0 = crop.y + y * scaleY; const y1 = crop.y + (y + 1) * scaleY;
    const sums = [0, 0, 0, 0]; let weight = 0;
    for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
      const w = Math.max(0, Math.min(x1, sx + 1) - Math.max(x0, sx)) * Math.max(0, Math.min(y1, sy + 1) - Math.max(y0, sy));
      const p = (Math.min(source.height - 1, sy) * source.width + Math.min(source.width - 1, sx)) * 4;
      for (let c = 0; c < 4; c++) sums[c] += source.data[p + c] * w;
      weight += w;
    }
    const p = (y * width + x) * 4;
    for (let c = 0; c < 4; c++) data[p + c] = Math.round(sums[c] / weight);
  }
  return { width, height, data };
}

function sampleAreaRect(frame, rect, width, height) {
  const area = resizeRegion(frame, width, height, rect);
  return sampleRect(area, { x: 0, y: 0, width, height }, width, height);
}

function prepareTemplate(template, sw, sh, aspect = null, rasterSize = null, areaSample = false) {
  if (!template || typeof template !== 'object' || validateFrame(template)) return null;
  let cached = compiled.get(template);
  if (!cached) { cached = new Map(); compiled.set(template, cached); }
  const rasterKey = typeof rasterSize === 'object' && rasterSize ? `${rasterSize.width}x${rasterSize.height}` : rasterSize;
  const key = `${sw}:${sh}:${aspect ? aspect.toFixed(3) : 'full'}:${rasterKey || 'native'}:${areaSample ? 'area' : 'point'}`;
  if (cached.has(key)) return cached.get(key);
  let source = template;
  let crop = { x: 0, y: 0, width: template.width, height: template.height };
  if (aspect) {
    if (source.width / source.height > aspect) { crop.width = source.height * aspect; crop.x = (source.width - crop.width) / 2; }
    else { crop.height = source.width / aspect; crop.y = (source.height - crop.height) / 2; }
  }
  if (rasterSize) {
    const width = typeof rasterSize === 'object' ? rasterSize.width : rasterSize;
    const height = typeof rasterSize === 'object' ? rasterSize.height : rasterSize;
    source = resizeRegion(source, width, height, crop);
    crop = { x: 0, y: 0, width: source.width, height: source.height };
  }
  const pixels = areaSample ? sampleAreaRect(source, crop, sw, sh) : sampleRect(source, crop, sw, sh);
  const mask = [];
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    // HUD borders and tiny capture translations must not introduce pixels
    // from an adjacent hero or the scoreboard into a portrait comparison.
    if (areaSample && sw >= 20 && (x < 2 || x >= sw - 2 || y < 1 || y >= sh - 1)) continue;
    const tx = clamp(Math.floor(crop.x + (x + 0.5) * crop.width / sw), 0, source.width - 1);
    const ty = clamp(Math.floor(crop.y + (y + 0.5) * crop.height / sh), 0, source.height - 1);
    if (source.data[(ty * source.width + tx) * 4 + 3] >= 160) mask.push((y * sw + x) * 3);
  }
  if (mask.length < 12) { cached.set(key, null); return null; }
  let sum = 0; let sq = 0;
  for (const p of mask) for (let c = 0; c < 3; c++) { const v = pixels[p + c]; sum += v; sq += v * v; }
  const count = mask.length * 3;
  const mean = sum / count;
  const variance = sq / count - mean * mean;
  // A flat icon cannot carry an identity, even if its color happens to match.
  if (variance < 70) { cached.set(key, null); return null; }
  const anchors = [];
  for (let i = 0; i < 7; i++) anchors.push(mask[Math.min(mask.length - 1, Math.floor((i + 0.5) * mask.length / 7))]);
  const prepared = { id: template.id ?? template.heroId, name: template.name ?? String(template.id ?? template.heroId), pixels, mask, anchors, sw, sh, mean, variance };
  cached.set(key, prepared);
  return prepared;
}

function comparePixels(actual, target) {
  let sum = 0; let sq = 0; let product = 0; let distance = 0;
  for (const p of target.mask) for (let c = 0; c < 3; c++) {
    const a = actual[p + c]; const b = target.pixels[p + c];
    sum += a; sq += a * a; product += a * b; distance += Math.abs(a - b);
  }
  const count = target.mask.length * 3;
  const mean = sum / count;
  const variance = sq / count - mean * mean;
  if (variance < 70) return { score: 0, distance: 1, contrast: Math.sqrt(Math.max(0, variance)) };
  const correlation = clamp((product / count - mean * target.mean) / Math.sqrt(variance * target.variance), -1, 1);
  const normalizedDistance = distance / count / 255;
  const score = clamp(0.72 * Math.max(0, correlation) + 0.28 * (1 - normalizedDistance), 0, 1);
  return { score, distance: normalizedDistance, contrast: Math.sqrt(variance) };
}

function frameQuality(frame) {
  const pixels = sampleRect(frame, { x: 0, y: 0, width: frame.width, height: frame.height }, 24, 14);
  let bright = 0; let total = 0;
  for (let i = 0; i < pixels.length; i += 3) { if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) > 12) bright++; total++; }
  return { usable: bright / total > 0.025, reason: bright / total > 0.025 ? null : 'Capture is almost entirely black', nonBlackFraction: bright / total };
}

function recognizeRoster(frame, rects, bank, settings) {
  const draft = settings.capturePhase === 'draft';
  const threshold = draft ? clamp(Number(settings.draftPortraitThreshold) || 0.96, 0.96, 0.99) : clamp(Number(settings.portraitThreshold) || 0.84, 0.70, 0.99);
  const margin = draft ? clamp(Number(settings.draftPortraitMargin) || 0.08, 0.08, 0.3) : clamp(Number(settings.portraitMargin) || 0.035, 0.01, 0.3);
  return rects.slice(0, 10).map((definition, index) => {
    const rect = resolveRect(definition, frame.width, frame.height);
    const base = { index, team: definition.team || (index < 5 ? 'radiant' : 'dire'), rect, hero: null };
    if (!rect || rect.clipped) return { ...base, reason: 'Invalid or clipped HUD calibration' };
    const offsets = settings.capturePhase === 'draft'
      ? [[0, 0], [-0.02, 0], [0.02, 0], [0, -0.02], [0, 0.02], [-0.04, 0], [0.04, 0]]
      : [[0, 0], [-0.06, 0], [0.06, 0], [0, -0.06], [0, 0.06]];
    const samples = offsets.map(([x, y]) => sampleAreaRect(frame, { ...rect, x: Math.max(0, rect.x + rect.width * x), y: Math.max(0, rect.y + rect.height * y) }, 20, 14));
    const candidates = [];
    for (const image of bank) {
      const rasterSize = { width: rect.width, height: rect.height };
      // HUDs may crop or stretch wide Valve portraits. Try both render modes,
      // after resampling to the calibrated slot's physical pixel dimensions.
      const targets = [prepareTemplate(image, 20, 14, rect.width / rect.height, rasterSize,true), prepareTemplate(image, 20, 14, null, rasterSize,true)].filter(Boolean);
      if (!targets.length) continue;
      let best = { score: 0, distance: 1 };
      for (const target of targets) for (const actual of samples) { const result = comparePixels(actual, target); if (result.score > best.score) best = result; }
      candidates.push({ ...best, id: targets[0].id, name: targets[0].name });
    }
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0]; const next = candidates[1];
    if (!best) return { ...base, reason: 'No usable portrait templates' };
    const gap = best.score - (next ? next.score : 0);
    const accepted = best.score >= threshold && best.distance <= 0.24 && gap >= margin;
    return { ...base, hero: accepted ? { id: best.id, name: best.name, confidence: best.score, margin: gap } : null, bestSimilarity: best.score, reason: accepted ? null : 'Portrait match is uncertain' };
  });
}

function classifyColor(r, g, b) {
  if (r > 170 && g > 150 && b < 100) return 3;
  if (r > 135 && r > g * 1.5 && r > b * 1.4) return 1;
  if (g > 130 && g > r * 1.35 && g > b * 1.2) return 2;
  if (g > 150 && b > 150 && r < 120) return 4;
  if (b > 140 && b > r * 1.4 && b > g * 1.15) return 5;
  return 0;
}

function findColorMarkers(frame, rect) {
  const width = rect.width; const height = rect.height;
  const colors = new Uint8Array(width * height);
  const seen = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = ((y + rect.y) * frame.width + x + rect.x) * 4;
    colors[y * width + x] = classifyColor(frame.data[p + 2], frame.data[p + 1], frame.data[p]);
  }
  const scale = frame.height / 1080;
  const minArea = Math.max(10, 22 * scale * scale);
  const maxArea = Math.max(80, 240 * scale * scale);
  const minSide = Math.max(4, Math.round(5 * scale));
  const maxSide = Math.max(12, Math.round(23 * scale));
  const result = [];
  const names = ['', 'red', 'green', 'yellow', 'cyan', 'blue'];
  for (let start = 0; start < colors.length; start++) {
    const color = colors[start];
    if (!color || seen[start]) continue;
    const queue = [start]; seen[start] = 1;
    let minX = width; let maxX = 0; let minY = height; let maxY = 0; let sx = 0; let sy = 0;
    for (let k = 0; k < queue.length; k++) {
      const p = queue[k]; const x = p % width; const y = Math.floor(p / width);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); sx += x; sy += y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx; const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const np = ny * width + nx;
        if (!seen[np] && colors[np] === color) { seen[np] = 1; queue.push(np); }
      }
    }
    const bw = maxX - minX + 1; const bh = maxY - minY + 1;
    const area = queue.length; const fill = area / (bw * bh);
    // Reject creep-size dots, long terrain outlines, structures and edge crops.
    if (area < minArea || area > maxArea || bw < minSide || bh < minSide || bw > maxSide || bh > maxSide || bw / bh < 0.55 || bw / bh > 1.8 || fill < 0.25 || minX === 0 || minY === 0 || maxX === width - 1 || maxY === height - 1) continue;
    result.push({ x: sx / area / width, y: sy / area / height, color: names[color], confidence: null, type: 'unclassified_color_marker', area, reason: 'Color alone cannot distinguish heroes, creeps and map objects' });
  }
  return result.slice(0, 40);
}

function classifyHeroTeam(id, settings, roster) {
  const same = (a) => String(a) === String(id);
  if (settings.selfHeroId !== undefined && same(settings.selfHeroId)) return 'self';
  if (Array.isArray(settings.enemyHeroIds) && settings.enemyHeroIds.some(same)) return 'enemy';
  if (Array.isArray(settings.allyHeroIds) && settings.allyHeroIds.some(same)) return 'ally';
  const slot = roster.find((s) => s.hero && same(s.hero.id));
  if (slot && ['radiant', 'dire'].includes(settings.playerTeam)) return slot.team === settings.playerTeam ? 'ally' : 'enemy';
  return 'unknown';
}

function mapIntegral(frame, rect) {
  const stride = rect.width + 1;
  const sums = new Float64Array(stride * (rect.height + 1) * 3);
  for (let y = 0; y < rect.height; y++) {
    const row = [0, 0, 0];
    for (let x = 0; x < rect.width; x++) {
      const p = ((rect.y + y) * frame.width + rect.x + x) * 4;
      const dest = ((y + 1) * stride + x + 1) * 3;
      const up = (y * stride + x + 1) * 3;
      row[0] += frame.data[p + 2]; row[1] += frame.data[p + 1]; row[2] += frame.data[p];
      for (let c = 0; c < 3; c++) sums[dest + c] = sums[up + c] + row[c];
    }
  }
  return { sums, stride };
}

function averageWindow(integral, x, y, size, output, grid = 6) {
  const { sums, stride } = integral;
  // The cumulative image is bilinear between integer corners. This is the
  // exact area-weighted mean, including fractional cells after a 1280px resize.
  // Reuse corner samples: adjacent cells share their cumulative corners.
  // No allocations are made for the thousands of coarse/fine search windows.
  const cornerStride = grid + 1;
  const samples = (integral.cellSamples ||= {})[grid] ||= new Float64Array(cornerStride * cornerStride * 3);
  for (let yy = 0; yy <= grid; yy++) {
    const sy = y + yy * size / grid, iy = Math.floor(sy), fy = sy - iy;
    for (let xx = 0; xx <= grid; xx++) {
      const sx = x + xx * size / grid, ix = Math.floor(sx), fx = sx - ix;
      const base = (iy * stride + ix) * 3, dest = (yy * cornerStride + xx) * 3;
      for (let c = 0; c < 3; c++) {
        const a = sums[base + c], b = fx ? sums[base + 3 + c] : a;
        const d = fy ? sums[base + stride * 3 + c] : a;
        const e = fx && fy ? sums[base + stride * 3 + 3 + c] : fx ? b : d;
        samples[dest + c] = (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
      }
    }
  }
  const area = (size / grid) ** 2;
  for (let yy = 0; yy < grid; yy++) for (let xx = 0; xx < grid; xx++) {
    const a = (yy * cornerStride + xx) * 3, b = a + 3, c = a + cornerStride * 3, d = c + 3;
    const dest = (yy * grid + xx) * 3;
    for (let channel = 0; channel < 3; channel++) output[dest + channel] = (samples[d + channel] - samples[b + channel] - samples[c + channel] + samples[a + channel]) / area;
  }
}

function findHeroIcons(frame, rect, bank, roster, settings) {
  const rosterIds = new Set(roster.filter((s) => s.hero).map((s) => String(s.hero.id)));
  const explicit = [...(settings.enemyHeroIds || []), ...(settings.allyHeroIds || []), settings.selfHeroId].filter((v) => v !== undefined);
  explicit.forEach((id) => rosterIds.add(String(id)));
  const all = bank.slice(0, 180);
  // A partial HUD must not remove the unrecognized carry/support from the
  // minimap search. Restrict the bank only after observing a complete draft.
  const teamComplete = team => roster.filter(s => s.team === team && s.hero?.confidence >= 0.90).length === 5;
  const completeDraft = roster.length === 10 && teamComplete('radiant') && teamComplete('dire') && new Set(roster.map(s => String(s.hero?.id))).size === 10;
  const knownAllies = new Set([...(settings.allyHeroIds || []), settings.selfHeroId].filter(v => v !== undefined).map(String));
  const knownEnemies = new Set((settings.enemyHeroIds || []).map(String));
  const completeKnownTeams = knownAllies.size === 5 && knownEnemies.size === 5 && new Set([...knownAllies, ...knownEnemies]).size === 10;
  const images = completeDraft || completeKnownTeams ? all.filter((t) => rosterIds.has(String(t.id ?? t.heroId))) : all;
  const threshold = clamp(Number(settings.minimapThreshold) || 0.88, 0.80, 0.99);
  const size = clamp(Number(settings.minimapHeroSizePx) || 19 * frame.height / 1080, 10, 64);
  const sizes = [Math.round(size * 0.83), Math.round(size), Math.round(size * 1.17)];
  const batches = sizes.map((iconSize) => ({ iconSize, targets: images.map((t) => ({ source: t, fine: prepareTemplate(t, 12, 12, null, iconSize, true), coarse: prepareTemplate(t, 6, 6, null, 6) })).filter((t) => t.fine && t.coarse) }));
  const candidates = [];
  let comparisons = 0;
  const actual = new Float32Array(12 * 12 * 3);
  const coarsePixels = new Float32Array(6 * 6 * 3);
  const integral = mapIntegral(frame, rect);
  const compareAt = (target, x, y, iconSize, quick = true) => {
    if (quick) {
      let difference = 0;
      for (const p of target.anchors) {
        const i = p / 3; const px = Math.floor(x + ((i % 12) + 0.5) * iconSize / 12); const py = Math.floor(y + (Math.floor(i / 12) + 0.5) * iconSize / 12);
        const q = (py * frame.width + px) * 4;
        difference += Math.abs(frame.data[q + 2] - target.pixels[p]) + Math.abs(frame.data[q + 1] - target.pixels[p + 1]) + Math.abs(frame.data[q] - target.pixels[p + 2]);
      }
      if (difference / (target.anchors.length * 3 * 255) > 0.22) return null;
    }
    // Integrals retain subpixel/resampling detail without allocating or reading
    // a canvas per search position, even for 10–13px captured icons.
    averageWindow(integral, x - rect.x, y - rect.y, iconSize, actual, 12);
    comparisons++;
    return comparePixels(actual, target);
  };
  for (const { iconSize, targets } of batches) {
    const step = Math.max(2, Math.floor(iconSize / 6));
    for (let y = rect.y; y <= rect.y + rect.height - iconSize; y += step) for (let x = rect.x; x <= rect.x + rect.width - iconSize; x += step) {
      // Broad search uses area-averaged cells. Fine single-pixel sampling loses
      // similarity after a 1px translation of detailed 22px hero faces.
      averageWindow(integral, x - rect.x, y - rect.y, iconSize, coarsePixels);
      for (const { source, fine: target, coarse } of targets) {
        let difference = 0;
        for (const p of coarse.anchors) for (let c = 0; c < 3; c++) difference += Math.abs(coarsePixels[p + c] - coarse.pixels[p + c]);
        if (difference / (coarse.anchors.length * 3 * 255) > 0.24) continue;
        const seed = comparePixels(coarsePixels, coarse);
        if (seed.score >= threshold - 0.18 && seed.distance <= 0.24) candidates.push({ source, target, x, y, size: iconSize, seedScore: seed.score });
      }
    }
  }
  candidates.sort((a, b) => b.seedScore - a.seedScore);
  const seeds = [];
  for (const candidate of candidates) {
    // Neighboring coarse windows commonly describe the very same face. Keep
    // one seed per identity/scale/location, so terrain and one large icon
    // cannot consume the whole fine-search budget before another hero is seen.
    if (seeds.some(s => s.size === candidate.size && s.target.id === candidate.target.id && Math.hypot(s.x - candidate.x, s.y - candidate.y) < candidate.size * 0.55)) continue;
    seeds.push(candidate);
    if (seeds.length === 80) break;
  }
  const refined = [];
  for (const candidate of seeds) {
    const radius = Math.max(1, Math.ceil(candidate.size / 6));
    let best = { ...candidate, ...compareAt(candidate.target, candidate.x, candidate.y, candidate.size, false) };
    // A capture resize can turn a 19px in-game icon into 12 or 13 pixels.
    // Refine the raster size too, rather than depending on the coarse grid.
    for (const iconSize of [candidate.size - 1, candidate.size, candidate.size + 1].filter(s => s >= 10)) {
      const target = prepareTemplate(candidate.source, 12, 12, null, iconSize, true);
      if (!target) continue;
      for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const x = candidate.x + dx; const y = candidate.y + dy;
      if (x < rect.x || y < rect.y || x + iconSize > rect.x + rect.width || y + iconSize > rect.y + rect.height) continue;
      const match = compareAt(target, x, y, iconSize, false);
      if (match.score > best.score) best = { ...candidate, target, x, y, size: iconSize, ...match };
      }
    }
    // Keep nearby runners-up below the acceptance threshold as ambiguity evidence.
    if (best.score >= threshold - 0.05 && best.distance <= 0.24) refined.push(best);
  }
  refined.sort((a, b) => b.score - a.score);
  const heroes = [];
  for (const hit of refined) {
    if (hit.score < threshold || hit.distance > 0.20) continue;
    const cx = hit.x + hit.size / 2; const cy = hit.y + hit.size / 2;
    if (heroes.some((h) => Math.hypot(h.screenX - cx, h.screenY - cy) < hit.size * 0.75)) continue;
    const alternative = refined.find((other) => String(other.target.id) !== String(hit.target.id) && Math.hypot(other.x + other.size / 2 - cx, other.y + other.size / 2 - cy) < hit.size * 0.6);
    const margin = alternative ? hit.score - alternative.score : null;
    if (margin !== null && margin < 0.035) continue;
    heroes.push({ id: hit.target.id, name: hit.target.name, x: (cx - rect.x) / rect.width, y: (cy - rect.y) / rect.height, screenX: cx, screenY: cy, confidence: hit.score, margin, team: classifyHeroTeam(hit.target.id, settings, roster), type: 'visible_template_match' });
    if (heroes.length === 20) break;
  }
  return { heroes, comparisons, templateCount: batches[0].targets.length };
}

function analyzeScreen(frame, settings = {}, templateBank = {}, previous = null) {
  const timestamp = finite(frame?.timestamp) ? Number(frame.timestamp) : Date.now();
  const invalid = validateFrame(frame);
  const empty = { timestamp, quality: { usable: false, reason: invalid }, minimap: { rect: null, heroes: [], uncertainMarkers: [], observedHeroCount: 0, enemyCount: null, lastSeenHeroes: [] }, roster: { slots: [] }, diagnostics: { crops: [], warnings: [], similarityIsProbability: false }, state: { lastSeen: [] } };
  if (invalid) return empty;
  const quality = frameQuality(frame);
  if (!quality.usable) return { ...empty, quality };
  const draft = settings.capturePhase === 'draft';
  const defaults = draft ? draftCalibration(frame.width, frame.height) : defaultCalibration(frame.width, frame.height, !!settings.minimapOnRight);
  const mapRect = draft ? null : resolveRect(settings.minimapRect || defaults.minimapRect, frame.width, frame.height);
  const roster = recognizeRoster(frame, draft ? settings.draftRosterRects || defaults.rosterRects : settings.rosterRects || defaults.rosterRects, templateBank.portraits || [], settings);
  const warnings = [];
  let map = { heroes: [], comparisons: 0, templateCount: 0 }; let markers = [];
  if (draft) { /* No minimap or player HUD exists on the draft screen. */ }
  else if (!mapRect || mapRect.clipped) warnings.push('Minimap calibration is invalid or cropped; analysis skipped');
  else {
    map = findHeroIcons(frame, mapRect, templateBank.minimap || [], roster, settings);
    markers = findColorMarkers(frame, mapRect).filter((m) => !map.heroes.some((h) => Math.hypot((h.x - m.x) * mapRect.width, (h.y - m.y) * mapRect.height) < 15 * frame.height / 1080));
  }
  if (!draft && !map.templateCount) warnings.push('No usable minimap templates; color markers remain unclassified');
  const old = draft ? [] : previous?.state?.lastSeen || previous?.lastSeen || [];
  const history = new Map(old.filter((h) => finite(h.lastSeen) && timestamp - h.lastSeen >= 0 && timestamp - h.lastSeen <= 180000).map((h) => [String(h.id), { ...h, currentlyVisible: false }]));
  for (const h of map.heroes) history.set(String(h.id), { id: h.id, name: h.name, x: h.x, y: h.y, team: h.team, lastSeen: timestamp, confidence: h.confidence, currentlyVisible: true });
  const lastSeenHeroes = [...history.values()].map((h) => ({ ...h, ageMs: timestamp - h.lastSeen }));
  return {
    timestamp, quality,
    minimap: { rect: mapRect, heroes: map.heroes, uncertainMarkers: markers, observedHeroCount: map.heroes.length, enemyCount: settings.playerTeam || settings.enemyHeroIds?.length ? map.heroes.filter((h) => h.team === 'enemy').length : null, lastSeenHeroes },
    roster: { slots: roster },
    diagnostics: { crops: [{ kind: 'minimap', rect: mapRect }, ...roster.map((s) => ({ kind: 'roster', index: s.index, rect: s.rect }))], warnings, templateCount: map.templateCount, fullComparisons: map.comparisons, similarityIsProbability: false, calibrationRequired: true },
    state: { lastSeen: lastSeenHeroes }
  };
}

module.exports = { analyzeScreen, defaultCalibration, resolveRect, validateFrame };
