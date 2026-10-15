'use strict';
// Offline diagnostics, never a runtime coefficient change or win prediction.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { evaluateDraft, HERO_PRIOR_GAMES, observationTimestamp } = require('./draft-coach.cjs');
const APP_VERSION = require('../package.json').version;
const MULTIPLIERS = Object.freeze([.5, 1, 2, 3]);
const MAX_ARCHIVE_BYTES = 300 * 1024 * 1024;
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
function sensitivity(input, multipliers = MULTIPLIERS, allyMultipliers = [1]) {
  if (!Array.isArray(multipliers) || !multipliers.length || multipliers.some(k => !Number.isFinite(k) || k < 0 || k > 10)) throw new Error('Invalid sensitivity multipliers');
  if (!Array.isArray(allyMultipliers) || !allyMultipliers.length || allyMultipliers.some(k => !Number.isFinite(k) || k < 0 || k > 10)) throw new Error('Invalid ally sensitivity multipliers');
  const result = evaluateDraft(input);
  const usable = result.candidates.filter(row => row.dataUsed && row.scoreBreakdown);
  const variants = multipliers.flatMap(multiplier => allyMultipliers.map(allyMultiplier => {
    const candidates = usable.map(row => {
      const b = row.scoreBreakdown;
      // Match the runtime exactly at k=1, including floating-point addition
      // order. Reconstructing all terms can change a full-precision tie.
      const rawScore = row.rawScore + b.enemies * (multiplier - 1) + b.allies * (allyMultiplier - 1);
      return { heroId:row.heroId, name:row.name, rawScore, score:Math.round(Math.min(100, Math.max(0,rawScore))*10)/10,
        base:b.baseline, enemies:b.enemies * multiplier, allies:b.allies * allyMultiplier, dataCoverage:row.dataCoverage,
        dataFreshness:row.dataFreshness, minimumPairGames:row.pairCount?row.sampleCount:null,
        pairScopeWeights:[...new Set(row.matchupEvidence.map(pair=>pair.scopeWeight))] };
    }).sort((a,b)=>b.rawScore-a.rawScore || a.heroId-b.heroId);
    return {multiplier,allyMultiplier,top5:candidates.slice(0,5),candidates};
  }));
  const reference = variants.find(row=>row.multiplier===1 && row.allyMultiplier===1) || variants[0];
  for (const row of variants) {
    row.overlapWithCurrent = row.top5.filter(hero=>reference.top5.some(other=>other.heroId===hero.heroId)).length;
    row.topChanged = row.top5[0]?.heroId !== reference.top5[0]?.heroId;
  }
  const noBroadReduction = usable.map(row=>{
    const enemies = row.matchupEvidence.filter(pair=>pair.side==='enemy').reduce((sum,pair)=>sum+pair.contribution/(pair.scopeWeight || 1),0);
    return {heroId:row.heroId,name:row.name,base:row.scoreBreakdown.baseline,enemies,allies:row.scoreBreakdown.allies,
      rawScore:50+row.scoreBreakdown.baseline+enemies+row.scoreBreakdown.allies};
  }).sort((a,b)=>b.rawScore-a.rawScore || a.heroId-b.heroId);
  const baselineOnly = usable.filter(row=>row.baselineGames>0 && row.roleFiltered).map(row=>({heroId:row.heroId,name:row.name,
    smoothedWR:(row.baselineWinRate*row.baselineGames+.5*HERO_PRIOR_GAMES)/(row.baselineGames+HERO_PRIOR_GAMES),games:row.baselineGames}))
    .sort((a,b)=>b.smoothedWR-a.smoothedWR || a.heroId-b.heroId);
  const spread = values => {
    if (!values.length) return null;
    const mean=values.reduce((sum,value)=>sum+value,0)/values.length;
    return {meanAbsolute:values.reduce((sum,value)=>sum+Math.abs(value),0)/values.length,
      range:Math.max(...values)-Math.min(...values),standardDeviation:Math.sqrt(values.reduce((sum,value)=>sum+(value-mean)**2,0)/values.length)};
  };
  const baselineIds = new Set(baselineOnly.slice(0,5).map(row=>row.heroId));
  // Removing context must not accidentally make picked opponents available.
  // All controls use the exact same candidates with a verified position WR.
  const matchedIds = new Set(baselineOnly.map(row=>row.heroId));
  const matched = usable.filter(row=>matchedIds.has(row.heroId));
  const rankControl = (name, scoreFor) => ({ name, candidates:matched.map(row=>({heroId:row.heroId,name:row.name,rawScore:scoreFor(row)}))
    .sort((a,b)=>b.rawScore-a.rawScore || a.heroId-b.heroId) });
  const controls = [
    rankControl('current',row=>row.rawScore),
    rankControl('withoutEnemies',row=>row.scoreBreakdown.initial+row.scoreBreakdown.baseline+row.scoreBreakdown.allies),
    rankControl('withoutAllies',row=>row.scoreBreakdown.initial+row.scoreBreakdown.baseline+row.scoreBreakdown.enemies),
    rankControl('withoutDraftContext',row=>row.scoreBreakdown.initial+row.scoreBreakdown.baseline),
  ];
  const currentMatched = controls[0].candidates, wrMatched = baselineOnly;
  const rankChange = (reference,other) => {
    if(!reference.length || reference.length!==other.length)return null;
    const ranks=new Map(other.map((row,index)=>[row.heroId,index]));
    return reference.reduce((sum,row,index)=>sum+Math.abs(index-ranks.get(row.heroId)),0)/reference.length;
  };
  const compareRanking = other => ({topEqualsCurrent:currentMatched.length>0?currentMatched[0].heroId===other[0]?.heroId:null,
    top5OverlapWithCurrent:currentMatched.slice(0,5).filter(row=>other.slice(0,5).some(value=>value.heroId===row.heroId)).length,
    meanAbsoluteRankChange:rankChange(currentMatched,other)});
  const dominantComponents = {baseline:0,enemies:0,allies:0,neutral:0,tied:0};
  for(const row of matched) {
    const terms=['baseline','enemies','allies'].map(name=>({name,value:Math.abs(row.scoreBreakdown[name])})).sort((a,b)=>b.value-a.value);
    dominantComponents[terms[0].value===0?'neutral':terms[0].value===terms[1].value?'tied':terms[0].name]++;
  }
  const matchedPoolDiagnostics = {status:matched.length?'descriptive_not_accuracy':'no_verified_position_baseline',candidateCount:matched.length,
    comparison:'identical_candidate_pool_roster_and_source_snapshot',
    currentTop5:currentMatched.slice(0,5),positionalWRTop5:wrMatched.slice(0,5),
    positionalWRComparison:compareRanking(wrMatched),
    controls:controls.map(({name,candidates})=>({name,top5:candidates.slice(0,5),...compareRanking(candidates)})),
    dominantAbsoluteComponentCounts:dominantComponents};
  return {kind:'sensitivity_not_accuracy',appVersion:APP_VERSION,modelVersion:result.model?.version,positionId:input.positionId || 1,
    allyHeroIds:input.allyHeroIds || [],enemyHeroIds:input.enemyHeroIds || [],
    model: result.model,
    assumptions:['Same draft and snapshot; enemy and optional ally contribution multipliers are offline diagnostics only.','Top-5 changes measure sensitivity, not recommendation accuracy.',
      'The broad-pair diagnostic removes the scope reduction only from enemy pairs; ally weights stay unchanged.',
      'The WR-only baseline uses verified selected-position counts, without matchup or synergy bonuses.',
      'Matched-pool controls remove only score contributions; the roster, available candidates and source snapshot stay fixed.'],
    variants,baselineOnlyTop5:baselineOnly.slice(0,5),withoutBroadPairReductionTop5:noBroadReduction.slice(0,5),
    diagnostics:{candidateCount:usable.length,baselineCandidateCount:baselineOnly.length,
      currentTop5OverlapWithWR:reference.top5.filter(row=>baselineIds.has(row.heroId)).length,
      currentTopEqualsWR:Boolean(reference.top5.length && baselineOnly.length && reference.top5[0].heroId===baselineOnly[0].heroId),
      componentSpread:{baseline:spread(usable.map(row=>row.scoreBreakdown.baseline)),enemies:spread(usable.map(row=>row.scoreBreakdown.enemies)),allies:spread(usable.map(row=>row.scoreBreakdown.allies))},
      matchedPool:matchedPoolDiagnostics},
    source:pick(input.stats,['providerId','updatedAt','scope','components','observedThrough'])};
}
function temporalEligibility(snapshot, decision) {
  const reasons = [];
  const cutoff = observationTimestamp(decision?.decisionAt);
  const available = observationTimestamp(snapshot?.availableAt);
  if (cutoff === null || available === null || available>=cutoff) reasons.push('snapshot_not_available_before_decision');
  const components = decision?.components || ['baseline','pairs'];
  if (!Array.isArray(components) || !components.length || components.some(name=>!['baseline','pairs'].includes(name))) {
    return {eligible:false,reasons:[...reasons,'evaluation_components_invalid']};
  }
  for (const name of components) {
    const value = snapshot?.data?.components?.[name];
    const kind = value?.observedThroughKind;
    const actualEnd = value?.observedUntilExclusive ?? value?.observedThrough;
    let through = observationTimestamp(actualEnd);
    // A verified aggregate period bounds every possible observation even when
    // the API omits the last actual match time. This is solely a no-future-data
    // bound, never a claim that the sample is fresh or complete.
    if(actualEnd==null && value?.periodBoundsVerified===true) {
      const start=observationTimestamp(value.periodStart),end=observationTimestamp(value.periodEndExclusive);
      const verified=value.periodMethod==='stratz_unix_week_roundtrip' && start!==null && end!==null && start<end
        && available!==null && start<=available && typeof value.periodPartial==='boolean' && value.periodPartial===(available<end);
      if(verified)through=Math.min(end,available);
      else reasons.push(`${name}_possible_period_invalid`);
    }
    const startOnly = ['completed_day','day_start','day_start_inclusive','latest_match_start'].includes(kind) && value?.observedUntilExclusive == null;
    if (through === null || cutoff === null || through>=cutoff || startOnly) reasons.push(`${name}_observation_cutoff_unverified`);
    if (through !== null && available !== null && through>available) reasons.push(`${name}_observations_after_snapshot_availability`);
    if (value?.observedFrom != null) {
      const from = observationTimestamp(value.observedFrom);
      if (from === null || through === null || from>through) reasons.push(`${name}_observation_period_invalid`);
    }
    if (decision?.patch && value?.scope?.patch !== decision.patch) reasons.push(`${name}_patch_mismatch_or_unknown`);
    if (decision?.rankId && (value?.scope?.rank || 'all') !== decision.rankId) reasons.push(`${name}_rank_mismatch`);
    if (name==='baseline' && decision?.positionId && value?.scope?.role!==`POSITION_${decision.positionId}`) reasons.push('baseline_position_mismatch');
  }
  return {eligible:reasons.length===0,reasons};
}

