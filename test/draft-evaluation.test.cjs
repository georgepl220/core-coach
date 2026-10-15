'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),zlib=require('node:zlib');
const {sensitivity,temporalEligibility,archiveSnapshot,validateDecisionRecord,readSnapshotArchive,chronologicalFolds,historicalEvaluation}=require('../src/draft-evaluation.cjs');
const {evaluateDraft,HERO_PRIOR_GAMES}=require('../src/draft-coach.cjs');
const now=Date.parse('2026-10-14T00:00:00Z');
const components={baseline:{observedThrough:'2026-10-13T00:00:00Z',scope:{patch:'p',rank:'all',role:'POSITION_1'}},pairs:{observedThrough:'2026-10-13T00:00:00Z',scope:{patch:'p',rank:'all',role:null}}};
const stats={schemaVersion:1,providerId:'stratz',updatedAt:'2026-10-14T00:00:00Z',scope:{patch:'p',rank:null,role:'POSITION_1'},components,provenance:{schemaVerified:true,roleFiltered:true,pairRoleFiltered:false,advantageMethod:'stratz_native_synergy'},heroes:[{heroId:42,games:1000,wins:530,matchups:[{heroId:2,games:1000,wins:600,advantage:.04}],synergies:[]},{heroId:8,games:1000,wins:540,matchups:[{heroId:2,games:1000,wins:400,advantage:-.04}],synergies:[]}]};
test('sensitivity changes only enemy coefficient, preserves actual current sorting',()=>{
 const input={heroes:[{id:42,name:'WK'},{id:8,name:'Jugg'},{id:2,name:'Axe'}],enemyHeroIds:[2],stats,now};
 const report=sensitivity(input);assert.equal(report.variants.length,4);
 for(const row of report.variants){for(const candidate of row.candidates)assert.ok(Math.abs(candidate.rawScore-(50+candidate.base+candidate.enemies+candidate.allies))<1e-12);}
 const baseline=report.variants.find(v=>v.multiplier===1);const higher=report.variants.find(v=>v.multiplier===3);
 assert.equal(higher.candidates.find(c=>c.heroId===42).enemies,baseline.candidates.find(c=>c.heroId===42).enemies*3);
 assert.equal(report.kind,'sensitivity_not_accuracy');assert.equal(baseline.overlapWithCurrent,2);
});
test('k=1 matches runtime full precision exactly when arithmetic regrouping would differ',()=>{
 const verified={observedThrough:'2026-10-13T00:00:00Z',scope:{patch:'p',rank:'DIVINE_IMMORTAL',role:'POSITION_1'},schemaVerified:true,roleFiltered:true,patchFiltered:true,rankFiltered:true};
 const snapshot={...stats,scope:verified.scope,components:{baseline:verified,pairs:verified},heroes:[
  {heroId:11,games:10000,wins:5201,matchups:[{heroId:35,games:30,wins:15,advantage:-.057831}],synergies:[{heroId:5,games:39,wins:20,advantage:.045321}]},
  {heroId:42,games:10000,wins:5201,matchups:[{heroId:35,games:30,wins:15,advantage:-.05783}],synergies:[{heroId:5,games:39,wins:20,advantage:.045321}]},
 ]};
 const input={candidateHeroIds:[11,42],enemyHeroIds:[35],allyHeroIds:[5],stats:snapshot,now};
 const runtime=evaluateDraft(input),report=sensitivity(input),current=report.variants.find(row=>row.multiplier===1);
 assert.deepEqual(current.candidates.map(row=>row.heroId),runtime.candidates.map(row=>row.heroId));
 for(const row of runtime.candidates)assert.equal(current.candidates.find(other=>other.heroId===row.heroId).rawScore,row.rawScore);
 const rec=runtime.candidates.find(row=>row.heroId===11),b=rec.scoreBreakdown;
 assert.notEqual(b.initial+b.baseline+b.enemies+b.allies,rec.rawScore);
});
test('enemy scope diagnostic leaves ally contribution unchanged and WR baseline uses role counts',()=>{
 const broadStats={...stats,heroes:[...stats.heroes.map(row=>({...row,synergies:[{heroId:5,games:1000,wins:400,advantage:-.03}]}))]};
 const input={candidateHeroIds:[42,8],enemyHeroIds:[2],allyHeroIds:[5],stats:broadStats,now};
 const runtime=evaluateDraft(input),report=sensitivity(input);
 for(const row of report.withoutBroadPairReductionTop5){
  const rec=runtime.candidates.find(other=>other.heroId===row.heroId);
  assert.equal(row.allies,rec.scoreBreakdown.allies);
  assert.ok(Math.abs(row.enemies-rec.scoreBreakdown.enemies*4)<1e-12);
 }
 assert.match(report.assumptions.join(' '),/only from enemy pairs/);
 for(const row of report.baselineOnlyTop5){
  const rec=runtime.candidates.find(other=>other.heroId===row.heroId);
  assert.equal(row.smoothedWR,(rec.baselineWinRate*rec.baselineGames+.5*HERO_PRIOR_GAMES)/(rec.baselineGames+HERO_PRIOR_GAMES));
 }
 const globalStats={...stats,scope:{patch:null,rank:null,role:null},components:{baseline:{...components.baseline,scope:{patch:null,rank:null,role:null}},pairs:components.pairs},provenance:{...stats.provenance,roleFiltered:false}};
 assert.equal(sensitivity({...input,stats:globalStats}).baselineOnlyTop5.length,0);
});

