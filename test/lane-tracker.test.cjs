'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { updateLaneTrack, newLaneTrack } = require('../src/lane-tracker.cjs');
const { updateRosterCache } = require('../src/roster-cache.cjs');
const START = 100000;
const marker = (id, x, y, extra = {}) => ({ id, x, y, confidence: 0.96, ...extra });
function frame(now, extra = {}) {
  return { state: { heroId: 42, heroName: 'npc_dota_hero_skeleton_king', isWraithKing: true, matchId: '100', gameTime: 150 + (now - START) / 1000, receivedAt: now, team: 'radiant' }, vision: { capturedAt: now, quality: { usable: true }, minimap: { heroes: [marker(42, .8, .8), marker(2, .84, .77), marker(101, .89, .78), marker(26, .75, .8)] } }, enemyHeroIds: [2, 101, 1, 11, 28], alliedHeroIds: [42, 26, 17, 30, 8], playerTeam: 'radiant', now, ...extra };
}
function confirmed(extra = {}) {
  let track = newLaneTrack();
  for (const offset of [0, 5000, 10000]) track = updateLaneTrack(track, frame(START + offset, extra));
  return track;
}
function withHeroes(now, heroes, extra = {}) {
  const input = frame(now, extra);
  input.vision = { ...input.vision, minimap: { heroes } };
  return input;
}

function sceneFrame(now, heroes) {
  const input=frame(now,{enemyHeroIds:[2,22,43,18,20],alliedHeroIds:[42,26,36,6,37],requireConfirmedRoster:true});
  input.vision.minimap.heroes=[];
  input.vision.scene={usable:true,heroes:heroes||[marker(42,.426,.431),marker(26,.162,.416),marker(22,.26,.309),marker(2,.526,.213)]};
  return input;
}

test('visible healthbar heads confirm the actual WK, Lion, Axe and Zeus lineup with no map icons',()=>{
  let track=null;
  for(const offset of[0,5000,10000])track=updateLaneTrack(track,sceneFrame(START+offset));
  assert.equal(track.inferred.complete,true);assert.equal(track.inferred.allyHeroId,26);
  assert.deepEqual(track.inferred.enemyHeroIds,[2,22]);assert.equal(track.inferred.source,'screen_scene');
  assert.equal(track.inferred.side,'unknown');
  assert.ok(track.inferred.evidence.every(e=>e.type==='visible_scene_members'&&!('screenX'in e)));
});

test('remote camera, duplicated WK, weak heads, unconfirmed teams and single scene frames cannot assign lineup',()=>{
  const heroes=sceneFrame(START).vision.scene.heroes;
  const missingSelf=sceneFrame(START,heroes.filter(h=>h.id!==42));
  const duplicates=sceneFrame(START,[...heroes,marker(42,.42,.4)]);
  const weak=sceneFrame(START,heroes.map(h=>h.id===42?{...h,confidence:.89}:h));
  const unknownTeams=sceneFrame(START);unknownTeams.enemyHeroIds=[];unknownTeams.alliedHeroIds=[];
  for(const input of[missingSelf,duplicates,weak,unknownTeams,sceneFrame(START)])assert.equal(updateLaneTrack(null,input).inferred.complete,false);
  let track=updateLaneTrack(null,sceneFrame(START));
  for(const offset of[5000,10000]){const repeated=sceneFrame(START+offset);repeated.vision.capturedAt=START;track=updateLaneTrack(track,repeated);}
  assert.equal(track.inferred.complete,false);
});

test('visible world heads do not establish old laning partners after ten minutes or during pause',()=>{
  for(const patch of[{gameTime:610},{isPaused:true}]){
    let track=null;
    for(const offset of[0,5000,10000]){const input=sceneFrame(START+offset);Object.assign(input.state,patch);track=updateLaneTrack(track,input);}
    assert.equal(track.inferred.complete,false);
  }
});

test('three distinct frames over ten seconds confirm the lineup and lane companion', () => {
  let track = updateLaneTrack(null, frame(START));
  assert.equal(track.inferred.status, 'observing'); assert.deepEqual(track.inferred.enemyHeroIds, []);
  track = updateLaneTrack(track, frame(START + 5000));
  assert.equal(track.inferred.status, 'observing');
  track = updateLaneTrack(track, frame(START + 10000));
  assert.equal(track.inferred.status, 'confirmed'); assert.deepEqual(track.inferred.enemyHeroIds, [2, 101]); assert.equal(track.inferred.allyHeroId, 26);
  assert.equal(track.inferred.side, 'safe'); assert.equal(track.inferred.source, 'screen'); assert.equal(track.inferred.evidence.length, 3);
  assert.match(track.inferred.reason, /роль не определяется/);
});

