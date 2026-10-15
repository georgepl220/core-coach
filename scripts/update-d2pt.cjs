'use strict';

// D2PT is linked for personal browsing; its public terms do not permit an
// application dataset. This fallback uses the documented public OpenDota API.
// Refresh is explicit and offline coaching never starts network requests.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const { providerHero, heroSourceUrls } = require('../src/provider-hero.cjs');
const SOURCE_URL = 'https://api.opendota.com/api/heroes/42/matches';
const D2PT_REFERENCE = 'https://dota2protracker.com/hero/Wraith%20King';
const DESTINATION = path.join(ROOT, 'data', 'd2pt-wraith-king.json');
const PATCH_URL = 'https://raw.githubusercontent.com/odota/dotaconstants/master/build/patch.json';
const VALVE_HERO_URL = 'https://www.dota2.com/datafeed/herodata?language=english&hero_id=42';
const BUILD_ITEMS = new Set(['magic_wand', 'bracer', 'wraith_band', 'phase_boots', 'power_treads', 'armlet', 'radiance', 'desolator', 'black_king_bar', 'blink', 'assault', 'abyssal_blade', 'monkey_king_bar', 'silver_edge', 'nullifier', 'satanic', 'aghanims_shard', 'ultimate_scepter', 'soul_ring', 'echo_sabre', 'harpoon', 'invis_sword', 'sange_and_yasha', 'skadi', 'bloodthorn', 'orchid', 'bfury', 'overwhelming_blink', 'swift_blink', 'moon_shard', 'manta', 'yasha', 'sange', 'mask_of_madness', 'maelstrom', 'mjollnir', 'butterfly', 'diffusal_blade', 'disperser', 'falcon_blade', 'greater_crit', 'dragon_lance', 'hurricane_pike', 'boots_of_travel', 'boots_of_travel_2', 'helm_of_the_dominator', 'sange_and_yasha', 'wraith_band']);
const SMALL_ITEMS = new Set(['magic_wand', 'bracer', 'wraith_band', 'phase_boots', 'power_treads', 'soul_ring']);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const isRadiant = player => Number(player.player_slot) < 128;
const stage = seconds => seconds <= 0 ? 'start' : seconds < 600 ? 'early' : seconds < 1800 ? 'mid' : 'late';

function percentile(values, q) {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position), upper = Math.ceil(position);
  return Math.round((sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)) * 100) / 100;
}

function timelineValue(player, field, seconds) {
  if (!Array.isArray(player.times) || !Array.isArray(player[field])) return null;
  const index = player.times.indexOf(seconds);
  const value = index < 0 ? null : player[field][index];
  return finite(value) && value >= 0 ? value : null;
}