test('context-removal diagnostics hold roster and role-baseline candidate pool fixed',()=>{
 const source={...stats,heroes:[...stats.heroes,{heroId:2,games:10000,wins:9900,matchups:[],synergies:[]}]};
 const input={candidateHeroIds:[42,8,2],enemyHeroIds:[2],stats:source,now,requirePositionData:true};
 const before=evaluateDraft(input),report=sensitivity(input),diagnostic=report.diagnostics.matchedPool;
 assert.equal(diagnostic.status,'descriptive_not_accuracy');assert.equal(diagnostic.candidateCount,2);
 assert.equal(diagnostic.comparison,'identical_candidate_pool_roster_and_source_snapshot');
 assert.equal(diagnostic.currentTop5[0].heroId,42);assert.equal(diagnostic.positionalWRTop5[0].heroId,8);
 const withoutEnemies=diagnostic.controls.find(row=>row.name==='withoutEnemies');
 assert.equal(withoutEnemies.top5[0].heroId,8);assert.equal(withoutEnemies.topEqualsCurrent,false);
 assert.equal(withoutEnemies.meanAbsoluteRankChange,1);
 for(const control of diagnostic.controls) {
  assert.deepEqual(control.top5.map(row=>row.heroId).sort((a,b)=>a-b),[8,42]);
  assert.ok(control.top5.every(row=>row.heroId!==2));
 }
 assert.equal(diagnostic.positionalWRComparison.top5OverlapWithCurrent,2);
 assert.deepEqual(evaluateDraft(input),before);
});

test('matched WR diagnostics exclude pairs-only candidates instead of comparing different candidate sets',()=>{
 const source={...stats,components:{baseline:{...components.baseline,roleFiltered:true},
  pairs:{...components.pairs,roleFiltered:true,scope:{...components.pairs.scope,role:'POSITION_1'}}},
  provenance:{...stats.provenance,pairRoleFiltered:true},heroes:[...stats.heroes,{heroId:11,games:0,wins:0,baselineAvailable:false,
   matchups:[{heroId:2,games:10000,wins:9000,advantage:.15}],synergies:[]}]};
 const report=sensitivity({candidateHeroIds:[42,8,11],enemyHeroIds:[2],stats:source,now,requirePositionData:true});
 assert.equal(report.diagnostics.candidateCount,3);assert.equal(report.diagnostics.matchedPool.candidateCount,2);
 assert.ok(report.variants.find(row=>row.multiplier===1).candidates.some(row=>row.heroId===11));
 assert.ok(report.diagnostics.matchedPool.currentTop5.every(row=>row.heroId!==11));
 assert.ok(report.diagnostics.matchedPool.positionalWRTop5.every(row=>row.heroId!==11));
 assert.ok(report.diagnostics.matchedPool.controls.every(control=>control.top5.every(row=>row.heroId!==11)));
});

