'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const{updateDraftCache}=require('../src/draft-cache.cjs');
const sample=now=>({now,state:{heroId:8,isSupportedCarry:true,status:'live',team:'radiant',receivedAt:now,matchId:'a'},vision:{capturedAt:now,roster:{slots:[{team:'radiant',hero:{id:26,confidence:.98}},{team:'dire',hero:{id:29,confidence:.86,margin:.18}},{team:'dire',hero:{id:31,confidence:.96}}]}}});
test('manual draft picker gets repeated team identities for another carry without assigning lane roles',()=>{
  let cache;for(const now of[100000,105000,110000])cache=updateDraftCache(cache,sample(now));
  assert.deepEqual(cache.teams,{radiant:[8,26],dire:[29,31]});assert.equal(Object.hasOwn(cache,'allyHeroId'),false);
});
test('cached portraits, stale GSI, spectators and conflicting own sides do not qualify identities',()=>{
  for(const kind of['cached','stale','spectator','conflict']){
    let cache;for(const now of[100000,105000,110000]){const input=sample(now);if(kind==='cached')input.vision.roster.slots.forEach(row=>row.fromCache=true);if(kind==='stale')input.state.receivedAt=now-16000;if(kind==='spectator')input.state.isSpectator=true;if(kind==='conflict')input.vision.roster.slots=[{team:'dire',hero:{id:8,confidence:.98}}];cache=updateDraftCache(cache,input);}
    assert.deepEqual(cache.teams.dire,[]);
  }
});
test('hero and match changes reset the draft cache',()=>{
  let cache;for(const now of[100000,105000])cache=updateDraftCache(cache,sample(now));
  const input=sample(110000);input.state.heroId=18;input.state.matchId='b';input.vision.roster.slots=[];cache=updateDraftCache(cache,input);
  assert.deepEqual(cache.teams,{radiant:[18],dire:[]});
});