function extractCarry(match, catalog = {}, options = {}) {
  const hero = providerHero(options);
  if (!match || !Number.isSafeInteger(match.match_id) || !finite(match.start_time) || !finite(match.duration) || match.duration < 600 || !Number.isInteger(match.patch) || !Array.isArray(match.players)) return null;
  const candidates = match.players.filter(player => player.hero_id === hero.id);
  if (candidates.length !== 1) return null;
  const player = candidates[0];
  if (!player || player.lane_role !== 1 || player.is_roaming === true || (Number.isInteger(player.position_est) && player.position_est !== 1) || !Array.isArray(player.purchase_log)) return null;
  const observed = player.purchase_log.filter(item => item && typeof item.key === 'string' && finite(item.time) && item.time >= -600 && item.time <= match.duration && Object.hasOwn(catalog, item.key)).sort((a, b) => a.time - b.time);
  if (!observed.length) return null;
  const seen = new Set();
  const sequence = observed.filter(item => {
    // Keep the actual opening purchases and selected completed build items,
    // never promote a component to a completed-item purchase.
    if ((item.time > 0 && !BUILD_ITEMS.has(item.key)) || seen.has(item.key)) return false;
    seen.add(item.key);
    return true;
  }).map(item => ({ key: item.key, timeSeconds: item.time, stage: stage(item.time) }));
  const won = typeof match.radiant_win === 'boolean' ? match.radiant_win === isRadiant(player) : null;
  const enemies = match.players.filter(enemy => isRadiant(enemy) !== isRadiant(player) && Number.isInteger(player.lane) && enemy.lane === player.lane && enemy.is_roaming !== true && Number.isInteger(enemy.hero_id) && enemy.hero_id > 0).map(enemy => ({
    enemyHeroId: enemy.hero_id, positionEstimate: enemy.position_est ?? null, laneRole: enemy.lane_role ?? null,
    netWorth10: timelineValue(enemy, 'networth_t', 600), lastHits10: timelineValue(enemy, 'lh_t', 600),
  }));
  const timelines = { lastHits: [], netWorth: [] };
  for (const minute of [5, 10, 15, 20, 25, 30]) {
    const lastHits = timelineValue(player, 'lh_t', minute * 60);
    const netWorth = timelineValue(player, 'networth_t', minute * 60);
    if (lastHits != null) timelines.lastHits.push({ minute, value: lastHits });
    if (netWorth != null) timelines.netWorth.push({ minute, value: netWorth });
  }
  return {
    matchId: match.match_id, startTime: match.start_time, patchId: match.patch, durationSeconds: match.duration,
    sourceUrl: `https://api.opendota.com/api/matches/${match.match_id}`, replayUrl: `https://www.opendota.com/matches/${match.match_id}`,
    heroId: hero.id, leagueId: match.leagueid ?? null, won, role: 'carry', roleEvidence: { heroId: hero.id, laneRole: 1, positionEstimate: player.position_est ?? null, roaming: false },
    sequence, timelines, enemies, purchaseLogSha256: crypto.createHash('sha256').update(JSON.stringify(observed)).digest('hex'),
    ...(options.abilityCatalog ? { skillObservation: require('../src/build-import.cjs').extractObservedSkills(player, options.abilityCatalog, match.match_id) } : {}),
  };
}

