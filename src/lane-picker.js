(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.LanePicker=api;
})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  const valid=id=>Number.isInteger(id)&&id>0;
  function playerHeroId(snapshot){return snapshot?.activeProfile?.heroId||snapshot?.activeProfile?.id||snapshot?.hero?.heroId||42;}
  function teamChoices(snapshot,role){
    const own=playerHeroId(snapshot),draft=snapshot?.draftRoster||{},catalog=new Set((snapshot?.heroes||[]).map(hero=>hero.id));
    const ids=role==='ally'?draft.alliedHeroIds:draft.enemyHeroIds;
    return [...new Set(Array.isArray(ids)?ids:[])].filter(id=>valid(id)&&id!==own&&catalog.has(id));
  }
  function manualEnemies(snapshot){return [...new Set((snapshot?.settings?.laneEnemyHeroIds||[]).filter(valid))].slice(0,2);}
  function selectEnemy(ids,index,heroId){
    const next=[...ids].slice(0,2),slot=index===1?1:0;
    if(!valid(heroId))return next.filter((id,i)=>i!==slot&&valid(id));
    const other=slot===0?1:0;
    if(next[other]===heroId){
      // Clicking the other selected opponent exchanges their slots.
      const replaced=next[slot];next[slot]=heroId;next[other]=replaced;
    }else next[slot]=heroId;
    return next.filter(valid);
  }
  function selectionPatch(snapshot,role,index,heroId){
    if(heroId!==null&&(!valid(heroId)||heroId===playerHeroId(snapshot)))return null;
    if(role==='ally')return{laneAllyHeroId:heroId};
    let ids=manualEnemies(snapshot);
    // Editing one confirmed opponent keeps the other visible card in place.
    // A tentative recognition never becomes a manual confirmation this way.
    if(heroId!==null){
      ids=[...ids];
      for(let slot=0;slot<2;slot++){
        const member=snapshot?.laneRoster?.enemies?.[slot];
        if(!ids[slot]&&valid(member?.id)&&['confirmed','retained'].includes(member.status))ids[slot]=member.id;
      }
    }
    return{laneEnemyHeroIds:selectEnemy(ids,index,heroId)};
  }
  return{playerHeroId,teamChoices,manualEnemies,selectEnemy,selectionPatch};
});
