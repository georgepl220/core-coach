'use strict';

const prepared = new WeakMap();
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function areaSample(source, rect, width = 14, height = 14) {
  const out = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const x0 = rect.x + x * rect.width / width; const x1 = rect.x + (x + 1) * rect.width / width;
    const y0 = rect.y + y * rect.height / height; const y1 = rect.y + (y + 1) * rect.height / height;
    const sums = [0, 0, 0]; let weight = 0;
    for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
      const w = Math.max(0, Math.min(x1, sx + 1) - Math.max(x0, sx)) * Math.max(0, Math.min(y1, sy + 1) - Math.max(y0, sy));
      const p = (clamp(sy, 0, source.height - 1) * source.width + clamp(sx, 0, source.width - 1)) * 4;
      for (let c = 0; c < 3; c++) sums[c] += source.data[p + 2 - c] * w;
      weight += w;
    }
    for (let c = 0; c < 3; c++) out[(y * width + x) * 3 + c] = Math.round(sums[c] / weight);
  }
  return out;
}

function resizeBitmap(source, size) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const x0 = x * source.width / size; const x1 = (x + 1) * source.width / size;
    const y0 = y * source.height / size; const y1 = (y + 1) * source.height / size;
    const sums = [0, 0, 0, 0]; let weight = 0;
    for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
      const w = Math.max(0, Math.min(x1, sx + 1) - Math.max(x0, sx)) * Math.max(0, Math.min(y1, sy + 1) - Math.max(y0, sy));
      const p = (sy * source.width + sx) * 4;
      for (let c = 0; c < 4; c++) sums[c] += source.data[p + c] * w;
      weight += w;
    }
    for (let c = 0; c < 4; c++) data[(y * size + x) * 4 + c] = Math.round(sums[c] / weight);
  }
  return { width: size, height: size, data };
}

function prepare(image, size) {
  let cache = prepared.get(image);
  if (!cache) { cache = new Map(); prepared.set(image, cache); }
  if (cache.has(size)) return cache.get(size);
  if (!image?.data || image.data.length < image.width * image.height * 4) return null;
  const source = resizeBitmap(image, size);
  const pixels = areaSample(source, { x: 0, y: 0, width: size, height: size });
  const mask = [];
  // The central face stays stable when outlines, player colors and the health
  // bar touch the little hero icon. At least 70 informative RGB pixels remain.
  for (let y = 2; y <= 11; y++) for (let x = 2; x <= 11; x++) {
    const sx = Math.floor((x + 0.5) * size / 14); const sy = Math.floor((y + 0.5) * size / 14);
    if (source.data[(sy * size + sx) * 4 + 3] >= 160) mask.push((y * 14 + x) * 3);
  }
  if (mask.length < 70) { cache.set(size, null); return null; }
  let sum = 0; let sq = 0;
  for (const p of mask) for (let c = 0; c < 3; c++) { const v = pixels[p + c]; sum += v; sq += v * v; }
  const count = mask.length * 3; const mean = sum / count; const variance = sq / count - mean * mean;
  const result = variance >= 70 ? { id: Number(image.id ?? image.heroId), name: image.name, mask, pixels, mean, variance } : null;
  cache.set(size, result); return result;
}

function compare(actual, target) {
  let sum = 0; let sq = 0; let product = 0; let distance = 0;
  for (const p of target.mask) for (let c = 0; c < 3; c++) {
    const a = actual[p + c]; const b = target.pixels[p + c];
    sum += a; sq += a * a; product += a * b; distance += Math.abs(a - b);
  }
  const count = target.mask.length * 3; const mean = sum / count; const variance = sq / count - mean * mean;
  if (variance < 70) return { score: 0, distance: 1 };
  const correlation = clamp((product / count - mean * target.mean) / Math.sqrt(variance * target.variance), -1, 1);
  const normalizedDistance = distance / count / 255;
  return { score: clamp(0.72 * Math.max(0, correlation) + 0.28 * (1 - normalizedDistance), 0, 1), distance: normalizedDistance };
}

function qualifiedSelectedSelf(best, margin, team, region, settings) {
  const proof = settings.screenPlayer;
  const now = settings.frameTimestamp;
  const age = now - proof?.observedAt;
  return !!best && Number(settings.selfHeroId) === 42 && best.id === 42 && best.score >= 0.86 && best.score < 0.90 && best.distance <= 0.12 && margin >= 0.16 && team === 'ally' && region.kind === 'scene_head' && region.healthColor === 'ally' && proof?.heroId === 42 && proof.confirmed === true && proof.source === 'selected_hud' && ['radiant', 'dire'].includes(proof.team) && (!['radiant', 'dire'].includes(settings.playerTeam) || settings.playerTeam === proof.team) && Number.isFinite(now) && Number.isFinite(proof.observedAt) && age >= -1000 && age <= 8000;
}

