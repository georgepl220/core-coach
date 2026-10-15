'use strict';

const PICK = 'DOTA_GAMERULES_STATE_HERO_SELECTION';
const STRATEGY = 'DOTA_GAMERULES_STATE_STRATEGY_TIME';
const PLAYING = new Set(['DOTA_GAMERULES_STATE_PRE_GAME', 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS']);
const side = value => value === 'radiant' || value === 'dire';
const id = value => Number.isInteger(value) && value > 0 && value < 1000;
const unique = value => [...new Set((Array.isArray(value) ? value : []).filter(id))];
function fresh(state, now = Date.now()) {
  return Boolean(state && !state.isSpectator && Number.isFinite(state.receivedAt) && now - state.receivedAt >= -1000 && now - state.receivedAt < 15000);
}
function draftPhase(state, settings = {}, now = Date.now()) {
  if (fresh(state, now)) {
    if (state.gameState === PICK) return 'pick';
    if (state.gameState === STRATEGY) return 'strategy';
    if (PLAYING.has(state.gameState)) return 'inactive';
  }
  return settings.draftMode === 'preview' ? 'preview' : 'inactive';
}
// Public GSI draft fields are optional in the player perspective. Empty and
// unrecognised shapes stay empty; a lobby/spectator list is never inferred.
function normalizeDraft(value) {
  const output = { teams: { radiant: [], dire: [] }, bannedHeroIds: [], available: false };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return output;
  for (const [key, team] of [['team2', 'radiant'], ['team3', 'dire']]) {
    const row = value[key];
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    for (let index = 0; index < 5; index++) {
      const heroId = row[`pick${index}_id`];
      if (id(heroId)) output.teams[team].push(heroId);
    }
    for (let index = 0; index < 30; index++) {
      const heroId = row[`ban${index}_id`];
      if (id(heroId)) output.bannedHeroIds.push(heroId);
    }
  }
  const conflicts = output.teams.radiant.filter(heroId => output.teams.dire.includes(heroId));
  output.teams.radiant = unique(output.teams.radiant).filter(heroId => !conflicts.includes(heroId));
  output.teams.dire = unique(output.teams.dire).filter(heroId => !conflicts.includes(heroId));
  const picks = [...output.teams.radiant, ...output.teams.dire];
  output.bannedHeroIds = unique(output.bannedHeroIds).filter(heroId => !picks.includes(heroId));
  output.available = picks.length > 0 || output.bannedHeroIds.length > 0;
  return output;
}
function newPickTrack() { return { slots: {}, teams: { radiant: [], dire: [] }, gsiTeams: { radiant: [], dire: [] }, lastFrameAt: null }; }
function updatePickTrack(previous, { state, vision, now = Date.now() } = {}) {
  let track = previous || newPickTrack();
  if (!fresh(state, now) || ![PICK, STRATEGY].includes(state.gameState)) return track;
  if(state.draft?.available){
    const gsiTeams={radiant:unique(state.draft.teams?.radiant).slice(0,5),dire:unique(state.draft.teams?.dire).slice(0,5)};
    track={...track,gsiTeams,teams:Object.fromEntries(['radiant','dire'].map(team=>[team,gsiTeams[team].length?gsiTeams[team]:track.teams[team]]))};
  }
  const stamp = vision?.capturedAt ?? vision?.timestamp;
  if (!Number.isFinite(stamp) || now - stamp < -1000 || now - stamp > 8000 || track.lastFrameAt !== null && stamp <= track.lastFrameAt || vision?.diagnostics?.rosterRefreshed === false) return track;
  const slots = Array.isArray(vision?.roster) ? vision.roster : vision?.roster?.slots;
  if (!Array.isArray(slots)) return track;
  const next = { ...track, slots: { ...track.slots }, lastFrameAt: stamp };
  const observations = slots.filter(slot => !slot?.fromCache && side(slot?.team) && Number.isInteger(slot.index) && slot.index >= 0 && slot.index < 10 && id(slot?.hero?.id) && slot.hero.confidence >= .96 && slot.hero.confidence <= 1 && Number.isFinite(slot.hero.margin) && slot.hero.margin >= .08);
  for (const slot of observations) {
    if (observations.filter(other => other.hero.id === slot.hero.id).length !== 1) continue;
    const key = `${slot.team}:${slot.index}`, old = next.slots[key];
    next.slots[key] = old?.heroId === slot.hero.id
      ? { ...old, count: old.count + 1, confirmed: old.confirmed || old.count + 1 >= 3 && stamp - old.firstSeenAt >= 6000 }
      : { heroId: slot.hero.id, team: slot.team, firstSeenAt: stamp, count: 1, confirmed: false };
  }
  const confirmed = Object.values(next.slots).filter(slot => slot.confirmed);
  const conflicts = confirmed.filter(slot => confirmed.some(other => other.heroId === slot.heroId && other.team !== slot.team)).map(slot => slot.heroId);
  next.teams = Object.fromEntries(['radiant', 'dire'].map(team => [team, next.gsiTeams?.[team]?.length?next.gsiTeams[team]:unique(confirmed.filter(slot => slot.team === team && !conflicts.includes(slot.heroId)).map(slot => slot.heroId)).slice(0, 5)]));
  return next;
}
function resolveDraft({ state, settings = {}, track = newPickTrack(), heroes = [], now = Date.now() } = {}) {
  const phase = draftPhase(state, settings, now), active = phase !== 'inactive';
  const isFresh = fresh(state, now), ownTeam = side(settings.draftOwnTeam) ? settings.draftOwnTeam : isFresh && side(state.team) ? state.team : null;
  const enemyTeam = ownTeam === 'radiant' ? 'dire' : ownTeam === 'dire' ? 'radiant' : null;
  const known = new Set(heroes.map(hero => hero.id));
  const validIds = value => unique(value).filter(heroId => known.has(heroId));
  const preview = phase === 'preview';
  const gsi = !preview && isFresh ? state.draft : null;
  const screenAllies = ownTeam ? validIds(track.teams[ownTeam]) : [], screenEnemies = enemyTeam ? validIds(track.teams[enemyTeam]) : [];
  const gsiAllies = ownTeam ? validIds(gsi?.teams?.[ownTeam]) : [], gsiEnemies = enemyTeam ? validIds(gsi?.teams?.[enemyTeam]) : [];
  const automaticAllies = gsiAllies.length ? gsiAllies : screenAllies;
  const automaticEnemies = gsiEnemies.length ? gsiEnemies : screenEnemies;
  const manualAllies = settings.draftAllyOverride === true, manualEnemies = settings.draftEnemyOverride === true, manualBans = settings.draftBanOverride === true;
  let allyHeroIds = validIds(manualAllies || preview ? settings.draftAllyHeroIds : automaticAllies).slice(0, 5);
  let enemyHeroIds = validIds(manualEnemies || preview ? settings.draftEnemyHeroIds : automaticEnemies).slice(0, 5);
  let bannedHeroIds = validIds(manualBans || preview ? settings.draftBannedHeroIds : gsi?.bannedHeroIds);
  const ownHeroId = !preview && isFresh && known.has(state.heroId) && !state.selectedOtherUnit ? state.heroId : null;
  if (ownHeroId) { allyHeroIds = unique([ownHeroId, ...allyHeroIds]).slice(0, 5); enemyHeroIds = enemyHeroIds.filter(heroId => heroId !== ownHeroId); }
  const conflicts = allyHeroIds.filter(heroId => enemyHeroIds.includes(heroId));
  allyHeroIds = allyHeroIds.filter(heroId => !conflicts.includes(heroId)||manualAllies&&!manualEnemies);
  enemyHeroIds = enemyHeroIds.filter(heroId => !conflicts.includes(heroId)||manualEnemies&&!manualAllies);
  bannedHeroIds = bannedHeroIds.filter(heroId => !allyHeroIds.includes(heroId) && !enemyHeroIds.includes(heroId));
  const manual = manualAllies || manualEnemies || manualBans || preview;
  const hasGsi = gsiAllies.length > 0 || gsiEnemies.length > 0;
  const hasScreen = screenAllies.length > 0 || screenEnemies.length > 0;
  const source = manual ? hasGsi || hasScreen ? 'mixed' : 'manual' : hasGsi ? 'gsi' : hasScreen ? 'screen' : 'waiting';
  const status = ownHeroId ? 'Герой выбран. Оценка известного состава.' : ownTeam === null && (gsi?.available || hasScreen) ? 'Выбери свою сторону или укажи состав вручную.' : allyHeroIds.length || enemyHeroIds.length ? 'Оценка по известным героям; скрытые пики не учитываются.' : 'Жду выбранных героев. Можно указать состав вручную.';
  return { active, phase, source, status, allyHeroIds, enemyHeroIds, bannedHeroIds, ownTeam, ownHeroId, locked: Boolean(ownHeroId) };
}
function applyDraftSettings(settings, input, heroIds, supportedIds) {
  const known = new Set(heroIds), pool = new Set(supportedIds);
  for (const [key, flag, max] of [['draftAllyHeroIds', 'draftAllyOverride', 5], ['draftEnemyHeroIds', 'draftEnemyOverride', 5], ['draftBannedHeroIds', 'draftBanOverride', 50]]) {
    if (Array.isArray(input[key])) { settings[key] = unique(input[key]).filter(heroId => known.has(heroId)).slice(0, max); settings[flag] = true; }
  }
  // Moving a portrait to a different group removes its old assignment.
  if (Array.isArray(input.draftAllyHeroIds)) {
    if(!Array.isArray(input.draftEnemyHeroIds))settings.draftEnemyHeroIds = settings.draftEnemyHeroIds.filter(heroId => !settings.draftAllyHeroIds.includes(heroId));
    if(!Array.isArray(input.draftBannedHeroIds))settings.draftBannedHeroIds = settings.draftBannedHeroIds.filter(heroId => !settings.draftAllyHeroIds.includes(heroId));
  }
  if (Array.isArray(input.draftEnemyHeroIds)) {
    settings.draftAllyHeroIds = settings.draftAllyHeroIds.filter(heroId => !settings.draftEnemyHeroIds.includes(heroId));
    if(!Array.isArray(input.draftBannedHeroIds))settings.draftBannedHeroIds = settings.draftBannedHeroIds.filter(heroId => !settings.draftEnemyHeroIds.includes(heroId));
  }
  if (Array.isArray(input.draftBannedHeroIds)) {
    settings.draftAllyHeroIds = settings.draftAllyHeroIds.filter(heroId => !settings.draftBannedHeroIds.includes(heroId));
    settings.draftEnemyHeroIds = settings.draftEnemyHeroIds.filter(heroId => !settings.draftBannedHeroIds.includes(heroId));
  }
  if (Array.isArray(input.draftPreferredHeroIds)) settings.draftPreferredHeroIds = unique(input.draftPreferredHeroIds).filter(heroId => pool.has(heroId));
  if (['auto', 'preview'].includes(input.draftMode)) settings.draftMode = input.draftMode;
  if (['auto', 'radiant', 'dire'].includes(input.draftOwnTeam)) settings.draftOwnTeam = input.draftOwnTeam;
  if (Number.isInteger(input.draftPositionId) && input.draftPositionId >= 1 && input.draftPositionId <= 5) settings.draftPositionId = input.draftPositionId;
  if (['all', 'UNCALIBRATED', 'HERALD_GUARDIAN', 'CRUSADER_ARCHON', 'LEGEND_ANCIENT', 'DIVINE_IMMORTAL'].includes(input.draftRankId)) settings.draftRankId = input.draftRankId;
}
function clearDraftOverrides(settings) {
  settings.draftAllyHeroIds = []; settings.draftEnemyHeroIds = []; settings.draftBannedHeroIds = [];
  settings.draftAllyOverride = false; settings.draftEnemyOverride = false; settings.draftBanOverride = false;
}
module.exports = { PICK, STRATEGY, fresh, draftPhase, normalizeDraft, newPickTrack, updatePickTrack, resolveDraft, applyDraftSettings, clearDraftOverrides };
