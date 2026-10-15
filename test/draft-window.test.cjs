'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),DraftUI=require('../src/draft-ui.js');
function fixture(){
  const heroes=[{id:42,name:'Wraith King',image:'wk.png'},{id:8,name:'Juggernaut',image:'jugg.png'},{id:18,name:'Sven'},{id:44,name:'Phantom Assassin'},{id:48,name:'Luna'},{id:6,name:'Drow Ranger'},{id:26,name:'Lion'},{id:2,name:'Axe'},{id:22,name:'Zeus'}];
  const candidates=[42,8,18,44,48,6].map((heroId,index)=>({heroId,name:heroes.find(hero=>hero.id===heroId).name,score:70-index,fitLabel:'Хорошо подходит',reasons:['Причина по известному составу.','Статистическая пара.'],risks:['Неизвестны роли соперников.'],confidence:'low',sampleCount:123,sampleLabel:'Наименьшая выборка пары'}));
  return{heroes,settings:{draftPositionId:1},overlayEditing:false,draft:{active:true,phase:'pick',windowVisible:true,positionId:1,ownTeam:'radiant',source:'screen',allyHeroIds:[26],enemyHeroIds:[2,22],bannedHeroIds:[],recommendations:candidates.slice(0,5),candidates,confidence:'low',sourceLabel:'OpenDota + авторские правила',scopeLabel:'Все ранги · роль не подтверждена',stats:{providerId:'opendota',updatedAt:'2026-10-13T12:00:00Z',message:'Выборка не отфильтрована по роли.'}}};
}
function setup(initial=fixture(),overrides={}){
  const document={visibilityState:'visible',listeners:{},createElement:tag=>element(tag),addEventListener(type,callback){this.listeners[type]=callback;},querySelectorAll(selector){return [...elements.values()].flatMap(root=>collect(root,selector));}};
  function element(tag='div'){
    const el={tagName:tag.toUpperCase(),id:'',ownerDocument:document,className:'',children:[],textContent:'',hidden:false,dataset:{},disabled:false,attributes:{},listeners:{},value:'',append(...items){this.children.push(...items);},replaceChildren(...items){this.children=[...items];},addEventListener(type,callback){this.listeners[type]=callback;},setAttribute(name,value){this.attributes[name]=value;},replaceWith(){},focus(){this.focused=true;},blur(){this.focused=false;},getBoundingClientRect(){if(this.hidden)return{x:0,y:0,width:0,height:0};const rects={'draft-header-actions':{x:650,y:25,width:180,height:27},'draft-position-buttons':{x:27,y:186,width:450,height:28},'draft-allies':{x:27,y:118,width:385,height:42},'draft-enemies':{x:435,y:118,width:385,height:42},'draft-tools':{x:500,y:186,width:320,height:28},'draft-catalog':{x:27,y:89,width:806,height:373},'draft-source':{x:27,y:476,width:200,height:16},'draft-side':{x:27,y:230,width:550,height:28}};return rects[this.id]||{x:27,y:240,width:120,height:30};}};
    el.classList={contains:name=>el.className.split(' ').includes(name),toggle(name,value){const names=new Set(el.className.split(' ').filter(Boolean));if(value)names.add(name);else names.delete(name);el.className=[...names].join(' ');}};
    return el;
  }
  function collect(el,selector){const result=[];for(const child of el.children){if(selector==='button'&&child.tagName==='BUTTON')result.push(child);result.push(...collect(child,selector));}return result;}
  const elements=new Map();document.getElementById=id=>{if(!elements.has(id)){const el=element(id==='draft-search'?'input':id.includes('button')?'div':'div');el.id=id;elements.set(id,el);}return elements.get(id);};document.body=element();let state=initial,hotkey;const patches=[],commands=[],areas=[];
  const coach={getState:async()=>state,onState(callback){this.push=callback;},onOverlayPicker(callback){hotkey=callback;},setOverlayHitAreas:value=>areas.push(value),notifyOverlayPointer(){},updateSettings:async patch=>{patches.push(patch);state={...state,settings:{...state.settings,...patch},draft:{...state.draft}};for(const[setting,field]of[['draftAllyHeroIds','allyHeroIds'],['draftEnemyHeroIds','enemyHeroIds'],['draftBannedHeroIds','bannedHeroIds'],['draftOwnTeam','ownTeam'],['draftPositionId','positionId']])if(patch[setting]!==undefined)state.draft[field]=patch[setting];return state;},command:async(name,value)=>{commands.push({name,value});return{ok:true};},...overrides};
  const window={document,coach,DraftUI,addEventListener(){}};vm.runInNewContext(fs.readFileSync(require.resolve('../src/draft-window.js'),'utf8'),{window,Date,console});window.draftWindowUI.render(state);
  return{window,ui:window.draftWindowUI,document,elements,$:id=>document.getElementById(id),patches,commands,areas,state:()=>state,hotkey:payload=>hotkey(payload)};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const nodes=el=>[el,...el.children.flatMap(nodes)];
const findClass=(el,name)=>nodes(el).find(item=>item.classList.contains(name));
const texts=el=>nodes(el).map(item=>[item.textContent,item.title,item.attributes['aria-label']].filter(Boolean).join(' ')).join(' ');
test('draft overlay position buttons persist all five positions without changing rosters',async()=>{
  const app=setup(),initialAllies=[...app.state().draft.allyHeroIds],initialEnemies=[...app.state().draft.enemyHeroIds];
  for(const id of [2,3,4,5,1]){await app.$('draft-position-buttons').children.find(el=>el.dataset.positionId===String(id)).listeners.click();await settle();assert.equal(app.state().draft.positionId,id);assert.equal(app.$('draft-position-buttons').children.find(el=>el.attributes['aria-pressed']==='true').dataset.positionId,String(id));assert.deepEqual(app.state().draft.allyHeroIds,initialAllies);assert.deepEqual(app.state().draft.enemyHeroIds,initialEnemies);}
  assert.deepEqual(app.patches.map(patch=>patch.draftPositionId),[2,3,4,5,1]);
});
test('overlay rank controls stay inside source details and never request search focus or a refresh',async()=>{
  const app=setup();assert.equal(app.$('draft-details').hidden,true);app.$('draft-source').listeners.click();assert.equal(app.$('draft-details').hidden,false);
  assert.equal(app.$('draft-rank-buttons').children.length,5);assert.equal(app.$('draft-rank-buttons').children.find(el=>el.attributes['aria-pressed']==='true').dataset.rankId,'all');assert.equal(app.$('draft-rank-buttons').children.find(el=>el.dataset.rankId==='all').textContent,'Все рейтинги');
  await app.$('draft-rank-buttons').children.find(el=>el.dataset.rankId==='LEGEND_ANCIENT').listeners.click();await settle();assert.equal(app.patches.length,1);assert.equal(app.patches[0].draftRankId,'LEGEND_ANCIENT');assert.equal(app.$('draft-rank-buttons').children.find(el=>el.attributes['aria-pressed']==='true').dataset.rankId,'LEGEND_ANCIENT');
  assert.equal(app.ui.hitAreas().length,3);assert.ok(!app.commands.some(command=>command.name==='draft-refresh'||command.name==='draft-search-focus'&&command.value===true));
});
test('overlay identifies other-cohort updates, selected queues and real token errors without acquiring focus',()=>{
  const state=fixture(),app=setup(state),render=stats=>app.ui.render({...state,settings:{...state.settings,draftRankId:'DIVINE_IMMORTAL'},draft:{...state.draft,stats}});
  render({requestedRankId:'DIVINE_IMMORTAL',refreshingRankId:'LEGEND_ANCIENT',pendingRankId:'DIVINE_IMMORTAL',status:'queued',refreshQueued:true,message:'Выбранная выборка в очереди.'});assert.match(app.$('draft-status').textContent,/Загружается другой рейтинг: Легенда \/ Властелин/);assert.match(app.$('draft-status').title,/Выбранный рейтинг в очереди: Божество \/ Титан/);
  render({requestedRankId:'DIVINE_IMMORTAL',status:'error',errorCode:'HTTP_401',message:'STRATZ: токен отклонён (HTTP 401).'});assert.match(app.$('draft-status').textContent,/токен отклонён \(HTTP 401\)/i);assert.doesNotMatch(app.$('draft-status').textContent,/STRATZ/);app.$('draft-source').listeners.click();assert.match(app.$('draft-details-message').textContent,/токен отклонён/i);assert.ok(!app.commands.some(command=>command.name==='draft-search-focus'&&command.value===true));
  app.ui.render({...state,draft:{...state.draft,ownTeam:null,stats:{status:'error',errorCode:'TOKEN_REQUIRED',message:'Добавь API-токен STRATZ в настройках.'}}});assert.equal(app.$('draft-status').textContent,'Добавь API-токен в настройках.');
});
test('overlay keeps coverage and source machinery out of the five clean rows and labels close ordering honestly',()=>{
  const state=fixture();for(const rec of state.draft.candidates){rec.dataCoverage={baseline:{available:true,used:true,games:1000},enemies:{known:2,used:1,missing:1,lowSample:0,rejected:0},allies:{known:1,used:1,missing:0,lowSample:0,rejected:0}};rec.dataFreshness={baseline:{observedThrough:'2026-10-10T00:00:00Z',scope:{patch:null,rank:null}},pairs:{observedThrough:null,roleFiltered:false,scope:{patch:null,rank:null}}};rec.comparison={closeScore:true,nearestGap:.07};}
  const app=setup(state);assert.equal(app.$('draft-recommendations').children.length,5);for(const card of app.$('draft-recommendations').children){assert.equal(findClass(card,'draft-fit').textContent,'Мало данных');assert.match(card.title,/порядок не означает доказанного превосходства/);assert.doesNotMatch(texts(card),/STRATZ|OpenDota|\/\s*100|Учтено:|пары: период|База 50/);assert.ok(findClass(card,'draft-why'));assert.ok(findClass(card,'draft-risk'));}
  assert.ok(!app.ui.hitAreas().some(area=>area.y===240));
});
test('separate draft window shows five candidates and two complete roster rows, with technical actions kept out of the pick',()=>{
  const app=setup();assert.equal(app.$('draft-recommendations').children.length,5);assert.equal(app.$('draft-allies').children.length,5);assert.equal(app.$('draft-enemies').children.length,5);assert.equal(app.$('draft-side').hidden,true);assert.equal(app.$('draft-auto').hidden,true);
  const html=fs.readFileSync(require.resolve('../src/draft-window.html'),'utf8');assert.doesNotMatch(html,/Обновить STRATZ|Проверить драфт|Мой пул/);assert.match(html,/draft-position-buttons/);assert.equal(app.$('draft-position-buttons').children.length,5);assert.doesNotMatch(fs.readFileSync(require.resolve('../src/draft-window.js'),'utf8'),/draft-refresh|draftMode/);
  assert.match(app.$('draft-source').title,/роль не подтверждена/);assert.equal(app.$('draft-details').hidden,true);app.$('draft-source').listeners.click();assert.equal(app.$('draft-details').hidden,false);assert.match(app.$('draft-details-message').textContent,/не отфильтрована по роли/);
});
test('five overlay rows explain strengths and risks without scores, raw counts, tables or provider names',()=>{
  const state=fixture();for(const rec of state.draft.recommendations)Object.assign(rec,{baselineWinRate:.585,baselineGames:2991,positionId:1,roleFiltered:true,scoreBreakdown:{initial:50,baseline:8.2,enemies:-12.4,allies:-3.5,total:42.3},matchupEvidence:Array.from({length:8},(_,index)=>({heroId:100+index,name:`Pair ${index+1}`,side:index<5?'enemy':'ally',games:1000+index,wins:450,advantagePp:-2-index,contribution:-.5-index/10,roleFiltered:false}))});
  const app=setup(state),cards=app.$('draft-recommendations').children;assert.equal(cards.length,5);for(const card of cards){assert.equal(findClass(card,'draft-fit').textContent,'Есть риск');assert.match(findClass(card,'draft-baseline').textContent,/58,5% на керри/);assert.match(findClass(card,'draft-risk').textContent,/Тяжелее против Pair/);assert.match(findClass(card,'draft-risk').title,/Pair 8/);assert.ok(nodes(card).every(el=>el.tagName!=='DETAILS'&&el.tagName!=='TABLE'));assert.doesNotMatch(texts(card),/\/\s*100|База 58|STRATZ|OpenDota|п\.п\.|матчей/);}
  const areas=app.ui.hitAreas();assert.ok(areas.length<=8);assert.ok(!areas.some(area=>area.y===240));assert.ok(!app.commands.some(command=>command.name==='draft-search-focus'&&command.value===true));
});
test('overlay footer stays short while sample and fetch dates remain available inside data details',()=>{
  const state=fixture();state.draft.stats={providerId:'stratz',observedThrough:'2026-10-10T00:00:00Z',updatedAt:'2026-10-14T12:00:00Z'};state.draft.sourceLabel='STRATZ';const app=setup(state);assert.equal(app.$('draft-source').textContent,'Данные · Все рейтинги ↗');assert.doesNotMatch(app.$('draft-source').textContent,/2026|STRATZ/);assert.match(app.$('draft-source').title,/Загружено: 14\.10\.2026/);app.$('draft-source').listeners.click();assert.match(app.$('draft-details-source').textContent,/Последний день выборки: 10\.10\.2026 · Загружено: 14\.10\.2026/);assert.doesNotMatch(app.$('draft-details-source').textContent,/STRATZ/);
});
test('portrait correction saves in one click, stays synchronized, and releases search focus',async()=>{
  const app=setup();app.$('draft-enemies').children[1].listeners.click();assert.equal(app.ui.isPickerOpen(),true);await app.$('draft-search').listeners.click();assert.equal(app.ui.isSearching(),true);
  await app.$('draft-choices').children.find(el=>el.dataset.heroId==='8').listeners.click();assert.deepEqual(app.patches,[{draftEnemyHeroIds:[2,8]}]);assert.equal(app.ui.isPickerOpen(),false);assert.equal(app.ui.isSearching(),false);assert.equal(app.$('draft-enemies').children[1].title,'Juggernaut · исправить');assert.equal(app.commands.at(-1).value,false);
});
test('checking an existing candidate changes only the displayed comparison and never mutates draft settings',async()=>{
  const app=setup();app.$('draft-inspect').listeners.click();assert.equal(app.$('draft-catalog-title').textContent,'Проверить другого героя');assert.equal(app.$('draft-clear').hidden,true);await app.$('draft-choices').children.find(el=>el.dataset.heroId==='48').listeners.click();assert.equal(app.$('draft-recommendations').children[0].dataset.heroId,'48');assert.equal(app.$('draft-inspect').textContent,'К топ-5');assert.deepEqual(app.patches,[]);
  app.$('draft-inspect').listeners.click();assert.equal(app.$('draft-recommendations').children[0].dataset.heroId,'42');
});
test('a newly unavailable inspected candidate returns to the current ranking without changing the draft',async()=>{
  const app=setup();app.$('draft-inspect').listeners.click();await app.$('draft-choices').children.find(el=>el.dataset.heroId==='48').listeners.click();
  app.ui.render({...app.state(),draft:{...app.state().draft,bannedHeroIds:[48],candidates:app.state().draft.candidates.filter(rec=>rec.heroId!==48),recommendations:app.state().draft.recommendations.filter(rec=>rec.heroId!==48)}});assert.equal(app.$('draft-inspect').textContent,'Проверить героя');assert.equal(app.$('draft-recommendations').children[0].dataset.heroId,'42');assert.deepEqual(app.patches,[]);
});
test('an inspected hero outside the top five keeps the real four remaining recommendation ranks',async()=>{
  const app=setup();app.$('draft-inspect').listeners.click();await app.$('draft-choices').children.find(el=>el.dataset.heroId==='6').listeners.click();
  const cards=app.$('draft-recommendations').children;assert.equal(cards.length,5);assert.equal(cards[0].dataset.heroId,'6');assert.equal(findClass(cards[0],'draft-rec-rank').textContent,'↗');assert.equal(findClass(cards[0],'draft-verdict-label').textContent,'ПРОВЕРКА');assert.deepEqual(cards.slice(1).map(card=>findClass(card,'draft-rec-rank').textContent),['1','2','3','4']);assert.deepEqual(app.patches,[]);
  app.$('draft-inspect').listeners.click();assert.deepEqual(app.$('draft-recommendations').children.map(card=>findClass(card,'draft-rec-rank').textContent),['1','2','3','4','5']);
});
test('the already chosen hero is labelled as a choice instead of claiming first place',()=>{
  const state=fixture();state.draft={...state.draft,locked:true,ownHeroId:6,chosenRecommendation:state.draft.candidates.find(rec=>rec.heroId===6)};const app=setup(state),cards=app.$('draft-recommendations').children;
  assert.equal(cards.length,5);assert.equal(findClass(cards[0],'draft-rec-rank').textContent,'✓');assert.equal(findClass(cards[0],'draft-verdict-label').textContent,'ТВОЙ ВЫБОР');assert.deepEqual(cards.slice(1).map(card=>findClass(card,'draft-rec-rank').textContent),['1','2','3','4']);
});
test('missing recommendations show an honest empty state without placeholder scores or rows',()=>{
  const state=fixture();state.draft={...state.draft,recommendations:[],candidates:[]};const app=setup(state);assert.equal(app.$('draft-recommendations').children.length,0);assert.equal(app.$('draft-recommendations').hidden,true);assert.equal(app.$('draft-empty').hidden,false);assert.equal(app.$('draft-inspect').disabled,true);
});
test('catalog search covers all heroes and preserves query during periodic state updates',async()=>{
  const state=fixture();state.heroes=Array.from({length:127},(_,index)=>({id:index+1,name:`Hero ${String(index).padStart(3,'0')}`}));const app=setup(state);app.ui.openPicker('enemy');assert.equal(app.$('draft-choices').children.length,20);assert.match(app.$('draft-page').textContent,/1 \/ 7 · 127/);
  app.$('draft-next').listeners.click();assert.match(app.$('draft-page').textContent,/2 \/ 7/);app.$('draft-search').value='Hero 126';app.$('draft-search').listeners.input();assert.equal(app.$('draft-choices').children.length,1);const before=app.$('draft-choices').children[0];app.ui.render({...state,hero:{gameTime:0}});assert.equal(app.$('draft-choices').children[0],before);assert.equal(app.$('draft-search').value,'Hero 126');
});
test('search is explicitly focusable only while typing and ends on Enter, phase change, and hide',async()=>{
  const app=setup();app.ui.openPicker();await app.$('draft-search').listeners.click();assert.equal(app.ui.isSearching(),true);assert.equal(app.commands.at(-1).name,'draft-search-focus');assert.equal(app.commands.at(-1).value,true);
  app.document.listeners.keydown({key:'Enter',preventDefault(){}});await settle();assert.equal(app.ui.isSearching(),false);assert.equal(app.ui.isPickerOpen(),true);assert.equal(app.commands.at(-1).value,false);
  await app.$('draft-search').listeners.click();app.ui.render({...app.state(),draft:{...app.state().draft,phase:'strategy'}});await settle();assert.equal(app.ui.isSearching(),false);assert.equal(app.ui.isPickerOpen(),false);
  app.$('draft-hide').listeners.click();assert.equal(app.commands.at(-1).name,'hide-draft-overlay');
});
test('hotkey targets the separate roster catalog and bounded hit areas leave recommendation text click-through',()=>{
  const app=setup();let areas=app.ui.hitAreas();assert.ok(areas.length<=8);assert.ok(areas.reduce((sum,area)=>sum+area.width*area.height,0)<420000);assert.ok(!areas.some(area=>area.y===240));app.hotkey({mode:'toggle'});assert.equal(app.ui.isPickerOpen(),true);areas=app.ui.hitAreas();assert.equal(areas.length,3);assert.ok(areas.reduce((sum,area)=>sum+area.width*area.height,0)<420000);
  app.hotkey({mode:'toggle'});assert.equal(app.ui.isPickerOpen(),false);app.document.visibilityState='hidden';assert.equal(app.ui.hitAreas().length,0);
});
test('locked own hero cannot be overwritten and backend errors keep the correction visible',async()=>{
  const state=fixture();state.draft={...state.draft,ownHeroId:42,locked:true,allyHeroIds:[42,26]};const app=setup(state,{updateSettings:async()=>{throw new Error('Нет связи');}});assert.equal(app.$('draft-allies').children[0].disabled,true);app.ui.openPicker('enemy',0);assert.equal(app.$('draft-choices').children.find(el=>el.dataset.heroId==='42').disabled,true);
  await app.$('draft-choices').children.find(el=>el.dataset.heroId==='8').listeners.click();assert.equal(app.ui.isPickerOpen(),true);assert.match(app.$('draft-status').textContent,/Нет связи/);
});
