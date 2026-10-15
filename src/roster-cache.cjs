'use strict';

// Team identities remain useful when a portrait is dark or the HUD crop is
// skipped. This cache contains identities, never positions or support roles.
const finite=Number.isFinite;
const isTeam=value=>value==='radiant'||value==='dire';
function newRosterCache(){return{version:1,matchId:null,lastGameTime:null,lastFrameAt:null,slots:{},teams:{radiant:[],dire:[]},fingerprint:null,pendingFingerprint:null,source:'screen_roster_history'};}
function validScreenPlayer(proof,now){return proof?.confirmed===true&&proof.heroId===42&&isTeam(proof.team)&&proof.source==='selected_hud'&&finite(proof.observedAt)&&now-proof.observedAt<=8000&&proof.observedAt-now<=1000;}
function rosterFingerprint(rows){
  if(rows.length!==10||new Set(rows.map(row=>row.id)).size!==10)return null;
  const ids=team=>rows.filter(row=>row.team===team).map(row=>row.id).sort((a,b)=>a-b);
  const radiant=ids('radiant'),dire=ids('dire');
  return radiant.length===5&&dire.length===5?`${radiant.join(',')}|${dire.join(',')}`:null;
}
function updateRosterCache(previous,{state,vision,screenPlayer,now=Date.now()}={}){
  let cache=previous?.version===1?{...previous,slots:{...previous.slots},teams:{radiant:[...previous.teams.radiant],dire:[...previous.teams.dire]}}:newRosterCache();
  const match=state?.matchId==null?null:String(state.matchId);
  if(cache.matchId!==null&&match!==null&&cache.matchId!==match||finite(cache.lastGameTime)&&finite(state?.gameTime)&&state.gameTime<cache.lastGameTime-5)cache=newRosterCache();
  if(match!==null)cache.matchId=match;if(finite(state?.gameTime))cache.lastGameTime=state.gameTime;
  const freshGsi=finite(state?.receivedAt)&&now-state.receivedAt<=15000&&state.receivedAt-now<=1000;
  const proof=screenPlayer??vision?.player,screenConfirmed=validScreenPlayer(proof,now);
  if(screenConfirmed&&freshGsi&&(state?.isSpectator===true||state?.status==='spectator'||Number.isInteger(state?.heroId)&&state.heroId>0&&state.heroId!==42))return newRosterCache();
  if(!screenConfirmed&&(!state?.isWraithKing||state.isSpectator||!freshGsi))return cache;
  const stamp=vision?.capturedAt??vision?.timestamp;
  if(!finite(stamp)||now-stamp>8000||stamp-now>1000||finite(cache.lastFrameAt)&&stamp<=cache.lastFrameAt)return cache;
  if(vision?.diagnostics?.rosterRefreshed===false)return cache;
  const slots=Array.isArray(vision?.roster)?vision.roster:vision?.roster?.slots;
  if(!Array.isArray(slots))return cache;cache.lastFrameAt=stamp;
  const accepted=slots.map((slot,index)=>({id:slot?.hero?.id,team:slot?.team,confidence:slot?.hero?.confidence,margin:slot?.hero?.margin,index,fromCache:slot?.fromCache})).filter(row=>row.fromCache!==true&&Number.isInteger(row.id)&&row.id>0&&isTeam(row.team)&&finite(row.confidence)&&(row.confidence>=.9||screenConfirmed&&row.confidence>=.84&&finite(row.margin)&&row.margin>=.12));
  const duplicates=new Set(accepted.filter(row=>accepted.filter(other=>other.id===row.id).length>1).map(row=>row.id));
  const fingerprint=rosterFingerprint(accepted);let rebuilt=false;
  if(fingerprint){
    const pending=cache.pendingFingerprint;
    const qualified=accepted.some(row=>row.confidence<.9);
    const confidenceById=Object.fromEntries(accepted.map(row=>[row.id,Math.min(row.confidence,pending?.value===fingerprint?(pending.confidenceById?.[row.id]??1):1)]));
    cache.pendingFingerprint=pending?.value===fingerprint?{...pending,lastSeenAt:stamp,count:pending.count+1,qualified:pending.qualified||qualified,confidenceById}:{value:fingerprint,firstSeenAt:stamp,lastSeenAt:stamp,count:1,qualified,confidenceById};
    const needsQualified=cache.pendingFingerprint.qualified;
    const stable=cache.pendingFingerprint.count>=(needsQualified?3:2)&&stamp-cache.pendingFingerprint.firstSeenAt>=(needsQualified?10000:2000);
    if(cache.fingerprint&&cache.fingerprint!==fingerprint&&!stable)return cache;
    if(stable&&cache.fingerprint!==fingerprint){
      // A changed complete, twice observed HUD is a new screen context even
      // without a GSI match ID. Never carry old heroes into that context.
      const firstSeenAt=cache.pendingFingerprint.firstSeenAt;
      cache.slots=Object.fromEntries(accepted.map(row=>[row.team+':'+row.index,{...row,confidence:cache.pendingFingerprint.confidenceById[row.id],firstSeenAt,lastSeenAt:stamp,count:cache.pendingFingerprint.count,confirmed:true,qualified:needsQualified&&cache.pendingFingerprint.confidenceById[row.id]<.9}]));
      cache.fingerprint=fingerprint;rebuilt=true;
    }
  }else cache.pendingFingerprint=null;
  for(const row of accepted){
    if(rebuilt)continue;
    if(duplicates.has(row.id))continue;
    const key=row.team+':'+row.index,old=cache.slots[key];
    const qualified=row.confidence<.9||old?.id===row.id&&old.qualified===true;
    if(old?.id===row.id){cache.slots[key]={...old,lastSeenAt:stamp,count:old.count+1,confidence:Math.min(old.confidence,row.confidence),qualified,confirmed:old.confirmed||(old.count+1>=(qualified?3:2)&&stamp-old.firstSeenAt>=(qualified?10000:2000))};}
    else cache.slots[key]={...row,firstSeenAt:stamp,lastSeenAt:stamp,count:1,qualified,confirmed:false};
  }
  const confirmed=Object.values(cache.slots).filter(row=>row.confirmed),conflicts=new Set(confirmed.filter(row=>confirmed.some(other=>row.id===other.id&&row.team!==other.team)).map(row=>row.id));
  cache.teams={radiant:[...new Set(confirmed.filter(row=>row.team==='radiant'&&!conflicts.has(row.id)).map(row=>row.id))],dire:[...new Set(confirmed.filter(row=>row.team==='dire'&&!conflicts.has(row.id)).map(row=>row.id))]};
  return cache;
}
module.exports={newRosterCache,updateRosterCache,validScreenPlayer,rosterFingerprint};
