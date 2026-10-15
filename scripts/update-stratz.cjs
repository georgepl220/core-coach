'use strict';

// STRATZ is the primary provider; a personal token is supplied by the application.
// Curated hero guides are an observational population, not all high-MMR matches.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createClient, StratzError, buildVersionQuery, buildGuideQuery, buildMatchQuery, candidateIds, matchRecords, testConnection, ENDPOINT } = require('../src/stratz-client.cjs');
const { aggregate, writeAtomic, VALVE_HERO_URL } = require('./update-d2pt.cjs');
const { abilityCatalogFromValve, extractObservedSkills } = require('../src/build-import.cjs');
const ROOT = path.resolve(__dirname, '..');
const { providerHero, heroSourceUrls } = require('../src/provider-hero.cjs');
const DESTINATION = path.join(ROOT, 'data', 'stratz-wraith-king.json');
const HERO_URL = 'https://stratz.com/heroes/42?positionIds=POSITION_1';
const COMPLETED_ITEMS = new Set(['magic_wand', 'bracer', 'wraith_band', 'phase_boots', 'power_treads', 'armlet', 'radiance', 'desolator', 'black_king_bar', 'blink', 'assault', 'abyssal_blade', 'monkey_king_bar', 'silver_edge', 'nullifier', 'satanic', 'aghanims_shard', 'ultimate_scepter', 'soul_ring', 'echo_sabre', 'harpoon', 'invis_sword', 'sange_and_yasha', 'skadi', 'bloodthorn', 'orchid', 'bfury', 'overwhelming_blink', 'swift_blink', 'moon_shard', 'manta', 'yasha', 'sange', 'mask_of_madness', 'maelstrom', 'mjollnir', 'butterfly', 'diffusal_blade', 'disperser', 'falcon_blade', 'greater_crit', 'dragon_lance', 'hurricane_pike', 'boots_of_travel', 'boots_of_travel_2', 'helm_of_the_dominator']);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const phase = seconds => seconds <= 0 ? 'start' : seconds < 600 ? 'early' : seconds < 1800 ? 'mid' : 'late';

function currentVersion(versions, now) {
  const nowSeconds = Date.parse(now) / 1000;
  const candidates = Array.isArray(versions) ? versions.filter(value => Number.isInteger(value?.id) && value.id > 0 && typeof value.name === 'string' && /^\d+\.\d+[a-z]?$/i.test(value.name) && finite(value.asOfDateTime) && value.asOfDateTime > 0 && value.asOfDateTime <= nowSeconds) : [];
  candidates.sort((a, b) => b.asOfDateTime - a.asOfDateTime || b.id - a.id);
  if (!candidates.length) throw new StratzError('INVALID_VERSION', 'STRATZ: не удалось подтвердить текущую версию игры; предыдущий кеш сохранён.');
  return candidates[0];
}

