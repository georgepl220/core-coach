'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateDraft } = require('../src/draft-coach.cjs');
const { normalizePosition, roleFitFor } = require('../src/draft-roles.cjs');
const { heroes: catalog } = require('../data/wraith-king.json');
const NOW = Date.UTC(2026, 9, 13, 12);
const allIds = Object.keys(catalog).map(Number);
function statistics(rows, extra = {}, position = 1) {
  return { providerId: 'stratz', updatedAt: new Date(NOW - 1000).toISOString(), observedThrough: new Date(NOW - 1000).toISOString(), scope: { patch: '7.41', rank: 'DIVINE_IMMORTAL', role: `POSITION_${position}` }, provenance: { roleFiltered: true, patchFiltered: true, rankFiltered: true, schemaVerified: true }, heroes: rows, ...extra };
}
function row(heroId, matchups = [], synergies = [], extra = {}) { return { heroId, games: 1000, wins: 500, matchups, synergies, ...extra }; }
function evaluate(input = {}) { return evaluateDraft({ now: NOW, ...input }); }
function candidate(result, id) { return result.candidates.find(hero => hero.heroId === id); }

test('default ranking and inspectable candidates use all 127 heroes without a five-hero restriction', () => {
  const result = evaluate();
  assert.equal(allIds.length, 127);
  assert.equal(result.catalogCount, 127);
  assert.equal(result.heroCount, 127);
  assert.equal(result.candidateCount, 127);
  assert.deepEqual(result.candidates.map(hero => hero.heroId).sort((a,b)=>a-b), allIds.sort((a,b)=>a-b));
  assert.ok(candidate(result, 2));
  assert.ok(candidate(result, 145));
  assert.equal(result.positionId, 1);
  assert.equal(result.statsStatus, 'no_data');
  assert.equal(result.recommendations.length, 0);
  assert.equal(result.coverageCount, 0);
  assert.ok(result.candidates.every(hero => hero.score === null && hero.sampleCount === 0 && !hero.dataUsed && hero.fitLabel === 'Мало данных'));
});

test('default statistical recommendations can include every catalog hero, not only supported coaching profiles', () => {
  const rows = allIds.map(id => row(id, [], [], { games: 10000, wins: id === 145 ? 6500 : id === 2 ? 6300 : id === 5 ? 6000 : 5000 }));
  const result = evaluate({ stats: statistics(rows) });
  assert.equal(result.catalogCount, 127);
  assert.equal(result.coverageCount, 127);
  assert.deepEqual(result.recommendations.map(hero => hero.heroId), [145, 2, 5, 1, 3]);
  assert.ok(result.recommendations.every(hero => hero.reasons[0].includes('винрейт')));
  assert.equal(result.sourceLabel, 'STRATZ');
  assert.equal(result.statsStatus, 'used');
});

test('excludes picked, banned, own and unknown heroes from explicit pools and all-catalog recommendations', () => {
  const result = evaluate({ allyHeroIds: [42], enemyHeroIds: [48], bannedHeroIds: [8], ownHeroId: 18, candidateHeroIds: [42, 8, 18, 44, 48, 1, 999] });
  assert.deepEqual(result.candidates.map(hero => hero.heroId).sort((a,b)=>a-b), [1,44]);
  const full = evaluate({ allyHeroIds: [42], enemyHeroIds: [48], bannedHeroIds: [8], ownHeroId: 18, stats: statistics(allIds.map(id => row(id))) });
  assert.equal(full.candidateCount, 123);
  assert.equal(full.coverageCount, 123);
  assert.ok(full.candidates.every(hero => ![42,48,8,18].includes(hero.heroId)));
});

test('normalizes numeric IDs and duplicates without mutating catalog or caller state', () => {
  const input = { heroes: { 44: { name: 'npc_dota_hero_phantom_assassin', localizedName: 'PA localized' } }, allyHeroIds: ['5', 5, null, Infinity], enemyHeroIds: ['12', 12, -1], candidateHeroIds: ['8', 18, 44, 48, 42], stats: statistics([row(44, [], [], { roles: ['Support'] })]) };
  const before = JSON.stringify(input);
  const result = evaluate(input);
  assert.equal(JSON.stringify(input), before);
  assert.ok(result.summary.includes('1 союзн. · 1 враг.'));
  assert.equal(result.candidates.length, 5);
  assert.equal(candidate(result, 44).name, 'PA localized');
  assert.equal(result.catalogCount, 127);
});

