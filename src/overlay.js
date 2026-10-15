'use strict';
const $=id=>document.getElementById(id);
const rosterSignatures=new Map();
const pickerSignatures=new Map();
let overlayState=null,pickerOpen=false,pickerRole='ally',pickerIndex=0,pickerFlow=[],pickerBusy=false,pickerMessage='',hitAreasQueued=false;
function requestOverlayHitAreas(){
  if(hitAreasQueued)return;hitAreasQueued=true;
  const report=()=>{hitAreasQueued=false;
    const ids=['overlay-lane-ally','overlay-lane-enemy-1','overlay-lane-enemy-2','overlay-pick-lineup',...(pickerOpen?['overlay-lane-picker']:[])];
    const areas=document.visibilityState==='hidden'?[]:ids.map(id=>$(id)?.getBoundingClientRect?.()).filter(rect=>rect&&rect.width>0&&rect.height>0).map(({x,y,width,height})=>({x,y,width,height}));
    window.coach.setOverlayHitAreas?.(areas);
  };
  if(window.requestAnimationFrame)window.requestAnimationFrame(report);else report();
}
function pickerHero(id){return overlayState?.heroes?.find(hero=>hero.id===id);}
function pickerNode(tag,className,text){const el=document.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=text;return el;}
function replacePickerChanged(id,signature,build){
  const el=$(id);if(pickerSignatures.get(id)!==signature){pickerSignatures.set(id,signature);el.replaceChildren(...build());}
  for(const child of el.children)child.disabled=pickerBusy;
}
function pickerImage(hero,className){
  if(!hero?.image)return pickerNode('span',className||'hero-question','?');
  const img=pickerNode('img');img.src=hero.image;img.alt='';img.addEventListener('error',()=>{img.replaceWith(pickerNode('span',className||'hero-question','?'));});return img;
}
function syncPickerVisibility(){
  $('overlay-lane-picker').hidden=!pickerOpen;$('overlay-advice-body').hidden=pickerOpen;document.body.classList.toggle('picking',pickerOpen);
  for(const [id,role,index]of[['overlay-lane-ally','ally',0],['overlay-lane-enemy-1','enemy',0],['overlay-lane-enemy-2','enemy',1]]){
    $(id).classList.toggle('active',pickerOpen&&role===pickerRole&&(role==='ally'||index===pickerIndex));$(id).disabled=pickerBusy;
  }
  $('overlay-pick-lineup').disabled=pickerBusy;requestOverlayHitAreas();
}
function openOverlayPicker(role='ally',index=0,flow=[]){
  if(!overlayState||pickerBusy)return;
  pickerRole=role==='enemy'?'enemy':'ally';pickerIndex=pickerRole==='enemy'&&index===1?1:0;pickerFlow=[...flow];pickerMessage='';pickerOpen=true;renderOverlayPicker();
}
function closeOverlayPicker(){pickerOpen=false;pickerFlow=[];pickerMessage='';syncPickerVisibility();}
function renderOverlayPicker(){
  syncPickerVisibility();if(!pickerOpen||!overlayState)return;
  const roster=overlayState.laneRoster||{},ids=window.LanePicker.teamChoices(overlayState,pickerRole),current=pickerRole==='ally'?roster.ally?.id:roster.enemies?.[pickerIndex]?.id,other=pickerRole==='enemy'?roster.enemies?.[pickerIndex===0?1:0]?.id:null;
  $('overlay-picker-step').textContent=`${pickerRole==='ally'?'МОЯ КОМАНДА':'ВРАЖЕСКАЯ КОМАНДА'}${pickerFlow.length?` · ${3-pickerFlow.length}/3`:''}`;
  $('overlay-picker-title').textContent=pickerRole==='ally'?'Кто стоит с тобой?':`Соперник ${pickerIndex+1} на линии`;
  $('overlay-picker-help').textContent=pickerFlow.length?'Нажми портрет → следующий герой.':'Нажми портрет — выбор сразу сохранится.';
  const tabs=[['ally',0,roster.ally],['enemy',0,roster.enemies?.[0]],['enemy',1,roster.enemies?.[1]]];
  replacePickerChanged('overlay-picker-tabs',JSON.stringify([pickerRole,pickerIndex,tabs.map(([role,index,slot])=>[role,index,slot?.id,slot?.name,slot?.image,pickerHero(slot?.id)])]),()=>tabs.map(([role,index,slot])=>{
    const hero=pickerHero(slot?.id),active=role===pickerRole&&(role==='ally'||index===pickerIndex),button=pickerNode('button',`picker-tab${active?' active':''}`);button.type='button';button.disabled=pickerBusy;button.setAttribute('aria-pressed',String(active));
    button.append(pickerImage(slot?.image?slot:hero,'tab-question'));
    const info=pickerNode('span');info.append(pickerNode('small','',role==='ally'?'НАПАРНИК':`ВРАГ ${index+1}`),pickerNode('strong','',slot?.name||hero?.name||'Выбрать'));button.append(info);
    button.addEventListener('click',()=>openOverlayPicker(role,index));return button;
  }));
  replacePickerChanged('overlay-picker-choices',JSON.stringify([pickerRole,pickerIndex,current,other,ids.map(id=>pickerHero(id))]),()=>ids.map(id=>{
    const hero=pickerHero(id),button=pickerNode('button',`picker-choice${current===id?' selected':''}`);button.type='button';button.disabled=pickerBusy;button.dataset.heroId=String(id);button.title=hero?.name||'Герой';button.setAttribute('aria-pressed',String(current===id));
    button.append(pickerImage(hero),pickerNode('span','hero-name',hero?.name||String(id)));
    if(current===id||other===id)button.append(pickerNode('span','choice-indicator',current===id?'✓':'↔'));
    if(other===id)button.title+=' · поменять соперников местами';button.addEventListener('click',()=>saveOverlayChoice(id));return button;
  }));
  $('overlay-picker-empty').hidden=ids.length>0;$('overlay-picker-status').textContent=pickerMessage;$('overlay-picker-auto').disabled=pickerBusy;$('overlay-picker-settings').disabled=pickerBusy;requestOverlayHitAreas();
}
async function saveOverlayChoice(heroId){
  if(pickerBusy||!pickerOpen)return;
  if(!window.LanePicker.teamChoices(overlayState,pickerRole).includes(heroId))return;
  const patch=window.LanePicker.selectionPatch(overlayState,pickerRole,pickerIndex,heroId);if(!patch)return;
  if(pickerRole==='enemy'){
    const allowed=new Set([...window.LanePicker.teamChoices(overlayState,'enemy'),...window.LanePicker.manualEnemies(overlayState)]),own=window.LanePicker.playerHeroId(overlayState);
    patch.laneEnemyHeroIds=patch.laneEnemyHeroIds.filter(id=>allowed.has(id)&&id!==own);
  }
  pickerBusy=true;pickerMessage='Сохраняю…';renderOverlayPicker();
  try{
    const result=await window.coach.updateSettings(patch);if(result?.error)throw new Error(result.error);
    if(result?.settings)update(result);else update(await window.coach.getState());
    pickerBusy=false;if(!pickerOpen){syncPickerVisibility();return;}
    const next=pickerFlow.shift();if(next)openOverlayPicker(next.role,next.index,pickerFlow);else closeOverlayPicker();
  }catch(error){pickerBusy=false;pickerMessage=`Не удалось сохранить: ${error.message}`;renderOverlayPicker();}
}
async function resetOverlayLineup(){
  if(pickerBusy)return;pickerBusy=true;pickerMessage='Возвращаю авто…';renderOverlayPicker();
  try{const result=await window.coach.command('resume-auto-lineup');if(result?.error)throw new Error(result.error);update(result?.settings?result:await window.coach.getState());pickerBusy=false;closeOverlayPicker();}
  catch(error){pickerBusy=false;pickerMessage=`Не удалось сохранить: ${error.message}`;renderOverlayPicker();}
}
function currentScreenLineup(state){return[state.laneRoster?.source,state.advice?.lane?.detectionSource].includes('screen_current');}
function selectedScreenHero(state,now=Date.now()){
  const player=state.vision?.player,stamp=state.vision?.capturedAt||0;
  return Boolean(!state.demo&&stamp>0&&now-stamp<=7000&&stamp-now<=1000&&player?.confirmed===true&&player.heroId===42&&player.source==='selected_hud'&&['radiant','dire'].includes(player.team)&&!['wrong_hero','spectator'].includes(state.connection?.status)&&!(state.connection?.status==='live'&&(state.hero?.isSpectator===true||state.hero?.isWraithKing===false)));
}
function renderLaneAvatar(id,slot,role,current=false){
  const el=$(id),signature=JSON.stringify([slot||{},current]);if(rosterSignatures.get(id)===signature)return;rosterSignatures.set(id,signature);
  const manual=slot?.source==='manual',status=slot?.status||'unknown',known=slot?.id&&['confirmed','observing','retained'].includes(status),name=known?slot.name||'Герой':'Пока неизвестен';
  el.className=`lane-avatar ${role} ${status}`;el.replaceChildren();
  const placeholder=document.createElement('span');placeholder.textContent='?';el.append(placeholder);
  if(known&&slot.image){const img=document.createElement('img');img.src=slot.image;img.alt=name;img.addEventListener('error',()=>{img.remove();placeholder.hidden=false;});el.prepend(img);placeholder.hidden=true;}
  if(status==='observing'){const check=document.createElement('span');check.className='avatar-check';check.textContent='?';el.append(check);}
  if(manual){const check=document.createElement('span');check.className='avatar-check';check.textContent='✓';el.append(check);}
  const statuses={confirmed:'Подтверждён',observing:'Проверяю',retained:'По предыдущим кадрам',unknown:'Пока не определён'};
  el.title=manual?`${name} · выбран тобой вручную`:`${name} · ${statuses[status]||statuses.unknown}${Number.isFinite(slot?.confidence)?` · ${Math.round(slot.confidence*100)}%`:''}${current?' · наблюдался рядом с WK; исходный состав линии не подтверждён':role==='ally'?' · вероятный напарник на линии':''}`;
}
function renderLineup(state){
  const roster=state.laneRoster||{},current=currentScreenLineup(state);
  renderLaneAvatar('overlay-lane-ally',roster.ally,'ally',current);renderLaneAvatar('overlay-lane-enemy-1',roster.enemies?.[0],'enemy',current);renderLaneAvatar('overlay-lane-enemy-2',roster.enemies?.[1],'enemy',current);
  $('overlay-ally-label').textContent=current?'СОЮЗНИК':'НАПАРНИК';
  const labels={confirmed:'Герои определены',observing:'Проверяю состав',retained:'По прошлым кадрам',unknown:'Ожидаю героев'};
  const manual=roster.ally?.source==='manual'||roster.enemies?.some(slot=>slot?.source==='manual');
  $('overlay-lane-status').textContent=manual?roster.source==='mixed'?'Выбор + авто':'Выбрано тобой':current?roster.status==='retained'?'Рядом · прошлые кадры':'Рядом с WK':roster.historical?'По ранним кадрам':labels[roster.status]||labels.unknown;$('overlay-lane-status').title=roster.reason||'';
  const outcome=state.laneOutcome||state.advice?.lane?.outcomeAssessment||{};
  const result=outcome.result||'unknown',known=['won','even','lost'].includes(result);
  $('overlay-lane-outcome').hidden=!known&&outcome.complete!==true&&outcome.dataSufficient!==true;
  $('overlay-lane-outcome').textContent=known?outcome.label||({won:'Линия выиграна',even:'Линия равная',lost:'Линия проиграна'}[result]):outcome.dataSufficient===true?'Неоднозначная линия':'Мало данных';
  $('overlay-lane-outcome').className=result;$('overlay-lane-outcome').title=outcome.reason||'';
}
function update(state){
  if(!state)return;
  const changedHero=overlayState&&window.LanePicker&&window.LanePicker.playerHeroId(state)!==window.LanePicker.playerHeroId(overlayState);
  const oldHero=overlayState?.hero,newHero=state.hero;
  const changedMatch=oldHero&&newHero&&(oldHero.matchId!=null&&newHero.matchId!=null&&String(oldHero.matchId)!==String(newHero.matchId)||Number.isFinite(oldHero.gameTime)&&Number.isFinite(newHero.gameTime)&&oldHero.gameTime-newHero.gameTime>5);
  overlayState={...overlayState,...state};state=overlayState;if((changedHero||changedMatch||state.overlayEditing)&&pickerOpen)closeOverlayPicker();
  const {advice,hero}=state,action=advice.action,bundle=advice.stageAdvice,skills=advice.skills||{},next=skills.next;
  const heroName=state.activeProfile?.name||state.supportedProfiles?.find(profile=>(profile.heroId||profile.id)===(state.activeProfile?.heroId||state.activeProfile?.id))?.name;
  if($('overlay-hero-name'))$('overlay-hero-name').textContent=heroName||'CARRY';
  document.body.classList.toggle('compact',state.settings.compact);document.body.classList.toggle('editing',state.overlayEditing);$('edit-hint').hidden=!state.overlayEditing;
  const live=state.connection.status==='live',screenSelected=selectedScreenHero(state);$('live').textContent=state.demo?'DEMO · ПРИМЕР':live?'● LIVE':screenSelected?'● SCREEN':'WAITING';$('live').className=state.demo?'demo':live||screenSelected?'live':'';
  const t=hero?.gameTime;$('time').textContent=Number.isFinite(t)?`${t<0?'−':''}${Math.floor(Math.abs(t)/60)}:${String(Math.floor(Math.abs(t)%60)).padStart(2,'0')}`:'—:—';
  $('stage-name').textContent=advice.stage?.id==='unknown'&&currentScreenLineup(state)?'ГЕРОИ РЯДОМ С WK':advice.stage?.title||'ОЖИДАЮ МАТЧ';
  renderLineup(state);
  const item=advice.item;$('item-name').textContent=item?.name||'Ожидаю матч';$('item-cost').textContent=item?`${Number.isFinite(item.remainingGold)?item.remainingGold.toLocaleString('ru-RU'):'—'} золота до сборки`:'Подключи GSI';$('item-reason').textContent=item?.reason||'Ctrl+Alt+W — открыть настройки.';
  $('item-image').hidden=!item?.image;$('empty-icon').hidden=Boolean(item?.image);if(item?.image&&$('item-image').src!==item.image)$('item-image').src=item.image;
  const economy=advice.economy||{};
  $('overlay-networth').textContent=Number.isFinite(economy.netWorth)?`${economy.exact?'':'≈ '}${Math.round(economy.netWorth).toLocaleString('ru-RU')}`:'—';$('overlay-cs').textContent=`${Number.isFinite(economy.lastHits)?economy.lastHits:'—'} / ${economy.checkpoint?.targetCs||economy.targetCs||50}`;$('overlay-gpm').textContent=Number.isFinite(economy.gpm)?Math.round(economy.gpm):'—';$('overlay-target').textContent=`LH · ${economy.checkpoint?.minute||10} МИН`;
  $('skill-key').textContent=next?.hotkey||'◇';$('skill-label').textContent=next?.ready?'ЕСТЬ ОЧКО · ПРОКАЧКА':next?.pointsKnown===false?'ПЛАН · ПРОВЕРЬ ОЧКО':'ПЛАН ПРОКАЧКИ';$('skill-name').textContent=next?.label?`${next.label}${Number.isFinite(next.desiredRank)?` · ${next.desiredRank}`:''}`:'Уровни навыков не подтверждены';
  const urgent=action.tone==='danger'||action.source==='screen'||hero?.alive===false||action.tone==='warning'&&!['lane','post_lane'].includes(action.source);
  $('action-label').textContent=urgent?'СЕЙЧАС · ПРИОРИТЕТ':bundle?`${advice.stage?.title||'ПЛАН'} · ДЕЙСТВИЕ`:'ТВОЙ СЛЕДУЮЩИЙ ШАГ';
  $('action').className=urgent?action.tone:'neutral';$('action-title').textContent=!urgent&&bundle?bundle.mainTitle:action.title;$('action-reason').textContent=!urgent&&bundle?bundle.mainReason:action.reason;$('signal').textContent=action.tone==='danger'?'!':'↗';
  $('stage-tips').hidden=!bundle;
  $('skill-use').textContent=bundle?.skillUseTitle||'';$('skill-use-reason').textContent=bundle?.skillUseReason||'';$('extra-tip').textContent=bundle?.extraTitle||'';$('extra-tip-reason').textContent=bundle?.extraReason||'';
  const age=Date.now()-(state.vision?.capturedAt||0),source=state.provider?.active==='stratz'?'STRATZ':state.provider?.active==='personal'?'МОЙ ПЛАН':state.provider?.active==='opendota'?'OPENDOTA':'КЕШ';
  const screenFresh=age>=-1000&&age<7000&&(state.vision?.quality?.usable||screenSelected);
  $('source').textContent=state.demo?'ДЕМО · ВЫМЫШЛЕННЫЕ ДАННЫЕ':live?`${screenFresh?'GSI + SCREEN':'GSI'} · ${source}`:screenFresh?`SCREEN · СТАТИСТИКА ЖДЁТ GSI`:'ОЖИДАЮ GSI И ЭКРАН';
  if(pickerOpen&&!pickerBusy)renderOverlayPicker();else requestOverlayHitAreas();
}
for(const [id,role,index]of[['overlay-lane-ally','ally',0],['overlay-lane-enemy-1','enemy',0],['overlay-lane-enemy-2','enemy',1]])$(id).addEventListener('click',()=>openOverlayPicker(role,index));
$('overlay-pick-lineup').addEventListener('click',()=>openOverlayPicker('ally',0,[{role:'enemy',index:0},{role:'enemy',index:1}]));
$('overlay-picker-close').addEventListener('click',closeOverlayPicker);$('overlay-picker-auto').addEventListener('click',resetOverlayLineup);
$('overlay-picker-settings').addEventListener('click',()=>{closeOverlayPicker();window.coach.command('show-settings');});
document.addEventListener?.('keydown',event=>{if(event.key==='Escape'&&pickerOpen){event.preventDefault();closeOverlayPicker();}});
document.addEventListener?.('visibilitychange',requestOverlayHitAreas);
let lastPointerNotification=0;
for(const type of ['mousemove','mouseleave'])document.addEventListener?.(type,()=>{const now=Date.now();if(type==='mouseleave'||now-lastPointerNotification>=40){lastPointerNotification=now;window.coach.notifyOverlayPointer?.();}});
window.addEventListener?.('resize',requestOverlayHitAreas);
if(typeof ResizeObserver==='function'){const observer=new ResizeObserver(requestOverlayHitAreas);observer.observe($('overlay-lane-picker'));observer.observe($('card'));}
window.coach.onOverlayPicker?.(payload=>{if(pickerOpen&&payload?.mode!=='open')closeOverlayPicker();else openOverlayPicker('ally',0,[{role:'enemy',index:0},{role:'enemy',index:1}]);});
window.coach.onState(update);window.coach.getState().then(update);
