'use strict';

// The live ProTracker page remains a browsing link. Automated refresh uses
// the public OpenDota API; ProTracker imports require a permitted export.
// Nothing here runs during a match or bypasses a website challenge.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const { providerHero, heroSourceUrls } = require('../src/provider-hero.cjs');
const DESTINATION = path.join(ROOT, 'data', 'protracker-wraith-king.json');
const FRESH_DESTINATION = path.join(ROOT, 'data', 'fresh-build.json');
const SOURCE_URL = 'https://dota2protracker.com/hero/Wraith%20King';
const TERMS_URL = 'https://dota2protracker.com/terms-of-service';
const POPULARITY_URL = 'https://api.opendota.com/api/heroes/42/itemPopularity';
const OPENDOTA_PHASES = { start_game_items: 'start', early_game_items: 'early', mid_game_items: 'mid', late_game_items: 'late' };
const BUILD_ITEMS = new Set(['quelling_blade', 'tango', 'branches', 'magic_stick', 'bracer', 'magic_wand', 'phase_boots', 'power_treads', 'armlet', 'radiance', 'desolator', 'black_king_bar', 'blink', 'assault', 'abyssal_blade', 'monkey_king_bar', 'silver_edge', 'nullifier', 'satanic', 'aghanims_shard', 'ultimate_scepter', 'soul_ring', 'echo_sabre', 'harpoon', 'invis_sword', 'sange_and_yasha', 'skadi', 'bloodthorn', 'orchid', 'bfury']);
const PHASES = new Set(['start', 'early', 'mid', 'late', 'situational']);
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);

