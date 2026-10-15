'use strict';

// Authored, conditional coaching rules. These are neither professional build
// statistics nor observations of an opponent's resources or cooldowns.
const RULES = Object.freeze({
  42: { id: 42, name: 'Wraith King', names: ['npc_dota_hero_skeleton_king', 'npc_dota_hero_wraith_king'], primary: ['skeleton_king_hellfire_blast', 'wraith_king_hellfire_blast'], primaryLabel: 'Wraithfire Blast', ultimate: ['skeleton_king_reincarnation', 'wraith_king_reincarnation'], ultimateLabel: 'Reincarnation', progressItems: ['armlet', 'radiance', 'desolator'], farmItems: ['radiance'], damageItems: ['armlet', 'radiance', 'desolator'], fightItems: ['armlet', 'desolator'], fallback: ['power_treads', 'armlet', 'radiance', 'black_king_bar', 'blink', 'assault'], melee: true },
  8: { id: 8, name: 'Juggernaut', names: ['npc_dota_hero_juggernaut'], primary: ['juggernaut_blade_fury'], primaryLabel: 'Blade Fury', ultimate: ['juggernaut_omni_slash'], ultimateLabel: 'Omnislash', progressItems: ['bfury', 'maelstrom', 'diffusal_blade'], farmItems: ['bfury', 'maelstrom', 'mjollnir'], damageItems: ['bfury', 'maelstrom', 'mjollnir', 'diffusal_blade', 'manta'], fightItems: ['diffusal_blade'], fallback: ['phase_boots', 'bfury', 'manta', 'black_king_bar', 'butterfly', 'abyssal_blade'], melee: true,
    laneTip: 'С союзным контролем Blade Fury даёт короткое окно атаки; не преследуй цель через большую волну. Healing Ward держи вне досягаемости врагов и перемещай вместе с собой.',
    combo: 'Если союзный контроль готов и цель рядом, используй Blade Fury после начала контроля. Сначала проверь здоровье, ману и путь отхода.',
    ultimateTip: 'Перед Omnislash проверь видимые цели рядом: крипы и другие юниты могут забрать прыжки. Ультимейт не оправдывает вход в неизвестность.',
    farmTip: 'Healing Ward помогает восстановиться между безопасными волнами и лагерями; сначала проверь ману и защищённую позицию варда.' },
  18: { id: 18, name: 'Sven', names: ['npc_dota_hero_sven'], primary: ['sven_storm_bolt'], primaryLabel: 'Storm Hammer', ultimate: ['sven_gods_strength'], ultimateLabel: 'God’s Strength', progressItems: ['echo_sabre', 'harpoon', 'blink'], farmItems: ['mask_of_madness', 'echo_sabre'], damageItems: ['echo_sabre', 'harpoon', 'greater_crit', 'silver_edge'], fightItems: ['blink', 'harpoon'], fallback: ['power_treads', 'mask_of_madness', 'echo_sabre', 'blink', 'black_king_bar', 'greater_crit'], melee: true,
    laneTip: 'Storm Hammer сохрани для совместного короткого размена или отхода. Great Cleave может вытолкнуть волну: выбирай позицию добивания так, чтобы не отдавать равновесие линии.',
    combo: 'Если саппорт рядом и его контроль готов, продолжи его Storm Hammer, не накладывая станы одновременно без причины. Warcry проверь перед физическим разменом.',
    ultimateTip: 'God’s Strength усиливает атаки, но требует возможности добраться до цели. Перед включением проверь союзный контроль, защиту от заклинаний и путь отхода.',
    farmTip: 'Great Cleave ускоряет доступные лагеря и волны; не уходи за фармом в зону без обзора. Перед Mask of Madness учитывай запрет собственных кастов.' },
  44: { id: 44, name: 'Phantom Assassin', names: ['npc_dota_hero_phantom_assassin'], primary: ['phantom_assassin_stifling_dagger'], primaryLabel: 'Stifling Dagger', ultimate: ['phantom_assassin_coup_de_grace'], ultimateLabel: 'Coup de Grace', ultimatePassive: true, progressItems: ['bfury', 'desolator'], farmItems: ['bfury'], damageItems: ['bfury', 'desolator', 'manta', 'abyssal_blade'], fightItems: ['desolator'], fallback: ['power_treads', 'bfury', 'desolator', 'black_king_bar', 'abyssal_blade', 'satanic'], melee: true,
    laneTip: 'Stifling Dagger используй для опасного добивания с дистанции или короткого харасса, сохраняя ману. До Phantom Strike проверь, сможет ли саппорт помочь и есть ли безопасный выход.',
    combo: 'Если союзник контролирует цель, начни со Stifling Dagger и оцени безопасный Phantom Strike. Dagger замедляет, но не заменяет стан союзника.',
    ultimateTip: 'Coup de Grace — пассивный навык: собственного каста ультимейта нет. Для входа важнее готовность Phantom Strike, защита и доступная цель.',
    farmTip: 'До законченного фармящего предмета держись доступных безопасных волн; Stifling Dagger помогает не отдавать здоровье за опасное добивание.' },
  48: { id: 48, name: 'Luna', names: ['npc_dota_hero_luna'], primary: ['luna_lucent_beam'], primaryLabel: 'Lucent Beam', ultimate: ['luna_eclipse'], ultimateLabel: 'Eclipse', progressItems: ['manta', 'mask_of_madness', 'khanda'], farmItems: ['mask_of_madness', 'manta'], damageItems: ['manta', 'khanda', 'butterfly'], fightItems: ['khanda'], fallback: ['power_treads', 'mask_of_madness', 'manta', 'black_king_bar', 'butterfly', 'satanic'], melee: false,
    laneTip: 'Добивай с края дальности атаки и не заходи в радиус ближнего контроля. Lucent Beam подходит для опасного добивания или короткого ответа; расход маны сравнивай с ценностью размена.',
    combo: 'После контроля саппорта Lucent Beam позволяет коротко ответить по той же цели; не сближайся только ради одного каста.',
    ultimateTip: 'До Eclipse проверь близких врагов и крипов: лучи распределяются по допустимым целям. Не входи одна в контроль ради ультимейта.',
    farmTip: 'Отскоки атак могут быстро вытолкнуть волну; после доступной волны переходи в безопасный лагерь и проверяй карту перед новым маршрутом.' },
});

