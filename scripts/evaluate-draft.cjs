'use strict';
// Offline diagnostics. None of these multipliers change the running picker.
const fs=require('node:fs'),path=require('node:path');
const {sensitivity,historicalEvaluation,readSnapshotArchive}=require('../src/draft-evaluation.cjs');
const ROOT=path.resolve(__dirname,'..'),VERSION=require('../package.json').version;
const heroes=Object.values(require('../data/wraith-king.json').heroes);

function constructedDrafts() {
  // Slots are plausible position assignments solely to construct varied test
  // inputs. No role assignment or balance bonus enters the runtime algorithm.
  const teams=[
    [42,13,2,26,5], [8,52,29,86,111], [18,11,16,20,31], [44,22,23,27,30],
    [48,17,96,64,83], [12,25,99,84,66], [10,46,102,75,3], [1,106,129,50,68],
    [70,74,28,9,7], [95,35,69,85,121], [6,47,137,128,119], [67,76,55,88,90],
  ];
  const names=new Map(heroes.map(hero=>[hero.id,hero.localizedName || hero.localized_name]));
  if (teams.flat().some(id=>!names.has(id))) throw new Error('Constructed draft uses an unknown hero');
  const reference=[
    {id:'user-leshrac',label:'Состав из примера пользователя',positionId:1,allyHeroIds:[66,95,83],enemyHeroIds:[102,70,46,75,99]},
    {id:'physical-pressure',label:'Физический урон и контроль',positionId:1,allyHeroIds:[26,5,129],enemyHeroIds:[2,44,18,31,27]},
    {id:'magic-control-mid',label:'Магический урон, позиция 2',positionId:2,allyHeroIds:[8,29,20],enemyHeroIds:[12,52,30,86,111]},
    {id:'partial-support',label:'Неполный драфт, позиция 5',positionId:5,allyHeroIds:[42,13],enemyHeroIds:[10,16,68]},
  ].map(row=>({...row,suite:'reference',draftKind:'constructed_or_user_example_not_historical_match'}));
  const complete=teams.flatMap((team,index)=>[1,2,3,4,5].map(positionId=>({
    id:`complete-${index+1}-position-${positionId}`,label:`Состав ${index+1}, позиция ${positionId}`,
    suite:'complete',draftKind:'constructed_not_historical_match',positionId,
    allyHeroIds:team.filter((id,slot)=>slot!==positionId-1),enemyHeroIds:[...teams[(index+5)%teams.length]],
  })));
  const partial=[1,2,3,4,5].flatMap(positionId=>[0,1].map(index=>{
    const full=complete[(positionId-1)*5+index];
    return {...full,id:`partial-${index+1}-position-${positionId}`,label:`Неполный состав ${index+1}, позиция ${positionId}`,
      suite:'partial',positionId,allyHeroIds:full.allyHeroIds.slice(0,index+1),enemyHeroIds:full.enemyHeroIds.slice(0,index+2)};
  }));
  return [...reference,...complete,...partial];
}

function aggregate(reports) {
  const mean=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
  const summarize=list=>({drafts:list.length,evaluableDrafts:list.filter(row=>row.diagnostics.candidateCount>0).length,
    positionalWRComparableDrafts:list.filter(row=>row.diagnostics.baselineCandidateCount>0).length,positions:[...new Set(list.map(row=>row.positionId))].sort(),
    currentTopEqualsWRCount:list.filter(row=>row.diagnostics.currentTopEqualsWR).length,
    meanCurrentTop5OverlapWithWR:mean(list.map(row=>row.diagnostics.currentTop5OverlapWithWR)),
    matchedPool:{comparableDrafts:list.filter(row=>row.diagnostics.matchedPool.candidateCount>0).length,
      currentTopEqualsWRCount:list.filter(row=>row.diagnostics.matchedPool.positionalWRComparison.topEqualsCurrent===true).length,
      meanTop5OverlapWithWR:mean(list.filter(row=>row.diagnostics.matchedPool.candidateCount>0).map(row=>row.diagnostics.matchedPool.positionalWRComparison.top5OverlapWithCurrent)),
      meanAbsoluteRankChangeFromWR:mean(list.map(row=>row.diagnostics.matchedPool.positionalWRComparison.meanAbsoluteRankChange).filter(Number.isFinite)),
      controls:['withoutEnemies','withoutAllies','withoutDraftContext'].map(name=>{
        const rows=list.filter(row=>row.diagnostics.matchedPool.candidateCount>0).map(row=>row.diagnostics.matchedPool.controls.find(value=>value.name===name));
        return {name,comparableDrafts:rows.length,topChangedCount:rows.filter(row=>row.topEqualsCurrent===false).length,
          meanTop5OverlapWithCurrent:mean(rows.map(row=>row.top5OverlapWithCurrent)),meanAbsoluteRankChange:mean(rows.map(row=>row.meanAbsoluteRankChange).filter(Number.isFinite))};
      }),dominantAbsoluteComponentCounts:Object.fromEntries(['baseline','enemies','allies','neutral','tied'].map(name=>[name,list.reduce((sum,row)=>sum+row.diagnostics.matchedPool.dominantAbsoluteComponentCounts[name],0)]))},
    variants:[.5,1,2,3].map(multiplier=>{
      const variants=list.map(row=>row.variants.find(value=>value.multiplier===multiplier && value.allyMultiplier===1)).filter(Boolean);
      return {enemyMultiplier:multiplier,topChangedCount:variants.filter(row=>row.topChanged).length,
        meanTop5OverlapWithCurrent:mean(variants.map(row=>row.overlapWithCurrent)),
        fullTop5UnchangedCount:variants.filter(row=>row.overlapWithCurrent===5).length};
    }),componentSpread:Object.fromEntries(['baseline','enemies','allies'].map(key=>[key,{
      meanAbsolute:mean(list.map(row=>row.diagnostics.componentSpread[key]?.meanAbsolute).filter(Number.isFinite)),
      meanStandardDeviation:mean(list.map(row=>row.diagnostics.componentSpread[key]?.standardDeviation).filter(Number.isFinite))}]))});
  return {all:summarize(reports),byPosition:[1,2,3,4,5].map(positionId=>({positionId,...summarize(reports.filter(row=>row.positionId===positionId))}))};
}

