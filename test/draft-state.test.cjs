'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalizeGsi}=require('../src/core.cjs');
const {PICK,STRATEGY,draftPhase,normalizeDraft,newPickTrack,updatePickTrack,resolveDraft,applyDraftSettings,clearDraftOverrides}=require('../src/draft-state.cjs');
const {capturePolicy}=require('../src/runtime-policy.cjs');
const NOW=1700000000000;
const heroes=[42,8,18,44,48,5,20,12,26,47].map(id=>({id}));
const settings=()=>({draftMode:'auto',draftOwnTeam:'auto',draftAllyHeroIds:[],draftEnemyHeroIds:[],draftBannedHeroIds:[],draftPreferredHeroIds:[],draftAllyOverride:false,draftEnemyOverride:false,draftBanOverride:false});
const state=(patch={})=>({gameState:PICK,receivedAt:NOW,team:'radiant',draft:normalizeDraft({team2:{pick0_id:5,pick1_id:20},team3:{pick0_id:12,pick1_id:26,ban0_id:44}}),...patch});
test('hero selection activates before any hero exists, strategy stays active and pregame restores match mode',()=>{
  for(const gameState of[PICK,STRATEGY])assert.notEqual(draftPhase(state({gameState}),settings(),NOW),'inactive');
  assert.equal(draftPhase(state({gameState:'DOTA_GAMERULES_STATE_PRE_GAME'}),{draftMode:'preview'},NOW),'inactive');
  const packet=normalizeGsi({map:{game_state:PICK},player:{activity:'playing',team_name:'radiant'},hero:{},draft:{team2:{pick0_id:5},team3:{pick0_id:26}}});
  assert.equal(packet.status,'waiting');assert.deepEqual(packet.draft.teams.radiant,[5]);
  assert.equal(draftPhase({...packet,receivedAt:NOW},settings(),NOW),'pick');
});
test('stale, future and spectator packets cannot activate automatic draft; preview is explicit',()=>{
  for(const patch of[{receivedAt:NOW-16000},{receivedAt:NOW+1001},{isSpectator:true}])assert.equal(draftPhase(state(patch),settings(),NOW),'inactive');
  assert.equal(draftPhase(null,{draftMode:'preview'},NOW),'preview');
  assert.equal(draftPhase(null,settings(),NOW),'inactive');
});
test('flat public draft keys are validated, conflicts removed and picks cannot be banned',()=>{
  const draft=normalizeDraft({team2:{pick0_id:5,pick1_id:5,pick2_id:42,ban0_id:42,ban1_id:44},team3:{pick0_id:5,pick1_id:26,pick2_id:'18',ban1_id:44}});
  assert.deepEqual(draft.teams,{radiant:[42],dire:[26]});assert.deepEqual(draft.bannedHeroIds,[44]);
  for(const value of[null,[],{},'bad'])assert.equal(normalizeDraft(value).available,false);
});
test('GSI draft assigns relative teams only with a known own side and filters unknown catalog IDs',()=>{
  const result=resolveDraft({state:state(),settings:settings(),heroes,now:NOW});
  assert.deepEqual(result.allyHeroIds,[5,20]);assert.deepEqual(result.enemyHeroIds,[12,26]);assert.deepEqual(result.bannedHeroIds,[44]);assert.equal(result.source,'gsi');
  const unknown=resolveDraft({state:state({team:null}),settings:settings(),heroes,now:NOW});
  assert.deepEqual(unknown.enemyHeroIds,[]);assert.match(unknown.status,/сторону/);
  const dire=resolveDraft({state:state({team:null}),settings:{...settings(),draftOwnTeam:'dire'},heroes,now:NOW});
  assert.deepEqual(dire.enemyHeroIds,[5,20]);
});
test('manual correction has priority, removing all members is an explicit empty override and auto resets it',()=>{
  const prefs=settings();applyDraftSettings(prefs,{draftEnemyHeroIds:[5,47]},heroes.map(hero=>hero.id),[42,8,18,44,48]);
  let result=resolveDraft({state:state(),settings:prefs,heroes,now:NOW});
  assert.deepEqual(result.enemyHeroIds,[5,47]);assert.deepEqual(result.allyHeroIds,[20]);
  applyDraftSettings(prefs,{draftEnemyHeroIds:[]},heroes.map(hero=>hero.id),[42,8,18,44,48]);
  result=resolveDraft({state:state(),settings:prefs,heroes,now:NOW});assert.deepEqual(result.enemyHeroIds,[]);
  clearDraftOverrides(prefs);assert.deepEqual(resolveDraft({state:state(),settings:prefs,heroes,now:NOW}).enemyHeroIds,[12,26]);
});
test('chosen carry is locked to own team and cannot become an enemy or a ban',()=>{
  const prefs={...settings(),draftEnemyOverride:true,draftBanOverride:true,draftEnemyHeroIds:[8,26],draftBannedHeroIds:[8,44]};
  const result=resolveDraft({state:state({heroId:8}),settings:prefs,heroes,now:NOW});
  assert.equal(result.locked,true);assert.equal(result.ownHeroId,8);assert.deepEqual(result.allyHeroIds,[8,5,20]);assert.deepEqual(result.enemyHeroIds,[26]);assert.deepEqual(result.bannedHeroIds,[44]);
});
test('draft edits reject unknown IDs, bound all arrays, resolve group conflicts and keep comfort within supported pool',()=>{
  const prefs=settings();applyDraftSettings(prefs,{draftAllyHeroIds:[5,20,12,26,47,42,9999],draftEnemyHeroIds:[26,8],draftBannedHeroIds:[8,44],draftPreferredHeroIds:[8,44,26,999],draftOwnTeam:'wrong'},heroes.map(hero=>hero.id),[42,8,18,44,48]);
  assert.deepEqual(prefs.draftAllyHeroIds,[5,20,12,47]);assert.deepEqual(prefs.draftEnemyHeroIds,[26]);assert.deepEqual(prefs.draftBannedHeroIds,[8,44]);assert.deepEqual(prefs.draftPreferredHeroIds,[8,44]);assert.equal(prefs.draftOwnTeam,'auto');
});
test('draft portraits require distinct strict observations; repeated frame publication and cached portraits do not confirm',()=>{
  const slot={index:0,team:'radiant',hero:{id:5,confidence:.98,margin:.12}};
  const vision=stamp=>({capturedAt:stamp,roster:{slots:[slot]},diagnostics:{rosterRefreshed:true}});
  const emptyState=state({draft:normalizeDraft(null)});
  let track=newPickTrack();track=updatePickTrack(track,{state:emptyState,vision:vision(NOW),now:NOW});
  for(let index=0;index<5;index++)track=updatePickTrack(track,{state:emptyState,vision:vision(NOW),now:NOW+1000});
  assert.deepEqual(track.teams.radiant,[]);
  track=updatePickTrack(track,{state:{...emptyState,receivedAt:NOW+3000},vision:vision(NOW+3000),now:NOW+3000});
  assert.deepEqual(track.teams.radiant,[]);
  track=updatePickTrack(track,{state:{...emptyState,receivedAt:NOW+6000},vision:vision(NOW+6000),now:NOW+6000});
  assert.deepEqual(track.teams.radiant,[5]);
  const cached=updatePickTrack(newPickTrack(),{state:emptyState,vision:{...vision(NOW),roster:{slots:[{...slot,fromCache:true}]}},now:NOW});assert.deepEqual(cached.teams.radiant,[]);
});
test('GSI confirmed teams persist when draft fields disappear on entering the game',()=>{
  const track=updatePickTrack(newPickTrack(),{state:state(),now:NOW});assert.deepEqual(track.teams.radiant,[5,20]);
  const next=updatePickTrack(track,{state:state({gameState:'DOTA_GAMERULES_STATE_PRE_GAME',draft:normalizeDraft(null)}),now:NOW});assert.deepEqual(next.teams.dire,[12,26]);
});
test('preview does not reuse automatic teams from an unrelated match',()=>{
  const result=resolveDraft({state:null,track:{...newPickTrack(),teams:{radiant:[42,5],dire:[12,26]}},settings:{...settings(),draftMode:'preview',draftOwnTeam:'radiant'},heroes,now:NOW});
  assert.deepEqual(result.allyHeroIds,[]);assert.deepEqual(result.enemyHeroIds,[]);
});
test('all five draft positions persist while malformed updates leave the last valid position intact',()=>{
  const prefs=settings();for(const positionId of [1,2,3,4,5]){applyDraftSettings(prefs,{draftPositionId:positionId},heroes.map(hero=>hero.id),[]);assert.equal(prefs.draftPositionId,positionId);}
  for(const invalid of [0,6,2.5,'2',null,NaN]){applyDraftSettings(prefs,{draftPositionId:invalid},heroes.map(hero=>hero.id),[]);assert.equal(prefs.draftPositionId,5);}
  clearDraftOverrides(prefs);assert.equal(prefs.draftPositionId,5);
});
test('pick capture needs no selected WK and respects GSI-only, hidden, imported and disabled modes',()=>{
  const prefs={captureEnabled:true,captureScope:'game',performanceMode:'economy',overlayVisible:true,autoLane:false};
  assert.equal(capturePolicy(prefs,state(),{now:NOW}).enabled,true);
  for(const patch of[{captureEnabled:false},{performanceMode:'gsi'},{demo:true}])assert.equal(capturePolicy({...prefs,...patch},state(),{now:NOW}).enabled,false);
  assert.equal(capturePolicy(prefs,state(),{now:NOW,visible:false}).enabled,false);assert.equal(capturePolicy(prefs,state(),{now:NOW,imported:true}).enabled,false);
});
