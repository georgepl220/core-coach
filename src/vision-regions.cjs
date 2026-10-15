'use strict';
const { analyzeScreen } = require('./vision.cjs');
const { validateRegionFrame } = require('./capture-policy.cjs');
const { analyzeSceneHeads } = require('./scene-vision.cjs');
const { analyzeSelectedHero } = require('./screen-identity.cjs');
const { resolveSelectedPlayer } = require('./selected-player.cjs');
const MAX_BYTES=1100000;
function pixels(region) { return region.data instanceof ArrayBuffer ? new Uint8Array(region.data) : region.data; }
function packRegions(packet) {
  const invalid=validateRegionFrame(packet);if(invalid)throw new Error(invalid);
  if(!packet?.originalSize||!Number.isFinite(packet.originalSize.width)||!Number.isFinite(packet.originalSize.height)||!Array.isArray(packet.regions))throw new Error('Invalid ROI packet');
  const accepted=packet.regions.filter(r=>r&&['minimap','roster'].includes(r.kind)&&Number.isInteger(r.width)&&Number.isInteger(r.height)&&r.width>=4&&r.height>=4&&r.width<=352&&r.height<=352&&r.rect&&['x','y','width','height'].every(k=>Number.isFinite(r.rect[k]))&&r.rect.width>0&&r.rect.height>0&&pixels(r)?.length===r.width*r.height*4);
  if(accepted.reduce((s,r)=>s+r.width*r.height*4,0)>MAX_BYTES||accepted.length>11)throw new Error('ROI packet exceeds budget');
  const map=accepted.find(r=>r.kind==='minimap');
  const slots=Array.from({length:10},(_,i)=>accepted.find(r=>r.kind==='roster'&&r.index===i));
  const rowHeight=Math.max(4,...slots.map(r=>r?.height||4));
  const rowWidths=[slots.slice(0,5).reduce((s,r)=>s+(r?.width||4)+2,0),slots.slice(5).reduce((s,r)=>s+(r?.width||4)+2,0)];
  const width=Math.max(map?.width||4,...rowWidths),height=rowHeight*2+6+(map?.height||4);
  const data=new Uint8Array(width*height*4);for(let i=3;i<data.length;i+=4)data[i]=255;
  function blit(r,x,y){if(!r)return;const bytes=pixels(r);for(let line=0;line<r.height;line++)data.set(bytes.subarray(line*r.width*4,(line+1)*r.width*4),((y+line)*width+x)*4);}
  const rosterRects=[];
  for(let row=0;row<2;row++){let x=0;for(let col=0;col<5;col++){const index=row*5+col,r=slots[index];const rect={x,y:row*(rowHeight+2),width:r?.width||4,height:r?.height||4,units:'px',team:index<5?'radiant':'dire'};rosterRects.push(rect);blit(r,rect.x,rect.y);x+=rect.width+2;}}
  const minimapRect={x:0,y:rowHeight*2+6,width:map?.width||4,height:map?.height||4,units:'px'};blit(map,minimapRect.x,minimapRect.y);
  return {frame:{width,height,data,timestamp:packet.timestamp},map,slots,minimapRect,rosterRects,inputBytes:accepted.reduce((s,r)=>s+r.width*r.height*4,0)};
}
function analyzeRegions(packet,settings,templates,previous){
  const packed=packRegions(packet), {map}=packed;
  const capturePhase=packet.capturePhase==='draft'?'draft':'game';
  const previousState=previous?.state||previous||{};
  const oldRoster=previousState.roster;
  const samePhase=(oldRoster?.capturePhase||'game')===capturePhase;
  const sameSize=samePhase&&oldRoster?.originalSize?.width===packet.originalSize.width&&oldRoster?.originalSize?.height===packet.originalSize.height;
  const cachedSlots=sameSize&&Array.isArray(oldRoster?.slots)?oldRoster.slots:[];
  const teamIds=team=>['radiant','dire'].includes(team)?cachedSlots.filter(s=>s.team===team&&s.hero?.confidence>=0.90).map(s=>s.hero.id):[];
  const playerTeam=settings.playerTeam;
  const enemyTeam=playerTeam==='radiant'?'dire':playerTeam==='dire'?'radiant':null;
  const knownOptions={...settings,allyHeroIds:[...new Set([...(settings.allyHeroIds||[]),...teamIds(playerTeam)])],enemyHeroIds:[...new Set([...(settings.enemyHeroIds||[]),...teamIds(enemyTeam)])]};
  const capturedRoster=packed.slots.some(Boolean);
  const originalIcon=Number(settings.minimapHeroSizePx)||19*packet.originalSize.height/1080;
  const scaledIcon=map?originalIcon*map.width/map.rect.width:originalIcon;
  const result=analyzeScreen(packed.frame,{...knownOptions,capturePhase,minimapRect:packed.minimapRect,rosterRects:packed.rosterRects,draftRosterRects:capturePhase==='draft'?packed.rosterRects:knownOptions.draftRosterRects,minimapHeroSizePx:scaledIcon},capturedRoster?templates:{...templates,portraits:[]},samePhase?previous:null);
  result.capturedAt=packet.timestamp;
  result.capturePhase=capturePhase;
  result.minimap.rect=map?.rect||null;
  for(const hero of result.minimap.heroes){if(map){hero.screenX=map.rect.x+hero.x*map.rect.width;hero.screenY=map.rect.y+hero.y*map.rect.height;}}
  if(capturedRoster){
    result.roster.slots.forEach((slot,i)=>{
      slot.rect=packed.slots[i]?.rect||null;
      slot.observedAt=packet.timestamp;
      const cached=cachedSlots.find(s=>s.index===slot.index&&s.team===slot.team&&s.hero);
      if(capturePhase!=='draft'&&!slot.hero&&cached)result.roster.slots[i]={...cached,fromCache:true,latestReason:slot.reason};
    });
  }else result.roster.slots=cachedSlots.map(s=>({...s,fromCache:true}));
  if(capturePhase==='draft'){
    result.player={confirmed:false,reason:'Player HUD is absent during hero selection'};
    result.scene={heroes:[],usable:false,capturedAt:packet.timestamp};
    result.state.roster={slots:result.roster.slots,observedAt:packet.timestamp,originalSize:{...packet.originalSize},capturePhase};
    result.diagnostics.crops=result.roster.slots.map(s=>({kind:'roster',index:s.index,rect:s.rect}));
    result.diagnostics.roiBytes=packet.regions.reduce((sum,region)=>sum+pixels(region).byteLength,0);
    result.diagnostics.originalBytes=packet.originalSize.width*packet.originalSize.height*4;
    result.diagnostics.atlasSize={width:packed.frame.width,height:packed.frame.height};
    result.diagnostics.rosterRefreshed=capturedRoster;
    result.diagnostics.captureMs=packet.diagnostics?.captureMs??null;
    return result;
  }
  const selected=analyzeSelectedHero(packet.regions.filter(region=>region.kind==='selected_hero_label').map(region=>({...region,data:pixels(region)})),packet.originalSize);
  result.player=resolveSelectedPlayer(selected,result.roster.slots,settings.gsiPlayer,packet.timestamp);
  const sceneTeam=result.player.confirmed?result.player.team:playerTeam,sceneEnemy=sceneTeam==='radiant'?'dire':sceneTeam==='dire'?'radiant':null;
  const sceneRegions=packet.regions.filter(region=>region.kind==='scene').map(region=>({...region,kind:'scene_head',data:pixels(region)}));
  const freshTeamIds=team=>result.roster.slots.filter(slot=>slot.team===team&&(slot.hero?.confidence>=.90||result.player.confirmed&&slot.hero?.confidence>=.84&&slot.hero?.margin>=.12)).map(slot=>slot.hero.id);
  const sceneOptions={...knownOptions,screenPlayer:result.player,frameTimestamp:packet.timestamp,playerTeam:sceneTeam,allyHeroIds:[...new Set([...(sceneTeam===playerTeam?knownOptions.allyHeroIds:knownOptions.enemyHeroIds),...freshTeamIds(sceneTeam)])],enemyHeroIds:[...new Set([...(sceneTeam===playerTeam?knownOptions.enemyHeroIds:knownOptions.allyHeroIds),...freshTeamIds(sceneEnemy)])]};
  if(result.player.confirmed)for(const hero of result.minimap.heroes){const slot=result.roster.slots.find(slot=>slot.hero?.id===hero.id);hero.team=hero.id===42?'self':slot?slot.team===sceneTeam?'ally':'enemy':'unknown';}
  result.scene=analyzeSceneHeads(sceneRegions,sceneOptions,templates,packet.originalSize);
  result.scene.usable=result.scene.heroes.filter(hero=>hero.id===settings.selfHeroId&&(hero.confidence>=.90||hero.qualifiedBySelectedHud===true&&hero.confidence>=.86&&result.player.confirmed)).length===1;
  result.scene.capturedAt=packet.timestamp;
  result.state.roster={slots:result.roster.slots,observedAt:capturedRoster?packet.timestamp:oldRoster?.observedAt,originalSize:{...packet.originalSize},capturePhase};
  result.diagnostics.crops=[{kind:'minimap',rect:result.minimap.rect},...result.roster.slots.map(s=>({kind:'roster',index:s.index,rect:s.rect}))];
  result.diagnostics.roiBytes=packet.regions.reduce((sum,region)=>sum+pixels(region).byteLength,0);result.diagnostics.originalBytes=packet.originalSize.width*packet.originalSize.height*4;result.diagnostics.atlasSize={width:packed.frame.width,height:packed.frame.height};
  result.diagnostics.rosterRefreshed=capturedRoster;
  result.diagnostics.captureMs=packet.diagnostics?.captureMs??null;
  return result;
}
module.exports={packRegions,analyzeRegions};
