'use strict';

// These are reviewed lane heuristics, not predictions learned from match results.
// Only explicitly confirmed lane heroes participate. The five enemy portraits
// establish a draft, but cannot establish who is standing on the player's lane.
const SOURCE = 'Подтверждённые герои линии + правила WK; механики: dotaconstants / Valve';
const { carryRuleFor, carryLaneAdvice, abilityFor } = require('./carry-rules.cjs');
const HERO_RULES = Object.freeze({
  2: { name: 'Axe', risk: 3, hardTrade: true, reason: 'Axe наказывает длинный размен в крипах через Counter Helix и Berserker’s Call.', tip: 'Добивай с края волны; не заходи с союзником в один Call.', window: 'После потраченного Call можно коротко ударить более уязвимого саппорта.', retreat: 'Не защищай волну, стоя вплотную к Axe.' },
  // Valve herodata 22, checked 12.10.2026: Arc jumps through nearby units,
  // Bolt deals magical damage/ministun, Jump is a directional escape/slow.
  22: { name: 'Zeus', risk: 2, reason: 'Zeus постоянно давит магией: Arc Lightning переходит между близкими юнитами, Lightning Bolt наносит урон и даёт мини-стан. Heavenly Jump помогает разорвать дистанцию.', tip: 'Агри волну к безопасной стороне; не отдавай здоровье под повторные молнии ради одного крипа и не стой рядом с целью Arc Lightning.', window: 'Когда Heavenly Jump потрачен и Zeus отделился от напарника, возможен короткий вход с союзным контролем; готовность чужих умений проверь на экране.', retreat: 'Уходи на восстановление до опасного порога здоровья: Zeus может добить магией с дистанции.' },
  98: { name: 'Timbersaw', risk: 3, hardTrade: true, reason: 'Атаки наращивают Reactive Armor Timbersaw; длительное избиение усиливает его восстановление.', tip: 'Фарм важнее затяжного размена; не преследуй Timber между деревьями.', window: 'Ищи саппорта, пока Timber занят волной; не считай его лёгкой целью.', retreat: 'Не возвращайся один к Timber ради нескольких крипов.' },
  108: { name: 'Underlord', risk: 2, reason: 'Firestorm вытесняет из волны, а Atrophy Aura мешает физическим разменам.', tip: 'Вытягивай крипов из Firestorm агром; не добивай внутри всей зоны.', window: 'Короткий стан по саппорту после Firestorm безопаснее затяжной драки с Underlord.', retreat: 'Не держи потерянную башню внутри Firestorm.' },
  99: { name: 'Bristleback', risk: 2, hardTrade: true, reason: 'Накопленные Quill Spray делают длинную драку всё дороже, особенно если бить Bristleback в спину.', tip: 'Разрывай контакт до накопления Quill Spray; не гонись за спиной Bristleback.', window: 'Стан и короткий размен по саппорту; на Bristleback нужно согласованное добивание.', retreat: 'Не возвращайся в тот же размен с накопленными Quill Spray.' },
  28: { name: 'Slardar', risk: 2, reason: 'Slardar опасен подготовленным Bash of the Deep и длинным физическим разменом; Corrosive Haze снижает броню.', tip: 'Следи за подготовленным bash; отходи после короткого размена.', window: 'После потраченного Crush/bash ищи короткий стан вместе с саппортом.', retreat: 'Под Corrosive Haze не принимай затяжную драку один.' },
  96: { name: 'Centaur Warrunner', risk: 2, reason: 'Retaliate возвращает урон за атаки, а близкая позиция открывает Hoof Stomp.', tip: 'Не бей Centaur ради долгого размена; разделяйся с саппортом против Stomp.', window: 'После промаха Stomp короткая атака по саппорту выгоднее погони за Centaur.', retreat: 'При отходе не собирайтесь вдвоём под Hoof Stomp.' },
  29: { name: 'Tidehunter', risk: 2, reason: 'Anchor Smash снижает урон атак; Tidehunter неудобен для длинного физического размена.', tip: 'Добивай с агром крипов; не трать весь контроль на здорового Tidehunter.', window: 'После Anchor Smash ищи саппорта вне радиуса Tidehunter.', retreat: 'Не держись с командой в одной точке перед возможным Ravage.' },
  129: { name: 'Mars', risk: 2, reason: 'Spear of Mars ловит у деревьев и препятствий; God’s Rebuke даёт сильный короткий размен.', tip: 'Не стой на линии между Mars и деревом/стеной; не группируйся под Rebuke.', window: 'После промаха Spear короткий ответ со станом безопаснее погони.', retreat: 'Оставь путь отхода, не прижимайся к деревьям у Mars.' },
  69: { name: 'Doom', risk: 2, reason: 'Scorched Earth делает погоню невыгодной; Doom может сорвать восстановление и применение способностей.', tip: 'Не преследуй Doom внутри Scorched Earth; следи за ресурсами и его уровнем.', window: 'Короткий размен после Scorched Earth; стан сохрани для реальной цели.', retreat: 'Не рассчитывай, что покупка BKB решит угрозу Doom.' },
  104: { name: 'Legion Commander', risk: 2, reason: 'Overwhelming Odds наказывает скопление юнитов, а Moment of Courage поддерживает длинный размен.', tip: 'Не стой рядом с саппортом в большой волне; не отдавай бесплатный долгий размен.', window: 'Саппорт без позиции обычно лучше для стана, чем здоровая Legion в крипах.', retreat: 'Без союзной помощи не подставляйся под Duel.' },
  55: { name: 'Dark Seer', risk: 2, reason: 'Ion Shell наносит постоянный урон возле носителя; Surge позволяет выйти из обычной погони.', tip: 'Вытягивай нужного крипа агром; не стой рядом с носителями Ion Shell.', window: 'Ищи короткий стан после потраченного Surge; не преследуй ускоренную цель.', retreat: 'Не теряй здоровье на Ion Shell ради удержания волны.' },
  47: { name: 'Viper', risk: 3, hardTrade: true, reason: 'Poison Attack делает затяжной подход WK к Viper опасным; зона Nethertoxin мешает стоять на месте.', tip: 'Агри крипов к себе и разрывай контакт при накоплении яда.', window: 'Размен только с поддержкой и после потраченных ресурсов Viper; фарм приоритетнее погони.', retreat: 'Не возвращайся один в дальность Poison Attack.' },
  40: { name: 'Venomancer', risk: 2, reason: 'Яд и замедления Venomancer затрудняют отход WK после затяжного размена.', tip: 'Не трать здоровье на погоню; держи восстановление и путь отхода.', window: 'Короткий стан по вышедшему вперёд Venomancer, если саппорт рядом и может помочь.', retreat: 'При яде не начинай новый размен до восстановления.' },
  64: { name: 'Jakiro', risk: 2, reason: 'Dual Breath и Ice Path наказывают стоящих вместе героев и медленный отход.', tip: 'Разделяйся с саппортом, вытягивай крипов из зон Jakiro.', window: 'После промаха Ice Path можно коротко ответить станом.', retreat: 'Не защищай объект, стоя в продолжительном уроне Jakiro.' },
  85: { name: 'Undying', risk: 3, hardTrade: true, reason: 'Decay ослабляет силу в длинном размене, а Tombstone меняет выигрышность драки.', tip: 'Не стой с саппортом под один Decay; при Tombstone решай вместе: быстро убрать или выйти.', window: 'Короткое давление без Tombstone и накопленных Decay, а не затяжная драка.', retreat: 'Не защищай потерянную линию под активным Tombstone.' },
  68: { name: 'Ancient Apparition', risk: 1, reason: 'Cold Feet наказывает остановку; позже Ice Blast мешает лечению и восстановлению.', tip: 'При Cold Feet выйди от точки наложения; не стой ради ещё одного удара.', window: 'После потраченного Cold Feet у AA мало собственного спасения — возможен короткий стан с союзником.', retreat: 'Под Ice Blast не рассчитывай на lifesteal как способ пережить вход.' },
  87: { name: 'Disruptor', risk: 2, reason: 'Glimpse возвращает в прошлую позицию, Kinetic Field ограничивает отход.', tip: 'Не заходи глубоко без союзника; при отходе помни о возврате Glimpse.', window: 'После потраченного Glimpse короткий стан безопаснее долгой погони.', retreat: 'При отходе не делай рискованный TP на виду у Disruptor.' },
  101: { name: 'Skywrath Mage', risk: 2, reason: 'Concussive Shot замедляет отход, а Ancient Seal усиливает магический урон и запрещает касты.', tip: 'Держи восстановление; не отдавай здоровье под серию заклинаний ради одного добивания.', window: 'Skywrath уязвим для короткого совместного стана, если второй враг не может прикрыть.', retreat: 'Не оставайся один в дальности Skywrath с низким здоровьем.' },
  26: { name: 'Lion', risk: 2, reason: 'Hex и Earth Spike дают цепочку контроля; Mana Drain может лишить ресурсов для ответа.', tip: 'Не стой с саппортом на одной линии Earth Spike; выходи из Mana Drain или прерывай его.', window: 'После потраченного Hex/Spike короткая атака по Lion с союзником.', retreat: 'Сохрани дистанцию: цепочка контроля мешает безопасно уйти.' },
  27: { name: 'Shadow Shaman', risk: 2, reason: 'Hex и Shackles удерживают WK для урона второго героя.', tip: 'Не заходи один на саппорта; союзник должен иметь возможность прервать Shackles.', window: 'После потраченного Hex вместе прервите Shackles и ответьте коротким станом.', retreat: 'Без прикрытия не подходи в дальность Hex.' },
  30: { name: 'Witch Doctor', risk: 2, reason: 'Paralyzing Cask и Maledict делают поздний выход из размена опасным.', tip: 'Не стой вплотную к саппорту для отскоков Cask; после Maledict снижай входящий урон сразу.', window: 'После потраченного Cask короткий совместный стан; не затягивай размен под Maledict.', retreat: 'Не принимай повторный урон под Maledict ради ещё одного крипа.' },
  5: { name: 'Crystal Maiden', risk: 1, reason: 'Frostbite удерживает WK, Crystal Nova замедляет подход и отход.', tip: 'Не заходи без саппорта под контроль и урон второго врага.', window: 'После потраченного Frostbite возможен короткий совместный стан по CM.', retreat: 'Низкое здоровье и замедление CM — повод разорвать контакт.' },
  31: { name: 'Lich', risk: 2, reason: 'Frost Blast замедляет; Frost Shield ухудшает размен атаками по защищённой цели.', tip: 'Не продолжай размен в Frost Shield; разделяйся с саппортом перед Chain Frost.', window: 'Короткий стан после окончания Frost Shield, если союзник может помочь.', retreat: 'Не уходи вплотную к союзнику, если может лететь Chain Frost.' },
  100: { name: 'Tusk', risk: 2, reason: 'Ice Shards перекрывают путь, Snowball позволяет быстро сократить дистанцию.', tip: 'Оставляй боковой путь отхода; не стой далеко от саппорта в узком проходе.', window: 'После потраченного Snowball коротко ответь вместе с саппортом.', retreat: 'Не уходи через очевидный узкий проход под Ice Shards.' },
  75: { name: 'Silencer', risk: 1, reason: 'Arcane Curse и Last Word наказывают плохой размен ресурсами; Silence может помешать стану.', tip: 'Не трать стан ради одного удара; поддерживай запас здоровья против харасса.', window: 'Silencer без контроля второго врага уязвим для совместного короткого стана.', retreat: 'Не рассчитывай на доступность стана под silence.' },
  123: { name: 'Hoodwink', risk: 2, reason: 'Bushwhack ловит у деревьев, Acorn Shot усиливает размен возле юнитов.', tip: 'Не стой у дерева на очевидной линии Bushwhack; не группируйся с саппортом.', window: 'После промаха Bushwhack можно коротко ответить; не преследуй через деревья.', retreat: 'Не выбирай уход вдоль дерева на виду у Hoodwink.' },
  121: { name: 'Grimstroke', risk: 2, reason: 'Stroke of Fate и Ink Swell помогают второму врагу сблизиться; Phantom’s Embrace запрещает касты.', tip: 'Не стой на одной линии с крипами под Stroke; бей Phantom’s Embrace, если это безопасно.', window: 'После потраченного Ink Swell короткий ответ по отделившемуся саппорту.', retreat: 'Не пытайся просто терпеть Ink Swell в ближней драке.' },
  138: { name: 'Primal Beast', risk: 3, hardTrade: true, reason: 'Onslaught сокращает дистанцию, Trample наказывает стояние рядом и затяжную погоню.', tip: 'Смещайся в сторону от Onslaught; сохраняй стан для опасного сближения.', window: 'После потраченного Onslaught/Trample ищи короткий размен с поддержкой.', retreat: 'Разрывай контакт при Trample вместо ответной долгой драки.' },
  38: { name: 'Beastmaster', risk: 2, reason: 'Призываемые юниты и Wild Axes усиливают харасс; позже Primal Roar открывает убийство.', tip: 'Добивай с агром; не теряй всё здоровье от героя и призывов ради волны.', window: 'Короткий совместный стан по саппорту, если Beastmaster не может прикрыть.', retreat: 'Не возвращайся один на линию против угрозы Primal Roar.' },
});

