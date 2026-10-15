'use strict';

// Screen evidence proves repeated lane occupancy, not a player's position-5
// role. Hidden members may remain in the historical lineup, never as positions.
const WK_ID = 42;
const MIN_SIMILARITY = .9;
const MAX_DISTANCE = .18;
const SCREEN_TTL_MS = 8000;
const GSI_TTL_MS = 15000;
const WINDOW_MS = 90000;
const CURRENT_MS = 60000;
const CONFIRM_MS = 10000;
const MAX_SAMPLES = 128;
const WK_NAMES = new Set(['npc_dota_hero_skeleton_king', 'npc_dota_hero_wraith_king']);
const { validScreenPlayer } = require('./roster-cache.cjs');
const finite = value => typeof value === 'number' && Number.isFinite(value);
const idOf = value => Number.isInteger(value) && value > 0 ? value : null;
const uniqueIds = values => [...new Set((Array.isArray(values) ? values : []).map(idOf).filter(Boolean))];
const teamOf = value => ['radiant', 'dire'].includes(value) ? value : null;
const matchOf = value => value === null || value === undefined || value === '' ? null : String(value);
const copy = value => JSON.parse(JSON.stringify(value));

function emptyInference(now, status = 'unknown', reason = 'Ожидаю наблюдения участников линии на миникарте.') {
  return { enemyHeroIds: [], allyHeroId: null, confidence: 0, status, reason, evidence: [], source: 'screen', updatedAt: now, lastSeenAt: null, lane: null, side: null, complete: false, historical: false, members: { enemies: [], ally: null }, candidates: { enemies: [], allies: [] } };
}

function newLaneTrack() {
  return { version: 2, matchId: null, lastGameTime: null, lastFrameAt: null, screenMode: false, screenRosterFingerprint: null, records: [], frames: [], candidate: null, confirmed: null, inferred: emptyInference(null) };
}

function laneFor(x, y, team, allowMid) {
  // Radiant base bottom-left, Dire top-right. Exclude bases and jungle/river.
  if ((x < .26 && y > .74) || (x > .74 && y < .26)) return null;
  let lane = null;
  if (y >= .72 || x >= .76) lane = 'bottom';
  else if (y <= .28 || x <= .24) lane = 'top';
  else if (allowMid && Math.abs(x + y - 1) <= .09) lane = 'mid';
  if (!lane) return null;
  return { lane, side: lane === 'mid' ? 'mid' : lane === (team === 'radiant' ? 'bottom' : 'top') ? 'safe' : 'off' };
}

function knownRoster(vision, enemyHeroIds, alliedHeroIds, playerTeam, requireConfirmedRoster = false) {
  const enemies = new Set(uniqueIds(enemyHeroIds)), allies = new Set(uniqueIds(alliedHeroIds));
  // Production supplies identities from its independently confirmed HUD cache.
  // A single portrait, including its reused crop copies, cannot bypass that gate.
  const slots = requireConfirmedRoster ? [] : Array.isArray(vision.roster) ? vision.roster : vision.roster?.slots;
  for (const slot of Array.isArray(slots) ? slots : []) {
    const id = idOf(slot?.hero?.id), team = teamOf(slot?.team);
    if (!id || !team || !finite(slot?.hero?.confidence) || slot.hero.confidence < MIN_SIMILARITY) continue;
    (team === playerTeam ? allies : enemies).add(id);
  }
  if (enemies.has(WK_ID) || [...enemies].some(id => allies.has(id))) return null;
  allies.add(WK_ID);
  return { enemies, allies };
}

function markerValid(marker) {
  return idOf(marker?.id ?? marker?.heroId) !== null && finite(marker?.x) && finite(marker?.y) && marker.x >= 0 && marker.x <= 1 && marker.y >= 0 && marker.y <= 1 && finite(marker?.confidence);
}

function ambiguousMarker(marker) {
  return marker.isIllusion === true || marker.illusion === true || marker.type === 'illusion' || (finite(marker.count) && marker.count > 1) || (finite(marker.observedCount) && marker.observedCount > 1);
}

function prune(track, stamp) {
  track.frames = track.frames.filter(frame => stamp - frame.capturedAt <= WINDOW_MS).slice(-MAX_SAMPLES);
  for (const record of track.records) record.samples = record.samples.filter(sample => stamp - sample.at <= WINDOW_MS).slice(-MAX_SAMPLES);
  track.records = track.records.filter(record => record.samples.length || record.confirmedAt !== null);
}

