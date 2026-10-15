'use strict';

// Deterministic stages and reviewed WK heuristics. They do not infer hidden
// enemies, enemy cooldowns or a lane result from the player's economy.
const STAGES = Object.freeze([
  { id: 'pregame', title: 'Подготовка' },
  { id: 'laning', title: 'Линия' },
  { id: 'transition', title: 'После линии' },
  { id: 'midgame', title: 'Середина игры' },
  { id: 'lategame', title: 'Поздняя игра' },
]);
const ABILITY_HOTKEYS = Object.freeze({ skeleton_king_hellfire_blast: 'Q', skeleton_king_bone_guard: 'W', skeleton_king_spectral_blade: 'W', skeleton_king_mortal_strike: 'E', skeleton_king_reincarnation: 'R' });
const { carryRuleFor, ownSkillAdvice, ultimateAdvice } = require('./carry-rules.cjs');
function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function number(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function integer(value) { const n = number(value); return n !== null && Number.isInteger(n) && n >= 0 ? n : null; }
function keys(state) { return new Set((Array.isArray(state.inventory) ? state.inventory : []).map(item => String(item.name || '').replace(/^item_/, ''))); }
function abilities(state) { return Array.isArray(state.abilities) ? state.abilities : []; }
function ownAbility(state, suffix) { return abilities(state).find(entry => entry.name === `skeleton_king_${suffix}` || entry.name === `wraith_king_${suffix}`); }

function stageFor(state, context = {}) {
  state = object(state); context = object(context);
  const override = STAGES.find(stage => stage.id === context.stageOverride);
  if (override) return { ...override, reason: 'Стадия выбрана тобой; автоматический переход отключён.', source: 'manual', automatic: false, matchId: state.matchId ?? null };
  const time = number(state.gameTime);
  let id = time === null || time < 0 || /HERO_SELECTION|STRATEGY_TIME|TEAM_SHOWCASE|WAIT_FOR_PLAYERS|PRE_GAME/.test(state.gameState || '') ? 'pregame' : time < 600 ? 'laning' : time < 900 ? 'transition' : time < 1800 ? 'midgame' : 'lategame';
  let reason = time === null ? 'Время матча пока неизвестно.' : id === 'pregame' ? 'Матч ещё не начался.' : `По времени матча: ${Math.floor(time / 60)}:${String(Math.floor(time % 60)).padStart(2, '0')}. Границы стадий — ориентир; стадию можно сменить вручную.`;
  // An early transition needs sustained progression evidence, not a transient
  // health/cooldown change. It cannot move a stage backwards when an item sells.
  const owned = keys(state);
  const carry = carryRuleFor(state, {}, { ...context, heroId: context.heroId ?? state.heroId ?? 42 });
  if (id === 'laning' && time >= 480 && state.level >= 8 && (carry?.progressItems || []).some(item => owned.has(item))) {
    id = 'transition'; reason = 'После 8-й минуты уже есть уровень 8+ и законченный основной предмет: предложен переход к плану после линии. Если линия продолжается, выбери её вручную.';
  }
  const previous = object(context.previousStage);
  const sameMatch = state.matchId != null && previous.matchId === state.matchId;
  if (sameMatch && previous.automatic !== false && time !== null && time >= 0 && STAGES.findIndex(stage => stage.id === previous.id) > STAGES.findIndex(stage => stage.id === id)) {
    id = previous.id; reason = 'Сохраняется достигнутая стадия текущего матча; смена предмета не возвращает подсказки к прошлой стадии.';
  }
  return { ...STAGES.find(stage => stage.id === id), reason, source: 'clock_and_progress', automatic: true, matchId: state.matchId ?? null };
}

function selectedBuild(provider, context) {
  const rows = Array.isArray(provider.builds) ? provider.builds : [];
  const has = (row, key) => (Array.isArray(row.sequence) ? row.sequence : []).some(item => (typeof item === 'string' ? item : item?.key) === key);
  const carry = carryRuleFor({}, { heroId: provider.heroId }, context);
  return rows.find(row => row.id === context.buildId) || (context.plan === 'fight' ? rows.find(row => carry?.id === 42 ? has(row, 'armlet') && has(row, 'desolator') && !has(row, 'radiance') : row.plan === 'fight' || carry?.fightItems.some(key => has(row, key))) : null) || (context.plan === 'farm' ? rows.find(row => carry?.farmItems.some(key => has(row, key))) : null) || rows[0] || null;
}

function skillsFor(state, dataset, context = {}) {
  state = object(state); dataset = object(dataset); context = object(context);
  const provider = object(context.proBuild ?? dataset.proTracker), build = selectedBuild(provider, context);
  const carry = carryRuleFor(state, dataset, context);
  const unavailable = (status, reason, order = []) => ({ order, next: null, status, reason, confidence: 0, source: provider.source || null, sourceUrl: provider.sourceUrl || null, sourceMatchId: null });
  if (!carry || provider.heroId !== carry.id || provider.heroId !== dataset.heroId || provider.role !== 'carry' || ['manual_only', 'unavailable', 'error'].includes(provider.status)) return unavailable('unavailable', `В выбранном источнике нет доступной carry-прокачки ${carry?.name || 'этого героя'}.`);
  const raw = Array.isArray(build?.skills) ? build.skills : Array.isArray(provider.skills) ? provider.skills : [];
  const catalog = { ...object(dataset.abilities), ...object(provider.currentAbilityCatalog), ...object(provider.abilities) };
  const order = raw.filter(row => integer(row?.heroLevel) !== null && row.heroLevel >= 1 && row.heroLevel <= 30 && typeof row.abilityKey === 'string').map(row => ({
    heroLevel: row.heroLevel, abilityKey: row.abilityKey, abilityId: integer(row.abilityId),
    label: row.label || catalog[row.abilityKey]?.dname || row.abilityKey,
    hotkey: row.hotkey || catalog[row.abilityKey]?.hotkey || ABILITY_HOTKEYS[row.abilityKey] || null,
    upgradeIndex: integer(row.upgradeIndex), levelVerified: row.levelVerified === true,
  })).sort((a, b) => a.heroLevel - b.heroLevel);
  if (!order.length) return unavailable('unavailable', 'В выбранном источнике нет последовательности прокачки; она не восстановлена по памяти.');
  if (new Set(order.map(row => row.heroLevel)).size !== order.length) return unavailable('invalid', 'В источнике повторяются уровни героя; прокачка требует повторной загрузки.');
  const sourceMatchId = build?.skillSourceMatchId ?? build?.sourceMatchId ?? provider.skillSourceMatchId ?? null;
  const levelsVerified = build?.skillLevelsVerified === true || order.every(row => row.levelVerified);
  const orderKind = build?.skillOrderKind || null, personal = orderKind === 'personal_authored_level_plan', exported = orderKind === 'authorized_export_level_plan', authored = orderKind === 'authored_heuristic_level_plan';
  const levelCaveat = personal ? 'Уровни заданы тобой в личном плане; эмпирической выборки матчей здесь нет.' : authored ? 'Авторский резервный порядок; уровни проверены по каталогу способностей, статистики матчей здесь нет.' : exported ? 'Уровни указаны в разрешённом экспорте; их наличие не означает независимую проверку записей матчей.' : levelsVerified ? 'Уровни взяты из записи матча.' : 'Порядок взят из матча; указанные уровни — минимальные допустимые, реальные уровни прокачки источник не подтвердил.';
  const info = { order, next: null, source: build?.skillSource || provider.source || null, sourceUrl: build?.skillSourceUrl || provider.sourceUrl || null, sourceMatchId, levelsVerified, levelCaveat, orderKind, confidence: authored ? .4 : .65, status: 'plan', reason: `${personal ? 'Личный план прокачки.' : authored ? 'Авторский резервный план прокачки.' : exported ? 'Прокачка из разрешённого экспорта.' : 'Прокачка из наблюдаемого carry-матча.'} ${levelCaveat}` };
  const skillContainer = Array.isArray(build?.skills) ? build : provider;
  const unknownAbilityIds = ['skillUnknownAbilityIds', 'unknownSkillAbilityIds', 'unknownAbilityIds'].flatMap(key => Array.isArray(skillContainer[key]) ? skillContainer[key] : []);
  if (skillContainer.skillOrderComplete === false || unknownAbilityIds.length || order.length !== raw.length) return { ...info, status: 'incomplete', skillOrderComplete: false, unknownAbilityIds, confidence: 0, reason: 'В источнике есть нераспознанные или пропущенные прокачки. Показана известная часть порядка; следующий навык не предлагается по неполной последовательности.' };
  const live = abilities(state), byKey = new Map(live.map(ability => [ability.name, ability]));
  const coreKeys = [...new Set(order.map(row => row.abilityKey))].filter(key => !key.startsWith('special_bonus'));
  const knownInnates = new Set(Object.entries(catalog).filter(([, detail]) => detail?.isInnate === true || detail?.is_innate === true || detail?.innate === true).map(([key]) => key));
  if (order.some(row => !catalog[row.abilityKey])) return { ...info, status: 'incompatible', confidence: 0, reason: 'В порядке прокачки есть навык, отсутствующий в проверенном каталоге героя; следующий навык не предлагается.' };
  if (order.some(row => catalog[row.abilityKey]?.granted === true || catalog[row.abilityKey]?.learnable === false && !row.abilityKey.startsWith('special_bonus'))) return { ...info, status: 'incompatible', confidence: 0, reason: 'Последовательность включает способность, которая выдаётся предметом или не прокачивается; следующий навык не предлагается.' };
  if (coreKeys.some(key => knownInnates.has(key) || /damage_tracker/.test(key))) return { ...info, status: 'incompatible', confidence: 0, reason: 'Последовательность включает врождённую или служебную способность: рекомендация прокачки отключена.' };
  if (!live.length || state.dataQuality?.abilities === false) return { ...info, status: 'waiting', confidence: 0, reason: 'План загружен. Для следующего навыка нужны текущие способности и их уровни из GSI.' };
  if (coreKeys.some(key => !byKey.has(key))) return { ...info, status: 'incompatible', confidence: 0, reason: 'Набор навыков источника отличается от текущего GSI — возможна другая грань или версия. Следующий навык не предлагается.' };
  if (order.some(row => integer(byKey.get(row.abilityKey)?.id) !== null && row.abilityId !== null && byKey.get(row.abilityKey).id !== row.abilityId)) return { ...info, status: 'incompatible', confidence: 0, reason: 'Идентификатор навыка в GSI отличается от источника; следующий навык не предлагается.' };
  const heroLevel = integer(state.level), points = integer(state.abilityPoints);
  if (heroLevel === null || coreKeys.some(key => integer(byKey.get(key)?.level) === null)) return { ...info, status: 'waiting', confidence: 0, pointsKnown: points !== null, reason: 'План загружен. Неизвестен уровень героя или уровни способностей: следующий навык не подтверждён.' };
  const desired = new Map(), candidates = [];
  for (const row of order) {
    const desiredRank = (desired.get(row.abilityKey) || 0) + 1; desired.set(row.abilityKey, desiredRank);
    const observed = byKey.get(row.abilityKey), currentRank = integer(observed?.level);
    // Talents require an actual observed rank as well; an absent talent is not
    // equivalent to an unlearned talent. Innates do not consume upgrade points.
    if (currentRank === null || observed.isInnate === true || currentRank >= desiredRank) continue;
    if (desiredRank !== currentRank + 1) continue;
    const isTalent = row.abilityKey.startsWith('special_bonus');
    const details = object(catalog[row.abilityKey]);
    const isUltimate = details.kind === 'ultimate' || details.isUltimate === true || carry.ultimate.includes(row.abilityKey);
    const requiredLevel = Array.isArray(details.minimumLevels) ? details.minimumLevels[desiredRank - 1] : isTalent ? row.heroLevel : isUltimate ? [6, 12, 18][desiredRank - 1] : desiredRank * 2 - 1;
    const maximumRank = integer(details.maxRank) ?? (isTalent ? 1 : isUltimate ? 3 : 4);
    if (requiredLevel === undefined || desiredRank > maximumRank) continue;
    if (isTalent && observed.canUpgrade !== true) {
      // A known candidate rank does not establish that its opposite talent has
      // not already been selected. No late-game unlock level is assumed here.
      const tier = integer(details.talentTier) ?? integer(details.minimumLevels?.[0]);
      const peers = tier === null ? [] : Object.entries(catalog).filter(([key, detail]) => key !== row.abilityKey && key.startsWith('special_bonus') && (integer(detail?.talentTier) ?? integer(detail?.minimumLevels?.[0])) === tier);
      if (peers.some(([key]) => integer(byKey.get(key)?.level) !== 0)) continue;
    }
    if ((points > 0 || points === null) && (row.heroLevel > heroLevel || requiredLevel > heroLevel || observed.canUpgrade === false)) continue;
    if (points === 0 && row.heroLevel <= heroLevel) continue;
    candidates.push({ ...row, currentRank, desiredRank, requiredLevel, ready: points > 0 && heroLevel >= requiredLevel, pointsKnown: points !== null, defaultHotkey: Boolean(row.hotkey) });
  }
  const next = candidates[0] || null;
  if (!next) return { ...info, status: 'no_suggestion', pointsKnown: points !== null, reason: 'Нет совместимого следующего навыка по текущим уровням. Таланты предлагаются только при наличии их уровней в GSI.' };
  if (points === null) return { ...info, next, status: 'conditional_plan', pointsKnown: false, reason: `Если в игре есть свободное очко, следующий совместимый шаг — ${next.label}: ${next.currentRank} → ${next.desiredRank}. Количество свободных очков GSI не подтвердил; проверь его в игре. ${levelCaveat}`, confidence: .6 };
  const ready = points > 0;
  return { ...info, next, pointsKnown: true, status: ready ? 'upgrade_available' : 'plan', reason: ready ? `Свободных очков: ${points}. ${next.label}: ${next.currentRank} → ${next.desiredRank}. Выбран первый недостающий доступный ранг; сохранённые очки учтены. ${levelCaveat}` : `План: ${next.label}, не раньше уровня ${next.heroLevel}. Сейчас свободных очков нет. ${levelCaveat}`, confidence: .75 };
}

function skillUseFor(state, dataset, context, lane) {
  const stun = ownAbility(state, 'hellfire_blast');
  const enemyIds = (lane?.opponents || []).map(hero => hero.id), ally = lane?.ally;
  const label = dataset.abilities?.[stun?.name]?.dname || 'Wraithfire Blast';
  if (!stun || number(stun.level) === null) return { title: 'Применение навыков', reason: 'GSI пока не подтвердил текущий набор способностей; конкретный каст не предлагается.' };
  if (stun.level === 0) return { title: `${label} ещё не изучен`, reason: 'Не рассчитывай на свой стан при размене. Сначала проверь прокачку и контроль союзника.' };
  if (number(stun.cooldown) !== null && stun.cooldown > 0) return { title: `Стан через ${Math.ceil(stun.cooldown)} с`, reason: 'Пока Wraithfire Blast перезаряжается, не начинай размен с расчётом на собственный контроль.' };
  if (number(stun.manaCost) !== null && number(state.mana) !== null && state.mana < stun.manaCost || stun.canCast === false) return { title: 'Стан сейчас недоступен', reason: 'GSI показывает нехватку маны или запрет каста. Не заходи для размена с расчётом на Wraithfire Blast.' };
  const caution = number(stun.cooldown) !== 0 || stun.canCast !== true ? 'Доступность каста не подтверждена; сначала проверь её. ' : '';
  let use;
  if (enemyIds.includes(2) && enemyIds.includes(101)) use = 'Сохрани Wraithfire Blast для остановки опасного подхода Axe или ответа по Skywrath после потраченного Call. Внутри Call или Ancient Seal ответный каст может быть недоступен.';
  else if (enemyIds.includes(26)) use = 'Если Lion начал Mana Drain по тебе и стан доступен, прерви канал Wraithfire Blast или выйди из его дальности. Под Hex/Earth Spike сначала пережди контроль.';
  else if (enemyIds.includes(27)) use = 'Если Shadow Shaman держит союзника Shackles и ты можешь безопасно подойти, прерви канал Wraithfire Blast. Когда Shackles держит тебя, собственный стан не является спасением.';
  else if (enemyIds.includes(137)) use = 'Сохрани Wraithfire Blast для опасного сближения Primal Beast. При Trample разрывай контакт; после стана не возвращайся к длинному размену.';
  else if (enemyIds.includes(100)) use = 'После приземления Snowball Tusk оцени выход; Wraithfire Blast используй по доступной цели, когда он больше не скрыт внутри Snowball. Не заходи следом в узкий проход.';
  else if (enemyIds.includes(85)) use = 'Не расходуй Wraithfire Blast ради длинного размена под Tombstone Undying. Сначала с союзником реши: убрать Tombstone атаками или отойти.';
  else if (ally?.setup) use = `Если ${ally.name} рядом и ${ally.setup} доступен, продолжи его контроль Wraithfire Blast; не накладывайте оба стана одновременно без причины. После короткого размена вернись к добиваниям.`;
  else if (enemyIds.length) use = `Wraithfire Blast используй для короткого размена с саппортом или безопасного отхода; сначала проверь, что ${lane.opponents.map(hero => hero.name).join(' + ')} потратили опасный контроль. Их текущие перезарядки неизвестны.`;
  else use = 'Не трать Wraithfire Blast ради одного удара: без распознанной линии неизвестно, нужен ли стан для отхода. Согласуй короткий размен с саппортом.';
  const title = enemyIds.includes(2) && enemyIds.includes(101) ? 'Сохрани стан для опасного подхода Axe' : enemyIds.includes(26) ? 'Если стан доступен, прерви Mana Drain' : enemyIds.includes(27) ? 'Если безопасно, прерви Shackles на союзнике' : enemyIds.includes(137) ? 'Сохрани стан для сближения Primal Beast' : enemyIds.includes(100) ? 'Стан — после приземления Snowball' : enemyIds.includes(85) ? 'Не трать стан на размен под Tombstone' : ally?.setup ? `Согласуй ${ally.setup} и свой стан` : enemyIds.length ? 'Сохрани стан для короткого ответа или отхода' : 'Сначала определи линию, сохрани стан';
  const skeletons = ownAbility(state, 'bone_guard'), strike = ownAbility(state, 'mortal_strike');
  let secondary = '';
  if (skeletons?.level > 0) {
    secondary += enemyIds.includes(2) ? ' Bone Guard: не выпускай скелетов ради длинной драки вплотную к Axe; его Counter Helix наказывает контакт.' : enemyIds.includes(104) ? ' Bone Guard: не собирай героя, саппорта и скелетов в одну точку под Overwhelming Odds Legion Commander.' : ' Bone Guard: перед призывом проверь заряды и равновесие линии; используй скелетов для доступного фарма, когда намеренно готов вытолкнуть волну.';
  }
  if (strike?.level > 0 && strike.cooldown === 0) secondary += ' Mortal Strike: таймер равен нулю по GSI — при безопасном подходе используй усиленный удар для добивания или короткого размена, затем отходи.';
  return { title, reason: caution + use + secondary };
}

function laneExtraTitle(state, lane) {
  const ids = (lane?.opponents || []).map(hero => hero.id);
  if (number(state.healthPercent) !== null && state.healthPercent < 55) return 'Сначала восстанови здоровье';
  if (ids.includes(2)) return 'Разделяйся с саппортом перед Call';
  if (ids.includes(85)) return 'При Tombstone: вместе убрать или отойти';
  if (ids.includes(137)) return 'Смещайся в сторону от Onslaught';
  if (ids.includes(129)) return 'Не стой между Mars и деревом';
  if (ids.includes(26)) return 'Не стой с саппортом на одной линии Spike';
  if (ids.includes(27)) return 'Не заходи под Hex без прикрытия';
  if (ids.includes(104)) return 'Разделяйтесь против Overwhelming Odds';
  if (ids.includes(108)) return 'Вытягивай крипов из Firestorm агром';
  if (ids.includes(98)) return 'Не бей Timber ради длинного размена';
  if (ids.includes(99)) return 'Не затягивай размен под Quill Spray';
  if (ids.includes(49)) return 'После Breathe Fire добивай агром';
  if (ids.includes(64)) return 'Разделяйтесь против Ice Path';
  if (ids.includes(31)) return 'Не продолжай размен в Frost Shield';
  if (ids.includes(47)) return 'Агри крипов к своей стороне, не копи яд';
  return ids.length ? 'Держи волну ближе к своей стороне' : 'Проверь соперников и саппорта линии';
}

function stageAdviceFor(state, dataset, context, stage, lane, postLane, economy) {
  state = object(state); dataset = object(dataset); context = object(context);
  const carry = carryRuleFor(state, dataset, context);
  if (carry && carry.id !== 42) return carryStageAdviceFor(state, dataset, context, stage, lane, postLane, economy, carry);
  const skillUse = skillUseFor(state, dataset, context, lane), owned = keys(state), reincarnation = ownAbility(state, 'reincarnation');
  const ultText = reincarnation?.level > 0 && reincarnation.cooldown === 0 ? 'Таймер Reincarnation равен нулю по GSI; ресурсы и возможность срабатывания проверь перед входом.' : reincarnation?.level > 0 && reincarnation.cooldown > 0 ? `Reincarnation на перезарядке ${Math.ceil(reincarnation.cooldown)} с: избегай рискованного первого входа.` : 'Готовность Reincarnation не подтверждена; сначала проверь её.';
  let mainTitle, mainReason, extraTitle, extraReason;
  if (stage.id === 'pregame') {
    mainTitle = 'Подготовь план линии'; mainReason = 'Выбери carry-сборку и проверь стартовые покупки. Соперники и саппорт линии определяются по повторным видимым наблюдениям после начала матча.';
    extraTitle = 'Подтверди роль'; extraReason = 'Этот план рассчитан на Wraith King carry. Пять портретов показывают состав, но не расположение героев на линии.';
  } else if (stage.id === 'laning') {
    mainTitle = lane?.title || 'Определяю линию'; mainReason = lane?.reason || 'Нужны повторные видимые наблюдения соперников и своего саппорта.';
    extraTitle = laneExtraTitle(state, lane);
    extraReason = lane?.tips?.[0] || 'Пока состав линии неизвестен, держи волну агром ближе к своей стороне и проверяй карту перед подходом к крипам.';
    if (lane?.ally?.setup && !skillUse.reason.includes(lane.ally.name)) extraReason += ` ${lane.ally.name}: сначала проверь, рядом ли он и доступен ли ${lane.ally.setup}.`;
  } else if (stage.id === 'transition') {
    mainTitle = postLane?.title || 'Составь маршрут после линии'; mainReason = postLane ? `${postLane.reason} ${postLane.priorities?.[0] || ''}` : 'Стадия после линии выбрана вручную. Если линия была тяжёлой, начни с безопасной волны и доступных лагерей; исход линии укажи отдельно.';
    extraTitle = context.plan === 'farm' || owned.has('relic') ? 'Сохраняй темп до фармящего предмета' : context.plan === 'fight' || owned.has('desolator') ? 'Выходи с союзниками при готовых ресурсах' : 'Перед выходом проверь предмет и ресурсы'; extraReason = postLane?.priorities?.[1] || 'Законченный основной предмет и ресурсы дают повод проверить короткий выход с союзниками. Видимость на карте обязательна.';
    skillUse.title = reincarnation?.cooldown > 0 ? 'Без ульты избегай рискованного первого входа' : 'Перед выходом проверь Reincarnation'; skillUse.reason = ultText + ' Wraithfire Blast сохраняй для совместного контроля или отхода; не трать его перед намеченным выходом.';
  } else if (stage.id === 'midgame') {
    const fight = context.plan === 'fight' || owned.has('desolator'), farming = context.plan === 'farm' || owned.has('relic');
    mainTitle = economy?.pace === 'behind' ? 'Восстанови темп перед новым выходом' : fight ? 'Играй от законченного предмета' : 'Фарм между короткими выходами';
    mainReason = economy?.pace === 'behind' ? 'По личной цели LH темп ниже ориентира. Забирай безопасные волны и доступные лагеря; это не доказывает проигрыш линии.' : fight ? 'С боевым предметом проверь короткий выход рядом с командой. После выигранного боя выбирайте доступный объект по живым врагам и обзору.' : farming ? 'Заверши выбранный фармящий предмет; подключайся к выгодному бою рядом с союзниками, сохраняя темп волн.' : 'Чередуй безопасные волны с доступными лагерями. Перед переходом в новую зону проверь видимых врагов и поддержку.';
    skillUse.title = reincarnation?.cooldown > 0 ? 'Без ульты избегай рискованного первого входа' : 'До драки проверь ульту и контроль команды'; skillUse.reason = ultText + ' Wraithfire Blast продолжает контроль команды по доступной цели; готовность чужих способностей неизвестна.';
    extraTitle = 'После выигранного боя оцените объект'; extraReason = 'Если ключевые враги действительно мертвы и команда рядом, оцените башню или Roshan. Приложение не подтверждает состояние Roshan и безопасность пути.';
  } else {
    mainTitle = 'Сохрани ресурсы для решающего боя'; mainReason = 'Перед выходом проверь Reincarnation, TP и поддержку команды. Удалённый фарм выбирай только по видимой карте и возможности вернуться к защите.';
    skillUse.title = 'Проверь ульту до первого входа'; skillUse.reason = ultText + ' Перед первым входом выбери цель с командой; после возрождения повторно оцени позицию и доступный стан.';
    extraTitle = 'Проверь выкуп до крупной покупки';
    const cost = number(state.buybackCost), cooldown = number(state.buybackCooldown), gold = number(state.gold);
    extraReason = cost !== null && gold !== null ? `По GSI стоимость выкупа ${Math.ceil(cost)}, у тебя ${Math.floor(gold)}: ${gold >= cost ? 'денег хватает' : `нужно ещё ${Math.ceil(cost - gold)}`}.${cooldown !== null ? cooldown > 0 ? ` Выкуп на перезарядке ${Math.ceil(cooldown)} с.` : ' Таймер выкупа равен нулю.' : ' Перезарядка выкупа неизвестна.'} Перед крупной покупкой оцени необходимость сохранить эту сумму; решение требует карты.` : 'GSI не передал стоимость выкупа или золото. Проверь выкуп в игре перед крупной покупкой; приложение не вычисляет цену по предположению.';
    if (cooldown !== null && cooldown > 0) extraTitle = `Выкуп на перезарядке: ${Math.ceil(cooldown)} с`;
    else if (cost !== null && gold !== null) extraTitle = gold >= cost ? `Проверь, нужно ли сохранить ${Math.ceil(cost)} на выкуп` : `Оцени запас: ещё ${Math.ceil(cost - gold)} до выкупа`;
  }
  return { mainTitle, mainReason, skillUseTitle: skillUse.title, skillUseReason: skillUse.reason, extraTitle, extraReason, confidence: stage.id === 'laning' ? lane?.confidence || 0 : .6 };
}

function carryStageAdviceFor(state, dataset, context, stage, lane, postLane, economy, carry) {
  const owned = keys(state), skillUse = stage.id === 'pregame' || stage.id === 'laning' ? ownSkillAdvice(state, dataset, context, lane) : ultimateAdvice(state, carry);
  let mainTitle, mainReason, extraTitle, extraReason;
  if (stage.id === 'pregame') {
    mainTitle = `Подготовь ${carry.name} к линии`;
    mainReason = 'Проверь стартовую закупку выбранной carry-сборки. Выбери своего саппорта и двух соперников из известных команд; это уточнит план разменов.';
    extraTitle = 'Определи цель первых минут';
    extraReason = carry.laneTip;
  } else if (stage.id === 'laning') {
    mainTitle = lane?.title || 'Выбери состав линии'; mainReason = lane?.reason || 'Нужен напарник и соперники твоей линии.';
    extraTitle = laneExtraTitle(state, lane); extraReason = lane?.tips?.[0] || carry.laneTip;
  } else if (stage.id === 'transition') {
    mainTitle = postLane?.title || 'Составь безопасный маршрут после линии';
    mainReason = postLane ? `${postLane.reason} ${postLane.priorities?.[0] || ''}` : 'Оцени безопасную волну и ближайшие доступные лагеря; история своей экономики помогает оценить темп, но не подтверждает экономику соперников.';
    extraTitle = 'Закончи выбранный предмет'; extraReason = `${postLane?.priorities?.[1] || 'Перед новым выходом проверь основной предмет, здоровье и поддержку команды.'} ${carry.farmTip}`;
  } else if (stage.id === 'midgame') {
    const fight = context.plan === 'fight' || carry.fightItems.some(key => owned.has(key));
    mainTitle = economy?.pace === 'behind' ? 'Восстанови темп перед выходом' : fight ? 'Проверь окно с командой' : 'Фарм между совместными выходами';
    mainReason = economy?.pace === 'behind' ? 'По твоей личной цели LH темп ниже ориентира. Сократи переходы и забирай доступные безопасные волны и лагеря; это не доказательство проигранной линии.' : fight ? 'С законченным предметом и ресурсами оцени короткую драку рядом с союзниками. После цели возвращайся к доступному фарму.' : `Чередуй безопасные волны и лагеря. ${carry.farmTip}`;
    extraTitle = 'После боя оцени доступный объект'; extraReason = 'Башня или Roshan требуют живой команды, видимых врагов и безопасного пути. Их текущее состояние приложение не подтверждает.';
  } else {
    mainTitle = 'Сохрани ресурсы для решающего боя'; mainReason = `Перед удалённым фармом проверь TP, поддержку и возможность вернуться к защите. ${carry.ultimateTip}`;
    extraTitle = 'Проверь выкуп до покупки';
    const cost = number(state.buybackCost), cooldown = number(state.buybackCooldown), gold = number(state.gold);
    extraReason = cost !== null && gold !== null ? `По GSI стоимость выкупа ${Math.ceil(cost)}, у тебя ${Math.floor(gold)}: ${gold >= cost ? 'денег хватает' : `нужно ещё ${Math.ceil(cost - gold)}`}.${cooldown !== null ? cooldown > 0 ? ` Выкуп на перезарядке ${Math.ceil(cooldown)} с.` : ' Таймер выкупа равен нулю.' : ' Перезарядка выкупа неизвестна.'} Решение о запасе золота требует оценки карты.` : 'GSI не передал стоимость выкупа или золото. Проверь выкуп в игре; цена не вычисляется по предположению.';
    if (cooldown > 0) extraTitle = `Выкуп на перезарядке: ${Math.ceil(cooldown)} с`;
  }
  return { mainTitle, mainReason, skillUseTitle: skillUse.title, skillUseReason: skillUse.reason, extraTitle, extraReason, confidence: stage.id === 'laning' ? lane?.confidence || 0 : .6, source: `authored_${carry.id}` };
}

module.exports = { STAGES, stageFor, skillsFor, stageAdviceFor };
