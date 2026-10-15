'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {evaluateDraft}=require('../src/draft-coach.cjs');
const NOW=Date.parse('2026-10-14T12:00:00Z');
const scope={patch:'7.41f',rank:'HERALD_GUARDIAN',role:'POSITION_1'};
const component={observedThrough:'2026-10-14T00:00:00Z',scope,roleFiltered:true,patchFiltered:true,rankFiltered:true,schemaVerified:true};
const pair=(heroId,advantage,games=1000)=>({heroId,games,wins:Math.floor(games*.8),advantage});
const row=(heroId,extra={})=>({heroId,games:100000,wins:75000,matchups:[],synergies:[],...extra});
function evaluate(rows,extra={}){
 return evaluateDraft({now:NOW,positionId:1,requirePositionData:true,candidateHeroIds:rows.map(row=>row.heroId),
  stats:{providerId:'stratz',scope,components:{baseline:component,pairs:component},
   provenance:{roleFiltered:true,pairRoleFiltered:true,advantageMethod:'stratz_native_synergy'},heroes:rows},...extra});
}

test('runtime returns five statistical recommendations with all remaining candidates inspectable',()=>{
 const result=evaluate([1,2,3,4,5,6,7].map(heroId=>row(heroId,{wins:60000-heroId*100})));
 assert.deepEqual(result.recommendations.map(row=>row.heroId),[1,2,3,4,5]);
 assert.equal(result.candidates.length,7);
 assert.equal(result.candidates[5].heroId,6);
 assert.deepEqual(result.recommendations,result.candidates.slice(0,5));
});

test('a high position WR cannot relabel an adverse enemy draft as a favorable fit',()=>{
 const result=evaluate([row(42,{matchups:[pair(35,-.04),pair(75,-.04),pair(99,-.04)],synergies:[pair(5,.04)]})],
  {enemyHeroIds:[35,75,99],allyHeroIds:[5]});
 const rec=result.recommendations[0],assessment=rec.draftAssessment;
 assert.ok(rec.rawScore>60); // Previously crossed the unconditional good-fit label.
 assert.equal(assessment.status,'unfavorable');
 assert.equal(assessment.basis,'baseline');
 assert.equal(assessment.baseOffsetsNegativeDraft,true);
 assert.equal(assessment.negativeEnemyCount,3);
 assert.equal(assessment.negativeAllyCount,0);
 assert.equal(assessment.risks.length,3);
 assert.equal(assessment.favorable[0].heroId,5);
 assert.equal(assessment.enemies.direction,'negative');
 assert.ok(assessment.components.enemies<0);
 assert.equal(rec.fitLabel,'Риски против соперников');
 assert.equal(assessment.interpretation,'descriptive_signals_not_statistical_significance');
});

test('mixed observed enemy effects retain both sides and follow their actual weighted contribution',()=>{
 const rec=evaluate([row(42,{matchups:[pair(35,-.04),pair(75,.10)]})],{enemyHeroIds:[35,75]}).recommendations[0];
 const assessment=rec.draftAssessment;
 assert.equal(assessment.status,'mixed');
 assert.equal(assessment.enemies.direction,'positive');
 assert.equal(assessment.enemies.positive,1);
 assert.equal(assessment.enemies.negative,1);
 assert.equal(assessment.enemies.strongestPositive.heroId,75);
 assert.equal(assessment.enemies.strongestNegative.heroId,35);
 assert.equal(assessment.enemies.netContribution,rec.scoreBreakdown.enemies);
 assert.equal(rec.fitLabel,'Плюсы и риски по драфту');
});

test('tiny positive observations keep their exact score but cannot create a favorable-fit claim',()=>{
 const rec=evaluate([row(42,{wins:50000,matchups:[pair(35,.00000001,2000)]})],{enemyHeroIds:[35]}).recommendations[0];
 assert.ok(rec.rawScore>50);
 assert.equal(rec.draftAssessment.enemies.positive,1);
 assert.equal(rec.draftAssessment.enemies.hasDirectionalSignal,false);
 assert.equal(rec.draftAssessment.enemies.strongestPositive.displayRelevant,false);
 assert.equal(rec.draftAssessment.status,'neutral');
 assert.equal(rec.fitLabel,'Без явного сигнала драфта');
});

test('missing pair evidence stays unknown rather than turning strong base WR into good matchup claims',()=>{
 const rec=evaluate([row(42)],{enemyHeroIds:[35,75],allyHeroIds:[5]}).recommendations[0];
 assert.ok(rec.rawScore>60);
 assert.equal(rec.draftAssessment.status,'unknown_context');
 assert.equal(rec.draftAssessment.basis,'baseline');
 assert.equal(rec.draftAssessment.missingPairs,3);
 assert.equal(rec.draftAssessment.enemies.neutral,0);
 assert.equal(rec.draftAssessment.allies.neutral,0);
 assert.equal(rec.draftAssessment.completeCoverage,false);
 assert.equal(rec.fitLabel,'Матчапы не подтверждены');
});

test('partial favorable evidence explicitly marks incomplete coverage and preserves the missing participants',()=>{
 const rec=evaluate([row(42,{matchups:[pair(35,.04)]})],{enemyHeroIds:[35,75],allyHeroIds:[5]}).recommendations[0];
 assert.equal(rec.draftAssessment.status,'favorable');
 assert.equal(rec.draftAssessment.enemies.used,1);
 assert.equal(rec.draftAssessment.enemies.missing,1);
 assert.equal(rec.draftAssessment.allies.missing,1);
 assert.equal(rec.draftAssessment.missingPairs,2);
 assert.equal(rec.fitLabel,'Есть плюсы, данные неполны');
});

test('baseline-only and observed neutral pairs never imply favorable draft effects',()=>{
 const base=evaluate([row(42)]).recommendations[0];
 assert.equal(base.draftAssessment.status,'no_context');
 assert.equal(base.draftAssessment.basis,'baseline');
 assert.equal(base.fitLabel,'Оценка по WR позиции');
 const neutral=evaluate([row(42,{matchups:[pair(35,0)]})],{enemyHeroIds:[35]}).recommendations[0];
 assert.equal(neutral.draftAssessment.status,'neutral');
 assert.equal(neutral.draftAssessment.enemies.neutral,1);
 assert.equal(neutral.draftAssessment.enemies.missing,0);
 assert.equal(neutral.draftAssessment.completeCoverage,true);
 assert.equal(neutral.fitLabel,'Без явного сигнала драфта');
});

test('structured explanation preserves genuine position WR and counts without deriving a match win chance',()=>{
 const rec=evaluate([row(42,{games:1000,wins:550})]).recommendations[0],base=rec.draftAssessment.baseline;
 assert.equal(base.winRate,.55);
 assert.equal(base.smoothedWinRate,800/1500);
 assert.equal(base.games,1000);
 assert.equal(base.positionId,1);
 assert.equal(base.roleFiltered,true);
 assert.equal(Object.hasOwn(rec.draftAssessment,'winProbability'),false);
 assert.equal(rec.draftAssessment.components.baseline,rec.scoreBreakdown.baseline);
});