const recordFor = (track, id, team, lane) => track.records.find(record => record.id === id && record.team === team && record.lane === lane);

function observe(track, id, team, lane, stamp, confidence, exclusive) {
  let record = recordFor(track, id, team, lane.lane);
  if (!record) {
    record = { id, team, ...lane, samples: [], confirmedAt: null, lastSeenAt: null, lastConfidence: null };
    track.records.push(record);
  }
  record.samples.push({ at: stamp, confidence, exclusive });
  record.samples = record.samples.slice(-MAX_SAMPLES);
  record.lastSeenAt = stamp;
  record.lastConfidence = confidence;
}

function stable(record, exclusive = false) {
  const samples = exclusive ? record.samples.filter(sample => sample.exclusive) : record.samples;
  return samples.length >= 3 && samples.at(-1).at - samples[0].at >= CONFIRM_MS;
}

function dominates(candidate, other) {
  const count = other?.samples.length || 0;
  return !count || (candidate.samples.length >= count + 2 && candidate.samples.length >= count * 1.5);
}

const compareRecords = (a, b) => b.samples.length - a.samples.length || b.lastSeenAt - a.lastSeenAt || a.id - b.id;

function selectEnemies(track, lane, stamp, incumbentIds) {
  const records = track.records.filter(record => record.team === 'enemy' && record.lane === lane && stable(record)).sort(compareRecords);
  const chosen = incumbentIds.map(id => recordFor(track, id, 'enemy', lane)).filter(Boolean);
  for (const candidate of records.filter(record => !chosen.includes(record))) {
    if (chosen.length < 2) {
      const others = records.filter(record => !chosen.includes(record) && record !== candidate);
      // Never break a tie between several possible second opponents by ID.
      if (others.length && chosen.length + others.length >= 2 && !dominates(candidate, others[0])) continue;
      chosen.push(candidate);
    } else {
      const weakest = [...chosen].sort(compareRecords).at(-1);
      if (stamp - weakest.lastSeenAt >= 20000 && dominates(candidate, weakest)) chosen.splice(chosen.indexOf(weakest), 1, candidate);
    }
  }
  return chosen.sort((a, b) => a.id - b.id).slice(0, 2);
}

function selectAlly(track, lane, stamp, incumbentId) {
  const records = track.records.filter(record => record.team === 'ally' && record.lane === lane).sort(compareRecords);
  const incumbent = recordFor(track, incumbentId, 'ally', lane);
  for (const candidate of records.filter(record => stable(record, true))) {
    if (candidate === incumbent) return incumbent;
    if (records.some(other => other !== candidate && !dominates(candidate, other))) continue;
    if (!incumbent || (stamp - incumbent.lastSeenAt >= 20000 && dominates(candidate, incumbent))) return candidate;
  }
  return incumbent || null;
}

function viewMember(record, now, stamp, selected) {
  const age = Math.max(0, now - record.lastSeenAt);
  const visibleNow = selected && stamp === record.lastSeenAt;
  const historical = selected && age > CURRENT_MS;
  const similarity = record.samples.length ? Math.min(...record.samples.map(sample => sample.confidence)) : record.lastConfidence;
  return { id: record.id, heroId: record.id, team: record.team, status: !selected ? 'observing' : visibleNow ? 'confirmed' : historical ? 'historical' : 'retained', confirmed: selected, visibleNow, historical, confidence: selected ? Math.max(.45, similarity * Math.max(.5, 1 - age / (2 * CURRENT_MS))) : similarity, minSimilarity: similarity, observations: record.samples.length, spanMs: record.samples.length ? record.samples.at(-1).at - record.samples[0].at : 0, exclusiveObservations: record.samples.filter(sample => sample.exclusive).length, firstSeenAt: record.samples[0]?.at ?? null, lastSeenAt: record.lastSeenAt, confirmedAt: record.confirmedAt, lane: record.lane };
}