function aggregate(observations, options = {}) {
  const hero = providerHero(options), urls = heroSourceUrls(hero);
  const fetchedAt = options.now || new Date().toISOString();
  const valid = observations.filter(record => record && (record.heroId == null ? hero.id === 42 : record.heroId === hero.id) && record.role === 'carry' && Number.isInteger(record.patchId) && finite(record.startTime)).sort((a, b) => b.startTime - a.startTime);
  if (!valid.length) throw new Error(`No parsed ${hero.displayName} carry observations; existing cache preserved`);
  const patchId = valid[0].patchId;
  const records = valid.filter(record => record.patchId === patchId);
  const patchConstant = options.patches?.find(patch => patch.id === patchId);
  const groups = new Map();
  const itemMap = new Map();
  for (const record of records) {
    const major = record.sequence.filter(item => BUILD_ITEMS.has(item.key) && !SMALL_ITEMS.has(item.key));
    if (major.length) {
      const signature = major.slice(0, 2).map(item => item.key).join('>');
      if (!groups.has(signature)) groups.set(signature, []);
      groups.get(signature).push(record);
    }
    for (const item of record.sequence.filter(item => item.timeSeconds > 0)) {
      if (!itemMap.has(item.key)) itemMap.set(item.key, []);
      itemMap.get(item.key).push({ ...item, matchId: record.matchId, won: record.won });
    }
  }
  const builds = [...groups.entries()].map(([signature, group]) => {
    const representative = group[0];
    const outcomes = group.filter(record => typeof record.won === 'boolean');
    return {
      id: signature.replaceAll('>', '-'), matches: group.length,
      winRate: outcomes.length ? outcomes.filter(record => record.won).length / outcomes.length : null,
      frequency: group.length / records.length, sequence: representative.sequence,
      representativeMatchId: representative.matchId, representativeDate: new Date(representative.startTime * 1000).toISOString(),
      sourceMatchIds: group.map(record => record.matchId), timingKind: 'actual_purchase_log_of_representative_match',
      skills: representative.skillObservation?.skills || [],
      skillOrderKind: representative.skillObservation?.kind || 'unavailable',
      skillLevelsVerified: representative.skillObservation?.levelVerified === true,
      skillSourceMatchId: representative.skillObservation?.skills?.length ? representative.matchId : null,
      skillUnknownAbilityIds: representative.skillObservation?.unknownAbilityIds || [],
      skillOrderComplete: (representative.skillObservation?.unknownAbilityIds?.length || 0) === 0,
    };
  }).sort((a, b) => b.matches - a.matches || Date.parse(b.representativeDate) - Date.parse(a.representativeDate));
  if (!builds.length) throw new Error('No completed carry build items in parsed sample; existing cache preserved');
  const itemStats = [...itemMap.entries()].map(([key, entries]) => ({ key, matches: entries.length, frequency: entries.length / records.length, medianTimeSeconds: percentile(entries.map(entry => entry.timeSeconds), 0.5), p25TimeSeconds: percentile(entries.map(entry => entry.timeSeconds), 0.25), p75TimeSeconds: percentile(entries.map(entry => entry.timeSeconds), 0.75) })).sort((a, b) => b.matches - a.matches);
  const benchmarks = { lastHits: [], netWorth: [] };
  for (const field of ['lastHits', 'netWorth']) {
    for (const minute of [5, 10, 15, 20, 25, 30]) {
      const entries = records.map(record => record.timelines[field].find(point => point.minute === minute)?.value).filter(finite);
      // A descriptive sample is never presented as a universal required norm.
      if (entries.length >= (options.minimumBenchmarkSample || 3)) benchmarks[field].push({ minute, p25: percentile(entries, 0.25), p50: percentile(entries, 0.5), p75: percentile(entries, 0.75), sampleSize: entries.length });
    }
  }
  const matchupMap = new Map();
  for (const record of records) {
    const ownNetWorth = record.timelines.netWorth.find(point => point.minute === 10)?.value;
    for (const enemy of record.enemies) {
      if (!matchupMap.has(enemy.enemyHeroId)) matchupMap.set(enemy.enemyHeroId, { enemyHeroId: enemy.enemyHeroId, matchCount: 0, sourceMatchIds: [], differences: [] });
      const entry = matchupMap.get(enemy.enemyHeroId);
      entry.matchCount++;
      entry.sourceMatchIds.push(record.matchId);
      if (enemy.positionEstimate === 3 && finite(ownNetWorth) && finite(enemy.netWorth10)) entry.differences.push(ownNetWorth - enemy.netWorth10);
    }
  }
  const laneMatchups = [...matchupMap.values()].map(({ differences, ...entry }) => ({ ...entry, laneOutcome: differences.length ? { metric: 'observed_carry_minus_opposing_offlane_net_worth_at_10', medianDifference: percentile(differences, 0.5), sampleSize: differences.length } : null })).sort((a, b) => b.matchCount - a.matchCount);
  const from = new Date(Math.min(...records.map(record => record.startTime)) * 1000).toISOString();
  const to = new Date(Math.max(...records.map(record => record.startTime)) * 1000).toISOString();
  return {
    schemaVersion: 1, heroId: hero.id, role: 'carry', status: 'available', source: 'OpenDota recent parsed carry matches', sourceUrl: urls.matches,
    d2ptReference: urls.d2pt, externalUrl: urls.d2pt, fetchedAt, sampleCount: records.length,
    patch: { id: patchId, name: patchConstant?.name || `OpenDota patch ${patchId}`, verified: true, minorPatchVerified: false, scope: 'Exact OpenDota base patch ID, not a verified minor-letter patch or D2PT patch filter' },
    patchVerified: true, windowText: `${from.slice(0, 10)} — ${to.slice(0, 10)}`, window: { from, to, lookbackDays: options.lookbackDays || 45 },
    builds, itemStats, laneMatchups, benchmarks,
    ...(options.abilityCatalog ? { currentAbilityCatalog: options.abilityCatalog, abilities: options.abilityCatalog, abilityCatalogSourceUrl: urls.valve, abilityCatalogFetchedAt: fetchedAt } : {}),
    provenance: {
      kind: 'existing_public_parsed_match_sample', population: `Recent OpenDota league matches with parsed safelane ${hero.displayName}; not the D2PT 7000+ MMR population`,
      roleFilter: `hero_id=${hero.id}, lane_role=1, not roaming, position_est=1 when present`, patchFilter: patchId,
      sampleMatchIds: records.map(record => record.matchId), sourceUrls: records.map(record => record.sourceUrl), observations: records,
      benchmarkMethod: 'Linear-interpolated empirical quantiles from exact times/lh_t/networth_t checkpoints; gold_t is never substituted for net worth',
      buildMethod: 'Group observed first two major purchases; show newest actual purchase log in the largest group. Timings are that match, not a universal target.',
      skillMethod: 'Recorded ability_upgrades_arr from the same representative match, mapped by exact current Valve ability IDs. Array-only levels are an earliest-legal reconstruction, not recorded hero levels; innate abilities are excluded.',
    },
    caveats: [
      'Dota2ProTracker is a browsing reference only; this cached dataset comes from the public OpenDota API.',
      'OpenDota patch IDs identify base patches and cannot verify the current minor-letter patch.',
      'This is a small observational sample with the actual date range shown, not a current-patch meta guarantee.',
      'Missing or unparsed replays, role inference, match duration, and the league population introduce selection bias.',
      'Farm quantiles describe these samples; personal farm targets remain separate and editable.',
      'A purchase in a winning match does not establish the best item for this matchup.',
      'Skill order is observed; levels reconstructed from an upgrade array may differ if the player saved skill points. The current Valve ability catalog does not verify the match minor patch.',
    ],
  };
}