test('internal catalog names never leak into statistical explanations and localized names have priority', () => {
  const result = evaluate({ heroes: [{ id: 35, name: 'npc_dota_hero_sniper', localizedName: 'Sniper localized' }, { id: 18, name: 'npc_dota_hero_sven', localizedName: 'Sven localized' }], candidateHeroIds: [18], enemyHeroIds: [35], stats: statistics([row(18, [{ heroId: 35, games: 500, wins: 300 }])]) });
  assert.equal(candidate(result, 18).name, 'Sven localized');
  assert.ok(candidate(result, 18).reasons.some(text => /Sniper localized/.test(text)));
  assert.ok(candidate(result, 18).reasons.every(text => !/npc_dota_hero_/.test(text)));
});

test('all five positions select their own statistical outcomes and expose their selected role', () => {
  for (const position of [1,2,3,4,5]) {
    const winner = [42,11,2,26,5][position-1];
    const result = evaluate({ positionId: position, stats: statistics(allIds.map(id => row(id, [], [], { games: 5000, wins: id === winner ? 3500 : 2500 })), {}, position) });
    assert.equal(result.positionId, position);
    assert.equal(result.position.id, position);
    assert.equal(result.position.role, `POSITION_${position}`);
    assert.equal(result.recommendations[0].heroId, winner);
    assert.equal(result.candidates.length, 127);
    assert.ok(result.recommendations.every(hero => hero.positionId === position && hero.roleFiltered));
    assert.ok(result.scopeLabel.includes(`позиция ${position}`));
  }
});

test('capability labels and known ability rules do not create arbitrary role or counter bonuses', () => {
  const stats = statistics([row(42), row(18), row(44), row(48), row(8), row(5)], { scope: { role: null, patch: null, rank: null }, provenance: {} });
  const first = evaluate({ positionId: 1, enemyHeroIds: [12,68], allyHeroIds: [26], stats });
  const third = evaluate({ positionId: 3, enemyHeroIds: [12,68], allyHeroIds: [26], stats });
  assert.deepEqual(first.candidates.map(hero => [hero.heroId,hero.score]), third.candidates.map(hero => [hero.heroId,hero.score]));
  assert.ok(first.candidates.every(hero => hero.roleFitScore === 0));
  assert.ok(first.candidates.every(hero => ![...hero.reasons,...hero.risks].some(text => /Great Cleave|Blade Fury|Reincarnation|Ice Blast/.test(text))));
  assert.equal(roleFitFor({roles:['Carry','Initiator','Durable']},3).score,0);
  assert.equal(roleFitFor({roles:['Support']},1).suitable,null);
  assert.ok(third.notes.some(text => /смена позиции не создаёт новые винрейты/.test(text)));
});

test('legacy preferred or comfortable heroes never change the common statistical ranking', () => {
  const input = { enemyHeroIds: [35], stats: statistics([row(42, [{ heroId: 35, games: 2000, wins: 1000 }]),row(44, [{ heroId: 35, games: 2000, wins: 700 }])]) };
  const plain = evaluate(input);
  const preferences = evaluate({ ...input, preferredHeroIds: [44], comfortableHeroIds: [44], comfortBonus: 999 });
  assert.deepEqual(preferences.recommendations,plain.recommendations);
  assert.equal(preferences.recommendations[0].heroId,42);
});

test('missing statistics remain inspectable and do not displace supported statistical recommendations', () => {
  const result = evaluate({ stats: statistics([row(44, [], [], { games: 1000, wins: 300 }), row(42)]) });
  assert.deepEqual(result.recommendations.map(hero => hero.heroId), [42,44]);
  assert.equal(result.coverageCount, 2);
  assert.equal(candidate(result, 5).score, null);
  assert.equal(candidate(result, 5).fitLabel, 'Мало данных');
  assert.equal(result.candidates.length, 127);
  assert.ok(result.recommendations.every(hero => hero.dataUsed));
});

