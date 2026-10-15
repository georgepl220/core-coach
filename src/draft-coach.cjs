'use strict';

// Rankings use observed outcomes only. Capability labels are displayed as
// context, never added to the score or treated as observed lane assignments.
const { heroes: BUILTIN_HERO_CATALOG } = require('../data/wraith-king.json');
const { POSITION_PROFILES, normalizePosition, roleFitFor } = require('./draft-roles.cjs');
const DAY_MS = 86400000;
const PAIR_PRIOR_GAMES = 200;
const HERO_PRIOR_GAMES = 500;
// The selected position's outcome is the anchor. Conditional pairs from all
// positions are only secondary evidence: they cannot carry the same weight as
// pairs observed on that selected position, even when their sample is large.
const POSITION_BASELINE_SCALE = 100;
const GLOBAL_BASELINE_SCALE = 18;
const CROSS_POSITION_PAIR_WEIGHT = .25;
const MIN_PAIR_GAMES = 30;
const MIN_HERO_GAMES = 30;
const ENEMY_MATCHUP_SCALE = 90;
const ALLY_SYNERGY_SCALE = 50;
// A presentation warning only: this is not a confidence interval or a test of
// significance. Aggregated pair counts do not expose their covariance.
const CLOSE_SCORE_THRESHOLD = .5;
// This existing explanation cutoff limits display copy, never the score or
// an assertion of statistical significance.
const PAIR_EXPLANATION_EFFECT = .002;
const CONFIDENCE_LABELS = { low: 'низкая', medium: 'средняя', high: 'высокая' };

