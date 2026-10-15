'use strict';
const $ = id => document.getElementById(id);
let state = null, currentPage = 'home', selectedEnemies = [], pickerMode='draft', cropMode = null, dragStart = null, dragEnd = null, fetchingState=false, providerBusy=false;
let lanePickerRole='ally',lanePickerIndex=0,lanePickerFlow=[],lanePickerBusy=false;
const contentSignatures=new WeakMap();
function replaceChanged(element,signature,create){if(contentSignatures.get(element)===signature)return;contentSignatures.set(element,signature);element.replaceChildren(...create());}
const titles = { home: 'Твой следующий шаг.',draft:'Герой под этот драфт.',builds:'Билд под твою игру.', vision: 'Карта в поле внимания.', settings: 'Настрой свой Core Coach.' };
const draftView=window.DraftUI&&$('draft-root')?window.DraftUI.create($('draft-root'),{updateSettings:patch=>window.coach.updateSettings(patch),command:name=>window.coach.command(name),getState:()=>window.coach.getState(),applyState:value=>applyState(value)}):null;
const phaseNames = { start: 'СТАРТОВАЯ ЗАКУПКА', early: 'РАННЯЯ ИГРА', mid: 'СЕРЕДИНА МАТЧА', late: 'ПОЗДНЯЯ ИГРА', unknown: 'ОЖИДАНИЕ' };
const threatNames = { magic: 'Магический урон', control: 'Контроль', illusions: 'Иллюзии / копии', armor: 'Снижение брони', physical: 'Физический урон', manaDrain: 'Потеря маны' };
const fmt = n => Number.isFinite(n) ? Math.round(n).toLocaleString('ru-RU') : '—';
function timeText(seconds) { if (!Number.isFinite(seconds)) return '—:—'; const abs = Math.abs(Math.floor(seconds)); return `${seconds < 0 ? '−' : ''}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')}`; }
function text(id, value) {const output=String(value??'');if($(id).textContent!==output)$(id).textContent=output;}
function imageFor(img, url) { img.hidden = !url; if (url && img.src !== url) img.src = url; }
function selectedScreenHero(snapshot,now=Date.now()){
  const player=snapshot.vision?.player,stamp=snapshot.vision?.capturedAt||snapshot.vision?.timestamp||0;
  const fresh=stamp>0&&now-stamp<=(snapshot.settings?.performanceMode==='economy'?7000:5000)&&stamp-now<=1000;
  const conflict=snapshot.connection?.status!=='stale'&&(snapshot.connection?.status==='wrong_hero'||snapshot.connection?.status==='spectator'||snapshot.connection?.status==='live'&&(snapshot.hero?.isSpectator===true||snapshot.hero?.isWraithKing===false));
  return Boolean(!snapshot.demo&&!snapshot.capture?.imported&&snapshot.settings?.captureEnabled!==false&&snapshot.settings?.performanceMode!=='gsi'&&fresh&&!conflict&&player?.confirmed===true&&player.heroId===42&&player.source==='selected_hud'&&['radiant','dire'].includes(player.team));
}
function currentScreenLineup(snapshot){return[snapshot.laneRoster?.source,snapshot.laneDetection?.effectiveSource,snapshot.advice?.lane?.detectionSource].includes('screen_current');}
function heroById(id) { return state?.heroes.find(h => h.id === id); }
function node(tag, className, content) { const el = document.createElement(tag); if (className) el.className = className; if (content != null) el.textContent = content; return el; }
function renderPageContext(){text('page-context',currentPage==='draft'?'CORE COACH / DRAFT':'CORE COACH / CARRY');if(state)text('product-role',(currentPage==='draft'?window.DraftUI.positionLabel(state):state.product?.roleLabel||'Керри · позиция 1').toUpperCase());}
function showPage(page) { currentPage = page; document.querySelectorAll('.page').forEach(el => el.classList.toggle('active', el.id === page)); document.querySelectorAll('.nav').forEach(el => el.classList.toggle('active', el.dataset.page === page)); text('page-title', titles[page]);renderPageContext();window.coach.command('set-page',page); if (page === 'vision') drawPreview(); }
document.querySelectorAll('.nav').forEach(button => button.addEventListener('click', () => showPage(button.dataset.page)));
function applyState(next) {
  if (!next) return;
  if(!next.dataset&&(!state?.dataset||next.staticRevision!==state.staticRevision)){if(!fetchingState){fetchingState=true;window.coach.getState().then(value=>{fetchingState=false;applyState(value);});}return;}
  state={...state,...next};next=state;
  draftView?.render(state);
  const { advice, hero, connection, capture, dataset, settings } = state;
  const profile=state.supportedProfiles?.find(profile=>(profile.heroId||profile.id)===(state.activeProfile?.heroId||state.activeProfile?.id));
  if(profile?.name){text('scope-current-hero',profile.name);text('current-hero-name',profile.name);$('wk-portrait').alt=profile.name;imageFor($('wk-portrait'),heroById(profile.heroId||profile.id)?.image);}
  renderHeroProfileSelector();
  renderPageContext();
  if(state.product?.version)document.querySelector('.version span').textContent=state.product.version;
  if(state.product?.name&&document.title!==state.product.name)document.title=state.product.name;
  const connected = connection.status === 'live', demo = state.demo;
  const labels = { waiting: 'Ожидаю подключение', stale: 'GSI устарел', wrong_hero: 'Выбран другой герой', spectator: 'Режим наблюдателя', live: 'GSI подключён', demo: 'Демонстрация' };
  text('gsi-label', labels[connection.status] || 'Ожидаю героя');
  $('gsi-dot').classList.toggle('live', connected);
  text('gsi-detail', demo ? 'Пример · данные вымышлены' : connection.receivedAt ? `Получено ${new Date(connection.receivedAt).toLocaleTimeString('ru-RU')}` : 'GSI · 127.0.0.1:43829');
  const screenSelected=selectedScreenHero(state);
  const draftActive=state.draft?.active===true,draftPreview=draftActive&&state.draft?.phase==='preview';
  text('mode-badge', demo ? 'ДЕМО · ПРИМЕР' : draftActive ? draftPreview ? 'ПРОСМОТР ДРАФТА' : state.draft.phase==='strategy' ? 'СТРАТЕГИЯ' : 'ПИК · LIVE' : connected ? 'МАТЧ · LIVE' : screenSelected ? 'ГЕРОИ · SCREEN' : 'ОЖИДАНИЕ');
  $('mode-badge').className = `badge ${demo||draftPreview ? 'demo' : connected||screenSelected||draftActive ? 'live' : ''}`;
  text('hero-level', `Уровень ${fmt(hero?.level)}`); text('hero-time', timeText(hero?.gameTime)); text('hero-gold', `${fmt(hero?.gold)} золота`);
  for (const [key, prop] of [['hp', 'healthPercent'], ['mp', 'manaPercent']]) { const value = hero?.[prop]; text(`${key}-text`, Number.isFinite(value) ? `${Math.round(value)}%` : '—'); $(`${key}-bar`).style.width = `${Number.isFinite(value) ? value : 0}%`; }
  text('phase', phaseNames[advice.phase]);
  const item = advice.item; text('item-name', item?.name || 'Ожидаю данные матча');
  text('item-cost', item ? `${fmt(item.cost)} золота${item.remainingGold < item.cost ? ` · осталось собрать ${fmt(item.remainingGold)}` : ''}` : 'Подключи Dota 2 через GSI');
  text('item-reason', item?.reason || 'Помощник учтёт текущую закупку, время матча и известный состав противников.');
  imageFor($('item-image'), item?.image); $('item-placeholder').hidden = Boolean(item?.image);
  replaceChanged($('alternatives'),JSON.stringify(advice.alternatives),()=>advice.alternatives.map(alt=>{const el=node('div','alternative');if(alt.image){const img=node('img');img.src=alt.image;img.alt='';el.append(img);}el.append(node('span','',alt.name));el.title=alt.reason;return el;}));
  text('item-evidence',item?`${item.source||'Правила выбранного героя'}${Number.isFinite(item.evidenceCount)?` · наблюдений ${fmt(item.evidenceCount)}`:''}`:'Источник билдов · статистика + правила');
  renderCoaching(advice,dataset,settings,hero,capture);
  renderProvider();
  text('action-title', advice.action.title); text('action-reason', advice.action.reason);
  document.querySelector('.action-card').className = `panel action-card ${advice.action.tone}`;
  text('action-icon', advice.action.tone === 'danger' ? '!' : '↗');
  const freshVision = !capture.imported && state.vision && Date.now() - (state.vision.capturedAt || state.vision.timestamp) < 7000;
  $('vision-dot').classList.toggle('live', Boolean(freshVision && state.vision.quality?.usable && !demo));
  text('vision-label', demo ? 'Деморежим · захват приостановлен' : !settings.captureEnabled ? 'Захват выключен' : capture.status);
  const observed = state.vision?.minimap?.heroes || [];
  text('map-detail', freshVision && observed.length ? `Уверенно распознано значков: ${observed.length}. Невидимые позиции остаются неизвестными.` : 'Позиции противников учитываются только при уверенном распознавании.');
  const draft=state.draftRoster;
  const manual=draft?draft.source==='manual':settings.enemyHeroIds.length>0;
  const enemyIds=Array.isArray(draft?.enemyHeroIds)?draft.enemyHeroIds:manual?settings.enemyHeroIds:[];
  replaceChanged($('enemy-roster'),enemyIds.join(','),()=>enemyIds.length?enemyIds.map(id=>heroChip(id)): [node('span','muted small','Состав проверяется по нескольким кадрам верхней панели.')]);
  replaceChanged($('threat-tags'),JSON.stringify(advice.matchup?.threats),()=>Object.entries(advice.matchup?.threats||{}).filter(([,v])=>v).map(([key])=>node('span','threat-tag',threatNames[key]||key)));
  text('matchup-summary', (advice.matchup?.summary || (enemyIds.length ? 'Оценка угроз по составу команд.' : 'После подтверждения состава появится оценка угроз для сборки.')) + (enemyIds.length ? ` · ${draft?.source==='demo'?'Демо: вымышленные герои':manual?'Состав исправлен вручную':'Состав подтверждён по повторным кадрам'}` : ''));
  $('demo-toggle').checked = demo;
  for (const [id, key] of [['capture-enabled','captureEnabled'], ['map-right','minimapOnRight'], ['overlay-visible','overlayVisible'], ['compact','compact']]) $(id).checked = settings[key];
  for (const [id,key] of [['capture-scope','captureScope'], ['monitor-index','monitorIndex'], ['player-team','playerTeam'], ['plan','plan']]) $(id).value = String(settings[key]);
  $('map-icon-size').value=String(settings.minimapHeroSizePx||0);
  $('opacity').value = settings.opacity * 100;
  text('dataset-summary', `${fmt(dataset.itemCount)} предметов · ${fmt(dataset.portraits)} портретов · ${fmt(dataset.minimapTemplates)} иконок миникарты`);
  text('dataset-date', dataset.fetchedAt ? `Данные загружены ${new Date(dataset.fetchedAt).toLocaleString('ru-RU')}. Версия справочника: ${typeof dataset.patch === 'string' ? dataset.patch : dataset.patch?.name || 'не указана'}.` : 'Локальные данные ещё не загружены. Запусти Update-Data.cmd.');
  text('installed-path', state.installedPath);
  if(currentPage==='draft')$('notice').hidden=true;
  else if (state.note) { text('notice', state.note); $('notice').hidden = false; }
  text('capture-source', capture.sourceName || capture.status); text('capture-performance', capture.size ? `${capture.size.width} × ${capture.size.height} · ${capture.analysisMs ?? '—'} мс` : '—');
  if (capture.preview) { imageFor($('screen-preview'), capture.preview); $('preview-empty').hidden = true; } else { $('screen-preview').hidden = true; $('preview-empty').hidden = false; }
  text('capture-result', capture.error || (state.vision ? `Значков героев: ${observed.length} · неопознанных маркеров: ${state.vision.minimap?.uncertainMarkers?.length || 0}${capture.imported ? ' · статичный скриншот' : ''}` : capture.status));
  const detections = observed.map(h => ({ name: h.name || heroById(h.id)?.name || `Hero ${h.id}`, confidence: h.confidence, where: 'миникарта' }));
  for(const h of state.vision?.scene?.heroes||[])detections.push({name:h.name||heroById(h.id)?.name||`Hero ${h.id}`,confidence:h.confidence,where:'у полоски здоровья'});
  for (const slot of state.vision?.roster?.slots || []) if (slot.hero) detections.push({ name: slot.hero.name || heroById(slot.hero.id)?.name, confidence: slot.hero.confidence, where: slot.team });
  if(currentPage==='vision')replaceChanged($('detections-list'),JSON.stringify(detections),()=>detections.length?detections.map(d=>node('div','detection',`${d.name} · ${Math.round(d.confidence*100)}% · ${d.where}`)):[node('span','muted','Пока нет уверенных распознаваний. Проверь масштаб и рамки HUD.')]);
  if (currentPage === 'vision') drawPreview();
  if($('lane-picker-dialog').open&&!lanePickerBusy)renderLanePicker();
}
function renderHeroProfileSelector(){
  const profiles=state.supportedProfiles||[],select=$('hero-profile');
  replaceChanged(select,JSON.stringify(profiles.map(profile=>[profile.heroId||profile.id,profile.name])),()=>profiles.map(profile=>{const option=node('option','',profile.name);option.value=String(profile.heroId||profile.id);return option;}));
  select.value=String(state.activeProfile?.heroId||state.activeProfile?.id||42);
  const playing=typeof state.activeProfile?.locked==='boolean'?state.activeProfile.locked:state.connection?.status==='live'&&!state.demo;
  select.disabled=playing;
  text('hero-profile-note',playing?'Герой выбран по данным игры':'Выбор для просмотра и деморежима');
}
function heroChip(id,prefix=''){const h=heroById(id),el=node('div','enemy-hero');if(h?.image){const img=node('img');img.src=h.image;img.alt='';el.append(img);}el.append(node('span','',prefix+(h?.name||String(id))));return el;}
function rosterForLane(){
  if(state.laneRoster)return state.laneRoster;
  const d=state.laneDetection||{},ids=d.effectiveEnemyHeroIds||[],ally=d.effectiveAllyHeroId;
  const fromId=id=>id?{id,...heroById(id),status:d.status==='confirmed'?'confirmed':d.status==='retained'?'retained':'unknown',confidence:d.confidence,source:d.effectiveSource}:null;
  return {ally:fromId(ally),enemies:ids.map(fromId),status:d.status,reason:d.reason,historical:d.historical,estimatedSupport:true};
}
function laneMember(slot,role,index,current=false){
  const status=slot?.status||'unknown',known=slot?.id&&['confirmed','observing','retained'].includes(status),h=known?heroById(slot.id):null;
  const manual=slot?.source==='manual',el=node('button',`lane-member ${role} ${status}${manual?' manual':''}`),portrait=node('div','lane-portrait'),name=known?(slot.name||h?.name||'Герой'):'Выбрать героя';
  el.type='button';el.dataset.laneSlot=role==='ally'?'ally':`enemy-${index}`;el.setAttribute('aria-haspopup','dialog');el.setAttribute('aria-label',`${role==='ally'?'Выбрать напарника':`Выбрать соперника ${index}`}: ${name}`);
  el.addEventListener('click',()=>openLanePicker(role,index-1));
  const placeholder=node('span','portrait-placeholder','?');portrait.append(placeholder);
  const url=known?(slot.image||h?.image):null;
  if(url){const img=node('img');img.src=url;img.alt=name;img.addEventListener('error',()=>{img.remove();placeholder.hidden=false;});portrait.prepend(img);placeholder.hidden=true;}
  if(status==='observing')portrait.append(node('span','portrait-check','?'));
  const info=node('div','lane-member-info');info.append(node('small','',role==='ally'?current?'СОЮЗНИК РЯДОМ':'НАПАРНИК':`СОПЕРНИК ${index}`),node('strong','',name),node('span','lane-member-origin',manual?'ВЫБРАН ТОБОЙ':known?'АВТО · ИЗМЕНИТЬ':'НАЖМИ ДЛЯ ВЫБОРА'));el.append(portrait,info);
  const statuses={confirmed:'Подтверждён',observing:'Проверяю по нескольким кадрам',retained:'Сохранён по предыдущим наблюдениям',unknown:'Пока не определён'};
  el.title=manual?`${name} · выбран вручную; нажми, чтобы изменить`:`${name} · ${statuses[status]||statuses.unknown}${Number.isFinite(slot?.confidence)?` · уверенность ${Math.round(slot.confidence*100)}%`:''}${current?' · наблюдался рядом с Wraith King; исходный состав линии не подтверждён':role==='ally'?' · вероятный напарник на линии; роль позиции 5 не подтверждена':''} · нажми, чтобы выбрать вручную`;
  return el;
}
function renderLaneRoster(){
  const roster=rosterForLane(),current=currentScreenLineup(state);
  replaceChanged($('lane-roster'),JSON.stringify([roster,current]),()=>[laneMember(roster.ally,'ally',0,current),laneMember(roster.enemies?.[0],'enemy',1,current),laneMember(roster.enemies?.[1],'enemy',2,current)]);
  const manual=Boolean(state.settings?.laneAllyHeroId||state.settings?.laneEnemyHeroIds?.length);
  text('lane-selection-mode',manual?'Ручной выбор имеет приоритет':'Автоопределение включено');
  $('resume-auto-roster').hidden=!manual&&state.settings?.autoLane!==false;
  document.querySelector('#lane-panel .card-top .eyebrow').textContent=current?'ГЕРОИ РЯДОМ С WK':'МАТЧАП ЛИНИИ';
  const labels={confirmed:'Герои определены',observing:'Проверяю состав по нескольким кадрам',retained:'Состав сохранён по прошлым наблюдениям',unknown:'Ожидаю видимые иконки героев'};
  text('lane-roster-note',`${current?roster.status==='retained'?'Последние наблюдения рядом с WK':'Видимые герои рядом с WK':roster.historical?'Состав по ранним кадрам':labels[roster.status]||labels.unknown}${roster.reason?` · ${roster.reason}`:''}`);
  renderLaneDiagnostics();
  const assessment=state.laneOutcome||state.advice?.lane?.outcomeAssessment||{},result=assessment.result||'unknown';
  text('lane-outcome',assessment.label||({won:'Линия выиграна',even:'Линия равная',lost:'Линия проиграна',unknown:'Оценка пока недоступна'}[result]));
  $('lane-outcome').className=`outcome-badge ${result}${assessment.provisional?' provisional':''}`;
  text('lane-outcome-reason',`${assessment.reason||'Оценка появится, когда накопятся наблюдения игры.'}${Number.isFinite(assessment.confidence)&&assessment.confidence>0?` · уверенность ${Math.round(assessment.confidence*100)}%`:''}${assessment.source==='manual'?' · ручная поправка':''}`);
}
function laneRecognitionDiagnostic(snapshot,now=Date.now()){
  const vision=snapshot.vision||{},capture=snapshot.capture||{},settings=snapshot.settings||{},connection=snapshot.connection||{},hero=snapshot.hero||{},detection=snapshot.laneDetection||{},draft=snapshot.draftRoster||{};
  const slots=Array.isArray(vision.roster)?vision.roster:Array.isArray(vision.roster?.slots)?vision.roster.slots:[];
  const portraits=slots.filter(slot=>slot?.hero?.id).length;
  const teams=new Set([...(Array.isArray(draft.enemyHeroIds)?draft.enemyHeroIds:[]),...(Array.isArray(draft.alliedHeroIds)?draft.alliedHeroIds:[])].filter(id=>Number.isInteger(id)&&id>0)).size;
  const mapIcons=Array.isArray(vision.minimap?.heroes)?vision.minimap.heroes.length:0;
  const sceneIcons=Array.isArray(vision.scene?.heroes)?vision.scene.heroes.length:0;
  const ready=Boolean(snapshot.laneRoster?.ally?.id&&snapshot.laneRoster?.enemies?.filter(member=>member?.id).length===2&&['confirmed','retained'].includes(snapshot.laneRoster.status));
  const selected=selectedScreenHero(snapshot,now),current=currentScreenLineup(snapshot);
  const needsGsi=selected&&['waiting','stale'].includes(connection.status);
  const explanation=[!ready?'Верхние портреты определяют команды. Герои рядом с WK определяются по миникарте или иконкам у полосок здоровья.':'',needsGsi?'GSI нужен отдельно для здоровья, золота, навыков и оценки темпа.':''].filter(Boolean).join(' ');
  const output={portraits,teams,mapIcons,sceneIcons,selected,tone:'checking',message:'',explanation};
  if(snapshot.demo)return{...output,tone:'ready',message:'Демонстрация: состав и наблюдения вымышлены.',explanation:''};
  const manualAlly=Boolean(settings.laneAllyHeroId),manualEnemies=Array.isArray(settings.laneEnemyHeroIds)?settings.laneEnemyHeroIds.length:0,automaticSupported=(snapshot.activeProfile?.heroId||snapshot.activeProfile?.id||42)===42;
  if(manualAlly||manualEnemies)return{...output,tone:manualAlly&&manualEnemies===2?'ready':'checking',message:manualAlly&&manualEnemies===2?'Напарник и соперники выбраны тобой. Ручной выбор имеет приоритет.':automaticSupported?'Указанные герои выбраны вручную. Выбери остальные слоты или дождись автоопределения.':'Указанные герои выбраны вручную. Выбери остальные слоты, чтобы уточнить матчап.',explanation:!automaticSupported?'Выбор из команд доступен для этого керри. Ручные участники сохраняются до нового матча.':settings.autoLane===false?'Автоопределение выключено; его можно вернуть одной кнопкой.':'Автоопределение продолжает работать для остальных участников.'};
  if(!automaticSupported)return{...output,message:'Выбери напарника и двух соперников из известных команд: нажми на портрет или «Выбрать линию».',explanation:'Автоопределение участников линии пока доступно для Wraith King. Выбор по командам работает для всех пяти керри.'};
  if(settings.autoLane===false)return{...output,message:'Автоопределение выключено. Нажми «Вернуть автоопределение», чтобы проверять участников линии.'};
  if(capture.imported)return{...output,message:'Это статичный скриншот. Вернись к живому захвату, чтобы накопить наблюдения участников линии.'};
  if(connection.status==='waiting'&&!selected)return{...output,tone:'attention',message:settings.captureScope==='game'?'Жду выбранного Wraith King: оставь открытым нижний HUD с названием героя и верхние портреты. Распознавание экрана работает отдельно от GSI.':connection.receivedAt?'Данные игры поступают, но свой герой ещё не выбран. Жду Wraith King.':'Нет данных своего героя из игры. Установи GSI в настройках и запусти Dota 2 с параметром -gamestateintegration.'};
  if(connection.status==='stale'&&!selected)return{...output,tone:'attention',message:settings.captureScope==='game'?'GSI устарел; жду подтверждения выбранного WK по нижнему HUD. Оставь название героя и верхние портреты в кадре.':'Данные игры перестали поступать. Проверь подключение GSI в настройках; без свежего состояния героя состав линии не обновляется.'};
  if(connection.status==='spectator'||connection.status==='live'&&hero.isSpectator)return{...output,message:'В режиме наблюдателя состав линии своего керри не определяется.'};
  if(connection.status==='wrong_hero'||connection.status==='live'&&hero.isWraithKing===false)return{...output,message:'Сейчас выбран другой герой. Автоопределение линии доступно для своего Wraith King.'};
  if(hero.isPaused&&!selected)return{...output,message:'Матч на паузе. Проверка участников продолжится после снятия паузы.'};
  if(detection.status==='inactive')return{...output,message:detection.reason||'Участники линии сейчас не обновляются.'};
  if(!settings.captureEnabled||settings.performanceMode==='gsi')return{...output,message:'Анализ экрана выключен. Включи его в настройках, чтобы определять героев рядом с Wraith King.'};
  if(capture.error)return{...output,tone:'attention',message:`Захват не обновляется: ${capture.error}. Проверь вкладку «Анализ экрана».`};
  const capturedAt=vision.capturedAt||vision.timestamp||0,ttl=settings.performanceMode==='economy'?7000:5000;
  if(!capturedAt||now-capturedAt>ttl||vision.quality?.usable!==true)return{...output,message:'Жду свежий кадр игры. На вкладке «Анализ экрана» проверь источник изображения и рамки HUD.'};
  if(ready)return{...output,tone:'ready',message:current?snapshot.laneRoster.status==='retained'?'Сохранены последние наблюдения рядом с WK; текущие позиции неизвестны.':'Герои рядом с WK подтверждены по экрану. Исходный состав линии не подтверждён.':snapshot.laneRoster.historical?'Участники сохранены по наблюдениям линии.':'Участники линии подтверждены; состав сохранится, если иконки временно скроются.'};
  if(sceneIcons&&vision.scene?.usable)return{...output,message:detection.reason||'Герои видны возле полосок здоровья. Проверяю состав по нескольким кадрам.'};
  if(selected&&!mapIcons)return{...output,message:detection.reason||'Выбранный WK подтверждён по нижнему HUD. Держи WK, союзника и двух соперников вместе в кадре: проверяю иконки у полосок здоровья по повторным наблюдениям.'};
  if(!mapIcons)return{...output,tone:'attention',message:'На миникарте пока не распознаны значки героев. Держи своего WK и участников линии в кадре: проверю иконки у полосок здоровья. Рамку миникарты и масштаб можно проверить во вкладке «Анализ экрана».'};
  if(!teams)return{...output,message:'Герои на карте видны; принадлежность командам ещё проверяется по повторным кадрам верхней панели.'};
  return{...output,message:detection.reason||'Герои на карте видны. Проверяю повторные наблюдения рядом с Wraith King.'};
}
function renderLaneDiagnostics(){
  const diagnostic=laneRecognitionDiagnostic(state),container=$('lane-recognition');
  container.className=`lane-recognition ${diagnostic.tone}`;
  text('lane-recognition-counts',`Портреты: ${diagnostic.portraits}/10 · Команды: ${diagnostic.teams}/10 · Миникарта: ${diagnostic.mapIcons} · В сцене: ${diagnostic.sceneIcons}${diagnostic.selected?' · WK: HUD':''}`);
  text('lane-recognition-status',diagnostic.message);
  text('lane-recognition-help',diagnostic.explanation);$('lane-recognition-help').hidden=!diagnostic.explanation;
}
function renderCoaching(advice,dataset,settings,hero,capture){
  renderStages(advice,settings);renderSkillBuild(advice);
  const economy=advice.economy||{},lane=advice.lane||{};
  text('networth-value',Number.isFinite(economy.netWorth)?`${economy.exact?'':'≈ '}${fmt(economy.netWorth)}`:'—');text('networth-source',economy.valueSource==='GSI'?'Точные данные GSI':economy.valueSource==='estimate'?'Оценка: предметы + золото':'Нет данных о нетворсе');
  text('cs-value',`${fmt(economy.lastHits)} / ${fmt(economy.denies)}`);text('farm-rate',`GPM ${fmt(economy.gpm)} · XPM ${fmt(economy.xpm)}`);
  text('farm-comparison',economy.comparison||`${fmt(economy.lastHits)} / ${fmt(economy.targetCs)} LH`);
  const ten=economy.checkpoint10;
  text('farm-description',ten?.complete?`На 10 мин: ${Number.isFinite(ten.actualCs)?fmt(ten.actualCs):'нет наблюдения'} / ${fmt(ten.targetCs)} LH · личная цель`:`Личная цель: ${fmt(economy.checkpoint?.targetCs||settings.farmTarget10)} LH к ${economy.checkpoint?.minute||10} мин${Number.isFinite(economy.csDelta)?` · ${economy.csDelta>=0?'+':''}${fmt(economy.csDelta)}`:''}`);
  $('farm-bar').style.width=`${Number.isFinite(economy.lastHits)&&economy.targetCs>0?Math.min(100,economy.lastHits/economy.targetCs*100):0}%`;
  $('farm-bar').parentElement.parentElement.className=`farm-progress ${economy.pace||''}`;
  const stances={aggressive:'АГРЕССИВНО ПО ОКНУ',defensive:'ОСТОРОЖНО',balanced:'КОРОТКИЕ РАЗМЕНЫ',unknown:'ОЖИДАЮ ГЕРОЕВ'};
  text('lane-title',lane.title||'Состав появится по наблюдениям экрана');text('lane-stance',stances[lane.stance]||lane.stance||'ОЖИДАЮ ГЕРОЕВ');text('lane-reason',lane.reason||'Совет учитывает подтверждённых героев рядом с тобой.');
  text('post-lane-plan',Array.isArray(lane.planAfterLane)?lane.planAfterLane.join(' '):typeof lane.planAfterLane==='string'?lane.planAfterLane:lane.planAfterLane?`${lane.planAfterLane.reason} ${(lane.planAfterLane.priorities||[]).join(' ')}`:'План после линии обновится по наблюдениям матча.');
  text('lane-evidence',lane.source||'Правила конкретного матчапа');
  replaceChanged($('lane-tips'),JSON.stringify(lane.tips),()=>(lane.tips||[]).map(tip=>node('li','',typeof tip==='string'?tip:tip.text||tip.reason||'')));
  renderLaneRoster();
  $('lane-result').value=!settings.laneResult||settings.laneResult==='unknown'?'auto':settings.laneResult;$('performance-mode').value=settings.performanceMode||'economy';
  for(const [id,key]of[['farm-target-10','farmTarget10'],['farm-target-20','farmTarget20'],['farm-target-30','farmTarget30']])if(document.activeElement!==$(id))$(id).value=settings[key];
  const metrics=capture.metrics||{};text('performance-detail',`${capture.status} · HUD ${Math.round((metrics.bytes||0)/1024)} КБ/кадр · анализ ${capture.analysisMs??'—'} мс. Полный кадр не пересылается.`);
  const build=dataset.build||{},selectedBuild=build.builds?.find(route=>route.id===advice.item?.buildId)||(settings.plan==='fight'?build.builds?.find(route=>route.id==='armlet-desolator'):null)||build.builds?.[0],sequence=selectedBuild?.sequence||build.build?.items||[];
  text('build-title',`${build.source||'OpenDota'} · ${build.role||build.build?.role||'carry'}`);
  replaceChanged($('build-route'),JSON.stringify(sequence),()=>sequence.filter(step=>step.key&&(Number.isFinite(step.cost)?step.cost>=1000||step.key==='magic_wand':true)&&(!Number.isFinite(step.timeSeconds)||step.timeSeconds>=0)).slice(0,9).map(step=>{const el=node('div','build-step');el.append(node('span','',step.name||step.key.replaceAll('_',' ')));if(Number.isFinite(step.timeSeconds))el.append(node('small','',timeText(step.timeSeconds)));else if(Number.isFinite(step.timingMinutes))el.append(node('small','',`${step.timingMinutes} мин`));return el;}));
  const sample=build.sampleCount??build.builds?.[0]?.matches,patch=typeof build.patch==='string'?build.patch:build.patch?.name;
  text('build-meta',`${build.fetchedAt?new Date(build.fetchedAt).toLocaleString('ru-RU'):'Нет свежего кеша'}${patch?` · ${build.patch?.minorPatchVerified?'патч':'базовый патч'} ${patch}`:''}${Number.isFinite(sample)?` · матчей: ${sample}`:''}${Number.isInteger(build.facet?.id)?` · грань выборки №${build.facet.id}`:''}${build.windowText?` · ${build.windowText}`:''}`);
  const empirical=advice.economy?.benchmark10,cs=empirical?.lastHits,nw=empirical?.netWorth;
  const personal=build.builds?.[0]?.timingKind==='personal_target_or_unspecified',exported=build.builds?.[0]?.timingKind==='authorized_export';
  text('build-caveat',`${personal?'Порядок и ориентиры заданы тобой в личном плане.':exported?'Предметы, навыки и тайминги взяты из разрешённого экспорта.':'Тайминги — покупки в выбранном матче, не обязательный дедлайн.'}${build.patch?.minorPatchVerified===false?' Минорный патч не подтверждён.':''}${Number.isInteger(build.facet?.id)?' Выборка содержит одну грань; твоя грань пока не определена.':''}${cs?` LH@10: медиана ${Math.round(cs.p50)}, n=${cs.sampleSize}.`:''}${nw?` NW@10: ${Math.round(nw.p50)}, n=${nw.sampleSize}.`:''}`);$('refresh-build').disabled=state.connection.status==='live';$('import-build').disabled=state.connection.status==='live';
}
function providerDate(value){
  if(!value)return '—';
  const date=new Date(typeof value==='number'&&value<1e12?value*1000:value);
  return Number.isFinite(date.getTime())?date.toLocaleString('ru-RU'):'—';
}
function renderProvider(){
  const provider=state?.provider||{},configured=Boolean(provider.tokenConfigured),refreshing=Boolean(provider.refreshing),inMatch=state?.connection?.status==='live';
  const statusLabels={needs_token:'НУЖЕН ТОКЕН',missing_token:'НУЖЕН ТОКЕН',token_required:'НУЖЕН ТОКЕН',configured:'ТОКЕН СОХРАНЁН',cached:'СОХРАНЁННЫЕ ДАННЫЕ',ready:'ПОДКЛЮЧЁН',connected:'ПОДКЛЮЧЁН',idle:'ОЖИДАНИЕ',connecting:'ПОДКЛЮЧЕНИЕ',refreshing:'ОБНОВЛЕНИЕ',error:'ПРОВЕРЬ ДОСТУП',fallback:'РЕЗЕРВНЫЙ ИСТОЧНИК',paused_match:'ПОСЛЕ МАТЧА',waiting:'ОЖИДАНИЕ'};
  const cachedStratz=provider.active==='stratz'&&provider.status!=='ready';
  const activeNames={stratz:cachedStratz?'STRATZ · сохранённый кеш':'STRATZ',opendota:'OpenDota · резерв',personal:'Личная сборка'};
  text('provider-status',refreshing?'ОБНОВЛЕНИЕ':statusLabels[provider.status]||(!configured?'НУЖЕН ТОКЕН':'ПРОВЕРКА ДОСТУПА'));
  $('provider-status').className=`badge ${provider.active==='stratz'&&configured&&!refreshing&&['ready','connected'].includes(provider.status)?'live':''}`;
  text('provider-message',provider.message||(!configured?'Получить личный токен можно после входа на сайте STRATZ. До подключения доступен сохранённый резервный билд.':'Токен сохранён. Проверь доступ к API, чтобы получить свежие билды.'));
  text('provider-active',activeNames[provider.active]||state?.dataset?.build?.source||'Источник ещё не подтверждён');
  text('provider-updated',providerDate(provider.lastSuccessAt));
  text('provider-next-refresh',refreshing?'Обновляется сейчас':state?.settings?.autoBuildRefresh===false?'Автообновление выключено':provider.active==='personal'?'После выбора автоматических билдов':inMatch?'После завершения матча':provider.nextRefreshAt?providerDate(provider.nextRefreshAt):!configured?'После подключения STRATZ':'При следующем обновлении');
  text('provider-build-status',refreshing?'ОБНОВЛЕНИЕ':provider.active==='stratz'?cachedStratz?'STRATZ · КЕШ':'STRATZ · API':provider.active==='personal'?'ЛИЧНЫЙ ПЛАН':provider.active==='opendota'?'OPENDOTA · РЕЗЕРВ':'ЛОКАЛЬНЫЙ КЕШ');
  $('stratz-token').placeholder=configured?'Токен сохранён · вставь новый для замены':'Вставь токен для подключения';
  $('save-stratz-token').disabled=providerBusy||refreshing||inMatch||!$('stratz-token').value.trim();
  $('test-stratz').disabled=providerBusy||refreshing||inMatch||!configured;
  $('clear-stratz-token').disabled=providerBusy||refreshing||!configured;
  $('refresh-build').disabled=providerBusy||refreshing||inMatch;
  $('auto-build-refresh').checked=state?.settings?.autoBuildRefresh!==false;
}
function renderStages(advice,settings){
  const stage=advice.stage||{},bundle=advice.stageAdvice||{};
  text('stage-title',stage.title||'Ожидаю матч');text('stage-reason',stage.reason||'');$('stage-mode').value=settings.stageMode||'auto';
  const order=['pregame','laning','transition','midgame','lategame'],index=order.indexOf(stage.id);document.querySelectorAll('[data-stage]').forEach(el=>{el.classList.toggle('active',el.dataset.stage===stage.id);el.classList.toggle('past',order.indexOf(el.dataset.stage)<index);});
  const urgent=advice.action.tone==='danger'||advice.action.source==='screen'||state.hero?.alive===false||advice.action.tone==='warning'&&!['lane','post_lane'].includes(advice.action.source);
  const fallback={'stage-main-title':advice.action.title,'stage-main-reason':advice.action.reason,'stage-skill-title':'Ожидаю навыки из GSI','stage-extra-title':'Ожидаю состояние матча'};
  for(const [id,key]of[['stage-main-title','mainTitle'],['stage-main-reason','mainReason'],['stage-skill-title','skillUseTitle'],['stage-skill-reason','skillUseReason'],['stage-extra-title','extraTitle'],['stage-extra-reason','extraReason']])text(id,urgent&&id==='stage-main-title'?advice.action.title:urgent&&id==='stage-main-reason'?advice.action.reason:bundle[key]||fallback[id]||'');
  const current=currentScreenLineup(state),manualPreview=advice.manualOnly===true||stage.source==='manual_matchup',show=current||manualPreview||stage.id==='laning'||stage.id==='pregame',grid=$('lane-advice-grid'),hidePostLane=current||manualPreview&&stage.id==='unknown';
  grid.hidden=!show;$('lane-stance').hidden=!show;
  grid.querySelector('div:first-child .eyebrow').textContent=manualPreview?'ПРОТИВ ВЫБРАННЫХ ГЕРОЕВ':current?'ПРОТИВ ВИДИМЫХ ГЕРОЕВ':'НА ЛИНИИ';
  grid.querySelector('div:nth-child(2)').hidden=hidePostLane;grid.style.gridTemplateColumns=hidePostLane?'1fr':'';
}
function renderSkillBuild(advice){
  const skills=advice.skills||{},next=skills.next,order=skills.order||[];
  text('skill-state',next?.ready?'ЕСТЬ ОЧКО':'ПЛАН');text('skill-next-key',next?.hotkey||'◇');text('skill-next-label',next?.ready?'МОЖНО ПРОКАЧАТЬ':'ПЛАН СЛЕДУЮЩЕГО УЛУЧШЕНИЯ');text('skill-next-name',next?.label||'Следующий навык не подтверждён');text('skill-next-reason',skills.reason||'');
  replaceChanged($('skill-order'),JSON.stringify([order,next?.upgradeIndex,skills.status,skills.orderKind,state.hero?.abilities]),()=>{
    const ranks={},personal=skills.orderKind==='personal_authored_level_plan',exported=skills.orderKind==='authorized_export_level_plan';
    return order.map((row,i)=>{
      ranks[row.abilityKey]=(ranks[row.abilityKey]||0)+1;
      const rank=ranks[row.abilityKey],known=state.hero?.abilities?.find(ability=>ability.name===row.abilityKey)?.level;
      const el=node('div',`skill-step ${next?.upgradeIndex===(row.upgradeIndex||i+1)?'next':''} ${Number.isFinite(known)&&known>=rank?'learned':''}`);
      const levelLabel=personal?`План ур. ${row.heroLevel}`:exported?`Экспорт ур. ${row.heroLevel}`:row.levelVerified===false?`№${row.upgradeIndex||i+1} · ≥${row.heroLevel}`:`Ур. ${row.heroLevel}`;
      el.append(node('small','',levelLabel),node('strong','',row.hotkey||'✦'),node('span','',row.label||row.abilityKey));
      el.title=`${row.label||row.abilityKey} · ${personal?'уровень из личного плана':exported?'уровень из экспорта':row.levelVerified===false?'минимально допустимый уровень':'уровень из матча'}`;
      return el;
    });
  });
  text('skill-source',`${skills.source||'Источник не указан'}${skills.sourceMatchId?` · матч ${skills.sourceMatchId}`:''}`);text('skill-level-caveat',skills.levelCaveat||'');
}
// Keep the hero first, then economy and the player's concrete lane.
document.querySelector('.hero-strip').after($('economy-panel'),$('stage-panel'),$('lane-panel'));
const laneToolbar=node('div','lane-selection-toolbar'),laneToolbarHint=node('div');
laneToolbarHint.append(node('span','muted small','Нажми на любой портрет, чтобы выбрать героя.'),node('small','lane-selection-mode',''));
laneToolbarHint.lastChild.id='lane-selection-mode';
const chooseLane=node('button','secondary','Выбрать состав');chooseLane.id='choose-lane';chooseLane.type='button';
chooseLane.addEventListener('click',()=>openLanePicker('ally',0,[{role:'enemy',index:0},{role:'enemy',index:1}]));
const laneToolbarActions=node('div','lane-selection-actions');laneToolbarActions.append(chooseLane,$('resume-auto-roster'));
laneToolbar.append(laneToolbarHint,laneToolbarActions);$('lane-roster').after(laneToolbar);
const stageControls=node('div','stage-controls');$('stage-mode').parentElement.append(stageControls);stageControls.append($('stage-mode'));
$('builds').prepend($('build-panel'));
document.querySelector('.version span').textContent='—';
function drawPreview() {
  const canvas = $('preview-canvas'), img = $('screen-preview');
  const rect = $('preview-area').getBoundingClientRect(); canvas.width = Math.round(rect.width); canvas.height = Math.round(rect.height);
  const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!state?.capture.size || img.hidden) return;
  const scaleX = canvas.width / state.capture.size.width, scaleY = canvas.height / state.capture.size.height;
  function box(r, label, color = '#9bddad') { if (!r) return; ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.strokeRect(r.x*scaleX, r.y*scaleY, r.width*scaleX, r.height*scaleY); ctx.font = '10px Segoe UI'; ctx.fillStyle = color; ctx.fillText(label, r.x*scaleX+3, Math.max(12,r.y*scaleY+12)); }
  box(state.vision?.minimap?.rect, 'MINIMAP');
  for (const s of state.vision?.roster?.slots || []) box(s.rect, s.hero ? String(s.hero.id) : '?', s.hero ? '#a3eab5' : '#c7b882');
  for (const h of state.vision?.minimap?.heroes || []) { ctx.beginPath(); ctx.arc(h.screenX*scaleX,h.screenY*scaleY,7,0,2*Math.PI); ctx.strokeStyle = h.team === 'enemy' ? '#e7a59c' : '#9bdfb0'; ctx.stroke(); }
  for(const h of state.vision?.scene?.heroes||[])box({x:h.screenX-12,y:h.screenY-12,width:24,height:24},h.name||String(h.id),h.team==='enemy'?'#e7a59c':'#9bdfb0');
  if (cropMode && dragStart && dragEnd) { ctx.strokeStyle='#fff3c1';ctx.fillStyle='#e4cb6f22'; const x=Math.min(dragStart.x,dragEnd.x)*canvas.width,y=Math.min(dragStart.y,dragEnd.y)*canvas.height,w=Math.abs(dragStart.x-dragEnd.x)*canvas.width,h=Math.abs(dragStart.y-dragEnd.y)*canvas.height; ctx.fillRect(x,y,w,h);ctx.strokeRect(x,y,w,h); }
}
$('screen-preview').addEventListener('load', drawPreview); window.addEventListener('resize', drawPreview);
document.querySelectorAll('.calibration').forEach(button => button.addEventListener('click', () => {
  if (!state?.capture.preview) { text('calibration-help','Сначала получи изображение игры или открой скриншот.'); return; }
  cropMode = button.dataset.crop; dragStart = dragEnd = null; $('preview-area').classList.add('calibrating'); document.querySelectorAll('.calibration').forEach(b=>b.classList.toggle('active', b===button)); text('calibration-help',cropMode==='minimap' ? 'Выдели внутреннюю область миникарты без декоративной рамки.' : 'Выдели один ряд из пяти портретов, без таймера и без полосок здоровья.');
}));
function pointer(event) { const r=$('preview-canvas').getBoundingClientRect(); return {x:Math.max(0,Math.min(1,(event.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(event.clientY-r.top)/r.height))}; }
$('preview-canvas').addEventListener('pointerdown',event=>{if(!cropMode)return;dragStart=dragEnd=pointer(event);event.target.setPointerCapture(event.pointerId);drawPreview();});
$('preview-canvas').addEventListener('pointermove',event=>{if(cropMode&&dragStart){dragEnd=pointer(event);drawPreview();}});
$('preview-canvas').addEventListener('pointerup',async event=>{
  if(!cropMode||!dragStart)return;dragEnd=pointer(event);const r={x:Math.min(dragStart.x,dragEnd.x),y:Math.min(dragStart.y,dragEnd.y),width:Math.abs(dragStart.x-dragEnd.x),height:Math.abs(dragStart.y-dragEnd.y)};
  if(r.width<.02||r.height<.01){text('calibration-help','Область слишком маленькая. Выдели её ещё раз.');dragStart=dragEnd=null;return;}
  const capturePhase=state.vision?.capturePhase||state.capture?.metrics?.capturePhase||(['DOTA_GAMERULES_STATE_HERO_SELECTION','DOTA_GAMERULES_STATE_STRATEGY_TIME'].includes(state.hero?.gameState)?'draft':'game');
  const key=cropMode==='minimap'?'minimapRect':capturePhase==='draft'?'draftRosterRects':'rosterRects';
  const patch=cropMode==='minimap'?{minimapRect:r}:{[key]:window.CalibrationSelection.selectRosterRow({size:state.capture.size,slots:state.vision?.roster?.slots,saved:state.settings[key],team:cropMode,row:r,mapOnRight:state.settings.minimapOnRight,capturePhase})};
  if(patch[key]===null){text('calibration-help','Не удалось сохранить область. Дождись изображения игры и выдели её снова.');return;}
  const applied=await window.coach.updateSettings(patch);
  if(JSON.stringify(applied?.settings?.[key])!==JSON.stringify(patch[key])){text('calibration-help','Область не сохранена. Выдели её внутри изображения игры.');dragStart=dragEnd=null;return;}
  cropMode=null;dragStart=dragEnd=null;$('preview-area').classList.remove('calibrating');document.querySelectorAll('.calibration').forEach(b=>b.classList.remove('active'));text('calibration-help','Калибровка сохранена. Для статичного скриншота открой его повторно; для игры дождись следующего кадра.');
});
function openLanePicker(role,index=0,flow=[]){
  if(!state||lanePickerBusy)return;
  lanePickerRole=role;lanePickerIndex=role==='ally'?0:Math.max(0,Math.min(1,index));lanePickerFlow=[...flow];
  $('lane-hero-search').value='';$('lane-picker-catalog').open=window.LanePicker.teamChoices(state,role).length===0;
  text('lane-picker-status','');renderLanePicker();
  if(!$('lane-picker-dialog').open)$('lane-picker-dialog').showModal();
}
function laneChoiceButton(id,catalog=false){
  const hero=heroById(id),roster=rosterForLane(),current=lanePickerRole==='ally'?roster.ally?.id:roster.enemies?.[lanePickerIndex]?.id,other=lanePickerRole==='enemy'?roster.enemies?.[lanePickerIndex===0?1:0]?.id:null;
  const button=node('button',`${catalog?'hero-choice':'lane-team-choice'}${current===id?' selected':''}`);button.type='button';button.dataset.heroId=String(id);button.disabled=lanePickerBusy;button.setAttribute('aria-pressed',String(current===id));
  if(hero?.image){const img=node('img');img.src=hero.image;img.alt='';button.append(img);}
  button.append(node('span','',hero?.name||String(id)));
  if(!catalog&&other===id)button.append(node('small','','УЖЕ ВЫБРАН · ПЕРЕСТАВИТЬ'));
  button.addEventListener('click',()=>saveLaneChoice(id));return button;
}
function renderLanePicker(){
  const role=lanePickerRole,ids=window.LanePicker.teamChoices(state,role),roster=rosterForLane();
  text('lane-picker-team-label',role==='ally'?'ИЗ МОЕЙ КОМАНДЫ':'ИЗ ВРАЖЕСКОЙ КОМАНДЫ');
  text('lane-picker-title',role==='ally'?'Кто стоит с тобой?':`Соперник ${lanePickerIndex+1} на линии`);
  text('lane-picker-help',lanePickerFlow.length?'Нажми на портрет. Затем выберем следующего участника линии.':'Нажми на портрет — выбор сразу сохранится. Остальное определение продолжит работать.');
  replaceChanged($('lane-picker-slots'),JSON.stringify([roster,role,lanePickerIndex,lanePickerBusy]),()=>[['ally',0,roster.ally],['enemy',0,roster.enemies?.[0]],['enemy',1,roster.enemies?.[1]]].map(([side,index,slot])=>{
    const button=node('button',`lane-picker-slot ${side}${role===side&&(side==='ally'||lanePickerIndex===index)?' active':''}`);button.type='button';button.disabled=lanePickerBusy;
    if(slot?.image){const img=node('img');img.src=slot.image;img.alt='';button.append(img);}else button.append(node('span','slot-question','?'));
    const info=node('span');info.append(node('small','',side==='ally'?'НАПАРНИК':`ВРАГ ${index+1}`),node('strong','',slot?.name||heroById(slot?.id)?.name||'Выбрать'));button.append(info);
    button.addEventListener('click',()=>openLanePicker(side,index));return button;
  }));
  replaceChanged($('lane-team-choices'),JSON.stringify([ids,roster,role,lanePickerIndex,lanePickerBusy]),()=>ids.map(id=>laneChoiceButton(id)));
  $('lane-team-empty').hidden=ids.length>0;
  const query=$('lane-hero-search').value.trim().toLowerCase(),own=window.LanePicker.playerHeroId(state);
  if($('lane-picker-catalog').open)replaceChanged($('lane-catalog-choices'),JSON.stringify([state.staticRevision,query,roster,role,lanePickerIndex,lanePickerBusy,own]),()=>{
    const heroes=(state.heroes||[]).filter(hero=>hero.id!==own&&hero.name.toLowerCase().includes(query)).sort((a,b)=>a.name.localeCompare(b.name));
    return heroes.length?heroes.map(hero=>laneChoiceButton(hero.id,true)):[node('p','muted small','Герой не найден. Попробуй английское название.')];
  });
  $('clear-lane-slot').disabled=lanePickerBusy;
  text('clear-lane-slot',role==='ally'?'Вернуть авто для напарника':`Убрать соперника ${lanePickerIndex+1}`);
}
async function saveLaneChoice(heroId){
  if(lanePickerBusy)return;
  const patch=window.LanePicker.selectionPatch(state,lanePickerRole,lanePickerIndex,heroId);if(!patch)return;
  lanePickerBusy=true;text('lane-picker-status','Сохраняю…');renderLanePicker();
  try{
    const result=await window.coach.updateSettings(patch);
    if(result?.error)throw new Error(result.error);
    if(result?.settings)applyState(result);
    lanePickerBusy=false;
    if(!$('lane-picker-dialog').open){lanePickerFlow=[];return;}
    const next=heroId!==null?lanePickerFlow.shift():null;
    if(next)openLanePicker(next.role,next.index,lanePickerFlow);
    else{$('lane-picker-dialog').close();lanePickerFlow=[];}
  }catch(error){lanePickerBusy=false;text('lane-picker-status',`Не удалось сохранить: ${error.message}`);renderLanePicker();}
}
function renderHeroPicker() {
  const query=$('hero-search').value.toLowerCase().trim(); $('selected-heroes').replaceChildren(...selectedEnemies.map(id=>node('span','',heroById(id)?.name||String(id))));
  $('hero-grid').replaceChildren(...(state?.heroes||[]).filter(h=>h.name.toLowerCase().includes(query)&&(pickerMode==='draft'||h.id!==42)).sort((a,b)=>a.name.localeCompare(b.name)).map(h=>{const button=node('button',`hero-choice ${selectedEnemies.includes(h.id)?'selected':''}`);if(h.image){const img=node('img');img.src=h.image;img.alt='';button.append(img);}button.append(node('span','',h.name));button.addEventListener('click',()=>{if(selectedEnemies.includes(h.id))selectedEnemies=selectedEnemies.filter(id=>id!==h.id);else if(selectedEnemies.length<(pickerMode==='lane'?2:pickerMode==='ally'?1:5))selectedEnemies.push(h.id);renderHeroPicker();});return button;}));
}
function openPicker(mode){if(!state)return;if(mode==='ally'){openLanePicker('ally');return;}if(mode==='lane'){openLanePicker('enemy',0,[{role:'enemy',index:1}]);return;}pickerMode='draft';selectedEnemies=[...state.settings.enemyHeroIds];text('picker-label','ПОЛНЫЙ ДРАФТ');text('picker-title','Выбери до пяти врагов');text('picker-help','Для предметов и карты. Полный драфт не определяет соперников линии.');$('hero-search').value='';renderHeroPicker();$('hero-dialog').showModal();}
$('edit-enemies').addEventListener('click',()=>openPicker('draft'));$('edit-lane-enemies').addEventListener('click',()=>openPicker('lane'));$('edit-lane-ally').addEventListener('click',()=>openPicker('ally'));
$('close-lane-picker').addEventListener('click',()=>{$('lane-picker-dialog').close();lanePickerFlow=[];});
$('lane-picker-dialog').addEventListener('cancel',()=>{lanePickerFlow=[];});
$('lane-hero-search').addEventListener('input',renderLanePicker);$('lane-picker-catalog').addEventListener('toggle',()=>{if($('lane-picker-dialog').open)renderLanePicker();});
$('clear-lane-slot').addEventListener('click',()=>saveLaneChoice(null));
$('hero-profile').addEventListener('change',event=>window.coach.updateSettings({selectedHeroId:Number(event.target.value)}));
$('hero-search').addEventListener('input',renderHeroPicker);$('close-dialog').addEventListener('click',()=>$('hero-dialog').close());$('clear-enemies').addEventListener('click',()=>{selectedEnemies=[];renderHeroPicker();});$('save-enemies').addEventListener('click',async()=>{await window.coach.updateSettings(pickerMode==='lane'?{laneEnemyHeroIds:selectedEnemies}:pickerMode==='ally'?{laneAllyHeroId:selectedEnemies[0]||null}:{enemyHeroIds:selectedEnemies});$('hero-dialog').close();});
for(const [id,key] of [['demo-toggle','demo'],['capture-enabled','captureEnabled'],['map-right','minimapOnRight'],['overlay-visible','overlayVisible'],['compact','compact']])$(id).addEventListener('change',event=>window.coach.updateSettings({[key]:event.target.checked}));
for(const [id,key] of [['capture-scope','captureScope'],['player-team','playerTeam'],['plan','plan']])$(id).addEventListener('change',event=>window.coach.updateSettings({[key]:event.target.value}));
$('monitor-index').addEventListener('change',event=>window.coach.updateSettings({monitorIndex:Number(event.target.value)}));$('opacity').addEventListener('change',event=>window.coach.updateSettings({opacity:Number(event.target.value)/100}));
$('lane-result').addEventListener('change',event=>window.coach.updateSettings({laneResult:event.target.value}));$('performance-mode').addEventListener('change',event=>window.coach.updateSettings({performanceMode:event.target.value}));
$('stage-mode').addEventListener('change',event=>window.coach.updateSettings({stageMode:event.target.value}));
$('resume-auto-roster').addEventListener('click',async()=>{const result=await window.coach.command('resume-auto-lineup');if(result?.settings)applyState(result);});
for(const [id,command]of[['import-build','import-build'],['use-observed-build','use-observed-build']])$(id).addEventListener('click',async()=>{const result=await window.coach.command(command);if(result?.error){text('notice',result.error);$('notice').hidden=false;}});
for(const [id,key]of[['farm-target-10','farmTarget10'],['farm-target-20','farmTarget20'],['farm-target-30','farmTarget30']])$(id).addEventListener('change',event=>window.coach.updateSettings({[key]:Number(event.target.value)}));
for(const [id,command]of[['open-protracker','open-protracker'],['refresh-build','refresh-build']])$(id).addEventListener('click',async()=>{const button=$(id);button.disabled=true;try{const result=await window.coach.command(command);if(result?.error){text('notice',result.error);$('notice').hidden=false;}}finally{button.disabled=command==='refresh-build'&&state.connection.status==='live';}});
for(const id of ['open-stratz','open-stratz-build'])$(id).addEventListener('click',()=>window.coach.command('open-stratz'));
$('auto-build-refresh').addEventListener('change',event=>window.coach.updateSettings({autoBuildRefresh:event.target.checked}));
$('stratz-token').addEventListener('input',renderProvider);
$('stratz-token').addEventListener('keydown',event=>{if(event.key==='Enter'&&!$('save-stratz-token').disabled)$('save-stratz-token').click();});
for(const [id,command]of[['save-stratz-token','set-stratz-token'],['test-stratz','test-stratz'],['clear-stratz-token','clear-stratz-token']])$(id).addEventListener('click',async()=>{
  if(providerBusy)return;
  providerBusy=true;renderProvider();
  try{
    const value=command==='set-stratz-token'?$('stratz-token').value.trim():undefined;
    const result=await window.coach.command(command,value);
    if(result?.error){text('notice',result.error);$('notice').hidden=false;}
  }finally{
    if(command==='set-stratz-token')$('stratz-token').value='';
    providerBusy=false;renderProvider();
  }
});
$('map-icon-size').addEventListener('change',event=>window.coach.updateSettings({minimapHeroSizePx:Number(event.target.value)}));
for(const [id,command] of [['overlay-toggle','toggle-overlay'],['move-overlay','toggle-edit'],['install-gsi','install-gsi'],['export-gsi','export-gsi'],['reload-data','reload-data'],['import-screenshot','import-screenshot'],['resume-capture','resume-capture'],['reset-calibration','reset-calibration'],['quit','quit']])$(id).addEventListener('click',async()=>{const result=await window.coach.command(command);if(result?.error){text('notice',result.error);$('notice').hidden=false;}});
window.coach.onState(applyState);window.coach.getState().then(applyState);