test('duplicate capture timestamps cannot count as repeated observations', () => {
  let track = updateLaneTrack(null, frame(START));
  for (const offset of [2000, 5000, 7000]) {
    const input = frame(START + offset); input.vision.capturedAt = START;
    track = updateLaneTrack(track, input);
  }
  assert.equal(track.candidate.frameCount, 1); assert.equal(track.inferred.status, 'observing');
});

test('short sampling bursts and a single roaming frame cannot confirm or replace a lineup', () => {
  let track = null;
  for (const offset of [0, 1000, 2000]) track = updateLaneTrack(track, frame(START + offset));
  assert.equal(track.inferred.status, 'observing');
  track = confirmed();
  const roaming = withHeroes(START + 15000, [marker(42, .8, .8), marker(1, .84, .77), marker(28, .89, .78), marker(26, .75, .8)]);
  track = updateLaneTrack(track, roaming);
  assert.equal(track.inferred.status, 'retained'); assert.deepEqual(track.inferred.enemyHeroIds, [2, 101]);
  track = updateLaneTrack(track, frame(START + 20000));
  assert.equal(track.inferred.status, 'confirmed'); assert.deepEqual(track.inferred.enemyHeroIds, [2, 101]);
});

test('a brief repeated rotation cannot replace incumbents; dominant occupancy can', () => {
  let track = confirmed();
  for (const offset of [15000, 20000, 25000]) track = updateLaneTrack(track, withHeroes(START + offset, [marker(42, .8, .8), marker(1, .84, .77), marker(28, .89, .78), marker(26, .75, .8)]));
  assert.equal(track.inferred.status, 'retained'); assert.deepEqual(track.inferred.enemyHeroIds, [2, 101]);
  for (const offset of [30000, 35000]) track = updateLaneTrack(track, withHeroes(START + offset, [marker(42, .8, .8), marker(1, .84, .77), marker(28, .89, .78), marker(26, .75, .8)]));
  assert.equal(track.inferred.status, 'confirmed'); assert.deepEqual(track.inferred.enemyHeroIds, [1, 28]);
});

test('hidden lineup transitions to historical members rather than losing the matchup', () => {
  let track = confirmed();
  track = updateLaneTrack(track, withHeroes(START + 40000, [marker(42, .8, .8)]));
  assert.equal(track.inferred.status, 'retained'); assert.deepEqual(track.inferred.enemyHeroIds, [2, 101]); assert.ok(track.inferred.confidence < .96);
  assert.match(track.inferred.reason, /текущие позиции.*не подтверждены/);
  assert.equal(track.inferred.lastSeenAt, START + 10000);
  assert.equal(track.inferred.evidence.some(entry => 'x' in entry || 'y' in entry), false);
  track = updateLaneTrack(track, withHeroes(START + 71000, [marker(42, .8, .8)]));
  assert.equal(track.inferred.status, 'retained'); assert.deepEqual(track.inferred.enemyHeroIds, [2, 101]);
  assert.equal(track.inferred.historical, true);
  assert.equal(track.inferred.members.ally.status, 'historical');
  assert.equal(track.inferred.members.enemies.every(member => member.status === 'historical' && !member.visibleNow), true);
  assert.match(track.inferred.reason, /текущие позиции неизвестны/);
});

test('a historical confirmed member can become visible again without being rediscovered', () => {
  let track = confirmed();
  track = updateLaneTrack(track, withHeroes(START + 110000, [marker(42, .8, .8)]));
  assert.equal(track.inferred.historical, true); assert.equal(track.records.every(record => !record.samples.length), true);
  track = updateLaneTrack(track, frame(START + 115000));
  assert.equal(track.inferred.status, 'confirmed'); assert.equal(track.inferred.historical, false);
  assert.deepEqual(track.inferred.enemyHeroIds, [2, 101]);
});

test('partial observation refreshes only that member and preserves clearly marked history', () => {
  let track = confirmed();
  for (const offset of [15000, 20000, 25000, 40000, 55000, 70000]) track = updateLaneTrack(track, withHeroes(START + offset, [marker(42, .8, .8), marker(2, .84, .77)]));
  assert.equal(track.inferred.status, 'retained'); assert.deepEqual(track.inferred.enemyHeroIds, [2, 101]); assert.equal(track.inferred.lastSeenAt, START + 10000);
  track = updateLaneTrack(track, withHeroes(START + 75000, [marker(42, .8, .8), marker(2, .84, .77)]));
  assert.equal(track.inferred.status, 'retained'); assert.deepEqual(track.inferred.enemyHeroIds, [2, 101]); assert.equal(track.inferred.allyHeroId, 26);
  assert.equal(track.inferred.members.enemies.find(member => member.id === 2).visibleNow, true);
  assert.equal(track.inferred.members.enemies.find(member => member.id === 101).status, 'historical');
  assert.equal(track.inferred.members.ally.lastSeenAt, START + 10000);
});

