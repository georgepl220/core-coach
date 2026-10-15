'use strict';

const { laneAdvice, postLaneAdvice, HERO_RULES, ALLY_RULES } = require('./coaching.cjs');
const { stageFor, skillsFor, stageAdviceFor } = require('./stages.cjs');
const { carryRuleFor, carryLaneAdvice, ownSkillAdvice } = require('./carry-rules.cjs');
const SOURCE = 'Подтверждённые герои линии + авторские правила WK; механики Valve, проверка 12.10.2026';
const DEFAULT_TARGETS = Object.freeze({ cs10: 50, cs20: 140, cs30: 230 });
const MECHANICS_URL = 'https://www.dota2.com/datafeed/herodata?language=english&hero_id=';
const EXTRA_RULES = Object.freeze({
  49: { name: 'Dragon Knight', risk: 2, reason: 'Breathe Fire снижает урон атак WK, Dragon Blood даёт Dragon Knight броню и восстановление: долгий физический размен обычно не окупается.', tip: 'После Breathe Fire добивай агром, а стан используй на отделившемся саппорте; не пытайся перебить восстановление здорового DK.', retreat: 'При Elder Dragon Form не защищай башню один: проверь поддержку и выход из линии.' },
  97: { name: 'Magnus', risk: 2, reason: 'Shockwave подтягивает, а Skewer может увести WK из безопасной позиции. Empower усиливает урон Magnus и cleave.', tip: 'Не стой на пути Skewer к вражеской башне; после потраченного Skewer возможен короткий стан с союзником.', retreat: 'Не собирайся вплотную с командой под Reverse Polarity; не преследуй Magnus без обзора за спиной.' },
  44: { name: 'Phantom Assassin', risk: 1, reason: 'Stifling Dagger даёт физический харасс и замедление, Phantom Strike — быстрый подход. Immaterial даёт уклонение: одних атак может не хватить.', tip: 'С союзным контролем ищи короткий размен после Phantom Strike; не принимай длинный обмен ударами с её бонусом скорости атаки.', retreat: 'При слабом здоровье не фарми далеко от союзников: Dagger и Phantom Strike позволяют быстро догнать.' },
  137: { name: 'Primal Beast', risk: 3, hardTrade: true, reason: 'Onslaught Primal Beast сокращает дистанцию, Trample наказывает стояние рядом; Uproar даёт броню и урон после полученного харасса.', tip: 'Смещайся в сторону от Onslaught; сохраняй стан для опасного сближения и разрывай контакт при Trample вместо длинного размена.', retreat: 'Не возвращайся один под Onslaught/Pulverize; держи путь отхода и помощь союзника.' },
  138: { name: 'Muerta', risk: 2, reason: 'Dead Shot Muerta может оттолкнуть страхом через рикошет от дерева или юнита; The Calling замедляет, а ревенанты дают silence.', tip: 'Не стой на очевидной линии рикошета Dead Shot; выходи из The Calling по свободной стороне, не через ревенанта.', retreat: 'Во время Pierce the Veil Muerta становится ethereal и меняет урон атак на магический: не рассчитывай на обычные атаки WK для ответного добивания.' },
});