function extractStratzCarry(match, catalog, options = {}) {
  const hero = providerHero(options);
  if (!match || !Number.isSafeInteger(match.id) || match.id <= 0 || !finite(match.startDateTime) || !finite(match.durationSeconds) || match.durationSeconds < 600 || !Number.isInteger(match.gameVersionId) || !Array.isArray(match.players)) return null;
  if (options.patchId != null && match.gameVersionId !== options.patchId) return null;
  const nowSeconds = Date.parse(options.now || new Date().toISOString()) / 1000;
  const cutoff = nowSeconds - (options.lookbackDays || 7) * 86400;
  if (!finite(nowSeconds) || match.startDateTime < cutoff || match.startDateTime > nowSeconds) return null;
  const candidates = match.players.filter(player => player?.heroId === hero.id && player.position === 'POSITION_1');
  if (candidates.length !== 1) return null;
  const player = candidates[0];
  // Refuse absent/unknown variants: they could merge incompatible facets.
  if (!Number.isInteger(player.variant) || player.variant < 1 || player.variant > 16 || (options.facetId != null && player.variant !== options.facetId)) return null;
  const purchases = player.stats?.purchases;
  if (!Array.isArray(purchases)) return null;
  const itemIds = new Map(Object.entries(catalog || {}).filter(([, item]) => Number.isInteger(item.id)).map(([key, item]) => [item.id, key]));
  const observed = purchases.filter(value => value && Number.isInteger(value.itemId) && itemIds.has(value.itemId) && finite(value.time) && value.time >= -600 && value.time <= match.durationSeconds).sort((a, b) => a.time - b.time);
  const seen = new Set();
  const sequence = observed.flatMap(value => {
    const key = itemIds.get(value.itemId);
    if (seen.has(key) || (value.time > 0 && !COMPLETED_ITEMS.has(key))) return [];
    seen.add(key);
    return [{ key, timeSeconds: value.time, stage: phase(value.time) }];
  });
  if (!sequence.some(value => value.timeSeconds > 0 && COMPLETED_ITEMS.has(value.key))) return null;
  const rawLearns = player.playbackData?.learns;
  if (!Array.isArray(rawLearns)) return null;
  const orderedLearns = rawLearns.filter(value => value && Number.isInteger(value.abilityId) && finite(value.time) && value.time >= -600 && value.time <= match.durationSeconds).sort((a, b) => a.time - b.time);
  if (orderedLearns.length < 6 || !options.abilityCatalog) return null;
  const byId = new Map(Object.values(options.abilityCatalog).map(value => [value.abilityId, value]));
  const upgrades = orderedLearns.filter(value => byId.get(value.abilityId)?.innate !== true);
  const skillObservation = extractObservedSkills({
    ability_upgrades_arr: upgrades.map(value => value.abilityId),
    ...(options.recordedHeroLevels ? { ability_upgrades_log: upgrades.map(value => ({ ability: value.abilityId, level: value.levelObtained })) } : {}),
  }, options.abilityCatalog, match.id);
  if (skillObservation.skills.length < 6) return null;
  if (!skillObservation.levelVerified) {
    for (const skill of skillObservation.skills) skill.observedTimeSeconds = upgrades[skill.upgradeIndex - 1]?.time ?? null;
  }
  const won = typeof player.isVictory === 'boolean' ? player.isVictory : typeof player.isRadiant === 'boolean' && typeof match.didRadiantWin === 'boolean' ? player.isRadiant === match.didRadiantWin : null;
  return {
    matchId: match.id, startTime: match.startDateTime, patchId: match.gameVersionId, durationSeconds: match.durationSeconds,
    sourceUrl: `https://stratz.com/matches/${match.id}`, replayUrl: `https://stratz.com/matches/${match.id}/builds`,
    heroId: hero.id, won, role: 'carry', facetId: player.variant,
    roleEvidence: { provider: 'stratz', position: 'POSITION_1', heroId: hero.id },
    sequence, skillObservation, timelines: { lastHits: [], netWorth: [] }, enemies: [],
    purchaseLogSha256: crypto.createHash('sha256').update(JSON.stringify(observed)).digest('hex'),
  };
}

function selectFacet(observations, facetId = null) {
  if (facetId != null) {
    if (!Number.isInteger(facetId) || facetId < 1 || facetId > 16) throw new StratzError('INVALID_FACET', 'Некорректная грань для выборки STRATZ.');
    return observations.filter(value => value.facetId === facetId);
  }
  const groups = new Map();
  for (const observation of observations) {
    if (!groups.has(observation.facetId)) groups.set(observation.facetId, []);
    groups.get(observation.facetId).push(observation);
  }
  return [...groups.values()].sort((a, b) => b.length - a.length || Math.max(...b.map(value => value.startTime)) - Math.max(...a.map(value => value.startTime)))[0] || [];
}

