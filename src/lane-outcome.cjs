'use strict';

// This estimates the carry's own laning tempo. Local GSI cannot compare the
// opponent's economy, tower damage or support contribution; labels deliberately
// describe a difficult/successful lane rather than prove a competitive result.
const CHECKPOINT = 600;
const CHECKPOINT_MIN = 585;
const CHECKPOINT_MAX = 630;
const MIN_SPAN = 120;
const MIN_POINTS = 3;
const MIN_SAMPLE_INTERVAL = 20;
const LABELS = Object.freeze({ won: 'Успешная линия', lost: 'Тяжёлая линия', even: 'Ровный темп', unknown: 'Мало данных' });

function number(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function nonnegative(value) { const valueNumber = number(value); return valueNumber !== null && valueNumber >= 0 ? valueNumber : null; }
function count(value) { const valueNumber = nonnegative(value); return valueNumber !== null && Number.isInteger(valueNumber) ? valueNumber : null; }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function matchKey(value) { return value === null || value === undefined ? null : String(value); }
function emptyAssessment(reason = 'Нужна история свежих GSI-сообщений: минимум три точки за две минуты.') {
  return { result: 'unknown', label: LABELS.unknown, confidence: 0, source: 'auto_metrics', reason, evidence: [], provisional: true, complete: false, supported: false, dataSufficient: false, measuredAtSeconds: null, matchId: null };
}

function newLaneOutcomeTrack() {
  return { matchId: null, lastGameTime: null, lastReceivedAt: null, samples: [], finalizedAssessment: null, assessment: emptyAssessment() };
}

function metricSeries(samples, key) {
  const points = samples.filter(sample => sample[key] !== null);
  const coverage = points.length >= MIN_POINTS && points.at(-1).gameTime - points[0].gameTime >= MIN_SPAN;
  // GSI counter regressions are inconsistent evidence. Do not invent a delta.
  const monotonic = points.every((sample, index) => !index || sample[key] >= points[index - 1][key]);
  return { points, coverage: coverage && monotonic, first: points[0], last: points.at(-1) };
}

function currentNetWorthBenchmark(provider, now, heroId=42) {
  provider = object(provider);
  const fetchedAt = Date.parse(provider.fetchedAt || '');
  if (provider.heroId !== heroId || provider.role !== 'carry' || provider.status !== 'available' || provider.patch?.verified !== true || !Number.isFinite(fetchedAt) || now - fetchedAt > 7 * 86400000 || fetchedAt - now > 60000) return null;
  const row = (Array.isArray(provider.benchmarks?.netWorth) ? provider.benchmarks.netWorth : []).find(point => point.minute === 10);
  if (!row || count(row.sampleSize) === null || row.sampleSize < 8 || nonnegative(row.p50) === null || row.p50 < 1000) return null;
  return { minute: 10, p50: row.p50, sampleSize: row.sampleSize, source: provider.source || null, fetchedAt: provider.fetchedAt };
}

function assess(samples, options) {
  const { matchId, now, farmTargets, proBuild, provisional,heroId=42 } = options;
  const latest = samples.at(-1);
  const common = { ...emptyAssessment(), matchId, measuredAtSeconds: latest?.gameTime ?? null, provisional };
  if (!latest || latest.gameTime < 300) return { ...common, reason: 'В начале линии рано оценивать темп; наблюдаю фарм и развитие героя.' };
  if (samples.length < MIN_POINTS || latest.gameTime - samples[0].gameTime < MIN_SPAN) return common;
  const cs = metricSeries(samples, 'lastHits'), levels = metricSeries(samples, 'level'), deaths = metricSeries(samples, 'deaths'), kills = metricSeries(samples, 'kills');
  const proposedTarget = nonnegative(object(farmTargets).cs10);
  const cs10 = proposedTarget !== null && proposedTarget >= 1 && proposedTarget <= 1000 ? proposedTarget : 50;
  const csTarget = cs10 * latest.gameTime / CHECKPOINT;
  const evidence = [], adverseGroups = new Set(), positiveGroups = new Set(), neutralGroups = new Set();
  const add = (type, direction, group, detail) => {
    evidence.push({ type, direction, group, source: 'GSI', ...detail });
    if (direction === 'behind') adverseGroups.add(group);
    if (direction === 'ahead') positiveGroups.add(group);
    if (direction === 'on_track') neutralGroups.add(group);
  };
  if (cs.coverage && cs.last.gameTime === latest.gameTime && csTarget >= 20) {
    const ratio = cs.last.lastHits / csTarget;
    const direction = ratio < .70 ? 'behind' : ratio > 1.30 ? 'ahead' : 'on_track';
    add('last_hits', direction, 'economy', { actual: cs.last.lastHits, target: Math.round(csTarget), target10: cs10, comparisonSource: 'personal_target', reason: `${cs.last.lastHits} LH при личном ориентире ${Math.round(csTarget)}.` });
  }
  if (levels.coverage && levels.last.gameTime === latest.gameTime) {
    const levelGain = levels.last.level - levels.first.level;
    const strongLevel = latest.gameTime >= 540 ? 8 : latest.gameTime >= 420 ? 7 : 6;
    const weakLevel = latest.gameTime >= 540 ? 5 : latest.gameTime >= 420 ? 4 : 3;
    const direction = levels.last.level >= strongLevel && levelGain >= 1 ? 'ahead' : levels.last.level <= weakLevel && levelGain <= 1 ? 'behind' : levelGain >= 1 ? 'on_track' : 'unknown';
    if (direction !== 'unknown') add('level_progress', direction, 'experience', { actual: levels.last.level, gain: levelGain, spanSeconds: levels.last.gameTime - levels.first.gameTime, comparisonSource: 'reviewed_carry_heuristic', reason: `Уровень ${levels.last.level}; за наблюдаемый отрезок +${levelGain} ур.` });
  }
  if (deaths.coverage && deaths.last.gameTime === latest.gameTime) {
    const delta = deaths.last.deaths - deaths.first.deaths;
    // Already recorded deaths at attachment are not attributed to this lane.
    if (delta >= 2) add('observed_deaths', 'behind', 'survival', { delta, spanSeconds: deaths.last.gameTime - deaths.first.gameTime, reason: `${delta} новых смертей за наблюдаемый отрезок.` });
  }
  if (kills.coverage && kills.last.gameTime === latest.gameTime) {
    const delta = kills.last.kills - kills.first.kills;
    if (delta >= 2) add('observed_kills', 'ahead', 'combat', { delta, spanSeconds: kills.last.gameTime - kills.first.gameTime, reason: `${delta} убийства за наблюдаемый отрезок; участие саппорта неизвестно.` });
  }
  // Net worth is optional, exact and from a current sufficient carry sample.
  // It belongs to the SAME economy group as CS, so two farm metrics never
  // masquerade as two independent signs. No wallet/item-price reconstruction.
  const benchmark = !provisional ? currentNetWorthBenchmark(proBuild, now,heroId) : null;
  const networth = latest.netWorth;
  if (benchmark && networth !== null && Math.abs(latest.gameTime - CHECKPOINT) <= 15) {
    const ratio = networth / benchmark.p50;
    add('exact_net_worth', ratio < .70 ? 'behind' : ratio > 1.30 ? 'ahead' : 'on_track', 'economy', { actual: networth, benchmark: benchmark.p50, sampleSize: benchmark.sampleSize, comparisonSource: benchmark.source, reason: `Точный NW ${networth}; медиана выборки ${Math.round(benchmark.p50)} (n=${benchmark.sampleSize}).` });
  }
  let result = 'unknown';
  if (adverseGroups.size >= 2 && positiveGroups.size === 0) result = 'lost';
  else if (positiveGroups.size >= 2 && adverseGroups.size === 0) result = 'won';
  else if (neutralGroups.has('economy') && neutralGroups.has('experience') && adverseGroups.size === 0) result = 'even';
  const supported = result !== 'unknown';
  const dataSufficient = new Set(evidence.map(point => point.group)).size >= 2;
  const label = result === 'unknown' && dataSufficient ? 'Неоднозначная линия' : LABELS[result];
  const confidence = supported ? (result === 'even' ? .50 : .58 + Math.min(2, (result === 'lost' ? adverseGroups.size : positiveGroups.size) - 2) * .06) * (provisional ? .80 : 1) : 0;
  const phaseNote = provisional ? 'Предварительно, до 10-й минуты. ' : 'По доступным признакам около 10-й минуты. ';
  const reasons = evidence.map(point => point.reason).join(' ');
  return { ...common, result, label, confidence, evidence, supported, dataSufficient,
    reason: supported ? `${phaseNote}${reasons} Это оценка твоего темпа: экономика соперников и вклад саппорта неизвестны.` : `${phaseNote}${reasons ? `${reasons} ` : ''}Не хватает двух согласованных независимых признаков; один фарм или убийство не определяют исход линии.` };
}

function updateLaneOutcome(previous, input = {}) {
  const state = object(input.state), now = number(input.now) ?? Date.now();
  const time = number(state.gameTime), receivedAt = number(state.receivedAt), incomingMatch = matchKey(state.matchId);
  let track = previous && Array.isArray(previous.samples) ? { ...previous, samples: previous.samples.slice() } : newLaneOutcomeTrack();
  const supported=state.isSupportedCarry===true&&Boolean(require('./product.cjs').getHeroProfile(state.heroId))||state.isWraithKing===true&&(!state.heroId||state.heroId===42);
  const live = state.status === 'live' && supported && state.isSpectator !== true && state.isPaused !== true && state.dataQuality?.hero !== false && time !== null && time >= 0 && receivedAt !== null && now - receivedAt <= 15000 && receivedAt - now <= 1000;
  if (!live) {
    track.assessment = { ...emptyAssessment('Нужны свежие данные своего керри из GSI; во время паузы и без связи оценка не обновляется.'), matchId: track.matchId };
    return track;
  }
  const newMatch = incomingMatch !== null && track.matchId !== null && incomingMatch !== track.matchId;
  const heroId=state.heroId||42,heroChanged=track.heroId!=null&&track.heroId!==heroId;
  const rewind = time !== null && track.lastGameTime !== null && time < track.lastGameTime - 5;
  if (newMatch || rewind || heroChanged) track = newLaneOutcomeTrack();track.heroId=heroId;
  if (incomingMatch !== null) track.matchId = incomingMatch;
  if (track.finalizedAssessment) { track.assessment = { ...track.finalizedAssessment }; return track; }
  const last = track.samples.at(-1);
  if (receivedAt !== track.lastReceivedAt && (track.lastGameTime === null || time >= track.lastGameTime) && time <= CHECKPOINT_MAX && (!last || time - last.gameTime >= MIN_SAMPLE_INTERVAL || time >= CHECKPOINT && last.gameTime < CHECKPOINT)) {
    const level = count(state.level);
    track.samples.push({ gameTime: time, receivedAt, lastHits: count(state.lastHits), level: level !== null && level >= 1 && level <= 30 ? level : null, deaths: count(state.deaths), kills: count(state.kills), netWorth: nonnegative(state.netWorth) });
    track.samples = track.samples.slice(-64);
    track.lastReceivedAt = receivedAt;
  }
  track.lastGameTime = time;
  track.assessment = assess(track.samples, { matchId: track.matchId, now, farmTargets: input.farmTargets, proBuild: input.proBuild, provisional: time < CHECKPOINT,heroId });
  if ((time >= CHECKPOINT && track.samples.at(-1)?.gameTime >= CHECKPOINT_MIN) || time > CHECKPOINT_MAX) {
    // A late attachment cannot reconstruct minute 10 from minute 25 numbers.
    if ((!last && time > CHECKPOINT_MAX) || track.samples.at(-1)?.gameTime < CHECKPOINT_MIN || !track.samples.length) track.assessment = { ...emptyAssessment('Не было достаточной истории около 10-й минуты; поздний фарм не восстанавливает исход линии.'), matchId: track.matchId, provisional: false };
    track.assessment = { ...track.assessment, provisional: false, complete: true };
    track.finalizedAssessment = { ...track.assessment };
  }
  return track;
}

module.exports = { newLaneOutcomeTrack, updateLaneOutcome, currentNetWorthBenchmark, LABELS };
