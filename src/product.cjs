'use strict';

// Product identity and explicitly implemented profiles live independently of
// the current hero's coaching engine. A registry entry is not a support claim.
const PRODUCT = Object.freeze({
  name: 'Core Coach',
  slug: 'core-coach',
  version: '0.9.7',
  description: 'Личный помощник для игры на керри',
  role: 'carry',
  roleLabel: 'Керри · позиция 1',
  defaultHeroId: 42,
  supportedHeroIds: Object.freeze([42, 8, 18, 44, 48]),
  supportedRoleIds: Object.freeze(['carry']),
  preferredProvider: 'stratz',
  releaseDirectory: 'Core Coach',
  executableFilename: 'Core Coach.exe',
  legacyReleaseDirectory: 'Wraith Coach',
});

const ROLE_PROFILES = Object.freeze({
  carry: Object.freeze({ id: 'carry', name: 'Керри', position: 1, label: 'Керри · позиция 1' }),
});

const HERO_PROFILES = Object.freeze({
  42: Object.freeze({
    id: 42,
    heroId: 42,
    name: 'Wraith King',
    slug: 'wraith-king',
    gameKey: 'npc_dota_hero_skeleton_king',
    supportedRoles: Object.freeze(['carry']),
    dataFile: 'wraith-king.json',
    observedBuildFile: 'd2pt-wraith-king.json',
    stratzBuildFile: 'stratz-wraith-king.json',
    abilityCatalogFile: 'sources/wk-live-abilities.json',
    portraitFile: 'portraits/skeleton_king.png',
    minimapFile: 'minimap/skeleton_king.png',
    personalBuildTemplate: 'personal-build-template.json',
  }),
  ...Object.fromEntries([
    [8, 'Juggernaut', 'juggernaut', 'juggernaut'],
    [18, 'Sven', 'sven', 'sven'],
    [44, 'Phantom Assassin', 'phantom-assassin', 'phantom_assassin'],
    [48, 'Luna', 'luna', 'luna'],
  ].map(([id,name,slug,key])=>[id,Object.freeze({
    id,heroId:id,name,slug,gameKey:`npc_dota_hero_${key}`,
    supportedRoles:Object.freeze(['carry']),dataFile:`${slug}.json`,
    observedBuildFile:`opendota-${slug}.json`,stratzBuildFile:`stratz-${slug}.json`,
    abilityCatalogFile:`sources/${slug}-live-abilities.json`,
    portraitFile:`portraits/${key}.png`,minimapFile:`minimap/${key}.png`,
    personalBuildTemplate:`personal-build-template-${id}.json`,
  })])),
});

function getHeroProfile(heroId) {
  return HERO_PROFILES[Number(heroId)] || null;
}

function getRoleProfile(roleId) {
  return ROLE_PROFILES[String(roleId)] || null;
}

function isSupportedProfile(heroId, roleId) {
  const hero = getHeroProfile(heroId);
  return Boolean(hero && getRoleProfile(roleId) && hero.supportedRoles.includes(roleId));
}

function supportedProfiles(){return PRODUCT.supportedHeroIds.map(getHeroProfile);}

module.exports = { PRODUCT, ROLE_PROFILES, HERO_PROFILES, getHeroProfile, getRoleProfile, isSupportedProfile, supportedProfiles };

