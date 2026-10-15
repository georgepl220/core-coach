'use strict';

// Provider arguments are independent of UI selection. A request always names
// one hero so an asynchronous update cannot replace another hero's cache.
const DEFINITIONS = {
  42: { id: 42, slug: 'wraith-king', displayName: 'Wraith King', abilityPrefix: 'skeleton_king_' },
  8: { id: 8, slug: 'juggernaut', displayName: 'Juggernaut', abilityPrefix: 'juggernaut_' },
  18: { id: 18, slug: 'sven', displayName: 'Sven', abilityPrefix: 'sven_' },
  44: { id: 44, slug: 'phantom-assassin', displayName: 'Phantom Assassin', abilityPrefix: 'phantom_assassin_' },
  48: { id: 48, slug: 'luna', displayName: 'Luna', abilityPrefix: 'luna_' },
};
function providerHero(options = {}) {
  const id = options.heroId ?? options.profile?.id ?? options.profile?.heroId ?? 42;
  if (!Number.isInteger(id) || !DEFINITIONS[id]) throw new Error('Unsupported carry hero for this provider');
  return DEFINITIONS[id];
}
function parseProviderArgs(args) {
  const rest = [...args];
  let heroId = 42;
  const index = rest.indexOf('--hero');
  if (index !== -1) {
    const value = rest[index + 1];
    if (!/^\d+$/.test(value || '') || rest.indexOf('--hero', index + 1) !== -1) throw new Error('Use --hero with one supported numeric carry hero ID');
    heroId = Number(value);
    providerHero({ heroId });
    rest.splice(index, 2);
  }
  return { args: rest, heroId };
}
const heroSourceUrls = hero => ({
  matches: `https://api.opendota.com/api/heroes/${hero.id}/matches`,
  popularity: `https://api.opendota.com/api/heroes/${hero.id}/itemPopularity`,
  valve: `https://www.dota2.com/datafeed/herodata?language=english&hero_id=${hero.id}`,
  stratz: `https://stratz.com/heroes/${hero.id}?positionIds=POSITION_1`,
  d2pt: `https://dota2protracker.com/hero/${encodeURIComponent(hero.displayName)}`,
});
module.exports = { providerHero, heroSourceUrls, parseProviderArgs, DEFINITIONS };