async function writeAtomic(file, value, options = {}) {
  options.signal?.throwIfAborted();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    options.signal?.throwIfAborted();
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    // Match start may cancel an update while the temporary file is being
    // written. Check at commit time so the previous cache remains intact.
    options.signal?.throwIfAborted();
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}

async function refreshBuilds(options = {}) {
  const hero = providerHero(options), urls = heroSourceUrls(hero);
  const now = options.now || new Date().toISOString();
  const lookbackDays = options.lookbackDays || 45;
  const request = options.fetch || fetch;
  const get = async url => {
    const response = await request(url, { signal: options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(25000)]):AbortSignal.timeout(25000), headers: { 'User-Agent': 'CoreCoach-PersonalPrototype/0.4' } });
    if (!response.ok) throw new Error(`OpenDota HTTP ${response.status}; existing build cache preserved`);
    return response.json();
  };
  const dataset = options.catalog ? null : JSON.parse(await fs.readFile(path.join(ROOT, 'data', `${hero.slug}.json`), 'utf8'));
  const catalog = options.catalog || dataset.items;
  // Test callers can supply their fixture catalog without external lookups.
  // The real refresh retrieves only the public Valve hero feed once.
  const heroData = options.heroData || (!options.catalog ? await get(urls.valve) : null);
  const abilityCatalog = options.abilityCatalog || (heroData ? require('../src/build-import.cjs').abilityCatalogFromValve(heroData, { heroId: hero.id }) : null);
  const patches = options.patches || await get(PATCH_URL);
  const candidates = await get(urls.matches);
  if (!Array.isArray(candidates)) throw new Error('Unexpected OpenDota match list; existing cache preserved');
  const cutoff = Date.parse(now) / 1000 - lookbackDays * 86400;
  const selected = candidates.filter(match => Number.isSafeInteger(match.match_id) && finite(match.start_time) && match.start_time >= cutoff && match.start_time <= Date.parse(now) / 1000 && match.duration >= 600).sort((a, b) => b.start_time - a.start_time).slice(0, options.maxMatches || 30);
  const observations = [];
  const errors = [];
  const seen = new Set();
  for (const candidate of selected) {
    if (seen.has(candidate.match_id)) continue;
    seen.add(candidate.match_id);
    try {
      const match = await get(`https://api.opendota.com/api/matches/${candidate.match_id}`);
      const observation = extractCarry(match, catalog, { abilityCatalog, heroId: hero.id });
      if (observation) observations.push(observation);
    } catch (error) {
      if(options.signal?.aborted)throw error;
      errors.push({ matchId: candidate.match_id, error: error.message });
      // Respect API rate limits immediately. Never retry or widen a sample to
      // make an unavailable source appear complete.
      if (/HTTP (429|403)/.test(error.message)) break;
    }
    if (options.delayMs !== 0) await new Promise(resolve => setTimeout(resolve, options.delayMs ?? 1100));
  }
  if (errors.length) throw new Error(`${errors.length} OpenDota match requests failed; existing build cache preserved (${errors[0].error})`);
  const result = aggregate(observations, { now, patches, lookbackDays, abilityCatalog, heroId: hero.id });
  result.validation = { attemptedMatches: seen.size, retainedCarries: result.sampleCount, fetchErrors: errors };
  options.signal?.throwIfAborted();await writeAtomic(options.destination || path.join(ROOT, 'data', hero.id === 42 ? 'd2pt-wraith-king.json' : `opendota-${hero.slug}.json`), result, { signal: options.signal });
  return result;
}

