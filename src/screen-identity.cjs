'use strict';

// This checks the selected-hero title in the bottom HUD, never the team strip.
// The reference contains only the public WRAITH KING lettering, retained from
// a game HUD. It does not contain a hero skin, the map, player names or account
// information. Matching cannot establish that a selected hero is the player:
// fresh GSI spectator/wrong-hero information remains authoritative in main.
const REFERENCE = 'RkZFQ0FAQUFCQkJDQ0REQT09PDo6Ozw9PT47OTk5Oz1AQUFBQkNER0lKSUdFREVHSElJSUlKS0tLS0tLS0tLS0tMTU1NTEtKSUlJSktMS0tLSkhHSEdHR0dJSktMTU1MS0pJSUdGRkVDREVFRUI7OD08NTY7NjY9Ozc7QUA4Mi8vLzM5Ozs6ODc5UDM7QkJCQkJAODlESEc+NzQ1Njc5PkZHRDs9R0pIQz1BSUtMTExMS0tHPT5HSUY/QUpNTEg7O0VISWQ9QkhLS0ZBRUtMTEtJRTxhNjY8QkPv/5Yi+fUe+vojqf/aKDU5/////NVGJzU4NjY1U/9PKjxDQ0NA//9nLz/e////////9yI0Qf//YjFCvf/eKTpJS0tLSklF//9oMbD/+ko6Skn//2cyRUX/mSo7SL//zy0+S01Lgej////GJTZApv/oD7H/3/+yHfP/eSErLP//8f//5xIkMzMzMsH/xRosQURFOP//Xh0u2Pz5///6++wcJDH//1ofNLj/2h8qQ0tKSUhHO///Ylr//4goMkQ///9fITs8//+RIDi5/8oiL0ZNm////+/80RwnOCT6/4AH+//6CJb/5hATJyv//1FW//83FysxMSz9//8mHDdAQDL//1QSLCgeEf//WAQOHCQu//9UECax/9cRID9KSUlISDj//2Tq/7kVGy9IPP//VRU4Of///4gctf/FFCZDSvv/xgoIClQdJzgst//dBsH/vQXq/5ELFC4s//9Tev//CRAnLi+w/+f/tw8pOzwu//9SDzA0JhL//1kFDyEzNf//2dHR6v/WCx49SEhISEg5///a/+APECA/TDz//1ITNzr/////gLL/xA8kQpD/9QoHDBEVIDA7OCv//2fs/+KC//EICx4zKv//////uAgRJSsq9fVU//oJGjI8Mf//UhAuPjoq//9ZDSc7Qzb/////////1gkcPEZGRUVFN/////+gCRY1SUk5//9SEzc6///D///Y/8QPJD6v/98IDj7V0yAvOz8rxP/s/+f/7v+mCRAnNCn//+b//S8FFikrnP/lr/b/qQ4mOjD//1IPKzs/M///WREyREY2//+YfX7I/9YIHDlERENDRDb//9///mEXPUhGN///UhM3Ov//A8X////EDSM7jf/2BxFO//8ZIDU/Nkv///QP+v/6BAkbMTUo//9T4P/QBBgvLer///////QIGjIr//9UDyw8PTH//1wRMkJDNP//UQUKr//WCRo4QkNDREU2//9j6P/zIydCSDb//1QTNjn//wUDy///xAsjOzn8/8UMPP/+DxUwPz0o0P+hA7L/uAYOJzY1KP//W13//5UQJpP/4IaGhvX/pg4mKP//Ww4rOjsx//9kEDBBQjP//1YKHLP/2QoaOENDQ0NFNv//X0n7/+AUK0Q2//9cEjQ2//8IChHS/8cLIz82l////fD//ggRMD4+NGPyCQgJ9TELGS82NSn//2QFv//+WBns/4cGBwq2//gNHCP//2QPKTg4M///bxEtPkEz//9eEiq6/90OHDlFRUNDRDb//2QIjP//xyA2Nf//ZBQyNf//JxMkGdjLFCRAQSZ76f///+EIFDI+PDgmFxgWGhYYFiY2NzYtFxQTEhALDhQZGxwXERkhFQ0PFhwgFRESFio1NzIdGBcbMT5BNBwYGB4xKxsXGiU8RUVEREU5IBsZGRcREhwlNTQdGRgdNTcfGhofNy4cMSMtQEY6IBINSwkIEB43';
const REFERENCE_WIDTH = 109;
const REFERENCE_HEIGHT = 12;
const REFERENCE_GAME_HEIGHT = 1079;
const reference = Uint8Array.from(Buffer.from(REFERENCE, 'base64'));
const cache = new Map();
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const whiteness = (value) => clamp((value - 110) / 120, 0, 1);

function selectedHeroLabelRect(width, height) {
  if (![width, height].every(Number.isFinite) || width < 320 || height < 240) return null;
  const rect = { x: Math.round(width / 2 - height * 0.372), y: Math.round(height * 0.846), width: Math.round(height * 0.126), height: Math.round(height * 0.026), units: 'px' };
  return rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= width && rect.y + rect.height <= height ? rect : null;
}