// Public decision records are captured at pick time, never reconstructed from
// a final ten-hero roster. Outcomes may be appended only after the match ends.
function validateDecisionRecord(value, options = {}) {
  const reasons = [], known = new Set(options.heroIds || Object.keys(require('../data/wraith-king.json').heroes).map(Number));
  const validHero = id => Number.isInteger(id) && known.has(id);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {valid:false,reasons:['decision_record_invalid']};
  if (value.schemaVersion !== 1) reasons.push('decision_schema_invalid');
  if (typeof value.decisionId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,120}$/.test(value.decisionId)) reasons.push('decision_id_invalid');
  if (!/^[a-f0-9]{64}$/.test(value.snapshotId || '')) reasons.push('snapshot_id_invalid');
  const at=observationTimestamp(value.decisionAt), observed=observationTimestamp(value.observedAt);
  if (at===null) reasons.push('decision_time_invalid');
  if (value.draftVisibility!=='observed_at_decision' || observed===null || at===null || observed>at) reasons.push('draft_visibility_unverified');
  if (typeof value.patch!=='string' || !value.patch.trim() || value.patch.length>32 || /^(unknown|null|undefined|\?)$/i.test(value.patch)) reasons.push('decision_patch_unknown');
  const ranks=['all',...Object.keys(require('./stratz-draft.cjs').RANK_COHORTS)];
  if (!ranks.includes(value.rankId)) reasons.push('decision_rank_unknown');
  if (![1,2,3,4,5].includes(value.positionId)) reasons.push('decision_position_invalid');
  const lists = [['allyHeroIds',4],['enemyHeroIds',5],['bannedHeroIds',known.size]];
  for (const [key,max] of lists) {
    const ids=value[key] ?? (key==='bannedHeroIds'?[]:null);
    if (!Array.isArray(ids) || ids.length>max || ids.some(id=>!validHero(id)) || new Set(ids).size!==ids.length) reasons.push(`${key}_invalid`);
  }
  const allies=Array.isArray(value.allyHeroIds)?value.allyHeroIds:[],enemies=Array.isArray(value.enemyHeroIds)?value.enemyHeroIds:[],bans=Array.isArray(value.bannedHeroIds)?value.bannedHeroIds:[];
  if (allies.some(id=>enemies.includes(id) || bans.includes(id)) || enemies.some(id=>bans.includes(id))) reasons.push('draft_hero_overlap');
  if (value.chosenHeroId!=null && (!validHero(value.chosenHeroId) || [...allies,...enemies,...bans].includes(value.chosenHeroId))) reasons.push('chosen_hero_invalid');
  if (value.visiblePicks!=null) {
    if (!Array.isArray(value.visiblePicks) || value.visiblePicks.length!==allies.length+enemies.length) reasons.push('pick_events_invalid');
    else {
      const seen=new Set();
      for (const event of value.visiblePicks) {
        const ids=event?.side==='ally'?allies:event?.side==='enemy'?enemies:[];
        const pickedAt=observationTimestamp(event?.pickedAt);
        if (!ids.includes(event?.heroId) || seen.has(event?.heroId) || pickedAt===null || observed===null || pickedAt>observed) reasons.push('pick_events_include_unknown_or_future_pick');
        seen.add(event?.heroId);
      }
    }
  }
  if (value.outcome!=null) {
    const ended=observationTimestamp(value.outcome.completedAt);
    if (typeof value.outcome!=='object' || typeof value.outcome.won!=='boolean' || ended===null || at===null || ended<=at) reasons.push('outcome_invalid');
    if (!validHero(value.chosenHeroId)) reasons.push('outcome_chosen_hero_missing');
    if (!(typeof value.matchId==='string' && /^\d{1,20}$/.test(value.matchId) || Number.isSafeInteger(value.matchId) && value.matchId>0)) reasons.push('outcome_match_id_missing');
  }
  return {valid:reasons.length===0,reasons:[...new Set(reasons)]};
}

