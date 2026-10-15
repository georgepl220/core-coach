'use strict';
(function(root){
  const fields={ally:'draftAllyHeroIds',enemy:'draftEnemyHeroIds',bans:'draftBannedHeroIds'};
  const rosterFields={ally:'allyHeroIds',enemy:'enemyHeroIds',bans:'bannedHeroIds'};
  const positions=[{id:1,label:'Керри',short:'Керри'},{id:2,label:'Мидер',short:'Мид'},{id:3,label:'Офлейнер',short:'Офлейн'},{id:4,label:'Саппорт',short:'Саппорт'},{id:5,label:'Полная поддержка',short:'Фулл саппорт'}];
  const ranks=[{id:'all',label:'Все рейтинги',short:'Все рейтинги'},{id:'HERALD_GUARDIAN',label:'Рекрут / Страж'},{id:'CRUSADER_ARCHON',label:'Рыцарь / Герой'},{id:'LEGEND_ANCIENT',label:'Легенда / Властелин'},{id:'DIVINE_IMMORTAL',label:'Божество / Титан'}];
  function rankId(snapshot={}){const id=snapshot.settings?.draftRankId;return ranks.some(rank=>rank.id===id)?id:'all';}
  function rankLabel(id){const rank=ranks.find(option=>option.id===id);return rank?.short||rank?.label||'Неизвестный рейтинг';}
  function refreshContext(stats={},selectedRank='all'){
    const requested=stats.requestedRankId||stats.rankId||selectedRank,active=stats.refreshingRankId||null,pending=stats.pendingRankId||stats.queuedRankId||null;
    const selectedRefreshing=active?active===requested:stats.refreshing===true||stats.status==='refreshing';
    const selectedQueued=pending?pending===requested:stats.refreshQueued===true||stats.status==='queued';
    const progress=[];
    if(active)progress.push(`${active===requested?'Загружается выбранный рейтинг':'Загружается другой рейтинг'}: ${rankLabel(active)}`);
    else if(selectedRefreshing)progress.push(`Загружается выбранный рейтинг: ${rankLabel(requested)}`);
    if(pending)progress.push(`${pending===requested?'Выбранный рейтинг в очереди':'В очереди другой рейтинг'}: ${rankLabel(pending)}`);
    else if(selectedQueued)progress.push(`Выбранный рейтинг в очереди: ${rankLabel(requested)}`);
    return{requested,active,pending,selectedRefreshing,selectedQueued,disabled:selectedRefreshing||selectedQueued,progress:progress.join(' · '),buttonText:selectedQueued?'В очереди':selectedRefreshing?'Обновляю данные':active?'Поставить в очередь':'Обновить данные'};
  }
  function sourceStatus(stats={},selectedRank='all'){
    const context=refreshContext(stats,selectedRank),sourceMessage=typeof stats.message==='string'?stats.message:'';
    const important=stats.status==='error'||Boolean(stats.errorCode)||stats.status==='partial';
    const text=plainText([...new Set((important?[sourceMessage,context.progress]:[context.progress,sourceMessage]).filter(Boolean))].join(' · '));return text?text[0].toLocaleUpperCase()+text.slice(1):'';
  }
  function positionId(snapshot={}){const id=Number(snapshot.draft?.positionId??snapshot.settings?.draftPositionId);return positions.some(position=>position.id===id)?id:1;}
  function positionLabel(snapshot={}){return snapshot.draft?.positionLabel||positions.find(position=>position.id===positionId(snapshot)).label;}
  function ids(value){return Array.isArray(value)?[...new Set(value.filter(id=>Number.isInteger(id)&&id>0))]:[];}
  function recommendationsFor(draft={}){const list=draft.locked&&draft.chosenRecommendation?[draft.chosenRecommendation,...(draft.recommendations||[])]:draft.recommendations||[],seen=new Set();return list.filter(rec=>{if(!rec||seen.has(rec.heroId))return false;seen.add(rec.heroId);return true;}).slice(0,5);}
  function plainText(value){return String(value||'').replace(/через\s+(?:STRATZ|OpenDota)\b/gi,'').replace(/\b(?:STRATZ|OpenDota)\s*:\s*/gi,'').replace(/\b(?:STRATZ|OpenDota)\b/gi,'').replace(/\s+([.,;])/g,'$1').replace(/\s+/g,' ').trim();}
  function heroNames(rows,limit=2){return [...new Set(rows.map(row=>plainText(row.name)||`герой ${row.heroId}`))].slice(0,limit).join(' и ');}
  function presentation(rec={},draft={}){
    const assessment=rec.draftAssessment||{},rows=matchupEvidence(rec),visible=rows.filter(row=>row.displayRelevant!==false),enemy=rows.filter(row=>row.side==='enemy'),ally=rows.filter(row=>row.side==='ally');
    const positive=side=>visible.filter(row=>row.side===side&&row.contribution>0).sort((a,b)=>b.contribution-a.contribution),negative=side=>visible.filter(row=>row.side===side&&row.contribution<0).sort((a,b)=>a.contribution-b.contribution);
    const enemyGood=positive('enemy'),allyGood=positive('ally'),enemyBad=negative('enemy'),allyBad=negative('ally');
    const enemyNet=Number.isFinite(assessment.enemies?.netContribution)?assessment.enemies.netContribution:Number.isFinite(rec.scoreBreakdown?.enemies)?rec.scoreBreakdown.enemies:enemy.reduce((sum,row)=>sum+row.contribution,0),allyNet=Number.isFinite(assessment.allies?.netContribution)?assessment.allies.netContribution:Number.isFinite(rec.scoreBreakdown?.allies)?rec.scoreBreakdown.allies:ally.reduce((sum,row)=>sum+row.contribution,0);
    const coverage=rec.dataCoverage||{},known=(assessment.enemies?.known??coverage.enemies?.known??ids(draft.enemyHeroIds).length)+(assessment.allies?.known??coverage.allies?.known??ids(draft.allyHeroIds).filter(id=>id!==rec.heroId).length),used=rows.length,missing=Math.max(0,assessment.missingPairs??known-used);
    const baseline=assessment.baseline||{},position=Number(rec.positionId||baseline.positionId||draft.positionId)||1,roleConfirmed=baseline.roleFiltered??rec.roleFiltered,roleEstimated=baseline.positionEstimated??rec.positionEstimated,rate=Number.isFinite(baseline.winRate)?baseline.winRate:rec.baselineWinRate;
    const available=baseline.available??(coverage.baseline?coverage.baseline.used:Number.isFinite(rate)&&rec.baselineGames>0),roleBaseline=Boolean(available&&(roleConfirmed||roleEstimated)&&Number.isFinite(rate)&&rate>=0&&rate<=1),roleNames={1:'керри',2:'миде',3:'офлейне',4:'саппорте',5:'полной поддержке'};
    const baselineSummary=roleBaseline?`${numberText(rate*100)}%${roleEstimated?' · роль оценена':` на ${roleNames[position]||'позиции'}`}`:'Нет WR на позиции';
    const noSignal=!enemyGood.length&&!allyGood.length&&!enemyBad.length&&!allyBad.length;
    const enemyDirectional=assessment.enemies?.hasDirectionalSignal!==false,allyDirectional=assessment.allies?.hasDirectionalSignal!==false;
    const enemyNegative=enemyDirectional&&enemyNet<0&&enemyBad.length>0,allyNegative=allyDirectional&&allyNet<0&&allyBad.length>0,enemyPositive=enemyDirectional&&enemyNet>0&&enemyGood.length>0,allyPositive=allyDirectional&&allyNet>0&&allyGood.length>0;
    const unfavorableContext=!['favorable','neutral'].includes(assessment.status)&&(enemyNegative||enemyNet+allyNet<0&&allyNegative);
    let tone='neutral',label='Нет явного плюса';
    if(!used||['no_data','no_context','unknown_context'].includes(assessment.status)){tone='unknown';label='Мало данных';if(!known&&roleBaseline){tone='neutral';label='До пиков';}}
    else if(noSignal||assessment.status==='neutral'){if(missing){tone='unknown';label='Мало данных';}}
    else if(['mixed','unfavorable'].includes(assessment.status)||!assessment.status&&(enemyNegative||allyNegative||enemyGood.length&&enemyBad.length||allyGood.length&&allyBad.length)){tone='negative';label='Есть риск';}
    else if(assessment.status==='favorable'||enemyPositive||allyPositive){tone='positive';label='Есть плюсы';}
    let why='';
    if(unfavorableContext&&roleBaseline&&rate>.5)why='WR на роли выше 50%, но драфт неудобен.';
    else{const reasons=[];if(enemyGood.length)reasons.push(`Лучше против ${heroNames(enemyGood)}.`);if(allyGood.length)reasons.push(`Сочетается с ${heroNames(allyGood,1)}.`);why=reasons.join(' ');}
    if(!why)why=!used?roleBaseline?'Пока ориентир — WR на выбранной позиции.':'Добавь пики команд, чтобы сравнить варианты.':tone==='negative'?'Известные сочетания требуют осторожности.':'Явного преимущества по известным пикам нет.';
    const risk=enemyBad.length?`Тяжелее против ${heroNames(enemyBad)}.`:allyBad.length?`Хуже сочетается с ${heroNames(allyBad)}.`:missing?'Не все сочетания оценены.':!used?!known?'Пики ещё могут изменить выбор.':'Матчапы ещё не определены.':'Явных минусов по известным пикам не видно.';
    const positiveCopy=[enemyGood.length?`Лучше против ${heroNames(enemyGood,10)}.`:'',allyGood.length?`Сочетается с ${heroNames(allyGood,10)}.`:''].filter(Boolean).join(' '),negativeCopy=[enemyBad.length?`Тяжелее против ${heroNames(enemyBad,10)}.`:'',allyBad.length?`Хуже сочетается с ${heroNames(allyBad,10)}.`:'',missing?'Часть известных сочетаний пока не оценена.':'',!roleBaseline?'Проверенного винрейта на выбранной позиции нет.':''].filter(Boolean).join(' ');
    return{label,tone,baselineSummary,why,risk,whyTitle:positiveCopy||why,riskTitle:negativeCopy||risk,limited:missing>0||!used||!roleBaseline,nearTie:rec.comparison?.closeScore===true};
  }
  function rosterPatch(snapshot,role,index,heroId){
    if(!fields[role]||!Number.isInteger(heroId)||heroId<=0)return null;
    const draft=snapshot.draft||{},current=ids(draft[rosterFields[role]]).slice(0,role==='bans'?50:5);
    if(role==='bans'){
      const at=current.indexOf(heroId);if(at>=0)current.splice(at,1);else if(current.length<50)current.push(heroId);else return null;
    }else{
      if(heroId===draft.ownHeroId&&draft.locked)return null;
      index=Math.max(0,Math.min(Number.isInteger(index)?index:current.length,current.length,4));
      const other=current.indexOf(heroId);
      if(other>=0&&other!==index){const old=current[index];current[index]=heroId;if(old)current[other]=old;else current.splice(other,1);}
      else current[index]=heroId;
    }
    const patch={[fields[role]]:current};
    for(const other of Object.keys(fields))if(other!==role){const before=ids(draft[rosterFields[other]]);if(before.includes(heroId)&&current.includes(heroId))patch[fields[other]]=before.filter(id=>id!==heroId);}
    return patch;
  }
  function catalog(snapshot,query='',role='enemy'){
    const heroes=snapshot.heroes||[],search=String(query).trim().toLocaleLowerCase();
    return heroes.filter(hero=>Number.isInteger(hero?.id)&&(!search||`${hero.name||''} ${hero.localizedName||''} ${hero.internalName||''}`.toLocaleLowerCase().includes(search))).sort((a,b)=>String(a.name).localeCompare(String(b.name)));
  }
  function pages(snapshot,query,role,page=0,pageSize=15){const list=catalog(snapshot,query,role),count=Math.max(1,Math.ceil(list.length/pageSize)),current=Math.max(0,Math.min(page,count-1));return{heroes:list.slice(current*pageSize,(current+1)*pageSize),page:current,count,total:list.length};}
  function scopeText(scope){
    if(typeof scope==='string')return scope;
    if(!scope||typeof scope!=='object')return 'Область статистики не подтверждена';
    const rank=scope.rank||scope.bracket,rankName=ranks.find(option=>option.id===rank)?.label||rank;
    return [scope.role||scope.position,scope.patch?`Патч ${scope.patch}`:'Патч неизвестен',rankName||'Рейтинг не подтверждён',scope.region].filter(value=>typeof value==='string'||typeof value==='number').join(' · ');
  }
  function numberText(value,signed=false){if(!Number.isFinite(value))return '—';const rounded=Math.round(value*10)/10,absolute=Math.abs(rounded).toLocaleString('ru-RU',{minimumFractionDigits:1,maximumFractionDigits:1});return `${rounded<0?'−':signed&&rounded>0?'+':''}${absolute}`;}
  function breakdownText(rec={}){
    const b=rec.scoreBreakdown;if(!b||![b.baseline,b.enemies,b.allies,b.total].every(Number.isFinite))return '';
    const initial=Number.isFinite(b.initial)?b.initial:50;
    return `База ${numberText(initial+b.baseline)} · Враги ${numberText(b.enemies,true)} · Союзники ${numberText(b.allies,true)} → ${numberText(b.total)}`;
  }
  function baselineText(rec={}){
    if(!Number.isFinite(rec.baselineWinRate)||rec.baselineWinRate<0||rec.baselineWinRate>1||!Number.isFinite(rec.baselineGames)||rec.baselineGames<=0)return '';
    const scope=rec.roleFiltered?`Позиция ${Number.isInteger(rec.positionId)?rec.positionId:'выбрана'}`:rec.positionEstimated?'Позиция оценена':'Все позиции';
    return `${scope} · WR ${numberText(rec.baselineWinRate*100)}% · ${Math.round(rec.baselineGames).toLocaleString('ru-RU')} матчей`;
  }
  function matchupEvidence(rec={}){return Array.isArray(rec.matchupEvidence)?rec.matchupEvidence.filter(row=>row&&['enemy','ally'].includes(row.side)&&Number.isFinite(row.advantagePp)&&Number.isFinite(row.contribution)):[];}
  function matchupSummary(rec={}){
    const rows=matchupEvidence(rec);if(!rows.length)return '';
    const parts=['enemy','ally'].map(side=>{const group=rows.filter(row=>row.side===side);return group.length?`${side==='enemy'?'враги':'союзники'} ${group.filter(row=>row.advantagePp<0).length}/${group.length}`:'';}).filter(Boolean);
    return `Пары хуже нормы: ${parts.join(' · ')}`;
  }
  function matchupTitle(rec={}){return matchupEvidence(rec).map(row=>`${row.side==='enemy'?'Против':'Вместе с'} ${row.name||`героем ${row.heroId}`}: эффект ${numberText(row.advantagePp,true)} п.п.; вклад ${numberText(row.contribution,true)} балла; ${Number.isFinite(row.games)?Math.round(row.games).toLocaleString('ru-RU'):'—'} матчей${row.roleFiltered?' · выбранная позиция':' · позиции смешаны'}`).join('\n');}
  function dateText(value,short=false){if(!value)return '';const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleDateString('ru-RU',short?{day:'2-digit',month:'2-digit',timeZone:'UTC'}:{timeZone:'UTC'}):'';}
  function coverageText(rec={}){
    const coverage=rec.dataCoverage;if(!coverage)return '';
    const parts=['enemies','allies'].map(key=>{const group=coverage[key];return group&&Number.isInteger(group.known)?`${key==='enemies'?'враги':'союзники'} ${group.used||0}/${group.known}`:'';}).filter(Boolean),base=coverage.baseline&&!coverage.baseline.used?coverage.baseline.available?'WR не учтён':'Базы WR нет':'';return[base,parts.length?`Учтено: ${parts.join(' · ')}`:''].filter(Boolean).join(' · ');
  }
  function coverageTitle(rec={}){
    const coverage=rec.dataCoverage;if(!coverage)return '';
    const baseline=coverage.baseline||{},parts=[`База: ${baseline.used?'учтена':baseline.available?'не использована':'нет данных'}${Number.isFinite(baseline.games)?` · ${Math.round(baseline.games).toLocaleString('ru-RU')} матчей`:''}`];
    for(const key of['enemies','allies']){const group=coverage[key];if(!group)continue;parts.push(`${key==='enemies'?'Враги':'Союзники'}: ${group.used||0}/${group.known||0} пар учтено; нет данных ${group.missing||0}; малая выборка ${group.lowSample||0}; отклонено ${group.rejected||0}`);}
    parts.push('Отсутствующая или отклонённая пара означает неизвестный эффект, а не нейтральный матчап.');return parts.join('\n');
  }
  function freshnessPart(component={},label='База',short=false){
    const observed=['unknown','missing'].includes(component.status)?'':dateText(displayThrough(component),short),rejected=component.rejected===true||component.status==='rejected';
    if(!rejected&&!observed&&component.periodBoundsVerified===true&&component.periodMethod==='stratz_unix_week_roundtrip'&&dateText(component.periodStart,short))return `${label}: неделя с ${dateText(component.periodStart,short)}`;
    return `${label}${rejected?label.toLocaleLowerCase()==='пары'?' отклонены':' отклонена':observed?` по ${observed}`:': период неизвестен'}`;
  }
  function displayThrough(component={}){const value=component.observedUntilExclusive||component.observedThrough;if((component.observedUntilExclusive||component.observedThroughKind==='exclusive_period_end')&&Number.isFinite(Date.parse(value)))return new Date(Date.parse(value)-1).toISOString();return value;}
  function freshnessText(rec={}){const freshness=rec.dataFreshness;if(!freshness)return '';return[freshnessPart(freshness.baseline,'База',true),freshnessPart(freshness.pairs,'пары',true)].join(' · ');}
  function freshnessTitle(rec={}){
    const freshness=rec.dataFreshness;if(!freshness)return '';
    return ['baseline','pairs'].map(key=>{const component=freshness[key]||{},label=key==='baseline'?'База':'Пары',from=dateText(component.observedFrom),through=dateText(displayThrough(component));return `${freshnessPart(component,label)}${from&&through?` · начало ${from}`:''}${component.rejected&&through?` · последние наблюдения ${through}`:''}${component.periodBoundsVerified===true?` · проверенные границы недели ${dateText(component.periodStart)} — ${dateText(component.periodEndExclusive)} UTC, конец не включён${component.periodPartial?' · при загрузке неделя ещё не завершилась':''} · время последнего матча неизвестно`:''} · ${scopeText(component.scope)}${key==='pairs'&&component.roleFiltered===false?' · позиции пары смешаны':''}${Number.isFinite(component.weight)?` · вес качества ${numberText(component.weight*100)}%`:''}`;}).join('\n');
  }
  function comparisonText(rec={}){return rec.comparison?.closeScore?'Близкие оценки · порядок не доказан':'';}
  function comparisonTitle(rec={}){if(!rec.comparison)return '';return `Статистическое превосходство не установлено. ${Number.isFinite(rec.comparison.nearestGap)?`Разница с ближайшим героем: ${numberText(rec.comparison.nearestGap)} балла. `:''}Метка близости основана на разнице баллов; это не доверительный интервал и не вероятность лучшего пика.`;}
  function statsDates(stats={}){
    const observed=dateText(stats.observedThrough),fetched=dateText(stats.updatedAt);
    if(stats.components){const{baseline={},pairs={}}=stats.components;return{label:[freshnessPart(baseline,'База'),freshnessPart(pairs,'пары')].join(' · '),title:[freshnessTitle({dataFreshness:stats.components}),fetched?`Загружено: ${fetched}`:''].filter(Boolean).join('\n')};}
    return{label:observed?`Выборка по ${observed}`:fetched?`Загружено ${fetched}`:'',title:[observed?`Последний день выборки: ${observed}`:'Последний день выборки не указан',fetched?`Загружено: ${fetched}`:''].filter(Boolean).join(' · ')};
  }
  function create(container,options={}){
    const document=container.ownerDocument||root.document,compact=options.compact===true,refs={},signatures=new Map();
    let snapshot={},pickerOpen=false,role='enemy',slot=0,page=0,query='',busy=false,message='',phase='inactive';
    const node=(tag,className,text)=>{const el=document.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=text;return el;};
    const make=(key,tag,className,text,parent=container)=>{const el=node(tag,className,text);refs[key]=el;parent.append(el);return el;};
    const button=(text,action,className='draft-button')=>{const el=node('button',className,text);el.type='button';el.addEventListener('click',action);return el;};
    const changed=(key,signature,build)=>{signature=JSON.stringify(signature);if(signatures.get(key)!==signature){signatures.set(key,signature);refs[key].replaceChildren(...build());}};
    const heroById=id=>(snapshot.heroes||[]).find(hero=>hero.id===id);
    const portrait=hero=>{if(!hero?.image)return node('span','draft-question','?');const img=node('img');img.src=hero.image;img.alt='';img.addEventListener('error',()=>img.replaceWith(node('span','draft-question','?')),{once:true});return img;};
    container.classList.add('draft-ui');if(compact)container.classList.add('draft-compact');
    const heading=make('heading','div','draft-heading');
    const headingText=make('headingText','div','',undefined,heading);make('eyebrow','span','draft-label','ПОМОЩЬ В ПИКЕ',headingText);make('title','h2','','Выбери героя под этот драфт',headingText);make('phase','span','draft-phase','ОЖИДАНИЕ',heading);
    const position=make('position','div','draft-position');make('positionLabel','span','draft-label','МОЯ ПОЗИЦИЯ',position);make('positionButtons','div','draft-position-buttons',undefined,position);
    const teams=make('teams','div','draft-teams');
    for(const key of ['ally','enemy']){
      const row=make(`${key}Group`,'div',`draft-team draft-team-${key}`,undefined,teams);make(`${key}Label`,'div','draft-label',key==='ally'?'МОЯ КОМАНДА':'СОПЕРНИКИ',row);make(key,'div','draft-team-slots',undefined,row);
    }
    const tools=make('tools','div','draft-tools');
    refs.bansButton=button('Баны · 0',()=>openPicker('bans',0));tools.append(refs.bansButton);
    refs.autoButton=button('Вернуть авто',()=>run(()=>options.command('draft-reset')));tools.append(refs.autoButton);
    if(compact){for(const side of ['radiant','dire']){const key=`${side}Button`;refs[key]=button(side==='radiant'?'Radiant':'Dire',()=>run(()=>options.updateSettings({draftOwnTeam:side})));refs[key].title=`Моя команда — ${side==='radiant'?'Radiant':'Dire'}`;refs[key].setAttribute('aria-label',refs[key].title);tools.append(refs[key]);}}
    if(!compact){refs.refreshButton=button('Обновить данные',()=>run(()=>options.command('draft-refresh')));tools.append(refs.refreshButton);refs.previewButton=button('Проверить драфт',()=>run(()=>options.updateSettings({draftMode:'preview'})));tools.append(refs.previewButton);refs.side=node('select','draft-side');refs.side.setAttribute('aria-label','Моя сторона в драфте');for(const[value,label]of[['auto','Сторона: авто'],['radiant','Я за Radiant'],['dire','Я за Dire']]){const option=node('option','',label);option.value=value;refs.side.append(option);}refs.side.addEventListener('change',()=>{const selected=refs.side.value;return run(()=>options.updateSettings({draftOwnTeam:selected}));});tools.append(refs.side);refs.rank=node('select','draft-rank');refs.rank.setAttribute('aria-label','Рейтинг статистики');refs.rank.title='Выбери свой рейтинг. Если данных ещё нет, нажми «Обновить данные».';for(const rank of ranks){const option=node('option','',rank.label);option.value=rank.id;refs.rank.append(option);}refs.rank.addEventListener('change',()=>{const selected=refs.rank.value;return run(()=>options.updateSettings({draftRankId:selected}));});tools.append(refs.rank);}
    make('summary','p','draft-summary','Известные пики уточняют советы. Неизвестные герои остаются пустыми.');
    make('detection','p','draft-detection','Пики команд определяются автоматически. Нажми портрет, если нужна поправка.');
    const picker=make('picker','section','draft-catalog');picker.hidden=true;picker.setAttribute('aria-label','Исправить состав драфта');
    const pickerHead=make('pickerHead','div','draft-catalog-head',undefined,picker);make('pickerTitle','strong','','Выбери героя',pickerHead);refs.closeButton=button('×',closePicker,'draft-close');refs.closeButton.setAttribute('aria-label','Закрыть выбор');pickerHead.append(refs.closeButton);
    make('tabs','div','draft-picker-tabs',undefined,picker);
    if(!compact){make('search','input','draft-search',undefined,picker);refs.search.placeholder='Найти героя…';refs.search.setAttribute('aria-label','Поиск героя');refs.search.addEventListener('input',()=>{query=refs.search.value;page=0;renderPicker();});}
    make('choices','div','draft-catalog-grid',undefined,picker);
    const pager=make('pager','div','draft-pager',undefined,picker);refs.prevButton=button('←',()=>{page--;renderPicker();});pager.append(refs.prevButton);make('pageLabel','span','','',pager);refs.nextButton=button('→',()=>{page++;renderPicker();});pager.append(refs.nextButton);refs.clearButton=button('Убрать из слота',clearSlot);pager.append(refs.clearButton);
    make('pickerNote','p','draft-picker-note','Нажми портрет — выбор сразу сохранится.',picker);
    make('recommendations','div','draft-recommendations');
    make('empty','div','draft-empty','Рекомендации появятся после получения состава и данных.');
    if(!compact){make('explanation','p','draft-explanation','По статистике известных пиков. Близкие варианты могут быть равноценны.');}
    const bottom=make('bottom','div','draft-bottom');make('source','span','draft-source','',bottom);refs.source.hidden=true;refs.finishButton=button('Закончить просмотр',()=>run(()=>options.command('draft-finish-preview')));bottom.append(refs.finishButton);
    make('status','p','draft-status','');refs.status.setAttribute('role','status');refs.status.setAttribute('aria-live','polite');
    async function run(action){
      if(busy)return;busy=true;message='Сохраняю…';render(snapshot);
      try{const result=await action();if(result?.error)throw new Error(result.error);if(options.applyState){if(result?.draft)options.applyState(result);else if(options.getState)options.applyState(await options.getState());}message='';}
      catch(error){message=`Не удалось сохранить: ${error.message}`;}
      finally{busy=false;render(snapshot);}
    }
    function openPicker(nextRole='enemy',index=0){if(busy)return;role=['ally','enemy','bans'].includes(nextRole)?nextRole:'enemy';slot=Math.max(0,Math.min(index,4));page=0;query='';if(refs.search)refs.search.value='';pickerOpen=true;render(snapshot);}
    function closePicker(){pickerOpen=false;message='';render(snapshot);}
    function togglePicker(){if(pickerOpen)closePicker();else openPicker('enemy',(snapshot.draft?.enemyHeroIds||[]).length);}
    function clearSlot(){
      const selected=ids(snapshot.draft?.[rosterFields[role]]);if(role==='bans')selected.length=0;else selected.splice(slot,1);
      return run(()=>options.updateSettings({[fields[role]]:selected})).then(()=>{if(!message)closePicker();});
    }
    function choose(heroId){
      if(busy)return;
      const patch=rosterPatch(snapshot,role,slot,heroId);if(!patch)return;
      return run(()=>options.updateSettings(patch)).then(()=>{if(!message&&role!=='bans')closePicker();});
    }
    function renderTeams(){
      for(const key of ['ally','enemy']){
        const selected=ids(snapshot.draft?.[rosterFields[key]]).slice(0,5);
        changed(key,[selected,snapshot.draft?.ownHeroId,snapshot.draft?.locked,selected.map(heroById)],()=>Array.from({length:5},(_,index)=>{
          const hero=heroById(selected[index]),own=snapshot.draft?.locked&&selected[index]===snapshot.draft?.ownHeroId,el=button('',()=>openPicker(key,index),`draft-slot${hero?' known':''}${own?' own':''}`);el.dataset.draftRole=key;el.dataset.draftSlot=String(index);el.append(portrait(hero));el.title=own?`${hero?.name||'Твой герой'} · твой выбранный герой`:`${hero?.name||'Пустой слот'} · нажми для исправления`;el.setAttribute('aria-label',`${key==='ally'?'Союзник':'Соперник'} ${index+1}: ${hero?.name||'выбрать'}`);if(!compact)el.append(node('span','draft-slot-name',hero?.name||'Выбрать'));if(own)el.append(node('span','draft-own-tag','ТЫ'));el.disabled=own||busy;return el;
        }));
      }
    }
    function renderPicker(){
      refs.picker.hidden=!pickerOpen;refs.recommendations.hidden=pickerOpen;refs.empty.hidden=pickerOpen||recommendationsFor(snapshot.draft).length>0;
      if(compact)refs.tools.hidden=pickerOpen;
      if(!pickerOpen)return;
      refs.pickerTitle.textContent=role==='bans'?'Недоступные герои':`${role==='ally'?'Союзник':'Соперник'} ${slot+1}`;
      changed('tabs',role,()=>[['ally','Союзники'],['enemy','Враги'],['bans','Баны']].map(([key,label])=>{const el=button(label,()=>openPicker(key,Math.min((snapshot.draft?.[rosterFields[key]]||[]).length,4)),`draft-button${role===key?' selected':''}`);el.setAttribute('aria-pressed',String(role===key));return el;}));
      const result=pages(snapshot,query,role,page,compact?15:20);page=result.page;
      const selected=ids(snapshot.draft?.[rosterFields[role]]);
      changed('choices',[role,slot,page,result.heroes,selected,snapshot.draft?.ownHeroId,snapshot.draft?.locked],()=>result.heroes.map(hero=>{
        const selectedHere=role==='bans'?selected.includes(hero.id):selected[slot]===hero.id;
        const el=button('',()=>choose(hero.id),`draft-catalog-choice${selectedHere?' selected':''}`);el.dataset.heroId=String(hero.id);el.append(portrait(hero),node('span','',hero.name));el.title=hero.name;el.setAttribute('aria-pressed',String(selectedHere));el.disabled=snapshot.draft?.locked&&hero.id===snapshot.draft?.ownHeroId;return el;
      }));
      refs.pageLabel.textContent=`${page+1} / ${result.count} · ${result.total}`;refs.prevButton.disabled=page===0||busy;refs.nextButton.disabled=page+1===result.count||busy;refs.clearButton.textContent=role==='bans'?'Убрать баны':'Убрать из слота';refs.clearButton.disabled=busy;
      refs.pickerNote.textContent=role==='bans'?'Нажми для добавления или снятия бана.':compact?'Выбор сразу сохранится · Ctrl+Alt+L закрыть':'Нажми портрет — выбор сразу сохранится. Для неизвестного состава советы предварительные.';
    }
    function renderRecommendations(){
      const recommendations=recommendationsFor(snapshot.draft);
      changed('recommendations',[recommendations,recommendations.map(rec=>heroById(rec.heroId)),snapshot.draft?.locked],()=>recommendations.map((rec,index)=>{
        const hero=heroById(rec.heroId),view=presentation(rec,snapshot.draft),card=node('article',`draft-recommendation draft-clean-card tone-${view.tone}${index===0?' best':''}`);card.dataset.heroId=String(rec.heroId);
        const chosen=snapshot.draft?.locked&&rec.heroId===snapshot.draft?.ownHeroId,actualRank=(snapshot.draft?.recommendations||[]).findIndex(candidate=>candidate.heroId===rec.heroId)+1,head=node('div','draft-rec-head'),rank=node('span','draft-rec-rank',chosen?'✓':String(actualRank||index+1)),image=node('div','draft-rec-portrait');image.append(portrait(hero));head.append(rank,image);
        const identity=node('div','draft-rec-identity');identity.append(node('strong','',rec.name||hero?.name||'Герой'),node('span','draft-matchup-label',chosen?'Твой выбор':view.label));head.append(identity);card.append(head);
        const copy=node('div','draft-rec-copy'),why=node('p','draft-why',view.why),risk=node('p','draft-risk',view.risk);why.title=view.whyTitle;risk.title=view.riskTitle;copy.append(why,risk);card.append(copy);
        const baseline=node('p','draft-role-winrate',view.baselineSummary);baseline.title='Доля побед героя на выбранной позиции в доступной статистике. Это не прогноз победы в этом матче.';card.append(baseline);return card;
      }));
    }
    function render(next){
      snapshot=next||snapshot;const draft=snapshot.draft||{};
      if(phase!==draft.phase){if(phase!=='inactive')pickerOpen=false;phase=draft.phase||'inactive';}
      refs.phase.textContent={pick:'ПИК',strategy:'СТРАТЕГИЯ',preview:'ПРОСМОТР',inactive:'ОЖИДАНИЕ'}[draft.phase]||'ОЖИДАНИЕ';
      refs.title.textContent=draft.locked?`Герой выбран · ${heroById(draft.ownHeroId)?.name||'твой герой'}`:compact?`${positionLabel(snapshot)} под этот драфт`:`Выбор героя · ${positionLabel(snapshot).toLocaleLowerCase()}`;
      const selectedPosition=positionId(snapshot);changed('positionButtons',selectedPosition,()=>positions.map(position=>{const el=button(compact?String(position.id):`${position.id} · ${position.label}`,()=>run(()=>options.updateSettings({draftPositionId:position.id})),`draft-button draft-position-button${position.id===selectedPosition?' selected':''}`);el.dataset.positionId=String(position.id);el.title=`Позиция ${position.id} · ${position.label}`;el.setAttribute('aria-label',el.title);el.setAttribute('aria-pressed',String(position.id===selectedPosition));return el;}));
      refs.positionLabel.textContent=compact?`ПОЗИЦИЯ · ${positionLabel(snapshot).toLocaleUpperCase()}`:'МОЯ ПОЗИЦИЯ';
      refs.summary.textContent='Пять вариантов под известный драфт. Добавляй пики — список обновится.';
      refs.bansButton.textContent=`Баны · ${ids(draft.bannedHeroIds).length}`;refs.autoButton.title='Снять ручные поправки состава и продолжить распознавание';
      if(compact)for(const key of ['radiantButton','direButton'])refs[key].hidden=Boolean(draft.ownTeam);
      if(refs.previewButton){refs.previewButton.hidden=draft.active===true;refs.side.value=snapshot.settings?.draftOwnTeam||'auto';refs.rank.value=rankId(snapshot);refs.rank.disabled=busy;}
      refs.finishButton.hidden=draft.phase!=='preview';
      refs.bottom.hidden=refs.finishButton.hidden;
      renderTeams();renderRecommendations();renderPicker();
      const detection=draft.detection||{},source={gsi:'GSI',screen:'экран',screen_confirmed:'экран',manual:'ручная поправка',mixed:'авто + поправка'}[detection.source||draft.rosterSource]||detection.source||'';
      const confidence=Number.isFinite(detection.confidence)?`${Math.round(detection.confidence<=1?detection.confidence*100:detection.confidence)}%`:'';
      const known=`${ids(draft.allyHeroIds).length}/5 союзников · ${ids(draft.enemyHeroIds).length}/5 врагов`;
      refs.detection.textContent='Нажми портрет, чтобы исправить состав.';refs.detection.title=[detection.message||draft.detectionMessage,known,source,confidence].filter(Boolean).join(' · ');
      const stats=draft.stats||{},progress=refreshContext(stats,rankId(snapshot)),actionable=stats.status==='error'||Boolean(stats.errorCode)||stats.status==='partial'||Boolean(progress.progress);
      refs.status.textContent=plainText(message||(actionable?sourceStatus(stats,rankId(snapshot)):''));refs.status.title=refs.status.textContent;refs.status.hidden=!refs.status.textContent;
      if(!compact&&refs.explanation)refs.explanation.textContent='По статистике известных пиков. Близкие варианты могут быть равноценны.';
      for(const el of container.querySelectorAll('button')){if(busy||compact&&pickerOpen&&el.classList.contains('draft-slot'))el.disabled=true;else if(el!==refs.prevButton&&el!==refs.nextButton&&!(el.classList.contains('draft-slot')&&el.classList.contains('own'))&&!(el.classList.contains('draft-catalog-choice')&&draft.locked&&Number(el.dataset.heroId)===draft.ownHeroId))el.disabled=false;}
      if(refs.refreshButton){const refresh=refreshContext(stats,rankId(snapshot));refs.refreshButton.disabled=busy||refresh.disabled;refs.refreshButton.textContent=refresh.buttonText;refs.refreshButton.title=refresh.progress||`Загрузить статистику: ${rankLabel(refresh.requested)}. Обновление не меняет выбранный рейтинг.`;}
      options.onLayout?.();
    }
    function hitAreas(){
      if(!compact)return[];
      const elements=pickerOpen?[refs.positionButtons,refs.picker]:[refs.positionButtons,refs.ally,refs.enemy,refs.tools,...(!refs.finishButton.hidden?[refs.finishButton]:[])];
      return elements.filter(el=>el&&!el.hidden).map(el=>el.getBoundingClientRect()).filter(rect=>rect.width>0&&rect.height>0).map(({x,y,width,height})=>({x,y,width,height}));
    }
    return{render,openPicker,closePicker,togglePicker,hitAreas,isPickerOpen:()=>pickerOpen};
  }
  const api={ids,positions,positionId,positionLabel,ranks,rankId,rankLabel,refreshContext,sourceStatus,plainText,presentation,recommendationsFor,rosterPatch,catalog,pages,scopeText,numberText,breakdownText,baselineText,matchupEvidence,matchupSummary,matchupTitle,coverageText,coverageTitle,freshnessText,freshnessTitle,comparisonText,comparisonTitle,statsDates,create};
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.DraftUI=api;
})(typeof window==='object'?window:globalThis);
