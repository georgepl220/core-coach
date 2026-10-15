'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalizeGsi,recommend}=require('../src/core.cjs');
const dataset=require('../data/wraith-king.json');
test('confirmed Lion against Axe and Zeus produces covered defensive advice and chained control',()=>{
  const state=normalizeGsi({map:{clock_time:519,game_state:'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS'},player:{activity:'playing',team_name:'radiant',gold:2014,last_hits:17},hero:{id:42,name:'npc_dota_hero_skeleton_king',alive:true,level:5,health:1000,max_health:1000,mana:375,max_mana:375},items:{},abilities:{}});
  const advice=recommend(state,dataset,{laneEnemyHeroIds:[2,22],laneAllyHeroId:26,laneSource:'screen_scene',laneConfidence:.903,laneStatus:'confirmed',laneObservedAt:Date.now()});
  assert.equal(advice.lane.stance,'defensive');assert.equal(advice.lane.detectionSource,'screen_scene');
  assert.match(advice.lane.title,/Axe \+ Zeus/);assert.match(advice.lane.tips.join(' '),/Lion.*Hex.*Earth Spike/);
  assert.match(advice.lane.tips.join(' '),/готовность.*проверь/i);assert.doesNotMatch(advice.lane.reason,/не хватает правил/);
});