function aggregateStratz(observations, options = {}) {
  const hero = providerHero(options), urls = heroSourceUrls(hero);
  const patch = options.patch;
  if (!Number.isInteger(patch?.id)) throw new StratzError('INVALID_VERSION', 'Не подтверждена версия выборки STRATZ.');
  const exactPatch = observations.filter(value => value?.patchId === patch.id && (value.heroId == null ? hero.id === 42 : value.heroId === hero.id));
  const selected = selectFacet(exactPatch, options.facetId);
  if (!selected.length) throw new StratzError('NO_SAMPLE', `STRATZ: нет свежих разобранных ${hero.displayName} carry-матчей на текущем патче с покупками и прокачкой; предыдущий кеш сохранён.`);
  const result = aggregate(selected, { ...options, patches: [{ id: patch.id, name: patch.name }] });
  result.providerId = 'stratz';
  result.source = 'STRATZ recent parsed carry guides';
  result.sourceUrl = ENDPOINT;
  result.externalUrl = urls.stratz;
  delete result.d2ptReference;
  result.patch = {
    id: patch.id, name: patch.name, verified: true, minorPatchVerified: /^\d+\.\d+[a-z]$/i.test(patch.name),
    versionDate: new Date(patch.asOfDateTime * 1000).toISOString(),
    scope: 'Exact latest released STRATZ gameVersionId, checked against constants.gameVersions; minor letters verified only when present in that version name',
  };
  result.facet = { id: selected[0].facetId, verified: true, selection: options.facetId == null ? 'largest_observed_facet_cohort' : 'explicit_facet', allFacetSampleCount: exactPatch.length };
  for (const build of result.builds) {
    build.facetId = selected[0].facetId;
    build.sourceUrl = `https://stratz.com/matches/${build.representativeMatchId}/builds`;
  }
  result.provenance = {
    ...result.provenance, kind: 'authenticated_stratz_parsed_guide_sample', providerId: 'stratz',
    population: 'STRATZ curated hero guides returned by heroStats.guide; not a random population or all D2PT/high-MMR matches',
    roleFilter: `Authenticated schema-confirmed heroStats.guide(heroId:${hero.id},positionId:POSITION_1); each returned match is independently checked for a unique ${hero.displayName} POSITION_1 player`,
    patchFilter: patch.id, facetFilter: selected[0].facetId,
    dateFilter: { from: new Date(Date.parse(result.fetchedAt) - (options.lookbackDays || 7) * 86400000).toISOString(), to: result.fetchedAt },
    sourceUrls: selected.map(value => value.sourceUrl), observations: selected,
    benchmarkMethod: 'Unavailable in this provider: per-minute arrays do not prove exact cumulative checkpoint semantics; no gold substitute or guessed indexing is used.',
    skillMethod: 'Time-sorted playbackData.abilityLearnEvents from the same representative match, exact current Valve ability IDs. Hero levels are recorded only when the live schema explicitly describes levelObtained as hero/player level and the complete log passes legal-level validation; otherwise levels are earliest-legal lower bounds.',
  };
  result.caveats = [
    'This is a bounded curated-guide sample, not the complete STRATZ or D2PT high-MMR population; guide selection can favor strong or winning performances.',
    'Only one confirmed facet is included. The largest observed facet cohort is chosen automatically unless the user selects a facet.',
    'Only the latest released STRATZ gameVersionId and the displayed recent time window are used. A new patch may have too few parsed guides; the previous cache is then kept.',
    'Routes are actual purchase sequences from representative matches; individual timings are examples, not mandatory deadlines.',
    'Recorded skill order does not prove recorded hero levels. Rows marked as lower bounds remain conditional plans, especially when players save skill points.',
    'Per-minute farm benchmarks and lane-matchup outcomes are not inferred from undocumented arrays by this provider.',
  ];
  return result;
}

