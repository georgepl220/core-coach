'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeGsi } = require('../src/core.cjs');
const { overlayLifecycle, MAX_GSI_AGE_MS } = require('../src/overlay-lifecycle.cjs');

const NOW = 1700000000000;
const PICK = 'DOTA_GAMERULES_STATE_HERO_SELECTION';
const PRE_GAME = 'DOTA_GAMERULES_STATE_PRE_GAME';
const GAME = 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS';
const state = (gameState = PICK, patch = {}) => ({
  gameState, receivedAt: NOW, team: 'radiant', isSpectator: false,
  ...patch,
});
const own = (gameState = GAME, patch = {}) => state(gameState, {
  heroId: 42, heroName: 'npc_dota_hero_skeleton_king', status: 'live',
  ...patch,
});
const policy = (gsi = state(), extra = {}) => overlayLifecycle({
  state: gsi, settings: { overlayVisible: true }, now: NOW, ...extra,
});

test('startup is hidden even when automatic overlays are enabled', () => {
  assert.deepEqual(policy(null), {
    draftVisible: false, coachVisible: false, activeSurface: null, phase: 'inactive',
  });
  assert.equal(overlayLifecycle().activeSurface, null);
});

test('a fresh pick starts the separate draft overlay before the own hero exists', () => {
  const packet = normalizeGsi({ map: { game_state: PICK }, player: { activity: 'playing' }, hero: {} });
  assert.deepEqual(policy({ ...packet, receivedAt: NOW }), {
    draftVisible: true, coachVisible: false, activeSurface: 'draft', phase: 'pick',
  });
  assert.equal(policy(state(PICK, { team: null, heroId: null })).draftVisible, true);
});

test('only hero selection shows the draft desktop window; previews never activate it', () => {
  const preferences = { overlayVisible: true, draftMode: 'preview' };
  for (const gameState of [
    'DOTA_GAMERULES_STATE_STRATEGY_TIME', 'DOTA_GAMERULES_STATE_TEAM_SHOWCASE',
    'DOTA_GAMERULES_STATE_WAIT_FOR_PLAYERS_TO_LOAD', 'DOTA_GAMERULES_STATE_INIT',
    'DOTA_GAMERULES_STATE_CUSTOM_GAME_SETUP', 'DOTA_GAMERULES_STATE_POST_GAME',
    'DOTA_GAMERULES_STATE_DISCONNECT', null, 'unexpected',
  ]) {
    assert.deepEqual(policy(own(gameState), { settings: preferences }), {
      draftVisible: false, coachVisible: false, activeSurface: null, phase: 'inactive',
    });
  }
  assert.equal(policy(null, { settings: preferences }).activeSurface, null);
  assert.equal(policy(state(), { settings: preferences }).activeSurface, 'draft');
});

test('coach starts on the map in pregame and stays for a running paused or unpaused game', () => {
  for (const gameState of [PRE_GAME, GAME]) {
    for (const isPaused of [false, true]) {
      assert.deepEqual(policy(own(gameState, { isPaused })), {
        draftVisible: false, coachVisible: true, activeSurface: 'coach', phase: 'game',
      });
    }
  }
});

test('unsupported own heroes and selected other units keep coach eligible; unknown own identity does not', () => {
  assert.equal(policy(own(GAME, { heroId: 120, heroName: 'npc_dota_hero_pangolier', status: 'wrong_hero' })).coachVisible, true);
  assert.equal(policy(own(GAME, { heroId: null, heroName: 'npc_dota_hero_new_hero', status: 'wrong_hero' })).coachVisible, true);
  assert.equal(policy(own(GAME, { selectedOtherUnit: true })).coachVisible, true);
  assert.equal(policy(own(GAME, { heroId: null, heroName: 'npc_dota_creep_goodguys_melee', selectedOtherUnit: true, status: 'wrong_hero' })).coachVisible, true);
  for (const patch of [
    { heroId: null, heroName: null, status: 'waiting' },
    { team: null }, { team: 'spectator' },
    { heroId: null, heroName: 'npc_dota_creep_goodguys_melee' },
    { heroId: 0, heroName: null }, { heroId: '42', heroName: null },
  ]) assert.equal(policy(own(GAME, patch)).coachVisible, false);
});

test('spectator flag or status keeps both windows hidden during pick and play', () => {
  for (const gameState of [PICK, PRE_GAME, GAME]) {
    for (const patch of [{ isSpectator: true }, { status: 'spectator' }]) {
      assert.equal(policy(own(gameState, patch)).activeSurface, null);
    }
  }
});

test('freshness includes its boundary and rejects missing stale and any future packet', () => {
  for (const gameState of [PICK, PRE_GAME, GAME]) {
    const selected = gameState === PICK ? 'draft' : 'coach';
    for (const age of [0, MAX_GSI_AGE_MS - 1, MAX_GSI_AGE_MS]) {
      assert.equal(policy(own(gameState, { receivedAt: NOW - age })).activeSurface, selected);
    }
    for (const receivedAt of [NOW - MAX_GSI_AGE_MS - 1, NOW + 1, NaN, Infinity, null, undefined, String(NOW)]) {
      assert.equal(policy(own(gameState, { receivedAt })).activeSurface, null);
    }
    assert.equal(policy(own(gameState), { now: NaN }).activeSurface, null);
  }
});

test('a stale gap hides the windows while preserving the phase for manual-hide state', () => {
  for (const [gameState, phase] of [[PICK, 'pick'], [PRE_GAME, 'game'], [GAME, 'game']]) {
    const fresh = policy(own(gameState)), stale = policy(own(gameState, { receivedAt: NOW - 20000 }));
    assert.equal(fresh.phase, phase);
    assert.equal(stale.phase, phase);
    assert.equal(stale.activeSurface, null);
  }
});

test('master enable and per-phase manual hide never reveal an ineligible window', () => {
  for (const gameState of [PICK, PRE_GAME, GAME]) {
    for (const overlayVisible of [false, undefined, null, 'true', 1]) {
      const result = policy(own(gameState), { settings: { overlayVisible } });
      assert.equal(result.draftVisible, false); assert.equal(result.coachVisible, false);
      assert.equal(result.activeSurface, gameState === PICK ? 'draft' : 'coach');
    }
  }
  assert.equal(policy(state(), { manualHidden: { draft: true } }).draftVisible, false);
  assert.equal(policy(state(), { manualHidden: { draft: true } }).activeSurface, 'draft');
  assert.equal(policy(own(), { manualHidden: { coach: true } }).coachVisible, false);
  assert.equal(policy(own(), { manualHidden: { coach: true } }).activeSurface, 'coach');
  assert.equal(policy(state(), { manualHidden: { coach: true } }).activeSurface, 'draft');
  assert.equal(policy(own(), { manualHidden: { draft: true } }).activeSurface, 'coach');
  assert.equal(policy(own('DOTA_GAMERULES_STATE_STRATEGY_TIME'), { manualHidden: { draft: false, coach: false } }).activeSurface, null);
});

test('only explicit demo can preview coach away from a real match and respects hide/enable', () => {
  assert.equal(policy(null, { demo: true }).activeSurface, 'coach');
  assert.equal(policy(null, { settings: { overlayVisible: true, demo: true, draftMode: 'preview' } }).activeSurface, 'coach');
  assert.equal(policy(state(), { demo: true }).activeSurface, 'coach');
  assert.equal(policy(null, { demo: 'true' }).activeSurface, null);
  assert.equal(policy(null, { demo: true, settings: { overlayVisible: false } }).coachVisible, false);
  assert.equal(policy(null, { demo: true, manualHidden: { coach: true } }).coachVisible, false);
});
