'use strict';

// This adapter only uses fields found in the authenticated, current schema.
// It never interprets undocumented ratings as an advantage percentage.
const { createClient, INTROSPECTION_QUERY, StratzError, typeText } = require('./stratz-client.cjs');
// The draft catalogue is deliberately independent of the five heroes which
// currently have in-game coaching profiles.
const IDS = Object.freeze(Object.values(require('../data/wraith-king.json').heroes || {}).map(hero => Number(hero?.id)).filter(id => Number.isInteger(id) && id > 0));
const BATCH_SIZE = 16;
const API_PAGE = 'https://stratz.com/api';
const WEEK_SECONDS = 604800;
// Use only cohorts available in BOTH aggregate endpoints. FILTERED has no
// documented population and is deliberately not exposed as a rating filter.
const RANK_COHORTS = Object.freeze({
  UNCALIBRATED: ['UNCALIBRATED'], HERALD_GUARDIAN: ['HERALD', 'GUARDIAN'],
  CRUSADER_ARCHON: ['CRUSADER', 'ARCHON'], LEGEND_ANCIENT: ['LEGEND', 'ANCIENT'],
  DIVINE_IMMORTAL: ['DIVINE', 'IMMORTAL'],
});
function normalizeRankId(value = 'all') {
  if (value === 'all' || value === 'ALL' || value == null || value === '') return 'all';
  if (Object.hasOwn(RANK_COHORTS, value)) return value;
  throw unsupported('рейтинг');
}
const rankLabel = (value, allRanksVerified = false) => normalizeRankId(value) === 'all' ? allRanksVerified ? 'пары по всем известным рейтинговым группам STRATZ' : 'фильтр рейтинга пар не задан' : value;
const unsupported = detail => new StratzError('SCHEMA_UNSUPPORTED', `STRATZ: статистика пика недоступна в этой схеме (${detail}). Сохранённый кеш доступен.`);
const unwrap = ref => { while (ref?.ofType) ref = ref.ofType; return ref; };
const validName = name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name || '');
const counts = (games, wins) => Number.isSafeInteger(games) && games >= 0 && Number.isSafeInteger(wins) && wins >= 0 && wins <= games;

