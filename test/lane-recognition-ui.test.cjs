'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the actual renderer diagnostic, without copying its gate logic.
const source = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
const diagnosticSource = source.slice(source.indexOf('function laneRecognitionDiagnostic('), source.indexOf('\nfunction renderLaneDiagnostics('));
const context = vm.createContext({});
vm.runInContext(source.slice(source.indexOf('function selectedScreenHero('), source.indexOf('\nfunction heroById(')), context);
vm.runInContext(diagnosticSource, context);
const NOW = 200000;
const diagnose = state => context.laneRecognitionDiagnostic(state, NOW);
const live = () => ({
  settings: { captureEnabled: true, autoLane: true, performanceMode: 'economy' },
  connection: { status: 'live', receivedAt: NOW }, hero: { isWraithKing: true },
  capture: {}, laneDetection: {}, draftRoster: { alliedHeroIds: [42, 26, 9, 37, 47], enemyHeroIds: [2, 49, 35, 6, 8] },
  vision: { capturedAt: NOW, quality: { usable: true }, roster: { slots: Array.from({length: 10}, (_, id) => ({hero: {id: id + 1}})) }, minimap: { heroes: [] } },
});

test('recognized team portraits do not imply recognized participants on the minimap', () => {
  const result = diagnose(live());
  assert.equal(result.portraits, 10); assert.equal(result.teams, 10); assert.equal(result.mapIcons, 0);
  assert.match(result.message, /На миникарте пока не распознаны/);
  assert.match(result.explanation, /Верхние портреты определяют команды/);
});

test('manual lineup is clear even while automatic recognition awaits GSI or map icons',()=>{
  const state=live();state.connection={status:'waiting'};state.settings.laneAllyHeroId=26;state.settings.laneEnemyHeroIds=[2,22];
  const result=diagnose(state);assert.equal(result.tone,'ready');assert.match(result.message,/выбраны тобой/);assert.doesNotMatch(result.message,/Жду|мини карте|Установи GSI/);
  assert.match(result.explanation,/Автоопределение продолжает/);
  state.settings.laneEnemyHeroIds=[2];assert.equal(diagnose(state).tone,'checking');assert.match(diagnose(state).message,/Выбери остальные/);
});

test('additional carry profiles offer quick manual selection rather than a wrong hero error',()=>{
  const state=live();state.activeProfile={heroId:18,name:'Sven'};state.hero.isWraithKing=false;
  const result=diagnose(state);assert.match(result.message,/Выбери напарника/);assert.doesNotMatch(result.message,/другой герой/);assert.match(result.explanation,/для всех пяти/);
});

test('visible scene heads explain the alternative evidence when map icons overlap',()=>{
  const state=live();state.vision.scene={usable:true,heroes:[{id:42},{id:26},{id:2},{id:22}]};
  const result=diagnose(state);assert.equal(result.sceneIcons,4);assert.match(result.message,/полосок здоровья/);assert.equal(result.tone,'checking');
});

test('missing and stale GSI produce an actionable reason before minimap advice', () => {
  for (const status of ['waiting', 'stale']) {
    const state = live(); state.connection = {status};
    const result = diagnose(state);
    assert.equal(result.tone, 'attention'); assert.match(result.message, /GSI/);
    assert.doesNotMatch(result.message, /не распознаны значки/);
  }
});

test('pause, imported screenshot and inactive stage report their actual gate', () => {
  const paused = live(); paused.hero.isPaused = true;
  assert.match(diagnose(paused).message, /на паузе/);
  const imported = live(); imported.capture.imported = true;
  assert.match(diagnose(imported).message, /статичный скриншот/);
  const inactive = live(); inactive.laneDetection = {status: 'inactive', reason: 'Проверка участников завершена.'};
  assert.equal(diagnose(inactive).message, inactive.laneDetection.reason);
});

