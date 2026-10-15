'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { providerHero } = require('../src/provider-hero.cjs');
const { normalizeBuildImport } = require('../src/build-import.cjs');
const { writeAtomic } = require('./update-d2pt.cjs');
const ROOT = path.resolve(__dirname, '..');
const CDN = 'https://cdn.cloudflare.steamstatic.com';
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
async function prepareCarryAssets() {
  const manifestPath = path.join(ROOT, 'data', 'assets', 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const jobs = new Map();
  for (const id of [8, 18, 44, 48]) {
    const hero = providerHero({ heroId: id });
    const data = JSON.parse(await fs.readFile(path.join(ROOT, 'data', `${hero.slug}.json`), 'utf8'));
    const sample = JSON.parse(await fs.readFile(path.join(ROOT, 'data', `opendota-${hero.slug}.json`), 'utf8'));
    const representative = sample.builds[0];
    const template = {
      kind: 'personal', heroId: id,
      description: `Редактируемый пример для ${hero.displayName} по последовательности покупок и навыков матча ${representative.representativeMatchId}. Это личный план, а не гарантия текущей меты. Уровни навыков восстановлены как минимально допустимые; их можно менять под линию.`,
      exampleSourceUrl: `https://www.opendota.com/matches/${representative.representativeMatchId}`,
      build: { role: 'carry', items: representative.sequence.map(item => ({ key: item.key, phase: item.stage })), skills: representative.skills.map(skill => ({ heroLevel: skill.heroLevel, abilityKey: skill.abilityKey })) },
    };
    normalizeBuildImport(template, data.items, { heroId: id });
    await writeAtomic(path.join(ROOT, 'data', `personal-build-template-${id}.json`), template);
    const keys = new Set(sample.builds.flatMap(route => route.sequence.map(item => item.key)));
    for (const key of keys) {
      const item = data.items[key];
      if (!manifest.items.some(entry => entry.key === key) && item?.img?.startsWith('/apps/dota2/')) jobs.set(key, item);
    }
  }
  for (const [key, item] of jobs) {
    const url = new URL(item.img, CDN).href;
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Valve item image HTTP ${response.status}: ${key}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.subarray(0, 8).equals(PNG)) throw new Error(`Invalid Valve item PNG: ${key}`);
    const file = `items/${key}.png`;
    await fs.writeFile(path.join(ROOT, 'data', 'assets', file), bytes);
    manifest.items.push({ key, id: item.id, name: item.dname, file, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), sourceUrl: url, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  }
  manifest.items.sort((a, b) => a.id - b.id);
  manifest.carryAssetsFetchedAt = new Date().toISOString();
  await writeAtomic(manifestPath, manifest);
  return { templates: 4, addedItemIcons: jobs.size, totalItemIcons: manifest.items.length };
}
module.exports = { prepareCarryAssets };
if (require.main === module) prepareCarryAssets().then(value => console.log(JSON.stringify(value))).catch(error => { console.error(error.message); process.exitCode = 1; });