function compactReport(report) {
  const current=report.variants.find(row=>row.multiplier===1 && row.allyMultiplier===1);
  const point=row=>({heroId:row.heroId,name:row.name,rawScore:row.rawScore,score:row.score,base:row.base,enemies:row.enemies,allies:row.allies,
    baselineGames:row.dataCoverage?.baseline?.games,enemyPairsUsed:row.dataCoverage?.enemies?.used,enemyPairsKnown:row.dataCoverage?.enemies?.known,
    allyPairsUsed:row.dataCoverage?.allies?.used,allyPairsKnown:row.dataCoverage?.allies?.known,minimumPairGames:row.minimumPairGames});
  return {...report,pairScopeWeights:[...new Set(current.candidates.flatMap(row=>row.pairScopeWeights))],
    variants:report.variants.map(({candidates,...variant})=>({...variant,top5:variant.top5.map(point),
    leshrac:candidates.some(row=>row.heroId===52)?{...point(candidates.find(row=>row.heroId===52)),rank:candidates.findIndex(row=>row.heroId===52)+1}:null})),
    currentCandidateDecomposition:current.candidates.map((row,index)=>({rank:index+1,heroId:row.heroId,name:row.name,
      rawScore:row.rawScore,base:row.base,enemies:row.enemies,allies:row.allies,
      baselineGames:row.dataCoverage?.baseline?.games,enemyPairsUsed:row.dataCoverage?.enemies?.used,enemyPairsKnown:row.dataCoverage?.enemies?.known,
      allyPairsUsed:row.dataCoverage?.allies?.used,allyPairsKnown:row.dataCoverage?.allies?.known,minimumPairGames:row.minimumPairGames}))};
}

function parseArguments(args) {
  args=args.flatMap(value=>/^--[^=]+=/.test(value)?[value.slice(0,value.indexOf('=')),value.slice(value.indexOf('=')+1)]:[value]);
  const result={statsDirectory:path.join(ROOT,'data'),snapshotsDirectory:path.join(ROOT,'runtime','draft-snapshots'),
    rankId:'all',outputPrefix:path.join(ROOT,'artifacts',`picker-validation-${VERSION}`),now:Date.now(),allyGrid:false};
  for(let index=0;index<args.length;index++) {
    const argument=args[index];
    if(argument==='--ally-grid') {result.allyGrid=true;continue;}
    if(!['--stats-dir','--snapshots','--rank','--output-prefix','--as-of','--historical'].includes(argument) || !args[index+1]) throw new Error('Invalid diagnostic arguments');
    const value=args[++index];
    if(argument==='--stats-dir') result.statsDirectory=path.resolve(value);
    if(argument==='--snapshots') result.snapshotsDirectory=path.resolve(value);
    if(argument==='--rank') {
      const {normalizeRankId}=require('../src/stratz-draft.cjs');result.rankId=normalizeRankId(value);
    }
    if(argument==='--output-prefix') result.outputPrefix=path.resolve(value);
    if(argument==='--historical') result.historicalFile=path.resolve(value);
    if(argument==='--as-of') {result.now=Date.parse(value);if(!Number.isFinite(result.now))throw new Error('Invalid as-of date');}
  }
  return result;
}

