'use strict';

const PICK = 'DOTA_GAMERULES_STATE_HERO_SELECTION';
const PLAYING = new Set([
  'DOTA_GAMERULES_STATE_PRE_GAME',
  'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS',
]);
const MAX_GSI_AGE_MS = 15000;

function isFreshPlayerState(state, now) {
  if (!state || state.isSpectator === true || state.status === 'spectator' ||
    !Number.isFinite(now) || !Number.isFinite(state.receivedAt)) return false;
  const age = now - state.receivedAt;
  return age >= 0 && age <= MAX_GSI_AGE_MS;
}

function hasOwnHero(state) {
  const knownHero = Number.isInteger(state?.heroId) && state.heroId > 0 ||
    typeof state?.heroName === 'string' && /^npc_dota_hero_[a-z0-9_]+$/.test(state.heroName);
  // Normalization sets selectedOtherUnit only when there was a parent own
  // hero identity. Selecting a courier/creep must not make the coach flicker.
  return Boolean((knownHero || state?.selectedOtherUnit === true) &&
    (state.team === 'radiant' || state.team === 'dire'));
}

// Phase describes the last reported game state, even when GSI is stale. This
// lets main preserve a manual hide during a short connection gap while hiding
// the actual windows immediately. Only a real phase transition resets it.
function overlayLifecycle({ state, demo = false, settings = {}, now = Date.now(), manualHidden = {} } = {}) {
  const demonstration = demo === true || settings.demo === true;
  const phase = demonstration ? 'game' : state?.gameState === PICK ? 'pick' :
    PLAYING.has(state?.gameState) ? 'game' : 'inactive';
  const enabled = settings.overlayVisible === true;
  const fresh = isFreshPlayerState(state, now);
  const activeSurface = !demonstration && phase === 'pick' && fresh ? 'draft' :
    phase === 'game' && (demonstration || fresh && hasOwnHero(state)) ? 'coach' : null;
  const draftVisible = enabled && activeSurface === 'draft' && manualHidden.draft !== true;
  const coachVisible = enabled && activeSurface === 'coach' && manualHidden.coach !== true;
  return {
    draftVisible,
    coachVisible,
    // Eligibility is independent of user visibility, allowing a hotkey to
    // reopen only the window appropriate to the current game stage.
    activeSurface,
    phase,
  };
}

module.exports = { MAX_GSI_AGE_MS, overlayLifecycle };