test('compares pair win rates relative to the candidate baseline rather than raw rates', () => {
  const result = evaluate({ candidateHeroIds: [42, 44], enemyHeroIds: [35], stats: statistics([
    row(42, [{ heroId: 35, games: 1000, wins: 580 }], [], { games: 10000, wins: 6000 }),
    row(44, [{ heroId: 35, games: 1000, wins: 530 }], [], { games: 10000, wins: 4500 }),
  ]) });
  const neutral = evaluate({candidateHeroIds:[42,44],enemyHeroIds:[35],stats:statistics([
    row(42,[],[],{games:10000,wins:6000}),row(44,[],[],{games:10000,wins:4500}),
  ])});
  assert.ok(candidate(result,44).score>candidate(neutral,44).score);
  assert.ok(candidate(result,42).score<candidate(neutral,42).score);
  assert.ok(candidate(result, 42).risks.some(text => /хуже общей выборки/.test(text)));
  assert.ok(candidate(result, 44).reasons.some(text => /лучше общей выборки/.test(text)));
  assert.ok(result.summary.includes('не вероятность победы'));
});

test('explicit source advantages work without raw baseline; incompatible raw pairs do not', () => {
  const noBaseline = statistics([row(44, [{ heroId: 35, games: 1000, wins: 900 }], [], { games: 0, wins: 0, baselineAvailable: false })]);
  const ignored = evaluate({ candidateHeroIds: [44], enemyHeroIds: [35], stats: noBaseline });
  assert.equal(candidate(ignored, 44).score, null);
  assert.equal(ignored.statsStatus, 'no_data');
  assert.ok(ignored.notes.some(text => /Нет сопоставимых пар/.test(text)));
  const adjusted = structuredClone(noBaseline);
  adjusted.heroes[0].matchups[0].advantage = .06;
  const result = evaluate({ candidateHeroIds: [44], enemyHeroIds: [35], stats: adjusted });
  assert.ok(candidate(result, 44).score > 50);
  assert.equal(candidate(result, 44).sampleCount, 1000);
  assert.ok(candidate(result,44).reasons.some(text=>/скорректированное преимущество источника/.test(text)));
  const incompatible = evaluate({ candidateHeroIds:[44], enemyHeroIds:[35],stats:statistics([row(44,[{heroId:35,games:1000,wins:900,baselineCompatible:false}])]) });
  assert.equal(candidate(incompatible,44).pairCount,0);
  assert.equal(candidate(incompatible,44).score,50);
});

test('ignores pairs under sample threshold and shrinks modest samples toward neutral', () => {
  const result = games => evaluate({ candidateHeroIds: [44], enemyHeroIds: [35], stats: statistics([row(44, [{ heroId: 35, games, wins: Math.floor(games * .8), advantage: .1 }])]) });
  const tiny = result(29), modest = result(40), large = result(1000);
  assert.equal(candidate(tiny, 44).score, 50);
  assert.equal(candidate(tiny, 44).pairCount, 0);
  assert.ok(candidate(large, 44).score > candidate(modest, 44).score);
  assert.equal(candidate(modest, 44).confidence, 'low');
});

test('baseline samples below threshold cannot produce a recommendation from one lucky observation', () => {
  const result = evaluate({ stats: statistics([row(2, [], [], { games: 1, wins: 1 }),row(44,[],[],{games:29,wins:29})]) });
  assert.equal(result.coverageCount,0);
  assert.equal(result.recommendations.length,0);
  assert.equal(candidate(result,2).score,null);
  assert.equal(candidate(result,44).score,null);
});

test('ally synergies affect score and explanations independently of opponent matchups', () => {
  const result = evaluate({ candidateHeroIds: [44, 48], allyHeroIds: [35], stats: statistics([
    row(44, [], [{ heroId: 35, games: 1000, wins: 580 }]),
    row(48, [], [{ heroId: 35, games: 1000, wins: 450 }]),
  ]) });
  assert.ok(candidate(result, 44).score > candidate(result, 48).score);
  assert.ok(candidate(result, 44).reasons.some(text => /STRATZ: с Sniper/.test(text)));
});

