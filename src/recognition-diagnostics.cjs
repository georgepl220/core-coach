'use strict';

// Deliberately whitelist scalar recognition data. No account IDs, tokens,
// inventory, pixel buffers or screenshots may enter this report.
function recognitionDiagnostic({now=Date.now(),version,state,vision,settings={},cache,track,captureConfig={},captureStatus,captureError,imported=false,busy=false}={}){
  const age=stamp=>Number.isFinite(stamp)?Math.max(0,now-stamp):null;
  const slots=Array.isArray(vision?.roster)?vision.roster:vision?.roster?.slots||[];
  const hero=h=>({id:h.id,score:h.confidence,margin:h.margin,team:h.team,x:h.x,y:h.y});
  return{
    measuredAt:new Date(now).toISOString(),version,
    gsi:{status:state?.status||'waiting',ageMs:age(state?.receivedAt),heroId:state?.heroId??null,isWraithKing:state?.isWraithKing===true,gameTime:state?.gameTime??null,gameState:state?.gameState??null,team:state?.team??null,paused:state?.isPaused===true,spectator:state?.isSpectator===true},
    capture:{enabled:captureConfig.enabled===true,status:captureStatus,error:captureError||null,busy,imported,scope:settings.captureScope,profile:settings.performanceMode,overlayVisible:settings.overlayVisible,frameAgeMs:age(vision?.capturedAt??vision?.timestamp),sceneEnabled:captureConfig.calibration?.sceneEnabled===true},
    selectedHero:{id:vision?.player?.heroId??null,confirmed:vision?.player?.confirmed===true,score:vision?.player?.confidence??null,team:vision?.player?.team??null,source:vision?.player?.source??null,teamSource:vision?.player?.teamSource??null,ageMs:age(vision?.player?.observedAt),reason:vision?.player?.reason??null},
    hud:slots.slice(0,10).map(slot=>({id:slot?.hero?.id??null,team:slot?.team,score:slot?.hero?.confidence??slot?.bestSimilarity??null,margin:slot?.hero?.margin??null,fromCache:slot?.fromCache===true})),
    teams:{radiant:[...(cache?.teams?.radiant||[])],dire:[...(cache?.teams?.dire||[])]},
    minimap:{heroes:(vision?.minimap?.heroes||[]).map(hero)},
    scene:{usable:vision?.scene?.usable===true,proposedHeads:vision?.scene?.proposedHeadCount??0,analyzedHeads:vision?.scene?.analyzedHeadCount??0,heroes:(vision?.scene?.heroes||[]).map(hero),observations:(vision?.scene?.observations||[]).slice(0,10).map(o=>({index:o.index,id:o.bestHeroId,score:o.bestSimilarity,margin:o.margin,distance:o.distance,accepted:o.accepted,reason:o.reason}))},
    lane:{status:track?.inferred?.status,reason:track?.inferred?.reason,complete:track?.inferred?.complete===true,allyId:track?.inferred?.allyHeroId??null,enemyIds:[...(track?.inferred?.enemyHeroIds||[])]},
  };
}
module.exports={recognitionDiagnostic};