async function enrichCachedSkills(options = {}) {
  const hero = providerHero(options), urls = heroSourceUrls(hero);
  const destination = options.destination || path.join(ROOT, 'data', hero.id === 42 ? 'd2pt-wraith-king.json' : `opendota-${hero.slug}.json`);
  const cache = JSON.parse(await fs.readFile(destination, 'utf8'));
  if (!Array.isArray(cache.provenance?.observations) || !Array.isArray(cache.builds) || cache.heroId !== hero.id) throw new Error('No existing parsed carry sample to enrich');
  const request = options.fetch || fetch;
  const get = async url => {
    const response = await request(url, { signal: AbortSignal.timeout(25000), headers: { 'User-Agent': 'WraithCoach-PersonalPrototype/0.3' } });
    if (!response.ok) throw new Error(`OpenDota/Valve HTTP ${response.status}; existing build cache preserved`);
    return response.json();
  };
  const abilityCatalog = options.abilityCatalog || require('../src/build-import.cjs').abilityCatalogFromValve(options.heroData || await get(urls.valve), { heroId: hero.id });
  const observations = structuredClone(cache.provenance.observations);
  const ids = [...new Set(cache.builds.map(build => build.representativeMatchId))];
  for (const matchId of ids) {
    const match = await get(`https://api.opendota.com/api/matches/${matchId}`);
    const existing = observations.find(record => record.matchId === matchId);
    const player = match.players?.find(player => player.hero_id === hero.id);
    if (!existing || match.match_id !== matchId || match.patch !== existing.patchId || player?.lane_role !== 1) throw new Error('Representative match no longer matches carry source; existing build cache preserved');
    existing.skillObservation = require('../src/build-import.cjs').extractObservedSkills(player, abilityCatalog, matchId);
    if (options.delayMs !== 0) await new Promise(resolve => setTimeout(resolve, options.delayMs ?? 1100));
  }
  const result = aggregate(observations, { now: cache.fetchedAt, patches: [{ id: cache.patch.id, name: cache.patch.name }], lookbackDays: cache.window?.lookbackDays, abilityCatalog, heroId: hero.id });
  result.validation = cache.validation;
  result.abilityCatalogFetchedAt = options.now || new Date().toISOString();
  result.skillsFetchedAt = result.abilityCatalogFetchedAt;
  await writeAtomic(destination, result);
  return result;
}

async function main(args = process.argv.slice(2)) {
  const parsed = require('../src/provider-hero.cjs').parseProviderArgs(args);
  if (parsed.args.length && !(parsed.args.length === 1 && parsed.args[0] === '--enrich-skills')) throw new Error('Usage: node scripts/update-d2pt.cjs [--hero ID] [--enrich-skills] (public OpenDota fallback; D2PT is browsing-only)');
  const hero = providerHero(parsed), urls = heroSourceUrls(hero);
  const result = parsed.args[0] === '--enrich-skills' ? await enrichCachedSkills({ heroId: hero.id }) : await refreshBuilds({ heroId: hero.id });
  console.log(`Saved ${result.sampleCount} observed ${hero.displayName} carry matches (${result.windowText}), base patch ${result.patch.name}; ${result.builds.length} routes. Current minor patch is not verified. D2PT guide: ${urls.d2pt}`);
}

module.exports = { SOURCE_URL, D2PT_REFERENCE, DESTINATION, VALVE_HERO_URL, extractCarry, aggregate, timelineValue, percentile, writeAtomic, enrichCachedSkills, refreshBuild: refreshBuilds, refreshBuilds, main };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