function targetsFor(height) {
  if (cache.has(height)) return cache.get(height);
  const scale = height / REFERENCE_GAME_HEIGHT;
  const dimensions = new Set(); const targets = [];
  for (const width of [Math.floor(REFERENCE_WIDTH * scale), Math.round(REFERENCE_WIDTH * scale), Math.ceil(REFERENCE_WIDTH * scale)]) {
    for (const targetHeight of [Math.floor(REFERENCE_HEIGHT * scale), Math.round(REFERENCE_HEIGHT * scale), Math.ceil(REFERENCE_HEIGHT * scale)]) {
      if (width < 35 || targetHeight < 5) continue;
      const key = `${width}:${targetHeight}`; if (dimensions.has(key)) continue; dimensions.add(key);
      for (const phaseY of [-0.75, -0.375, 0, 0.375, 0.75]) for (const phaseX of [-0.5, 0, 0.5]) {
      const data = new Float32Array(width * targetHeight); let energy = 0;
      for (let y = 0; y < targetHeight; y++) for (let x = 0; x < width; x++) {
        const x0 = x * REFERENCE_WIDTH / width + phaseX; const x1 = (x + 1) * REFERENCE_WIDTH / width + phaseX;
        const y0 = y * REFERENCE_HEIGHT / targetHeight + phaseY; const y1 = (y + 1) * REFERENCE_HEIGHT / targetHeight + phaseY;
        let sum = 0; let weight = 0;
        for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const amount = Math.max(0, Math.min(x1, sx + 1) - Math.max(x0, sx)) * Math.max(0, Math.min(y1, sy + 1) - Math.max(y0, sy));
          sum += (sx >= 0 && sx < REFERENCE_WIDTH && sy >= 0 && sy < REFERENCE_HEIGHT ? reference[sy * REFERENCE_WIDTH + sx] : 45) * amount; weight += amount;
        }
        const value = whiteness(sum / weight); data[y * width + x] = value; energy += value * value;
      }
      targets.push({ width, height: targetHeight, data, energy });
      }
    }
  }
  cache.set(height, targets); if (cache.size > 8) cache.delete(cache.keys().next().value);
  return targets;
}

function analyzeSelectedHero(regions, originalSize = {}) {
  const unknown = { heroId: null, confidence: 0, source: 'selected_hero_label', reason: 'Selected hero title is not recognized', similarityIsProbability: false };
  if (!Number.isInteger(originalSize.width) || !Number.isInteger(originalSize.height) || originalSize.width < 320 || originalSize.height < 240 || originalSize.width > 16384 || originalSize.height > 2160) return { ...unknown, reason: 'Invalid selected hero capture size' };
  const region = Array.isArray(regions) ? regions.find(candidate => candidate?.kind === 'selected_hero_label') : regions;
  if (!region || region.kind !== 'selected_hero_label' || !Number.isInteger(region.width) || !Number.isInteger(region.height) || region.width < 35 || region.height < 5 || region.width > 280 || region.height > 64 || !region.rect) return { ...unknown, reason: 'Selected hero title crop is unavailable' };
  const bytes = region.data instanceof ArrayBuffer ? new Uint8Array(region.data) : region.data;
  if (!bytes || bytes.length !== region.width * region.height * 4 || !['x','y','width','height'].every(key => Number.isFinite(region.rect[key])) || region.rect.width !== region.width || region.rect.height !== region.height) return { ...unknown, reason: 'Selected hero title crop must retain native pixels' };
  const expected = selectedHeroLabelRect(originalSize.width, originalSize.height);
  if (!expected || Math.abs(region.rect.x - expected.x) > 2 || Math.abs(region.rect.y - expected.y) > 2 || Math.abs(region.rect.width - expected.width) > 2 || Math.abs(region.rect.height - expected.height) > 2) return { ...unknown, reason: 'Selected hero proof must come from the bottom HUD' };
  const actual = new Float32Array(region.width * region.height);
  for (let index = 0; index < actual.length; index++) actual[index] = whiteness(Math.min(bytes[index * 4], bytes[index * 4 + 1], bytes[index * 4 + 2]));
  let best = { confidence: 0 };
  for (const target of targetsFor(originalSize.height)) {
    if (target.width > region.width || target.height > region.height) continue;
    for (let y = 0; y <= region.height - target.height; y++) for (let x = 0; x <= region.width - target.width; x++) {
      let dot = 0; let energy = 0;
      for (let sy = 0; sy < target.height; sy++) for (let sx = 0; sx < target.width; sx++) {
        const value = actual[(y + sy) * region.width + x + sx];
        dot += value * target.data[sy * target.width + sx]; energy += value * value;
      }
      // Soft Dice penalizes extra letters or a blank/all-white crop as well as
      // missing letters. A bright background alone cannot prove the title.
      const confidence = target.energy + energy > 0 ? 2 * dot / (target.energy + energy) : 0;
      if (confidence > best.confidence) best = { confidence, x, y, width: target.width, height: target.height };
    }
  }
  if (best.confidence < 0.94) return { ...unknown, confidence: best.confidence };
  return { heroId: 42, confidence: best.confidence, source: 'selected_hero_label', reason: null, similarityIsProbability: false, rect: { x: region.rect.x + best.x, y: region.rect.y + best.y, width: best.width, height: best.height } };
}

module.exports = { selectedHeroLabelRect, analyzeSelectedHero };