function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function finite(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function nonnegative(value) { const number = finite(value); return number === null || number < 0 ? null : number; }
function key(value) { return typeof value === 'string' ? value.replace(/^item_/, '') : ''; }
function heroId(value) { const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : finite(value); return number !== null && number > 0 && Number.isInteger(number) ? number : null; }
function opponentIds(context) { return [...new Set((Array.isArray(context.laneEnemyHeroIds) ? context.laneEnemyHeroIds : []).map(heroId).filter(Boolean))].slice(0, 2); }

function economyFor(state, dataset, context = {}) {
  state = object(state); dataset = object(dataset); context = object(context);
  const desired = object(context.farmTargets), targets = {};
  for (const [name, fallback] of Object.entries(DEFAULT_TARGETS)) {
    const proposed = nonnegative(desired[name] ?? (name === 'cs10' ? context.farmTarget10 : null));
    targets[name] = proposed !== null && proposed >= 1 && proposed <= 1000 ? Math.round(proposed) : fallback;
  }
  targets.cs20 = Math.max(targets.cs10, targets.cs20);
  targets.cs30 = Math.max(targets.cs20, targets.cs30);
  const time = nonnegative(state.gameTime), minutes = time === null ? null : time / 60;
  const points = [{ minute: 0, cs: 0 }, { minute: 10, cs: targets.cs10 }, { minute: 20, cs: targets.cs20 }, { minute: 30, cs: targets.cs30 }];
  let targetCs = null;
  if (minutes !== null && minutes <= 30) {
    const next = points.find(point => point.minute >= minutes) || points.at(-1);
    const previous = points[Math.max(0, points.indexOf(next) - 1)];
    targetCs = next.minute === previous.minute ? next.cs : Math.round(previous.cs + (next.cs - previous.cs) * (minutes - previous.minute) / (next.minute - previous.minute));
  }
  const lastHits = nonnegative(state.lastHits), csDelta = lastHits !== null && targetCs !== null ? lastHits - targetCs : null;
  const tolerance = targetCs === null ? null : Math.max(5, Math.round(targetCs * .15));
  const pace = csDelta === null || targetCs < 5 ? 'unknown' : csDelta < -tolerance ? 'behind' : csDelta > tolerance ? 'ahead' : 'on_track';
  const exactNetWorth = nonnegative(state.netWorth);
  let netWorth = exactNetWorth, valueSource = exactNetWorth !== null ? 'GSI' : 'unknown', valueCaveat = null;
  // Item-price sums are only a rough reconstruction. Missing items must not
  // produce an apparently complete total; never substitute wallet gold alone.
  if (netWorth === null && nonnegative(state.gold) !== null && state.dataQuality?.inventory === true && Array.isArray(state.inventory)) {
    let estimate = state.gold, complete = true;
    for (const item of state.inventory) {
      if (/^neutral/.test(item.slot || '')) continue;
      const price = nonnegative(object(dataset.items)[key(item.name)]?.cost);
      if (price === null) { complete = false; break; }
      estimate += price;
    }
    if (complete && state.inventory.length) {
      netWorth = estimate; valueSource = 'estimate';
      valueCaveat = 'Примерно: стоимость известного инвентаря + золото. Не учтены предметы курьера, поглощённые улучшения и расходование зарядов.';
    }
  }
  const checkpointMinute = minutes === null ? 10 : minutes <= 10 ? 10 : minutes <= 20 ? 20 : 30;
  const history = [...(Array.isArray(context.history) ? context.history : []), ...((nonnegative(context.laneSnapshot?.gameTime) !== null) ? [context.laneSnapshot] : [])];
  const checkpoints = [10, 20, 30].map(minute => {
    const sample = history.filter(point => nonnegative(point.gameTime) !== null && Math.abs(point.gameTime - minute * 60) <= 15 && nonnegative(point.lastHits) !== null && (time === null || point.gameTime <= time)).sort((a, b) => Math.abs(a.gameTime - minute * 60) - Math.abs(b.gameTime - minute * 60))[0];
    const actualCs = sample?.lastHits ?? (time === minute * 60 ? lastHits : null);
    return { minute, targetCs: targets[`cs${minute}`], actualCs, measuredAtSeconds: sample?.gameTime ?? (actualCs !== null ? time : null), complete: minutes !== null && minutes >= minute };
  });
  const provider = object(context.proBuild ?? dataset.proTracker);
  const empirical = provider.heroId === 42 && provider.role === 'carry' ? object(provider.benchmarks) : {};
  const cleanBenchmark = point => {
    const row = object(point);
    if (nonnegative(row.minute) === null || nonnegative(row.p50) === null || nonnegative(row.sampleSize) === null || row.sampleSize < 1) return null;
    return { minute: row.minute, p25: nonnegative(row.p25), p50: row.p50, p75: nonnegative(row.p75), sampleSize: row.sampleSize };
  };
  const benchmarkRows = type => (Array.isArray(empirical[type]) ? empirical[type] : []).map(cleanBenchmark).filter(Boolean);
  const benchmarks = { lastHits: benchmarkRows('lastHits'), netWorth: benchmarkRows('netWorth'), source: provider.source || null, sourceUrl: provider.sourceUrl || null, patch: provider.patch || null };
  return {
    netWorth, exact: valueSource === 'GSI', valueSource, valueCaveat,
    lastHits, denies: nonnegative(state.denies), gpm: nonnegative(state.gpm), xpm: nonnegative(state.xpm), kills: nonnegative(state.kills), deaths: nonnegative(state.deaths),
    targetCs, csDelta, pace, tolerance, targets, target10: targets.cs10,
    checkpoint: checkpoints.find(point => point.minute === checkpointMinute), checkpoints,
    checkpoint10: checkpoints[0], checkpoint20: checkpoints[1], checkpoint30: checkpoints[2],
    targetsSource: 'personal', source: 'Настраиваемая личная цель',
    benchmarks,
    benchmark10: { lastHits: benchmarks.lastHits.find(point => point.minute === 10) || null, netWorth: benchmarks.netWorth.find(point => point.minute === 10) || null, source: benchmarks.source, sourceUrl: benchmarks.sourceUrl },
    comparison: lastHits === null || targetCs === null ? 'Недостаточно данных' : `${Math.round(lastHits)} / ${targetCs} LH`,
    reason: '50 LH к 10 минуте — стартовый личный ориентир. Цели 10/20/30 минут можно менять; это не норма и не статистика профессиональных игроков.',
  };
}

function coachingFor(state, dataset, context = {}) {
  const carry = carryRuleFor(state, dataset, context);
  if (carry && carry.id !== 42) return carryCoachingFor(state, dataset, context, carry);
  const economy = economyFor(state, dataset, context);
  const selectedIds = opponentIds(context);
  const currentScreen = context.laneSource === 'screen_current';
  const conditionalOnly = currentScreen || context.staticMatchup === true;
  const screenLane = ['screen', 'screen_scene', 'screen_current', 'screen_history', 'mixed'].includes(context.laneSource);
  const demoLane = context.laneSource === 'demo';
  const normalizedContext = { ...context, laneEnemyHeroIds: selectedIds };
  const base = laneAdvice(state, dataset, normalizedContext);
  const rules = selectedIds.map(id => ({ ...(EXTRA_RULES[id] || HERO_RULES[id] || {}), id })).filter(rule => rule.reason);
  const covered = rules.length === selectedIds.length && selectedIds.length > 0;
  let lane = { ...base, stance: !selectedIds.length || !covered ? 'unknown' : base.style, evidence: [] };
  if (rules.some(rule => EXTRA_RULES[rule.id])) {
    const names = base.opponents.map(hero => hero.name).join(' + ');
    const hasHardTrade = rules.some(rule => rule.hardTrade), risk = rules.reduce((sum, rule) => sum + rule.risk, 0);
    lane.style = risk >= 4 || hasHardTrade || nonnegative(state.healthPercent) !== null && state.healthPercent < 55 ? 'defensive' : 'balanced';
    lane.stance = covered ? lane.style : 'unknown';
    lane.title = `Против ${names}: ${lane.style === 'defensive' ? 'береги здоровье' : 'фарм и короткие размены'}`;
    lane.reason = rules.sort((a, b) => b.risk - a.risk).map(rule => rule.reason).join(' ');
    lane.tips = rules.map(rule => rule.tip).filter(Boolean).slice(0, 2);
    lane.confidence = selectedIds.length ? rules.length / selectedIds.length * .8 : 0;
  }
  if (!covered && selectedIds.length) {
    lane.stance = 'unknown';
    lane.title = 'Для части линии не хватает правил';
    lane.reason += ' Общая оценка агрессии не подтверждена: для одного из выбранных героев нет проверенного правила.';
  }
  if (!selectedIds.length && context.laneSource !== 'manual') {
    lane.title = 'Наблюдаю состав линии';
    lane.reason = 'Жду повторных уверенных наблюдений героев рядом с WK на миникарте или возле полосок здоровья. Пять портретов показывают состав, но не подтверждают, кто стоит на линии. Совет появится после подтверждения видимых героев.';
  }
  if (selectedIds.includes(2) && selectedIds.includes(101)) {
    lane.style = lane.stance = 'defensive';
    lane.title = 'Axe + Skywrath: не отдавай вход под Call';
    lane.reason = 'Berserker’s Call Axe удерживает WK под магическим уроном Skywrath; Ancient Seal усиливает урон заклинаний и запрещает ответный стан. Counter Helix наказывает контакт в волне.';
    lane.tips = ['Добивай с края волны и агри крипов к своей стороне. Разделяйся с саппортом, чтобы один Call не удержал обоих; не отдавай здоровье под Bolt ради одного крипа.', 'Окно ответа — после потраченного Call и с союзным контролем по Skywrath; не преследуй его через Axe и большую волну. Готовность чужих заклинаний проверь на экране.'];
  }
  if(selectedIds.includes(2)&&selectedIds.includes(22)){
    lane.style=lane.stance='defensive';lane.title='Axe + Zeus: береги здоровье на волне';
    lane.reason='Call Axe удерживает WK под молниями Zeus, а Counter Helix наказывает длинный контакт в крипах. Arc Lightning переходит между близкими юнитами: фарми короткими подходами и сохраняй здоровье.';
    lane.tips=['Агри крипов к своей стороне и добивай с края волны. Разделяйся с напарником, чтобы один Call не удержал обоих; не принимай повторные молнии ради одного крипа.',context.laneAllyHeroId===26?'Окно атаки — после потраченного Call, если Zeus отделился и его Heavenly Jump уже использован: Lion начинает Hex / Earth Spike, WK продолжает станом. Не трать контроль одновременно; готовность чужих умений проверь на экране.':'Короткий вход по отделившемуся Zeus возможен с союзным контролем после потраченных Call и Heavenly Jump; не преследуй его через Axe. Готовность чужих умений проверь на экране.'];
  }
  const rawHealth = nonnegative(state.healthPercent), rawMana = nonnegative(state.manaPercent);
  if (selectedIds.length && rawHealth !== null && rawHealth < 55) {
    lane.style = lane.stance = 'defensive';
    lane.tips.unshift(`Твоё здоровье ${Math.round(rawHealth)}% ${demoLane ? 'в демонстрации' : 'по GSI'}: сначала восстановись, не начинай новый размен.`);
    lane.tips = lane.tips.slice(0, 2);
  } else if (lane.stance === 'aggressive') {
    // The presence/readiness of allied spells is not provided by local GSI.
    // This style is a conditional opportunity; the text must keep that limit.
    lane.evidence.push({ type: 'own_resources', healthPercent: rawHealth, manaPercent: rawMana, source: demoLane ? 'demo' : 'GSI' });
    lane.evidence.push({ type: 'ally_control', heroId: heroId(context.laneAllyHeroId), ready: null, nearby: null, source: demoLane ? 'demo' : screenLane ? 'repeated_screen_observations_or_manual' : 'manual_hero_choice' });
  }
  lane.evidence.unshift(...rules.map(rule => ({ type: 'hero_mechanic', heroId: rule.id, sourceUrl: `${MECHANICS_URL}${rule.id}` })));
  lane.source = selectedIds.length ? demoLane ? 'Демонстрационный состав линии + авторские правила WK; герои заданы для примера' : screenLane ? currentScreen ? 'Повторные наблюдения героев рядом с WK + авторские правила; исходный состав линии неизвестен' : context.laneSource === 'screen_history' ? 'Ранее наблюдавшийся состав линии + авторские правила WK; текущие позиции неизвестны' : context.laneSource === 'screen_scene' ? 'Повторные наблюдения героев возле полосок здоровья + авторские правила WK' : context.laneSource === 'mixed' ? 'Твой выбор и наблюдения экрана + авторские правила WK' : 'Повторные наблюдения миникарты + авторские правила WK' : SOURCE : 'Противники линии неизвестны; полный драфт не определяет линию';
  lane.detectionSource = demoLane ? 'demo' : screenLane ? context.laneSource : selectedIds.length ? 'manual' : 'unknown';
  lane.detectionStatus = demoLane ? 'demo' : context.laneStatus || (selectedIds.length ? 'confirmed' : 'observing');
  if (demoLane) lane.evidence.push({ type: 'lane_detection', source: 'demo', confidence: null, observedAt: null });
  if (screenLane) {
    const certainty = nonnegative(context.laneConfidence);
    lane.confidence = Math.min(lane.confidence, certainty === null ? 0 : Math.min(1, certainty));
    lane.evidence.push({ type: 'lane_detection', source: 'screen', confidence: certainty, observedAt: nonnegative(context.laneObservedAt) });
  }
  // The automatic tracker evaluates our own tempo across a real timeline;
  // it does not compare hidden enemy economy or prove a competitive win/loss.
  const manualOutcome = ['won', 'lost', 'even'].includes(context.laneResult) ? context.laneResult : ['won', 'lost', 'even'].includes(context.laneOutcome) ? context.laneOutcome : 'unknown';
  const automatic = object(context.laneOutcomeAssessment);
  const sameOutcomeMatch = automatic.matchId == null || state.matchId == null || String(automatic.matchId) === String(state.matchId);
  const automaticOutcome = sameOutcomeMatch && automatic.source === 'auto_metrics' && automatic.supported === true && automatic.provisional === false && automatic.complete === true && ['won', 'lost', 'even'].includes(automatic.result) ? automatic.result : 'unknown';
  const outcome = conditionalOnly ? 'unknown' : manualOutcome !== 'unknown' ? manualOutcome : automaticOutcome;
  const postLane = conditionalOnly ? null : postLaneAdvice({ ...state, deaths: null }, dataset, {
    ...normalizedContext, laneResult: manualOutcome === 'unknown' ? 'auto' : manualOutcome, laneOutcomeAssessment: sameOutcomeMatch ? automatic : {}, laneSnapshot: {}, farmAssessment: economy.pace,
  });
  if (postLane) {
    const specific = rules.find(rule => EXTRA_RULES[rule.id]);
    if (specific?.retreat) postLane.reason += ` ${specific.name}: ${specific.retreat}`;
    postLane.economicPace = economy.pace;
    postLane.outcome = postLane.result;
  }
  lane.outcome = outcome;
  lane.outcomeSource = conditionalOnly ? 'unknown' : manualOutcome !== 'unknown' ? 'manual' : 'auto_metrics';
  lane.outcomeAssessment = conditionalOnly ? {} : manualOutcome !== 'unknown' ? { result: manualOutcome, label: { won: 'Успешная линия', lost: 'Тяжёлая линия', even: 'Ровный темп' }[manualOutcome], source: 'manual', confidence: 1, supported: true, provisional: false, complete: true, reason: 'Оценка скорректирована тобой.' } : sameOutcomeMatch ? automatic : {};
  lane.planAfterLane = postLane ? { title: postLane.title, reason: postLane.reason, priorities: postLane.priorities } : null;
  const stage = stageFor(state, context), skills = skillsFor(state, dataset, context);
  // A current visible group can occur after laning, during a pause or while
  // GSI is missing. Describe conditional interactions without making it the
  // original lane, assuming levels, or claiming that a spell is ready now.
  const stageAdvice = conditionalOnly ? {
    mainTitle: lane.title,
    mainReason: lane.reason,
    skillUseTitle: lane.ally?.setup ? `Согласуй ${lane.ally.name} и свой стан` : 'Стан — для короткого ответа или отхода',
    skillUseReason: `${lane.tips[1] || (lane.ally?.setup ? `Если ${lane.ally.name} рядом и ${lane.ally.setup} доступен, продолжи его контроль Wraithfire Blast; не накладывайте контроль одновременно без причины.` : 'Если Wraithfire Blast изучен и доступен, используй его для короткого ответа или отхода.')} Уровни, ману и готовность заклинаний проверь в игре перед действием.`,
    extraTitle: 'Проверь позицию и путь отхода',
    extraReason: lane.tips[0] || 'Позиции героев могут измениться после кадра; перед сближением проверь основной экран и поддержку.',
    confidence: lane.confidence,
    source: currentScreen ? 'screen_current' : 'manual_matchup',
  } : stageAdviceFor(state, dataset, context, stage, lane, postLane, economy);
  return { economy, lane, postLane, stage, stageAdvice, skills };
}

function carryCoachingFor(state, dataset, context, carry) {
  const economy = economyFor(state, dataset, context), selectedIds = opponentIds(context);
  const normalized = { ...context, laneEnemyHeroIds: selectedIds };
  const lane = carryLaneAdvice(state, dataset, normalized, { ...HERO_RULES, ...EXTRA_RULES }, ALLY_RULES);
  const currentScreen = context.laneSource === 'screen_current', demoLane = context.laneSource === 'demo';
  const conditionalOnly = currentScreen || context.staticMatchup === true;
  const screenLane = ['screen', 'screen_scene', 'screen_current', 'screen_history', 'mixed'].includes(context.laneSource);
  lane.evidence = selectedIds.filter(id => HERO_RULES[id] || EXTRA_RULES[id]).map(id => ({ type: 'hero_mechanic', heroId: id, sourceUrl: `${MECHANICS_URL}${id}` }));
  lane.detectionSource = demoLane ? 'demo' : screenLane ? context.laneSource : selectedIds.length ? 'manual' : 'unknown';
  lane.detectionStatus = demoLane ? 'demo' : context.laneStatus || (selectedIds.length ? 'confirmed' : 'observing');
  if (demoLane) lane.source = `Демонстрационный состав + авторские правила ${carry.name}; герои заданы для примера`;
  else if (currentScreen) lane.source = `Видимые герои рядом + авторские правила ${carry.name}; исходный состав линии неизвестен`;
  else if (screenLane) lane.source = `Наблюдения экрана и выбор состава + авторские правила ${carry.name}`;
  if (screenLane) {
    const certainty = nonnegative(context.laneConfidence);
    lane.confidence = Math.min(lane.confidence, certainty === null ? 0 : Math.min(1, certainty));
    lane.evidence.push({ type: 'lane_detection', source: 'screen', confidence: certainty, observedAt: nonnegative(context.laneObservedAt) });
  }
  const manualOutcome = ['won', 'lost', 'even'].includes(context.laneResult) ? context.laneResult : ['won', 'lost', 'even'].includes(context.laneOutcome) ? context.laneOutcome : 'unknown';
  const automatic = object(context.laneOutcomeAssessment), sameMatch = automatic.matchId == null || state.matchId == null || String(automatic.matchId) === String(state.matchId);
  const automaticOutcome = sameMatch && automatic.source === 'auto_metrics' && automatic.supported === true && automatic.provisional === false && automatic.complete === true && ['won', 'lost', 'even'].includes(automatic.result) ? automatic.result : 'unknown';
  lane.outcome = conditionalOnly ? 'unknown' : manualOutcome !== 'unknown' ? manualOutcome : automaticOutcome;
  lane.outcomeSource = conditionalOnly ? 'unknown' : manualOutcome !== 'unknown' ? 'manual' : 'auto_metrics';
  lane.outcomeAssessment = conditionalOnly ? {} : manualOutcome !== 'unknown' ? { result: manualOutcome, label: { won: 'Успешная линия', lost: 'Тяжёлая линия', even: 'Ровный темп' }[manualOutcome], source: 'manual', confidence: 1, supported: true, provisional: false, complete: true, reason: 'Оценка скорректирована тобой.' } : sameMatch ? automatic : {};
  const postLane = conditionalOnly ? null : postLaneAdvice({ ...state, deaths: null }, dataset, { ...normalized, laneResult: manualOutcome === 'unknown' ? 'auto' : manualOutcome, laneOutcomeAssessment: sameMatch ? automatic : {}, laneSnapshot: {}, farmAssessment: economy.pace });
  if (postLane) { postLane.economicPace = economy.pace; postLane.outcome = postLane.result; }
  lane.planAfterLane = postLane ? { title: postLane.title, reason: postLane.reason, priorities: postLane.priorities } : null;
  const stage = stageFor(state, context), skills = skillsFor(state, dataset, context);
  const conditionalSkill = ownSkillAdvice({}, dataset, context, lane);
  const stageAdvice = conditionalOnly ? { mainTitle: lane.title, mainReason: lane.reason, skillUseTitle: 'Согласуй способности с напарником', skillUseReason: `${carry.combo} Уровни, ману и готовность навыков проверь в игре.`, extraTitle: 'Проверь путь отхода', extraReason: lane.tips[0] || conditionalSkill.reason, confidence: lane.confidence, source: currentScreen ? 'screen_current' : 'manual_matchup' } : stageAdviceFor(state, dataset, context, stage, lane, postLane, economy);
  return { economy, lane, postLane, stage, stageAdvice, skills };
}

module.exports = { economyFor, coachingFor, DEFAULT_TARGETS };