test('never sums overlapping pair samples into a claimed unique sample', () => {
  const result = evaluate({ candidateHeroIds: [44], enemyHeroIds: [35, 145], allyHeroIds: [5], stats: statistics([row(44, [
    { heroId: 35, games: 2000, wins: 1100 }, { heroId: 145, games: 700, wins: 380 },
  ], [{ heroId: 5, games: 900, wins: 480 }])]) });
  assert.equal(candidate(result, 44).sampleCount, 700);
  assert.equal(candidate(result, 44).pairCount, 3);
  assert.ok(candidate(result, 44).sampleLabel.includes('могут пересекаться'));
  assert.ok(candidate(result, 44).reasons.some(text => /Kez|Crystal Maiden|Sniper/.test(text)));
  assert.equal(result.confidence, 'high');
});

test('unfiltered OpenDota data is explicitly mixed-role and cannot receive high confidence', () => {
  const unfiltered = statistics([row(44, [{ heroId: 35, games: 3000, wins: 1900 }])], { providerId: 'opendota', scope: { patch: null, rank: null, role: null }, provenance: { roleFiltered: false, patchFiltered: false, rankFiltered: false } });
  const result = evaluate({ candidateHeroIds: [44], enemyHeroIds: [35], stats: unfiltered });
  assert.equal(result.confidence, 'low');
  assert.ok(result.scopeLabel.includes('патч не отфильтрован'));
  assert.ok(result.scopeLabel.includes('роли смешаны'));
  assert.ok(result.sourceLabel.includes('OpenDota'));
  assert.ok(result.notes.some(text => /Нет подтверждённых.*фильтров/.test(text)));
});

test('inferred observed positions use genuine counts but remain labeled estimated with low confidence', () => {
  const stats = statistics([row(2,[{heroId:35,games:1000,wins:650}])], {providerId:'opendota', scope:{role:'POSITION_3',patch:null,rank:null},provenance:{roleFiltered:false,positionEstimated:true,positionMethod:'lane_role_and_lane_farm_rank'}});
  const result = evaluate({positionId:3,enemyHeroIds:[35],stats});
  assert.ok(candidate(result,2).score>50);
  assert.equal(result.positionEstimated,true);
  assert.equal(candidate(result,2).positionEstimated,true);
  assert.equal(result.roleFiltered,false);
  assert.equal(result.confidence,'low');
  assert.ok(result.scopeLabel.includes('позиция 3 оценена'));
  assert.ok(result.notes.some(text=>/линии и распределению фарма/.test(text)));
  const wrong = evaluate({positionId:2,stats});
  assert.equal(wrong.statsStatus,'rejected');
  assert.equal(wrong.recommendations.length,0);
});

test('old caches, explicit mixed scopes, wrong role and wrong patch are excluded without invented scores', () => {
  const stats = statistics([row(44, [{ heroId: 35, games: 1000, wins: 700 }])]);
  for (const override of [
    { observedThrough: new Date(NOW - 31 * 86400000).toISOString() },
    { mixedScope: true },
    { scope: { patch: '7.41', rank: 'DIVINE', role: 'POSITION_5' } },
    { patchMatchesCurrent: false },
  ]) {
    const result = evaluate({ candidateHeroIds: [44], enemyHeroIds: [35], stats: { ...stats, ...override } });
    assert.equal(candidate(result, 44).score, null);
    assert.equal(result.recommendations.length,0);
    assert.equal(result.statsStatus, 'rejected');
    assert.equal(result.confidence, 'low');
  }
});

test('row-level hero and pair position mismatches cannot leak into another position', () => {
  const result = evaluate({positionId:2,candidateHeroIds:[2,11],enemyHeroIds:[35],stats:statistics([
    row(2,[{heroId:35,games:1000,wins:900}],[],{positionId:3}),
    row(11,[{heroId:35,games:1000,wins:900,positionId:3}],[],{positionId:2}),
  ],{},2)});
  assert.equal(candidate(result,2).score,null);
  assert.equal(candidate(result,11).score,50);
  assert.equal(candidate(result,11).pairCount,0);
});

test('unknown timestamps and incomplete filter verification lower confidence', () => {
  const rows = [row(44, [{ heroId: 35, games: 900, wins: 550 }, { heroId: 145, games: 900, wins: 550 }], [{ heroId: 5, games: 900, wins: 550 }])];
  for (const extra of [{ observedThrough: null }, { observedThrough: new Date(NOW + 3600000).toISOString() }, { provenance: { patchFiltered: true, rankFiltered: true, roleFiltered: true } }]) {
    const result = evaluate({ candidateHeroIds: [44], enemyHeroIds: [35, 145], allyHeroIds: [5], stats: statistics(rows, extra) });
    assert.equal(result.confidence, 'low');
  }
});