function finiteNumber(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${label}`);
  return value;
}

function optionalNumber(value, label, min, max) {
  return value == null ? null : finiteNumber(value, label, min, max);
}

function quantiles(value, label) {
  if (value == null) return null;
  if (typeof value === 'number') return finiteNumber(value, label, 0, 1000000);
  if (!plainObject(value)) throw new Error(`Invalid ${label}`);
  const result = {
    p25: finiteNumber(value.p25, `${label}.p25`, 0, 1000000),
    median: finiteNumber(value.median, `${label}.median`, 0, 1000000),
    p75: finiteNumber(value.p75, `${label}.p75`, 0, 1000000),
  };
  if (result.p25 > result.median || result.median > result.p75) throw new Error(`Unordered ${label} percentiles`);
  return result;
}

function validateImport(input, catalog, now = new Date().toISOString(), options = {}) {
  const hero = providerHero(options);
  if (!plainObject(input) || input.heroId !== hero.id || input.build?.role !== 'carry') throw new Error(`Expected ${hero.displayName} carry export (heroId ${hero.id})`);
  if (input.license?.applicationUseAllowed !== true || typeof input.license?.permissionReference !== 'string' || !input.license.permissionReference.trim()) {
    throw new Error('Application use permission is required for this source. ProTracker public terms do not allow scraping or using site data in applications.');
  }
  if (typeof input.sourceUrl !== 'string') throw new Error('Missing source URL');
  const url = new URL(input.sourceUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'dota2protracker.com' || !/^\/(hero|builds)\//.test(url.pathname)) throw new Error('Unexpected source URL');
  if (typeof input.patch?.name !== 'string' || !/^\d+\.\d+[a-z]?$/.test(input.patch.name)) throw new Error('Missing or invalid source patch');
  if (typeof input.fetchedAt !== 'string' || !Number.isFinite(Date.parse(input.fetchedAt)) || Date.parse(input.fetchedAt) > Date.parse(now) + 300000) throw new Error('Invalid source fetch timestamp');
  if (!Number.isInteger(input.sampleCount) || input.sampleCount < 1) throw new Error('Missing sample count');
  if (!Array.isArray(input.build.items) || input.build.items.length < 1 || input.build.items.length > 100) throw new Error('Expected nonempty item build');
  const seenItems = new Set();
  const items = input.build.items.map(item => {
    if (!plainObject(item) || typeof item.key !== 'string' || !/^[a-z_0-9]+$/.test(item.key) || !Object.hasOwn(catalog, item.key)) throw new Error(`Unknown item ${item?.key || '(missing)'}`);
    if (seenItems.has(item.key)) throw new Error(`Duplicate item ${item.key}`);
    seenItems.add(item.key);
    if (item.phase != null && !PHASES.has(item.phase)) throw new Error(`Invalid phase for ${item.key}`);
    return {
      key: item.key,
      timingMinutes: optionalNumber(item.timingMinutes, `${item.key}.timingMinutes`, 0, 180),
      frequency: optionalNumber(item.frequency, `${item.key}.frequency (fraction 0..1)`, 0, 1),
      phase: item.phase || 'situational',
    };
  });
  const skills = input.build.skills == null ? [] : input.build.skills;
  if (!Array.isArray(skills) || skills.length > 30) throw new Error('Invalid skill order');
  const seenLevels = new Set();
  const validatedSkills = skills.map(skill => {
    if (!plainObject(skill) || !Number.isInteger(skill.level) || skill.level < 1 || skill.level > 30 || seenLevels.has(skill.level) || typeof skill.key !== 'string' || !skill.key.startsWith(hero.abilityPrefix) || !/^[a-z_]+$/.test(skill.key)) throw new Error('Invalid skill order entry');
    seenLevels.add(skill.level);
    return { level: skill.level, key: skill.key, frequency: optionalNumber(skill.frequency, 'skill frequency', 0, 1) };
  });
  const benchmarks = input.benchmarks == null ? [] : input.benchmarks;
  if (!Array.isArray(benchmarks) || benchmarks.length > 30) throw new Error('Invalid benchmarks');
  const seenMinutes = new Set();
  const validatedBenchmarks = benchmarks.map(checkpoint => {
    if (!plainObject(checkpoint) || !Number.isInteger(checkpoint.minute) || checkpoint.minute < 1 || checkpoint.minute > 120 || seenMinutes.has(checkpoint.minute)) throw new Error('Invalid checkpoint minute');
    seenMinutes.add(checkpoint.minute);
    if (!Number.isInteger(checkpoint.sampleCount) || checkpoint.sampleCount < 1 || checkpoint.sampleCount > input.sampleCount) throw new Error('Invalid checkpoint sample count');
    if (typeof checkpoint.provenance !== 'string' || !checkpoint.provenance.trim()) throw new Error('Each farm checkpoint requires direct observation provenance');
    const result = {
      minute: checkpoint.minute,
      lastHits: quantiles(checkpoint.lastHits, 'lastHits'),
      netWorth: quantiles(checkpoint.netWorth, 'netWorth'),
      sampleCount: checkpoint.sampleCount,
      provenance: checkpoint.provenance.trim(),
    };
    if (result.lastHits == null && result.netWorth == null) throw new Error('Empty farm checkpoint');
    return result;
  }).sort((a, b) => a.minute - b.minute);
  return {
    schemaVersion: 1, heroId: hero.id, source: 'Dota2ProTracker authorized carry-build export', sourceUrl: url.href,
    fetchedAt: input.fetchedAt, importedAt: now, status: 'available', sampleCount: input.sampleCount,
    patch: { name: input.patch.name, scope: typeof input.patch.scope === 'string' ? input.patch.scope : 'As supplied by permitted export' },
    license: { applicationUseAllowed: true, permissionReference: input.license.permissionReference.trim(), termsUrl: TERMS_URL },
    build: { role: 'carry', items, skills: validatedSkills }, benchmarks: validatedBenchmarks,
    provenance: {
      kind: 'authorized_existing_export', population: typeof input.provenance?.population === 'string' ? input.provenance.population : 'Not specified by export',
      timeWindow: input.provenance?.timeWindow ?? null,
      caveats: ['Purchase frequency is observational and does not prove an optimal item.', 'Benchmarks require direct minute-specific observations; total earned gold is not net worth.'],
    },
  };
}

function normalizePopularity(popularity, catalog, now = new Date().toISOString(), options = {}) {
  const hero = providerHero(options), urls = heroSourceUrls(hero);
  if (!plainObject(popularity) || !plainObject(catalog)) throw new Error('Invalid OpenDota purchase data');
  const byId = new Map(Object.entries(catalog).map(([key, item]) => [String(item.id), key]));
  const items = [];
  const unmappedIds = new Set();
  for (const [sourcePhase, phase] of Object.entries(OPENDOTA_PHASES)) {
    const counts = popularity[sourcePhase];
    if (!plainObject(counts)) throw new Error(`Missing OpenDota phase ${sourcePhase}`);
    const candidates = [];
    for (const [id, count] of Object.entries(counts)) {
      if (!/^\d+$/.test(id) || !Number.isInteger(count) || count < 0) throw new Error(`Invalid purchase count ${sourcePhase}/${id}`);
      const key = byId.get(id);
      if (!key) { unmappedIds.add(id); continue; }
      if (count > 0 && BUILD_ITEMS.has(key)) candidates.push({ key, phase, evidenceCount: count });
    }
    candidates.sort((a, b) => b.evidenceCount - a.evidenceCount || a.key.localeCompare(b.key));
    items.push(...candidates.map((item, index) => ({ ...item, phaseRank: index + 1, timingMinutes: null, frequency: null })));
  }
  if (!items.length) throw new Error('OpenDota returned no recognized purchases');
  return {
    schemaVersion: 1, heroId: hero.id, source: 'OpenDota', sourceUrl: urls.popularity,
    externalUrl: urls.d2pt, fetchedAt: now, status: 'available', patchVerified: false, patch: null, sampleCount: null,
    build: { role: 'unknown', items }, benchmarks: [],
    provenance: {
      kind: 'existing_aggregate_dataset', population: 'Professional item purchases; player role is not exposed by this endpoint',
      timeWindow: null, patchFiltered: false, uniqueMatchCount: null,
      caveats: ['The API does not expose the aggregate time window, patch filter, or player role.', 'Counts represent purchases and are not a percentage of unique matches.', 'Phase ranks are observed popularity, not a fixed carry build or evidence of an optimal item.', 'No purchase timings or minute-specific last-hit/net-worth benchmarks are supplied by this endpoint.'],
    },
    licenses: { source: 'OpenDota public API', documentationUrl: 'https://docs.opendota.com/' },
    validation: { unknownItemIds: [...unmappedIds].sort((a, b) => Number(a) - Number(b)) },
  };
}

async function writeCache(destination, value) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function refreshOpenDota(options = {}) {
  const hero = providerHero(options), urls = heroSourceUrls(hero);
  const catalog = options.catalog || JSON.parse(await fs.readFile(path.join(ROOT, 'data', `${hero.slug}.json`), 'utf8')).items;
  const response = await (options.fetch || fetch)(urls.popularity, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'CoreCoach-PersonalPrototype/0.6' } });
  if (!response.ok) throw new Error(`OpenDota update HTTP ${response.status}; existing cache preserved`);
  const popularity = await response.json();
  const result = normalizePopularity(popularity, catalog, options.now, { heroId: hero.id });
  await writeCache(options.destination || path.join(ROOT, 'data', hero.id === 42 ? 'fresh-build.json' : `fresh-${hero.slug}.json`), result);
  return result;
}

function validatePersonalImport(input, catalog, now = new Date().toISOString(), options = {}) {
  const hero = providerHero(options);
  if (!plainObject(input) || input.heroId !== hero.id || input.build?.role !== 'carry' || !Array.isArray(input.build.items) || !input.build.items.length || input.build.items.length > 30) throw new Error(`Expected personally authored ${hero.displayName} carry route`);
  const seen = new Set();
  const items = input.build.items.map(item => {
    if (!plainObject(item) || typeof item.key !== 'string' || !Object.hasOwn(catalog, item.key) || seen.has(item.key)) throw new Error('Unknown or duplicate item in personal build');
    seen.add(item.key);
    if (item.phase != null && !PHASES.has(item.phase)) throw new Error('Invalid personal build phase');
    return { key: item.key, phase: item.phase || 'situational', targetMinutes: optionalNumber(item.targetMinutes, 'personal target minutes', 0, 180) };
  });
  return {
    schemaVersion: 1, heroId: hero.id, source: 'Personal build', status: 'available', fetchedAt: now,
    patchVerified: false, sampleCount: null, externalUrl: heroSourceUrls(hero).d2pt, build: { role: 'carry', items }, benchmarks: [],
    provenance: { kind: 'personal_preference', caveats: ['This is a personally authored route, not a verified ProTracker export, empirical purchase frequency, or normative farm benchmark.'] },
  };
}

async function importFile(sourceFile, options = {}) {
  const hero = providerHero(options);
  const catalog = options.catalog || JSON.parse(await fs.readFile(path.join(ROOT, 'data', `${hero.slug}.json`), 'utf8')).items;
  const bytes = await fs.readFile(sourceFile);
  const imported = validateImport(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')), catalog, options.now, { heroId: hero.id });
  imported.provenance.importSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const destination = options.destination || path.join(ROOT, 'data', `protracker-${hero.slug}.json`);
  await writeCache(destination, imported);
  return imported;
}

async function main(args = process.argv.slice(2)) {
  const parsed = require('../src/provider-hero.cjs').parseProviderArgs(args);
  const hero = providerHero(parsed), urls = heroSourceUrls(hero);
  args = parsed.args;
  if (args.length === 0) {
    const updated = await refreshOpenDota({ heroId: hero.id });
    console.log(`Refreshed ${hero.displayName} OpenDota cache: ${updated.build.items.length} item/phase observations; patch, player role, and sample window are not exposed by the API. Live guide: ${urls.d2pt}`);
    return;
  }
  if (args.length === 2 && args[0] === '--import') {
    const imported = await importFile(path.resolve(args[1]), { heroId: hero.id });
    console.log(`Imported permitted ${imported.patch.name} carry build: ${imported.sampleCount} matches, ${imported.build.items.length} items; original fetch ${imported.fetchedAt}.`);
    return;
  }
  if (args.length === 2 && args[0] === '--personal-import') {
    const catalog = JSON.parse(await fs.readFile(path.join(ROOT, 'data', `${hero.slug}.json`), 'utf8')).items;
    const input = JSON.parse((await fs.readFile(path.resolve(args[1]), 'utf8')).replace(/^\uFEFF/, ''));
    const personal = validatePersonalImport(input, catalog, undefined, { heroId: hero.id });
    await writeCache(path.join(ROOT, 'data', `personal-${hero.slug}.json`), personal);
    console.log(`Imported ${personal.build.items.length} personally authored items. This does not replace source statistics.`);
    return;
  }
  throw new Error(`Usage: node scripts/update-protracker.cjs [--hero ID] [--import permitted-export.json | --personal-import personal-route.json]. Website scraping is disabled; live guide: ${urls.d2pt}`);
}

module.exports = { SOURCE_URL, TERMS_URL, POPULARITY_URL, validateImport, validatePersonalImport, normalizePopularity, refreshOpenDota, importFile, main };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