test('visible icons, missing team confirmation and detector evidence remain distinct', () => {
  const state = live(); state.vision.minimap.heroes = [{id: 42}, {id: 26}, {id: 2}, {id: 22}];
  state.draftRoster = {enemyHeroIds: [], alliedHeroIds: []};
  assert.match(diagnose(state).message, /принадлежность командам ещё проверяется/);
  state.draftRoster = live().draftRoster;
  state.laneDetection.reason = 'Жду отдельный значок Wraith King.';
  assert.equal(diagnose(state).message, state.laneDetection.reason);
});

test('expired captures are reported as old images and confirmed participants stay explicit', () => {
  const state = live(); state.vision.capturedAt -= 10000;
  assert.match(diagnose(state).message, /Жду свежий кадр/);
  state.vision.capturedAt = NOW;
  state.laneRoster = {status: 'confirmed', ally: {id: 26}, enemies: [{id: 2}, {id: 22}]};
  const result = diagnose(state);
  assert.equal(result.tone, 'ready'); assert.match(result.message, /Участники линии подтверждены/); assert.equal(result.explanation, '');
});

function screenCurrent(){
  const state=live();state.settings.captureScope='game';state.connection={status:'waiting'};state.hero=null;
  state.vision.player={heroId:42,confirmed:true,source:'selected_hud',team:'radiant',observedAt:NOW};
  state.vision.scene={usable:true,heroes:[{id:42},{id:26},{id:2},{id:22}]};
  state.laneRoster={source:'screen_current',status:'confirmed',ally:{id:26},enemies:[{id:2},{id:22}]};
  return state;
}

test('fresh selected HUD proof shows nearby composition without claiming an original lane or personal statistics',()=>{
  const state=screenCurrent(),result=diagnose(state);
  assert.equal(result.selected,true);assert.equal(result.tone,'ready');
  assert.match(result.message,/Герои рядом с WK подтверждены/);assert.match(result.message,/Исходный состав линии не подтверждён/);
  assert.match(result.explanation,/GSI нужен отдельно/);assert.doesNotMatch(result.message,/Установи GSI|продолжится после/);
});

test('pause, a late clock, and stale personal GSI cannot mask fresh selected HUD scene observations',()=>{
  for(const status of ['live','stale']){
    const state=screenCurrent();state.connection={status};state.hero={isWraithKing:status==='live',isPaused:true,gameTime:720};
    const result=diagnose(state);assert.equal(result.selected,true);assert.equal(result.tone,'ready');assert.match(result.message,/рядом с WK/);
  }
});

test('fresh wrong-hero and spectator GSI override an apparent selected HUD proof',()=>{
  for(const status of ['wrong_hero','spectator']){
    const state=screenCurrent();state.connection={status};const result=diagnose(state);
    assert.equal(result.selected,false);assert.notEqual(result.tone,'ready');assert.match(result.message,/другой герой|наблюдателя/);
  }
});

test('screen mode waits for scene evidence without blaming empty minimap icons',()=>{
  const state=screenCurrent();delete state.laneRoster;state.vision.scene={usable:false,heroes:[]};
  const result=diagnose(state);assert.equal(result.selected,true);assert.match(result.message,/держи WK|Держи WK/);assert.doesNotMatch(result.message,/На миникарте пока не распознаны/);
});

test('stale selected HUD proof and imported images cannot enable screen composition',()=>{
  const state=screenCurrent();state.vision.capturedAt=NOW-8000;
  assert.equal(diagnose(state).selected,false);assert.notEqual(diagnose(state).tone,'ready');
  state.vision.capturedAt=NOW;state.capture.imported=true;
  const result=diagnose(state);assert.equal(result.selected,false);assert.match(result.message,/статичный скриншот/);
});

test('retained nearby composition is labelled as previous observations rather than currently visible positions',()=>{
  const state=screenCurrent();state.laneRoster.status='retained';
  assert.match(diagnose(state).message,/последние наблюдения.*текущие позиции неизвестны/);
});
