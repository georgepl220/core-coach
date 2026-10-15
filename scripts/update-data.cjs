'use strict';

// This updates existing public data; it does not fabricate purchase counts or
// claim that the most popular purchase is the optimal action in a match.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'data', 'wraith-king.json');
const ASSETS = path.join(ROOT, 'data', 'assets');
const CONSTANTS = 'https://raw.githubusercontent.com/odota/dotaconstants/master/build/';
const SOURCES = {
  popularity: 'https://api.opendota.com/api/heroes/42/itemPopularity',
  items: `${CONSTANTS}items.json`, heroes: `${CONSTANTS}heroes.json`,
  abilities: `${CONSTANTS}abilities.json`, patches: `${CONSTANTS}patch.json`,
  constantsLicense: 'https://github.com/odota/dotaconstants/blob/master/LICENSE',
  openDotaDocs: 'https://docs.opendota.com/',
  heroMechanics: 'https://www.dota2.com/hero/wraithking',
};
const CDN = 'https://cdn.cloudflare.steamstatic.com';
const PHASES = ['start_game_items', 'early_game_items', 'mid_game_items', 'late_game_items'];
const ITEM_ASSETS = ['quelling_blade', 'tango', 'branches', 'power_treads', 'phase_boots', 'armlet', 'radiance', 'desolator', 'black_king_bar', 'blink', 'assault', 'abyssal_blade', 'monkey_king_bar', 'silver_edge', 'nullifier', 'relic'];
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function get(url, type = 'json') {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(25000), headers: { 'User-Agent': 'WraithCoach-PersonalPrototype/0.1' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
      if (type === 'json') return await response.json();
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.subarray(0, 8).equals(pngSignature)) throw new Error(`Expected PNG: ${url}`);
      return bytes;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 1000));
    }
  }
  throw lastError;
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temp, file);
}

function validatePopularity(popularity) {
  for (const phase of PHASES) {
    const counts = popularity[phase];
    if (!counts || Array.isArray(counts) || typeof counts !== 'object') throw new Error(`Missing OpenDota phase ${phase}`);
    for (const [id, count] of Object.entries(counts)) {
      if (!/^\d+$/.test(id) || !Number.isFinite(count) || count < 0) throw new Error(`Invalid purchase count ${phase}/${id}`);
    }
  }
  if (!PHASES.some(phase => Object.keys(popularity[phase]).length)) throw new Error('OpenDota returned empty purchase data');
}

