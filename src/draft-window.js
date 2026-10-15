'use strict';
(function(root){
  const document=root.document,$=id=>document.getElementById(id),helper=root.DraftUI,coach=root.coach;
  const fields={ally:'draftAllyHeroIds',enemy:'draftEnemyHeroIds',bans:'draftBannedHeroIds'},rosterFields={ally:'allyHeroIds',enemy:'enemyHeroIds',bans:'bannedHeroIds'},signatures=new Map();
  let state={},pickerOpen=false,role='enemy',slot=0,page=0,query='',busy=false,message='',inspectedId=null,detailsOpen=false,searching=false,searchPending=false,layoutQueued=false,phase='inactive',searchGeneration=0;
  const node=(tag,className,text)=>{const el=document.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=text;return el;};
  const button=(text,action,className)=>{const el=node('button',className,text);el.type='button';el.addEventListener('click',action);return el;};
  const changed=(id,signature,build)=>{const text=JSON.stringify(signature);if(signatures.get(id)!==text){signatures.set(id,text);$(id).replaceChildren(...build());}};
  const plain=value=>helper.plainText?helper.plainText(value):String(value||'').replace(/\b(?:STRATZ|OpenDota)\b\s*:?\s*/gi,'').trim();
  const heroById=id=>(state.heroes||[]).find(hero=>hero.id===id);
  const portrait=hero=>{if(!hero?.image)return node('span','draft-question','?');const img=node('img');img.src=hero.image;img.alt='';img.addEventListener('error',()=>img.replaceWith(node('span','draft-question','?')),{once:true});return img;};
  function visible(el){return el&&!el.hidden&&el.getBoundingClientRect().width>0&&el.getBoundingClientRect().height>0;}
  function hitAreas(){
    if(document.visibilityState==='hidden'||state.overlayEditing)return[];
    const elements=pickerOpen?[$('draft-header-actions'),$('draft-catalog'),$('draft-source')]:detailsOpen?[$('draft-header-actions'),$('draft-rank-buttons'),$('draft-source')]:[$('draft-header-actions'),$('draft-allies'),$('draft-enemies'),$('draft-position-buttons'),$('draft-tools'),...(!$('draft-side').hidden?[$('draft-side')]:[]),$('draft-source')];
    return elements.filter(visible).map(el=>{const{x,y,width,height}=el.getBoundingClientRect();return{x,y,width,height};});
  }
  function reportLayout(){
    if(layoutQueued)return;layoutQueued=true;const report=()=>{layoutQueued=false;coach.setOverlayHitAreas?.(hitAreas());};
    if(root.requestAnimationFrame)root.requestAnimationFrame(report);else report();
  }
  async function endSearch(){
    searching=false;searchPending=false;searchGeneration++;$('draft-search-done').hidden=true;$('draft-search').blur?.();
    try{await coach.command('draft-search-focus',false);}catch{}reportLayout();
  }
  async function beginSearch(){
    if(!pickerOpen||busy||searching||searchPending||state.overlayEditing)return;
    searchPending=true;const generation=++searchGeneration;
    try{const result=await coach.command('draft-search-focus',true);if(result?.error||result?.ok===false)throw new Error(result?.error||'Не удалось открыть поиск');
      if(generation!==searchGeneration||!pickerOpen)return;searchPending=false;searching=true;$('draft-search-done').hidden=false;$('draft-search').focus?.();reportLayout();
    }catch(error){searchPending=false;message=error.message;render();}
  }
  async function run(action){
    if(busy)return false;busy=true;message='Сохраняю…';render();
    try{const result=await action();if(result?.error)throw new Error(result.error);const next=result?.draft?result:await coach.getState();render(next);message='';return true;}
    catch(error){message=`Не удалось сохранить: ${error.message}`;return false;}
    finally{busy=false;render();}
  }
  function openPicker(nextRole='enemy',index=0){
    if(busy)return;endSearch();role=['ally','enemy','bans','candidate'].includes(nextRole)?nextRole:'enemy';slot=Math.max(0,Math.min(Number.isInteger(index)?index:0,4));page=0;query='';$('draft-search').value='';pickerOpen=true;detailsOpen=false;render();
  }
  function closePicker(){pickerOpen=false;message='';endSearch();render();}
  function togglePicker(){if(pickerOpen)closePicker();else openPicker('enemy',Math.min((state.draft?.enemyHeroIds||[]).length,4));}
  async function choose(heroId){
    if(busy)return;await endSearch();
    if(role==='candidate'){inspectedId=heroId;closePicker();return;}
    const patch=helper.rosterPatch(state,role,slot,heroId);if(!patch)return;
    if(await run(()=>coach.updateSettings(patch))){if(role!=='bans')closePicker();else render();}
  }
  async function clearSlot(){
    if(busy)return;await endSearch();const selected=helper.ids(state.draft?.[rosterFields[role]]);if(role==='bans')selected.length=0;else selected.splice(slot,1);
    if(await run(()=>coach.updateSettings({[fields[role]]:selected})))closePicker();
  }
  function renderTeams(){
    for(const key of ['ally','enemy']){
      const selected=helper.ids(state.draft?.[rosterFields[key]]).slice(0,5),elementId=key==='ally'?'draft-allies':'draft-enemies';
      $(key==='ally'?'draft-ally-count':'draft-enemy-count').textContent=`${selected.length} / 5`;
      changed(elementId,[selected,selected.map(heroById),state.draft?.ownHeroId,state.draft?.locked],()=>Array.from({length:5},(_,index)=>{
        const hero=heroById(selected[index]),own=state.draft?.locked&&selected[index]===state.draft?.ownHeroId,el=button('',()=>openPicker(key,index),`draft-slot${hero?' known':''}${own?' own':''}`);
        el.dataset.draftRole=key;el.dataset.draftSlot=String(index);el.append(portrait(hero),node('span',`draft-slot-name${hero?'':' empty'}`,hero?.name||'Выбрать'));el.title=own?`${hero?.name||'Герой'} · твой выбор`:`${hero?.name||'Пустой слот'} · исправить`;
        el.setAttribute('aria-label',`${key==='ally'?'Союзник':'Соперник'} ${index+1}: ${hero?.name||'выбрать'}`);if(own)el.append(node('span','draft-own-tag','ТЫ'));el.disabled=own||busy;return el;
      }));
    }
  }
  function displayedRecommendations(){
    const draft=state.draft||{},top=helper.recommendationsFor(draft),inspected=(draft.candidates||[]).find(rec=>rec.heroId===inspectedId)||top.find(rec=>rec.heroId===inspectedId);
    if(!inspected)return top.slice(0,5);return[inspected,...top.filter(rec=>rec.heroId!==inspected.heroId)].slice(0,5);
  }
  function renderRecommendations(){
    const recommendations=displayedRecommendations();
    changed('draft-recommendations',[recommendations,recommendations.map(rec=>heroById(rec.heroId)),state.draft?.locked,state.draft?.ownHeroId,inspectedId],()=>recommendations.map((rec,index)=>{
      const hero=heroById(rec.heroId),inspected=inspectedId===rec.heroId,chosen=state.draft?.locked&&rec.heroId===state.draft?.ownHeroId,view=helper.presentation(rec,state.draft||{}),actualRank=(state.draft?.recommendations||[]).findIndex(item=>item.heroId===rec.heroId)+1,card=node('article',`draft-recommendation${actualRank===1&&!inspected&&!chosen?' best':''}${inspected?' inspected':''}`);card.dataset.heroId=String(rec.heroId);
      const rank=node('span','draft-rec-rank',chosen?'✓':inspected?'↗':String(actualRank||index+1));rank.title=chosen?'Твой выбор':inspected?'Проверка героя':`Вариант ${actualRank||index+1}`;
      const head=node('div','draft-rec-head'),image=node('div','draft-rec-portrait');image.append(portrait(hero));const identity=node('div','draft-rec-identity');identity.append(node('strong','',rec.name||hero?.name||'Герой'));
      const baseline=node('span','draft-baseline',plain(view.baselineSummary));baseline.title=plain(view.baselineSummary);identity.append(baseline);head.append(image,identity);
      const explanation=node('div','draft-rec-explanation'),why=node('p','draft-why',plain(view.why));why.title=plain(view.whyTitle||view.why);explanation.append(why);
      const risk=node('p','draft-risk',plain(view.risk)||(view.limited?'Данных пока недостаточно для оценки рисков':'Явных минусов в известных парах не видно'));risk.title=plain(view.riskTitle||view.risk);explanation.append(risk);
      const verdict=node('div',`draft-rec-verdict ${view.tone||'neutral'}`);verdict.append(node('span','draft-verdict-label',chosen?'ТВОЙ ВЫБОР':inspected?'ПРОВЕРКА':'МАТЧАПЫ'),node('span','draft-fit',plain(view.label)));verdict.title=view.nearTie?'Близкие варианты: преимущество одного героя над другим не доказано':plain(view.label);
      card.append(rank,head,explanation,verdict);card.title=view.nearTie?'Близкий вариант — порядок не означает доказанного превосходства':'Рекомендация по известному составу';return card;
    }));
    $('draft-empty').hidden=pickerOpen||detailsOpen||recommendations.length>0;
    $('draft-inspect').textContent=inspectedId?'К топ-5':'Проверить героя';
    $('draft-inspect').disabled=busy||!inspectedId&&!(state.draft?.candidates||[]).length;
  }
  function renderPicker(){
    $('draft-catalog').hidden=!pickerOpen;$('draft-recommendations').hidden=pickerOpen||detailsOpen||!displayedRecommendations().length;
    document.body.classList.toggle('picking',pickerOpen);if(!pickerOpen)return;
    const inspect=role==='candidate';$('draft-catalog-label').textContent=inspect?'ОЦЕНИТЬ ПОД ЭТОТ ДРАФТ':role==='bans'?'НЕДОСТУПНЫЕ ГЕРОИ':'ИСПРАВИТЬ СОСТАВ';$('draft-catalog-title').textContent=inspect?'Проверить другого героя':role==='bans'?'Баны':`${role==='ally'?'Союзник':'Соперник'} ${slot+1}`;
    changed('draft-picker-tabs',role,()=>inspect?[node('span','eyebrow','Выбор здесь не меняет пик')]:[['ally','Союзники'],['enemy','Враги'],['bans','Баны']].map(([key,label])=>{const el=button(label,()=>openPicker(key,Math.min((state.draft?.[rosterFields[key]]||[]).length,4)),role===key?'selected':'');el.setAttribute('aria-pressed',String(role===key));return el;}));
    const available=inspect?new Set((state.draft?.candidates||[]).map(rec=>rec.heroId)):null,heroes=available?(state.heroes||[]).filter(hero=>available.has(hero.id)):state.heroes;
    const result=helper.pages({...state,heroes},query,role,page,20);page=result.page;const selected=helper.ids(state.draft?.[rosterFields[role]]);
    changed('draft-choices',[role,slot,page,result.heroes,selected,state.draft?.ownHeroId,state.draft?.locked,inspectedId],()=>result.heroes.map(hero=>{
      const selectedHere=inspect?inspectedId===hero.id:role==='bans'?selected.includes(hero.id):selected[slot]===hero.id,el=button('',()=>choose(hero.id),`draft-catalog-choice${selectedHere?' selected':''}`);el.dataset.heroId=String(hero.id);el.append(portrait(hero),node('span','',hero.name));el.title=hero.name;el.setAttribute('aria-pressed',String(selectedHere));el.disabled=!inspect&&state.draft?.locked&&hero.id===state.draft?.ownHeroId;return el;
    }));
    $('draft-page').textContent=`${page+1} / ${result.count} · ${result.total} героев`;$('draft-prev').disabled=busy||page===0;$('draft-next').disabled=busy||page+1===result.count;$('draft-clear').hidden=inspect;$('draft-clear').textContent=role==='bans'?'Убрать баны':'Убрать из слота';
  }
  function render(next){
    state=next||state;const draft=state.draft||{},nextPhase=draft.phase||'inactive';
    if(nextPhase!==phase){pickerOpen=false;detailsOpen=false;inspectedId=null;endSearch();phase=nextPhase;}
    if((state.overlayEditing||draft.windowVisible===false)&&(searching||searchPending))endSearch();
    if(state.overlayEditing&&pickerOpen){pickerOpen=false;endSearch();}
    if(inspectedId&&!(draft.candidates||[]).some(rec=>rec.heroId===inspectedId)&&!helper.recommendationsFor(draft).some(rec=>rec.heroId===inspectedId))inspectedId=null;
    document.body.classList.toggle('editing',Boolean(state.overlayEditing));$('draft-edit-hint').hidden=!state.overlayEditing;
    $('draft-title').textContent=draft.locked?`Выбран ${heroById(draft.ownHeroId)?.name||'герой'}`:'Выбор героя';
    const selectedPosition=helper.positionId(state);
    changed('draft-position-buttons',selectedPosition,()=>helper.positions.map(position=>{const el=button(`${position.id} · ${position.short}`,()=>{inspectedId=null;run(()=>coach.updateSettings({draftPositionId:position.id}));},`draft-position-button${position.id===selectedPosition?' selected':''}`);el.dataset.positionId=String(position.id);el.title=`Позиция ${position.id} · ${position.label}`;el.setAttribute('aria-label',el.title);el.setAttribute('aria-pressed',String(position.id===selectedPosition));return el;}));
    const selectedRank=helper.rankId(state);changed('draft-rank-buttons',selectedRank,()=>helper.ranks.map(rank=>{const el=button(rank.short||rank.label,()=>{inspectedId=null;run(()=>coach.updateSettings({draftRankId:rank.id}));},rank.id===selectedRank?'selected':'');el.dataset.rankId=rank.id;el.setAttribute('aria-pressed',String(rank.id===selectedRank));return el;}));
    const manual=['manual','mixed'].includes(draft.source||draft.rosterSource);$('draft-auto').hidden=!manual;$('draft-bans').textContent=`Баны · ${helper.ids(draft.bannedHeroIds).length}`;$('draft-side').hidden=Boolean(draft.ownTeam);document.body.classList.toggle('needs-side',!draft.ownTeam);
    const detection=draft.detection||{},known=`${helper.ids(draft.allyHeroIds).length}/5 союзников · ${helper.ids(draft.enemyHeroIds).length}/5 врагов`;
    $('draft-note').textContent='Варианты под известный состав. Нажми портрет команды, чтобы исправить героя.';$('draft-note').title=plain([draft.summary,draft.status,known,detection.message].filter(Boolean).join(' · '));
    renderTeams();renderRecommendations();renderPicker();document.body.classList.toggle('details',detailsOpen);$('draft-details').hidden=!detailsOpen;
    const stats=draft.stats||{},dates=helper.statsDates(stats),scope=stats.scopeDescription||draft.scopeLabel||helper.scopeText(stats.scope);
    const sourceStatus=plain(helper.sourceStatus(stats,helper.rankId(state))),refresh=helper.refreshContext(stats,helper.rankId(state)),priorityStatus=stats.status==='error'||Boolean(stats.errorCode)||stats.status==='partial'||Boolean(refresh.progress);
    $('draft-source').textContent=detailsOpen?'Закрыть данные':`Данные · ${helper.rankLabel(selectedRank)} ↗`;$('draft-source').title=plain([`Позиция: ${helper.positionLabel(state)}`,scope,dates.title,sourceStatus].filter(Boolean).join(' · '));
    $('draft-details-source').textContent=plain(dates.title||'Период выборки пока не подтверждён');$('draft-details-scope').textContent=plain(scope);$('draft-details-message').textContent=plain([sourceStatus,Number.isInteger(draft.catalogCount)?`Каталог: ${draft.catalogCount} героев; статистика для ${draft.coverageCount||0} из ${draft.candidateCount||0} доступных.`:'',...(draft.notes||[])].filter(Boolean).join(' '));
    $('draft-status').textContent=plain(message)||(priorityStatus?sourceStatus:!draft.ownTeam?'Укажи свою сторону':'Совет уточняется после каждого пика');$('draft-status').title=plain(message||[sourceStatus,draft.status].filter(Boolean).join(' · '));
    for(const el of document.querySelectorAll('button'))if(busy)el.disabled=true;else if(!['draft-prev','draft-next','draft-inspect'].includes(el.id))el.disabled=Boolean(el.classList.contains('draft-slot')&&el.classList.contains('own')||el.classList.contains('draft-catalog-choice')&&role!=='candidate'&&draft.locked&&Number(el.dataset.heroId)===draft.ownHeroId);
    reportLayout();
  }
  $('draft-hide').addEventListener('click',()=>{endSearch();coach.command('hide-draft-overlay');});
  $('draft-bans').addEventListener('click',()=>openPicker('bans'));
  $('draft-inspect').addEventListener('click',()=>{if(inspectedId){inspectedId=null;render();}else openPicker('candidate');});
  $('draft-auto').addEventListener('click',()=>run(()=>coach.command('draft-reset')));
  $('draft-radiant').addEventListener('click',()=>run(()=>coach.updateSettings({draftOwnTeam:'radiant'})));$('draft-dire').addEventListener('click',()=>run(()=>coach.updateSettings({draftOwnTeam:'dire'})));
  $('draft-picker-close').addEventListener('click',closePicker);$('draft-clear').addEventListener('click',clearSlot);$('draft-prev').addEventListener('click',()=>{page--;renderPicker();reportLayout();});$('draft-next').addEventListener('click',()=>{page++;renderPicker();reportLayout();});
  $('draft-search').addEventListener('pointerdown',beginSearch);$('draft-search').addEventListener('click',beginSearch);$('draft-search').addEventListener('input',()=>{query=$('draft-search').value;page=0;renderPicker();reportLayout();});$('draft-search-done').addEventListener('click',endSearch);
  $('draft-source').addEventListener('click',()=>{if(pickerOpen)closePicker();detailsOpen=!detailsOpen;render();});
  document.addEventListener?.('keydown',event=>{if(event.key==='Escape'){event.preventDefault();if(searching)endSearch();else if(pickerOpen)closePicker();else if(detailsOpen){detailsOpen=false;render();}}else if(event.key==='Enter'&&searching){event.preventDefault();endSearch();}});
  document.addEventListener?.('visibilitychange',()=>{if(document.visibilityState==='hidden')endSearch();reportLayout();});let lastPointer=0;
  for(const type of['mousemove','mouseleave'])document.addEventListener?.(type,()=>{const now=Date.now();if(type==='mouseleave'||now-lastPointer>=40){lastPointer=now;coach.notifyOverlayPointer?.();}});
  root.addEventListener?.('resize',reportLayout);root.addEventListener?.('blur',()=>{if(searching)endSearch();});
  if(typeof root.ResizeObserver==='function'){const observer=new root.ResizeObserver(reportLayout);observer.observe($('draft-card'));observer.observe($('draft-catalog'));}
  root.draftWindowUI={render,openPicker,closePicker,togglePicker,hitAreas,isPickerOpen:()=>pickerOpen,isSearching:()=>searching,displayedRecommendations};
  coach.onOverlayPicker?.(payload=>{if(payload?.mode==='open')openPicker('enemy');else togglePicker();});coach.onState(render);coach.getState().then(render);render();
})(window);
