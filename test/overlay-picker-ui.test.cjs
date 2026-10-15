'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../src/overlay.js'),'utf8');
function element(id=''){
  const classes=new Set(),listeners={};
  return{id,textContent:'',hidden:false,title:'',dataset:{},disabled:false,children:[],attributes:{},listeners,classList:{toggle(name,value){if(value)classes.add(name);else classes.delete(name);},contains:name=>classes.has(name)},append(...nodes){this.children.push(...nodes);},prepend(node){this.children.unshift(node);},replaceChildren(...nodes){this.children=nodes;},addEventListener(type,listener){listeners[type]=listener;},setAttribute(name,value){this.attributes[name]=value;},remove(){},replaceWith(){},getBoundingClientRect(){return id==='overlay-lane-picker'?{x:24,y:145,width:292,height:240}:{x:24,y:84,width:29,height:27};}};
}
function fixture(){
  const names={42:'Wraith King',18:'Sven',26:'Lion',5:'Crystal Maiden',6:'Drow Ranger',37:'Warlock',2:'Axe',22:'Zeus',49:'Dragon Knight',8:'Juggernaut',35:'Sniper'};
  return{activeProfile:{heroId:42,name:'Wraith King'},heroes:Object.entries(names).map(([id,name])=>({id:Number(id),name,image:`hero-${id}.png`})),draftRoster:{alliedHeroIds:[42,26,5,6,37],enemyHeroIds:[2,22,49,8,35]},settings:{compact:true,laneAllyHeroId:null,laneEnemyHeroIds:[],autoLane:true},connection:{status:'waiting'},hero:null,laneRoster:{source:'screen',status:'confirmed',ally:{id:26,status:'confirmed',name:'Lion',image:'hero-26.png'},enemies:[{id:2,status:'confirmed',name:'Axe',image:'hero-2.png'},{id:22,status:'confirmed',name:'Zeus',image:'hero-22.png'}]},advice:{stage:{id:'unknown',title:'Ожидаю матч'},action:{title:'Совет',reason:'Пример',tone:'neutral'},alternatives:[],skills:{}}};
}
function setup(initial=fixture(),overrides={}){
  const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,element(id));return elements.get(id);};
  const calls={patches:[],commands:[],areas:[],pointer:0};let current=initial,hotkey=null;
  const coach={onState(){},onOverlayPicker(callback){hotkey=callback;},getState:async()=>current,setOverlayHitAreas(areas){calls.areas.push(areas);},notifyOverlayPointer(){calls.pointer++;},async updateSettings(patch){
    calls.patches.push(patch);current={...current,settings:{...current.settings,...patch}};
    const slot=id=>{const hero=current.heroes.find(hero=>hero.id===id);return hero?{...hero,status:'confirmed',source:'manual'}:{status:'unknown'};};
    current.laneRoster={...current.laneRoster,source:'manual',ally:current.settings.laneAllyHeroId?slot(current.settings.laneAllyHeroId):current.laneRoster.ally,enemies:current.settings.laneEnemyHeroIds.length?current.settings.laneEnemyHeroIds.map(slot):current.laneRoster.enemies};return current;
  },async command(name){calls.commands.push(name);if(name==='resume-auto-lineup')current={...current,settings:{...current.settings,laneAllyHeroId:null,laneEnemyHeroIds:[],autoLane:true}};return{ok:true};},...overrides};
  const document={getElementById:get,createElement:()=>element(),body:element('body'),listeners:{},addEventListener(type,handler){this.listeners[type]=handler;}};
  const sandbox={document,Date,window:{LanePicker:require('../src/lane-picker.js'),coach,addEventListener(){}},console};
  vm.runInNewContext(source,sandbox);sandbox.update(initial);
  return{sandbox,get,calls,document,setCurrent:value=>{current=value;},hotkey:payload=>hotkey(payload),choiceIds:()=>get('overlay-picker-choices').children.map(el=>Number(el.dataset.heroId)),click:id=>get(id).listeners.click(),choose:id=>get('overlay-picker-choices').children.find(el=>Number(el.dataset.heroId)===id).listeners.click()};
}