function readSnapshotArchive(file) {
  if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size>3*1024*1024) throw new Error('Invalid archive file');
  const match=/^([a-f0-9]{64})\.json\.gz$/.exec(path.basename(file));
  if (!match) throw new Error('Invalid archive identity');
  const raw=zlib.gunzipSync(fs.readFileSync(file),{maxOutputLength:3*1024*1024});
  if (crypto.createHash('sha256').update(raw).digest('hex')!==match[1]) throw new Error('Archive identity mismatch');
  const value=JSON.parse(raw);
  if (value.schemaVersion!==1 || observationTimestamp(value.availableAt)===null || !require('./draft-sources.cjs').validData(value.data)) throw new Error('Invalid snapshot');
  return {...value,id:match[1]};
}

function chronologicalFolds(rows) {
  const grouped=new Map();
  for (const row of rows) {
    const id=String(row.matchId), group=grouped.get(id) || {id,rows:[],firstDecision:Infinity,lastOutcome:0};
    group.rows.push(row);group.firstDecision=Math.min(group.firstDecision,observationTimestamp(row.decisionAt));
    group.lastOutcome=Math.max(group.lastOutcome,observationTimestamp(row.outcome.completedAt));grouped.set(id,group);
  }
  const groups=[...grouped.values()].sort((a,b)=>a.firstDecision-b.firstDecision || a.id.localeCompare(b.id));
  if (groups.length<3) return {status:'insufficient_groups',train:[],validation:[],test:[],withheld:rows.map(row=>row.decisionId),groupCount:groups.length};
  const trainEnd=Math.max(1,Math.min(groups.length-2,Math.floor(groups.length*.6))),validationEnd=Math.max(trainEnd+1,Math.min(groups.length-1,Math.floor(groups.length*.8)));
  const validationStartsAt=groups[trainEnd].firstDecision,testStartsAt=groups[validationEnd].firstDecision;
  const result={status:'prepared_not_accuracy_measured',train:[],validation:[],test:[],withheld:[],groupCount:groups.length,
    validationStartsAt:new Date(validationStartsAt).toISOString(),testStartsAt:new Date(testStartsAt).toISOString()};
  for(let index=0;index<groups.length;index++) {
    const group=groups[index],fold=index<trainEnd?'train':index<validationEnd?'validation':'test';
    const cutoff=fold==='train'?validationStartsAt:fold==='validation'?testStartsAt:Infinity;
    // A match that started in training but finished in validation cannot supply
    // a label available at the training cutoff. Keep all its decisions together.
    const destination=group.lastOutcome>=cutoff?'withheld':fold;
    result[destination].push(...group.rows.map(row=>row.decisionId));
  }
  return result;
}

