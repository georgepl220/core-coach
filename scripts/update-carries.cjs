'use strict';

// Build the four additional carry datasets from public, attributable sources.
// STRATZ remains the primary in-app provider; this supplies its token-free
// OpenDota fallback and Valve's actual learnable ability catalog.
const fs = require('node:fs/promises');
const path = require('node:path');
const { providerHero, heroSourceUrls } = require('../src/provider-hero.cjs');
const { abilityCatalogFromValve } = require('../src/build-import.cjs');
const { extractCarry, aggregate, writeAtomic } = require('./update-d2pt.cjs');
const ROOT = path.resolve(__dirname, '..');
const CONSTANTS = 'https://raw.githubusercontent.com/odota/dotaconstants/master/build/';
const PHASES = ['start_game_items', 'early_game_items', 'mid_game_items', 'late_game_items'];

async function updateCarries(options = {}) {
  const ids = options.heroIds || [8, 18, 44, 48];
  const now = options.now || new Date().toISOString();
  const request = options.fetch || fetch;
  const get = async url => {
    const response = await request(url, { signal: AbortSignal.timeout(25000), headers: { 'User-Agent': 'CoreCoach-PersonalPrototype/0.6' } });
    if (!response.ok) throw new Error(`Public dataset HTTP ${response.status}: ${url}`);
    return response.json();
  };
  const [fullItems, fullHeroes, patches] = await Promise.all(['items.json', 'heroes.json', 'patch.json'].map(name => get(`${CONSTANTS}${name}`)));
  const items = Object.fromEntries(Object.entries(fullItems).filter(([, item]) => Number.isFinite(item.id)).map(([key, item]) => [key, { id: item.id, dname: item.dname || key, cost: Number.isFinite(item.cost) ? item.cost : null, components: Array.isArray(item.components) ? item.components : [], img: item.img }]));
  const heroes = Object.fromEntries(Object.entries(fullHeroes).map(([id, hero]) => [id, { id: hero.id, name: hero.name, localizedName: hero.localized_name, localized_name: hero.localized_name, primary_attr: hero.primary_attr, attack_type: hero.attack_type, roles: hero.roles, portrait: hero.img, minimapIcon: hero.icon }]));
  const latestPatch = patches.filter(value => Date.parse(value.date) <= Date.parse(now)).sort((a, b) => Date.parse(a.date) - Date.parse(b.date)).at(-1);
  const outputs = [];
  // Public OpenDota requests are paced; no replay-parse jobs or account data.
  const pacedGet = async url => { const value = await get(url); if (options.delayMs !== 0) await new Promise(resolve => setTimeout(resolve, options.delayMs ?? 1200)); return value; };
  for (const id of ids) {
    const hero = providerHero({ heroId: id }), urls = heroSourceUrls(hero);
    const raw = await get(urls.valve);
    const abilityCatalog = abilityCatalogFromValve(raw, { heroId: id });
    const valveHero = raw.result.data.heroes.find(value => value.id === id);
    if (!valveHero || heroes[id]?.name !== valveHero.name) throw new Error(`Hero catalog mismatch: ${hero.displayName}`);
    const popularity = await pacedGet(urls.popularity);
    for (const phase of PHASES) {
      if (!popularity[phase] || Array.isArray(popularity[phase]) || typeof popularity[phase] !== 'object' || Object.values(popularity[phase]).some(count => !Number.isFinite(count) || count < 0)) throw new Error(`Invalid popularity phase: ${hero.displayName}/${phase}`);
    }
    const abilities = Object.fromEntries((valveHero.abilities || []).map(ability => [ability.name, { ...abilityCatalog[ability.name], dname: ability.name_loc, description: ability.desc_loc, manaCost: ability.mana_costs, mc: ability.mana_costs, cooldown: ability.cooldowns, cd: ability.cooldowns, attributes: ability.special_values, img: `/apps/dota2/images/dota_react/abilities/${ability.name}.png` }]));
    const unknownIds = [...new Set(PHASES.flatMap(phase => Object.keys(popularity[phase])))].filter(itemId => !Object.values(items).some(item => String(item.id) === itemId));
    const dataset = {
      schemaVersion: 1, heroId: id, source: 'OpenDota: professional item-purchase counts by game phase', fetchedAt: now,
      sourceUrls: { popularity: urls.popularity, items: `${CONSTANTS}items.json`, heroes: `${CONSTANTS}heroes.json`, abilities: urls.valve, patches: `${CONSTANTS}patch.json`, constantsLicense: 'https://github.com/odota/dotaconstants/blob/master/LICENSE', openDotaDocs: 'https://docs.opendota.com/', heroMechanics: urls.valve },
      patch: latestPatch ? { ...latestPatch, scope: 'Latest dotaconstants entry, not a filter applied to item popularity' } : null,
      provenance: { kind: 'existing_aggregate_dataset', population: 'professional games (as documented by OpenDota)', observation: 'item popularity counts by phase', patchFiltered: false, uniqueMatchCount: null, caveats: ['The endpoint does not expose a sample window, patch filter, carry role, or unique match count.', 'Purchase popularity is descriptive; it does not establish an optimal build.'] },
      licenses: { constants: 'MIT (odota/dotaconstants)', images: 'Valve game assets for this personal prototype', purchaseData: 'OpenDota public API; see source documentation' },
      popularity, items, heroes, abilities, currentAbilityCatalog: abilityCatalog,
      abilityCatalogSourceUrl: urls.valve, abilityCatalogFetchedAt: now,
      validation: { unknownPopularityItemIds: unknownIds },
    };
    await writeAtomic(path.join(ROOT, 'data', 'sources', `${hero.slug}-live-abilities.json`), { ...raw, sourceUrl: urls.valve, fetchedAt: now });
    await writeAtomic(path.join(ROOT, 'data', `${hero.slug}.json`), dataset);
    const candidates = await pacedGet(urls.matches);
    if (!Array.isArray(candidates)) throw new Error(`Invalid parsed match list: ${hero.displayName}`);
    const cutoff = Date.parse(now) / 1000 - (options.lookbackDays || 45) * 86400;
    const selected = candidates.filter(match => Number.isSafeInteger(match.match_id) && match.duration >= 600 && match.start_time >= cutoff && match.start_time <= Date.parse(now) / 1000).sort((a, b) => b.start_time - a.start_time).slice(0, options.maxMatches || 12);
    const observations = [];
    for (const candidate of selected) {
      const match = await pacedGet(`https://api.opendota.com/api/matches/${candidate.match_id}`);
      const observation = extractCarry(match, items, { heroId: id, abilityCatalog });
      if (observation) observations.push(observation);
    }
    const result = aggregate(observations, { heroId: id, abilityCatalog, patches, now, lookbackDays: options.lookbackDays || 45 });
    result.validation = { attemptedMatches: selected.length, retainedCarries: result.sampleCount, fetchErrors: [] };
    await writeAtomic(path.join(ROOT, 'data', `opendota-${hero.slug}.json`), result);
    outputs.push({ heroId: id, name: hero.displayName, sampleCount: result.sampleCount, routes: result.builds.length, skillRoutes: result.builds.filter(build => build.skills.length).length, patch: result.patch.name, window: result.windowText });
    options.onProgress?.(outputs.at(-1));
  }
  return outputs;
}
module.exports = { updateCarries };
if (require.main === module) updateCarries({ onProgress: value => console.log(JSON.stringify(value)) }).catch(error => { console.error(error.message); process.exitCode = 1; });
