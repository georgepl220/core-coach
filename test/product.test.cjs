'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PRODUCT, getHeroProfile, getRoleProfile, isSupportedProfile } = require('../src/product.cjs');

test('product supports five carry profiles and keeps the original WK file paths', () => {
  assert.equal(PRODUCT.name, 'Core Coach');
  assert.equal(PRODUCT.preferredProvider, 'stratz');
  assert.equal(isSupportedProfile(42, 'carry'), true);
  assert.equal(isSupportedProfile(42, 'mid'), false);
  assert.equal(isSupportedProfile(1, 'carry'), false);
  assert.equal(getHeroProfile('42').observedBuildFile, 'd2pt-wraith-king.json');
  assert.equal(getHeroProfile(1), null);
  assert.equal(getRoleProfile('carry').position, 1);
  assert.equal(getRoleProfile('support'), null);
  assert.deepEqual(PRODUCT.supportedHeroIds,[42,8,18,44,48]);
  for(const id of PRODUCT.supportedHeroIds){const profile=getHeroProfile(id);assert.equal(isSupportedProfile(id,'carry'),true);assert.equal(profile.heroId,id);assert.match(profile.gameKey,/^npc_dota_hero_/);assert.equal(isSupportedProfile(id,'support'),false);}
});

test('brand and release paths are consistent with the application package', () => {
  const manifest = require('../package.json');
  assert.equal(PRODUCT.version, manifest.version);
  assert.equal(PRODUCT.slug, manifest.name);
  assert.equal(PRODUCT.releaseDirectory, PRODUCT.name);
  assert.equal(PRODUCT.executableFilename, `${PRODUCT.name}.exe`);
});