test('matched diagnostics distinguish a missing positional baseline and never manufacture accuracy metrics',()=>{
 const source={...stats,scope:{patch:null,rank:null,role:null},components:{
  baseline:{...components.baseline,scope:{patch:null,rank:null,role:null},roleFiltered:false},
  pairs:{...components.pairs,scope:{patch:null,rank:null,role:null},roleFiltered:false}},
  provenance:{...stats.provenance,roleFiltered:false}};
 const report=sensitivity({candidateHeroIds:[42,8],enemyHeroIds:[2],stats:source,now});
 assert.equal(report.diagnostics.candidateCount,2);
 assert.equal(report.diagnostics.matchedPool.status,'no_verified_position_baseline');
 assert.equal(report.diagnostics.matchedPool.candidateCount,0);
 assert.equal(report.diagnostics.matchedPool.positionalWRComparison.topEqualsCurrent,null);
 assert.equal(report.diagnostics.matchedPool.positionalWRComparison.meanAbsoluteRankChange,null);
 assert.equal(Object.hasOwn(report.diagnostics,'accuracy'),false);
});
test('historical gate rejects future, unknown pair date and mismatched contexts',()=>{
 const snapshot={availableAt:'2026-10-13T12:00:00Z',data:{components}};
 const decision={decisionAt:'2026-10-14T00:00:00Z',patch:'p',rankId:'all',positionId:1};
 assert.equal(temporalEligibility(snapshot,decision).eligible,true);
 assert.equal(temporalEligibility({...snapshot,availableAt:'2026-10-15T00:00:00Z'},decision).eligible,false);
 assert.equal(temporalEligibility({ ...snapshot,data:{components:{...components,pairs:{scope:{patch:'p'}}}}},decision).eligible,false);
 assert.equal(temporalEligibility(snapshot,{...decision,patch:'old'}).eligible,false);
 assert.equal(temporalEligibility(snapshot,{...decision,rankId:'DIVINE_IMMORTAL'}).eligible,false);
 assert.equal(temporalEligibility(snapshot,{...decision,positionId:2}).eligible,false);
});
test('archives are immutable, compressed and whitelist public data only',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'coach-snapshot-'));
 try{const value=archiveSnapshot(directory,{...stats,token:'must-not-archive',settings:{private:true}},'2026-10-14T00:00:00Z');
 const again=archiveSnapshot(directory,stats,'2026-10-14T00:00:00Z');assert.equal(value.id,again.id);assert.equal(fs.readdirSync(directory).length,1);
 const raw=zlib.gunzipSync(fs.readFileSync(value.file)).toString();assert.equal(raw.includes('must-not-archive'),false);assert.equal(raw.includes('private'),false);assert.equal(JSON.parse(raw).availableAt,'2026-10-14T00:00:00Z');
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
test('historical gate rejects empty components, exact-decision data and unknown true period ends',()=>{
 const snapshot={availableAt:'2026-10-13T12:00:00Z',data:{components}};
 const decision={decisionAt:'2026-10-14T00:00:00Z',patch:'p',rankId:'all',positionId:1};
 assert.equal(temporalEligibility(snapshot,{...decision,components:[]}).eligible,false);
 assert.equal(temporalEligibility(snapshot,{...decision,components:['invalid']}).eligible,false);
 assert.equal(temporalEligibility({...snapshot,availableAt:decision.decisionAt},decision).eligible,false);
 const atDecision={...snapshot,data:{components:{...components,pairs:{...components.pairs,observedThrough:decision.decisionAt}}}};
 assert.equal(temporalEligibility(atDecision,decision).eligible,false);
 const dayStart={...snapshot,data:{components:{...components,baseline:{...components.baseline,observedThroughKind:'completed_day'}}}};
 const blocked=temporalEligibility(dayStart,decision);
 assert.equal(blocked.eligible,false);
 assert.ok(blocked.reasons.includes('baseline_observation_cutoff_unverified'));
 const endDefined={...dayStart,data:{components:{...dayStart.data.components,baseline:{...dayStart.data.components.baseline,observedUntilExclusive:'2026-10-13T01:00:00Z'}}}};
 assert.equal(temporalEligibility(endDefined,decision).eligible,true);
 const unknownPair={...snapshot,data:{components:{...components,pairs:{...components.pairs,observedThrough:null}}}};
 assert.ok(temporalEligibility(unknownPair,decision).reasons.includes('pairs_observation_cutoff_unverified'));
});
test('historical date gate accepts explicit Unix observation instants without parsing them as years',()=>{
 const snapshot={availableAt:Date.parse('2026-10-13T12:00:00Z')/1000,data:{components:{
  baseline:{...components.baseline,observedThrough:Date.parse(components.baseline.observedThrough)/1000},
  pairs:{...components.pairs,observedThrough:Date.parse(components.pairs.observedThrough)},
 }}};
 const decision={decisionAt:'2026-10-14T00:00:00Z',patch:'p',rankId:'all',positionId:1};
 assert.equal(temporalEligibility(snapshot,decision).eligible,true);
});
test('archived public provenance replays native adjusted effects without an extra WR correction',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'coach-replay-'));
 try{
  const source={...stats,provenance:{...stats.provenance,secret:'do-not-store'},heroes:[{
   heroId:42,games:1000,wins:530,matchups:[{heroId:2,games:1000,wins:800,advantage:-.04}],synergies:[],
  }]};
  const input={candidateHeroIds:[42],enemyHeroIds:[2],stats:source,now};
  const runtime=evaluateDraft(input),archive=archiveSnapshot(directory,source,'2026-10-14T00:00:00Z');
  const decoded=JSON.parse(zlib.gunzipSync(fs.readFileSync(archive.file)));
  assert.equal(decoded.data.provenance.advantageMethod,'stratz_native_synergy');
  assert.equal(decoded.data.provenance.pairRoleFiltered,false);
  assert.equal(Object.hasOwn(decoded.data.provenance,'secret'),false);
  const replay=evaluateDraft({...input,stats:decoded.data});
  assert.deepEqual(replay.candidates,runtime.candidates);
  const entry=replay.candidates[0].matchupEvidence[0];
  assert.equal(entry.rawWinRate,.8);
  assert.equal(entry.advantagePp,-4);
  assert.equal(entry.nativeAdjusted,true);
  assert.ok(entry.contribution<0);
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

test('offline enemy and ally grid varies independent contributions and leaves current engine untouched',()=>{
 const input={candidateHeroIds:[42,8],enemyHeroIds:[2],allyHeroIds:[5],stats:{...stats,heroes:stats.heroes.map(row=>({...row,synergies:[{heroId:5,games:1000,wins:550,advantage:.03}]}))},now};
 const before=evaluateDraft(input),grid=sensitivity(input,undefined,[.5,1,2]);assert.equal(grid.variants.length,12);
 const reference=grid.variants.find(row=>row.multiplier===1 && row.allyMultiplier===1);
 for(const variant of grid.variants)for(const row of variant.candidates){
  const initial=reference.candidates.find(value=>value.heroId===row.heroId);
  assert.equal(row.base,initial.base);assert.equal(row.enemies,initial.enemies*variant.multiplier);assert.equal(row.allies,initial.allies*variant.allyMultiplier);
 }
 assert.deepEqual(evaluateDraft(input),before);
 assert.throws(()=>sensitivity(input,[1],[NaN]),/Invalid ally/);
 assert.ok(grid.diagnostics.componentSpread.enemies.standardDeviation>0);
});

const decision={schemaVersion:1,decisionId:'test-decision',snapshotId:'a'.repeat(64),matchId:'123456',
 decisionAt:'2026-10-14T00:00:00Z',observedAt:'2026-10-13T23:59:58Z',draftVisibility:'observed_at_decision',
 patch:'p',rankId:'all',positionId:1,allyHeroIds:[],enemyHeroIds:[2],bannedHeroIds:[],chosenHeroId:42,
 outcome:{won:true,completedAt:'2026-10-14T01:00:00Z'}};
const historicalSnapshot={id:decision.snapshotId,availableAt:'2026-10-13T12:00:00Z',data:{...stats,components:{
 baseline:{...components.baseline,roleFiltered:true},pairs:components.pairs}}};
test('decision import requires an observed pick-time draft, known context and a finished observed outcome',()=>{
 assert.equal(validateDecisionRecord(decision).valid,true);
 for(const patch of [{draftVisibility:'final_match_roster'},{observedAt:'2026-10-14T00:00:01Z'},{patch:null},{rankId:'FILTERED'},
  {positionId:6},{allyHeroIds:[2]},{enemyHeroIds:[2,2]},{chosenHeroId:2},{matchId:null},{outcome:{won:true,completedAt:decision.decisionAt}}]){
  assert.equal(validateDecisionRecord({...decision,...patch}).valid,false,JSON.stringify(patch));
 }
 const picks=[{heroId:2,side:'enemy',pickedAt:'2026-10-13T23:59:57Z'}];
 assert.equal(validateDecisionRecord({...decision,visiblePicks:picks}).valid,true);
 assert.ok(validateDecisionRecord({...decision,visiblePicks:[{...picks[0],pickedAt:decision.decisionAt}]}).reasons.includes('pick_events_include_unknown_or_future_pick'));
});

test('historical preparation exports only observed chosen-hero outcome features and rejects missing temporal pair context',()=>{
 const valid=historicalEvaluation([decision],[historicalSnapshot]);
 assert.equal(valid.eligibleOutcomeCount,1);assert.equal(valid.rows[0].chosenHeroId,42);assert.equal(valid.rows[0].outcome.won,true);
 assert.equal(valid.rows[0].smoothedPositionWR,(530+250)/1500);
 assert.equal(valid.rows[0].variants.length,4);assert.equal(valid.metrics.logLoss,null);assert.equal(valid.metrics.recommendationAccuracy,null);
 assert.equal(valid.folds.status,'insufficient_groups');
 const unknownPairs={...historicalSnapshot,data:{...historicalSnapshot.data,components:{...historicalSnapshot.data.components,pairs:{...components.pairs,observedThrough:null}}}};
 const blocked=historicalEvaluation([decision],[unknownPairs]);
 assert.equal(blocked.eligibleOutcomeCount,0);assert.equal(blocked.readiness.baselineEligible,1);assert.equal(blocked.readiness.fullModelEligible,0);
 assert.equal(blocked.blockerCounts.pairs_observation_cutoff_unverified,1);
 assert.equal(historicalEvaluation([{...decision,outcome:null}],[historicalSnapshot]).blockerCounts.completed_outcome_missing,1);
 assert.equal(historicalEvaluation([decision,decision],[historicalSnapshot]).blockerCounts.duplicate_decision_id,1);
 const estimated={...historicalSnapshot,data:{...historicalSnapshot.data,components:{...historicalSnapshot.data.components,baseline:{...components.baseline,positionEstimated:true}}}};
 assert.equal(historicalEvaluation([decision],[estimated]).blockerCounts.baseline_role_filter_unverified,1);
});

test('chronological folds keep the same match together and withhold unavailable training labels',()=>{
 const rows=Array.from({length:6},(_,index)=>({decisionId:`d${index}`,matchId:`m${index}`,
  decisionAt:new Date(Date.parse('2026-10-01T00:00:00Z')+index*86400000).toISOString(),
  outcome:{won:!!(index%2),completedAt:new Date(Date.parse('2026-10-01T01:00:00Z')+index*86400000).toISOString()}}));
 rows.push({...rows[0],decisionId:'same-match-another-role'});
 rows[2].outcome.completedAt='2026-10-04T00:30:00Z';
 const folds=chronologicalFolds(rows);
 assert.ok(folds.train.includes('d0') && folds.train.includes('same-match-another-role'));
 assert.ok(folds.withheld.includes('d2'));assert.equal(folds.train.includes('d2'),false);
 assert.equal(new Set([...folds.train,...folds.validation,...folds.test,...folds.withheld]).size,rows.length);
 const trainMatchIds=new Set(rows.filter(row=>folds.train.includes(row.decisionId)).map(row=>row.matchId));
 assert.equal(rows.filter(row=>[...folds.validation,...folds.test].includes(row.decisionId)).some(row=>trainMatchIds.has(row.matchId)),false);
});

test('archive reader verifies immutable public snapshot identity before replay',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'coach-archive-read-'));
 try{
  const archived=archiveSnapshot(directory,stats,'2026-10-14T00:00:00Z'),decoded=readSnapshotArchive(archived.file);
  assert.equal(decoded.id,archived.id);assert.equal(decoded.data.providerId,'stratz');
  fs.writeFileSync(archived.file,zlib.gzipSync(Buffer.from(JSON.stringify({...decoded,availableAt:'2026-10-15T00:00:00Z'}))));
  assert.throws(()=>readSnapshotArchive(archived.file),/identity mismatch/);
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

test('expanded diagnostic draft suite covers all positions reproducibly with no impossible overlapping picks',()=>{
 const {constructedDrafts,parseArguments}=require('../scripts/evaluate-draft.cjs');
 const drafts=constructedDrafts();assert.equal(drafts.length,74);assert.deepEqual(constructedDrafts(),drafts);
 assert.equal(new Set(drafts.map(row=>row.id)).size,drafts.length);
 for(const positionId of [1,2,3,4,5])assert.ok(drafts.filter(row=>row.positionId===positionId).length>=14);
 for(const row of drafts){assert.ok(row.allyHeroIds.length<=4 && row.enemyHeroIds.length<=5);assert.equal(new Set([...row.allyHeroIds,...row.enemyHeroIds]).size,row.allyHeroIds.length+row.enemyHeroIds.length);}
 assert.equal(drafts.filter(row=>row.suite==='complete').length,60);
 assert.equal(parseArguments(['--rank','DIVINE_IMMORTAL','--ally-grid']).rankId,'DIVINE_IMMORTAL');
 assert.equal(parseArguments(['--rank=HERALD_GUARDIAN']).rankId,'HERALD_GUARDIAN');
 assert.throws(()=>parseArguments(['--rank','IMMORTAL']),/рейтинг/);
 assert.throws(()=>parseArguments(['--as-of','bad-date']),/Invalid as-of/);
});

test('historical gate accepts a verified partial pair-period upper bound without claiming a last-observation date',()=>{
 const pairs={...components.pairs,observedThrough:null,periodBoundsVerified:true,periodMethod:'stratz_unix_week_roundtrip',
  periodStart:'2026-10-09T00:00:00Z',periodEndExclusive:'2026-10-16T00:00:00Z',periodPartial:true,
  proof:{authority:'stratz_live_graphql_roundtrip',sampleWeek:1,requestSeconds:{current:1,inside:2,before:3,older:4},recentPeriodStarts:[1]}};
 const snapshot={...historicalSnapshot,data:{...historicalSnapshot.data,components:{...historicalSnapshot.data.components,pairs}}};
 assert.equal(temporalEligibility(snapshot,decision).eligible,true);
 assert.equal(snapshot.data.components.pairs.observedThrough,null);
 assert.equal(historicalEvaluation([decision],[snapshot]).eligibleOutcomeCount,1);
 for(const patch of [{periodBoundsVerified:false},{periodMethod:'assumed_week'},{periodStart:'2026-10-14T00:00:00Z'},
  {periodPartial:false},{periodPartial:null},{periodEndExclusive:'2026-10-08T00:00:00Z'},
  {observedThrough:'2026-10-15T00:00:00Z'},{observedThrough:'invalid-time'}]) {
  const changed={...snapshot,data:{...snapshot.data,components:{...snapshot.data.components,pairs:{...pairs,...patch}}}};
  assert.equal(temporalEligibility(changed,decision).eligible,false,JSON.stringify(patch));
 }
 const completed={...snapshot,data:{...snapshot.data,components:{...snapshot.data.components,pairs:{...pairs,
  periodStart:'2026-10-01T00:00:00Z',periodEndExclusive:'2026-10-08T00:00:00Z',periodPartial:false}}}};
 assert.equal(temporalEligibility(completed,decision).eligible,true);
 assert.equal(temporalEligibility({...snapshot,availableAt:decision.decisionAt},decision).eligible,false);
});

test('archives retain the public verified pair-period proof used for reproducible temporal replay',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'coach-period-proof-'));
 try{
  const proof={authority:'stratz_live_graphql_roundtrip',sampleWeek:123,requestSeconds:{current:1,inside:2,before:3,older:4},recentPeriodStarts:[1,2]};
  const pairPeriod={periodStart:'2026-10-09T00:00:00Z',periodEndExclusive:'2026-10-16T00:00:00Z',periodBoundsVerified:true,
   periodMethod:'stratz_unix_week_roundtrip',periodPartial:true,proof};
  const source={...stats,components:{...stats.components,pairs:{...stats.components.pairs,...pairPeriod}},
   provenance:{...stats.provenance,pairPeriodProof:proof,pairPeriodConsistent:true,pairPeriodMethod:pairPeriod.periodMethod,pairPeriodStart:pairPeriod.periodStart,
    pairPeriodEndExclusive:pairPeriod.periodEndExclusive,pairPeriodBoundsVerified:true,pairPeriodPartial:true}};
  const archive=archiveSnapshot(directory,source,'2026-10-14T00:00:00Z'),decoded=readSnapshotArchive(archive.file);
  assert.deepEqual(decoded.data.components.pairs.proof,proof);assert.deepEqual(decoded.data.provenance.pairPeriodProof,proof);
  assert.equal(decoded.data.provenance.pairPeriodMethod,'stratz_unix_week_roundtrip');
  assert.equal(decoded.data.provenance.advantageMethod,'stratz_native_synergy');
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