test('malformed samples cannot create NaN or unchecked statistical advantages', () => {
  for (const pair of [{ games: -1, wins: 1 }, { games: 100, wins: 101 }, { games: 0, wins: 0 }, { games: 100.5, wins: 60 }, { games: '100', wins: 60 }, { games: Infinity, wins: 30 }]) {
    const result = evaluate({ candidateHeroIds: [44], enemyHeroIds: [35], stats: statistics([row(44, [{ heroId: 35, ...pair }])]) });
    assert.equal(candidate(result, 44).score, 50);
    assert.equal(candidate(result, 44).pairCount, 0);
    assert.ok(Number.isFinite(candidate(result, 44).score));
  }
});

test('empty candidate pool explains exclusion and unknown roster identities do not create invented opponents', () => {
  const empty = evaluate({ bannedHeroIds: allIds });
  assert.equal(empty.recommendations.length, 0);
  assert.ok(empty.summary.includes('выбраны или запрещены'));
  const unknown = evaluate({ allyHeroIds: [999], enemyHeroIds: [998],stats:statistics([row(44)]) });
  assert.ok(unknown.summary.includes('0 союзн. · 0 враг.'));
  assert.ok(unknown.candidates.every(hero => ![...hero.reasons,...hero.risks].some(text=>/Герой (999|998)/.test(text))));
});

test('fresh verified samples produce medium confidence before enough draft coverage for high', () => {
  const result = evaluate({ candidateHeroIds: [44], allyHeroIds: [5], enemyHeroIds: [35], stats: statistics([row(44, [{ heroId: 35, games: 150, wins: 80 }], [{ heroId: 5, games: 150, wins: 80 }])]) });
  assert.equal(result.confidence, 'medium');
  assert.equal(candidate(result, 44).sampleCount, 150);
});

test('role normalization supports all public position forms and rejects invalid selections', () => {
  assert.equal(normalizePosition('POSITION_2'),2);
  assert.equal(normalizePosition('3'),3);
  assert.equal(normalizePosition('hard_support'),5);
  assert.equal(normalizePosition('POSITION_99',null),null);
  assert.equal(evaluate({positionId:99}).positionId,1);
});

test('role baseline and both-hero adjusted broad pairs stay clearly labeled and do not claim native advantage', () => {
  const stats = statistics([row(11,[{heroId:35,games:1000,wins:800,advantage:.05,baselineCompatible:false}],[],{games:1000,wins:600})],{provenance:{roleFiltered:true,patchFiltered:true,rankFiltered:true,schemaVerified:true,pairRoleFiltered:false,advantageMethod:'pair_winrate_adjusted_both_hero_baselines'}},2);
  const result = evaluate({positionId:2,enemyHeroIds:[35],stats});
  const hero = candidate(result,11);
  assert.ok(hero.score>50);
  assert.equal(hero.pairCount,1);
  assert.equal(hero.roleFiltered,true);
  assert.equal(hero.pairRoleFiltered,false);
  assert.equal(hero.confidence,'low');
  assert.ok(hero.reasons.some(text=>/Пара без фильтра по позиции/.test(text)));
  assert.ok(hero.reasons.every(text=>!/преимущество источника/.test(text)));
  assert.ok(hero.reasons.some(text=>/обоих героев/.test(text)));
  assert.ok(result.scopeLabel.includes('пары всех позиций'));
  assert.ok(result.notes.some(text=>/той же общей выборк/.test(text)));
});

test('broad matchup evidence cannot resurrect heroes with no adequate selected-position baseline', () => {
  for (const games of [0,1,29]) {
    const stats = statistics([row(42,[{heroId:35,games:10000,wins:9000,advantage:.15,baselineCompatible:false}],[],{games,wins:games})],{provenance:{roleFiltered:true,pairRoleFiltered:false,schemaVerified:true,advantageMethod:'stratz_native_synergy'}},2);
    const result = evaluate({positionId:2,enemyHeroIds:[35],stats});
    assert.equal(candidate(result,42).score,null);
    assert.equal(candidate(result,42).pairCount,0);
    assert.equal(result.recommendations.length,0);
  }
});