async function downloadAssets(heroes, items, fetchedAt, force = false) {
  const manifest = { schemaVersion: 1, fetchedAt, source: 'Valve Dota 2 CDN; paths from OpenDota dotaconstants', sourceUrls: [CDN, SOURCES.heroes, SOURCES.items], portraits: [], minimap: [], items: [], errors: [] };
  const jobs = [];
  for (const hero of Object.values(heroes)) {
    const slug = hero.name.replace(/^npc_dota_hero_/, '');
    for (const [group, source] of [['portraits', hero.img], ['minimap', hero.icon]]) {
      if (typeof source !== 'string' || !source.startsWith('/apps/dota2/')) continue;
      jobs.push({ group, url: new URL(source, CDN).href, entry: { heroId: hero.id, name: hero.name, localizedName: hero.localized_name, file: `${group}/${slug}.png` } });
    }
  }
  for (const key of ITEM_ASSETS) {
    const item = items[key];
    if (item?.img?.startsWith('/apps/dota2/')) jobs.push({ group: 'items', url: new URL(item.img, CDN).href, entry: { key, id: item.id, name: item.dname, file: `items/${key}.png` } });
  }
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const job = jobs[next++];
      const file = path.join(ASSETS, job.entry.file);
      try {
        let bytes = null;
        if (!force) {
          try { bytes = await fs.readFile(file); } catch {}
          if (bytes && !bytes.subarray(0, 8).equals(pngSignature)) bytes = null;
        }
        if (!bytes) {
          bytes = await get(job.url, 'png');
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, bytes);
        }
        const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
        manifest[job.group].push({ ...job.entry, width, height, sourceUrl: job.url, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
      } catch (error) {
        manifest.errors.push({ ...job.entry, sourceUrl: job.url, error: error.message });
      }
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  for (const group of ['portraits', 'minimap']) manifest[group].sort((a, b) => a.heroId - b.heroId);
  manifest.items.sort((a, b) => a.id - b.id);
  await writeJson(path.join(ASSETS, 'manifest.json'), manifest);
  console.log(`Assets: ${manifest.portraits.length} portraits, ${manifest.minimap.length} minimap icons, ${manifest.items.length} items; ${manifest.errors.length} failures.`);
  return manifest;
}

async function main() {
  const skipAssets = process.argv.includes('--no-assets');
  const forceAssets = process.argv.includes('--force-assets');
  const fetchedAt = new Date().toISOString();
  console.log('Fetching existing OpenDota purchase dataset and Dota constants…');
  const [popularity, fullItems, fullHeroes, fullAbilities, patches] = await Promise.all([
    get(SOURCES.popularity), get(SOURCES.items), get(SOURCES.heroes), get(SOURCES.abilities), get(SOURCES.patches),
  ]);
  validatePopularity(popularity);
  if (fullHeroes['42']?.name !== 'npc_dota_hero_skeleton_king') throw new Error('Hero 42 is not Wraith King in the fetched constants');
  const items = Object.fromEntries(Object.entries(fullItems).filter(([, item]) => Number.isFinite(item.id)).map(([key, item]) => [key, {
    id: item.id, dname: item.dname || key, cost: Number.isFinite(item.cost) ? item.cost : null,
    components: Array.isArray(item.components) ? item.components : [], img: item.img,
  }]));
  const heroes = Object.fromEntries(Object.entries(fullHeroes).map(([id, hero]) => [id, { id: hero.id, name: hero.name, localizedName: hero.localized_name, localized_name: hero.localized_name, primary_attr: hero.primary_attr, attack_type: hero.attack_type, roles: hero.roles, portrait: hero.img, minimapIcon: hero.icon }]));
  const abilities = Object.fromEntries(Object.entries(fullAbilities).filter(([name]) => name.startsWith('skeleton_king_')).map(([name, ability]) => [name, {
    dname: ability.dname, description: ability.desc, manaCost: ability.mc, mc: ability.mc, cooldown: ability.cd, cd: ability.cd, attributes: ability.attrib, isInnate: ability.is_innate === true, img: ability.img,
  }]));
  const latestPatch = Array.isArray(patches) ? patches.filter(patch => Date.parse(patch.date) <= Date.now()).sort((a, b) => Date.parse(a.date) - Date.parse(b.date)).at(-1) : null;
  const unknownIds = [...new Set(PHASES.flatMap(phase => Object.keys(popularity[phase])))].filter(id => !Object.values(items).some(item => String(item.id) === id));
  const dataset = {
    schemaVersion: 1, heroId: 42, source: 'OpenDota: professional item-purchase counts by game phase',
    fetchedAt, sourceUrls: SOURCES,
    patch: latestPatch ? { id: latestPatch.id, name: latestPatch.name, date: latestPatch.date, scope: 'Latest entry in dotaconstants, not a filter applied to the purchase dataset' } : null,
    provenance: {
      kind: 'existing_aggregate_dataset', population: 'professional games (as documented by OpenDota)',
      observation: 'item popularity counts by phase', patchFiltered: false, uniqueMatchCount: null,
      caveats: ['The API does not expose the aggregate time window or patch filter.', 'Counts represent purchases, not evidence of an optimal item or a causal win-rate improvement.', 'Phase counts include components; do not present their sum as a number of unique matches.', 'Current constants are maintained by OpenDota and may lag the installed game patch.'],
    },
    licenses: { constants: 'MIT (odota/dotaconstants)', images: 'Valve game assets; downloaded from Valve CDN for this personal prototype', purchaseData: 'OpenDota public API; see source API documentation' },
    popularity, items, heroes, abilities, validation: { unknownPopularityItemIds: unknownIds },
  };
  await writeJson(DATA_FILE, dataset);
  console.log(`Saved genuine data: ${Object.keys(items).length} items, ${Object.keys(heroes).length} heroes. Latest constants patch: ${latestPatch?.name || 'unknown'}.`);
  if (unknownIds.length) console.warn(`Purchase IDs missing from constants: ${unknownIds.join(', ')}`);
  if (!skipAssets) {
    const manifest = await downloadAssets(fullHeroes, fullItems, fetchedAt, forceAssets);
    if (manifest.errors.length) console.warn('Some images could not be downloaded; manifest.errors records each failure.');
  }
  if (!process.argv.includes('--no-builds')) {
    try {
      const carry = await require('./update-d2pt.cjs').refreshBuilds({ catalog: items, patches, now: fetchedAt });
      console.log(`Carry observations: ${carry.sampleCount} parsed matches, ${carry.windowText}, base patch ${carry.patch.name}. Minor patch not verified.`);
    } catch (error) {
      console.warn(`Carry-build refresh unavailable: ${error.message}. The previously validated build cache is kept.`);
    }
  }
}

main().catch(error => { console.error(`Update failed: ${error.message}. Existing data is preserved until complete JSON validation succeeds.`); process.exitCode = 1; });
