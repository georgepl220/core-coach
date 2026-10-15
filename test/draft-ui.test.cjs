'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),DraftUI=require('../src/draft-ui.js');
function fixture(){return{heroes:[{id:42,name:'Wraith King',image:'wk.png'},{id:8,name:'Juggernaut',image:'jugg.png'},{id:18,name:'Sven'},{id:44,name:'Phantom Assassin'},{id:48,name:'Luna'},{id:26,name:'Lion'},{id:2,name:'Axe'},{id:22,name:'Zeus'}],settings:{draftPositionId:1,draftPreferredHeroIds:[42]},draft:{active:true,phase:'pick',positionId:1,allyHeroIds:[26],enemyHeroIds:[2,22],bannedHeroIds:[],recommendations:[{heroId:42,name:'Wraith King',score:71,fitLabel:'Хороший вариант',reasons:['Контроль помогает союзнику.','Команда получает фронтлайн.'],risks:['Мало информации о линии.'],confidence:'low',sampleCount:null}],stats:{providerId:'rules',scope:'Правила героев · статистика не загружена',message:'Нужен токен STRATZ'},summary:'Предварительно: известны три героя.'}};}
function dom(){
  const document={createElement(tag){return element(tag);}};
  function element(tag='div'){
    const listeners={},children=[];const el={ownerDocument:document,tagName:tag.toUpperCase(),className:'',children,textContent:'',hidden:false,dataset:{},disabled:false,attributes:{},listeners,append(...items){children.push(...items);},replaceChildren(...items){children.splice(0,children.length,...items);},addEventListener(type,callback){listeners[type]=callback;},setAttribute(name,value){this.attributes[name]=value;},replaceWith(){},getBoundingClientRect(){return this.className.includes('draft-position-buttons')?{x:210,y:30,width:145,height:22}:this.className.includes('draft-catalog')?{x:24,y:170,width:330,height:254}:{x:24,y:50,width:330,height:29};},querySelectorAll(selector){const found=[];function visit(node){for(const child of node.children){if(selector==='button'&&child.tagName==='BUTTON')found.push(child);visit(child);}}visit(this);return found;}};
    el.classList={add(...names){el.className=[...new Set([...el.className.split(' ').filter(Boolean),...names])].join(' ');},contains(name){return el.className.split(' ').includes(name);},toggle(name,value){const names=el.className.split(' ').filter(Boolean),at=names.indexOf(name);if(value&&at<0)names.push(name);else if(!value&&at>=0)names.splice(at,1);el.className=names.join(' ');}};
    return el;
  }
  return element();
}
function find(root,className){if(root.classList.contains(className))return root;for(const child of root.children){const found=find(child,className);if(found)return found;}return null;}
function setup(compact=true){let state=fixture();const container=dom(),patches=[],commands=[];let controller;
  controller=DraftUI.create(container,{compact,updateSettings:async patch=>{patches.push(patch);state={...state,settings:{...state.settings,...patch},draft:{...state.draft}};for(const[setting,field]of[['draftAllyHeroIds','allyHeroIds'],['draftEnemyHeroIds','enemyHeroIds'],['draftBannedHeroIds','bannedHeroIds'],['draftPositionId','positionId']])if(patch[setting])state.draft[field]=patch[setting];return state;},command:async name=>{commands.push(name);return state;},applyState:next=>{state=next;controller.render(next);}});controller.render(state);return{container,controller,patches,commands,state:()=>state};}