test('broad raw pair rates are never subtracted from a different role-filtered baseline', () => {
  const stats = statistics([row(11,[{heroId:35,games:1000,wins:900}],[],{games:1000,wins:500})],{provenance:{roleFiltered:true,pairRoleFiltered:false,schemaVerified:true}},2);
  const result = evaluate({positionId:2,enemyHeroIds:[35],stats});
  assert.equal(candidate(result,11).pairCount,0);
  assert.equal(candidate(result,11).score,50);
  assert.equal(result.recommendations.length,1);
});

test('multiple adjusted broad matches can overturn a role prior without inventing role-specific pair evidence', () => {
  const enemies=[12,26,47],allies=[5,20];
  const broadPairs=list=>list.map(heroId=>({heroId,games:10000,wins:9000,advantage:.15,baselineCompatible:false}));
  const stats=statistics([
    row(55,broadPairs(enemies),broadPairs(allies),{games:1314,wins:641}),
    row(42,[],[],{games:28842,wins:16082}),
  ],{provenance:{roleFiltered:true,pairRoleFiltered:false,schemaVerified:true,advantageMethod:'stratz_native_synergy'}});
  const result=evaluate({positionId:1,allyHeroIds:allies,enemyHeroIds:enemies,stats});
  assert.ok(candidate(result,55).score>candidate(result,42).score);
  assert.equal(result.recommendations[0].heroId,55);
  assert.ok(candidate(result,55).reasons[0].includes('винрейт'));
  assert.ok(candidate(result,55).reasons[1].includes('Пара без фильтра по позиции'));
  assert.equal(candidate(result,55).pairCount,5);
  assert.equal(candidate(result,55).confidence,'low');
});

test('true selected-role matchup evidence can still overturn a moderate baseline disadvantage', () => {
  const stats=statistics([
    row(55,[{heroId:35,games:10000,wins:6000,advantage:.1}],[],{games:10000,wins:4900}),
    row(42,[],[],{games:10000,wins:5400}),
  ]);
  const result=evaluate({positionId:1,enemyHeroIds:[35],stats});
  assert.equal(result.recommendations[0].heroId,55);
  assert.equal(candidate(result,55).pairRoleFiltered,true);
  assert.ok(candidate(result,55).score>candidate(result,42).score);
});

test('a cross-position pair contributes one quarter of otherwise identical selected-position evidence', () => {
  const common=[row(11,[{heroId:35,games:10000,wins:6000,advantage:.08,baselineCompatible:false}])];
  const matched=evaluate({positionId:2,enemyHeroIds:[35],stats:statistics(common,{},2)});
  const broad=evaluate({positionId:2,enemyHeroIds:[35],stats:statistics(common,{provenance:{roleFiltered:true,pairRoleFiltered:false,patchFiltered:true,rankFiltered:true,schemaVerified:true}},2)});
  const matchedDelta=candidate(matched,11).score-50,broadDelta=candidate(broad,11).score-50;
  assert.ok(Math.abs(broadDelta/matchedDelta-.25)<.02);
  assert.ok(candidate(broad,11).reasons.some(text=>/Пара без фильтра по позиции/.test(text)));
});

test('adding neutral or unobserved picks never erases a previously observed counter or bad synergy', () => {
  for (const heroId of [2,11,42,52,145]) {
    const stats=statistics([row(heroId,
      [{heroId:35,games:2000,wins:700,advantage:-.06},{heroId:75,games:2000,wins:1000,advantage:0}],
      [{heroId:26,games:2000,wins:700,advantage:-.06},{heroId:5,games:2000,wins:1000,advantage:0}],
      {games:10000,wins:5700})]);
    const original=evaluate({candidateHeroIds:[heroId],enemyHeroIds:[35],allyHeroIds:[26],stats});
    for (const extra of [{enemyHeroIds:[35,75],allyHeroIds:[26,5]},{enemyHeroIds:[35,99],allyHeroIds:[26,20]}]) {
      const result=evaluate({candidateHeroIds:[heroId],stats,...extra});
      assert.equal(candidate(result,heroId).score,candidate(original,heroId).score);
      assert.equal(candidate(result,heroId).scoreBreakdown.enemies,candidate(original,heroId).scoreBreakdown.enemies);
      assert.equal(candidate(result,heroId).scoreBreakdown.allies,candidate(original,heroId).scoreBreakdown.allies);
    }
  }
});

