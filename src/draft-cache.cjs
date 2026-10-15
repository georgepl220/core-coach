'use strict';
const {getHeroProfile}=require('./product.cjs');
const team=value=>value==='radiant'||value==='dire';
function newDraftCache(){return{heroId:null,matchId:null,lastFrameAt:null,slots:{},teams:{radiant:[],dire:[]}};}
// The new carry profiles use this cache for the manual picker only. It assigns
// team identities from portraits, never positions or automatic lane roles.
function updateDraftCache(previous,{state,vision,now=Date.now()}={}){
  if(!getHeroProfile(state?.heroId)||state.isSupportedCarry!==true||state.isSpectator===true||state.status!=='live'||!team(state.team)||!Number.isFinite(state.receivedAt)||now-state.receivedAt>15000||state.receivedAt-now>1000)return previous||newDraftCache();
  const matchId=state.matchId==null?null:String(state.matchId);
  let cache=previous?.heroId===state.heroId&&(matchId===null||previous.matchId===null||previous.matchId===matchId)?{...previous,slots:{...previous.slots},teams:{radiant:[...previous.teams.radiant],dire:[...previous.teams.dire]}}:newDraftCache();
  cache.heroId=state.heroId;cache.matchId=matchId;
  const stamp=vision?.capturedAt??vision?.timestamp;
  if(!Number.isFinite(stamp)||now-stamp>8000||stamp-now>1000||cache.lastFrameAt!==null&&stamp<=cache.lastFrameAt||vision?.diagnostics?.rosterRefreshed===false)return cache;
  const slots=Array.isArray(vision?.roster)?vision.roster:vision?.roster?.slots;
  if(!Array.isArray(slots))return cache;cache.lastFrameAt=stamp;
  const rows=slots.map((slot,index)=>({id:slot?.hero?.id,team:slot?.team,index,score:slot?.hero?.confidence,margin:slot?.hero?.margin,cached:slot?.fromCache===true})).filter(row=>!row.cached&&Number.isInteger(row.id)&&row.id>0&&team(row.team)&&Number.isFinite(row.score)&&row.score<=1&&(row.score>=.9||row.score>=.84&&row.margin>=.12)&&!(row.id===state.heroId&&row.team!==state.team));
  for(const row of rows){
    if(rows.filter(other=>other.id===row.id).length!==1)continue;
    const key=`${row.team}:${row.index}`,old=cache.slots[key],weak=row.score<.9||old?.id===row.id&&old.weak===true;
    cache.slots[key]=old?.id===row.id?{...old,score:Math.min(old.score,row.score),lastSeenAt:stamp,count:old.count+1,weak,confirmed:old.confirmed||(old.count+1>=(weak?3:2)&&stamp-old.firstSeenAt>=(weak?10000:2000))}:{...row,firstSeenAt:stamp,lastSeenAt:stamp,count:1,weak,confirmed:false};
  }
  const confirmed=Object.values(cache.slots).filter(row=>row.confirmed),conflicts=new Set(confirmed.filter(row=>confirmed.some(other=>row.id===other.id&&row.team!==other.team)).map(row=>row.id));
  const ids=side=>[...new Set(confirmed.filter(row=>row.team===side&&!conflicts.has(row.id)).map(row=>row.id))];
  cache.teams={radiant:ids('radiant'),dire:ids('dire')};
  if(!conflicts.has(state.heroId)&&!cache.teams[state.team].includes(state.heroId))cache.teams[state.team].unshift(state.heroId);
  return cache;
}
module.exports={newDraftCache,updateDraftCache};
