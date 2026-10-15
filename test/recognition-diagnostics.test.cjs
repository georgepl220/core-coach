'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {recognitionDiagnostic}=require('../src/recognition-diagnostics.cjs');
test('recognition diagnostics expose actual capture gates and scores without account data or secrets',()=>{
  const d=recognitionDiagnostic({now:200000,version:'test',state:{status:'live',heroId:42,isWraithKing:true,gameTime:519,receivedAt:199900,isPaused:false,team:'radiant',steamid:'private-account',auth:{token:'private-token'},inventory:[{name:'private-inventory'}]},settings:{authToken:'private-token',stratzToken:'private-stratz',captureScope:'game'},captureConfig:{enabled:true,calibration:{sceneEnabled:true}},vision:{capturedAt:199500,roster:{slots:[{team:'radiant',hero:{id:42,confidence:.98,margin:.3},data:'private-pixels'}]},scene:{proposedHeadCount:4,analyzedHeadCount:4,usable:true,heroes:[{id:42,confidence:.94,margin:.3,team:'ally'}],observations:[{bestHeroId:42,bestSimilarity:.94,accepted:true,reason:null}]}},cache:{teams:{radiant:[42,26],dire:[2,22]}},track:{inferred:{status:'observing',reason:'Checking',complete:false}}});
  assert.equal(d.gsi.ageMs,100);assert.equal(d.capture.frameAgeMs,500);assert.equal(d.capture.sceneEnabled,true);assert.equal(d.scene.proposedHeads,4);
  assert.equal(d.hud[0].score,.98);assert.equal(d.scene.heroes[0].score,.94);
  assert.doesNotMatch(JSON.stringify(d),/private-|steamid|stratz|auth|inventory|pixels/);
});
test('diagnostics explain selected HUD proof separately from missing personal GSI',()=>{
  const d=recognitionDiagnostic({now:100000,state:null,captureConfig:{enabled:true,calibration:{sceneEnabled:true}},vision:{capturedAt:99500,player:{heroId:42,confirmed:true,confidence:.97,team:'radiant',source:'selected_hud',observedAt:99500,data:'private-pixels',steamid:'private-account'}}});
  assert.equal(d.gsi.status,'waiting');assert.equal(d.selectedHero.id,42);assert.equal(d.selectedHero.confirmed,true);assert.equal(d.selectedHero.ageMs,500);assert.equal(d.capture.enabled,true);
  assert.doesNotMatch(JSON.stringify(d),/private-|steamid|pixels/);
});