test('stale captures, missing or duplicated WK and low similarity abstain', () => {
  const inputs = [
    frame(START, { vision: { capturedAt: START - 9000, quality: { usable: true }, minimap: { heroes: [marker(42, .8, .8), marker(2, .84, .77)] } } }),
    withHeroes(START, [marker(2, .84, .77)]),
    withHeroes(START, [marker(42, .8, .8), marker(42, .7, .8), marker(2, .84, .77)]),
    withHeroes(START, [marker(42, .8, .8, { confidence: .89 }), marker(2, .84, .77)]),
    withHeroes(START, [marker(42, .8, .8, { count: 2 }), marker(2, .84, .77)]),
  ];
  for (const input of inputs) { const track = updateLaneTrack(null, input); assert.deepEqual(track.inferred.enemyHeroIds, []); assert.equal(track.candidate, null); }
});

test('unknown team, missing known enemy ids, conflicting roster and other hero cannot infer', () => {
  const inputs = [frame(START, { playerTeam: 'unknown', state: { ...frame(START).state, team: null } }), frame(START, { enemyHeroIds: [] }), frame(START, { alliedHeroIds: [42, 2] }), frame(START, { playerTeam: 'dire' }), frame(START, { state: { ...frame(START).state, heroId: 1, isWraithKing: false } }), frame(START, { state: { ...frame(START).state, receivedAt: START - 20000 } })];
  for (const input of inputs) { const track = updateLaneTrack(null, input); assert.deepEqual(track.inferred.enemyHeroIds, []); assert.equal(track.candidate, null); }
});

test('fresh high-similarity roster can identify teams without role guesses', () => {
  let track = null;
  for (const offset of [0, 5000, 10000]) {
    const input = frame(START + offset, { enemyHeroIds: [], alliedHeroIds: [] });
    input.vision.roster = { slots: [{ team: 'radiant', hero: { id: 42, confidence: .96 } }, { team: 'radiant', hero: { id: 26, confidence: .96 } }, { team: 'dire', hero: { id: 2, confidence: .96 } }, { team: 'dire', hero: { id: 101, confidence: .96 } }] };
    track = updateLaneTrack(track, input);
  }
  assert.equal(track.inferred.status, 'confirmed'); assert.equal(track.inferred.allyHeroId, 26);
});

test('strict team gate cannot promote a single HUD portrait reused in later crops', () => {
  let track = null, cache = null;
  for (const offset of [0, 5000, 10000]) {
    const input = withHeroes(START + offset, [marker(42, .8, .8), marker(2, .84, .77)], { enemyHeroIds: [], alliedHeroIds: [], requireConfirmedRoster: true });
    input.vision.roster = { slots: [{ team: 'dire', hero: { id: 2, confidence: .96 }, fromCache: offset !== 0 }] };
    input.vision.diagnostics = { rosterRefreshed: offset === 0 };
    cache = updateRosterCache(cache, input);
    input.enemyHeroIds = cache.teams.dire; input.alliedHeroIds = cache.teams.radiant;
    track = updateLaneTrack(track, input);
  }
  assert.deepEqual(cache.teams.dire, []); assert.deepEqual(track.inferred.enemyHeroIds, []);
  assert.equal(track.confirmed, null); assert.equal(track.records.length, 0);
});

test('strict bootstrap starts independent map confirmation after two real HUD frames', () => {
  let track = null, cache = null;
  for (const offset of [0, 5000, 10000, 15000]) {
    const input = frame(START + offset, { enemyHeroIds: [], alliedHeroIds: [], requireConfirmedRoster: true });
    input.vision.roster = { slots: [{ team: 'radiant', hero: { id: 42, confidence: .96 } }, { team: 'radiant', hero: { id: 26, confidence: .96 } }, { team: 'dire', hero: { id: 2, confidence: .96 } }, { team: 'dire', hero: { id: 101, confidence: .96 } }] };
    input.vision.diagnostics = { rosterRefreshed: true };
    cache = updateRosterCache(cache, input);
    input.enemyHeroIds = cache.teams.dire; input.alliedHeroIds = cache.teams.radiant;
    track = updateLaneTrack(track, input);
    if (offset < 15000) assert.notEqual(track.inferred.status, 'confirmed');
  }
  assert.equal(track.inferred.status, 'confirmed'); assert.equal(track.inferred.complete, true);
  assert.deepEqual(track.inferred.enemyHeroIds, [2, 101]); assert.equal(track.inferred.allyHeroId, 26);
  assert.equal(track.inferred.members.enemies.every(member => member.observations === 3 && member.spanMs === 10000), true);
});

