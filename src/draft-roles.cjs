'use strict';

const POSITION_PROFILES = Object.freeze([
  { id: 1, role: 'POSITION_1', name: 'Керри', label: 'Керри · позиция 1' },
  { id: 2, role: 'POSITION_2', name: 'Мид', label: 'Мид · позиция 2' },
  { id: 3, role: 'POSITION_3', name: 'Оффлейн', label: 'Оффлейн · позиция 3' },
  { id: 4, role: 'POSITION_4', name: 'Саппорт', label: 'Саппорт · позиция 4' },
  { id: 5, role: 'POSITION_5', name: 'Полная поддержка', label: 'Полная поддержка · позиция 5' },
].map(Object.freeze));

function normalizePosition(value, fallback = 1) {
  if (typeof value === 'string') {
    const name = value.trim().toLowerCase();
    const aliases = { carry: 1, mid: 2, offlane: 3, support: 4, hard_support: 5, hardsupport: 5 };
    if (aliases[name]) return aliases[name];
    const match = /^(?:position[_ -]?)?([1-5])$/.exec(name);
    if (match) return Number(match[1]);
  }
  return Number.isInteger(value) && value >= 1 && value <= 5 ? value : fallback;
}

function roleFitFor(hero, positionId = 1) {
  const position = normalizePosition(positionId);
  const metadata = hero && typeof hero === 'object' ? hero : {};
  const capabilities = metadata.capabilities && typeof metadata.capabilities === 'object' ? metadata.capabilities : {};
  const roles = [...new Set((Array.isArray(metadata.roles) ? metadata.roles : Array.isArray(capabilities.roles) ? capabilities.roles : [])
    .filter(value => typeof value === 'string'))];
  // Valve/OpenDota labels such as Carry and Initiator describe capabilities;
  // they do not establish observed positions or justify score adjustments.
  return { score: 0, known: roles.length > 0, suitable: null, positionId: position,
    label: 'Статистика выбранной позиции не подтверждена',
    reason: roles.length ? `Метки ${roles.join(', ')} описывают возможности героя, но не подтверждают его результаты на позиции ${position}.` : `Нет подтверждённых данных для позиции ${position}.` };
}

module.exports = { POSITION_PROFILES, normalizePosition, roleFitFor };
