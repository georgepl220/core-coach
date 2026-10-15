'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { analyzeRegions } = require('../src/vision-regions.cjs');
const { newRosterCache, updateRosterCache } = require('../src/roster-cache.cjs');

// Execute the actual main-process tick, with just its external APIs stubbed.
// Testing the worker alone missed the failure on the next live capture tick.
const source = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
const tickSource = source.slice(source.indexOf('async function captureTick() {'), source.indexOf('\nfunction createCaptureHost(){'));
function fixture(vision, rosterCache = newRosterCache()) {
  const updates = [], previews = [];
  const context = {
    SMOKE_NONCE:null,
    overlayWindow:{isVisible:()=>true},draftWindow:{isVisible:()=>false},
    lastVision: vision, settings: { captureScope: 'game', monitorIndex: 0, overlayVisible: true, playerTeam: 'radiant' },
    currentGsi: { team: 'radiant' },laneTrack:{inferred:{}}, rosterCache, imported: false, controlPage: 'vision', controlWindow: { isVisible: () => true },
    captureStatus: null, captureError: null,
    capturePolicy: () => ({ enabled: true, intervalMs: 5000 }),
    screen: { getAllDisplays: () => [{ id: 7 }], getPrimaryDisplay: () => ({ id: 7 }) },
    captureHost: { update: async value => updates.push(value), requestPreview: () => previews.push(true) },
  };
  vm.createContext(context); vm.runInContext(tickSource, context);
  return { context, updates, previews, tick: () => context.captureTick() };
}
const slots = Array.from({ length: 10 }, (_, index) => ({ index, hero: { id: index + 1, confidence: index < 8 ? .95 : .85 } }));

test('next live tick accepts the ROI worker roster object and continues configuring capture', async () => {
  const packet = { timestamp: 200000, originalSize: { width: 1280, height: 720 }, regions: [{ kind: 'minimap', rect: { x: 0, y: 560, width: 160, height: 160 }, width: 80, height: 80, data: new Uint8Array(80 * 80 * 4).buffer }] };
  const result = analyzeRegions(packet, {}, { portraits: [], minimap: [] }, { roster: { slots, observedAt: 195000, originalSize: packet.originalSize } });
  assert.equal(Array.isArray(result.state.roster), false);
  const fixtureTick = fixture(result);
  await fixtureTick.tick(); await fixtureTick.tick();
  assert.equal(fixtureTick.context.captureError, null);
  assert.equal(fixtureTick.updates.length, 2);
  assert.equal(fixtureTick.updates[1].rosterConfirmed, false);
  assert.equal(fixtureTick.updates[1].calibration.selfHeroId, 42);
  assert.equal(fixtureTick.previews.length, 2);
});

test('full screenshot roster, missing roster and malformed roster cannot stop capture configuration', async () => {
  for (const vision of [{ state: { roster: slots } }, { roster: { slots } }, null, { state: { roster: {} } }, { state: { roster: 'bad' } }]) {
    const fixtureTick = fixture(vision); await fixtureTick.tick();
    assert.equal(fixtureTick.context.captureError, null);
    assert.equal(fixtureTick.updates.length, 1);
    assert.equal(fixtureTick.updates[0].rosterConfirmed, false);
  }
});

test('portrait capture slows only after separate fresh frames confirm team identities', async () => {
  const now = Date.now();
  const state = { isWraithKing: true, team: 'radiant', receivedAt: now, gameTime: 100, matchId: 'warmup' };
  const hudSlots = [42, 26, 36, 6, 37, 43, 2, 22, 18, 20].map((id, index) => ({ index, team: index < 5 ? 'radiant' : 'dire', hero: { id, confidence: .95 } }));
  const vision = { capturedAt: now, roster: { slots: hudSlots }, diagnostics: { rosterRefreshed: true } };
  let cache = updateRosterCache(newRosterCache(), { state, vision, now });
  const f = fixture(vision, cache);
  await f.tick();
  assert.equal(f.updates.at(-1).rosterConfirmed, false);

  // Republishing the same capture cannot independently confirm its identities.
  cache = updateRosterCache(cache, { state, vision, now: now + 1000 });
  f.context.rosterCache = cache;
  await f.tick();
  assert.equal(f.updates.at(-1).rosterConfirmed, false);

  const next = now + 5000;
  const nextVision = { ...vision, capturedAt: next };
  cache = updateRosterCache(cache, { state: { ...state, receivedAt: next }, vision: nextVision, now: next });
  assert.equal(cache.teams.radiant.length, 5);
  assert.equal(cache.teams.dire.length, 5);
  f.context.rosterCache = cache;
  f.context.lastVision = nextVision;
  await f.tick();
  assert.equal(f.updates.at(-1).rosterConfirmed, true);
});

