'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const picker=require('../src/lane-picker.js');
const snapshot={activeProfile:{heroId:42},heroes:[42,8,26,2,22,49].map(id=>({id})),draftRoster:{alliedHeroIds:[42,26,8,26,999],enemyHeroIds:[2,22,49,2]},settings:{laneEnemyHeroIds:[2,22]}};
test('quick picker shows only the appropriate known team and omits the active carry',()=>{
  assert.deepEqual(picker.teamChoices(snapshot,'ally'),[26,8]);
  assert.deepEqual(picker.teamChoices(snapshot,'enemy'),[2,22,49]);
  const other={...snapshot,activeProfile:{heroId:8}};
  assert.deepEqual(picker.teamChoices(other,'ally'),[42,26]);
});
test('incomplete draft safely gives no invented choices',()=>{
  assert.deepEqual(picker.teamChoices({heroes:snapshot.heroes},'enemy'),[]);
  assert.deepEqual(picker.teamChoices({...snapshot,draftRoster:{enemyHeroIds:'2,22'}},'enemy'),[]);
});
test('opponent changes retain the other manual choice and swap duplicate selection',()=>{
  assert.deepEqual(picker.selectEnemy([2,22],0,49),[49,22]);
  assert.deepEqual(picker.selectEnemy([2,22],1,2),[22,2]);
  assert.deepEqual(picker.selectEnemy([2],1,2),[2]);
  assert.deepEqual(picker.selectEnemy([2],1,22),[2,22]);
  assert.deepEqual(picker.selectEnemy([],1,22),[22]);
});
test('clearing returns that side to automatic inference without changing full draft or ally',()=>{
  assert.deepEqual(picker.selectionPatch(snapshot,'enemy',0,null),{laneEnemyHeroIds:[22]});
  assert.deepEqual(picker.selectionPatch(snapshot,'ally',0,null),{laneAllyHeroId:null});
  assert.equal(picker.selectionPatch(snapshot,'enemy',0,42),null);
  assert.deepEqual(picker.selectionPatch(snapshot,'ally',0,26),{laneAllyHeroId:26});
});

test('editing a confirmed automatic opponent keeps its other card while tentative guesses are not pinned',()=>{
  const auto={...snapshot,settings:{laneEnemyHeroIds:[]},laneRoster:{enemies:[{id:2,status:'confirmed'},{id:22,status:'confirmed'}]}};
  assert.deepEqual(picker.selectionPatch(auto,'enemy',1,49),{laneEnemyHeroIds:[2,49]});
  assert.deepEqual(picker.selectionPatch(auto,'enemy',1,2),{laneEnemyHeroIds:[22,2]});
  auto.laneRoster.enemies[0].status='observing';
  assert.deepEqual(picker.selectionPatch(auto,'enemy',1,49),{laneEnemyHeroIds:[49]});
});