test('complete strict corrected HUD roster invalidates false confirmed members and candidates', () => {
  let track = confirmed();
  track = updateLaneTrack(track, withHeroes(START + 15000, [marker(42, .8, .8), marker(1, .84, .77), marker(26, .75, .8)]));
  assert.equal(track.inferred.candidates.enemies.some(member => member.id === 1), true);
  const corrected = { enemyHeroIds: [3, 101, 4, 11, 28], alliedHeroIds: [42, 26, 17, 30, 8], requireConfirmedRoster: true };
  for (const offset of [20000, 25000, 30000]) {
    track = updateLaneTrack(track, withHeroes(START + offset, [marker(42, .8, .8), marker(101, .84, .77), marker(3, .89, .78), marker(26, .75, .8)], corrected));
    assert.equal(track.records.some(record => record.id === 1 || record.id === 2), false);
    assert.equal(track.inferred.enemyHeroIds.includes(2), false);
    assert.equal(track.inferred.candidates.enemies.some(member => member.id === 1 || member.id === 2), false);
    if (offset === 20000) { assert.deepEqual(track.inferred.enemyHeroIds, [101]); assert.equal(track.inferred.complete, false); }
  }
  assert.deepEqual(track.inferred.enemyHeroIds, [3, 101]); assert.equal(track.inferred.complete, true);
  assert.equal(track.inferred.allyHeroId, 26);
});

test('partial strict roster cannot disprove original members merely by missing their IDs', () => {
  let track = confirmed();
  track = updateLaneTrack(track, withHeroes(START + 15000, [marker(42, .8, .8), marker(101, .84, .77), marker(3, .89, .78), marker(26, .75, .8)], { enemyHeroIds: [3, 101], alliedHeroIds: [42, 26], requireConfirmedRoster: true }));
  assert.deepEqual(track.inferred.enemyHeroIds, [2, 101]); assert.equal(track.inferred.allyHeroId, 26);
  assert.equal(track.records.some(record => record.id === 2 && record.team === 'enemy'), true);
  assert.equal(track.inferred.members.enemies.find(member => member.id === 2).visibleNow, false);
});

test('complete strict roster invalidates historical membership on a corrected side', () => {
  let track = confirmed();
  track = updateLaneTrack(track, withHeroes(START + 15000, [marker(42, .8, .8), marker(101, .84, .77), marker(3, .89, .78), marker(2, .75, .8)], { enemyHeroIds: [3, 101, 4, 11, 28], alliedHeroIds: [42, 2, 17, 30, 8], requireConfirmedRoster: true }));
  assert.deepEqual(track.inferred.enemyHeroIds, [101]); assert.equal(track.inferred.allyHeroId, null);
  assert.equal(track.records.some(record => record.id === 2 && record.team === 'enemy'), false);
  assert.equal(track.records.some(record => record.id === 26), false);
  assert.equal(track.inferred.candidates.allies.find(member => member.id === 2)?.confirmed, false);
});

test('a partial strict side conflict abstains without erasing historical evidence', () => {
  let track = confirmed();
  track = updateLaneTrack(track, withHeroes(START + 15000, [marker(42, .8, .8), marker(101, .84, .77), marker(2, .75, .8)], { enemyHeroIds: [101], alliedHeroIds: [42, 2], requireConfirmedRoster: true }));
  assert.deepEqual(track.confirmed.enemyHeroIds, [2, 101]);
  assert.equal(track.records.some(record => record.id === 2 && record.team === 'enemy'), true);
  assert.deepEqual(track.inferred.enemyHeroIds, []); assert.equal(track.inferred.status, 'unknown');
});

test('three enemies, duplicates, illusions and unknown nearby identities cannot add evidence', () => {
  for (const additions of [[marker(1, .83, .86)], [marker(2, .85, .78)], [marker(999, .83, .86)], [marker(1, .83, .86, { isIllusion: true })]]) {
    const input = frame(START); input.vision.minimap.heroes.push(...additions);
    const track = updateLaneTrack(null, input); assert.equal(track.candidate, null); assert.deepEqual(track.inferred.enemyHeroIds, []);
  }
});