function historicalEvaluation(records, snapshots, options = {}) {
  if (!Array.isArray(records) || records.length>100000) throw new Error('Invalid decision records');
  const byId=snapshots instanceof Map?snapshots:new Map((snapshots || []).map(row=>[row.id,row]));
  const seen=new Set(), skipped=[], rows=[], readiness={baselineEligible:0,fullModelEligible:0};
  for (const record of records) {
    const checked=validateDecisionRecord(record,options), reasons=[...checked.reasons];
    if (seen.has(record?.decisionId)) reasons.push('duplicate_decision_id');
    seen.add(record?.decisionId);
    if (!checked.valid || reasons.length) {skipped.push({decisionId:record?.decisionId || null,reasons});continue;}
    const snapshot=byId.get(record.snapshotId);
    if (!snapshot) {skipped.push({decisionId:record.decisionId,reasons:['snapshot_not_found']});continue;}
    const baselineGate=temporalEligibility(snapshot,{...record,components:['baseline']});
    const baselineComponent=snapshot.data?.components?.baseline;
    if(baselineComponent?.roleFiltered!==true || baselineComponent?.positionEstimated===true) {
      baselineGate.eligible=false;baselineGate.reasons.push('baseline_role_filter_unverified');
    }
    if (baselineGate.eligible) readiness.baselineEligible++;
    const gate=temporalEligibility(snapshot,record);
    if(!baselineGate.eligible) {gate.eligible=false;gate.reasons=[...new Set([...gate.reasons,...baselineGate.reasons])];}
    if (!gate.eligible) {skipped.push({decisionId:record.decisionId,reasons:gate.reasons});continue;}
    readiness.fullModelEligible++;
    if (!record.outcome || !record.chosenHeroId) {skipped.push({decisionId:record.decisionId,reasons:['completed_outcome_missing']});continue;}
    const input={heroes:options.heroes,allyHeroIds:record.allyHeroIds,enemyHeroIds:record.enemyHeroIds,bannedHeroIds:record.bannedHeroIds,
      positionId:record.positionId,stats:snapshot.data,now:observationTimestamp(record.decisionAt)};
    const report=sensitivity(input),current=report.variants.find(row=>row.multiplier===1 && row.allyMultiplier===1);
    const chosen=current.candidates.find(row=>row.heroId===record.chosenHeroId);
    const wr=report.baselineOnlyTop5.find(row=>row.heroId===record.chosenHeroId);
    const statsHero=snapshot.data.heroes.find(row=>row.heroId===record.chosenHeroId);
    // For a fair positional-WR comparison both models need the same observed
    // chosen hero. Do not impute missing role counts from a global hero sample.
    if (!chosen?.dataCoverage?.baseline?.used || !Number.isSafeInteger(statsHero?.games) || !Number.isSafeInteger(statsHero?.wins) || statsHero.games<=0) {
      skipped.push({decisionId:record.decisionId,reasons:['chosen_position_baseline_unavailable']});continue;
    }
    const smoothedWR=wr?.smoothedWR ?? (statsHero.wins+.5*HERO_PRIOR_GAMES)/(statsHero.games+HERO_PRIOR_GAMES);
    rows.push({decisionId:record.decisionId,matchId:String(record.matchId),snapshotId:record.snapshotId,decisionAt:record.decisionAt,
      positionId:record.positionId,rankId:record.rankId,patch:record.patch,chosenHeroId:record.chosenHeroId,
      visibleAllies:record.allyHeroIds,visibleEnemies:record.enemyHeroIds,outcome:{won:record.outcome.won,completedAt:record.outcome.completedAt},
      base:chosen.base,enemies:chosen.enemies,allies:chosen.allies,smoothedPositionWR:smoothedWR,
      variants:report.variants.map(variant=>({enemyMultiplier:variant.multiplier,allyMultiplier:variant.allyMultiplier,
        chosenRank:variant.candidates.findIndex(row=>row.heroId===record.chosenHeroId)+1,
        chosenScore:variant.candidates.find(row=>row.heroId===record.chosenHeroId)?.rawScore ?? null,
        top5HeroIds:variant.top5.map(row=>row.heroId)})),dataCoverage:chosen.dataCoverage,model:report.model});
  }
  const blockerCounts={};for(const row of skipped)for(const reason of row.reasons)blockerCounts[reason]=(blockerCounts[reason] || 0)+1;
  return {kind:'historical_preparation_not_accuracy',appVersion:APP_VERSION,recordCount:records.length,eligibleOutcomeCount:rows.length,readiness,
    blockerCounts,skipped,rows,folds:chronologicalFolds(rows),metrics:{logLoss:null,brier:null,recommendationAccuracy:null},
    limitations:['Only the selected hero has an observed outcome; unpicked recommendations have no counterfactual outcome.',
      'The ranking index is not a win probability. Outcome metrics require calibration fitted only on training matches.',
      'Choose enemy and ally weights on validation matches, then compare once against smoothed positional WR on untouched later matches.',
      'Match-level chronological grouping and label availability must be preserved; current statistics cannot evaluate past decisions.']};
}
function archiveSnapshot(directory, stats, availableAt = new Date().toISOString()) {
  // Only public statistical fields enter archives; credentials/settings absent.
  if (!directory || !Number.isFinite(Date.parse(availableAt)) || !['stratz','opendota'].includes(stats?.providerId) || !Array.isArray(stats.heroes)) throw new Error('Invalid public snapshot');
  const data = pick(stats,['schemaVersion','providerId','updatedAt','observedThrough','scope','scopeDescription','components','catalogHeroIds','heroes',
    'roleFiltered','pairRoleFiltered','positionEstimated','positionMethod','patchFiltered','rankFiltered','mixedScope','patchMatchesCurrent']);
  // Source provenance affects score eligibility and the meaning of native
  // advantages. Preserve the public query contract for reproducible replay,
  // while excluding arbitrary fields such as tokens or account settings.
  data.provenance = pick(stats.provenance,['sourceUrl','implementationUrl','positionImplementationUrl','schemaVerified',
    'roleFiltered','pairRoleFiltered','positionEstimated','positionMethod','patchFiltered','rankFiltered','mixedScope','patchMatchesCurrent',
    'matchupWindow','corpus','completeQuery','paginated','opponentSlotsPerMatch','zeroObservationRowsOmitted','baselineKind',
    'synergyAvailable','advantageMethod','nativePairCount','fallbackPairCount','unavailablePairCount','pairWeekIds','calls','batchSize','bulkQuery',
    'roleSampleDay','roleSampleStart','roleSampleDays','roleBaselineSource','observedThrough','observedThroughKind','patchMethod','latestKnownGameVersion',
    'pairPeriodConsistent','pairPeriodMethod','pairPeriodStart','pairPeriodEndExclusive','pairPeriodBoundsVerified','pairPeriodPartial','pairPeriodProof',
    'pairPeriod','periodStart','periodEndExclusive','periodBoundsVerified','periodPartial','periodMethod','proof']);
  const value = {schemaVersion:1,availableAt,appVersion:APP_VERSION,modelVersion:'statistical-index-v2',data};
  const content = Buffer.from(JSON.stringify(value));
  if (content.length>3*1024*1024) throw new Error('Snapshot exceeds bounded source size');
  const id = crypto.createHash('sha256').update(content).digest('hex');
  fs.mkdirSync(directory,{recursive:true});
  const destination = path.join(directory,`${id}.json.gz`);
  if (!fs.existsSync(destination)) {
    const stored = fs.readdirSync(directory,{withFileTypes:true}).filter(entry=>entry.isFile() && /^[a-f0-9]{64}\.json\.gz$/.test(entry.name))
      .reduce((sum,entry)=>sum+fs.statSync(path.join(directory,entry.name)).size,0);
    const compressed = zlib.gzipSync(content);
    if (stored+compressed.length>MAX_ARCHIVE_BYTES) return {status:'full',id:null};
    fs.writeFileSync(destination,compressed,{flag:'wx',mode:0o600});
  }
  return {status:'archived',id,file:destination};
}
module.exports = {MULTIPLIERS,sensitivity,temporalEligibility,validateDecisionRecord,readSnapshotArchive,chronologicalFolds,historicalEvaluation,archiveSnapshot};