const ALLY_RULES = Object.freeze({
  5: { name: 'Crystal Maiden', setup: 'Frostbite' },
  9: { name: 'Mirana', setup: 'Sacred Arrow', conditional: true },
  20: { name: 'Vengeful Spirit', setup: 'Magic Missile' },
  26: { name: 'Lion', setup: 'Earth Spike / Hex' },
  27: { name: 'Shadow Shaman', setup: 'Hex / Shackles' },
  30: { name: 'Witch Doctor', setup: 'Paralyzing Cask', conditional: true },
  64: { name: 'Jakiro', setup: 'Ice Path', conditional: true },
  84: { name: 'Ogre Magi', setup: 'Fireblast' },
  86: { name: 'Rubick', setup: 'Telekinesis' },
  100: { name: 'Tusk', setup: 'Snowball', conditional: true },
  111: { name: 'Oracle', setup: 'Fortune’s End', conditional: true },
  119: { name: 'Dark Willow', setup: 'Bramble Maze', conditional: true },
  121: { name: 'Grimstroke', setup: 'Ink Swell', conditional: true },
  123: { name: 'Hoodwink', setup: 'Bushwhack', conditional: true },
  128: { name: 'Snapfire', setup: 'Firesnap Cookie', conditional: true },
});

function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function finite(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function id(value) { const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : finite(value); return n !== null && Number.isInteger(n) && n > 0 ? n : null; }
function heroName(heroId, dataset) { const hero = object(object(dataset.heroes)[heroId]); return hero.localizedName || hero.localized_name || HERO_RULES[heroId]?.name || ALLY_RULES[heroId]?.name || `Герой ${heroId}`; }
function confirmedLaneIds(context) { return [...new Set((Array.isArray(context.laneEnemyHeroIds) ? context.laneEnemyHeroIds : []).map(id).filter(value => value !== null))].slice(0, 3); }
function farmStatus(value) { const assessment = typeof value === 'string' ? value : object(value).status; return ['ahead', 'behind', 'on_track'].includes(assessment) ? assessment : null; }

function laneAdvice(state, dataset, context = {}) {
  state = object(state); dataset = object(dataset); context = object(context);
  const carry = carryRuleFor(state, dataset, context);
  if (carry && carry.id !== 42) return carryLaneAdvice(state, dataset, context, HERO_RULES, ALLY_RULES);
  const opponents = confirmedLaneIds(context).map(heroId => ({ id: heroId, name: heroName(heroId, dataset) }));
  if (!opponents.length) return { style: 'balanced', title: 'Наблюдаю состав линии', reason: 'Состав из пяти портретов не показывает, кто стоит против тебя. Жду повторных уверенных наблюдений соперников и напарника на миникарте.', tips: [], opponents, source: 'Противники линии неизвестны', confidence: 0, ally: null };
  const rules = opponents.map(hero => ({ ...HERO_RULES[hero.id], ...hero })).filter(hero => HERO_RULES[hero.id]);
  const allyId = id(context.laneAllyHeroId), allyRule = ALLY_RULES[allyId];
  const ally = allyId ? { id: allyId, name: heroName(allyId, dataset), setup: allyRule?.setup || null } : null;
  const risk = rules.reduce((sum, rule) => sum + rule.risk, 0);
  const stun = (Array.isArray(state.abilities) ? state.abilities : []).find(ability => ['skeleton_king_hellfire_blast', 'wraith_king_hellfire_blast'].includes(ability.name));
  const resourcesReady = finite(state.healthPercent) !== null && state.healthPercent >= 70 && finite(state.manaPercent) !== null && state.manaPercent >= 35 && stun?.level > 0 && stun.cooldown === 0 && stun.canCast === true;
  const hardTrade = rules.some(rule => rule.hardTrade);
  let style = risk >= 4 || hardTrade || finite(state.healthPercent) !== null && state.healthPercent < 55 ? 'defensive' : 'balanced';
  // A supportive draft hero alone does not prove presence or spell readiness.
  // "Aggressive" is an opportunity to check, never an automatic all-in call.
  if (style === 'balanced' && resourcesReady && allyRule && !allyRule.conditional && rules.length === opponents.length) style = 'aggressive';
  const names = opponents.map(hero => hero.name).join(' + ');
  const reason = rules.length ? rules.slice().sort((a, b) => b.risk - a.risk).map(rule => rule.reason).join(' ') : `Для ${names} нет проверенного правила линии; сохраняй сбалансированный фарм и оценивай их конкретные способности.`;
  let tips = rules.slice().sort((a, b) => b.risk - a.risk).map(rule => rule.tip).slice(0, 2);
  if (style === 'aggressive') {
    tips = [`Если ${ally.name} рядом и ${allyRule.setup} готов, согласуйте его контроль и Wraithfire Blast по одной цели; после короткого размена вернись к крипам.`, rules[0]?.tip || 'Не продолжай погоню через большую вражескую волну.'];
  } else if (tips.length < 2) {
    tips.push(allyRule ? `Окно для ответа: ${rules[0]?.window || 'короткий совместный стан' } Проверь присутствие ${ally.name} и готовность ${allyRule.setup}.` : 'Держи волну ближе к своей стороне агром; попроси саппорта помочь с равновесием линии.');
  }
  return { style, title: style === 'defensive' ? `Против ${names}: береги здоровье` : style === 'aggressive' ? `Против ${names}: ищи короткое окно` : `Против ${names}: фарм и короткие размены`, reason, tips: tips.slice(0, 2), opponents, ally, source: SOURCE, confidence: rules.length / opponents.length * .8 };
}

function postLaneAdvice(state, dataset, context = {}) {
  state = object(state); dataset = object(dataset); context = object(context);
  const carry = carryRuleFor(state, dataset, context);
  const time = finite(state.gameTime);
  if (time === null || time < 600) return null;
  const manual = ['won', 'lost', 'even'].includes(context.laneResult) ? context.laneResult : null;
  const assessment = object(context.laneOutcomeAssessment);
  const sameOutcomeMatch = assessment.matchId == null || state.matchId == null || String(assessment.matchId) === String(state.matchId);
  const automatic = sameOutcomeMatch && assessment.source === 'auto_metrics' && assessment.supported === true && assessment.complete === true && assessment.provisional === false && ['won', 'lost', 'even'].includes(assessment.result) ? assessment : null;
  const snapshot = object(context.laneSnapshot), snapshotTime = finite(snapshot.gameTime);
  // The first ten-minute snapshot is relevant to lane assessment. Current
  // minute-25 economy must never silently rewrite what happened on the lane.
  const snapshotUsable = snapshotTime !== null && snapshotTime >= 480 && snapshotTime <= 780;
  const earlyCurrent = time <= 720;
  const pace = farmStatus(snapshotUsable ? snapshot.farmAssessment : earlyCurrent ? context.farmAssessment : null);
  const deaths = finite(snapshotUsable ? snapshot.deaths : earlyCurrent ? state.deaths : null);
  let result = manual || automatic?.result || 'unknown', confidence = manual ? 1 : automatic ? Math.min(.75, Math.max(0, finite(automatic.confidence) || 0)) : 0;
  // Older callers may still provide an explicit checkpoint; the app's auto
  // mode only accepts the timestamped multi-signal track above.
  if (!manual && !automatic && context.laneResult !== 'auto' && !assessment.source) {
    if (pace === 'behind' && deaths !== null && deaths >= 2) { result = 'lost'; confidence = .55; }
    else if (pace === 'ahead' && deaths === 0) { result = 'won'; confidence = .5; }
    else if (pace === 'on_track' && deaths !== null && deaths <= 1) { result = 'even'; confidence = .45; }
  }
  const inference = manual ? 'Исход линии указан тобой.' : automatic ? `По доступным признакам твоего темпа: ${automatic.label || 'автоматическая оценка'}. ${automatic.reason || 'Экономика соперников неизвестна.'}` : result !== 'unknown' ? 'Оценка темпа по фарму и смертям на 10-й минуте; это не доказательство выигранной или проигранной линии.' : assessment.source === 'auto_metrics' || context.laneResult === 'auto' ? `Автоматической оценке пока не хватает истории. ${assessment.reason || 'Наблюдаю фарм, развитие и потери; дефицит крипов сам по себе не доказывает проигрыш.'}` : 'Исход линии не подтверждён; дефицит крипов сам по себе не доказывает проигрыш.';
  const owned = new Set((Array.isArray(state.inventory) ? state.inventory : []).map(item => String(item.name || '').replace(/^item_/, '')));
  const farmRoute = context.plan === 'farm' || (carry?.farmItems || []).some(key => owned.has(key)) || carry?.id === 42 && (owned.has('relic') || context.buildRoute === 'radiance');
  const fightRoute = context.plan === 'fight' || (carry?.fightItems || []).some(key => owned.has(key)) || carry?.id === 42 && context.buildRoute === 'armlet_desolator';
  const ultimate = abilityFor(state, carry?.ultimate), ultReady = ultimate?.level > 0 && ultimate.cooldown === 0;
  const farmKey = carry?.farmItems?.[0], farmLabel = dataset.items?.[farmKey]?.dname || farmKey || 'фармящий предмет';
  const opponents = confirmedLaneIds(context), threatRule = opponents.map(heroId => HERO_RULES[heroId]).filter(Boolean).sort((a, b) => b.risk - a.risk)[0];
  const specific = threatRule ? ` ${threatRule.name}: ${threatRule.retreat}` : '';
  let title, reason, priorities;
  if (result === 'lost' || result === 'unknown' && pace === 'behind') {
    title = result === 'lost' ? 'После трудной линии: восстанови темп' : 'Темп ниже ориентира: сократи потери';
    reason = `${inference} Не возвращайся на опасную линию ради каждого крипа.${specific}`;
    priorities = ['Забирай безопасную волну у своей T2 и доступные ближайшие лагеря; маршрут выбирай по видимым врагам, вардам и здоровью.', farmRoute ? 'Доведи фармящий предмет; избегай долгих переходов на драки без явного преимущества. TP держи для безопасного ответа рядом с командой.' : 'Собери следующий доступный предмет; отвечай на драку рядом с союзниками, если есть ресурсы и путь отхода.'];
  } else if (result === 'won') {
    title = 'После успешной линии: закрепи преимущество';
    reason = `${inference} Преимущество — повод занять больше безопасного фарма, а не идти одному в неизвестность.${specific}`;
    priorities = ['Вытолкни безопасную волну, проверь видимых врагов и продолжи фарм; давление на башню только вместе с командой и обзором.', farmRoute && farmKey && !owned.has(farmKey) ? `Доведи ${farmLabel} по выбранной сборке; подключайся к короткому выгодному бою, сохраняя темп.` : fightRoute ? `${carry?.ultimatePassive ? 'Проверь защиту и готовность способности для входа.' : ultReady ? `Таймер ${carry?.ultimateLabel || 'ультимейта'} готов.` : `Проверь готовность ${carry?.ultimateLabel || 'ультимейта'}.`} С боевым предметом ищи короткий выход с союзниками; после цели вернись к фарму.` : 'Доведи основной предмет; выбирай совместный выход по ресурсам и обзору, сохраняя безопасный фарм.'];
  } else {
    title = result === 'even' ? 'После ровной линии: сыграй от предмета' : 'После линии: выбери безопасный маршрут';
    reason = `${inference}${specific}`;
    priorities = ['Чередуй безопасные волны и доступные лагеря; перед новой зоной фарма проверь видимых врагов и поддержку союзников.', farmRoute && farmKey && !owned.has(farmKey) ? `Приоритет — закончить ${farmLabel} по выбранной сборке; не теряй несколько волн ради случайной драки.` : fightRoute ? 'С ранним боевым предметом и ресурсами ищи совместный короткий выход; одиночная погоня не заменяет фарм.' : 'Законченный предмет и готовые ресурсы дают окно для команды; без них продолжай безопасный фарм.'];
  }
  const ruleLabel = carry?.id === 42 ? 'WK' : carry?.name || 'керри';
  return { result, confidence, title, reason, priorities, source: manual ? `Твой выбор исхода линии + правила ${ruleLabel}` : automatic ? `Автоматическая оценка темпа по истории GSI + правила ${ruleLabel}` : `GSI / ориентир фарма + правила ${ruleLabel}`, assessmentSource: manual ? 'manual' : 'auto_metrics', estimated: !manual, phase: time <= 1080 ? 'transition' : 'midgame' };
}

module.exports = { laneAdvice, postLaneAdvice, HERO_RULES, ALLY_RULES };