function renderInference(track, now, reason, forceRetained = false, emptyStatus = 'unknown') {
  const group = track.confirmed;
  const lane = group?.lane ?? track.candidate?.lane;
  const selectedIds = new Set(group?.enemyHeroIds || []), selectedAlly = group?.allyHeroId;
  const visibleStamp = forceRetained ? null : track.lastFrameAt;
  const enemyRecords = (group?.enemyHeroIds || []).map(id => recordFor(track, id, 'enemy', lane)).filter(Boolean);
  const allyRecord = recordFor(track, selectedAlly, 'ally', lane);
  const members = { enemies: enemyRecords.map(record => viewMember(record, now, visibleStamp, true)), ally: allyRecord ? viewMember(allyRecord, now, visibleStamp, true) : null };
  const records = track.records.filter(record => record.lane === lane && record.samples.length);
  const candidates = { enemies: records.filter(record => record.team === 'enemy' && !selectedIds.has(record.id)).sort(compareRecords).map(record => viewMember(record, now, null, false)), allies: records.filter(record => record.team === 'ally' && record.id !== selectedAlly).sort(compareRecords).map(record => viewMember(record, now, null, false)) };
  if (!group) {
    track.inferred = { ...emptyInference(now, track.candidate ? 'observing' : emptyStatus, reason), lane: lane || null, side: track.candidate?.side || null, candidates, evidence: copy(track.candidate?.evidence || []) };
    return track;
  }
  const allMembers = [...members.enemies, ...(members.ally ? [members.ally] : [])];
  const current = !forceRetained && allMembers.every(member => member.visibleNow);
  const complete = members.enemies.length === 2 && members.ally !== null;
  const historical = allMembers.some(member => member.historical);
  let detail = current ? (complete ? 'Два соперника и вероятный напарник подтверждены независимыми наблюдениями.' : 'Часть участников линии подтверждена; остальные иконки ещё проверяются.') : 'Сохранён подтверждённый состав линии; текущие позиции скрытых героев не подтверждены.';
  if (historical) detail = 'Сохранена история участников линии; длительно скрытые герои отмечены как прошлые наблюдения, их текущие позиции неизвестны.';
  if (members.ally) detail += ' Напарник — вероятный союзник линии; его роль не определяется.';
  if(group.source==='screen_current')detail='Видимые герои рядом с Wraith King; исходный состав линии не подтверждён. '+(current?'Иконки проверены по повторным кадрам.':'Текущие позиции скрытых героев неизвестны.');
  track.inferred = { enemyHeroIds: [...group.enemyHeroIds], allyHeroId: group.allyHeroId, confidence: Math.min(...allMembers.map(member => member.confidence)), status: current ? 'confirmed' : 'retained', reason: reason ? `${reason} ${detail}` : detail, evidence: copy(group.evidence), source: group.source||'screen', updatedAt: now, lastSeenAt: Math.min(...allMembers.map(member => member.lastSeenAt)), lane: group.lane, side: group.side, complete, historical, members, candidates };
  return track;
}

function abstain(track, now, reason, status = 'unknown', retain = true) {
  track.candidate = null;
  if (retain) return renderInference(track, now, reason, true, status);
  track.inferred = emptyInference(now, status, reason);
  return track;
}

/** Immutable state. Call with real live captures only, never demo/import frames.
 * Each hero needs three distinct observations over ten seconds. Simultaneous
 * visibility is unnecessary. Manual selections may override the result. */