test('scene scan runs only for fresh own WK during laning and stops after lineup confirmation',async()=>{
  const f=fixture(null);f.context.currentGsi={isWraithKing:true,team:'radiant',gameTime:519,receivedAt:Date.now()};
  await f.tick();assert.equal(f.updates.at(-1).calibration.sceneEnabled,true);
  f.context.laneTrack.inferred.complete=true;await f.tick();assert.equal(f.updates.at(-1).calibration.sceneEnabled,false);
  f.context.laneTrack.inferred.complete=false;
  for(const patch of[{gameTime:610},{isPaused:true},{isWraithKing:false},{receivedAt:Date.now()-16000}]){
    f.context.currentGsi={isWraithKing:true,team:'radiant',gameTime:519,receivedAt:Date.now(),...patch};
    await f.tick();assert.equal(f.updates.at(-1).calibration.sceneEnabled,false);
  }
});

test('game screen mode bootstraps from a confirmed selected HUD independently of GSI pause and match clock', async () => {
  const f = fixture(null);
  f.context.settings.autoLane = true;
  f.context.currentGsi = null;
  await f.tick();
  assert.equal(f.updates.at(-1).calibration.sceneEnabled, false, 'first frame checks selection before scene scanning');
  f.context.lastVision = { player: { heroId: 42, confirmed: true, team: 'dire', source: 'selected_hud', observedAt: Date.now() } };
  f.context.laneTrack.inferred.complete = true;
  for (const state of [null, { isWraithKing: true, team: 'radiant', isPaused: true }, { isWraithKing: true, gameTime: 1800 }, { isWraithKing: true, receivedAt: Date.now() - 16000 }]) {
    f.context.currentGsi = state;
    await f.tick();
    assert.equal(f.updates.at(-1).calibration.sceneEnabled, true);
    assert.equal(f.updates.at(-1).calibration.playerTeam, 'dire', 'selected HUD team is passed to scene matching');
  }
  for (const player of [null, { confirmed: false }, { heroId: 42 }]) {
    f.context.lastVision = { player };
    await f.tick();
    assert.equal(f.updates.at(-1).calibration.sceneEnabled, false, 'unconfirmed selection cannot start scene matching');
  }
});

test('game screen mode keeps sampling all portraits until ten unique team identities are cached', async () => {
  const cache = newRosterCache();
  cache.teams = { radiant: [42, 26, 36, 6, 37], dire: [43, 2, 22] };
  const f = fixture(null, cache);
  f.context.settings.autoLane = true;
  await f.tick();
  assert.equal(f.updates.at(-1).rosterConfirmed, false, 'eight cached identities cannot defer the remaining two');
  f.context.rosterCache.teams.dire = [43, 2, 22, 18, 42];
  await f.tick();
  assert.equal(f.updates.at(-1).rosterConfirmed, false, 'a duplicated identity does not count as a tenth hero');
  f.context.rosterCache.teams.dire = [43, 2, 22, 18, 20];
  await f.tick();
  assert.equal(f.updates.at(-1).rosterConfirmed, true);
});

test('selected WK title plus fresh own GSI enables scene even when the top WK portrait is missing', async () => {
  const now = Date.now();
  const f = fixture({ player: { heroId: 42, confidence: .972, confirmed: false, team: null, source: 'selected_hud', observedAt: now }, roster: { slots: [] } });
  f.context.settings.autoLane = true;
  const ownState = { heroId: 42, isWraithKing: true, team: 'radiant', receivedAt: now, gameTime: 519 };
  for (const patch of [{}, { isPaused: true }, { gameTime: 1800 }]) {
    f.context.currentGsi = { ...ownState, ...patch };
    await f.tick();
    assert.equal(f.updates.at(-1).calibration.sceneEnabled, true, 'verified own GSI supplies team without requiring a top WK portrait');
    assert.equal(f.updates.at(-1).calibration.playerTeam, 'radiant');
  }
  f.context.currentGsi = ownState;
  for (const player of [null, { heroId: 30, confirmed: false }, { heroId: null, confirmed: false }]) {
    f.context.lastVision = { player };
    await f.tick();
    assert.equal(f.updates.at(-1).calibration.sceneEnabled, false, 'GSI alone cannot enable scene without selected WK title');
  }
});

test('an unconfirmed WK title cannot borrow team from invalid, spectator or stale GSI', async () => {
  const now = Date.now();
  const f = fixture({ player: { heroId: 42, confidence: .972, confirmed: false, team: null, source: 'selected_hud', observedAt: now } });
  f.context.settings.autoLane = true;
  const ownState = { heroId: 42, isWraithKing: true, team: 'radiant', receivedAt: now, gameTime: 519 };
  for (const patch of [{ heroId: 30, isWraithKing: false }, { heroId: 30 }, { isWraithKing: false }, { isSpectator: true }, { status: 'spectator' }, { receivedAt: now - 16000 }, { receivedAt: now + 5000 }, { receivedAt: null }, { team: null }, { team: 'unknown' }]) {
    f.context.currentGsi = { ...ownState, ...patch };
    await f.tick();
    assert.equal(f.updates.at(-1).calibration.sceneEnabled, false, JSON.stringify(patch));
  }
  f.context.currentGsi = null;
  await f.tick();
  assert.equal(f.updates.at(-1).calibration.sceneEnabled, false);
});