function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function finite(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function heroId(value) { const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : finite(value); return n !== null && Number.isInteger(n) && n > 0 && n <= 10000 ? n : null; }
function ids(values, limit = 256) { return [...new Set((Array.isArray(values) ? values : []).map(heroId).filter(value => value !== null))].slice(0, limit); }
function clamp(value, minimum, maximum) { return Math.min(maximum, Math.max(minimum, value)); }
function catalogFor(heroes) {
  const supplied = Array.isArray(heroes) ? Object.fromEntries(heroes.filter(hero => heroId(hero?.id)).map(hero => [hero.id, hero])) : object(heroes);
  const catalog = { ...BUILTIN_HERO_CATALOG };
  for (const [key, hero] of Object.entries(supplied)) {
    const id = heroId(hero?.id ?? key);
    if (id) catalog[id] = { ...object(catalog[id]), ...object(hero) };
  }
  return catalog;
}
function nameFor(id, heroes) {
  const hero = object(heroes[id]);
  const name = [hero.localizedName, hero.localized_name, hero.name_loc, hero.name].find(value => typeof value === 'string' && value.trim() && !/^npc_dota_/i.test(value.trim()));
  return name?.trim() || `Герой ${id}`;
}
function countRows(value) {
  const row = object(value), games = finite(row.games), wins = finite(row.wins);
  if (games === null || wins === null || !Number.isSafeInteger(games) || !Number.isSafeInteger(wins) || games <= 0 || wins < 0 || wins > games) return null;
  return { ...row, games, wins, winRate: wins / games };
}
function providerLabel(providerId) { return providerId === 'stratz' ? 'STRATZ' : providerId === 'opendota' ? 'OpenDota' : 'Статистика'; }
function rowMatchesPosition(entry, positionId) {
  const declared = normalizePosition(entry?.positionId ?? entry?.role ?? entry?.scope?.role, null);
  return declared === null || declared === positionId;
}

function timestamp(value) {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const number = finite(value);
  // STRATZ day IDs are Unix seconds; ISO observation dates are preferred.
  return number === null ? null : number < 1e11 ? number * 1000 : number;
}

function componentQuality(stats, componentName, now, positionId) {
  stats = object(stats);
  const provenance = object(stats.provenance), component = object(object(stats.components)[componentName]);
  const componentProvenance = object(component.provenance);
  const explicitComponent = Object.keys(component).length > 0;
  const scope = explicitComponent ? object(component.scope) : object(stats.scope);
  const flag = name => typeof component[name] === 'boolean' ? component[name]
    : typeof componentProvenance[name] === 'boolean' ? componentProvenance[name]
    : typeof stats[name] === 'boolean' ? stats[name] : provenance[name];
  // Downloading an old sample today does not make its observations current.
  // A role-day observation describes only baseline WR, never the pair window.
  // In particular, updatedAt/fetchedAt must not establish observation age.
  const legacyObservedValue = componentName === 'baseline'
    ? stats.baselineObservedThrough ?? provenance.baselineObservedThrough ?? stats.roleSampleDay ?? provenance.roleSampleDay ?? stats.observedThrough ?? provenance.observedThrough
    : stats.pairObservedThrough ?? provenance.pairObservedThrough ?? (stats.roleSampleDay || provenance.roleSampleDay ? null : stats.observedThrough ?? provenance.observedThrough);
  const observedValue = explicitComponent ? component.observedThrough ?? componentProvenance.observedThrough : legacyObservedValue;
  const observedFrom = explicitComponent ? component.observedFrom ?? componentProvenance.observedFrom ?? null
    : componentName === 'baseline' ? stats.baselineObservedFrom ?? provenance.roleSampleStart ?? stats.roleSampleStart ?? null : stats.pairObservedFrom ?? provenance.pairObservedFrom ?? null;
  const observedThroughKind = explicitComponent ? component.observedThroughKind ?? componentProvenance.observedThroughKind ?? null
    : componentName === 'baseline' ? stats.observedThroughKind ?? provenance.observedThroughKind ?? null : stats.pairObservedThroughKind ?? provenance.pairObservedThroughKind ?? null;
  const observedUntilExclusive = explicitComponent ? component.observedUntilExclusive ?? componentProvenance.observedUntilExclusive ?? null
    : componentName === 'baseline' ? stats.baselineObservedUntilExclusive ?? provenance.baselineObservedUntilExclusive ?? null : stats.pairObservedUntilExclusive ?? provenance.pairObservedUntilExclusive ?? null;
  const observedAt = timestamp(observedValue);
  const periodStart = timestamp(component.periodStart), periodEnd = timestamp(component.periodEndExclusive);
  const periodBoundsVerified = component.periodBoundsVerified === true && component.periodMethod === 'stratz_unix_week_roundtrip'
    && periodStart !== null && periodEnd !== null && periodEnd - periodStart === 7 * DAY_MS && periodStart <= now;
  const age = observedAt !== null && observedAt <= now + 300000 ? Math.max(0, now - observedAt) : null;
  const requestedPosition = normalizePosition(positionId);
  const knownRole = normalizePosition(scope.role ?? scope.positionId, null) === requestedPosition;
  const declaredPairRoleFiltered = typeof component.roleFiltered === 'boolean' ? component.roleFiltered : typeof stats.pairRoleFiltered === 'boolean' ? stats.pairRoleFiltered : provenance.pairRoleFiltered;
  const roleFiltered = componentName === 'pairs'
    ? (declaredPairRoleFiltered !== false && flag('roleFiltered') === true || declaredPairRoleFiltered === true) && knownRole
    : flag('roleFiltered') === true && knownRole;
  const positionEstimated = componentName === 'baseline' && flag('positionEstimated') === true && knownRole && !roleFiltered;
  const patchFiltered = flag('patchFiltered') === true && Boolean(scope.patch);
  const rankFiltered = flag('rankFiltered') === true && scope.rank !== null && scope.rank !== undefined;
  const mixed = flag('mixedScope') === true || scope.mixed === true || component.mixedScope === true;
  const wrongRole = componentName === 'baseline'
    ? (flag('roleFiltered') === true || flag('positionEstimated') === true) && !knownRole
    : (declaredPairRoleFiltered === true || declaredPairRoleFiltered !== false && flag('roleFiltered') === true) && !knownRole;
  const mismatchedPatch = flag('patchMatchesCurrent') === false;
  const periodTooOld = periodBoundsVerified && periodEnd <= now - 30 * DAY_MS;
  const rejected = mixed || wrongRole || mismatchedPatch || periodTooOld || age !== null && age > 30 * DAY_MS;
  // For explicitly general pairs, the separate .25 transfer coefficient
  // already represents the lack of a position filter. Their date/filter
  // quality remains independent from the role WR observation window.
  const reliableScope = patchFiltered && rankFiltered && flag('schemaVerified') === true && (roleFiltered || componentName === 'pairs' && declaredPairRoleFiltered === false);
  const weight = rejected ? 0 : reliableScope ? age !== null && age <= 3 * DAY_MS ? 1 : .5 : age !== null && age <= 3 * DAY_MS ? .4 : .2;
  const label = componentName === 'baseline' ? 'База WR' : 'Матчапы и синергии';
  const notes = [];
  if (mixed) notes.push(`${label}: выборки с разными фильтрами исключены из оценки.`);
  if (wrongRole) notes.push(`${label}: выборка другой позиции исключена из оценки.`);
  if (mismatchedPatch) notes.push(`${label}: выборка другого патча исключена из оценки.`);
  if (periodTooOld) notes.push(`${label}: подтверждённый период закончился более 30 дней назад; статистика исключена из оценки.`);
  if (age === null) notes.push(periodBoundsVerified
    ? `${label}: недельный период подтверждён STRATZ; время последнего учтённого матча неизвестно.`
    : `${label}: дата наблюдений статистики неизвестна; дата скачивания не подтверждает свежесть.`);
  else if (age > 30 * DAY_MS) notes.push(`${label}: статистика старше 30 дней исключена из оценки.`);
  else if (age > 3 * DAY_MS) notes.push(`${label}: последние наблюдения статистики старше трёх дней; новое скачивание не меняет возраст выборки.`);
  return { age, ageDays: age === null ? null : age / DAY_MS, observedAt,
    observedFrom, observedThrough: observedValue ?? null, observedThroughKind, observedUntilExclusive,
    periodBoundsVerified, periodStart: periodBoundsVerified ? component.periodStart : null,
    periodEndExclusive: periodBoundsVerified ? component.periodEndExclusive : null,
    periodPartial: periodBoundsVerified ? component.periodPartial === true : null,
    periodMethod: periodBoundsVerified ? component.periodMethod : null, scope: { ...scope }, notes, weight, reliableScope,
    rejected, roleFiltered, positionEstimated, patchFiltered, rankFiltered,
    status: rejected ? 'rejected' : age === null ? 'unknown' : age > 3 * DAY_MS ? 'aging' : 'fresh' };
}

function sourceQuality(stats, now, positionId = 1) {
  stats = object(stats);
  const provenance = object(stats.provenance);
  const rows = Array.isArray(stats.heroes) ? stats.heroes : [];
  const baseline = componentQuality(stats, 'baseline', now, positionId), pairs = componentQuality(stats, 'pairs', now, positionId);
  const requestedPosition = normalizePosition(positionId);
  const { age, observedAt, roleFiltered, positionEstimated } = baseline;
  const pairComponent = object(object(stats.components).pairs);
  const pairRoleFiltered = typeof pairComponent.roleFiltered === 'boolean' ? pairComponent.roleFiltered : typeof stats.pairRoleFiltered === 'boolean' ? stats.pairRoleFiltered : typeof provenance.pairRoleFiltered === 'boolean' ? provenance.pairRoleFiltered : null;
  const advantageMethod = typeof provenance.advantageMethod === 'string' ? provenance.advantageMethod : null;
  const { patchFiltered, rankFiltered } = baseline;
  const rejected = baseline.rejected && pairs.rejected;
  const reliableScope = baseline.reliableScope && pairs.reliableScope;
  const notes = rows.length ? [...baseline.notes, ...pairs.notes] : [];
  if (advantageMethod === 'pair_winrate_minus_same_corpus_hero_baseline') notes.push('Старые эффекты пар без поправки на винрейт второго героя исключены; требуется обновление источника.');
  if (['raw_pair_winrate', 'pair_winrate_minus_candidate_baseline'].includes(advantageMethod)) notes.push('В резерве есть только исходные винрейты пар. Без поправки на силу обоих героев они не используются как контрпики или синергии.');
  if (rows.length && !reliableScope) notes.push(`Нет подтверждённых общих фильтров по патчу, рейтингу и позиции ${requestedPosition}.`);
  if (rows.length && positionEstimated) notes.push(`Позиция ${requestedPosition} оценена по линии и распределению фарма в исходных матчах. Это статистика предполагаемой позиции, а не подтверждённой роли; уверенность ограничена.`);
  else if (rows.length && !roleFiltered && !baseline.rejected) notes.push(`Для позиции ${requestedPosition} пока нет отдельной подтверждённой выборки. Используется общая статистика; смена позиции не создаёт новые винрейты.`);
  const baselineScope = baseline.scope, pairScope = pairs.scope;
  const details = [patchFiltered ? `патч ${String(baselineScope.patch).slice(0, 32)} (база)` : 'патч не отфильтрован (база)',
    rankFiltered ? baselineScope.rank === 'all' ? 'все рейтинги (база)' : `рейтинг ${String(baselineScope.rank).slice(0, 40)} (база)` : 'рейтинг не отфильтрован (база)',
    roleFiltered ? pairRoleFiltered === false ? `позиция ${requestedPosition} для винрейтов; пары всех позиций` : `позиция ${requestedPosition}` : positionEstimated ? `позиция ${requestedPosition} оценена по линии и фарму` : 'роли смешаны',
    pairs.patchFiltered ? `патч ${String(pairScope.patch).slice(0, 32)} (пары)` : 'патч пар не подтверждён',
    pairs.rankFiltered ? pairScope.rank === 'all' ? 'все рейтинги (пары)' : `рейтинг ${String(pairScope.rank).slice(0, 40)} (пары)` : 'рейтинг пар не подтверждён'];
  const scopeDescription = typeof stats.scopeDescription === 'string' ? stats.scopeDescription.slice(0, 250) : '';
  return { rows, age, observedAt, notes, weight: baseline.weight, baseline, pairs: { ...pairs, advantageMethod }, reliableScope, rejected, roleFiltered, pairRoleFiltered, advantageMethod, positionEstimated, providerId: stats.providerId, sourceLabel: rows.length ? providerLabel(stats.providerId) : 'Статистика не загружена', scopeLabel: rows.length ? [scopeDescription, details.join(' · ')].filter(Boolean).join(' · ') : 'Статистика матчапов пока недоступна' };
}

function pairEvidence(pair, baseline, quality) {
  const normalized = countRows(pair);
  if (!normalized || normalized.games < MIN_PAIR_GAMES || !quality.weight) return null;
  const advantage = finite(normalized.advantage);
  const advantageMethod = normalized.advantageMethod ?? normalized.provenance?.advantageMethod ?? quality.advantageMethod;
  // This legacy transform measured the candidate's conditional win rate only.
  // It did not remove the other hero's global strength and is not advantage.
  if (['pair_winrate_minus_same_corpus_hero_baseline', 'pair_winrate_minus_candidate_baseline', 'raw_pair_winrate'].includes(advantageMethod)) return null;
  // Source-adjusted advantages do not need a raw baseline. Unadjusted pair
  // rates require the candidate's baseline from the same statistical corpus.
  const adjusted = advantage !== null && Math.abs(advantage) <= 1;
  const compatible = normalized.baselineCompatible !== false && normalized.provenance?.baselineCompatible !== false;
  const relative = adjusted ? advantage : baseline && compatible ? normalized.winRate - baseline.winRate : null;
  if (relative === null) return null;
  const shrink = normalized.games / (normalized.games + PAIR_PRIOR_GAMES);
  const computedAdvantage = adjusted && (advantageMethod === 'pair_winrate_adjusted_both_hero_baselines' || normalized.adjustedFallback === true);
  const nativeAdjusted = adjusted && advantageMethod === 'stratz_native_synergy' && !computedAdvantage;
  return { ...normalized, relative, adjusted, computedAdvantage, nativeAdjusted, advantageMethod: adjusted ? advantageMethod || 'source_adjusted' : 'pair_winrate_minus_candidate_baseline', effect: clamp(relative, -.15, .15) * shrink * quality.weight, shrink };
}

function assessDraft({ dataUsed, evidence, coverage, baseline, positionId, roleFiltered, positionEstimated, contributions }) {
  const group = (side, sourceCoverage) => {
    const rows = evidence.filter(row => row.side === side);
    const favorable = rows.filter(row => row.contribution > 0).sort((a, b) => b.contribution - a.contribution || a.heroId - b.heroId);
    const unfavorable = rows.filter(row => row.contribution < 0).sort((a, b) => a.contribution - b.contribution || a.heroId - b.heroId);
    const netContribution = rows.reduce((sum, row) => sum + row.contribution, 0);
    const visiblePositive = favorable.filter(row => row.displayRelevant), visibleNegative = unfavorable.filter(row => row.displayRelevant);
    const direction = netContribution > 0 ? 'positive' : netContribution < 0 ? 'negative' : 'neutral';
    const hasDirectionalSignal = direction === 'positive' ? visiblePositive.length > 0 : direction === 'negative' ? visibleNegative.length > 0 : false;
    return { ...sourceCoverage, positive: favorable.length, negative: unfavorable.length,
      neutral: rows.length - favorable.length - unfavorable.length, netContribution, direction, hasDirectionalSignal,
      visiblePositive: visiblePositive.length, visibleNegative: visibleNegative.length,
      favorable, unfavorable, strongestPositive: favorable[0] || null, strongestNegative: unfavorable[0] || null };
  };
  const enemies = group('enemy', coverage.enemies), allies = group('ally', coverage.allies);
  const known = enemies.known + allies.known, used = enemies.used + allies.used;
  let status;
  if (!dataUsed) status = 'no_data';
  else if (!known) status = 'no_context';
  else if (!used) status = 'unknown_context';
  // Qualitative copy follows the actual enemy contribution first. A high WR
  // never turns negative enemy evidence into a claim of favorable matchups.
  else if (enemies.hasDirectionalSignal && enemies.direction === 'negative') status = 'unfavorable';
  else if (enemies.hasDirectionalSignal && enemies.direction === 'positive') status = enemies.visibleNegative || allies.hasDirectionalSignal && allies.direction === 'negative' ? 'mixed' : 'favorable';
  else if (allies.hasDirectionalSignal && allies.direction === 'negative') status = 'unfavorable';
  else if (allies.hasDirectionalSignal && allies.direction === 'positive') status = allies.visibleNegative || enemies.visibleNegative ? 'mixed' : 'favorable';
  else status = 'neutral';
  const draftContribution = contributions.enemies + contributions.allies;
  return { status, basis: !dataUsed ? 'none' : baseline && (!used || draftContribution <= 0) ? 'baseline' : 'draft',
    baseline: { available: Boolean(baseline), winRate: baseline?.winRate ?? null,
      smoothedWinRate: baseline ? (baseline.wins + HERO_PRIOR_GAMES * .5) / (baseline.games + HERO_PRIOR_GAMES) : null,
      games: baseline?.games ?? 0, positionId, roleFiltered, positionEstimated },
    enemies, allies, favorable: [...enemies.favorable, ...allies.favorable], risks: [...enemies.unfavorable, ...allies.unfavorable],
    missingPairs: known - used, completeCoverage: known > 0 && used === known,
    negativeEnemyCount: enemies.negative, negativeAllyCount: allies.negative,
    components: { ...contributions, draft: draftContribution },
    baseOffsetsNegativeDraft: Boolean(baseline && contributions.baseline > 0 && draftContribution < 0),
    interpretation: 'descriptive_signals_not_statistical_significance' };
}

function assessmentLabel(assessment) {
  if (assessment.status === 'no_data') return 'Мало данных';
  if (assessment.status === 'unknown_context') return 'Матчапы не подтверждены';
  if (assessment.status === 'no_context') return assessment.baseline.roleFiltered ? 'Оценка по WR позиции' : 'Оценка по винрейту';
  if (assessment.status === 'unfavorable') return assessment.enemies.hasDirectionalSignal && assessment.enemies.direction === 'negative' ? 'Риски против соперников' : 'Риски в сочетаниях';
  if (assessment.status === 'mixed') return 'Плюсы и риски по драфту';
  if (assessment.status === 'favorable') return assessment.missingPairs ? 'Есть плюсы, данные неполны' : 'Есть плюсы по драфту';
  return 'Без явного сигнала драфта';
}

function evaluateDraft(input = {}) {
  input = object(input);
  const now = finite(input.now) ?? Date.now(), heroes = catalogFor(input.heroes);
  const positionId = normalizePosition(input.positionId), position = POSITION_PROFILES[positionId - 1];
  // A selected-position recommendation needs observations of that position.
  // Generic diagnostics can explicitly keep evaluating broad hero statistics.
  const requirePositionData = input.requirePositionData === true;
  const stats = object(input.stats);
  const metadataRows = [...(Array.isArray(stats.roleCatalog) ? stats.roleCatalog : []), ...(Array.isArray(stats.heroes) ? stats.heroes : [])];
  // Metadata may supplement known catalog entries but cannot invent a hero.
  // It never creates score bonuses, even if the statistical bundle is rejected.
  for (const row of metadataRows) {
    const id = heroId(row?.heroId ?? row?.id);
    if (!id || !heroes[id]) continue;
    const existing = object(heroes[id]), capabilities = object(row.capabilities);
    heroes[id] = { ...existing,
      roles: existing.roles ?? row.roles ?? capabilities.roles,
      attack_type: existing.attack_type ?? existing.attackType ?? row.attackType ?? capabilities.attackType,
      primary_attr: existing.primary_attr ?? existing.primaryAttribute ?? row.primaryAttribute ?? capabilities.primaryAttribute,
    };
  }
  const catalogIds = ids(Object.keys(heroes)), known = new Set(catalogIds);
  const enemies = ids(input.enemyHeroIds, 5).filter(id => known.has(id));
  const allies = ids(input.allyHeroIds, 5).filter(id => known.has(id) && !enemies.includes(id));
  const own = heroId(input.ownHeroId), banned = ids(input.bannedHeroIds);
  const excluded = new Set([...allies, ...enemies, ...banned, ...(own ? [own] : [])]);
  const pool = ids(input.candidateHeroIds ?? catalogIds).filter(id => known.has(id) && !excluded.has(id));
  const quality = sourceQuality(stats, now, positionId), notes = [...quality.notes];
  const knownCount = allies.length + enemies.length;
  let totalEvidence = 0, totalBroadEvidence = 0;
  const candidates = pool.map(id => {
    const reasons = [], risks = [], roleFit = roleFitFor(heroes[id], positionId);
    let score = 50, evidenceCount = 0, broadEvidenceCount = 0, pairSamples = [], statScore = 0;
    let baselineContribution = 0, enemyContribution = 0, allyContribution = 0;
    const matchupEvidence = [];
    const coverageFor = list => ({ known: list.length, used: 0, missing: 0, lowSample: 0, rejected: 0 });
    const dataCoverage = { baseline: null, enemies: coverageFor(enemies), allies: coverageFor(allies) };
    const row = object(quality.rows.find(entry => heroId(entry?.heroId ?? entry?.id) === id && rowMatchesPosition(entry, positionId)));
    const rawBaseline = row.baselineAvailable === false || row.baselineCompatible === false || row.provenance?.baselineCompatible === false ? null : countRows(row);
    const baseline = rawBaseline && rawBaseline.games >= MIN_HERO_GAMES ? rawBaseline : null;
    const baselineHasPosition = quality.roleFiltered || quality.positionEstimated;
    const baselineUsed = Boolean(baseline && quality.baseline.weight && (!requirePositionData || baselineHasPosition));
    dataCoverage.baseline = { available: Boolean(rawBaseline), used: baselineUsed, games: rawBaseline?.games ?? 0,
      status: baselineUsed ? 'used' : baseline && quality.baseline.rejected ? 'rejected' : baseline && requirePositionData && !baselineHasPosition ? 'position_unverified' : rawBaseline ? 'low_sample' : 'missing' };
    if (baselineUsed) {
      const baselineScale = quality.roleFiltered || quality.positionEstimated ? POSITION_BASELINE_SCALE : GLOBAL_BASELINE_SCALE;
      baselineContribution = (baseline.winRate - .5) * baseline.games / (baseline.games + HERO_PRIOR_GAMES) * baselineScale * quality.baseline.weight;
      score += baselineContribution;
      const rate = (baseline.winRate * 100).toFixed(1).replace('.', ',');
      reasons.push({ weight: quality.roleFiltered || quality.positionEstimated ? 20 : 1, text: `${quality.sourceLabel}: винрейт ${nameFor(id, heroes)} ${rate}% в общей выборке героя (${baseline.games} матчей; эффект сглажен).${quality.roleFiltered ? ` Позиция ${positionId}.` : quality.positionEstimated ? ` Позиция ${positionId} оценена по линии и фарму.` : ' Позиции в этой выборке смешаны.'}` });
    }
    const collect = (list, field, weight, type) => {
      const pairs = Array.isArray(row[field]) ? row[field] : [];
      const componentCoverage = type === 'enemy' ? dataCoverage.enemies : dataCoverage.allies;
      const evidence = list.map(otherId => {
        const pair = pairs.find(entry => heroId(entry?.heroId) === otherId && rowMatchesPosition(entry, positionId));
        if (!pair) { componentCoverage.missing++; return null; }
        const normalized = countRows(pair);
        if (normalized && normalized.games < MIN_PAIR_GAMES) { componentCoverage.lowSample++; return null; }
        const broadRolePair = quality.pairRoleFiltered === false || row.pairRoleFiltered === false || row.provenance?.pairRoleFiltered === false || pair?.roleFiltered === false || pair?.provenance?.roleFiltered === false;
        // A globally useful matchup does not establish that a hero is played
        // successfully on a selected position with no observed role sample.
        if (quality.roleFiltered && broadRolePair && !baselineUsed) { componentCoverage.rejected++; return null; }
        if (requirePositionData && !baselineUsed && (!quality.pairs.roleFiltered || broadRolePair)) { componentCoverage.rejected++; return null; }
        const value = pairEvidence(pair, quality.roleFiltered && broadRolePair ? null : baselineUsed ? baseline : null, quality.pairs);
        const scopeWeight = broadRolePair && (quality.roleFiltered || quality.positionEstimated) ? CROSS_POSITION_PAIR_WEIGHT : 1;
        if (value) componentCoverage.used++; else componentCoverage.rejected++;
        return value ? { ...value, sourceEffect: value.effect, effect: value.effect * scopeWeight, scopeWeight, otherId, type, broadRolePair } : null;
      }).filter(Boolean);
      if (evidence.length) {
        // Accumulate known context: a neutral or missing new pick must never
        // erase an existing counter. This remains a bounded ranking index;
        // overlapping rates and counts are not a match win probability.
        const contribution = evidence.reduce((sum, entry) => sum + entry.effect * weight, 0);
        statScore += contribution;
        if (type === 'enemy') enemyContribution += contribution;
        else allyContribution += contribution;
        evidenceCount += evidence.length;
        broadEvidenceCount += evidence.filter(entry => entry.broadRolePair).length;
        pairSamples.push(...evidence.map(entry => entry.games));
        for (const entry of evidence) {
          matchupEvidence.push({ heroId: entry.otherId, name: nameFor(entry.otherId, heroes), side: type,
            games: entry.games, wins: entry.wins, rawWinRate: entry.winRate, advantagePp: entry.relative * 100,
            contribution: entry.effect * weight, roleFiltered: quality.pairs.roleFiltered && !entry.broadRolePair,
            displayRelevant: Math.abs(entry.sourceEffect) >= PAIR_EXPLANATION_EFFECT,
            shrink: entry.shrink, scopeWeight: entry.scopeWeight, advantageMethod: entry.advantageMethod,
            nativeAdjusted: entry.nativeAdjusted, adjusted: entry.adjusted });
          const direction = entry.effect >= 0 ? 'лучше' : 'хуже';
          const delta = Math.abs(entry.relative * 100).toFixed(1).replace('.', ',');
          const comparison = entry.computedAdvantage ? `${type === 'enemy' ? 'преимущество' : 'совместимость'} с поправкой на общие винрейты обоих героев ${entry.relative >= 0 ? '+' : '−'}${delta} п.п.`
            : entry.adjusted ? type === 'enemy' ? `скорректированное ${entry.effect >= 0 ? 'преимущество' : 'отставание'} источника ${delta} п.п.` : `скорректированная совместимость источника ${entry.relative >= 0 ? '+' : '−'}${delta} п.п.`
            : `результат ${direction} общей выборки ${nameFor(id, heroes)} на ${delta} п.п.`;
          const text = `${quality.sourceLabel}: ${type === 'enemy' ? 'против' : 'с'} ${nameFor(entry.otherId, heroes)} ${comparison} (${entry.games} матчей; эффект сглажен).${entry.broadRolePair ? ' Пара без фильтра по позиции; эффект из её общей выборки.' : ''}`;
          // Display meaningful source evidence even when its ranking influence
          // is reduced for scope mismatch; do not hide the actual observation.
          if (Math.abs(entry.sourceEffect) >= PAIR_EXPLANATION_EFFECT) (entry.effect >= 0 ? reasons : risks).push({ weight: Math.abs(entry.effect) * weight + 4, text });
        }
      }
    };
    collect(enemies, 'matchups', ENEMY_MATCHUP_SCALE, 'enemy');
    collect(allies, 'synergies', ALLY_SYNERGY_SCALE, 'ally');
    score += statScore;
    const hasPositionData = Boolean(baselineUsed && baselineHasPosition || matchupEvidence.some(entry => entry.roleFiltered));
    const dataUsed = (evidenceCount > 0 || baselineUsed) && (!requirePositionData || hasPositionData);
    const coverage = knownCount ? evidenceCount / knownCount : 0;
    dataCoverage.knownPairs = knownCount;
    dataCoverage.usedPairs = evidenceCount;
    const sampleCount = pairSamples.length ? Math.min(...pairSamples) : baselineUsed ? baseline.games : 0;
    const usedQualities = [...(baselineUsed ? [quality.baseline] : []), ...(evidenceCount ? [quality.pairs] : [])];
    const reliable = usedQualities.length > 0 && usedQualities.every(component => component.reliableScope);
    const fresh = usedQualities.length > 0 && usedQualities.every(component => component.age !== null && component.age <= 3 * DAY_MS);
    const recent = usedQualities.length > 0 && usedQualities.every(component => component.age !== null && component.age <= 7 * DAY_MS);
    const confidence = reliable && fresh && !broadEvidenceCount && evidenceCount && knownCount >= 3 && coverage >= .75 && sampleCount >= 500 ? 'high' : reliable && recent && (!broadEvidenceCount && evidenceCount && knownCount >= 2 && coverage >= .5 && sampleCount >= 100 || !knownCount && sampleCount >= 1000) ? 'medium' : 'low';
    if (!dataUsed) reasons.push({ weight: 0, text: requirePositionData && !hasPositionData
      ? `Нет сопоставимой статистики этого героя на позиции ${positionId}. Общие матчапы не подтверждают его пригодность на выбранной позиции.`
      : quality.rejected ? 'Статистическая выборка отклонена: рекомендация по этому герою пока недоступна.' : 'Нет сопоставимой статистической выборки этого героя. Он доступен для выбора, но не получает выдуманную оценку.' });
    else if (!reasons.length) reasons.push({ weight: 0, text: `Учтено статистических сочетаний: ${evidenceCount}. Значимые преимущества по имеющейся выборке не подтверждены.` });
    if (dataUsed && knownCount && evidenceCount < knownCount) risks.push({ weight: 0, text: `Нет сопоставимых данных для ${knownCount - evidenceCount} из ${knownCount} известных участников драфта; недостающие пары не считаются преимуществом.` });
    totalEvidence += evidenceCount;
    totalBroadEvidence += broadEvidenceCount;
    const finalScore = dataUsed ? Math.round(clamp(score, 0, 100) * 10) / 10 : null;
    const draftAssessment = assessDraft({ dataUsed, evidence: matchupEvidence, coverage: dataCoverage,
      baseline: baselineUsed ? baseline : null, positionId, roleFiltered: quality.roleFiltered && baselineUsed,
      positionEstimated: quality.positionEstimated && baselineUsed,
      contributions: { baseline: baselineContribution, enemies: enemyContribution, allies: allyContribution } });
    return {
      heroId: id, name: nameFor(id, heroes), score: finalScore, rawScore: dataUsed ? score : null,
      scoreBreakdown: dataUsed ? { initial: 50, baseline: baselineContribution, enemies: enemyContribution, allies: allyContribution, total: score } : null,
      baselineWinRate: baselineUsed ? baseline.winRate : null, baselineGames: baselineUsed ? baseline.games : 0,
      dataCoverage, dataFreshness: { baseline: freshnessDetails(quality.baseline), pairs: freshnessDetails(quality.pairs) },
      matchupEvidence, draftAssessment, negativePairCount: matchupEvidence.filter(entry => entry.advantagePp < 0).length,
      positionId, hasPositionData, roleFitScore: 0, roleFitLabel: (quality.roleFiltered || matchupEvidence.some(entry => entry.roleFiltered)) && dataUsed ? 'Есть статистика выбранной позиции' : quality.positionEstimated && dataUsed ? 'Позиция оценена по линии и фарму' : roleFit.label,
      roleFiltered: quality.roleFiltered && dataUsed,
      pairRoleFiltered: evidenceCount ? quality.pairs.roleFiltered && !broadEvidenceCount : null,
      positionEstimated: quality.positionEstimated && dataUsed,
      fitLabel: assessmentLabel(draftAssessment),
      reasons: reasons.sort((a, b) => b.weight - a.weight).slice(0, 2).map(entry => entry.text),
      risks: risks.sort((a, b) => b.weight - a.weight).slice(0, 2).map(entry => entry.text),
      confidence, confidenceLabel: CONFIDENCE_LABELS[confidence], sampleCount, sampleLabel: pairSamples.length ? 'Наименьшая выборка учтённой пары; матчи между парами могут пересекаться' : sampleCount ? 'Общая выборка героя; матчапы не подтверждены' : 'Без статистической выборки',
      dataUsed, pairCount: evidenceCount, draftCoverage: coverage,
    };
  }).sort((a, b) => Number(b.dataUsed) - Number(a.dataUsed) || (b.rawScore ?? 0) - (a.rawScore ?? 0) || a.heroId - b.heroId);
  const ranked = candidates.filter(candidate => candidate.dataUsed);
  for (let index = 0; index < ranked.length; index++) {
    const candidate = ranked[index], adjacent = [ranked[index - 1], ranked[index + 1]].filter(Boolean);
    const nearestGap = adjacent.length ? Math.min(...adjacent.map(other => Math.abs(candidate.rawScore - other.rawScore))) : null;
    candidate.comparison = { status: 'unproven', nearestGap, closeScore: nearestGap !== null && nearestGap <= CLOSE_SCORE_THRESHOLD,
      threshold: CLOSE_SCORE_THRESHOLD, method: 'score_gap_heuristic' };
  }
  const recommendations = candidates.filter(candidate => candidate.dataUsed).slice(0, 5);
  const confidence = recommendations[0]?.confidence || 'low';
  if (knownCount < 3) notes.push('Драфт ещё неполный: рекомендации изменятся после следующих пиков.');
  if (knownCount) notes.push('Позиции героев на линии не определены; оценивается весь известный драфт.');
  if (knownCount && quality.rows.length && !quality.rejected && !totalEvidence) notes.push('Нет сопоставимых пар с общей выборкой героя или подтверждённым преимуществом.');
  if (totalBroadEvidence) notes.push(`Винрейты выбранной позиции и общие пары используются как отдельные показатели. Пары не отфильтрованы по позиции; ${quality.advantageMethod === 'raw_pair_winrate' ? 'сравнивается исходный результат пары с общей выборкой героя, без подтверждённой поправки на силу второго героя' : 'используется скорректированный эффект источника или поправка на винрейты обоих героев внутри той же общей выборки'}. При базе выбранной позиции общие пары имеют четверть веса пар этой позиции; в общем резерве без роли этот коэффициент не применяется. Вклады известного драфта складываются в индекс; он не является вероятностью победы.`);
  if (recommendations.some(candidate => candidate.comparison?.closeScore)) notes.push('Близкие баллы: порядок рассчитан без округления, но преимущество одного героя статистически не доказано. Порог 0,5 балла — только предупреждение интерфейса, не доверительный интервал.');
  const coverageCount = candidates.filter(candidate => candidate.dataUsed).length;
  const dataUsed = coverageCount > 0;
  if (requirePositionData && pool.length && !dataUsed) notes.push(`Ожидаю статистику позиции ${positionId}. Общая статистика без наблюдений выбранной позиции не создаёт рекомендации.`);
  const summary = !pool.length ? 'Все доступные кандидаты уже выбраны или запрещены.' : !dataUsed ? requirePositionData
    ? `В каталоге ${catalogIds.length} героев. Ожидаю сопоставимую статистику позиции ${positionId}: без неё рекомендации не назначаются.`
    : `В каталоге ${catalogIds.length} героев. Ожидаю сопоставимую статистику: без неё рекомендации не назначаются.` : `${allies.length} союзн. · ${enemies.length} враг. · оценка пригодности, не вероятность победы. Статистика учтена со сглаживанием; данные есть для ${coverageCount} из ${pool.length} доступных героев.`;
  return { recommendations, candidates, positionId, requirePositionData, position: { ...position }, positionLabel: position.label,
    heroCount: catalogIds.length, catalogCount: catalogIds.length, candidateCount: pool.length, coverageCount,
    summary, confidence, sourceLabel: dataUsed ? quality.sourceLabel : 'Статистика не участвует', scopeLabel: quality.scopeLabel, roleFiltered: quality.roleFiltered, positionEstimated: quality.positionEstimated,
    notes: [...new Set(notes)], dataFreshness: { baseline: freshnessDetails(quality.baseline), pairs: freshnessDetails(quality.pairs) },
    model: { version: 'statistical-index-v2', baselinePriorGames: HERO_PRIOR_GAMES, pairPriorGames: PAIR_PRIOR_GAMES,
      positionBaselineScale: POSITION_BASELINE_SCALE, globalBaselineScale: GLOBAL_BASELINE_SCALE,
      enemyScale: ENEMY_MATCHUP_SCALE, allyScale: ALLY_SYNERGY_SCALE, crossPositionPairWeight: CROSS_POSITION_PAIR_WEIGHT },
    statsStatus: dataUsed ? 'used' : quality.baseline.rejected || quality.pairs.rejected ? 'rejected' : 'no_data', updatedAt: stats.updatedAt || null };
}

function freshnessDetails(quality) {
  return { observedFrom: quality.observedFrom, observedThrough: quality.observedThrough, ageDays: quality.ageDays,
    periodBoundsVerified: quality.periodBoundsVerified, periodStart: quality.periodStart,
    periodEndExclusive: quality.periodEndExclusive, periodPartial: quality.periodPartial, periodMethod: quality.periodMethod,
    observedThroughKind: quality.observedThroughKind, observedUntilExclusive: quality.observedUntilExclusive,
    status: quality.status, rejected: quality.rejected, scope: { ...quality.scope }, weight: quality.weight,
    roleFiltered: quality.roleFiltered, patchFiltered: quality.patchFiltered, rankFiltered: quality.rankFiltered };
}

module.exports = { evaluateDraft, MIN_PAIR_GAMES, MIN_HERO_GAMES, PAIR_PRIOR_GAMES, HERO_PRIOR_GAMES,
  POSITION_BASELINE_SCALE, GLOBAL_BASELINE_SCALE, CROSS_POSITION_PAIR_WEIGHT, ENEMY_MATCHUP_SCALE, ALLY_SYNERGY_SCALE, CLOSE_SCORE_THRESHOLD,
  observationTimestamp: timestamp };