test('clicking actual overlay avatar shows only four allies and exposes the compact picker as an interactive area',()=>{
  const ui=setup();ui.click('overlay-lane-ally');
  assert.deepEqual(ui.choiceIds(),[26,5,6,37]);assert.equal(ui.get('overlay-lane-picker').hidden,false);assert.equal(ui.get('overlay-advice-body').hidden,true);
  assert.equal(ui.get('overlay-picker-title').textContent,'Кто стоит с тобой?');assert.equal(ui.get('overlay-picker-empty').hidden,true);
  const areas=ui.calls.areas.at(-1);assert.equal(areas.length,5);assert.ok(areas.some(area=>area.width===292));assert.ok(areas.reduce((sum,area)=>sum+area.width*area.height,0)<90000);
  assert.deepEqual(ui.calls.commands,[]);assert.deepEqual(ui.calls.patches,[]);
});

test('three portrait clicks save the full lineup and immediately restore advice without relying on an IPC broadcast',async()=>{
  const ui=setup();ui.click('overlay-pick-lineup');await ui.choose(5);
  assert.equal(ui.get('overlay-picker-title').textContent,'Соперник 1 на линии');assert.deepEqual(ui.choiceIds(),[2,22,49,8,35]);
  await ui.choose(49);assert.equal(ui.get('overlay-picker-title').textContent,'Соперник 2 на линии');await ui.choose(8);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls.patches)),[{laneAllyHeroId:5},{laneEnemyHeroIds:[49,22]},{laneEnemyHeroIds:[49,8]}]);
  assert.equal(ui.get('overlay-lane-picker').hidden,true);assert.equal(ui.get('overlay-advice-body').hidden,false);assert.equal(ui.get('overlay-lane-status').textContent,'Выбрано тобой');
  assert.deepEqual(['overlay-lane-ally','overlay-lane-enemy-1','overlay-lane-enemy-2'].map(id=>ui.get(id).children[0].alt),['Crystal Maiden','Dragon Knight','Juggernaut']);
  assert.equal(ui.calls.areas.at(-1).length,4);
});

test('editing one overlay opponent preserves the other confirmed opponent and swaps duplicates',async()=>{
  const ui=setup();ui.click('overlay-lane-enemy-2');await ui.choose(2);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls.patches)),[{laneEnemyHeroIds:[22,2]}]);assert.equal(ui.get('overlay-lane-picker').hidden,true);
});

test('unrecognized teams show an explicit fallback without invented heroes, and opening settings closes the picker',()=>{
  const state=fixture();state.draftRoster={alliedHeroIds:[],enemyHeroIds:[]};const ui=setup(state);ui.click('overlay-lane-enemy-1');
  assert.deepEqual(ui.choiceIds(),[]);assert.equal(ui.get('overlay-picker-empty').hidden,false);ui.click('overlay-picker-settings');
  assert.deepEqual(ui.calls.commands,['show-settings']);assert.equal(ui.get('overlay-lane-picker').hidden,true);
});

test('resume automatic lineup uses the existing command and does not modify team assignments',async()=>{
  const state=fixture();state.settings.laneAllyHeroId=26;state.settings.laneEnemyHeroIds=[2,22];const ui=setup(state);ui.click('overlay-lane-ally');await ui.click('overlay-picker-auto');
  assert.deepEqual(ui.calls.commands,['resume-auto-lineup']);assert.deepEqual(ui.calls.patches,[]);assert.equal(ui.get('overlay-lane-picker').hidden,true);
  const current=vm.runInNewContext('overlayState',ui.sandbox);assert.deepEqual(current.draftRoster,state.draftRoster);assert.equal(current.settings.autoLane,true);assert.equal(current.settings.laneAllyHeroId,null);assert.deepEqual(current.settings.laneEnemyHeroIds,[]);
});