function loadArchives(directory) {
  const snapshots=[],errors=[];
  if (!fs.existsSync(directory)) return {snapshots,errors};
  for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
    if(!entry.isFile() || !/^[a-f0-9]{64}\.json\.gz$/.test(entry.name))continue;
    try{snapshots.push(readSnapshotArchive(path.join(directory,entry.name)));}catch{errors.push({file:entry.name,error:'invalid_archive'});}
  }
  return {snapshots,errors};
}

function markdown(report) {
  const number=value=>Number.isFinite(value)?value.toFixed(3):'—';
  const lines=[`# Офлайн-проверка пикера ${VERSION}`,'',
    `Проверено ${report.reports.length} заданных составов на всех пяти позициях. Рейтинг: ${report.rankId}.`,
    'Это проверка влияния компонентов и устойчивости списка. У составов нет результатов матчей; она не измеряет качество рекомендаций и не выбирает лучшие веса. Рабочие коэффициенты сохранены.','',
    '| Вес врагов | Изменился первый герой | Среднее совпадение топ-5 с текущим | Полностью тот же набор топ-5 |','|---|---:|---:|---:|'];
  for(const row of report.summary.all.variants)lines.push(`| ${row.enemyMultiplier}× | ${row.topChangedCount}/${report.reports.length} | ${number(row.meanTop5OverlapWithCurrent)}/5 | ${row.fullTop5UnchangedCount}/${report.reports.length} |`);
  lines.push('',`Текущий первый герой совпадает с первым героем по сглаженному WR в ${report.summary.all.currentTopEqualsWRCount} из ${report.reports.length} составов. Среднее совпадение топ-5: ${number(report.summary.all.meanCurrentTop5OverlapWithWR)}/5.`,'',
    'Разброс компонентов между кандидатами показывает, какой компонент сильнее меняет их порядок. Это описание текущих настроек, а не доказательство правильного веса.','',
    '| Компонент | Средний абсолютный вклад | Средний разброс между кандидатами |','|---|---:|---:|');
  for(const [key,label] of [['baseline','База'],['enemies','Враги'],['allies','Союзники']]) {
    const value=report.summary.all.componentSpread[key];lines.push(`| ${label} | ${number(value.meanAbsolute)} | ${number(value.meanStandardDeviation)} |`);
  }
  const matched=report.summary.all.matchedPool;
  lines.push('','Сравнение на одинаковом наборе кандидатов с подтверждённым WR позиции. Герои, уже выбранные в драфте, остаются исключёнными во всех вариантах.','',
    `Сопоставимых составов: ${matched.comparableDrafts}. Первый герой совпадает с WR в ${matched.currentTopEqualsWRCount}; среднее совпадение топ-5 ${number(matched.meanTop5OverlapWithWR)}/5. Среднее перемещение кандидата относительно WR: ${number(matched.meanAbsoluteRankChangeFromWR)} мест.`,
    '','| Удалённый вклад | Изменился первый герой | Среднее совпадение топ-5 | Среднее изменение места |','|---|---:|---:|---:|');
  for(const row of matched.controls)lines.push(`| ${({withoutEnemies:'Враги',withoutAllies:'Союзники',withoutDraftContext:'Враги и союзники'})[row.name]} | ${row.topChangedCount}/${row.comparableDrafts} | ${number(row.meanTop5OverlapWithCurrent)}/5 | ${number(row.meanAbsoluteRankChange)} |`);
  lines.push('',`Наибольший абсолютный вклад у кандидатов: база ${matched.dominantAbsoluteComponentCounts.baseline}; враги ${matched.dominantAbsoluteComponentCounts.enemies}; союзники ${matched.dominantAbsoluteComponentCounts.allies}; равные максимальные вклады ${matched.dominantAbsoluteComponentCounts.tied}; все вклады нулевые ${matched.dominantAbsoluteComponentCounts.neutral}. Это характеристика настроек, а не измерение точности.`);
  lines.push('','Все составы, текущий топ-5, остальные веса и разложение каждого кандидата сохранены в JSON рядом с этим документом. Общие пары могут иметь понижение за отсутствие позиции; свежесть и контекст каждого источника сохранены отдельно.','',
    '## Подготовка исторической проверки','',`Найдено снимков: ${report.archives.snapshotCount}. С подтверждёнными границами возможного периода пар: ${report.archives.pairPossiblePeriodVerifiedCount}. С известной датой последнего наблюдения пар: ${report.archives.pairLastObservationKnownCount}. Пригодных записей с результатом матча: ${report.historical.eligibleOutcomeCount}.`,
    'Пикер не выдаёт вероятность победы. Log loss и Brier пока не рассчитаны: для них нужны пригодные исторические записи и калибровка на более ранних матчах. Неподобранные герои не имеют наблюдаемого исхода.','');
  if(Object.keys(report.historical.blockerCounts).length)lines.push('| Причина пропуска | Записей |','|---|---:|',...Object.entries(report.historical.blockerCounts).map(([reason,count])=>`| ${reason} | ${count} |`),'');
  if(!report.historical.recordCount)lines.push('Исторические решения с видимым на момент выбора драфтом и итогом матча ещё не предоставлены. Снимки сами по себе не являются набором матчей.','');
  for(const item of report.reports.filter(row=>row.suite==='reference')) {
    lines.push(`## ${item.label}`,'','| Вес врагов | Топ-5 | Совпадений с текущим |','|---|---|---:|');
    for(const variant of item.variants.filter(row=>row.allyMultiplier===1))lines.push(`| ${variant.multiplier}× | ${variant.top5.map(row=>`${row.name} (${row.score})`).join(', ')} | ${variant.overlapWithCurrent}/5 |`);
    lines.push('','| Герой, текущий вес | База | Враги | Союзники | Балл |','|---|---:|---:|---:|---:|');
    const current=item.variants.find(row=>row.multiplier===1 && row.allyMultiplier===1);
    for(const row of current.top5)lines.push(`| ${row.name} | ${number(row.base)} | ${number(row.enemies)} | ${number(row.allies)} | ${number(row.rawScore)} |`);
    if(current.leshrac) {
      const row=current.leshrac;lines.push('',`Leshrac: место ${row.rank}; база ${number(row.base)}, враги ${number(row.enemies)}, союзники ${number(row.allies)}.`);
    }
    lines.push('',`Сглаженный WR: ${item.baselineOnlyTop5.map(row=>row.name).join(', ')}.`,
      `Диагностика без понижения общих вражеских пар: ${item.withoutBroadPairReductionTop5.map(row=>row.name).join(', ')}. Это отдельный эксперимент; союзные коэффициенты сохранены.`, '');
  }
  return lines.join('\n');
}

