'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {draftCalibration,defaultCalibration}=require('../src/hud-calibration.js');
const {resolveRect}=require('../src/vision.cjs');
const {analyzeRegions}=require('../src/vision-regions.cjs');
const size={width:1920,height:1080};
function flatPacket(capturePhase){
  const regions=draftCalibration(size.width,size.height).rosterRects.map((definition,index)=>({kind:'roster',index,team:definition.team,rect:resolveRect(definition,size.width,size.height),width:64,height:38,data:new Uint8Array(64*38*4).fill(40)}));
  return {capturePhase,timestamp:100000,originalSize:size,regions};
}
test('large draft portraits retain centred, height-scaled geometry across window sizes',()=>{
  for(const [width,height]of[[1920,1080],[1280,720],[2560,1440],[2560,1080]]){
    const draft=draftCalibration(width,height).rosterRects.map(rect=>resolveRect(rect,width,height));
    assert.equal(draft.length,10);assert.ok(draft.every(rect=>rect&&!rect.clipped));
    assert.ok(draft[0].height>defaultCalibration(width,height).rosterRects[0].height*height);
    assert.ok(draft.every(rect=>rect.y+rect.height<=height*.075),'player names below cards are never included');
    assert.ok(Math.abs(draft[0].x-(width/2-750*height/1080))<1);
  }
});
test('draft analysis has no map/player/scene and ignores stale game roster history',()=>{
  const previous={lastSeen:[{id:42,lastSeen:99999}],roster:{originalSize:size,slots:[{index:0,team:'radiant',hero:{id:42,confidence:.99}}],capturePhase:'game'}};
  const result=analyzeRegions(flatPacket('draft'),{}, {portraits:[],minimap:[]},previous);
  assert.equal(result.capturePhase,'draft');assert.equal(result.player.confirmed,false);assert.equal(result.scene.usable,false);
  assert.equal(result.minimap.rect,null);assert.deepEqual(result.minimap.heroes,[]);assert.deepEqual(result.minimap.lastSeenHeroes,[]);
  assert.ok(result.roster.slots.every(slot=>!slot.hero&&!slot.fromCache));
  assert.equal(result.state.roster.capturePhase,'draft');assert.ok(result.diagnostics.roiBytes<=120000);
});
test('blank draft slots clear prior portrait observations instead of promoting cached identities',()=>{
  const previous={roster:{originalSize:size,slots:[{index:0,team:'radiant',hero:{id:42,confidence:.99}}],capturePhase:'draft'}};
  const result=analyzeRegions(flatPacket('draft'),{}, {portraits:[],minimap:[]},previous);
  assert.ok(result.roster.slots.every(slot=>!slot.hero&&!slot.fromCache));
});
test('transition from draft to game never reuses menu team observations as game HUD proof',()=>{
  const previous={roster:{originalSize:size,slots:[{index:0,team:'radiant',hero:{id:42,confidence:.99}}],capturePhase:'draft'}};
  const packet={capturePhase:'game',timestamp:100000,originalSize:size,regions:[{kind:'minimap',width:80,height:80,rect:{x:8,y:844,width:228,height:236},data:new Uint8Array(80*80*4).fill(40)}]};
  const result=analyzeRegions(packet,{}, {portraits:[],minimap:[]},previous);
  assert.equal(result.state.roster.capturePhase,'game');assert.deepEqual(result.roster.slots,[]);
});