async function refreshStratz(options = {}) {
  const hero = providerHero(options), urls = heroSourceUrls(hero);
  const now = options.now || new Date().toISOString();
  if (!Number.isFinite(Date.parse(now))) throw new StratzError('INVALID_DATE', 'Некорректное время обновления STRATZ.');
  const lookbackDays = Math.min(14, Math.max(1, options.lookbackDays || 7));
  const maxMatches = Math.min(60, Math.max(1, Math.floor(options.maxMatches || 60)));
  const client = createClient(options);
  const contract = await client.introspect();
  if (!contract.learns) throw new StratzError('SCHEMA_UNSUPPORTED', 'STRATZ: события прокачки недоступны в текущей схеме; предыдущий кеш сохранён.');
  const versionQuery = buildVersionQuery(contract);
  const versionData = await client.graphql(versionQuery.query, versionQuery.variables);
  const patch = currentVersion(versionData[contract.constants.name]?.versions, now);
  const guideQuery = buildGuideQuery(contract, maxMatches, { heroId: hero.id });
  const guideData = await client.graphql(guideQuery.query, guideQuery.variables);
  const ids = candidateIds(guideData).slice(0, maxMatches);
  if (!ids.length) throw new StratzError('NO_SAMPLE', `STRATZ: нет carry-гайдов для ${hero.displayName}; предыдущий кеш сохранён.`);
  const catalog = options.catalog || JSON.parse(await fs.readFile(path.join(ROOT, 'data', `${hero.slug}.json`), 'utf8')).items;
  let abilityCatalog = options.abilityCatalog;
  if (!abilityCatalog) {
    const request = options.fetch || fetch;
    let response;
    try { response = await request(urls.valve, { signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) }); }
    catch { throw new StratzError('ABILITY_CATALOG', 'Не удалось обновить каталог способностей Valve; предыдущий кеш сохранён.'); }
    if (!response.ok) throw new StratzError('ABILITY_CATALOG', 'Каталог способностей Valve недоступен; предыдущий кеш сохранён.');
    try { abilityCatalog = abilityCatalogFromValve(await response.json(), { heroId: hero.id }); }
    catch { throw new StratzError('ABILITY_CATALOG', 'Некорректный каталог способностей Valve; предыдущий кеш сохранён.'); }
  }
  const observations = [], fetchedIds = new Set();
  for (let offset = 0; offset < ids.length; offset += 20) {
    const batch = ids.slice(offset, offset + 20), query = buildMatchQuery(contract, batch);
    const data = await client.graphql(query.query, query.variables);
    const records = matchRecords(data);
    for (const record of records) {
      if (!batch.includes(record?.id) || fetchedIds.has(record.id)) continue;
      fetchedIds.add(record.id);
      const observation = extractStratzCarry(record, catalog, { now, lookbackDays, patchId: patch.id, facetId: options.facetId, abilityCatalog, recordedHeroLevels: Boolean(contract.heroLevelField), heroId: hero.id });
      if (observation) observations.push(observation);
    }
  }
  const result = aggregateStratz(observations, { now, lookbackDays, patch, facetId: options.facetId, abilityCatalog, heroId: hero.id });
  result.validation = { schemaVerified: true, graphqlCalls: client.calls, requestedMatches: ids.length, returnedMatches: fetchedIds.size, eligibleCurrentPatchCarries: observations.length, retainedFacetCarries: result.sampleCount, skillHeroLevelSemanticsVerified: Boolean(contract.heroLevelField) };
  options.signal?.throwIfAborted();
  await writeAtomic(options.destination || path.join(ROOT, 'data', `stratz-${hero.slug}.json`), result, { signal: options.signal });
  return result;
}

async function main(args = process.argv.slice(2)) {
  const parsed = require('../src/provider-hero.cjs').parseProviderArgs(args);
  if (parsed.args.length) throw new Error('Usage: node scripts/update-stratz.cjs [--hero ID] (STRATZ_API_TOKEN environment variable, never a command-line token)');
  const hero = providerHero(parsed);
  const result = await refreshStratz({ token: process.env.STRATZ_API_TOKEN, heroId: hero.id });
  console.log(`STRATZ ${hero.displayName}: ${result.sampleCount} carry guides, patch ${result.patch.name}, facet ${result.facet.id}, ${result.windowText}; ${result.builds.length} observed routes.`);
}
module.exports = { DESTINATION, HERO_URL, ENDPOINT, currentVersion, extractStratzCarry, selectFacet, aggregateStratz, refreshStratz, refreshBuild: refreshStratz, refreshBuilds: refreshStratz, testConnection, main };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
