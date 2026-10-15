'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveSelectedPlayer } = require('../src/selected-player.cjs');
const now = 200000;
const selected = { heroId: 42, confidence: 0.972, source: 'selected_hero_label', reason: null };
const slot = (team = 'radiant', confidence = 0.97) => ({ team, hero: { id: 42, confidence } });
const gsi = override => ({ heroId: 42, isWraithKing: true, isSpectator: false, status: 'live', team: 'radiant', receivedAt: now - 1000, ...override });

test('selected label and a unique strong top WK portrait confirm screen-only identity', () => {
  const result = resolveSelectedPlayer(selected, [slot()], null, now);
  assert.equal(result.confirmed, true);
  assert.equal(result.heroId, 42);
  assert.equal(result.team, 'radiant');
  assert.equal(result.teamSource, 'screen_roster');
  assert.equal(result.source, 'selected_hud');
  assert.equal(result.observedAt, now);
});

test('real reported weak upper WK portrait can use selected title and fresh personal team', () => {
  for (const slots of [[], [slot('radiant', 0.757)]]) {
    const result = resolveSelectedPlayer(selected, slots, gsi(), now);
    assert.equal(result.confirmed, true);
    assert.equal(result.team, 'radiant');
    assert.equal(result.teamSource, 'gsi');
    assert.equal(result.confidence, 0.972);
  }
  assert.equal(resolveSelectedPlayer(selected, [], gsi({ team: 'dire' }), now).team, 'dire');
});

test('personal GSI alone never manufactures selected-hero title proof', () => {
  for (const proof of [null, {}, { ...selected, heroId: 26 }, { ...selected, confidence: 0.89 }, { ...selected, confidence: NaN }, { ...selected, source: 'roster' }]) {
    const result = resolveSelectedPlayer(proof, [slot()], gsi(), now);
    assert.equal(result.confirmed, false);
    assert.equal(result.heroId, null);
    assert.equal(result.team, null);
  }
});

test('fresh wrong-hero and spectator packets veto even matching upper and lower WK HUD', () => {
  for (const personal of [gsi({ heroId: 26, isWraithKing: false, status: 'wrong_hero' }), gsi({ isSpectator: true }), gsi({ status: 'spectator' }), gsi({ status: 'wrong_hero' }), gsi({ isWraithKing: false })]) {
    const result = resolveSelectedPlayer(selected, [slot()], personal, now);
    assert.equal(result.confirmed, false);
    assert.match(result.reason, /Fresh personal GSI/);
  }
});

test('fresh team conflict with a strong upper WK portrait abstains', () => {
  const result = resolveSelectedPlayer(selected, [slot('dire')], gsi(), now);
  assert.equal(result.confirmed, false);
  assert.equal(result.team, null);
  assert.match(result.reason, /conflicts/);
  assert.equal(resolveSelectedPlayer(selected, [slot('radiant', 0.757)], gsi({ team: 'dire' }), now).confirmed, true);
});

test('freshness bounds prevent stale and future team proofs', () => {
  assert.equal(resolveSelectedPlayer(selected, [], gsi({ receivedAt: now - 12000 }), now).confirmed, true);
  assert.equal(resolveSelectedPlayer(selected, [], gsi({ receivedAt: now + 1000 }), now).confirmed, true);
  for (const receivedAt of [now - 12001, now + 1001, NaN, Infinity, null, '199000']) assert.equal(resolveSelectedPlayer(selected, [], gsi({ receivedAt }), now).confirmed, false, String(receivedAt));
  assert.equal(resolveSelectedPlayer(selected, [slot()], gsi({ receivedAt: now - 12001, status: 'wrong_hero', heroId: 26 }), now).confirmed, true);
});

test('a GSI team fallback requires every explicit personal-player identity field', () => {
  for (const override of [{ heroId: null }, { isWraithKing: undefined }, { isSpectator: undefined }, { status: 'waiting' }, { team: null }, { team: 'unknown' }]) assert.equal(resolveSelectedPlayer(selected, [], gsi(override), now).confirmed, false, JSON.stringify(override));
  assert.equal(resolveSelectedPlayer(selected, [], gsi({ isPaused: true }), now).confirmed, true);
});

test('duplicate upper WK portraits abstain unless independent personal team disambiguates', () => {
  assert.equal(resolveSelectedPlayer(selected, [slot(), slot()], null, now).confirmed, false);
  const sameTeam = resolveSelectedPlayer(selected, [slot(), slot()], gsi(), now);
  assert.equal(sameTeam.confirmed, true);
  assert.equal(sameTeam.teamSource, 'gsi');
  assert.equal(resolveSelectedPlayer(selected, [slot(), slot('dire')], gsi(), now).confirmed, false);
});

test('absent/invalid top slots and invalid frame times do not throw or confirm', () => {
  for (const slots of [null, {}, [{ team: 'unknown', hero: { id: 42, confidence: 1 } }], [{ team: 'radiant', hero: { id: 42, confidence: Infinity } }]]) assert.equal(resolveSelectedPlayer(selected, slots, null, now).confirmed, false);
  for (const timestamp of [null, NaN, Infinity, -1, '200000']) assert.equal(resolveSelectedPlayer(selected, [slot()], gsi(), timestamp).confirmed, false);
});