function analyzeSceneHeads(regions, settings = {}, templateBank = {}, originalSize = {}) {
  const allies = new Set((Array.isArray(settings.allyHeroIds) ? settings.allyHeroIds : []).map(Number));
  const enemies = new Set((Array.isArray(settings.enemyHeroIds) ? settings.enemyHeroIds : []).map(Number));
  const self = Number(settings.selfHeroId);
  if (Number.isInteger(self) && self > 0) allies.add(self);
  const known = new Set([...allies, ...enemies]);
  const bank = (Array.isArray(templateBank.minimap) ? templateBank.minimap : []).filter((image) => known.has(Number(image.id ?? image.heroId)));
  const observations = []; const heroes = [];
  if (!Array.isArray(regions) || !Number.isInteger(originalSize.width) || !Number.isInteger(originalSize.height) || originalSize.width < 8 || originalSize.height < 8 || originalSize.width > 16384 || originalSize.height > 16384 || known.size < 2 || !bank.length) return { heroes, observations, reason: 'Confirmed team identities are required for visible scene matching' };
  for (const region of regions.slice(0, 10)) {
    if (region.kind !== 'scene_head' || !region.rect || !region.anchor || !region.data || !Number.isInteger(region.width) || !Number.isInteger(region.height) || region.width < 12 || region.height < 12 || region.width > 96 || region.height > 96 || region.data.length < region.width * region.height * 4) continue;
    if (![region.rect.x, region.rect.y, region.anchor.x, region.anchor.y].every(Number.isFinite) || region.rect.x < 0 || region.rect.y < 0 || region.rect.x + region.width > originalSize.width || region.rect.y + region.height > originalSize.height || region.anchor.x < region.rect.x || region.anchor.x >= region.rect.x + region.width || region.anchor.y < region.rect.y || region.anchor.y >= region.rect.y + region.height) continue;
    const scale = originalSize.height / 1080;
    const base = 30 * scale;
    const sizes = [...new Set([0.83, 0.87, 0.9, 0.93, 0.97, 1, 1.03, 1.07].map((s) => Math.max(12, Math.round(base * s))))];
    const targets = new Map(sizes.map((size) => [size, bank.map((image) => prepare(image, size)).filter(Boolean)]));
    const bestByHero = new Map();
    const seen = new Set();
    for (const size of sizes) for (const dx of [-3, -2, -1, 0, 1, 2, 3]) for (const dy of [-3, -2, -1, 0, 1, 2, 3]) {
      const rect = { x: Math.round(region.anchor.x - region.rect.x - size + dx * scale), y: Math.round(region.anchor.y - region.rect.y - size / 2 + dy * scale), width: size, height: size };
      if (rect.x < 0 || rect.y < 0 || rect.x + size > region.width || rect.y + size > region.height) continue;
      const key = `${rect.x}:${rect.y}:${size}`; if (seen.has(key)) continue; seen.add(key);
      const actual = areaSample(region, rect);
      for (const target of targets.get(size)) {
        const match = compare(actual, target); const prev = bestByHero.get(target.id);
        if (!prev || match.score > prev.score) bestByHero.set(target.id, { ...match, id: target.id, name: target.name, rect });
      }
    }
    const candidates = [...bestByHero.values()].sort((a, b) => b.score - a.score);
    const best = candidates[0]; const margin = best ? best.score - (candidates[1]?.score || 0) : 0;
    const team = best && allies.has(best.id) && !enemies.has(best.id) ? 'ally' : best && enemies.has(best.id) && !allies.has(best.id) ? 'enemy' : 'unknown';
    const qualifiedBySelectedHud = qualifiedSelectedSelf(best, margin, team, region, settings);
    const accepted = !!best && (best.score >= 0.90 && best.distance <= 0.15 && margin >= 0.10 && team !== 'unknown' && region.healthColor === team || qualifiedBySelectedHud);
    observations.push({ index: region.index, bestHeroId: best?.id || null, bestSimilarity: best?.score || 0, distance: best?.distance ?? 1, margin, accepted, ...(qualifiedBySelectedHud ? { qualifiedBySelectedHud: true } : {}), reason: accepted ? null : team !== region.healthColor ? 'Visible health color conflicts with confirmed team' : 'Scene head match is uncertain' });
    if (!accepted) continue;
    const screenX = region.rect.x + best.rect.x + best.rect.width / 2;
    const screenY = region.rect.y + best.rect.y + best.rect.height / 2;
    heroes.push({ id: best.id, name: best.name, confidence: best.score, margin, team, healthColor: region.healthColor, x: screenX / originalSize.width, y: screenY / originalSize.height, screenX, screenY, type: 'visible_scene_head', source: 'visible_scene_head', currentlyVisible: true, ...(qualifiedBySelectedHud ? { qualifiedBySelectedHud: true } : {}) });
  }
  // Multiple matches for one identity are ambiguous (illusions, Rubick, overlap).
  const counts = new Map(); for (const hero of heroes) counts.set(hero.id, (counts.get(hero.id) || 0) + 1);
  return { heroes: heroes.filter((hero) => counts.get(hero.id) === 1), observations, proposedHeadCount: regions.length, analyzedHeadCount: observations.length, similarityIsProbability: false };
}

module.exports = { analyzeSceneHeads, qualifiedSelectedSelf };
