'use strict';

const WK_ID = 42;
const teams = new Set(['radiant', 'dire']);
const finite = value => typeof value === 'number' && Number.isFinite(value);

// A personal GSI packet can supply the team when the selected WK title is
// visible but his top portrait is dimmed. It cannot replace the title proof.
function resolveSelectedPlayer(selected, slots, gsiPlayer, frameTimestamp) {
  const titleProof = selected?.heroId === WK_ID && selected?.source === 'selected_hero_label' && finite(selected?.confidence) && selected.confidence >= 0.94 && selected.confidence <= 1;
  const result = {
    ...(selected && typeof selected === 'object' ? selected : {}),
    heroId: titleProof ? WK_ID : null,
    confidence: finite(selected?.confidence) ? selected.confidence : 0,
    source: 'selected_hud', observedAt: finite(frameTimestamp) ? frameTimestamp : null,
    confirmed: false, team: null, teamSource: null,
    reason: 'Selected Wraith King title is not confirmed',
  };
  if (!titleProof) return result;
  if (!finite(frameTimestamp) || frameTimestamp < 0) return { ...result, reason: 'Selected hero frame time is invalid' };

  const strongSlots = (Array.isArray(slots) ? slots : []).filter(slot => slot?.hero?.id === WK_ID && finite(slot.hero.confidence) && slot.hero.confidence >= 0.90 && slot.hero.confidence <= 1 && teams.has(slot.team));
  const freshGsi = finite(gsiPlayer?.receivedAt) && frameTimestamp - gsiPlayer.receivedAt <= 12000 && gsiPlayer.receivedAt - frameTimestamp <= 1000;
  if (freshGsi) {
    if (gsiPlayer.isSpectator === true || gsiPlayer.status === 'spectator') return { ...result, reason: 'Fresh personal GSI identifies spectator mode' };
    const knownOtherHero = gsiPlayer.status === 'wrong_hero' || Number.isInteger(gsiPlayer.heroId) && gsiPlayer.heroId > 0 && (gsiPlayer.heroId !== WK_ID || gsiPlayer.isWraithKing === false);
    if (knownOtherHero) return { ...result, reason: 'Fresh personal GSI identifies another hero' };
    if (teams.has(gsiPlayer.team) && strongSlots.some(slot => slot.team !== gsiPlayer.team)) return { ...result, reason: 'Selected hero team conflicts between the top HUD and fresh personal GSI' };
  }

  const ownGsi = freshGsi && gsiPlayer.heroId === WK_ID && gsiPlayer.isWraithKing === true && gsiPlayer.isSpectator === false && gsiPlayer.status === 'live' && teams.has(gsiPlayer.team);
  if (strongSlots.length === 1) return { ...result, confirmed: true, team: strongSlots[0].team, teamSource: 'screen_roster', reason: null };
  if (ownGsi) return { ...result, confirmed: true, team: gsiPlayer.team, teamSource: 'gsi', reason: null };
  return { ...result, reason: strongSlots.length > 1 ? 'Selected Wraith King has ambiguous top portraits' : 'Selected Wraith King needs a confirmed top portrait or fresh personal GSI team' };
}

module.exports = { resolveSelectedPlayer };