test('each additional independent negative pair accumulates a penalty rather than becoming one average counter', () => {
  const enemies=[35,75,99,70,102], allies=[5,26,66,83];
  const pairs=list=>list.map(heroId=>({heroId,games:2000,wins:900,advantage:-.04}));
  const stats=statistics([row(11,pairs(enemies),pairs(allies),{games:10000,wins:5700})]);
  let previous=candidate(evaluate({candidateHeroIds:[11],stats}),11).score;
  for (let count=1;count<=enemies.length;count++) {
    const hero=candidate(evaluate({candidateHeroIds:[11],enemyHeroIds:enemies.slice(0,count),stats}),11);
    assert.ok(hero.score<previous);
    assert.equal(hero.negativePairCount,count);
    previous=hero.score;
  }
  const full=candidate(evaluate({candidateHeroIds:[11],enemyHeroIds:enemies,allyHeroIds:allies,stats}),11);
  assert.ok(full.score<previous);
  assert.equal(full.negativePairCount,9);
  assert.equal(full.sampleCount,2000);
});

test('score breakdown and every pair contribution reconcile without claiming a unique combined sample', () => {
  const stats=statistics([row(11,[{heroId:35,games:2000,wins:1600,advantage:-.05},{heroId:75,games:500,wins:200,advantage:.03}],
    [{heroId:5,games:300,wins:210,advantage:.02}],{games:10000,wins:5500})],
    {provenance:{roleFiltered:true,pairRoleFiltered:false,schemaVerified:true,advantageMethod:'stratz_native_synergy'}});
  const hero=candidate(evaluate({candidateHeroIds:[11],enemyHeroIds:[35,75],allyHeroIds:[5],stats}),11);
  const {initial,baseline,enemies,allies,total}=hero.scoreBreakdown;
  assert.equal(initial,50);
  assert.equal(total,hero.rawScore);
  assert.ok(Math.abs(initial+baseline+enemies+allies-total)<1e-12);
  assert.equal(Math.round(total*10)/10,hero.score);
  assert.equal(hero.baselineGames,10000);
  assert.equal(hero.baselineWinRate,.55);
  assert.equal(hero.matchupEvidence.length,3);
  assert.equal(hero.negativePairCount,1);
  assert.equal(hero.sampleCount,300);
  assert.equal(hero.matchupEvidence.filter(p=>p.side==='enemy').reduce((n,p)=>n+p.contribution,0),enemies);
  assert.equal(hero.matchupEvidence.filter(p=>p.side==='ally').reduce((n,p)=>n+p.contribution,0),allies);
  const native=hero.matchupEvidence.find(p=>p.heroId===35);
  assert.equal(native.rawWinRate,.8);
  assert.equal(native.advantagePp,-5);
  assert.equal(native.nativeAdjusted,true);
  assert.equal(native.roleFiltered,false);
  assert.ok(native.contribution<0);
});

test('source-adjusted interactions determine direction even when the raw pair win rate says the opposite', () => {
  const stats=statistics([row(11,[{heroId:35,games:1000,wins:800,advantage:-.04}],
    [{heroId:5,games:1000,wins:400,advantage:.04}])],
    {provenance:{roleFiltered:true,patchFiltered:true,rankFiltered:true,schemaVerified:true,advantageMethod:'stratz_native_synergy'}});
  const hero=candidate(evaluate({candidateHeroIds:[11],enemyHeroIds:[35],allyHeroIds:[5],stats}),11);
  assert.ok(hero.scoreBreakdown.enemies<0);
  assert.ok(hero.scoreBreakdown.allies>0);
  assert.ok(hero.risks.some(text=>/отставание источника/.test(text)));
  assert.ok(hero.reasons.some(text=>/совместимость источника/.test(text)));
});