function draftContract(schema) {
  if (!schema?.queryType?.name || !Array.isArray(schema.types)) throw unsupported('introspection');
  const types = new Map(schema.types.map(value => [value.name, value]));
  const field = (owner, names, required = true) => {
    const type = typeof owner === 'string' ? types.get(owner) : owner;
    const found = names.map(name => type?.fields?.find(value => value.name === name)).filter(Boolean);
    if (found.length > 1) throw unsupported('неоднозначное поле');
    if (!found.length && required) throw unsupported(`${type?.name || owner}.${names[0]}`);
    const value = found[0];
    if (value && !validName(value.name)) throw unsupported('имя поля');
    return value;
  };
  const child = entry => types.get(unwrap(entry?.type)?.name);
  const scalar = (owner, names, required = true) => {
    const value = field(owner, names, required);
    if (value && unwrap(value.type)?.kind !== 'SCALAR') throw unsupported(`тип ${value.name}`);
    return value;
  };
  const stats = field(schema.queryType.name, ['heroStats']);
  const matchup = field(child(stats), ['matchUp']);
  const heroArg = matchup.args?.find(value => value.name === 'heroId');
  if (!heroArg || !['Short', 'Int'].includes(unwrap(heroArg.type)?.name)) throw unsupported('heroId');
  const pairOwner = child(matchup);
  const vs = field(pairOwner, ['vs']);
  const withField = field(pairOwner, ['with'], false);
  const pairFields = owner => ({
    hero: scalar(owner, ['heroId2']),
    games: scalar(owner, ['matchCount']),
    wins: scalar(owner, ['winCount']),
    ownHero: scalar(owner, ['heroId1'], false),
    synergy: scalar(owner, ['synergy'], false),
    week: scalar(owner, ['week'], false),
  });
  const vsFields = pairFields(child(vs));
  const withFields = withField ? pairFields(child(withField)) : null;
  const ownId = scalar(pairOwner, ['heroId', 'heroId1'], false);
  // A field name alone cannot establish which hero a position filter concerns.
  const position = matchup.args?.find(value => ['positionId', 'positionIds'].includes(value.name) && /(?:position\s+of\s+(?:the\s+)?(?:selected\s+)?hero|hero(?:'s)?\s+position|primary\s+hero.*position)/i.test(value.description || ''));
  const positionType = position && types.get(unwrap(position.type)?.name);
  const verifiedPosition = positionType?.kind === 'ENUM' && positionType.enumValues?.some(value => value.name === 'POSITION_1') ? position : null;
  const positions = verifiedPosition ? positionType.enumValues.map(value => value.name).filter(name => /^POSITION_[1-5]$/.test(name)) : [];
  for (const entry of [stats, matchup, vs, withField].filter(Boolean)) {
    for (const arg of entry.args || []) {
      const allowed = entry === matchup && ['heroId', 'take', verifiedPosition?.name].includes(arg.name);
      if (arg.type?.kind === 'NON_NULL' && arg.defaultValue == null && !allowed) throw unsupported(`обязательный ${entry.name}.${arg.name}`);
    }
  }
  const take = matchup.args?.find(value => value.name === 'take');
  if (take && !['Int', 'Short'].includes(unwrap(take.type)?.name)) throw unsupported('take');
  const bracket = matchup.args?.find(value => value.name === 'bracketBasicIds');
  const bracketType = types.get(unwrap(bracket?.type)?.name);
  const ranks = bracketType?.name === 'RankBracketBasicEnum' ? (bracketType.enumValues || []).map(value => value.name) : [];
  const populations = ranks.filter(value => !['ALL', 'FILTERED'].includes(value)), allRanks = Object.keys(RANK_COHORTS);
  // The API special ALL enum currently returns an empty matrix. Enumerate the
  // verified population groups instead and let STRATZ combine their native
  // effects. A newly added/unknown population invalidates this all-rank claim.
  const allRanksVerified = bracketType?.kind === 'ENUM' && populations.length === allRanks.length && allRanks.every(value => populations.includes(value));
  return { stats, matchup, heroArg, vs, withField, vsFields, withFields, ownId, position: verifiedPosition, positions, take, bracket: ranks.length ? bracket : null, ranks, allRanksVerified };
}

function buildDraftQuery(contract, heroIds = IDS.slice(0, BATCH_SIZE), options = {}) {
  if (!Array.isArray(heroIds) || !heroIds.length || heroIds.length > BATCH_SIZE || new Set(heroIds).size !== heroIds.length || heroIds.some(id => !Number.isInteger(id) || id <= 0 || id > 10000)) throw unsupported('список героев');
  const positionId = Number(options.positionId || 1), role = `POSITION_${positionId}`;
  if (!Number.isInteger(positionId) || positionId < 1 || positionId > 5) throw unsupported('позиция');
  const usePosition = contract.position && contract.positions.includes(role);
  const rankId = normalizeRankId(options.rankId);
  if (rankId !== 'all' && (!contract.bracket || !contract.ranks.includes(rankId))) throw unsupported('фильтр рейтинга пар');
  const definitions = [], variables = {};
  const variable = (name, argument, value) => { definitions.push(`$${name}:${typeText(argument.type)}`); variables[name] = value; return `$${name}`; };
  const selectedRanks = rankId === 'all' ? contract.allRanksVerified ? Object.keys(RANK_COHORTS) : null : [rankId];
  const bracket = selectedRanks ? variable('brackets', contract.bracket, selectedRanks) : null;
  const pairs = fields => `heroId:${fields.hero.name} games:${fields.games.name} wins:${fields.wins.name}${fields.ownHero ? ` ownHeroId:${fields.ownHero.name}` : ''}${fields.synergy && fields.ownHero ? ` nativeSynergy:${fields.synergy.name}` : ''}${fields.week ? ` sampleWeek:${fields.week.name}` : ''}`;
  const selected = `${contract.ownId ? `heroId:${contract.ownId.name} ` : ''}matchups:${contract.vs.name} { ${pairs(contract.vsFields)} }${contract.withField ? ` synergies:${contract.withField.name} { ${pairs(contract.withFields)} }` : ''}`;
  const fields = heroIds.map(id => {
    const args = [`${contract.heroArg.name}:${variable(`hero${id}`, contract.heroArg, id)}`];
    if (contract.take) args.push(`${contract.take.name}:${variable(`take${id}`, contract.take, 200)}`);
    if (bracket) args.push(`${contract.bracket.name}:${bracket}`);
    if (usePosition) {
      const list = contract.position.type.kind === 'LIST' || contract.position.type.ofType?.kind === 'LIST';
      args.push(`${contract.position.name}:${variable(`position${id}`, contract.position, list ? [role] : role)}`);
    }
    return `h${id}:${contract.matchup.name}(${args.join(',')}) { ${selected} }`;
  });
  return { query: `query CoreCoachDraft(${definitions.join(',')}) { ${contract.stats.name} { ${fields.join(' ')} } }`, variables };
}

function normalizePairs(values, ownId, fields = {}) {
  if (!Array.isArray(values) || values.length > 300) throw new StratzError('INVALID_RESPONSE', 'Некорректная статистика пар героев STRATZ.');
  const seen = new Set();
  return values.map(value => {
    if (!Number.isInteger(value?.heroId) || value.heroId <= 0 || value.heroId > 10000 || value.heroId === ownId || seen.has(value.heroId) || !counts(value.games, value.wins)) throw new StratzError('INVALID_RESPONSE', 'Некорректная статистика пар героев STRATZ.');
    if (fields.ownHero && value.ownHeroId !== ownId) throw new StratzError('INVALID_RESPONSE', 'STRATZ: неверная ориентация пары героев.');
    if (value.nativeSynergy != null && (!fields.synergy || !fields.ownHero || typeof value.nativeSynergy !== 'number' || !Number.isFinite(value.nativeSynergy) || Math.abs(value.nativeSynergy) > 100)) throw new StratzError('INVALID_RESPONSE', 'STRATZ: некорректный эффект пары героев.');
    if (value.sampleWeek != null && (!Number.isSafeInteger(value.sampleWeek) || value.sampleWeek < 0 || value.sampleWeek > 100000)) throw new StratzError('INVALID_RESPONSE', 'STRATZ: некорректный период пары героев.');
    seen.add(value.heroId);
    return { heroId: value.heroId, games: value.games, wins: value.wins, ...(value.nativeSynergy != null ? { advantage: Number((value.nativeSynergy / 100).toFixed(6)) } : {}), ...(value.sampleWeek != null ? { sampleWeek: value.sampleWeek } : {}) };
  });
}

// A raw pair win rate contains the general strength of BOTH heroes. Removing
// only the candidate's win rate mistakes a weak opponent for a good counter.
// This fallback is allowed only when both baselines came from this matrix.
function adjustPairEffects(heroes, options = {}) {
  const byId = new Map(heroes.map(hero => [hero.heroId, hero]));
  const usable = hero => hero?.baselineAvailable === true && hero.games > 0 && counts(hero.games, hero.wins);
  let nativePairCount = 0, fallbackPairCount = 0, unavailablePairCount = 0;
  const weeks = new Set();
  const result = heroes.map(hero => {
    const pairs = key => (hero[key] || []).map(pair => {
      if (pair.sampleWeek != null) weeks.add(pair.sampleWeek);
      const { sampleWeek, ...value } = pair;
      if (typeof pair.advantage === 'number' && Number.isFinite(pair.advantage)) { nativePairCount++; return value; }
      const other = byId.get(pair.heroId);
      if (!options.roleFiltered && pair.games > 0 && usable(hero) && usable(other)) {
        const ownRate = hero.wins / hero.games, otherRate = other.wins / other.games, pairRate = pair.wins / pair.games;
        const effect = key === 'matchups' ? pairRate - ownRate + otherRate - .5 : pairRate - ownRate - otherRate + .5;
        fallbackPairCount++;
        return { ...value, advantage: Number(effect.toFixed(6)), adjustedFallback: true };
      }
      unavailablePairCount++; return value;
    });
    return { ...hero, matchups: pairs('matchups'), synergies: pairs('synergies') };
  });
  // A fallback-only matrix declares its method once on the dataset. Repeating
  // the same flag on 32,000 pairs would exceed the bounded cache size.
  const compact = nativePairCount ? result : result.map(hero => ({ ...hero, ...Object.fromEntries(['matchups', 'synergies'].map(key => [key, hero[key].map(({ adjustedFallback, ...pair }) => pair)])) }));
  return { heroes: compact, provenance: { advantageMethod: nativePairCount ? 'stratz_native_synergy' : fallbackPairCount ? 'pair_winrate_adjusted_both_hero_baselines' : null, nativePairCount, fallbackPairCount, unavailablePairCount, pairWeekIds: [...weeks].sort((a, b) => a - b) } };
}

// Every completed ten-player match contributes five opposing-hero records.
// Use this identity only for a complete matrix; partial or unknown coverage
// cannot establish the candidate's baseline and is never promoted to one.
function baselineFromPairs(rows, ownId, expectedHeroIds, options = {}) {
  const expected = Array.isArray(expectedHeroIds) ? [...new Set(expectedHeroIds)].filter(id => Number.isInteger(id) && id > 0 && id !== ownId) : [];
  const observed = new Set(rows.map(row => row.heroId));
  const games = rows.reduce((sum, row) => sum + row.games, 0), wins = rows.reduce((sum, row) => sum + row.wins, 0);
  // OpenDota's verified SQL route returns the entire GROUP BY result without
  // pagination and naturally omits opponents with zero matches. Other adapters
  // cannot rely on this endpoint-specific guarantee.
  const coverage = options.completeUnpaginatedEndpoint === true ? expected.length > 0 && [...observed].every(id => expected.includes(id)) : expected.length > 0 && !expected.some(id => !observed.has(id)) && observed.size === expected.length;
  if (!coverage || !Number.isSafeInteger(games) || !Number.isSafeInteger(wins) || games <= 0 || games % 5 || wins % 5) return { games: 0, wins: 0, baselineAvailable: false };
  return { games: games / 5, wins: wins / 5, baselineAvailable: true, baselineKind: 'complete_opponent_pairs_divided_by_five' };
}

function roleBaselineContract(schema) {
  const types = new Map((schema?.types || []).map(value => [value.name, value]));
  const query = types.get(schema?.queryType?.name), stats = query?.fields?.find(value => value.name === 'heroStats');
  const owner = types.get(unwrap(stats?.type)?.name), wins = owner?.fields?.find(value => value.name === 'winDay');
  if (!wins || !/last.*days|by day/i.test(wins.description || '')) return null;
  const arg = name => wins.args?.find(value => value.name === name);
  const heroIds = arg('heroIds'), positionIds = arg('positionIds'), groupBy = arg('groupBy'), take = arg('take'), bracketIds = arg('bracketIds');
  const positionType = types.get(unwrap(positionIds?.type)?.name), groupType = types.get(unwrap(groupBy?.type)?.name);
  if (!heroIds || !['Short', 'Int'].includes(unwrap(heroIds.type)?.name) || positionType?.name !== 'MatchPlayerPositionType' || ![1, 2, 3, 4, 5].every(id => positionType.enumValues?.some(value => value.name === `POSITION_${id}`)) || !groupType?.enumValues?.some(value => value.name === 'HERO_ID') || !take || unwrap(take.type)?.name !== 'Int') return null;
  const result = types.get(unwrap(wins.type)?.name);
  const fields = Object.fromEntries(['day', 'heroId', 'matchCount', 'winCount'].map(name => [name, result?.fields?.find(value => value.name === name)]));
  if (Object.values(fields).some(value => !value || unwrap(value.type)?.kind !== 'SCALAR')) return null;
  if ((wins.args || []).some(value => value.type?.kind === 'NON_NULL' && value.defaultValue == null && !['heroIds', 'positionIds', 'groupBy', 'take'].includes(value.name))) return null;
  const bracketType = types.get(unwrap(bracketIds?.type)?.name);
  const ranks = bracketType?.enumValues?.map(value => value.name) || [];
  const allRanks = [...new Set(Object.values(RANK_COHORTS).flat())];
  const allRanksVerified = bracketType?.name === 'RankBracket' && ranks.length === allRanks.length && allRanks.every(value => ranks.includes(value));
  return { stats, wins, heroIds, positionIds, groupBy, take, fields, bracketIds: bracketType?.name === 'RankBracket' ? bracketIds : null, ranks, allRanksVerified };
}

function gameVersionContract(schema) {
  const types = new Map((schema?.types || []).map(value => [value.name, value]));
  const constants = types.get(schema?.queryType?.name)?.fields?.find(value => value.name === 'constants');
  const versions = types.get(unwrap(constants?.type)?.name)?.fields?.find(value => value.name === 'gameVersions');
  const output = types.get(unwrap(versions?.type)?.name);
  const fields = ['id', 'name', 'asOfDateTime'].map(name => output?.fields?.find(value => value.name === name));
  if (!constants || !versions || fields.some(value => !value || unwrap(value.type)?.kind !== 'SCALAR') || [constants, versions].some(value => value.args?.some(arg => arg.type?.kind === 'NON_NULL' && arg.defaultValue == null))) return null;
  return { constants, versions, fields };
}

function latestKnownGameVersion(records, options = {}) {
  if (!Array.isArray(records) || !records.length || records.length > 1000) return null;
  const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1000), seen = new Set();
  for (const row of records) {
    if (!Number.isInteger(row?.id) || row.id <= 0 || seen.has(row.id) || typeof row.name !== 'string' || !/^\d+\.\d+[a-z]?$/.test(row.name) || !Number.isSafeInteger(row.asOfDateTime) || row.asOfDateTime < 1000000000 || row.asOfDateTime > nowSeconds + 300) return null;
    seen.add(row.id);
  }
  const latest = [...records].sort((a, b) => b.asOfDateTime - a.asOfDateTime || b.id - a.id)[0];
  return { id: latest.id, name: latest.name, observedFrom: new Date(latest.asOfDateTime * 1000).toISOString(), asOfDateTime: latest.asOfDateTime, authority: 'stratz_constants_catalogue' };
}

function pairPeriodContract(schema) {
  const types = new Map((schema?.types || []).map(value => [value.name, value]));
  const draft = draftContract(schema), owner = types.get(unwrap(draft.stats.type)?.name);
  const weekArg = draft.matchup.args?.find(value => value.name === 'week');
  const winWeek = owner?.fields?.find(value => value.name === 'winWeek');
  const arg = name => winWeek?.args?.find(value => value.name === name);
  const heroIds = arg('heroIds'), groupBy = arg('groupBy'), take = arg('take');
  const output = types.get(unwrap(winWeek?.type)?.name);
  const week = output?.fields?.find(value => value.name === 'week'), hero = output?.fields?.find(value => value.name === 'heroId');
  if (!weekArg || unwrap(weekArg.type)?.name !== 'Long' || !draft.ownId || !draft.vsFields.week || !draft.vsFields.ownHero || draft.withFields && (!draft.withFields.week || !draft.withFields.ownHero) || !winWeek || !/last\s+12\s+weeks/i.test(winWeek.description || '') || !heroIds || !['Short', 'Int'].includes(unwrap(heroIds.type)?.name) || !groupBy || !take || unwrap(take.type)?.name !== 'Int' || unwrap(week?.type)?.name !== 'Long' || !hero || !types.get(unwrap(groupBy.type)?.name)?.enumValues?.some(value => value.name === 'HERO_ID') || winWeek.args?.some(value => value.type?.kind === 'NON_NULL' && value.defaultValue == null && !['heroIds', 'groupBy', 'take'].includes(value.name))) return null;
  return { ...draft, weekArg, winWeek, winHeroIds: heroIds, winGroupBy: groupBy, winTake: take, winWeekField: week, winHeroField: hero };
}

function buildPairPeriodProof(contract, options = {}) {
  const ownHeroId = options.heroId, sampleWeek = options.sampleWeek;
  const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1000);
  if (!contract || !Number.isInteger(ownHeroId) || ownHeroId <= 0 || !Number.isSafeInteger(sampleWeek)) return null;
  const start = sampleWeek * WEEK_SECONDS;
  // This multiplication is a HYPOTHESIS, verified below against live source
  // responses on every refresh. It never becomes date evidence by itself.
  if (!Number.isSafeInteger(start) || start < 1000000000 || start > nowSeconds) return null;
  const rankId = normalizeRankId(options.rankId), definitions = [], variables = {};
  const variable = (name, argument, value) => { definitions.push(`$${name}:${typeText(argument.type)}`); variables[name] = value; return `$${name}`; };
  const hero = variable('pairProofHero', contract.heroArg, ownHeroId);
  const take = contract.take ? variable('pairProofRows', contract.take, 1) : null;
  const selectedRanks = rankId === 'all' ? contract.allRanksVerified ? Object.keys(RANK_COHORTS) : null : contract.bracket && contract.ranks.includes(rankId) ? [rankId] : null;
  const bracket = selectedRanks ? variable('pairProofBrackets', contract.bracket, selectedRanks) : null;
  if (rankId !== 'all' && !bracket) return null;
  const times = { current: start, inside: Math.min(start + 86400, nowSeconds), before: start - 1, older: start - 2 * WEEK_SECONDS };
  const pairFields = fields => `ownHeroId:${fields.ownHero.name} sampleWeek:${fields.week.name}`;
  const output = `heroId:${contract.ownId.name} matchups:${contract.vs.name}{${pairFields(contract.vsFields)}}${contract.withField ? ` synergies:${contract.withField.name}{${pairFields(contract.withFields)}}` : ''}`;
  const fields = Object.entries(times).map(([key, seconds]) => {
    const time = variable(`pairProof${key[0].toUpperCase()}${key.slice(1)}Time`, contract.weekArg, seconds);
    const args = [`${contract.heroArg.name}:${hero}`, `${contract.weekArg.name}:${time}`, ...(take ? [`${contract.take.name}:${take}`] : []), ...(bracket ? [`${contract.bracket.name}:${bracket}`] : [])];
    return `pairProof${key[0].toUpperCase()}${key.slice(1)}:${contract.matchup.name}(${args.join(',')}){${output}}`;
  });
  const heroes = variable('pairProofHeroes', contract.winHeroIds, [ownHeroId]), group = variable('pairProofGroup', contract.winGroupBy, 'HERO_ID'), weeksTake = variable('pairProofWeeksTake', contract.winTake, 20);
  fields.push(`pairProofRecent:${contract.winWeek.name}(${contract.winHeroIds.name}:${heroes},${contract.winGroupBy.name}:${group},${contract.winTake.name}:${weeksTake}){week:${contract.winWeekField.name} heroId:${contract.winHeroField.name}}`);
  return { definitions, variables, fields: fields.join(' '), expected: { heroId: ownHeroId, sampleWeek, ...times } };
}

function normalizePairPeriodProof(records, expected, options = {}) {
  if (!expected || !records || typeof records !== 'object') return null;
  const now = options.now?.() ?? Date.now(), wanted = { Current: expected.sampleWeek, Inside: expected.sampleWeek, Before: expected.sampleWeek - 1, Older: expected.sampleWeek - 2 };
  for (const [key, week] of Object.entries(wanted)) {
    const group = records[`pairProof${key}`];
    const entry = Array.isArray(group) && group.length === 1 ? group[0] : null;
    if (!entry || entry.heroId !== expected.heroId || !Array.isArray(entry.matchups) || entry.synergies != null && !Array.isArray(entry.synergies)) return null;
    const pairs = [...entry.matchups, ...(entry.synergies || [])];
    if (!pairs.length || pairs.some(pair => pair.ownHeroId !== expected.heroId || pair.sampleWeek !== week)) return null;
  }
  const recent = records.pairProofRecent;
  if (!Array.isArray(recent) || recent.length < 3 || recent.length > 20 || recent.some(row => row.heroId !== expected.heroId || !Number.isSafeInteger(row.week) || row.week < 1000000000 || row.week % WEEK_SECONDS || row.week > now / 1000 + 300)) return null;
  const dates = [...new Set(recent.map(row => row.week))].sort((a, b) => b - a);
  if (dates.length !== recent.length || dates.slice(1).some((day, index) => dates[index] - day !== WEEK_SECONDS) || !dates.includes(expected.current - WEEK_SECONDS) || !dates.includes(expected.older)) return null;
  const end = expected.current + WEEK_SECONDS;
  return { periodStart: new Date(expected.current * 1000).toISOString(), periodEndExclusive: new Date(end * 1000).toISOString(), periodBoundsVerified: true, periodPartial: end * 1000 > now, periodMethod: 'stratz_unix_week_roundtrip', proof: { authority: 'stratz_live_graphql_roundtrip', sampleWeek: expected.sampleWeek, requestSeconds: { current: expected.current, inside: expected.inside, before: expected.before, older: expected.older }, recentPeriodStarts: dates } };
}

function buildRoleBaselineQuery(contract, heroIds = IDS, options = {}) {
  if (!contract || !Array.isArray(heroIds) || !heroIds.length || heroIds.length > 160 || new Set(heroIds).size !== heroIds.length || heroIds.some(id => !Number.isInteger(id) || id <= 0 || id > 10000)) throw unsupported('статистика позиций');
  const definitions = [], variables = {};
  const variable = (name, argument, value) => { definitions.push(`$${name}:${typeText(argument.type)}`); variables[name] = value; return `$${name}`; };
  const rankId = normalizeRankId(options.rankId), selectedRanks = rankId === 'all' && contract.allRanksVerified ? contract.ranks : RANK_COHORTS[rankId];
  if (rankId !== 'all' && (!contract.bracketIds || selectedRanks.some(value => !contract.ranks.includes(value)))) throw unsupported('фильтр рейтинга базы');
  const bracket = selectedRanks ? variable('brackets', contract.bracketIds, selectedRanks) : null;
  const heroes = variable('heroes', contract.heroIds, heroIds), group = variable('group', contract.groupBy, 'HERO_ID'), take = variable('take', contract.take, 2000);
  const aliases = [1, 2, 3, 4, 5].map(positionId => {
    const position = variable(`position${positionId}`, contract.positionIds, [`POSITION_${positionId}`]);
    return `p${positionId}:${contract.wins.name}(${contract.heroIds.name}:${heroes},${contract.positionIds.name}:${position},${contract.groupBy.name}:${group},${contract.take.name}:${take}${bracket ? `,${contract.bracketIds.name}:${bracket}` : ''}){day:${contract.fields.day.name} heroId:${contract.fields.heroId.name} games:${contract.fields.matchCount.name} wins:${contract.fields.winCount.name}}`;
  });
  const versions = options.gameVersionContract;
  const constantFields = versions ? `${versions.constants.name}{${versions.versions.name}{${versions.fields.map(value => value.name).join(' ')}}}` : '';
  const proof = options.pairPeriodProof;
  if (proof) { definitions.push(...proof.definitions); Object.assign(variables, proof.variables); }
  return { query: `query CoreCoachAllDraftPositions(${definitions.join(',')}){${contract.stats.name}{${aliases.join(' ')}${proof ? ` ${proof.fields}` : ''}}${constantFields}}`, variables };
}

function normalizeRoleBaselines(records, heroIds, options = {}) {
  const positions = {}, daySeconds = 86400;
  const currentDay = Math.floor((options.now?.() ?? Date.now()) / 86400000) * daySeconds;
  const boundary = options.latestKnownGameVersion?.asOfDateTime;
  if (boundary != null && (!Number.isSafeInteger(boundary) || boundary < 1000000000 || boundary > (options.now?.() ?? Date.now()) / 1000 + 300)) throw new StratzError('INVALID_RESPONSE', 'STRATZ: некорректная граница патча.');
  const grouped = new Map();
  for (const positionId of [1, 2, 3, 4, 5]) {
    const rows = records?.[`p${positionId}`];
    if (!Array.isArray(rows) || !rows.length || rows.length > 5000) throw new StratzError('INVALID_RESPONSE', 'STRATZ: неполная статистика позиций.');
    const seen = new Set();
    for (const row of rows) {
      const key = `${row?.heroId}:${row?.day}`;
      if (!heroIds.includes(row?.heroId) || !Number.isSafeInteger(row?.day) || row.day < 1000000000 || row.day % daySeconds !== 0 || row.day > currentDay || !counts(row.games, row.wins) || seen.has(key)) throw new StratzError('INVALID_RESPONSE', 'STRATZ: некорректная статистика позиций.');
      seen.add(key);
    }
    const days = new Map();
    for (const row of rows) {
      // Never use today's partial bucket or a day crossing the verified
      // latest catalogue release. Whole older-patch days are excluded too.
      if (row.day >= currentDay || boundary != null && row.day < boundary) continue;
      const day = days.get(row.day) || new Map(); day.set(row.heroId, row); days.set(row.day, day);
    }
    grouped.set(positionId, days);
  }
  const completeDays = [...(grouped.get(1)?.keys() || [])].filter(day => [1, 2, 3, 4, 5].every(positionId => grouped.get(positionId)?.get(day)?.size === heroIds.length)).sort((a, b) => b - a);
  if (!completeDays.length) throw new StratzError('INCOMPLETE_SAMPLE', boundary != null ? 'STRATZ: нет полного завершённого дня актуального патча для всех героев и позиций.' : 'STRATZ: нет полного завершённого дня для всех героев и позиций.');
  const latestDay = completeDays[0];
  // Use only a consecutive, common, fully observed window of at most twelve
  // completed days. A page-cut day or missing bucket ends the window; gaps are
  // never bridged with weeks-old rows merely to increase the sample count.
  const sampleDays = [latestDay];
  for (let offset = 1; offset < 12; offset++) {
    const day = latestDay - offset * daySeconds;
    if (!completeDays.includes(day)) break;
    sampleDays.push(day);
  }
  for (const positionId of [1, 2, 3, 4, 5]) {
    positions[positionId] = {
      latestDay, sampleStartDay: sampleDays[sampleDays.length - 1], sampleDays: [...sampleDays].reverse(),
      observedThrough: new Date(latestDay * 1000).toISOString(),
      heroes: heroIds.map(heroId => {
        const rows = sampleDays.map(day => grouped.get(positionId).get(day).get(heroId));
        const games = rows.reduce((sum, row) => sum + row.games, 0), wins = rows.reduce((sum, row) => sum + row.wins, 0);
        if (!counts(games, wins)) throw new StratzError('INVALID_RESPONSE', 'STRATZ: некорректная сумма статистики позиций.');
        return { heroId, games, wins, baselineAvailable: games > 0, baselineKind: 'stratz_win_day_position' };
      }),
    };
  }
  return positions;
}

function createPositionDatasets(broad, baselines, options = {}) {
  if (!['stratz_native_synergy', 'pair_winrate_adjusted_both_hero_baselines'].includes(broad.provenance?.advantageMethod)) {
    const raw = broad.heroes.map(hero => ({ ...hero, ...Object.fromEntries(['matchups', 'synergies'].map(key => [key, (hero[key] || []).map(({ advantage, adjustedFallback, ...pair }) => pair)])) }));
    const adjusted = adjustPairEffects(raw, { roleFiltered: broad.provenance?.roleFiltered === true });
    broad = { ...broad, heroes: adjusted.heroes, provenance: { ...broad.provenance, ...adjusted.provenance } };
  }
  const byHero = new Map(broad.heroes.map(hero => [hero.heroId, hero]));
  return [1, 2, 3, 4, 5].map(positionId => {
    const sample = baselines[positionId];
    const version = options.latestKnownGameVersion;
    const baselineRank = broad.scope.rank || (options.baselineAllRanksVerified === true ? 'all' : null);
    // Day buckets are unfiltered by patch. They can be attributed to the
    // latest catalogue version only when the WHOLE observed window starts
    // after its release boundary; a crossed/unknown boundary stays unknown.
    const patch = version && sample.sampleStartDay >= version.asOfDateTime ? version.name : null;
    return {
      ...broad, scope: { ...broad.scope, patch, role: `POSITION_${positionId}` },
      observedThrough: sample.observedThrough,
      components: {
        baseline: { observedFrom: new Date(sample.sampleStartDay * 1000).toISOString(), observedThrough: new Date((sample.latestDay + 86400) * 1000).toISOString(), observedUntilExclusive: new Date((sample.latestDay + 86400) * 1000).toISOString(), observedThroughKind: 'exclusive_period_end', scope: { ...broad.scope, rank: baselineRank, patch, role: `POSITION_${positionId}` }, schemaVerified: true, roleFiltered: true, patchFiltered: Boolean(patch), rankFiltered: Boolean(baselineRank), patchMethod: patch ? 'daily_window_inside_catalogue_version' : null },
        pairs: broad.components?.pairs || { observedFrom: null, observedThrough: null, scope: { ...broad.scope, role: broad.provenance?.pairRoleFiltered === true ? broad.scope.role : null }, schemaVerified: true, roleFiltered: broad.provenance?.pairRoleFiltered === true, patchFiltered: false, rankFiltered: broad.provenance?.rankFiltered === true },
      },
      scopeDescription: `STRATZ: винрейт на позиции ${positionId} за ${new Date(sample.sampleStartDay * 1000).toISOString().slice(0, 10)} — ${new Date(sample.latestDay * 1000).toISOString().slice(0, 10)} (${sample.sampleDays.length} дн.); ${baselineRank === 'all' ? 'база по всем рангам; ' : ''}${rankLabel(broad.scope.rank, broad.components?.pairs?.scope?.rank === 'all' && broad.components.pairs.rankFiltered === true)}; ${patch ? `база ${patch} по границам каталога STRATZ` : 'патч базы не подтверждён'}; ${broad.components?.pairs?.periodBoundsVerified ? `пары по подтверждённой неделе с ${broad.components.pairs.periodStart.slice(0, 10)}${broad.components.pairs.periodPartial ? ', неполный период' : ''}; крайний матч неизвестен; ${broad.components.pairs.scope.patch ? `пары ${broad.components.pairs.scope.patch}` : 'патч пар не подтверждён'}; пары без фильтра позиции` : 'пары без фильтра позиции, патч и даты пар не подтверждены'}`,
      provenance: { ...broad.provenance, roleFiltered: true, pairRoleFiltered: false, patchFiltered: Boolean(patch), patchMethod: patch ? 'daily_window_inside_catalogue_version' : null, latestKnownGameVersion: version || null, roleBaselineSource: 'heroStats.winDay', roleSampleDay: sample.latestDay, roleSampleStart: sample.sampleStartDay, roleSampleDays: sample.sampleDays, observedThrough: sample.observedThrough, observedThroughKind: 'completed_day', baselineKind: 'stratz_win_day_position' },
      heroes: sample.heroes.map(hero => {
        const pairHero = byHero.get(hero.heroId);
        // Six decimal places exceed the precision justified by the samples
        // and keep each complete 127-hero cache below the bounded file limit.
        // Shared pair provenance lives on the dataset, not on every pair.
        const pairs = key => (pairHero?.[key] || []).map(pair => ({ ...pair, baselineCompatible: false }));
        return { ...hero, matchups: pairs('matchups'), synergies: pairs('synergies') };
      }),
    };
  });
}

async function refreshStratzDraft(options = {}) {
  const heroIds = Array.isArray(options.heroIds) && options.heroIds.length ? [...options.heroIds] : [...IDS];
  if (heroIds.length > 160 || new Set(heroIds).size !== heroIds.length || heroIds.some(id => !Number.isInteger(id) || id <= 0 || id > 10000)) throw unsupported('каталог героев');
  const positionId = Number(options.positionId || 1);
  if (!Number.isInteger(positionId) || positionId < 1 || positionId > 5) throw unsupported('позиция');
  // At most 11 bounded calls for a catalogue of up to 160 heroes. Only the
  // background updater calls this adapter; ranking reads the local cache.
  const client = createClient({ token: options.token, fetch: options.fetch, signal: options.signal, timeoutMs: options.timeoutMs, maxCalls: 2 + Math.ceil(heroIds.length / BATCH_SIZE) });
  const schema = (await client.graphql(INTROSPECTION_QUERY)).__schema;
  const contract = draftContract(schema), records = {};
  let snapshotWeek = null, pairPeriodComplete = true;
  const rankId = normalizeRankId(options.rankId), roleContract = roleBaselineContract(schema);
  // Refuse a partial cohort filter. Pair and baseline rank populations must
  // agree; a narrower pair matrix cannot silently borrow an all-rank base.
  if (rankId !== 'all') {
    buildDraftQuery(contract, heroIds.slice(0, BATCH_SIZE), { positionId, rankId });
    if (!roleContract) throw unsupported('фильтр рейтинга базы');
    buildRoleBaselineQuery(roleContract, heroIds, { rankId });
  }
  const role = contract.position && contract.positions.includes(`POSITION_${positionId}`) ? `POSITION_${positionId}` : null;
  for (let index = 0; index < heroIds.length; index += BATCH_SIZE) {
    if (options.signal?.aborted) throw new StratzError('CANCELLED', 'Обновление статистики пика отменено.');
    const batchIds = heroIds.slice(index, index + BATCH_SIZE);
    const request = buildDraftQuery(contract, batchIds, { positionId, rankId });
    const response = await client.graphql(request.query, request.variables);
    // Keep the public native bucket identifier, rather than guessing what date
    // it means. Reject different returned buckets so a weekly API rollover
    // cannot silently mix two different pair matrices. The input `week` is a
    // Long whereas the returned bucket is an Int; their units are not assumed
    // to be interchangeable without a verified API contract.
    const batchWeeks = new Set();
    for (const heroId of batchIds) {
      const group = response[contract.stats.name]?.[`h${heroId}`];
      const entry = Array.isArray(group) && group.length === 1 ? group[0] : !Array.isArray(group) ? group : null;
      for (const key of ['matchups', 'synergies']) {
        for (const pair of Array.isArray(entry?.[key]) ? entry[key] : []) {
          if (pair.sampleWeek == null) { pairPeriodComplete = false; continue; }
          if (!Number.isSafeInteger(pair.sampleWeek) || pair.sampleWeek < 0 || pair.sampleWeek > 100000) throw new StratzError('INVALID_RESPONSE', 'STRATZ: некорректный период пары героев.');
          batchWeeks.add(pair.sampleWeek);
        }
      }
    }
    if (batchWeeks.size > 1 || snapshotWeek != null && [...batchWeeks].some(week => week !== snapshotWeek)) throw new StratzError('INCONSISTENT_SAMPLE', 'STRATZ: периоды пар изменились во время загрузки. Сохранённый кеш доступен.');
    if (snapshotWeek == null && batchWeeks.size === 1) snapshotWeek = [...batchWeeks][0];
    Object.assign(records, response[contract.stats.name]);
    options.onProgress?.({ completed: Math.min(index + BATCH_SIZE, heroIds.length), total: heroIds.length });
  }
  const heroes = heroIds.map(heroId => {
    const group = records?.[`h${heroId}`];
    // A verified role query can legitimately have no matches for a hero.
    if (Array.isArray(group) && group.length === 0) return { heroId, games: 0, wins: 0, baselineAvailable: false, matchups: [], synergies: [] };
    const entry = Array.isArray(group) && group.length === 1 ? group[0] : !Array.isArray(group) ? group : null;
    if (!entry || typeof entry !== 'object' || contract.ownId && entry.heroId !== heroId) throw new StratzError('INVALID_RESPONSE', 'STRATZ не вернул полную однозначную статистику каталога героев.');
    const matchups = normalizePairs(entry.matchups, heroId, contract.vsFields);
    const synergies = contract.withField ? normalizePairs(entry.synergies, heroId, contract.withFields) : [];
    return { heroId, ...baselineFromPairs(matchups, heroId, heroIds), matchups, synergies };
  });
  const adjusted = adjustPairEffects(heroes, { roleFiltered: Boolean(role) });
  if (adjusted.provenance.pairWeekIds.length > 1) throw new StratzError('INCONSISTENT_SAMPLE', 'STRATZ: несовместимые периоды пар героев. Сохранённый кеш доступен.');
  const allPairRanksVerified = rankId === 'all' && contract.allRanksVerified, pairRanks = rankId === 'all' ? allPairRanksVerified ? Object.keys(RANK_COHORTS) : null : [rankId];
  const result = {
    schemaVersion: 1, providerId: 'stratz', updatedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
    scope: { patch: null, rank: rankId === 'all' ? null : rankId, role },
    scopeDescription: `STRATZ: ${role ? `позиция ${positionId}` : 'общие пары героев'}; ${rankLabel(rankId, allPairRanksVerified)}; патч и даты пар не подтверждены`,
    provenance: { sourceUrl: API_PAGE, schemaVerified: true, roleFiltered: Boolean(role), pairRoleFiltered: Boolean(role), patchFiltered: false, rankFiltered: Boolean(pairRanks), pairRankCohorts: pairRanks, baselineKind: 'complete_opponent_pairs_divided_by_five', batchSize: BATCH_SIZE, calls: client.calls, completeQuery: true, ...adjusted.provenance, pairPeriodConsistent: pairPeriodComplete && adjusted.provenance.pairWeekIds.length === 1, pairPeriodMethod: pairPeriodComplete && snapshotWeek != null ? 'native_week_id_consistent' : null },
    catalogHeroIds: heroIds,
    heroes: adjusted.heroes,
  };
  const broadComponent = { observedFrom: null, observedThrough: null, scope: { ...result.scope, rank: rankId === 'all' ? allPairRanksVerified ? 'all' : null : rankId }, schemaVerified: true, roleFiltered: Boolean(role), patchFiltered: false, rankFiltered: Boolean(pairRanks) };
  result.components = { baseline: { ...broadComponent }, pairs: { ...broadComponent } };
  if (!role && roleContract) {
    const versionsContract = gameVersionContract(schema);
    const proofHero = [...result.heroes].sort((a, b) => b.matchups.reduce((sum, pair) => sum + pair.games, 0) - a.matchups.reduce((sum, pair) => sum + pair.games, 0))[0];
    const proof = result.provenance.pairPeriodConsistent ? buildPairPeriodProof(pairPeriodContract(schema), { heroId: proofHero?.heroId, sampleWeek: adjusted.provenance.pairWeekIds[0], rankId, now: options.now }) : null;
    const request = buildRoleBaselineQuery(roleContract, heroIds, { rankId, gameVersionContract: versionsContract, pairPeriodProof: proof });
    const response = await client.graphql(request.query, request.variables);
    const version = versionsContract ? latestKnownGameVersion(response[versionsContract.constants.name]?.[versionsContract.versions.name], { now: options.now }) : null;
    result.provenance.latestKnownGameVersion = version;
    const period = proof ? normalizePairPeriodProof(response[roleContract.stats.name], proof.expected, { now: options.now }) : null;
    if (period) {
      const patch = version && Date.parse(period.periodStart) / 1000 >= version.asOfDateTime ? version.name : null;
      const { proof: evidence, ...bounds } = period;
      result.scope.patch = patch;
      const component = { ...result.components.pairs, ...bounds, observedFrom: period.periodStart, scope: { ...result.components.pairs.scope, patch }, patchFiltered: Boolean(patch), patchMethod: patch ? 'verified_pair_period_inside_catalogue_version' : null, ...(version && !patch ? { patchMatchesCurrent: false } : {}) };
      result.components = { baseline: { ...component }, pairs: component };
      Object.assign(result.provenance, { pairPeriodStart: bounds.periodStart, pairPeriodEndExclusive: bounds.periodEndExclusive, pairPeriodBoundsVerified: true, pairPeriodPartial: bounds.periodPartial, pairPeriodMethod: bounds.periodMethod, pairPeriodProof: evidence, patchFiltered: Boolean(patch), patchMethod: component.patchMethod });
      result.scopeDescription = `STRATZ: ${rankLabel(rankId, allPairRanksVerified)}; пары по подтверждённой неделе с ${period.periodStart.slice(0, 10)}${period.periodPartial ? ', неполный период' : ''}; крайний матч неизвестен; ${patch ? `пары ${patch} по границам каталога STRATZ` : 'патч пар не подтверждён'}; пары без фильтра позиции`;
    }
    let baselines;
    try {
      baselines = normalizeRoleBaselines(response[roleContract.stats.name], heroIds, { now: options.now, latestKnownGameVersion: version });
    } catch (error) {
      if (!version || error.code !== 'INCOMPLETE_SAMPLE') throw error;
      // Preserve the new native pairs AND catalogue evidence even immediately
      // after a patch when no complete daily role bucket exists yet. A broad
      // unknown-patch base must not replace the unavailable current role base.
      result.provenance.roleBaselineError = 'NO_COMPLETE_CURRENT_PATCH_SAMPLE';
      result.provenance.calls = client.calls;
      result.heroes = result.heroes.map(hero => ({ ...hero, games: 0, wins: 0, baselineAvailable: false }));
      result.components.baseline = { ...result.components.baseline, targetPatch: version.name, unavailableReason: 'NO_COMPLETE_CURRENT_PATCH_SAMPLE' };
      result.scopeDescription += '; база актуального патча пока отсутствует';
      return result;
    }
    const positions = createPositionDatasets(result, baselines, { latestKnownGameVersion: version, baselineAllRanksVerified: rankId === 'all' && roleContract.allRanksVerified });
    result.provenance.calls = client.calls;
    for (const value of positions) value.provenance.calls = client.calls;
    Object.defineProperty(result, 'positionDatasets', { value: positions, enumerable: false });
  }
  return result;
}

module.exports = { IDS, BATCH_SIZE, RANK_COHORTS, normalizeRankId, draftContract, buildDraftQuery, normalizePairs, baselineFromPairs, adjustPairEffects, roleBaselineContract, buildRoleBaselineQuery, normalizeRoleBaselines, createPositionDatasets, gameVersionContract, latestKnownGameVersion, pairPeriodContract, buildPairPeriodProof, normalizePairPeriodProof, refreshStratzDraft };