test('independent partial sightings identify two enemies and the pulling companion', () => {
  let track = null;
  const sequence = [
    [0, [2, 26]], [5000, [101]], [10000, [2, 26]],
    [15000, [101]], [20000, [2]], [25000, [101, 26]],
  ];
  for (const [offset, ids] of sequence) {
    track = updateLaneTrack(track, withHeroes(START + offset, [marker(42, .8, .8), ...ids.map((id, i) => marker(id, .82 + i * .04, .78))]));
  }
  assert.deepEqual(track.inferred.enemyHeroIds, [2, 101]); assert.equal(track.inferred.allyHeroId, 26);
  assert.equal(track.inferred.complete, true); assert.equal(track.inferred.status, 'retained');
  assert.equal(track.inferred.members.enemies.find(member => member.id === 2).visibleNow, false);
  assert.equal(track.inferred.members.ally.observations, 3);
});

test('support can be inferred independently while enemies are in fog', () => {
  let track = null;
  for (const offset of [0, 5000, 10000]) track = updateLaneTrack(track, withHeroes(START + offset, [marker(42, .8, .8), marker(26, .75, .8)]));
  assert.equal(track.inferred.allyHeroId, 26); assert.deepEqual(track.inferred.enemyHeroIds, []);
  assert.equal(track.inferred.complete, false); assert.equal(track.inferred.members.ally.status, 'confirmed');
});

test('equally persistent allied candidates remain ambiguous without role guesses', () => {
  let track = null;
  for (const offset of [0, 5000, 10000]) {
    const input = frame(START + offset); input.vision.minimap.heroes.push(marker(17, .83, .86));
    track = updateLaneTrack(track, input);
  }
  assert.deepEqual(track.inferred.enemyHeroIds, [2, 101]); assert.equal(track.inferred.allyHeroId, null);
  assert.equal(track.inferred.candidates.allies.length, 2);
  assert.equal(track.inferred.candidates.allies.every(member => !member.confirmed && member.exclusiveObservations === 0), true);
  for (const offset of [15000, 20000, 25000]) track = updateLaneTrack(track, frame(START + offset));
  assert.equal(track.inferred.allyHeroId, 26);
});

test('a roaming ally cannot replace the support during a pull or even short repeated visits', () => {
  let track = confirmed();
  for (const offset of [15000, 20000, 25000]) track = updateLaneTrack(track, withHeroes(START + offset, [marker(42, .8, .8), marker(2, .84, .77), marker(101, .89, .78), marker(17, .75, .8)]));
  assert.equal(track.inferred.allyHeroId, 26); assert.equal(track.inferred.members.ally.visibleNow, false);
  assert.equal(track.inferred.candidates.allies[0].id, 17);
  track = updateLaneTrack(track, frame(START + 30000));
  assert.equal(track.inferred.allyHeroId, 26); assert.equal(track.inferred.members.ally.visibleNow, true);
});

test('unconfirmed observations expire after ninety seconds and cannot be stitched across long gaps', () => {
  let track = null;
  for (const offset of [0, 5000, 100000]) track = updateLaneTrack(track, frame(START + offset));
  assert.equal(track.inferred.status, 'observing'); assert.deepEqual(track.inferred.enemyHeroIds, []);
  assert.equal(track.records.every(record => record.samples.length === 1), true);
});

test('three equally frequent possible opponents are not assigned by ID order', () => {
  let track = null;
  for (const [offset, id] of [[0, 2], [5000, 101], [10000, 1], [15000, 2], [20000, 101], [25000, 1], [30000, 2], [35000, 101], [40000, 1]]) track = updateLaneTrack(track, withHeroes(START + offset, [marker(42, .8, .8), marker(id, .84, .77)]));
  // First members are confirmed from their own evidence. An equally frequent
  // third visitor cannot displace either established opponent.
  assert.deepEqual(track.inferred.enemyHeroIds, [2, 101]);
  assert.equal(track.inferred.candidates.enemies.find(member => member.id === 1).confirmed, false);
});

test('a short trip to the opposite lane does not replace the original lineup', () => {
  let track = confirmed();
  for (const offset of [15000, 20000, 25000]) track = updateLaneTrack(track, withHeroes(START + offset, [marker(42, .2, .2), marker(1, .24, .23)]));
  assert.equal(track.inferred.lane, 'bottom'); assert.deepEqual(track.inferred.enemyHeroIds, [2, 101]);
});

test('samples and frames remain bounded under faster capture cadence', () => {
  let track = null;
  for (let offset = 0; offset < 100000; offset += 250) track = updateLaneTrack(track, frame(START + offset));
  assert.equal(track.inferred.complete, true);
  assert.ok(track.frames.length <= 128); assert.ok(track.records.every(record => record.samples.length <= 128));
});