test('legacy own-baseline transforms are rejected rather than presented as native source advantage', () => {
  const stats=statistics([row(11,[{heroId:35,games:5000,wins:4500,advantage:.1,baselineCompatible:false}])],
    {provenance:{roleFiltered:true,pairRoleFiltered:false,schemaVerified:true,advantageMethod:'pair_winrate_minus_same_corpus_hero_baseline'}});
  const result=evaluate({candidateHeroIds:[11],enemyHeroIds:[35],stats}), hero=candidate(result,11);
  assert.equal(hero.score,50);
  assert.equal(hero.pairCount,0);
  assert.equal(hero.matchupEvidence.length,0);
  assert.ok(result.notes.some(text=>/винрейт второго героя/.test(text)));
});

test('a freshly downloaded old observation window cannot acquire fresh-sample confidence or weights', () => {
  const rows=[row(11,[{heroId:35,games:2000,wins:1100,advantage:.04},{heroId:75,games:2000,wins:1100,advantage:.04}],
    [{heroId:5,games:2000,wins:1100,advantage:.04}],{games:10000,wins:5500})];
  const input={candidateHeroIds:[11],enemyHeroIds:[35,75],allyHeroIds:[5]};
  const fresh=candidate(evaluate({...input,stats:statistics(rows)}),11);
  const oldStats=statistics(rows,{observedThrough:new Date(NOW-4*86400000).toISOString()});
  const oldResult=evaluate({...input,stats:oldStats}),old=candidate(oldResult,11);
  assert.equal(fresh.confidence,'high');
  assert.notEqual(old.confidence,'high');
  assert.equal(old.scoreBreakdown.baseline,fresh.scoreBreakdown.baseline*.5);
  assert.ok(oldResult.notes.some(text=>/скачивание не меняет возраст/.test(text)));
  assert.equal(evaluate({...input,stats:{...oldStats,observedThrough:new Date(NOW-31*86400000).toISOString()}}).statsStatus,'rejected');
});

test('legacy role day IDs are interpreted as observation seconds rather than fetch milliseconds', () => {
  const stats=statistics([row(11,[],[],{games:10000,wins:6000})]);
  stats.provenance.roleSampleDay=Math.floor((NOW-31*86400000)/1000);
  const result=evaluate({candidateHeroIds:[11],stats});
  assert.equal(result.statsStatus,'rejected');
  assert.equal(candidate(result,11).scoreBreakdown,null);
  assert.equal(candidate(result,11).baselineWinRate,null);
});

test('hostile public STRATZ Leshrac snapshot accumulates all eight native disadvantages', () => {
  // Public API probe from 2026-10-14, native heroVsHeroMatchup week 2962.
  // This fixture checks the statistical calculation; no hero receives a rule.
  const matchups=[
    {heroId:99,games:777,wins:383,advantage:-.04582,baselineCompatible:false},
    {heroId:75,games:1380,wins:658,advantage:-.04582,baselineCompatible:false},
    {heroId:46,games:676,wins:348,advantage:-.05195,baselineCompatible:false},
    {heroId:70,games:1011,wins:484,advantage:-.0529,baselineCompatible:false},
    {heroId:102,games:388,wins:179,advantage:-.05613,baselineCompatible:false},
  ];
  const synergies=[
    {heroId:66,games:41,wins:18,advantage:-.05498,baselineCompatible:false},
    {heroId:95,games:266,wins:129,advantage:-.06631,baselineCompatible:false},
    {heroId:83,games:316,wins:126,advantage:-.08175,baselineCompatible:false},
  ];
  const stats=statistics([row(52,matchups,synergies,{games:2991,wins:1750})],
    {scope:{patch:null,rank:null,role:'POSITION_1'},provenance:{roleFiltered:true,pairRoleFiltered:false,schemaVerified:true,advantageMethod:'stratz_native_synergy'}});
  const hero=candidate(evaluate({candidateHeroIds:[52],enemyHeroIds:[102,70,46,75,99],allyHeroIds:[66,95,83],stats}),52);
  assert.equal(hero.pairCount,8);
  assert.equal(hero.negativePairCount,8);
  assert.ok(hero.scoreBreakdown.enemies<-1.7);
  assert.ok(hero.scoreBreakdown.allies<-.4);
  assert.ok(hero.score<51);
  assert.equal(hero.confidence,'low');
  assert.equal(hero.matchupEvidence.every(p=>p.nativeAdjusted&&p.contribution<0),true);
});
