'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const{newRosterCache,updateRosterCache}=require('../src/roster-cache.cjs');
const input=(now,extra={})=>({now,state:{isWraithKing:true,receivedAt:now,gameTime:now/1000,matchId:'1'},vision:{capturedAt:now,roster:{slots:[{team:'radiant',hero:{id:42,confidence:.97}},{team:'radiant',hero:{id:5,confidence:.96}},{team:'dire',hero:{id:2,confidence:.96}},{team:'dire',hero:{id:101,confidence:.96}}]}},...extra});
test('team identities require repeated HUD observations, duplicate frame does not confirm',()=>{
  let cache=updateRosterCache(newRosterCache(),input(100000));assert.deepEqual(cache.teams.dire,[]);
  cache=updateRosterCache(cache,input(105000,{vision:input(100000).vision}));assert.deepEqual(cache.teams.dire,[]);
  const reused=input(107000);reused.vision.roster.slots.forEach(slot=>{slot.fromCache=true;});cache=updateRosterCache(cache,reused);assert.deepEqual(cache.teams.dire,[]);
  cache=updateRosterCache(cache,input(110000));assert.deepEqual(cache.teams.dire,[2,101]);assert.deepEqual(cache.teams.radiant,[42,5]);
});
test('dark or skipped HUD frames retain identities without inferring a role or position',()=>{
  let cache=updateRosterCache(null,input(100000));cache=updateRosterCache(cache,input(105000));
  const hidden=input(115000);hidden.vision.roster.slots=[];cache=updateRosterCache(cache,hidden);assert.deepEqual(cache.teams.dire,[2,101]);
  assert.equal(Object.hasOwn(cache,'positions'),false);assert.equal(Object.hasOwn(cache,'supportId'),false);
});
test('match changes, local clock restarts, spectators and duplicate hero sides cannot reuse evidence',()=>{
  let cache=updateRosterCache(null,input(100000));cache=updateRosterCache(cache,input(105000));
  const changed=input(110000);changed.state.matchId='2';cache=updateRosterCache(cache,changed);assert.deepEqual(cache.teams.dire,[]);
  cache=updateRosterCache(cache,input(115000,{state:{...input(115000).state,matchId:'2'}}));
  const restart=input(1000);restart.state.matchId='2';cache=updateRosterCache(cache,restart);assert.deepEqual(cache.teams.dire,[]);
  const observer=input(5000);observer.state.isSpectator=true;cache=updateRosterCache(cache,observer);assert.deepEqual(cache.teams.dire,[]);
  const conflict=input(10000);conflict.vision.roster.slots[2].hero.id=42;cache=updateRosterCache(cache,conflict);assert.deepEqual(cache.teams.dire,[]);
});
const selected=(now,extra={})=>({heroId:42,team:'radiant',confirmed:true,observedAt:now,source:'selected_hud',...extra});
const fullSlots=(replacement=101)=>[42,5,26,8,17,2,replacement,1,11,28].map((id,index)=>({team:index<5?'radiant':'dire',hero:{id,confidence:.96}}));
test('verified selected WK allows real repeated team observations without GSI or during pause',()=>{
  for(const state of[{}, {isWraithKing:true,heroId:42,receivedAt:100000,isPaused:true}]){
    let cache=null;
    for(const now of[100000,105000]){const sample=input(now,{state,screenPlayer:selected(now)});cache=updateRosterCache(cache,sample);}
    assert.deepEqual(cache.teams.radiant,[42,5]);assert.deepEqual(cache.teams.dire,[2,101]);
    assert.equal(cache.lastGameTime,null);
  }
});
test('stale, unrelated or unsupported selected HUD proof cannot bootstrap teams without GSI',()=>{
  for(const patch of[{heroId:26},{observedAt:80000},{confirmed:false},{source:'top_roster'},{team:'unknown'}]){
    let cache=null;for(const now of[100000,105000])cache=updateRosterCache(cache,input(now,{state:{},screenPlayer:selected(now,patch)}));
    assert.deepEqual(cache.teams.radiant,[]);assert.deepEqual(cache.teams.dire,[]);
  }
});
test('a complete changed HUD twice observed resets screen roster even without a GSI match',()=>{
  let cache=null;
  const sample=(now,replacement=101)=>input(now,{state:{},screenPlayer:selected(now),vision:{capturedAt:now,roster:{slots:fullSlots(replacement)},diagnostics:{rosterRefreshed:true}}});
  for(const now of[100000,105000])cache=updateRosterCache(cache,sample(now));
  assert.ok(cache.fingerprint);assert.ok(cache.teams.dire.includes(101));
  const original=JSON.stringify(cache);
  const pending=updateRosterCache(cache,sample(110000,22));
  assert.ok(pending.teams.dire.includes(101));assert.equal(JSON.stringify(cache),original);
  const reused=sample(115000,22);reused.vision.roster.slots.forEach(slot=>slot.fromCache=true);
  cache=updateRosterCache(pending,reused);assert.ok(cache.teams.dire.includes(101));
  // The cached crop is not a second observation, so confirmation starts again.
  cache=updateRosterCache(cache,sample(120000,22));assert.ok(cache.teams.dire.includes(101));
  cache=updateRosterCache(cache,sample(125000,22));assert.ok(cache.teams.dire.includes(22));assert.equal(cache.teams.dire.includes(101),false);
  assert.equal(Object.values(cache.slots).some(slot=>slot.id===101),false);
});
test('fresh spectator or other selected GSI hero cannot reuse verified screen teams',()=>{
  let cache=updateRosterCache(null,input(100000));cache=updateRosterCache(cache,input(105000));
  for(const state of[{heroId:26,receivedAt:110000},{isSpectator:true,receivedAt:110000}]){
    const result=updateRosterCache(cache,input(110000,{state,screenPlayer:selected(110000)}));
    assert.deepEqual(result.teams.radiant,[]);assert.deepEqual(result.teams.dire,[]);
  }
});
test('screen team cache qualifies distinct low-score HUD matches by margin and three observations without inflating scores',()=>{
  let cache=null;
  for(const now of[100000,105000,110000]){
    const sample=input(now,{state:{},screenPlayer:selected(now)});
    sample.vision.roster.slots[3].hero={id:20,confidence:.86,margin:.14};
    cache=updateRosterCache(cache,sample);
    if(now<110000)assert.equal(cache.teams.dire.includes(20),false);
  }
  assert.deepEqual(cache.teams.dire,[2,20]);
  const row=Object.values(cache.slots).find(slot=>slot.id===20);
  assert.equal(row.confidence,.86);assert.equal(row.count,3);assert.equal(row.qualified,true);
});
test('qualified HUD identities reject weak margins, cached frames, short bursts and legacy GSI bootstrap',()=>{
  for(const mode of['margin','cached','short','legacy']){
    let cache=null;
    for(const offset of[0,5000,10000]){
      const now=100000+(mode==='short'?offset/10:offset);
      const sample=input(now,{state:mode==='legacy'?input(now).state:{},screenPlayer:mode==='legacy'?undefined:selected(now)});
      sample.vision.roster.slots[3].hero={id:20,confidence:.86,margin:mode==='margin'?.11:.14};
      if(mode==='cached'&&offset>0)sample.vision.roster.slots[3].fromCache=true;
      cache=updateRosterCache(cache,sample);
    }
    assert.equal(cache.teams.dire.includes(20),false,mode);
  }
});
test('full qualified HUD fingerprint waits for three actual frames spanning ten seconds',()=>{
  let cache=null;
  for(const now of[100000,105000,110000]){
    const slots=fullSlots();slots[6].hero={id:101,confidence:.86,margin:.14};
    cache=updateRosterCache(cache,input(now,{state:{},screenPlayer:selected(now),vision:{capturedAt:now,roster:{slots}}}));
    if(now<110000){assert.equal(cache.fingerprint,null);assert.equal(cache.teams.dire.includes(101),false);}
  }
  assert.ok(cache.fingerprint);assert.ok(cache.teams.dire.includes(101));
  assert.equal(Object.values(cache.slots).find(slot=>slot.id===101).confidence,.86);
});