function updateLaneTrack(previous, input = {}) {
  const now = finite(input.now) ? input.now : Date.now(), state = input.state || {}, vision = input.vision || {};
  const matchId = matchOf(state.matchId), gameTime = finite(state.gameTime) ? state.gameTime : null;
  let track = previous?.version === 2 ? copy(previous) : newLaneTrack();
  if ((track.matchId !== null && matchId !== null && track.matchId !== matchId) || (finite(track.lastGameTime) && gameTime !== null && gameTime < track.lastGameTime - 5)) track = newLaneTrack();
  if (matchId !== null) track.matchId = matchId;
  if (gameTime !== null) track.lastGameTime = gameTime;
  const proof=input.screenPlayer??vision.player,screenMode=validScreenPlayer(proof,now);
  const freshGsi=finite(state.receivedAt)&&now-state.receivedAt<=GSI_TTL_MS&&state.receivedAt-now<=1000;
  const ownGsi=state.isWraithKing===true&&state.heroId===WK_ID&&(!state.heroName||WK_NAMES.has(state.heroName));
  if(proof&&!screenMode||track.screenMode&&!screenMode){track=newLaneTrack();return abstain(track,now,'Выбранный Wraith King в HUD не подтверждён свежим кадром.','inactive',false);}
  if(screenMode){
    if(freshGsi&&(state.isSpectator===true||state.status==='spectator'||(Number.isInteger(state.heroId)&&state.heroId>0&&state.heroId!==WK_ID))){track=newLaneTrack();return abstain(track,now,'Свежие данные игрока не соответствуют выбранному Wraith King.','inactive',false);}
    track.screenMode=true;
  }else{
    if (!ownGsi || state.isSpectator === true || state.status === 'spectator') return abstain(track, now, 'Состояние своего Wraith King не подтверждено.', 'inactive', false);
    if (!freshGsi) return abstain(track, now, 'Нет свежих данных GSI для определения участников линии.', 'unknown', false);
    if (gameTime === null || gameTime < 0 || gameTime >= 600 || state.isPaused === true || /POST_GAME|DISCONNECT|INIT|WAIT_FOR_PLAYERS|HERO_SELECTION|STRATEGY_TIME|TEAM_SHOWCASE|CUSTOM_GAME_SETUP/.test(state.gameState || '')) return abstain(track, now, 'Новые участники определяются во время лайнинга, до 10:00.', 'inactive');
  }
  const playerTeam = screenMode?proof.team:teamOf(input.playerTeam ?? state.team);
  if (!playerTeam || (freshGsi&&teamOf(state.team) && state.team !== playerTeam)) return abstain(track, now, 'Сторона игрока неизвестна или конфликтует с GSI.', 'unknown', false);
  const stamp = finite(vision.capturedAt) ? vision.capturedAt : finite(vision.receivedAt) ? vision.receivedAt : vision.timestamp;
  if (vision.quality?.usable !== true || !finite(stamp) || now - stamp > SCREEN_TTL_MS || stamp - now > 1000) return abstain(track, now, 'Нет свежего пригодного изображения миникарты.');
  if (finite(track.lastFrameAt) && stamp <= track.lastFrameAt) {
    if (now - track.lastFrameAt <= SCREEN_TTL_MS) return track;
    return renderInference(track, now, 'Нового кадра пока нет.', true);
  }
  track.lastFrameAt = stamp;
  prune(track, stamp);
  const known = knownRoster(vision, input.enemyHeroIds, input.alliedHeroIds, playerTeam, input.requireConfirmedRoster === true);
  if (!known || !known.enemies.size) return abstain(track, now, 'Нужен известный состав команд без конфликтующих героев.', 'unknown', false);
  if(screenMode&&input.requireConfirmedRoster!==true)return abstain(track,now,'Для экранного режима нужны команды, подтверждённые повторными кадрами HUD.','unknown',false);
  if(screenMode&&known.enemies.size===5&&known.allies.size===5){
    const fingerprint=[...known.allies].sort((a,b)=>a-b).join(',')+'|'+[...known.enemies].sort((a,b)=>a-b).join(',');
    if(track.screenRosterFingerprint&&track.screenRosterFingerprint!==fingerprint){
      track.records=[];track.frames=[];track.confirmed=null;track.candidate=null;
    }
    track.screenRosterFingerprint=fingerprint;
  }
  if (input.requireConfirmedRoster === true && known.enemies.size >= 5 && known.allies.size >= 5) {
    const memberKnown = record => (record.team === 'enemy' ? known.enemies : known.allies).has(record.id);
    if (track.records.some(record => !memberKnown(record))) {
      // A complete independently confirmed HUD roster can disprove an earlier
      // portrait identification. Missing entries in a partial roster cannot.
      track.records = track.records.filter(memberKnown);
      const evidenceKnown = evidence => evidence.enemyHeroIds.every(id => known.enemies.has(id)) && (evidence.alliedHeroIds || []).every(id => known.allies.has(id));
      track.frames = track.frames.filter(evidenceKnown);
      track.candidate = null;
      if (track.confirmed) {
        const group = track.confirmed;
        const enemyIds = group.enemyHeroIds.filter(id => known.enemies.has(id));
        const allyId = known.allies.has(group.allyHeroId) ? group.allyHeroId : null;
        const surviving = [...enemyIds.map(id => recordFor(track, id, 'enemy', group.lane)), ...(allyId ? [recordFor(track, allyId, 'ally', group.lane)] : [])].filter(Boolean);
        track.confirmed = surviving.length ? { ...group, enemyHeroIds: enemyIds, allyHeroId: allyId, lastSeenAt: Math.min(...surviving.map(record => record.lastSeenAt)), evidence: group.evidence.filter(evidenceKnown) } : null;
      }
    }
  }
  if (track.records.some(record => record.team === 'enemy' ? known.allies.has(record.id) : known.enemies.has(record.id))) {
    if (input.requireConfirmedRoster === true) return abstain(track, now, 'Стороны прежних участников расходятся с неполным HUD; ожидаю полный состав команд для проверки.', 'unknown', false);
    track.records = []; track.frames = []; track.confirmed = null;
    return abstain(track, now, 'Известные стороны героев изменились; прежние наблюдения сброшены.', 'unknown', false);
  }
  let markers = (Array.isArray(vision.minimap?.heroes) ? vision.minimap.heroes : []).filter(markerValid);
  let selves = markers.filter(marker => idOf(marker.id ?? marker.heroId) === WK_ID);
  let sceneObservation=false;
  const uniqueSelf=(values,allowQualifiedScene=false)=>{
    if(values.length!==1||ambiguousMarker(values[0]))return false;
    const marker=values[0],qualified=allowQualifiedScene&&screenMode&&marker.qualifiedBySelectedHud===true&&(marker.type==='visible_scene_head'||marker.source==='visible_scene_head')&&marker.confidence>=.86;
    return marker.confidence>=MIN_SIMILARITY||qualified;
  };
  let lane=uniqueSelf(selves)?laneFor(selves[0].x,selves[0].y,playerTeam,input.allowMid===true):null;
  {
    const scene=(Array.isArray(vision.scene?.heroes)?vision.scene.heroes:[]).filter(markerValid);
    const sceneSelves=scene.filter(marker=>idOf(marker.id??marker.heroId)===WK_ID);
    const sceneHasAlly=scene.some(marker=>marker.id!==WK_ID&&marker.confidence>=MIN_SIMILARITY&&known.allies.has(marker.id));
    const sceneHasEnemy=scene.some(marker=>marker.confidence>=MIN_SIMILARITY&&known.enemies.has(marker.id));
    const selfTeamProved=!screenMode||sceneSelves.length===1&&(sceneSelves[0].healthColor==='ally'||['ally','self',playerTeam].includes(sceneSelves[0].team));
    if (vision.scene?.usable===true&&uniqueSelf(sceneSelves,true)&&selfTeamProved&&(screenMode||sceneHasAlly&&sceneHasEnemy)) {
      // These coordinates are in the visible camera, never positions on the map.
      // Own WK must also be visible; looking at a remote lane cannot assign it.
      markers=scene;selves=sceneSelves;sceneObservation=true;
      lane={lane:track.confirmed?.lane||'onscreen',side:track.confirmed?.side||'unknown'};
    }
  }
  if (!uniqueSelf(selves,sceneObservation)) return abstain(track, now, 'Жду отдельный значок Wraith King на миникарте или рядом с его полоской здоровья.');
  if(screenMode&&(selves[0].team==='enemy'||teamOf(selves[0].team)&&selves[0].team!==playerTeam))return abstain(track,now,'Сторона видимого Wraith King конфликтует с выбранным героем.','unknown',false);
  if (!sceneObservation&&finite(vision.minimap?.observedHeroCount) && vision.minimap.observedHeroCount > 10) return abstain(track, now, 'На миникарте неоднозначное число иконок; возможны иллюзии или ошибки распознавания.');
  const self = selves[0];
  const currentOnly=screenMode&&(!freshGsi||!ownGsi||gameTime===null||gameTime<0||gameTime>=600||state.isPaused===true);
  if (!lane&&currentOnly)lane={lane:'nearby',side:'unknown'};
  if (!lane) return abstain(track, now, 'Wraith King вне коридора боковой линии: близость героев не определяет участников линии.');
  const nearby = markers.filter(marker => idOf(marker.id ?? marker.heroId) !== WK_ID && marker.confidence >= MIN_SIMILARITY && Math.hypot(marker.x - self.x, marker.y - self.y) <= (sceneObservation ? .40 : MAX_DISTANCE));
  const observed = nearby.filter(marker => known.enemies.has(idOf(marker.id ?? marker.heroId)) || known.allies.has(idOf(marker.id ?? marker.heroId)));
  if (nearby.some(marker => !observed.includes(marker))) return abstain(track, now, 'Рядом есть герой, чья принадлежность команде не подтверждена.');
  const seenIds = observed.map(marker => idOf(marker.id ?? marker.heroId));
  if (new Set(seenIds).size !== seenIds.length || observed.some(ambiguousMarker)) return abstain(track, now, 'Рядом неоднозначные или повторяющиеся иконки героев.');
  if (observed.some(marker => (marker.team === 'enemy' && !known.enemies.has(idOf(marker.id ?? marker.heroId))) || (['ally', 'self'].includes(marker.team) && !known.allies.has(idOf(marker.id ?? marker.heroId))) || (teamOf(marker.team) && (marker.team === playerTeam) !== known.allies.has(idOf(marker.id ?? marker.heroId))))) return abstain(track, now, 'Распознанные стороны героев конфликтуют с известным составом.', 'unknown', false);
  const enemyHeroIds = seenIds.filter(id => known.enemies.has(id)).sort((a, b) => a - b), alliedHeroIds = seenIds.filter(id => known.allies.has(id)).sort((a, b) => a - b);
  if(sceneObservation&&screenMode&&!observed.length)return renderInference(track,now,'Wraith King виден; жду союзника и соперников рядом в сцене.',true);
  if(sceneObservation&&!screenMode&&!track.confirmed&&(!enemyHeroIds.length||!alliedHeroIds.length))return abstain(track,now,'Жду своего Wraith King, союзника и соперников вместе в видимой сцене.');
  if (enemyHeroIds.length > 2) return abstain(track, now, 'Рядом три и более соперника; возможна ротация, новые участники не назначаются.');
  const minConfidence = Math.min(self.confidence, ...observed.map(marker => marker.confidence));
  const evidence = { type: sceneObservation?'visible_scene_members':'visible_lane_members', capturedAt: stamp, enemyHeroIds, alliedHeroIds, allyHeroId: alliedHeroIds.length === 1 ? alliedHeroIds[0] : null, ...lane, minSimilarity: minConfidence };
  track.frames.push(evidence);
  track.frames = track.frames.slice(-MAX_SAMPLES);
  for (const marker of observed) {
    const id = idOf(marker.id ?? marker.heroId), team = known.enemies.has(id) ? 'enemy' : 'ally';
    observe(track, id, team, lane, stamp, Math.min(self.confidence, marker.confidence), team === 'enemy' || alliedHeroIds.length === 1);
  }
  const frames = track.frames.filter(frame => frame.lane === lane.lane);
  track.candidate = { ...lane, enemyHeroIds: [...enemyHeroIds], allyHeroId: alliedHeroIds.length === 1 ? alliedHeroIds[0] : null, firstSeenAt: frames[0].capturedAt, lastSeenAt: stamp, frameCount: frames.length, evidence: copy(frames.slice(-3)) };
  const sameLane = track.confirmed?.lane === lane.lane;
  const enemies = selectEnemies(track, lane.lane, stamp, sameLane ? track.confirmed.enemyHeroIds : []);
  const ally = selectAlly(track, lane.lane, stamp, sameLane ? track.confirmed.allyHeroId : null);
  // A brief visit to another lane cannot rewrite the initial matchup.
  if ((!track.confirmed || sameLane || (enemies.length === 2 && ally)) && (enemies.length || ally)) {
    const confirmedAt = sameLane ? track.confirmed.confirmedAt : stamp;
    for (const record of [...enemies, ...(ally ? [ally] : [])]) if (record.confirmedAt === null) record.confirmedAt = stamp;
    track.confirmed = { ...lane, source:currentOnly?'screen_current':sceneObservation?'screen_scene':'screen',enemyHeroIds: enemies.map(record => record.id), allyHeroId: ally?.id ?? null, confirmedAt, lastSeenAt: Math.min(...[...enemies, ...(ally ? [ally] : [])].map(record => record.lastSeenAt)), minConfidence, evidence: copy(frames.slice(-3)) };
  }
  return renderInference(track, now, track.confirmed ? null : 'Участники проверяются отдельно: каждому нужны 3 разных кадра за 10 секунд; для напарника также проверяется преобладание над другими союзниками.');
}

module.exports = { updateLaneTrack, newLaneTrack, resetLaneTrack: newLaneTrack };
