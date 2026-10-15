'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const NOW=200000;
function element(){return{textContent:'',hidden:false,title:'',style:{},children:[],classList:{toggle(){}},append(...nodes){this.children.push(...nodes);},prepend(node){this.children.unshift(node);},replaceChildren(...nodes){this.children=nodes;},addEventListener(){},remove(){}};}
function documentStub(){
  const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);};
  return{elements,get,document:{getElementById:get,createElement:element,body:element(),querySelectorAll:()=>[]}};
}
function fixture(){return{settings:{compact:true,captureEnabled:true,performanceMode:'economy'},connection:{status:'waiting'},hero:null,vision:{capturedAt:NOW,quality:{usable:true},player:{heroId:42,confirmed:true,source:'selected_hud',team:'radiant'}},laneRoster:{source:'screen_current',status:'confirmed',ally:{id:26,status:'confirmed',name:'Lion',image:'lion.png',confidence:.96},enemies:[{id:2,status:'confirmed',name:'Axe',image:'axe.png'},{id:22,status:'confirmed',name:'Zeus',image:'zeus.png'}]},advice:{stage:{id:'unknown',title:'Ожидаю матч'},action:{title:'Учитывай видимых героев',reason:'Проверяй окно атаки',tone:'neutral'},alternatives:[],lane:{detectionSource:'screen_current'},stageAdvice:{mainTitle:'Axe + Zeus',mainReason:'Короткие подходы',skillUseTitle:'Lion начинает контроль',skillUseReason:'Готовность проверь',extraTitle:'Сохраняй здоровье',extraReason:'Уровни неизвестны'}},laneOutcome:{result:'unknown'}};}

test('actual overlay renders the three observed portraits and identifies SCREEN independently of waiting GSI',()=>{
  const ui=documentStub(),sandbox={document:ui.document,Date:{now:()=>NOW},window:{coach:{onState(){},getState:()=>Promise.resolve(null)}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/overlay.js'),'utf8'),sandbox);
  sandbox.update(fixture());
  assert.equal(ui.get('overlay-ally-label').textContent,'СОЮЗНИК');assert.equal(ui.get('overlay-lane-status').textContent,'Рядом с WK');
  assert.equal(ui.get('live').textContent,'● SCREEN');assert.match(ui.get('source').textContent,/SCREEN.*ЖДЁТ GSI/);assert.equal(ui.get('stage-name').textContent,'ГЕРОИ РЯДОМ С WK');
  for(const [id,name]of[['overlay-lane-ally','Lion'],['overlay-lane-enemy-1','Axe'],['overlay-lane-enemy-2','Zeus']]){
    assert.equal(ui.get(id).children[0].alt,name);assert.match(ui.get(id).title,/исходный состав линии не подтверждён/);
  }
  assert.equal(ui.get('overlay-networth').textContent,'—');assert.equal(ui.get('time').textContent,'—:—');assert.equal(ui.get('stage-tips').hidden,false);assert.equal(ui.get('skill-use').textContent,'Lion начинает контроль');
});

test('changing evidence to an original lane restores teammate wording, and stale screen evidence stops the SCREEN status',()=>{
  const ui=documentStub(),sandbox={document:ui.document,Date:{now:()=>NOW},window:{coach:{onState(){},getState:()=>Promise.resolve(null)}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/overlay.js'),'utf8'),sandbox);
  const state=fixture();sandbox.update(state);state.laneRoster.source='screen_scene';state.advice.lane.detectionSource='screen_scene';state.vision.capturedAt=NOW-8000;
  sandbox.update(state);assert.equal(ui.get('overlay-ally-label').textContent,'НАПАРНИК');assert.match(ui.get('overlay-lane-ally').title,/вероятный напарник на линии/);assert.equal(ui.get('live').textContent,'WAITING');assert.equal(ui.get('source').textContent,'ОЖИДАЮ GSI И ЭКРАН');
});

test('static nearby matchup remains visible outside laning and does not show a plan for an unconfirmed original lane',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../src/renderer.js'),'utf8'),ui=documentStub();
  const firstLabel=element(),afterLane=element();ui.get('lane-advice-grid').querySelector=selector=>selector==='div:first-child .eyebrow'?firstLabel:afterLane;
  const sandbox={state:fixture(),$:ui.get,text:(id,value)=>{ui.get(id).textContent=value;},document:ui.document};
  vm.runInNewContext(source.slice(source.indexOf('function currentScreenLineup('),source.indexOf('\nfunction heroById(')),sandbox);
  vm.runInNewContext(source.slice(source.indexOf('function renderStages('),source.indexOf('\nfunction renderSkillBuild(')),sandbox);
  for(const id of ['unknown','midgame']){
    sandbox.state.advice.stage.id=id;sandbox.renderStages(sandbox.state.advice,sandbox.state.settings);
    assert.equal(ui.get('lane-advice-grid').hidden,false);assert.equal(ui.get('lane-stance').hidden,false);assert.equal(firstLabel.textContent,'ПРОТИВ ВИДИМЫХ ГЕРОЕВ');assert.equal(afterLane.hidden,true);assert.equal(ui.get('stage-skill-title').textContent,'Lion начинает контроль');
  }
  sandbox.state.laneRoster.source='screen_scene';sandbox.state.advice.lane.detectionSource='screen_scene';sandbox.renderStages(sandbox.state.advice,sandbox.state.settings);
  assert.equal(ui.get('lane-advice-grid').hidden,true);assert.equal(afterLane.hidden,false);
});

test('manual matchup preview keeps chosen hero advice visible without an inferred stage or post-lane plan',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../src/renderer.js'),'utf8'),ui=documentStub(),firstLabel=element(),afterLane=element();
  ui.get('lane-advice-grid').querySelector=selector=>selector==='div:first-child .eyebrow'?firstLabel:afterLane;
  const state=fixture();state.laneRoster.source='manual';state.advice.lane.detectionSource='manual';
  const sandbox={state,$:ui.get,text:(id,value)=>{ui.get(id).textContent=value;},document:ui.document};
  vm.runInNewContext(source.slice(source.indexOf('function currentScreenLineup('),source.indexOf('\nfunction heroById(')),sandbox);
  vm.runInNewContext(source.slice(source.indexOf('function renderStages('),source.indexOf('\nfunction renderSkillBuild(')),sandbox);
  for(const preview of [{manualOnly:true,source:'unknown'},{manualOnly:false,source:'manual_matchup'}]){
    state.advice.manualOnly=preview.manualOnly;state.advice.stage={id:'unknown',source:preview.source};sandbox.renderStages(state.advice,state.settings);
    assert.equal(ui.get('lane-advice-grid').hidden,false);assert.equal(ui.get('lane-stance').hidden,false);assert.equal(firstLabel.textContent,'ПРОТИВ ВЫБРАННЫХ ГЕРОЕВ');assert.equal(afterLane.hidden,true);assert.equal(ui.get('lane-advice-grid').style.gridTemplateColumns,'1fr');
  }
  state.advice.manualOnly=false;state.advice.stage={id:'laning',source:'gsi'};sandbox.renderStages(state.advice,state.settings);
  assert.equal(firstLabel.textContent,'НА ЛИНИИ');assert.equal(afterLane.hidden,false);assert.equal(ui.get('lane-advice-grid').hidden,false);
  state.advice.stage.id='midgame';sandbox.renderStages(state.advice,state.settings);assert.equal(ui.get('lane-advice-grid').hidden,true);
});