function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function number(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function identifyCarry(id, name) {
  const numericId = typeof id === 'string' && /^\d+$/.test(id) ? Number(id) : number(id);
  const suppliedName = typeof name === 'string' ? name : null;
  const rule = numericId !== null ? RULES[numericId] : Object.values(RULES).find(entry => entry.names.includes(suppliedName));
  return rule && (!suppliedName || rule.names.includes(suppliedName)) ? rule : null;
}
function carryRuleFor(state = {}, dataset = {}, context = {}) {
  const requested = context.heroId ?? context.activeHeroId ?? context.activeProfile?.id ?? dataset.heroId ?? state.heroId ?? 42;
  return RULES[Number(requested)] || null;
}
function abilityFor(state, names) { return (Array.isArray(state?.abilities) ? state.abilities : []).find(ability => (Array.isArray(names) ? names : []).includes(ability.name)); }
function spellAvailability(state, ability, label) {
  if (!ability || number(ability.level) === null) return { known: false, ready: false, title: 'Применение навыков', reason: `GSI не подтвердил уровень ${label}; конкретный каст не предлагается.` };
  if (ability.level <= 0) return { known: true, ready: false, title: `${label} ещё не изучен`, reason: 'Не рассчитывай на этот навык до прокачки.' };
  if (number(ability.cooldown) !== null && ability.cooldown > 0) return { known: true, ready: false, title: `${label} через ${Math.ceil(ability.cooldown)} с`, reason: 'Таймер по GSI; не начинай действие с расчётом на недоступную способность.' };
  if (ability.canCast === false || number(ability.manaCost) !== null && number(state.mana) !== null && state.mana < ability.manaCost) return { known: true, ready: false, title: `${label} сейчас недоступен`, reason: 'GSI показывает запрет каста или нехватку маны; сначала восстанови ресурсы.' };
  return { known: true, ready: ability.cooldown === 0 && ability.canCast === true, title: `Проверь ${label} перед разменом`, reason: ability.cooldown === 0 && ability.canCast === true ? 'Таймер и возможность каста подтверждены GSI; позицию и цель проверь в игре.' : 'Готовность каста не подтверждена; сначала проверь её в игре.' };
}
function ownSkillAdvice(state, dataset, context, lane) {
  const rule = carryRuleFor(state, dataset, context);
  if (!rule) return { title: 'Применение навыков', reason: 'Для выбранного героя нет проверенных правил.' };
  const ability = abilityFor(state, rule.primary), label = dataset.abilities?.[ability?.name]?.dname || rule.primaryLabel;
  const available = spellAvailability(state, ability, label);
  if (!available.known || !available.ready && (ability?.level === 0 || ability?.cooldown > 0 || ability?.canCast === false || number(ability?.manaCost) !== null && number(state.mana) !== null && state.mana < ability.manaCost)) return { title: available.title, reason: available.reason };
  const ally = lane?.ally;
  const coordination = ally?.setup ? `Если ${ally.name} рядом и ${ally.setup} доступен, согласуйте короткий размен. ` : '';
  return { title: available.title, reason: `${available.reason} ${coordination}${rule.combo || ''} Готовность вражеских способностей неизвестна.` };
}
function ultimateAdvice(state, rule) {
  if (rule.ultimatePassive) return { title: 'Выбирай вход по защите и позиции', reason: rule.ultimateTip };
  const ability = abilityFor(state, rule.ultimate), availability = spellAvailability(state, ability, rule.ultimateLabel);
  return { title: availability.ready ? `Перед выходом оцени ${rule.ultimateLabel}` : availability.title, reason: `${availability.reason} ${rule.ultimateTip || ''}` };
}
function positionalTip(opponents, melee) {
  const ids = opponents.map(hero => hero.id);
  if (ids.includes(2)) return 'Держись вне радиуса Berserker’s Call и разделяйся с саппортом; не продолжай длинный контакт с Axe в волне.';
  if (ids.includes(137)) return 'Смещайся в сторону от Onslaught; при Trample разрывай контакт и сохраняй свободный путь отхода.';
  if (ids.includes(85)) return 'При Tombstone вместе решите, можно ли безопасно убрать её атаками; иначе отойди, сохраняя здоровье.';
  if (ids.includes(104)) return 'Разделяйся с саппортом и не собирай много юнитов в одну точку под Overwhelming Odds.';
  if (ids.includes(129)) return 'Не стой между Mars и деревом или препятствием на очевидной линии Spear of Mars.';
  if (ids.includes(26)) return 'Не стой с саппортом на одной линии Earth Spike; выходи из Mana Drain, если союзник не может безопасно прервать канал.';
  if (ids.includes(27)) return 'Не заходи в дальность Hex и Shackles без прикрытия; если союзник пойман, помощь зависит от твоего фактического контроля.';
  if (ids.includes(30)) return 'Разделяйся с саппортом для Paralyzing Cask; под Maledict сразу сокращай повторный входящий урон.';
  if (ids.includes(47)) return 'Не копи Poison Attack ради затяжного размена: добивай агром или с безопасной дистанции и восстанавливай здоровье.';
  if (ids.includes(98)) return 'Не затягивай физический размен с Timbersaw; добивай крипов и оценивай урон второго врага.';
  return melee ? 'Подтягивай крипов агром к своей стороне; подходи коротко и оставляй путь отхода за своей волной.' : 'Добивай с края дальности атаки; при сближении врага отходи за свою волну и проверяй позицию саппорта.';
}
function carryLaneAdvice(state, dataset, context, enemyRules, allyRules) {
  const rule = carryRuleFor(state, dataset, context);
  const ids = [...new Set((Array.isArray(context.laneEnemyHeroIds) ? context.laneEnemyHeroIds : []).map(Number).filter(value => Number.isInteger(value) && value > 0))].slice(0, 2);
  const name = id => dataset.heroes?.[id]?.localizedName || dataset.heroes?.[id]?.localized_name || enemyRules[id]?.name || allyRules[id]?.name || `Герой ${id}`;
  const opponents = ids.map(id => ({ id, name: name(id) })), allyId = Number(context.laneAllyHeroId), allyRule = allyRules[allyId];
  const ally = Number.isInteger(allyId) && allyId > 0 ? { id: allyId, name: name(allyId), setup: allyRule?.setup || null } : null;
  if (!opponents.length) return { style: 'balanced', stance: 'unknown', title: 'Выбери соперников линии', reason: 'Полный драфт уже известен, но позиции на линии не подтверждены. Выбери напарника и двух соперников из команд или дождись наблюдений экрана.', tips: [rule?.laneTip || 'Сохраняй здоровье и проверяй карту.'], opponents, ally, confidence: 0, source: 'Противники линии неизвестны' };
  const known = ids.map(id => enemyRules[id]).filter(Boolean), covered = known.length === ids.length;
  const risk = known.reduce((sum, enemy) => sum + enemy.risk, 0);
  let style = risk >= 4 || known.some(enemy => enemy.hardTrade) || number(state.healthPercent) !== null && state.healthPercent < 55 ? 'defensive' : 'balanced';
  const primary = abilityFor(state, rule.primary), ownReady = spellAvailability(state, primary, rule.primaryLabel).ready;
  if (style === 'balanced' && covered && allyRule && !allyRule.conditional && ownReady && state.healthPercent >= 70 && state.manaPercent >= 35) style = 'aggressive';
  const matchupReason = known.map(enemy => String(enemy.reason).replace(/\bWK\b/g, rule.name).replace(/ответный стан/g, 'ответные способности')).join(' ');
  const safeResources = number(state.healthPercent) !== null && state.healthPercent < 55 ? `Здоровье ${Math.round(state.healthPercent)}% по GSI: сначала восстановись. ` : '';
  return { style, stance: covered ? style : 'unknown', title: `Против ${opponents.map(hero => hero.name).join(' + ')}: ${style === 'defensive' ? 'береги здоровье' : style === 'aggressive' ? 'проверь короткое окно' : 'фарм и короткие размены'}`, reason: `${matchupReason || 'Для этого сочетания нет проверенного правила угроз.'}${covered ? '' : ' Для части соперников правила отсутствуют; оценка агрессии неполная.'}`, tips: [`${safeResources}${positionalTip(opponents, rule.melee)}`, `${ally?.setup ? `${ally.name}: сначала проверь его позицию и готовность ${ally.setup}. ` : ''}${rule.laneTip}`], opponents, ally, confidence: known.length / ids.length * .8, source: `Выбранный состав линии + авторские правила ${rule.name}` };
}

module.exports = { RULES, identifyCarry, carryRuleFor, abilityFor, spellAvailability, ownSkillAdvice, ultimateAdvice, carryLaneAdvice };