function run(options) {
  const statsByPosition=new Map();
  for(const positionId of [1,2,3,4,5]) {
    const suffix=options.rankId==='all'?'':`-rank-${options.rankId.toLowerCase()}`;
    const stats=JSON.parse(fs.readFileSync(path.join(options.statsDirectory,`draft-statistics-stratz-position-${positionId}${suffix}.json`),'utf8'));
    if((stats.scope?.rank || 'all')!==options.rankId)throw new Error('Diagnostic rank scope mismatch');
    statsByPosition.set(positionId,stats);
  }
  const reports=constructedDrafts().map(draft=>({...draft,...sensitivity({...draft,heroes,stats:statsByPosition.get(draft.positionId),now:options.now,requirePositionData:true},undefined,options.allyGrid?[.5,1,2]:[1])}));
  const archives=loadArchives(options.snapshotsDirectory);
  let records=[];
  if(options.historicalFile) {
    if(fs.statSync(options.historicalFile).size>20*1024*1024)throw new Error('Historical import exceeds bound');
    const value=JSON.parse(fs.readFileSync(options.historicalFile,'utf8'));
    records=Array.isArray(value)?value:value.records;
    if(!Array.isArray(records))throw new Error('Historical import must contain decision records');
  }
  const report={generatedAt:new Date().toISOString(),asOf:new Date(options.now).toISOString(),type:'sensitivity_and_historical_preparation_not_accuracy',
    appVersion:VERSION,rankId:options.rankId,summary:aggregate(reports),reports:reports.map(compactReport),
    archives:{snapshotCount:archives.snapshots.length,errors:archives.errors,
      pairLastObservationKnownCount:archives.snapshots.filter(row=>row.data.components?.pairs?.observedThrough!=null).length,
      pairPossiblePeriodVerifiedCount:archives.snapshots.filter(row=>row.data.components?.pairs?.periodBoundsVerified===true && row.data.components?.pairs?.periodMethod==='stratz_unix_week_roundtrip').length},
    historical:historicalEvaluation(records,archives.snapshots,{heroes})};
  fs.mkdirSync(path.dirname(options.outputPrefix),{recursive:true});
  fs.writeFileSync(`${options.outputPrefix}.json`,JSON.stringify(report,null,2));
  fs.writeFileSync(`${options.outputPrefix}.md`,markdown(report));
  return {ok:true,output:`${options.outputPrefix}.json`,drafts:reports.length,variants:reports.reduce((sum,row)=>sum+row.variants.length,0),
    historicalRecords:records.length,eligibleHistoricalOutcomes:report.historical.eligibleOutcomeCount,summary:report.summary.all};
}
if(require.main===module) {
  try{console.log(JSON.stringify(run(parseArguments(process.argv.slice(2)))));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
module.exports={constructedDrafts,aggregate,compactReport,parseArguments,loadArchives,markdown,run};