test('failed saves remain reviewable and allow another selection',async()=>{
  let failure=true;const ui=setup(fixture(),{async updateSettings(){if(failure)throw new Error('Нет связи');return fixture();}});ui.click('overlay-lane-ally');await ui.choose(5);
  assert.equal(ui.get('overlay-lane-picker').hidden,false);assert.match(ui.get('overlay-picker-status').textContent,/Нет связи/);assert.equal(ui.get('overlay-picker-choices').children[0].disabled,false);
  failure=false;await ui.choose(5);assert.equal(ui.get('overlay-lane-picker').hidden,true);
});

test('hotkey and Escape close the picker, partial state updates retain the catalog, and another carry excludes itself',()=>{
  const state=fixture();state.activeProfile={heroId:18,name:'Sven'};state.draftRoster.alliedHeroIds=[18,26,5,6,37];const ui=setup(state);ui.hotkey();assert.deepEqual(ui.choiceIds(),[26,5,6,37]);
  const delta={...state};delete delta.heroes;ui.sandbox.update(delta);assert.deepEqual(ui.choiceIds(),[26,5,6,37]);
  let prevented=false;ui.document.listeners.keydown({key:'Escape',preventDefault(){prevented=true;}});assert.equal(prevented,true);assert.equal(ui.get('overlay-lane-picker').hidden,true);
  ui.hotkey();ui.hotkey();assert.equal(ui.get('overlay-lane-picker').hidden,true);
});

test('closing a saving picker prevents the sequential flow from reopening after the response',async()=>{
  let resolve;const pending=new Promise(done=>{resolve=done;}),ui=setup(fixture(),{updateSettings:()=>pending});ui.click('overlay-pick-lineup');const saved=ui.choose(5);ui.click('overlay-picker-close');resolve(fixture());await saved;
  assert.equal(ui.get('overlay-lane-picker').hidden,true);assert.equal(ui.get('overlay-advice-body').hidden,false);
});

test('an unchanged periodic state preserves portrait buttons during a mouse click',()=>{
  const state=fixture(),ui=setup(state);ui.click('overlay-lane-ally');const choices=[...ui.get('overlay-picker-choices').children],tabs=[...ui.get('overlay-picker-tabs').children];
  ui.sandbox.update({...state,hero:{gameTime:123}});
  assert.ok(choices.every((button,index)=>ui.get('overlay-picker-choices').children[index]===button));assert.ok(tabs.every((button,index)=>ui.get('overlay-picker-tabs').children[index]===button));
});

test('showing a hidden overlay refreshes click areas and an open hotkey cannot close the previously hidden picker',()=>{
  const ui=setup();ui.hotkey();ui.document.visibilityState='hidden';ui.document.listeners.visibilitychange();assert.equal(ui.calls.areas.at(-1).length,0);
  ui.document.visibilityState='visible';ui.document.listeners.visibilitychange();assert.equal(ui.calls.areas.at(-1).length,5);ui.hotkey({mode:'open'});assert.equal(ui.get('overlay-lane-picker').hidden,false);
  ui.hotkey({mode:'toggle'});assert.equal(ui.get('overlay-lane-picker').hidden,true);
});

test('an outdated automatic opponent is not promoted into a manual pick, while an explicit manual opponent is retained',async()=>{
  const state=fixture();state.draftRoster.enemyHeroIds=[22,49,8,35];const ui=setup(state);ui.click('overlay-lane-enemy-2');await ui.choose(49);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls.patches)),[{laneEnemyHeroIds:[49]}]);
  const manual=fixture();manual.draftRoster.enemyHeroIds=[22,49,8,35];manual.settings.laneEnemyHeroIds=[2,22];const other=setup(manual);other.click('overlay-lane-enemy-2');await other.choose(49);
  assert.deepEqual(JSON.parse(JSON.stringify(other.calls.patches)),[{laneEnemyHeroIds:[2,49]}]);
});