test('draft manual correction swaps same-team duplicates and removes cross-team conflicts without inventing missing slots',()=>{
  const state=fixture();assert.deepEqual(DraftUI.rosterPatch(state,'enemy',1,2),{draftEnemyHeroIds:[22,2]});
  assert.deepEqual(DraftUI.rosterPatch(state,'enemy',4,26),{draftEnemyHeroIds:[2,22,26],draftAllyHeroIds:[]});
  assert.equal(DraftUI.rosterPatch({...state,draft:{...state.draft,ownHeroId:42,locked:true}},'enemy',0,42),null);
});
test('bans are reversible and a locked own hero is never selectable as an opponent',()=>{
  const state=fixture();state.draft.bannedHeroIds=[42];assert.deepEqual(DraftUI.rosterPatch(state,'bans',0,42),{draftBannedHeroIds:[]});
  assert.deepEqual(DraftUI.rosterPatch(state,'bans',0,2),{draftBannedHeroIds:[42,2],draftEnemyHeroIds:[22]});
});
test('locked draft keeps the chosen supported carry first and deduplicates comparison alternatives',()=>{
  const state=fixture(),chosen={heroId:8,name:'Juggernaut',score:63};state.draft={...state.draft,locked:true,ownHeroId:8,chosenRecommendation:chosen,recommendations:[state.draft.recommendations[0],chosen,{heroId:48,name:'Luna',score:61}]};
  assert.deepEqual(DraftUI.recommendationsFor(state.draft).map(rec=>rec.heroId),[8,42,48]);
  const container=dom(),controller=DraftUI.create(container,{compact:true});controller.render(state);assert.equal(find(container,'draft-matchup-label').textContent,'Твой выбор');const cards=find(container,'draft-recommendations').children;assert.equal(find(cards[0],'draft-rec-rank').textContent,'✓');assert.equal(find(cards[1],'draft-rec-rank').textContent,'1');
});
test('search and pagination cover every catalog hero for each manually selected position',()=>{
  const state=fixture();state.heroes=Array.from({length:127},(_,i)=>({id:i+1,name:`Hero ${String(i).padStart(3,'0')}`}));
  const seen=[];for(let i=0;i<9;i++)seen.push(...DraftUI.pages(state,'','enemy',i).heroes.map(hero=>hero.id));assert.equal(new Set(seen).size,127);assert.equal(seen.length,127);
  assert.deepEqual(DraftUI.catalog(fixture(),'wraith').map(hero=>hero.id),[42]);for(const position of DraftUI.positions)assert.equal(DraftUI.catalog({...state,draft:{...state.draft,positionId:position.id}}).length,127);
});
test('compact draft controller saves a hero with a single portrait click and restores concise recommendation cards',async()=>{
  const ui=setup();ui.controller.openPicker('enemy',1);assert.equal(ui.controller.isPickerOpen(),true);
  const choices=find(ui.container,'draft-catalog-grid');await choices.children.find(el=>el.dataset.heroId==='8').listeners.click();
  assert.deepEqual(ui.patches,[{draftEnemyHeroIds:[2,8]}]);assert.equal(ui.controller.isPickerOpen(),false);assert.equal(find(ui.container,'draft-recommendations').hidden,false);
  assert.equal(find(ui.container,'draft-score'),null);assert.equal(find(ui.container,'draft-role-winrate').textContent,'Нет WR на позиции');assert.equal(find(ui.container,'draft-matchup-label').textContent,'Мало данных');
});
test('periodic state updates keep choice buttons and compact picker reports a bounded interactive rectangle',()=>{
  const ui=setup();ui.controller.openPicker('enemy',0);const choices=find(ui.container,'draft-catalog-grid'),before=[...choices.children];ui.controller.render({...ui.state(),hero:{gameTime:0}});
  assert.ok(before.every((node,index)=>choices.children[index]===node));const areas=ui.controller.hitAreas();assert.equal(areas.length,2);assert.ok(areas.reduce((sum,area)=>sum+area.width*area.height,0)<90000);
  ui.controller.togglePicker();assert.equal(ui.controller.isPickerOpen(),false);assert.equal(ui.controller.hitAreas().length,4);
});
test('compact unknown-side controls set the user team and disappear after side is confirmed',async()=>{
  const ui=setup(),tools=find(ui.container,'draft-tools'),radiant=tools.children.find(el=>el.textContent==='Radiant'),dire=tools.children.find(el=>el.textContent==='Dire');assert.equal(radiant.hidden,false);assert.equal(dire.hidden,false);await radiant.listeners.click();assert.deepEqual(ui.patches,[{draftOwnTeam:'radiant'}]);
  ui.controller.render({...ui.state(),draft:{...ui.state().draft,ownTeam:'radiant'}});assert.equal(radiant.hidden,true);assert.equal(dire.hidden,true);assert.equal(ui.controller.hitAreas().length,4);
});
test('draft errors preserve the picker and phase changes close it without relabeling other candidates as the selected hero',async()=>{
  const container=dom(),state=fixture(),controller=DraftUI.create(container,{compact:true,updateSettings:async()=>{throw new Error('Нет связи');}});controller.render(state);controller.openPicker('enemy',0);await find(container,'draft-catalog-grid').children[0].listeners.click();
  assert.equal(controller.isPickerOpen(),true);assert.match(find(container,'draft-status').textContent,/Нет связи/);
  controller.render({...state,draft:{...state.draft,phase:'strategy',locked:true,ownHeroId:8}});assert.equal(controller.isPickerOpen(),false);assert.notEqual(find(container,'draft-matchup-label').textContent,'Твой выбор');assert.equal(find(container,'draft-rec-identity').children[0].textContent,'Wraith King');
});
test('main and overlay position selectors offer all five positions without pool or comfort side effects',async()=>{
  for(const compact of [false,true]){
    const ui=setup(compact),buttons=find(ui.container,'draft-position-buttons');assert.equal(buttons.children.length,5);
    assert.equal(find(ui.container,'draft-comfort'),null);assert.ok(!ui.container.querySelectorAll('button').some(button=>button.textContent==='Мой пул'));
    for(const position of DraftUI.positions){await find(ui.container,'draft-position-buttons').children.find(button=>Number(button.dataset.positionId)===position.id).listeners.click();assert.equal(ui.state().draft.positionId,position.id);assert.equal(find(ui.container,'draft-position-buttons').children.find(button=>Number(button.dataset.positionId)===position.id).attributes['aria-pressed'],'true');}
    assert.deepEqual(ui.patches,DraftUI.positions.map(position=>({draftPositionId:position.id})));assert.deepEqual(ui.state().settings.draftPreferredHeroIds,[42]);assert.deepEqual(ui.commands,[]);
    ui.controller.openPicker('enemy',0);assert.equal(find(ui.container,'draft-picker-tabs').children.length,3);assert.ok(!find(ui.container,'draft-picker-tabs').children.some(button=>button.textContent==='Мой пул'));
  }
});
test('main draft preview keeps technical source data out of the card view and preserves detection counts',()=>{
  const ui=setup(false);
  assert.equal(find(ui.container,'draft-source').hidden,true);assert.match(find(ui.container,'draft-explanation').textContent,/Близкие варианты могут быть равноценны/);assert.deepEqual(ui.commands,[]);
  ui.controller.render({...ui.state(),draft:{...ui.state().draft,detection:{source:'screen',confidence:.94,message:'Портреты подтверждены'}}});assert.equal(find(ui.container,'draft-detection').textContent,'Нажми портрет, чтобы исправить состав.');assert.match(find(ui.container,'draft-detection').title,/1\/5 союзников · 2\/5 врагов · экран · 94%/);
});
test('clean card explains a high-role-WR hero with hostile pairs without pretending that its matchup is good',()=>{
  const state=fixture(),rec=state.draft.recommendations[0];Object.assign(rec,{score:42.3,positionId:1,roleFiltered:true,baselineWinRate:.585,baselineGames:2991,scoreBreakdown:{initial:50,baseline:8.2,enemies:-12.4,allies:-3.5,total:42.3},matchupEvidence:Array.from({length:8},(_,index)=>({heroId:100+index,name:`Pair ${index+1}`,side:index<5?'enemy':'ally',games:1000+index,wins:450,rawWinRate:.45,advantagePp:-2-index,contribution:-.5-index/10,roleFiltered:false,shrink:.9,scopeWeight:.5,nativeAdjusted:true}))});
  const container=dom(),controller=DraftUI.create(container);controller.render(state);
  assert.equal(find(container,'draft-role-winrate').textContent,'58,5% на керри');assert.equal(find(container,'draft-matchup-label').textContent,'Есть риск');assert.match(find(container,'draft-why').textContent,/WR на роли выше 50%, но драфт неудобен/);assert.match(find(container,'draft-risk').textContent,/Pair 5 и Pair 4/);assert.match(find(container,'draft-risk').title,/Pair 8/);
  for(const className of['draft-score','draft-breakdown','draft-pair-summary','draft-pair-details','draft-rec-confidence'])assert.equal(find(container,className),null);
});
test('statistical explanations distinguish verified positions, estimated positions and broad baselines',()=>{
  const rec={positionId:2,baselineWinRate:.55,baselineGames:1500};assert.match(DraftUI.baselineText(rec),/^Все позиции/);assert.match(DraftUI.baselineText({...rec,positionEstimated:true}),/^Позиция оценена/);assert.match(DraftUI.baselineText({...rec,roleFiltered:true}),/^Позиция 2/);
  assert.equal(DraftUI.breakdownText({score:80}), '');assert.equal(DraftUI.baselineText({baselineWinRate:null,baselineGames:1500}), '');assert.equal(DraftUI.matchupSummary({matchupEvidence:[{side:'enemy',advantagePp:0,contribution:0},{side:'ally',advantagePp:1,contribution:.5}]}),'Пары хуже нормы: враги 0/1 · союзники 0/1');
});
test('source date describes the sample period separately from the fetch date',()=>{
  const source=DraftUI.statsDates({observedThrough:'2026-10-10T00:00:00Z',updatedAt:'2026-10-14T12:00:00Z'});assert.match(source.label,/Выборка по 10\.10\.2026/);assert.doesNotMatch(source.label,/14\.10\.2026/);assert.match(source.title,/Загружено: 14\.10\.2026/);
  assert.equal(DraftUI.statsDates({observedThrough:'invalid',updatedAt:'invalid'}).label,'');assert.equal(DraftUI.statsDates({updatedAt:'2026-10-14T12:00:00Z'}).label,'Загружено 14.10.2026');
});
test('rank selection defaults to all and saves a cohort without starting a network refresh',async()=>{
  const ui=setup(false),select=find(ui.container,'draft-rank');assert.equal(select.value,'all');assert.equal(select.children.length,5);assert.equal(select.children[0].textContent,'Все рейтинги');assert.match(DraftUI.scopeText({patch:null,rank:null}),/Рейтинг не подтверждён/);
  select.value='DIVINE_IMMORTAL';await select.listeners.change();assert.deepEqual(ui.patches,[{draftRankId:'DIVINE_IMMORTAL'}]);assert.equal(ui.state().settings.draftRankId,'DIVINE_IMMORTAL');assert.deepEqual(ui.commands,[]);
  assert.equal(DraftUI.rankId({settings:{draftRankId:'FILTERED'}}),'all');
});
test('refresh controls identify the selected cohort and allow queuing it behind another cohort',()=>{
  const ui=setup(false),button=find(ui.container,'draft-tools').children.find(el=>el.textContent==='Обновить данные');
  const render=stats=>ui.controller.render({...ui.state(),settings:{...ui.state().settings,draftRankId:'DIVINE_IMMORTAL'},draft:{...ui.state().draft,stats}});
  render({requestedRankId:'DIVINE_IMMORTAL',refreshingRankId:'LEGEND_ANCIENT',anyRefreshing:true,status:'unavailable',message:'Нет статистики выбранного рейтинга.'});assert.equal(button.disabled,false);assert.equal(button.textContent,'Поставить в очередь');assert.match(find(ui.container,'draft-status').textContent,/Загружается другой рейтинг: Легенда \/ Властелин/);
  render({requestedRankId:'DIVINE_IMMORTAL',refreshingRankId:'LEGEND_ANCIENT',pendingRankId:'DIVINE_IMMORTAL',refreshQueued:true,status:'queued',message:'Выборка в очереди.'});assert.equal(button.disabled,true);assert.equal(button.textContent,'В очереди');assert.match(find(ui.container,'draft-status').textContent,/Выбранный рейтинг в очереди: Божество \/ Титан/);
  render({requestedRankId:'DIVINE_IMMORTAL',refreshingRankId:'DIVINE_IMMORTAL',refreshing:true,status:'refreshing',message:'Обновляю STRATZ.'});assert.equal(button.disabled,true);assert.equal(button.textContent,'Обновляю данные');assert.match(button.title,/Загружается выбранный рейтинг: Божество \/ Титан/);
});
test('selected cohort errors remain visible ahead of unrelated progress and missing WR remains explicit',()=>{
  const stats={requestedRankId:'DIVINE_IMMORTAL',refreshingRankId:'LEGEND_ANCIENT',status:'error',errorCode:'HTTP_401',message:'STRATZ: токен отклонён (HTTP 401).'};
  assert.match(DraftUI.sourceStatus(stats),/^Токен отклонён/);assert.match(DraftUI.sourceStatus(stats),/Загружается другой рейтинг/);assert.doesNotMatch(DraftUI.sourceStatus(stats),/STRATZ/);
  const ui=setup(false);ui.controller.render({...ui.state(),draft:{...ui.state().draft,stats,status:'Ожидаю статистику.'}});assert.match(find(ui.container,'draft-status').textContent,/^Токен отклонён/);
  assert.equal(DraftUI.coverageText({dataCoverage:{baseline:{available:false,used:false},enemies:{known:2,used:2}}}),'Базы WR нет · Учтено: враги 2/2');assert.equal(DraftUI.coverageText({dataCoverage:{baseline:{available:true,used:false},enemies:{known:2,used:2}}}),'WR не учтён · Учтено: враги 2/2');
});
test('exclusive UTC observation bound displays the final included sample day',()=>{
  const components={baseline:{observedFrom:'2026-10-01T00:00:00Z',observedThrough:'2026-10-11T00:00:00Z',observedThroughKind:'exclusive_period_end'},pairs:{observedThrough:null}};
  assert.match(DraftUI.statsDates({components}).label,/База по 10\.10\.2026/);
  assert.doesNotMatch(DraftUI.statsDates({components}).label,/11\.10/);
});
test('verified weekly interval is shown without inventing a last-match observation date',()=>{
  const components={baseline:{observedThrough:'2026-10-10T00:00:00Z'},pairs:{observedThrough:null,status:'unknown',periodBoundsVerified:true,periodMethod:'stratz_unix_week_roundtrip',periodStart:'2026-10-08T00:00:00Z',periodEndExclusive:'2026-10-15T00:00:00Z',periodPartial:true}};
  const display=DraftUI.statsDates({components,updatedAt:'2026-10-14T15:00:00Z'});
  assert.match(display.label,/пары: неделя с 08\.10\.2026/);assert.doesNotMatch(display.label,/по 14\.10|по 15\.10/);
  assert.match(display.title,/время последнего матча неизвестно/);assert.match(display.title,/при загрузке неделя ещё не завершилась/);
});
test('technical data diagnostics remain available to helpers without cluttering the default cards',()=>{
  const state=fixture(),rec=state.draft.recommendations[0];rec.score=51.249;rec.dataCoverage={baseline:{available:true,used:true,games:1000},enemies:{known:5,used:3,missing:1,lowSample:1,rejected:0},allies:{known:3,used:1,missing:0,lowSample:0,rejected:2}};rec.dataFreshness={baseline:{observedThrough:'2026-10-10T00:00:00Z',scope:{patch:'7.40',rank:'DIVINE_IMMORTAL',role:'POSITION_1'},weight:.5},pairs:{observedThrough:null,roleFiltered:false,scope:{patch:null,rank:'DIVINE_IMMORTAL',role:null},weight:.2}};rec.comparison={status:'unproven',closeScore:true,nearestGap:.08,threshold:.5};
  const container=dom(),controller=DraftUI.create(container);controller.render(state);
  for(const className of['draft-score','draft-coverage','draft-freshness','draft-comparison','draft-pair-table'])assert.equal(find(container,className),null);
  assert.equal(DraftUI.coverageText(rec),'Учтено: враги 3/5 · союзники 1/3');assert.match(DraftUI.coverageTitle(rec),/малая выборка 1/);assert.match(DraftUI.coverageTitle(rec),/отклонено 2/);assert.match(DraftUI.freshnessText(rec),/База по 10\.10 · пары: период неизвестен/);assert.match(DraftUI.freshnessTitle(rec),/Патч неизвестен/);assert.match(DraftUI.freshnessTitle(rec),/позиции пары смешаны/);assert.match(DraftUI.comparisonTitle(rec),/не доверительный интервал/);assert.equal(DraftUI.presentation(rec,state.draft).limited,true);
  const dates=DraftUI.statsDates({updatedAt:'2026-10-14T12:00:00Z',components:rec.dataFreshness});assert.match(dates.label,/пары: период неизвестен/);assert.doesNotMatch(dates.label,/14\.10/);assert.match(dates.title,/Загружено: 14\.10\.2026/);
});
test('main view renders five readable alternatives with role WR, named reasons and risks, without source brands or scores',()=>{
  const state=fixture();state.draft.recommendations=[42,8,18,44,48].map((heroId,index)=>({heroId,name:state.heroes.find(hero=>hero.id===heroId).name,score:90-index,positionId:1,roleFiltered:true,baselineWinRate:.558,baselineGames:1000,reasons:['STRATZ: raw internal reason'],risks:['OpenDota internal risk'],matchupEvidence:[{heroId:2,name:'Axe',side:'enemy',advantagePp:3,contribution:1.2},{heroId:22,name:'Zeus',side:'enemy',advantagePp:2,contribution:.6},{heroId:26,name:'Lion',side:'ally',advantagePp:1,contribution:.3}]}));
  const container=dom(),controller=DraftUI.create(container);controller.render(state);const cards=find(container,'draft-recommendations').children;assert.equal(cards.length,5);
  for(const[at,card]of cards.entries()){assert.equal(find(card,'draft-rec-rank').textContent,String(at+1));assert.equal(find(card,'draft-role-winrate').textContent,'55,8% на керри');assert.equal(find(card,'draft-matchup-label').textContent,'Есть плюсы');assert.match(find(card,'draft-why').textContent,/Axe и Zeus/);assert.match(find(card,'draft-why').textContent,/Lion/);assert.match(find(card,'draft-risk').textContent,/Явных минусов/);assert.equal(find(card,'draft-score'),null);}
  const visible=node=>node.hidden?'':[node.textContent,...node.children.map(visible)].join(' ');assert.doesNotMatch(visible(container),/STRATZ|OpenDota|\/\s*100|п\.п\.|1000 матч|вклад|сглажен/i);assert.ok(container.querySelectorAll('button').some(button=>button.textContent==='Обновить данные'));
});
test('presentation distinguishes missing role WR, missing draft context and weak signals from favorable matchups',()=>{
  const baseline={baselineWinRate:.6,baselineGames:1000,roleFiltered:true,positionId:1};assert.equal(DraftUI.presentation(baseline).label,'До пиков');assert.match(DraftUI.presentation(baseline).why,/ориентир — WR/);assert.equal(DraftUI.presentation(baseline).risk,'Пики ещё могут изменить выбор.');assert.equal(DraftUI.presentation(baseline,{enemyHeroIds:[2]}).label,'Мало данных');
  const broad=DraftUI.presentation({...baseline,roleFiltered:false});assert.equal(broad.baselineSummary,'Нет WR на позиции');assert.equal(DraftUI.presentation({...baseline,roleFiltered:false,positionEstimated:true}).baselineSummary,'60,0% · роль оценена');
  const tiny=DraftUI.presentation({...baseline,matchupEvidence:[{heroId:2,name:'Axe',side:'enemy',advantagePp:.01,contribution:.001,displayRelevant:false}]},{enemyHeroIds:[2]});assert.equal(tiny.label,'Нет явного плюса');assert.doesNotMatch(tiny.why,/Лучше против/);
  const mixed=DraftUI.presentation({...baseline,draftAssessment:{status:'mixed',enemies:{known:2,netContribution:1},allies:{known:0,netContribution:0}},matchupEvidence:[{heroId:2,name:'Axe',side:'enemy',advantagePp:3,contribution:2},{heroId:22,name:'Zeus',side:'enemy',advantagePp:-1,contribution:-1}]},{enemyHeroIds:[2,22]});assert.equal(mixed.label,'Есть риск');assert.match(mixed.why,/Лучше против Axe/);assert.match(mixed.risk,/Zeus/);
});
test('hidden tiny enemy disadvantages do not contradict a visible positive ally signal',()=>{
  const rec={roleFiltered:true,positionId:1,baselineWinRate:.55,baselineGames:10000,scoreBreakdown:{enemies:-.0001,allies:1},matchupEvidence:[{heroId:2,name:'Axe',side:'enemy',advantagePp:-.01,contribution:-.0001,displayRelevant:false},{heroId:26,name:'Lion',side:'ally',advantagePp:2,contribution:1,displayRelevant:true}]},draft={enemyHeroIds:[2],allyHeroIds:[26]};
  for(const candidate of[rec,{...rec,draftAssessment:{status:'favorable',enemies:{known:1,netContribution:-.0001,hasDirectionalSignal:false},allies:{known:1,netContribution:1,hasDirectionalSignal:true},missingPairs:0}}]){const view=DraftUI.presentation(candidate,draft);assert.equal(view.label,'Есть плюсы');assert.equal(view.tone,'positive');assert.equal(view.why,'Сочетается с Lion.');assert.doesNotMatch(view.why,/драфт неудобен/);assert.doesNotMatch(view.risk,/Axe/);assert.match(view.risk,/Явных минусов/);}
});
test('neutral incomplete evidence stays unknown and partial positive evidence is described without overstating it',()=>{
  const baseline={roleFiltered:true,positionId:1,baselineWinRate:.55,baselineGames:1000},tiny={heroId:2,name:'Axe',side:'enemy',advantagePp:-.01,contribution:-.001,displayRelevant:false};
  const neutral=DraftUI.presentation({...baseline,matchupEvidence:[tiny],draftAssessment:{status:'neutral',enemies:{known:2,netContribution:-.001,hasDirectionalSignal:false},allies:{known:0,netContribution:0,hasDirectionalSignal:false},missingPairs:1}},{enemyHeroIds:[2,22]});assert.equal(neutral.label,'Мало данных');assert.equal(neutral.tone,'unknown');assert.doesNotMatch(neutral.why,/драфт неудобен/);assert.match(neutral.risk,/Не все сочетания/);
  const partial=DraftUI.presentation({...baseline,matchupEvidence:[{heroId:2,name:'Axe',side:'enemy',advantagePp:2,contribution:.7,displayRelevant:true}],draftAssessment:{status:'favorable',enemies:{known:2,netContribution:.7,hasDirectionalSignal:true},allies:{known:0,netContribution:0,hasDirectionalSignal:false},missingPairs:1}},{enemyHeroIds:[2,22]});assert.equal(partial.label,'Есть плюсы');assert.equal(partial.limited,true);assert.match(partial.risk,/Не все сочетания/);
});
test('five recommendation slots exclude duplicate heroes while preserving the original ranking order',()=>{
  const recs=[42,8,18,44,48,26].map(heroId=>({heroId}));assert.deepEqual(DraftUI.recommendationsFor({recommendations:[recs[0],recs[0],...recs.slice(1)]}).map(rec=>rec.heroId),[42,8,18,44,48]);assert.equal(DraftUI.plainText('Статистика STRATZ обновлена.'),'Статистика обновлена.');
});
test('gameplay overlay keeps only lane correction and never renders draft recommendations',()=>{
  const state=fixture();Object.assign(state,{connection:{status:'waiting'},activeProfile:{heroId:42,name:'Wraith King'},hero:null,laneRoster:{enemies:[]},advice:{action:{title:'Фарм',reason:'Пример',tone:'neutral'},stage:{id:'laning',title:'Лайнинг'},skills:{},alternatives:[]}});state.settings.compact=true;
  const body=dom(),document=body.ownerDocument,elements=new Map();document.body=body;document.visibilityState='visible';document.getElementById=id=>{if(!elements.has(id)){const el=document.createElement('div');el.id=id;elements.set(id,el);}return elements.get(id);};document.listeners={};document.addEventListener=(type,callback)=>{document.listeners[type]=callback;};let hotkey;const areas=[];
  const coach={onState(){},getState:async()=>state,setOverlayHitAreas:value=>areas.push(value),onOverlayPicker:callback=>{hotkey=callback;},notifyOverlayPointer(){},updateSettings:async()=>state,command:async()=>state};
  const sandbox={document,Date,console,window:{coach,DraftUI,LanePicker:require('../src/lane-picker.js'),addEventListener(){}}};vm.runInNewContext(fs.readFileSync(require.resolve('../src/overlay.js'),'utf8'),sandbox);sandbox.update(state);
  assert.equal(body.classList.contains('draft-active'),false);assert.equal(elements.has('overlay-draft'),false);assert.equal(document.getElementById('action-title').textContent,'Фарм');assert.equal(document.getElementById('stage-name').textContent,'Лайнинг');
  hotkey({mode:'toggle'});assert.equal(document.getElementById('overlay-lane-picker').hidden,false);assert.equal(areas.at(-1).length,5);
  sandbox.update({...state,draft:{...state.draft,active:false,phase:'inactive'}});assert.equal(elements.has('overlay-draft'),false);assert.equal(document.getElementById('action-title').textContent,'Фарм');
  const html=fs.readFileSync(require.resolve('../src/overlay.html'),'utf8');assert.doesNotMatch(html,/draft-ui|overlay-draft/);
});