test('map side reverses safe lane for Dire; jungle/base grouping and default middle are rejected', () => {
  let track = null;
  for (const offset of [0, 5000, 10000]) {
    const now = START + offset;
    track = updateLaneTrack(track, withHeroes(now, [marker(42, .2, .2), marker(2, .24, .23), marker(101, .27, .22), marker(26, .15, .2)], { playerTeam: 'dire', state: { ...frame(now).state, team: 'dire' } }));
  }
  assert.equal(track.inferred.status, 'confirmed'); assert.equal(track.inferred.lane, 'top'); assert.equal(track.inferred.side, 'safe');
  for (const [x, y] of [[.45, .7], [.5, .5], [.1, .9], [.9, .1]]) {
    const result = updateLaneTrack(null, withHeroes(START, [marker(42, x, y), marker(2, x + .03, y)]));
    assert.equal(result.candidate, null); assert.deepEqual(result.inferred.enemyHeroIds, []);
  }
});

test('mid lane requires explicit allowMid and a stable actual nearby lineup', () => {
  let track = null;
  for (const offset of [0, 5000, 10000]) track = updateLaneTrack(track, withHeroes(START + offset, [marker(42, .5, .5), marker(2, .53, .5)], { allowMid: true }));
  assert.equal(track.inferred.status, 'confirmed'); assert.equal(track.inferred.lane, 'mid');
});

test('different match IDs, local zero ID transition and clock rewind clear inferred lineup', () => {
  for (const stateChange of [{ matchId: '101' }, { gameTime: 20 }]) {
    const track = updateLaneTrack(confirmed(), frame(START + 15000, { state: { ...frame(START + 15000).state, ...stateChange } }));
    assert.equal(track.inferred.status, 'observing'); assert.equal(track.confirmed, null); assert.equal(track.candidate.frameCount, 1);
  }
  let track = confirmed({ state: { ...frame(START).state, matchId: '0' } });
  // A fresh match state replaces a local lobby's special zero ID as well.
  track = updateLaneTrack(track, frame(START + 15000));
  assert.equal(track.confirmed, null); assert.deepEqual(track.inferred.enemyHeroIds, []);
});

test('lane inference stops after ten minutes, and updates do not mutate previous state', () => {
  const track = confirmed(); const before = JSON.stringify(track);
  const result = updateLaneTrack(track, frame(START + 15000, { state: { ...frame(START + 15000).state, gameTime: 601 } }));
  assert.equal(result.inferred.status, 'retained'); assert.match(result.inferred.reason, /до 10:00/); assert.equal(JSON.stringify(track), before);
  const first = updateLaneTrack(null, frame(START)); const original = JSON.stringify(first);
  updateLaneTrack(first, frame(START + 5000)); assert.equal(JSON.stringify(first), original);
});

function screenScene(now,patch={}){
  const input=sceneFrame(now);
  input.screenPlayer={heroId:42,team:'radiant',confirmed:true,observedAt:now,source:'selected_hud'};
  input.vision.scene.heroes=input.vision.scene.heroes.map(hero=>({...hero,team:hero.id===42||hero.id===26?'ally':'enemy',healthColor:hero.id===42||hero.id===26?'ally':'enemy'}));
  input.state={};return {...input,...patch};
}

test('UI refreshes preserve the actual waiting reason until the next captured frame',()=>{
  const sample=screenScene(START);sample.vision.scene={usable:false,heroes:[]};sample.vision.minimap={heroes:[]};
  const track=updateLaneTrack(null,sample);assert.match(track.inferred.reason,/значок Wraith King/);
  const repeated=updateLaneTrack(track,{...sample,now:START+1000});
  assert.equal(repeated.inferred.reason,track.inferred.reason);assert.equal(repeated.records.length,0);
});
test('selected HUD proof confirms current nearby WK, Lion, Axe and Zeus without GSI',()=>{
  let track=null;for(const offset of[0,5000,10000])track=updateLaneTrack(track,screenScene(START+offset));
  assert.equal(track.inferred.complete,true);assert.equal(track.inferred.allyHeroId,26);assert.deepEqual(track.inferred.enemyHeroIds,[2,22]);
  assert.equal(track.inferred.source,'screen_current');assert.match(track.inferred.reason,/исходный состав линии не подтверждён/);
  assert.equal(track.matchId,null);assert.equal(track.lastGameTime,null);
  assert.equal(Object.hasOwn(track.inferred,'gameTime'),false);assert.equal(Object.hasOwn(track.inferred,'networth'),false);
});
test('selected HUD proof can show current nearby heroes after ten minutes, during pause and with stale GSI',()=>{
  for(const patch of[{gameTime:1300},{gameTime:150,isPaused:true},{gameTime:150,receivedAt:START-16000}]){
    let track=null;
    for(const offset of[0,5000,10000]){const now=START+offset;track=updateLaneTrack(track,screenScene(now,{state:{...frame(now).state,...patch}}));}
    assert.equal(track.inferred.complete,true);assert.equal(track.inferred.source,'screen_current');
  }
});
test('screen-selected proof does not bypass wrong hero, stale evidence, team conflicts or cached single portraits',()=>{
  const patches=[{screenPlayer:{heroId:26,team:'radiant',confirmed:true,observedAt:START,source:'selected_hud'}},{screenPlayer:{heroId:42,team:'radiant',confirmed:true,observedAt:START-9000,source:'selected_hud'}},{state:{heroId:26,receivedAt:START}},{state:{isSpectator:true,receivedAt:START}},{state:{heroId:42,team:'dire',receivedAt:START}},{enemyHeroIds:[],alliedHeroIds:[]},{requireConfirmedRoster:false}];
  for(const patch of patches){const result=updateLaneTrack(null,screenScene(START,patch));assert.equal(result.inferred.complete,false);assert.equal(result.records.length,0);}
  const wrongHead=screenScene(START);wrongHead.vision.scene.heroes[0].healthColor='enemy';wrongHead.vision.scene.heroes[0].team='enemy';
  assert.equal(updateLaneTrack(null,wrongHead).candidate,null);
});
test('losing selected HUD proof clears current screen group instead of retaining remote camera participants',()=>{
  let track=null;for(const offset of[0,5000,10000])track=updateLaneTrack(track,screenScene(START+offset));
  const missing=screenScene(START+15000);delete missing.screenPlayer;
  const cleared=updateLaneTrack(track,missing);assert.equal(cleared.confirmed,null);assert.equal(cleared.inferred.complete,false);assert.equal(cleared.records.length,0);
});
test('a complete changed confirmed team roster clears current participants before gathering new evidence',()=>{
  let track=null;for(const offset of[0,5000,10000])track=updateLaneTrack(track,screenScene(START+offset));
  assert.equal(track.inferred.complete,true);
  const changed=screenScene(START+15000,{enemyHeroIds:[2,22,43,18,9],alliedHeroIds:[42,26,36,6,37]});
  const result=updateLaneTrack(track,changed);assert.equal(result.confirmed,null);assert.equal(result.inferred.complete,false);
  assert.equal(result.frames.length,1);assert.equal(result.records.every(record=>record.samples.length===1),true);
});
function qualifiedScene(now){
  const input=screenScene(now);
  input.vision.scene.heroes[0]={...input.vision.scene.heroes[0],confidence:.8782,qualifiedBySelectedHud:true,type:'visible_scene_head',source:'visible_scene_head'};
  return input;
}
test('WK head qualified by fresh selected HUD confirms scene while retaining its actual similarity',()=>{
  let track=null;
  for(const offset of[0,5000,10000]){
    track=updateLaneTrack(track,qualifiedScene(START+offset));
    if(offset<10000)assert.equal(track.inferred.complete,false);
  }
  assert.equal(track.inferred.complete,true);assert.deepEqual(track.inferred.enemyHeroIds,[2,22]);assert.equal(track.inferred.allyHeroId,26);
  assert.equal(track.inferred.confidence,.8782);assert.equal(track.confirmed.minConfidence,.8782);
  assert.equal(track.inferred.evidence.every(e=>e.minSimilarity===.8782),true);
});
test('qualified WK scene heads cannot bypass missing proof, false qualification, marker type, wrong team or strict other heroes',()=>{
  const invalid=[
    input=>{delete input.screenPlayer;},
    input=>{input.screenPlayer.observedAt=START-9000;},
    input=>{input.vision.scene.heroes[0].qualifiedBySelectedHud=false;},
    input=>{delete input.vision.scene.heroes[0].type;delete input.vision.scene.heroes[0].source;},
    input=>{input.vision.scene.heroes[0].confidence=.859;},
    input=>{input.vision.scene.heroes[0].team='enemy';input.vision.scene.heroes[0].healthColor='enemy';},
  ];
  for(const mutate of invalid){const input=qualifiedScene(START);mutate(input);const result=updateLaneTrack(null,input);assert.equal(result.inferred.complete,false);assert.equal(result.candidate,null);}
  const weakAlly=qualifiedScene(START);weakAlly.vision.scene.heroes[1].confidence=.89;
  const partial=updateLaneTrack(null,weakAlly);assert.equal(partial.inferred.allyHeroId,null);assert.equal(partial.records.some(record=>record.id===26),false);assert.equal(partial.candidate.allyHeroId,null);
});
test('selected HUD qualification never lowers the minimum similarity for a minimap WK',()=>{
  let track=null;
  for(const offset of[0,5000,10000]){
    const now=START+offset,input=qualifiedScene(now);
    delete input.vision.scene;
    input.vision.minimap.heroes=[marker(42,.8,.8,{confidence:.8782,qualifiedBySelectedHud:true,type:'visible_scene_head',source:'visible_scene_head',team:'self'}),marker(26,.75,.8),marker(2,.84,.77),marker(22,.89,.78)];
    track=updateLaneTrack(track,input);
  }
  assert.equal(track.confirmed,null);assert.equal(track.candidate,null);assert.equal(track.records.length,0);
});
test('selected WK visible alone produces an accurate reason without adding participant evidence',()=>{
  let track=null;
  for(const offset of[0,5000,10000]){
    const input=qualifiedScene(START+offset);input.vision.scene.heroes=input.vision.scene.heroes.filter(hero=>hero.id===42);
    track=updateLaneTrack(track,input);
    assert.match(track.inferred.reason,/Wraith King виден; жду союзника и соперников/);
    assert.equal(track.records.length,0);assert.equal(track.frames.length,0);assert.equal(track.confirmed,null);
  }
});
test('selected scene confirms an ally independently then fills opponents through separate later sightings',()=>{
  let track=null;
  const sequence=[[0,[26]],[5000,[26]],[10000,[26]],[15000,[2]],[20000,[22]],[25000,[2]],[30000,[22]],[35000,[2]],[40000,[22]]];
  for(const[offset,ids]of sequence){
    const input=qualifiedScene(START+offset);input.vision.scene.heroes=input.vision.scene.heroes.filter(hero=>hero.id===42||ids.includes(hero.id));
    track=updateLaneTrack(track,input);
    if(offset===10000){assert.equal(track.inferred.allyHeroId,26);assert.deepEqual(track.inferred.enemyHeroIds,[]);assert.equal(track.inferred.complete,false);}
    if(offset===35000){assert.deepEqual(track.inferred.enemyHeroIds,[2]);assert.equal(track.inferred.allyHeroId,26);assert.equal(track.inferred.complete,false);}
  }
  assert.equal(track.inferred.complete,true);assert.equal(track.inferred.allyHeroId,26);assert.deepEqual(track.inferred.enemyHeroIds,[2,22]);
  assert.equal(track.inferred.members.ally.visibleNow,false);assert.equal(track.inferred.members.enemies.find(hero=>hero.id===22).visibleNow,true);
});
test('an own-only scene preserves partial candidates and confirmed history without renewing them',()=>{
  let track=updateLaneTrack(null,qualifiedScene(START));
  assert.equal(track.inferred.candidates.allies.length,1);
  const onlySelf=qualifiedScene(START+5000);onlySelf.vision.scene.heroes=onlySelf.vision.scene.heroes.filter(hero=>hero.id===42);
  track=updateLaneTrack(track,onlySelf);assert.equal(track.inferred.candidates.allies.length,1);assert.equal(track.frames.length,1);
  for(const offset of[10000,15000])track=updateLaneTrack(track,qualifiedScene(START+offset));
  assert.equal(track.inferred.complete,true);
  const savedSeen=track.inferred.members.ally.lastSeenAt,empty=qualifiedScene(START+20000);empty.vision.scene.heroes=empty.vision.scene.heroes.filter(hero=>hero.id===42);
  track=updateLaneTrack(track,empty);assert.equal(track.inferred.complete,true);assert.equal(track.inferred.members.ally.lastSeenAt,savedSeen);
  assert.equal(track.inferred.members.ally.visibleNow,false);assert.match(track.inferred.reason,/Wraith King виден; жду/);
});
test('without selected HUD proof scene still requires own WK plus ally and enemy to establish evidence',()=>{
  for(const ids of[[42],[42,26],[42,2],[42,2,22]]){
    let track=null;
    for(const offset of[0,5000,10000]){const input=sceneFrame(START+offset);input.vision.scene.heroes=input.vision.scene.heroes.filter(hero=>ids.includes(hero.id));track=updateLaneTrack(track,input);}
    assert.equal(track.confirmed,null);assert.equal(track.records.length,0);assert.equal(track.frames.length,0);
  }
});
