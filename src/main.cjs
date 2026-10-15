'use strict';
const electron = require('electron');
const { app, BrowserWindow, screen, globalShortcut, ipcMain, dialog, nativeImage, Tray, Menu, shell, safeStorage } = electron;
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { pathToFileURL } = require('node:url');
const { normalizeGsi, recommend } = require('./core.cjs');
const { ScreenCaptureHost } = require('./capture-host.cjs');
const { capturePolicy } = require('./runtime-policy.cjs');
const { addHistory } = require('./farm.cjs');
const { updateLaneTrack,newLaneTrack } = require('./lane-tracker.cjs');
const { PRODUCT, getHeroProfile, supportedProfiles } = require('./product.cjs');
const { BuildSourceManager, activeMatch } = require('./build-sources.cjs');
const { newRosterCache, updateRosterCache } = require('./roster-cache.cjs');
const { newLaneOutcomeTrack, updateLaneOutcome } = require('./lane-outcome.cjs');
const { repairLegacyPortraitCalibration } = require('./calibration-selection.js');
const { recognitionDiagnostic } = require('./recognition-diagnostics.cjs');
const {newDraftCache,updateDraftCache}=require('./draft-cache.cjs');
const {normalizeHitAreasForZoom,overlayPointerPolicy}=require('./overlay-hit-policy.cjs');
const {PICK,STRATEGY,draftPhase,newPickTrack,updatePickTrack,resolveDraft,applyDraftSettings,clearDraftOverrides}=require('./draft-state.cjs');
const {evaluateDraft}=require('./draft-coach.cjs');
const {createDraftSources}=require('./draft-sources.cjs');
const {archiveSnapshot}=require('./draft-evaluation.cjs');
const {overlayLifecycle}=require('./overlay-lifecycle.cjs');
let HERO_PROFILE = getHeroProfile(PRODUCT.defaultHeroId);

const ROOT = path.resolve(__dirname, '..');
const RUNTIME = path.join(ROOT, 'runtime');
const SETTINGS_PATH = path.join(RUNTIME, 'settings.json');
const PORT = 43829;
// Keep a concurrently running Dota match out of the automated GUI fixture.
const SMOKE_NONCE = process.argv.includes('--smoke-test') ? crypto.randomBytes(24).toString('hex') : null;
const DIAGNOSTICS_ENABLED=process.argv.includes('--recognition-diagnostics');
let recognitionReports=[],lastDiagnosticAt=0;
const DEFAULTS = { captureEnabled: true, captureScope: 'game', monitorIndex: 0, performanceMode: 'economy', minimapOnRight: false, minimapHeroSizePx: 0, playerTeam: 'radiant', plan: 'balanced', enemyHeroIds: [], alliedHeroIds: [], laneEnemyHeroIds: [], laneAllyHeroId: null, autoLane:true,autoBuildRefresh:true,stageMode:'auto',laneResult:'auto',farmTarget10:50,farmTarget20:140,farmTarget30:230, overlayVisible: true, compact: true, opacity: 0.94, demo: false, minimapRect: null, rosterRects: null, overlayPosition: null };
let settings, dataset = {}, templateBank = { portraits: [], minimap: [] }, manifest = {};
Object.assign(DEFAULTS,{draftMode:'auto',draftPositionId:1,draftRankId:'all',draftOwnTeam:'auto',draftAllyHeroIds:[],draftEnemyHeroIds:[],draftBannedHeroIds:[],draftPreferredHeroIds:[],draftAllyOverride:false,draftEnemyOverride:false,draftBanOverride:false,draftRosterRects:null});
let controlWindow, overlayWindow, draftWindow, tray, server, currentGsi = null, lastVision = null, lastPreview = null;
let captureStatus = 'Ожидаю окно Dota 2', captureError = null, sourceName = null, captureSize = null;
let busy = false, closing = false, timers = [], statusNote = null, shortcuts = {}, lastAnalysisMs = null;
let lastRealPacketAt = null, imported = false, editOverlay = false, installedPath = null;
let analysisWorker = null, analysisId = 0, analysisRequests = new Map(), captureGeneration = 0;
let captureHost=null,controlPage='home',farmHistory=[],buildData={},cachedHeroes=[],cachedDataset={},captureMetrics={},lastPublishAt=0,staticRevision=0;
let laneTrack=newLaneTrack(),sessionLane=null,previousStage=null,rosterCache=newRosterCache(),laneOutcomeTrack=newLaneOutcomeTrack(),draftCache=newDraftCache();
let buildSources=null,customBuild=null;
let draftSources=null,pickTrack=newPickTrack(),draftRankingKey=null,draftRanking=null;
let overlayHitAreas=[],overlayPointerInteractive=false,overlayPointerFocusable=false;
let draftHitAreas=[],draftPointerInteractive=false,draftPointerFocusable=false,draftSearching=false,editSurface='coach',surfacePhase=null;
let manualHidden={coach:false,draft:false};

function refreshOverlayPointer(cursor){
  const point=cursor||screen.getCursorScreenPoint();
  for(const [win,surface] of [[overlayWindow,'coach'],[draftWindow,'draft']]){
    if(!win||win.isDestroyed())continue;
    const visible=win.isVisible(),draft=surface==='draft';
    const policy=overlayPointerPolicy({cursor:point,bounds:win.getBounds(),areas:draft?draftHitAreas:overlayHitAreas,visible,editing:editOverlay&&editSurface===surface,searching:draft&&draftSearching,surface:draft?'draft':'coach'});
    const focusable=draft?draftPointerFocusable:overlayPointerFocusable,interactive=draft?draftPointerInteractive:overlayPointerInteractive;
    if(policy.focusable!==focusable)win.setFocusable(policy.focusable);
    if(policy.interactive!==interactive)win.setIgnoreMouseEvents(!policy.interactive,{forward:true});
    if(draft){draftPointerFocusable=policy.focusable;draftPointerInteractive=policy.interactive;}else{overlayPointerFocusable=policy.focusable;overlayPointerInteractive=policy.interactive;}
  }
}
function overlaySnapshot(state){
  const {hero,advice,laneRoster,laneOutcome,connection,demo,provider,activeProfile,draftRoster,settings:preferences}=state;
  const ids=new Set([...(draftRoster?.alliedHeroIds||[]),...(draftRoster?.enemyHeroIds||[]),laneRoster?.ally?.id,...(laneRoster?.enemies||[]).map(member=>member?.id),activeProfile?.heroId]);
  return{hero,advice,laneRoster,laneOutcome,connection,demo,provider,activeProfile,draftRoster,heroes:cachedHeroes.filter(entry=>ids.has(entry.id)),product:PRODUCT,supportedProfiles:supportedProfiles(),settings:{compact:preferences.compact,laneEnemyHeroIds:preferences.laneEnemyHeroIds,laneAllyHeroId:preferences.laneAllyHeroId},overlayEditing:editOverlay&&editSurface==='coach',vision:lastVision?{capturedAt:lastVision.capturedAt,quality:lastVision.quality,player:lastVision.player?{heroId:lastVision.player.heroId,confirmed:lastVision.player.confirmed,confidence:lastVision.player.confidence,team:lastVision.player.team,source:lastVision.player.source,observedAt:lastVision.player.observedAt}:null}:null};
}
function draftWindowSnapshot(state){
  return{hero:state.hero,draft:{...state.draft,active:overlayLifecycle({state:currentGsi,settings,demo:settings.demo}).activeSurface==='draft',searching:draftSearching,windowVisible:Boolean(draftWindow&&!draftWindow.isDestroyed()&&draftWindow.isVisible())},heroes:cachedHeroes,product:PRODUCT,settings:{draftPositionId:settings.draftPositionId,draftRankId:settings.draftRankId,draftOwnTeam:settings.draftOwnTeam},overlayEditing:editOverlay&&editSurface==='draft',connection:state.connection};
}
function syncOverlayLayout(){
  if(!overlayWindow||overlayWindow.isDestroyed())return;
  const bounds=overlayWindow.getBounds(),width=340,height=settings.compact?420:600;
  if(bounds.width===width&&bounds.height===height)return;
  const area=screen.getDisplayMatching(bounds).workArea;
  overlayWindow.setResizable(true);overlayWindow.setBounds({...bounds,width,height,x:Math.max(area.x,Math.min(bounds.x,area.x+area.width-width)),y:Math.max(area.y,Math.min(bounds.y,area.y+area.height-height))});overlayWindow.setResizable(false);
  overlayHitAreas=[];refreshOverlayPointer();
}
function deactivateOverlay(win,surface){
  if(!win||win.isDestroyed()||!win.isFocused())return;
  win.blur();
  // Transparent Windows widgets may retain foreground activation after blur.
  // Hide/showInactive forces deactivation without choosing another application.
  if(win.isFocused()){
    const reopen=win.isVisible()&&!closing&&settings.overlayVisible&&!manualHidden[surface]&&eligibleOverlay()?.surface===surface;
    win.hide();if(reopen)win.showInactive();
  }
}
function releaseDraftFocus(){
  draftSearching=false;refreshOverlayPointer();
  if(!(editOverlay&&editSurface==='draft'))deactivateOverlay(draftWindow,'draft');
}
function syncOverlayVisibility(){
  let lifecycle=overlayLifecycle({state:currentGsi,demo:settings.demo,settings,manualHidden});
  if(surfacePhase!==lifecycle.phase){surfacePhase=lifecycle.phase;manualHidden={coach:false,draft:false};editOverlay=false;draftSearching=false;lifecycle=overlayLifecycle({state:currentGsi,demo:settings.demo,settings,manualHidden});}
  for(const [win,show,surface] of [[overlayWindow,lifecycle.coachVisible,'coach'],[draftWindow,lifecycle.draftVisible,'draft']]){
    if(!win||win.isDestroyed())continue;
    if(show){if(!win.isVisible()&&!win.webContents.isLoading())win.showInactive();}
    else if(win.isVisible())win.hide();
    if(!show){if(surface==='draft'){draftSearching=false;draftHitAreas=[];}else overlayHitAreas=[];if(editSurface===surface)editOverlay=false;}
  }
  refreshOverlayPointer();return lifecycle;
}
function eligibleOverlay(){
  const surface=overlayLifecycle({state:currentGsi,demo:settings.demo,settings}).activeSurface;
  return surface?{surface,win:surface==='draft'?draftWindow:overlayWindow}:null;
}
function openOverlayPicker(){
  const target=eligibleOverlay();if(!target?.win||target.win.isDestroyed())return;
  const wasHidden=!target.win.isVisible();
  editOverlay=false;releaseDraftFocus();manualHidden[target.surface]=false;
  if(!settings.overlayVisible){settings.overlayVisible=true;saveSettings();}
  publish(true);target.win.webContents.send('coach:overlay-picker',{mode:wasHidden?'open':'toggle'});
}

function loadJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function saveSettings() { fs.mkdirSync(RUNTIME, { recursive: true }); fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2)); }
function customBuildPath(){return path.join(RUNTIME,HERO_PROFILE.id===42?'custom-build.json':`custom-build-${HERO_PROFILE.id}.json`);}
function activateProfile(heroId,{persist=true}={}){
  const profile=getHeroProfile(heroId);if(!profile||profile.id===HERO_PROFILE.id)return false;
  buildSources?.stop();HERO_PROFILE=profile;settings.selectedHeroId=profile.id;
  settings.enemyHeroIds=[];settings.alliedHeroIds=[];settings.laneEnemyHeroIds=[];settings.laneAllyHeroId=null;settings.laneResult='auto';settings.stageMode='auto';
  lastVision=null;farmHistory=[];laneOutcomeTrack=newLaneOutcomeTrack();laneTrack=newLaneTrack();rosterCache=newRosterCache();draftCache=newDraftCache();sessionLane=null;previousStage=null;
  captureGeneration++;captureHost?.stop();createBuildSources();loadData();
  if(persist)saveSettings();return true;
}
function localImage(relative) { const target = path.resolve(ROOT, 'data', 'assets', relative || ''); return target.startsWith(path.join(ROOT, 'data', 'assets') + path.sep) && fs.existsSync(target) ? pathToFileURL(target).href : null; }
function loadData() {
  dataset = loadJson(path.join(ROOT, 'data', HERO_PROFILE.dataFile), {});
  manifest = loadJson(path.join(ROOT, 'data', 'assets', 'manifest.json'), {});
  const imagesLoaded=templateBank.portraits.length>0&&templateBank.minimap.length>0;
  if(!imagesLoaded){
  templateBank = { portraits: [], minimap: [] };
  for (const kind of ['portraits', 'minimap']) for (const entry of manifest[kind] || []) {
    const target = path.resolve(ROOT, 'data', 'assets', entry.file);
    if (!target.startsWith(path.join(ROOT, 'data', 'assets') + path.sep)) continue;
    const img = nativeImage.createFromPath(target);
    if (!img.isEmpty()) templateBank[kind].push({ id: entry.heroId, name: entry.localizedName || entry.localized_name || entry.name, ...img.getSize(), data: img.toBitmap() });
  }
  }
  customBuild=loadJson(customBuildPath(),null);
  buildSources?.reload();
  buildData=buildSources?buildSources.select(customBuild):customBuild||loadJson(path.join(ROOT,'data',HERO_PROFILE.observedBuildFile),{});
  for(const build of buildData.builds||[])for(const step of build.sequence||[]){step.name=dataset.items?.[step.key]?.dname||step.key;step.cost=dataset.items?.[step.key]?.cost??null;}
  dataset.proTracker=buildData; dataset.freshBuild=buildData;
  cachedHeroes=Object.values(dataset.heroes||{}).map(h=>({id:Number(h.id),name:h.localized_name||h.name,roles:h.roles||[],attack_type:h.attack_type,primary_attr:h.primary_attr,image:localImage((manifest.portraits||[]).find(p=>p.heroId===Number(h.id))?.file)})).filter(h=>Number.isFinite(h.id));
  cachedDataset={heroId:dataset.heroId,fetchedAt:dataset.fetchedAt,source:dataset.source,patch:dataset.patch,itemCount:Object.keys(dataset.items||{}).length,portraits:templateBank.portraits.length,minimapTemplates:templateBank.minimap.length,warnings:dataset.warnings||[],sourceUrls:dataset.sourceUrls||[],build:buildData,customBuild:buildSources?.getState().active==='personal'};
  staticRevision++;
  if(analysisWorker&&!imagesLoaded)analysisWorker.postMessage({ kind: 'templates', templates: templateBank });
}
function updateBuildSelection(){
  if(!buildSources)return;
  buildData=buildSources.select(customBuild);
  for(const build of buildData.builds||[])for(const step of build.sequence||[]){step.name=dataset.items?.[step.key]?.dname||step.key;step.cost=dataset.items?.[step.key]?.cost??null;}
  dataset.proTracker=buildData;dataset.freshBuild=buildData;
  cachedDataset={...cachedDataset,build:buildData,customBuild:buildSources.getState().active==='personal'};staticRevision++;publish(true);
}
function createBuildSources(){
  const secretCodec={
    encode:token=>{if(!safeStorage.isEncryptionAvailable())throw new Error('Защищённое хранилище Windows недоступно.');return{version:1,storage:'electron-safe-storage',payload:safeStorage.encryptString(token).toString('base64')};},
    decode:record=>{if(record?.version!==1||record.storage!=='electron-safe-storage'||typeof record.payload!=='string'||record.payload.length>12000||!safeStorage.isEncryptionAvailable())throw new Error('Токен недоступен.');return safeStorage.decryptString(Buffer.from(record.payload,'base64'));},
  };
  buildSources=new BuildSourceManager({runtimeDir:RUNTIME,dataDir:path.join(ROOT,'data'),profile:HERO_PROFILE,secretCodec,onChange:()=>updateBuildSelection()});
}
function createPickSources(){
  draftSources=createDraftSources({runtimeDir:RUNTIME,dataDir:path.join(ROOT,'data'),getToken:()=>buildSources?.token,onSnapshot:value=>archiveSnapshot(path.join(RUNTIME,'draft-snapshots'),value),onUpdate:()=>{draftRankingKey=null;publish(true);}});
  draftSources.setContext({positionId:settings.draftPositionId,rankId:settings.draftRankId});
}
async function draftRefreshTick(){
  if(!draftSources||settings.demo||SMOKE_NONCE||activeMatch(currentGsi)||[PICK,STRATEGY].includes(currentGsi?.gameState)||!draftSources.shouldRefresh({rankId:settings.draftRankId}))return;
  await draftSources.refresh({positionId:settings.draftPositionId,rankId:settings.draftRankId});
}
function pickSnapshot(state){
  const draft=resolveDraft({state:settings.demo?null:state,settings,track:pickTrack,heroes:cachedHeroes});
  const positionId=settings.draftPositionId;
  const rankId=settings.draftRankId;
  const stats=draftSources?.getData({positionId,rankId});
  const key=JSON.stringify([positionId,rankId,draft.allyHeroIds,draft.enemyHeroIds,draft.bannedHeroIds,draft.ownHeroId,stats?.updatedAt,stats?.scope,stats?.components,staticRevision,Math.floor(Date.now()/600000)]);
  if(key!==draftRankingKey){
    const input={...draft,positionId,heroes:cachedHeroes,stats,requirePositionData:true};
    draftRanking=evaluateDraft(input);
    if(draft.ownHeroId&&cachedHeroes.some(hero=>hero.id===draft.ownHeroId))draftRanking.chosenRecommendation=evaluateDraft({...input,ownHeroId:null,allyHeroIds:draft.allyHeroIds.filter(id=>id!==draft.ownHeroId),candidateHeroIds:[draft.ownHeroId]}).candidates[0]||null;
    draftRankingKey=key;
  }
  return{...draft,...draftRanking,stats:draftSources?.getState({positionId,rankId})||{status:'waiting',message:'Статистика ещё не загружена.'}};
}
async function buildRefreshTick(){
  if(!buildSources||settings.demo||process.argv.includes('--smoke-test'))return;
  try{await buildSources.tick({state:currentGsi,enabled:settings.autoBuildRefresh,custom:buildSources.getState().active==='personal',catalog:dataset.items});}catch(error){note(error.message);}
}
function ensureWorker() {
  if (analysisWorker) return;
  analysisWorker = new Worker(path.join(__dirname, 'vision-worker.cjs'));
  const worker=analysisWorker;
  worker.on('message', message => { const pending=analysisRequests.get(message.id); if (!pending) return; clearTimeout(pending.timer); analysisRequests.delete(message.id); message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.result); });
  worker.on('error', error => failWorker(error,worker));
  worker.on('exit', () => { if(!closing&&analysisWorker===worker)failWorker(new Error('Фоновый анализатор завершился; следующий кадр перезапустит его.'),worker); });
}
function failWorker(error,worker) { if(worker!==analysisWorker)return;analysisWorker=null;for(const pending of analysisRequests.values()){clearTimeout(pending.timer);pending.reject(error);}analysisRequests.clear();worker.terminate().catch(()=>{}); }
function runAnalysis(frame, options, previous = null, kind='analyze') {
  if (!analysisWorker) { ensureWorker(); analysisWorker.postMessage({kind:'templates',templates:templateBank}); }
  return new Promise((resolve,reject) => { const id=++analysisId,worker=analysisWorker; const timer=setTimeout(()=>failWorker(new Error('Анализ кадра превысил 20 секунд; анализатор будет перезапущен.'),worker),20000); analysisRequests.set(id,{resolve,reject,timer});try{const transfers=kind==='regions'?frame.regions.map(r=>r.data instanceof ArrayBuffer?r.data:r.data.buffer):[frame.data.buffer];worker.postMessage({kind,id,frame,settings:options,previous},transfers);}catch(error){failWorker(error,worker);} });
}
function heroesList() {
  return cachedHeroes;
}
function demoGsi() {
  if(HERO_PROFILE.id!==42){
    const catalog=buildData.currentAbilityCatalog||loadJson(path.join(ROOT,'data',HERO_PROFILE.abilityCatalogFile),{});
    const learned=(catalog.abilities||[]).filter(row=>row.learnable===true&&!row.innate&&!row.abilityKey?.startsWith('special_bonus')&&row.maxRank>0&&row.minimumLevels?.[0]<=9);
    const abilities=Object.fromEntries(learned.map((row,index)=>[`ability${index}`,{id:row.abilityId,name:row.abilityKey,level:1,cooldown:0,passive:row.passive===true}]));
    const exampleItems={8:['phase_boots','maelstrom','magic_wand'],18:['power_treads','echo_sabre','magic_wand'],44:['power_treads','bfury','magic_wand'],48:['power_treads','dragon_lance','magic_wand']}[HERO_PROFILE.id]||[];
    return normalizeGsi({map:{clock_time:600,game_state:'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS',matchid:`DEMO-${HERO_PROFILE.id}`},player:{activity:'playing',team_name:settings.playerTeam,gold:1870,net_worth:4850,last_hits:43,denies:8,gpm:380,xpm:410,kills:1,deaths:2},hero:{id:HERO_PROFILE.id,name:HERO_PROFILE.gameKey,alive:true,level:9,ability_points:1,health:1680,max_health:2100,mana:305,max_mana:540},items:Object.fromEntries(exampleItems.map((key,index)=>[`slot${index}`,{name:`item_${key}`}])),abilities});
  }
  return normalizeGsi({ provider: { name: 'Dota 2' }, map: { clock_time: 600, game_state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS', matchid: 'DEMO' }, player: { activity: 'playing', team_name: settings.playerTeam, gold: 1870,net_worth:4850,last_hits:43,denies:8,gpm:380,xpm:410,kills:1,deaths:2 }, hero: { id: 42, name: 'npc_dota_hero_skeleton_king', alive: true, level: 9, ability_points:1, health: 1680, max_health: 2100, mana: 305, max_mana: 540 }, items: { slot0: { name: 'item_phase_boots' }, slot1: { name: 'item_armlet' }, slot2: { name: 'item_magic_wand' }, teleport0: { name: 'item_tpscroll' } }, abilities: { ability0: { id:5086,name: 'skeleton_king_hellfire_blast', level: 1, cooldown: 0 }, ability1:{id:5087,name:'skeleton_king_bone_guard',level:4,cooldown:0},ability2:{id:5088,name:'skeleton_king_mortal_strike',level:2,cooldown:0,passive:true},ability3: { id:5089,name: 'skeleton_king_reincarnation', level: 1, cooldown: 0 } } });
}
function demoLaneLineup(){return{enemyHeroIds:[2,101],allyHeroId:5,confidence:1,status:'confirmed',source:'demo',lastSeenAt:Date.now(),reason:'Демонстрация: герои и данные вымышлены.',members:{enemies:[{id:2,status:'confirmed',confidence:1},{id:101,status:'confirmed',confidence:1}],ally:{id:5,status:'confirmed',confidence:1}}};}
function demoLaneAssessment(state){
  const now=Date.now();let track=newLaneOutcomeTrack();
  for(const row of [{time:0,cs:0,level:1,deaths:0,kills:0},{time:180,cs:12,level:4,deaths:0,kills:0},{time:360,cs:22,level:6,deaths:1,kills:0},{time:480,cs:33,level:8,deaths:2,kills:1},{time:600,cs:43,level:9,deaths:2,kills:1}]){
    const receivedAt=now-(600-row.time)*1000;
    track=updateLaneOutcome(track,{state:{...state,gameTime:row.time,receivedAt,lastHits:row.cs,level:row.level,deaths:row.deaths,kills:row.kills},now:receivedAt,farmTargets:{cs10:settings.farmTarget10},proBuild:buildData});
  }
  return track.assessment;
}
function laneRosterFor(auto,enemyIds,allyId,lineSource,usable){
  const member=(id,side)=>{
    if(!id)return{id:null,name:side==='ally'?'Напарник пока неизвестен':'Противник пока неизвестен',image:null,status:'unknown',confidence:0};
    const known=cachedHeroes.find(hero=>hero.id===id),record=(side==='ally'?[auto?.members?.ally,...(auto?.candidates?.allies||[])]:[...(auto?.members?.enemies||[]),...(auto?.candidates?.enemies||[])]).find(hero=>hero?.id===id);
    const manual=side==='ally'?Boolean(settings.laneAllyHeroId):settings.laneEnemyHeroIds.includes(id);
    const status=manual?'confirmed':record?.status==='historical'?'retained':record?.status||auto?.status||'observing';
    return{id,name:known?.name||`Герой ${id}`,image:known?.image||null,status,confidence:manual?1:record?.confidence??auto?.confidence??0,source:manual?'manual':lineSource,visibleNow:record?.visibleNow===true,historical:record?.historical===true,lastSeenAt:record?.lastSeenAt??auto?.lastSeenAt??null};
  };
  const pending=settings.autoLane&&!imported&&!settings.demo&&!settings.laneEnemyHeroIds.length?auto?.candidates?.enemies||[]:[];
  const ids=[...enemyIds,...pending.map(hero=>hero.id).filter(id=>!enemyIds.includes(id))].slice(0,2);
  const allyCandidate=settings.autoLane&&!imported&&!settings.demo&&!settings.laneAllyHeroId&&!allyId?(auto?.candidates?.allies||[])[0]:null;
  const ally=member(allyId||allyCandidate?.id||null,'ally');if(allyCandidate){ally.status='observing';ally.confidence=allyCandidate.confidence;}
  const manualComplete=Boolean(settings.laneAllyHeroId)&&settings.laneEnemyHeroIds.length===2;
  return{ally,enemies:[member(ids[0],'enemy'),member(ids[1],'enemy')],status:manualComplete?'confirmed':usable?auto.status:ids.length||ally.id?'observing':'unknown',reason:manualComplete?'Напарник и два соперника выбраны вручную. Этот выбор имеет приоритет.':settings.demo?auto.reason:auto?.reason||'Нужны свежие наблюдения иконок героев.',historical:Boolean(usable&&auto.historical&&!manualComplete),estimatedSupport:!settings.laneAllyHeroId,source:lineSource};
}
function stateSnapshot(includeStatic=true) {
  const state = settings.demo ? demoGsi() : currentGsi;
  const screenStaleAfterMs=settings.performanceMode==='economy'?7000:5000;
  const liveVision = !settings.demo&&settings.captureEnabled && settings.performanceMode!=='gsi'&&!imported && lastVision && Date.now() - (lastVision.capturedAt || lastVision.timestamp || 0) < screenStaleAfterMs ? lastVision : null;
  const screenPlayer=liveVision?.player?.confirmed===true?liveVision.player:null;
  const ownTeam = screenPlayer?.team|| (state?.team === 'dire' || state?.team === 'radiant' ? state.team : settings.playerTeam);
  const enemyTeam = ownTeam === 'radiant' ? 'dire' : 'radiant';
  const teamCache=HERO_PROFILE.id===42?rosterCache:draftCache;
  const readIds = team => {
    const manualDraft=team===ownTeam?settings.draftAllyOverride?settings.draftAllyHeroIds:null:settings.draftEnemyOverride?settings.draftEnemyHeroIds:null;
    return manualDraft!==null?[...manualDraft]:[...new Set([...(teamCache.teams[team]||[]),...(pickTrack.teams[team]||[]),...(state?.draft?.teams?.[team]||[])])].slice(0,5);
  };
  const enemyHeroIds = settings.demo?[2,101]:settings.enemyHeroIds.length ? settings.enemyHeroIds : readIds(enemyTeam);
  const alliedHeroIds = settings.demo?[HERO_PROFILE.id,5]:settings.alliedHeroIds.length ? settings.alliedHeroIds : readIds(ownTeam);
  const manual = !settings.demo&&(settings.enemyHeroIds.length > 0||settings.draftEnemyOverride||settings.draftAllyOverride);
  const draftRoster={enemyHeroIds,alliedHeroIds,source:settings.demo?'demo':manual?'manual':'screen_roster_history'};
  if(!settings.demo&&!imported){laneTrack=updateLaneTrack(laneTrack,{state:currentGsi,vision:liveVision,screenPlayer,enemyHeroIds,alliedHeroIds,playerTeam:ownTeam,requireConfirmedRoster:true,now:Date.now()});if(['confirmed','retained'].includes(laneTrack.inferred.status))sessionLane={...laneTrack.inferred};laneOutcomeTrack=updateLaneOutcome(laneOutcomeTrack,{state:currentGsi,now:Date.now(),farmTargets:{cs10:settings.farmTarget10},proBuild:buildData});}
  const automatic=settings.demo?demoLaneLineup():laneTrack.inferred;
  const auto=!settings.demo&&automatic.source!=='screen_current'&&(state?.gameTime>=600||automatic.historical)?{...automatic,source:'screen_history'}:automatic;
  const automaticOutcome=settings.demo?demoLaneAssessment(state):laneOutcomeTrack.assessment;
  const manualEnemies=settings.laneEnemyHeroIds.length>0,manualAlly=Boolean(settings.laneAllyHeroId);
  const autoUsable=(settings.demo||!imported)&&settings.autoLane&&['confirmed','retained'].includes(auto?.status);
  const laneEnemyHeroIds=manualEnemies?settings.laneEnemyHeroIds:autoUsable?auto.enemyHeroIds:[];
  const laneAllyHeroId=manualAlly?settings.laneAllyHeroId:autoUsable?auto.allyHeroId:null;
  const autoSupplied=autoUsable&&(!manualEnemies&&auto.enemyHeroIds?.length>0||!manualAlly&&Boolean(auto.allyHeroId));
  const lineSource=manualEnemies||manualAlly?(autoSupplied?'mixed':'manual'):autoUsable?auto.source||'screen':'unknown';
  const advice = recommend(state || {}, dataset, { heroId:HERO_PROFILE.id,plan: settings.plan, enemyHeroIds, alliedHeroIds, screenPlayer,playerTeam:ownTeam,draftSource: manual ? 'manual' : 'vision', draftConfidence: manual ? 1 : enemyHeroIds.length ? 0.9 : 0, vision: settings.demo||HERO_PROFILE.id!==42 ? null : liveVision,screenStaleAfterMs, laneEnemyHeroIds,laneAllyHeroId,laneSource:lineSource,laneConfidence:manualEnemies?1:autoUsable?auto.confidence:0,laneStatus:auto?.status,laneObservedAt:autoUsable?auto.lastSeenAt:null,laneResult:settings.laneResult,laneOutcomeAssessment:automaticOutcome,farmTargets:{cs10:settings.farmTarget10,cs20:settings.farmTarget20,cs30:settings.farmTarget30},history:farmHistory,proBuild:buildData,stageOverride:settings.stageMode==='auto'?null:settings.stageMode,previousStage });
  const laneRoster=laneRosterFor(auto,laneEnemyHeroIds,laneAllyHeroId,lineSource,autoUsable),laneOutcome=advice.lane?.outcomeAssessment||automaticOutcome;
  if(!settings.demo&&state?.status==='live'&&advice.stage?.automatic)previousStage=advice.stage;
  function enrich(item) { if (!item) return item; return { ...item, image: localImage((manifest.items || []).find(i => i.key === item.key)?.file) }; }
  advice.item = enrich(advice.item); advice.alternatives = advice.alternatives.map(enrich);
  const fresh = state && Date.now() - state.receivedAt < 15000;
  const draft=pickSnapshot(state);
  return { settings: { ...settings, authToken: undefined }, provider:buildSources?.getState(),hero: state, advice,laneRoster,laneOutcome,draftRoster,draft,laneDetection:{...auto,enabled:settings.autoLane,effectiveEnemyHeroIds:laneEnemyHeroIds,effectiveAllyHeroId:laneAllyHeroId,effectiveSource:lineSource,historical:laneRoster.historical}, demo: settings.demo,activeProfile:{id:HERO_PROFILE.id,heroId:HERO_PROFILE.id,name:HERO_PROFILE.name,role:PRODUCT.role,automatic:!settings.demo&&activeMatch(currentGsi),locked:!settings.demo&&activeMatch(currentGsi)}, connection: { status: settings.demo ? 'demo' : !currentGsi ? 'waiting' : !fresh ? 'stale' : currentGsi.status, receivedAt: lastRealPacketAt, port: PORT }, vision: lastVision, capture: { status: captureStatus, error: captureError, sourceName, size: captureSize, ...(controlPage==='vision'||imported?{preview:lastPreview}:{}), analysisMs: lastAnalysisMs, imported,metrics:captureMetrics }, ...(includeStatic?{dataset:cachedDataset,heroes:heroesList(),shortcuts,product:PRODUCT,supportedProfiles:supportedProfiles()}:{}),staticRevision, note: statusNote, installedPath, overlayEditing: editOverlay };
}
function publish(force=false) {
  if(!settings||(!force&&Date.now()-lastPublishAt<950))return;lastPublishAt=Date.now();
  const state=stateSnapshot(false);
  syncOverlayLayout();syncOverlayVisibility();
  if(DIAGNOSTICS_ENABLED&&Date.now()-lastDiagnosticAt>=5000){
    lastDiagnosticAt=Date.now();recognitionReports.push(currentRecognitionDiagnostic());recognitionReports=recognitionReports.slice(-24);
    try{fs.writeFileSync(path.join(RUNTIME,'recognition-diagnostics.json'),JSON.stringify({reports:recognitionReports},null,2));}catch{}
  }
  if(controlWindow&&!controlWindow.isDestroyed()&&controlWindow.isVisible()&&!controlWindow.isMinimized()&&!controlWindow.webContents.isLoading())controlWindow.webContents.send('coach:state',state);
  if(overlayWindow&&!overlayWindow.isDestroyed()&&overlayWindow.isVisible()&&!overlayWindow.webContents.isLoading())overlayWindow.webContents.send('coach:state',overlaySnapshot(state));
  if(draftWindow&&!draftWindow.isDestroyed()&&!draftWindow.webContents.isLoading())draftWindow.webContents.send('coach:state',draftWindowSnapshot(state));
}
function currentRecognitionDiagnostic(){return recognitionDiagnostic({version:PRODUCT.version,state:currentGsi,vision:lastVision,settings,cache:rosterCache,track:laneTrack,captureConfig:captureHost?.config,captureStatus,captureError,imported,busy});}
function note(message) { statusNote = message; publish(); }

function createWindows() {
  const productIcon=nativeImage.createFromPath(path.join(ROOT,'data','assets','core-coach.png'));
  controlWindow = new BrowserWindow({ width: 1130, height: 835, minWidth: 940, minHeight: 690, backgroundColor: '#0e111b', title: PRODUCT.name+' — настройка',icon:productIcon,autoHideMenuBar: true, show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  controlWindow.loadFile(path.join(__dirname, 'index.html'));
  controlWindow.once('ready-to-show', () => { if(!DIAGNOSTICS_ENABLED){controlWindow.restore();controlWindow.show();}publish(true); });
  controlWindow.on('show',()=>{if(!controlWindow.webContents.isLoading())controlWindow.webContents.send('coach:state',stateSnapshot());});
  controlWindow.on('restore',()=>{if(!controlWindow.webContents.isLoading())controlWindow.webContents.send('coach:state',stateSnapshot());});
  controlWindow.on('close', event => { if (!closing) { event.preventDefault(); controlWindow.hide(); note('Окно настроек скрыто. Открыть: Ctrl+Alt+W. Выход: Ctrl+Alt+Q.'); } });
  const display = screen.getPrimaryDisplay().workArea;
  const savedPos = settings.overlayPosition || { x: display.x + display.width - 365, y: display.y + 145 },height=settings.compact?420:600;
  const area=screen.getDisplayNearestPoint(savedPos).workArea,pos={x:Math.max(area.x,Math.min(savedPos.x,area.x+area.width-340)),y:Math.max(area.y,Math.min(savedPos.y,area.y+area.height-height))};
  overlayWindow = new BrowserWindow({ width: 340,height,x: pos.x, y: pos.y, frame: false, transparent: true, resizable: false, alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false, show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver'); overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  // Prevent our own card from becoming a template candidate in monitor captures.
  overlayWindow.setContentProtection(true); overlayWindow.setOpacity(settings.opacity);
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWindow.once('ready-to-show', () => {publish(true);});
  overlayWindow.on('hide',()=>{overlayHitAreas=[];refreshOverlayPointer();});
  overlayWindow.on('resize',()=>{overlayHitAreas=[];refreshOverlayPointer();});
  overlayWindow.on('moved', () => { settings.overlayPosition = overlayWindow.getPosition().reduce((o,v,i) => ({ ...o, [i ? 'y' : 'x']: v }), {}); saveSettings(); });
  const draftDisplay=screen.getAllDisplays()[settings.monitorIndex]?.workArea||display;
  const draftSaved=settings.draftOverlayPosition||{x:draftDisplay.x+(draftDisplay.width-860)/2,y:draftDisplay.y+draftDisplay.height-568};
  const draftArea=screen.getDisplayNearestPoint(draftSaved).workArea,draftWidth=Math.min(860,draftArea.width-24),draftHeight=Math.min(520,draftArea.height-24);
  draftWindow=new BrowserWindow({width:draftWidth,height:draftHeight,x:Math.round(Math.max(draftArea.x,Math.min(draftSaved.x,draftArea.x+draftArea.width-draftWidth))),y:Math.round(Math.max(draftArea.y,Math.min(draftSaved.y,draftArea.y+draftArea.height-draftHeight))),title:'Core Coach — выбор героя',frame:false,transparent:true,resizable:false,alwaysOnTop:true,skipTaskbar:true,focusable:false,hasShadow:false,show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  draftWindow.setAlwaysOnTop(true,'screen-saver');draftWindow.setIgnoreMouseEvents(true,{forward:true});draftWindow.setContentProtection(true);draftWindow.setOpacity(settings.opacity);
  draftWindow.loadFile(path.join(__dirname,'draft-window.html'));draftWindow.once('ready-to-show',()=>publish(true));
  draftWindow.on('hide',()=>{draftSearching=false;draftHitAreas=[];if(editSurface==='draft')editOverlay=false;refreshOverlayPointer();});
  draftWindow.on('resize',()=>{draftHitAreas=[];refreshOverlayPointer();});
  draftWindow.on('moved',()=>{const[x,y]=draftWindow.getPosition();settings.draftOverlayPosition={x,y};saveSettings();});
  draftWindow.on('close',event=>{if(!closing){event.preventDefault();manualHidden.draft=true;releaseDraftFocus();publish(true);}});
  for (const win of [controlWindow, overlayWindow,draftWindow]) {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
  }
  const icon=productIcon;
  try { tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon); tray.setToolTip(PRODUCT.name); tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Открыть настройки', click: () => controlWindow.show() }, { label: 'Показать / скрыть оверлей', click: toggleOverlay }, { type: 'separator' }, { label: 'Выход', click: quit }])); tray.on('double-click', () => controlWindow.show()); } catch { /* keyboard shortcuts remain available */ }
}
function toggleOverlay() {
  const target=eligibleOverlay();if(!target){note('Оверлеи появятся автоматически на своей стадии матча.');return;}
  if(!settings.overlayVisible){settings.overlayVisible=true;manualHidden[target.surface]=false;saveSettings();}else manualHidden[target.surface]=!manualHidden[target.surface];
  editOverlay=false;releaseDraftFocus();publish(true);void captureTick();
}
function showControl(){controlWindow.restore();controlWindow.show();controlWindow.focus();}
function toggleEdit() {
  const target=eligibleOverlay();if(!target){note('Перемещение доступно, когда игровой оверлей виден.');return;}
  releaseDraftFocus();editOverlay=editSurface===target.surface?!editOverlay:true;editSurface=target.surface;
  settings.overlayVisible=true;manualHidden[target.surface]=false;saveSettings();publish(true);
  if(editOverlay){target.win.show();refreshOverlayPointer();}
  else deactivateOverlay(target.win,target.surface);
}
function quit() { closing = true; app.quit(); }
function registerShortcuts() {
  const bindings = { 'Ctrl+Alt+W': showControl, 'Ctrl+Alt+O': toggleOverlay, 'Ctrl+Alt+M': toggleEdit, 'Ctrl+Alt+L': openOverlayPicker,'Ctrl+Alt+C': () => updateSettings({ compact: !settings.compact }), 'Ctrl+Alt+Q': quit };
  for (const [key, handler] of Object.entries(bindings)) shortcuts[key] = globalShortcut.register(key, handler);
}
function createGsiServer() {
  server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/health') { res.end(JSON.stringify({ ok: true, app: PRODUCT.name,version:PRODUCT.version,role:PRODUCT.role })); return; }
    if(req.method==='GET'&&req.url==='/diagnostics'&&DIAGNOSTICS_ENABLED){if(req.headers['x-core-coach-diagnostics']!==settings.authToken){res.writeHead(403);res.end('{"error":"unauthorized"}');return;}res.end(JSON.stringify({latest:currentRecognitionDiagnostic(),reports:recognitionReports}));return;}
    if (req.method !== 'POST' || req.url !== '/gsi') { res.writeHead(404); res.end('{"error":"not found"}'); return; }
    if (SMOKE_NONCE && req.headers['x-core-coach-fixture'] !== SMOKE_NONCE) { req.resume();res.writeHead(503);res.end('{"error":"automated check in progress"}');return; }
    let chunks = [], size = 0, oversized = false;
    req.on('data', chunk => { size += chunk.length; if (size > 262144) { oversized = true; chunks = []; } else if (!oversized) chunks.push(chunk); });
    req.on('end', () => {
      if (oversized) { res.writeHead(413); res.end('{"error":"payload too large"}'); return; }
      try {
        const packet = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!packet || typeof packet !== 'object' || Array.isArray(packet)) throw new Error('Expected object');
        if (packet.auth?.token !== settings.authToken) { res.writeHead(403); res.end('{"error":"invalid token"}'); return; }
        const nextState = normalizeGsi(packet, currentGsi);
        const fromPick=[PICK,STRATEGY].includes(currentGsi?.gameState);
        const enteringPick=[PICK,STRATEGY].includes(nextState.gameState)&&(![PICK,STRATEGY].includes(currentGsi?.gameState)||nextState.matchId&&currentGsi?.matchId&&nextState.matchId!==currentGsi.matchId);
        if(enteringPick){manualHidden={coach:false,draft:false};editOverlay=false;releaseDraftFocus();clearDraftOverrides(settings);settings.draftMode='auto';settings.draftOwnTeam='auto';statusNote='Помощь в пике: выбери героя под свою позицию и известный состав.';pickTrack=newPickTrack();lastVision=null;captureGeneration++;captureHost?.stop();saveSettings();}
        if(fromPick&&![PICK,STRATEGY].includes(nextState.gameState)){lastVision=null;captureGeneration++;captureHost?.stop();}
        if(nextState.isSupportedCarry===true&&nextState.status==='live'&&!nextState.isSpectator&&activeMatch(nextState))activateProfile(nextState.heroId);
        if(activeMatch(nextState)){buildSources?.deferForMatch();draftSources?.deferForMatch();settings.draftMode='auto';}
        const clockRestart=currentGsi?.gameTime>=0&&Number.isFinite(nextState.gameTime)&&nextState.gameTime<120&&currentGsi.gameTime-nextState.gameTime>5;
        const newMatch = clockRestart || nextState.matchId && ((currentGsi?.matchId && currentGsi.matchId !== nextState.matchId) || (settings.draftMatchId && settings.draftMatchId !== nextState.matchId));
        if(newMatch){manualHidden={coach:false,draft:false};editOverlay=false;releaseDraftFocus();}
        if(newMatch&&!fromPick&&!enteringPick){clearDraftOverrides(settings);pickTrack=newPickTrack();}
        if (newMatch) { settings.enemyHeroIds = []; settings.alliedHeroIds = []; settings.laneEnemyHeroIds=[];settings.laneAllyHeroId=null;settings.laneResult='auto';settings.stageMode='auto';laneTrack=newLaneTrack();rosterCache=newRosterCache();draftCache=newDraftCache();laneOutcomeTrack=newLaneOutcomeTrack();sessionLane=null;previousStage=null;farmHistory=[];lastVision = null;captureHost?.stop(); captureGeneration++; settings.draftMatchId = nextState.matchId; saveSettings(); }
        else if (nextState.matchId && !settings.draftMatchId && (settings.enemyHeroIds.length||settings.alliedHeroIds.length||settings.laneEnemyHeroIds.length||settings.laneAllyHeroId)) { settings.draftMatchId = nextState.matchId; saveSettings(); }
        currentGsi = nextState; lastRealPacketAt = Date.now();
        pickTrack=updatePickTrack(pickTrack,{state:nextState});
        farmHistory=addHistory(farmHistory,currentGsi);laneOutcomeTrack=updateLaneOutcome(laneOutcomeTrack,{state:currentGsi,now:Date.now(),farmTargets:{cs10:settings.farmTarget10},proBuild:buildData});
        // A real game packet always exits demo; real and simulated states are never mixed.
        if (settings.demo) { settings.demo = false; saveSettings(); }
        res.end('{"ok":true}'); publish();void captureTick();
      } catch { res.writeHead(400); res.end('{"error":"invalid JSON"}'); }
    });
  });
  server.on('error', error => note(`GSI недоступен: ${error.message}. Закрой второй экземпляр приложения или освободите порт ${PORT}.`));
  server.listen(PORT, '127.0.0.1');
}
function gsiConfig() {
  return `"${PRODUCT.name}"\n{\n  "uri" "http://127.0.0.1:${PORT}/gsi"\n  "timeout" "5.0"\n  "buffer" "0.1"\n  "throttle" "0.5"\n  "heartbeat" "5.0"\n  "data"\n  {\n    "provider" "1"\n    "map" "1"\n    "player" "1"\n    "hero" "1"\n    "abilities" "1"\n    "items" "1"\n    "draft" "1"\n    "events" "1"\n  }\n  "auth"\n  {\n    "token" "${settings.authToken}"\n  }\n}\n`;
}
function possibleDotaPaths() {
  const bases = ['E:\\SteamLibrary', 'D:\\SteamLibrary', 'C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam'];
  for (const base of [...bases]) {
    const vdf = path.join(base, 'steamapps', 'libraryfolders.vdf');
    try { for (const match of fs.readFileSync(vdf, 'utf8').matchAll(/"path"\s*"([^"\r\n]+)"/g)) bases.push(match[1].replace(/\\\\/g, '\\')); } catch {}
  }
  return [...new Set(bases)].map(base => path.join(base, 'steamapps', 'common', 'dota 2 beta')).filter(base => ['game/dota/cfg','game/dota/pak01_dir.vpk','game/bin/win64/dota2.exe'].every(relative => fs.existsSync(path.join(base,...relative.split('/')))));
}
async function installGsi() {
  let base = possibleDotaPaths()[0];
  if (!base) { const choice = await dialog.showOpenDialog(controlWindow, { title: 'Выбери папку dota 2 beta', properties: ['openDirectory'] }); if (choice.canceled) return { cancelled: true }; base = choice.filePaths[0]; }
  const cfg = path.join(base, 'game', 'dota', 'cfg');
  if (!fs.existsSync(cfg) || !fs.statSync(cfg).isDirectory()) throw new Error('В выбранной папке нет game/dota/cfg. Выбери корневую папку dota 2 beta.');
  const dir = path.join(cfg, 'gamestate_integration'); fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'gamestate_integration_wraith_coach.cfg');
  if (fs.existsSync(target)) fs.copyFileSync(target, target + '.backup-' + Date.now());
  fs.writeFileSync(target, gsiConfig()); installedPath = target;
  note('GSI установлен. Добавь -gamestateintegration в параметры запуска Dota 2 и перезапусти игру.'); return { path: target };
}
function updateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const oldScope=settings.captureScope, oldMapSide=settings.minimapOnRight;
  const oldCompact=settings.compact,oldOpacity=settings.opacity,oldVisible=settings.overlayVisible;
  const oldDraftRank=settings.draftRankId,oldDraftPosition=settings.draftPositionId;
  for (const key of ['captureEnabled', 'minimapOnRight', 'overlayVisible', 'compact', 'demo','autoLane','autoBuildRefresh']) if (typeof input[key] === 'boolean') settings[key] = input[key];
  if(Number.isInteger(input.selectedHeroId)&&getHeroProfile(input.selectedHeroId)&&(!activeMatch(currentGsi)||settings.demo)){
    activateProfile(input.selectedHeroId);settings.selectedHeroId=input.selectedHeroId;if(!settings.demo)currentGsi=null;
  }
  if (['game', 'monitor'].includes(input.captureScope)) settings.captureScope = input.captureScope;
  if (['radiant', 'dire'].includes(input.playerTeam)) settings.playerTeam = input.playerTeam;
  applyDraftSettings(settings,input,cachedHeroes.map(hero=>hero.id),PRODUCT.supportedHeroIds);
  if(oldDraftRank!==settings.draftRankId||oldDraftPosition!==settings.draftPositionId){
    const draftRefreshAlreadyRunning=draftSources?.getState()?.refreshing===true;
    draftSources?.setContext({positionId:settings.draftPositionId,rankId:settings.draftRankId,
      requestRefresh:oldDraftRank!==settings.draftRankId&&!SMOKE_NONCE&&!settings.demo&&!activeMatch(currentGsi)&&(![PICK,STRATEGY].includes(currentGsi?.gameState)||draftRefreshAlreadyRunning)});
  }
  if(activeMatch(currentGsi)&&!settings.demo)settings.draftMode='auto';
  if (['farm', 'fight', 'balanced'].includes(input.plan)) settings.plan = input.plan;
  if (['economy','balanced','gsi'].includes(input.performanceMode)) settings.performanceMode=input.performanceMode;
  if (['auto','unknown','won','lost','even'].includes(input.laneResult)) settings.laneResult=input.laneResult;
  if(['auto','pregame','laning','transition','midgame','lategame'].includes(input.stageMode))settings.stageMode=input.stageMode;
  for(const [key,min,max] of [['farmTarget10',10,150],['farmTarget20',30,350],['farmTarget30',60,600]])if(Number.isFinite(input[key]))settings[key]=Math.round(Math.max(min,Math.min(max,input[key])));
  if(Array.isArray(input.laneEnemyHeroIds))settings.laneEnemyHeroIds=[...new Set(input.laneEnemyHeroIds.filter(id=>Number.isInteger(id)&&id!==HERO_PROFILE.id&&dataset.heroes?.[id]))].slice(0,2);
  if(Object.hasOwn(input,'laneAllyHeroId'))settings.laneAllyHeroId=input.laneAllyHeroId===null?null:Number.isInteger(input.laneAllyHeroId)&&input.laneAllyHeroId!==HERO_PROFILE.id&&dataset.heroes?.[input.laneAllyHeroId]?input.laneAllyHeroId:settings.laneAllyHeroId;
  if(Object.hasOwn(input,'laneEnemyHeroIds')||Object.hasOwn(input,'laneAllyHeroId'))settings.draftMatchId=currentGsi?.matchId||null;
  if (Number.isInteger(input.monitorIndex)) settings.monitorIndex = Math.max(0, Math.min(10, input.monitorIndex));
  if (Number.isFinite(input.minimapHeroSizePx)) settings.minimapHeroSizePx = input.minimapHeroSizePx === 0 ? 0 : Math.max(10,Math.min(48,input.minimapHeroSizePx));
  if (Number.isFinite(input.opacity)) settings.opacity = Math.max(0.55, Math.min(1, input.opacity));
  for (const key of ['enemyHeroIds', 'alliedHeroIds']) if (Array.isArray(input[key])) { settings[key] = [...new Set(input[key].filter(x => Number.isInteger(x) && x > 0 && dataset.heroes?.[x]))].slice(0, 5); settings.draftMatchId = currentGsi?.matchId || null; }
  if (oldMapSide !== settings.minimapOnRight) settings.minimapRect = null;
  if (input.captureEnabled === false || settings.captureScope !== oldScope || Object.hasOwn(input,'performanceMode') || Object.hasOwn(input, 'minimapRect') || Object.hasOwn(input, 'rosterRects') || Object.hasOwn(input, 'draftRosterRects') || Object.hasOwn(input, 'minimapOnRight') || Object.hasOwn(input,'minimapHeroSizePx') || Object.hasOwn(input,'demo')) { lastVision = null; captureGeneration++; }
  if (Object.hasOwn(input, 'minimapRect')) { const r = input.minimapRect; if (r === null) settings.minimapRect = null; else if (['x','y','width','height'].every(k => Number.isFinite(r?.[k])) && r.x >= 0 && r.y >= 0 && r.width > 0.03 && r.height > 0.03 && r.x + r.width <= 1 && r.y + r.height <= 1) settings.minimapRect = r; }
  for (const key of ['rosterRects','draftRosterRects']) if (Object.hasOwn(input, key)) {
    const rects = input[key];
    if (rects === null) settings[key] = null;
    else if (Array.isArray(rects) && rects.length === 10 && rects.every(r => ['x','y','width','height'].every(k => Number.isFinite(r?.[k])) && r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0 && r.x + r.width <= 1.001 && r.y + r.height <= 1.001)) settings[key] = rects.map((r,i) => ({ ...r, team: i < 5 ? 'radiant' : 'dire' }));
  }
  if(Object.hasOwn(input,'draftRosterRects')){pickTrack=newPickTrack();draftRankingKey=null;}
  if (['minimapRect','rosterRects','minimapOnRight','minimapHeroSizePx'].some(key=>Object.hasOwn(input,key))) {
    rosterCache=newRosterCache();laneTrack=newLaneTrack();sessionLane=null;
  }
  if (input.demo === false) { imported = false; lastVision = null; }
  if(oldOpacity!==settings.opacity)for(const win of[overlayWindow,draftWindow])if(win&&!win.isDestroyed())win.setOpacity(settings.opacity);
  saveSettings();void captureTick(); publish(true); return stateSnapshot();
}
async function captureTick() {
  if(!captureHost||SMOKE_NONCE)return;
  const policy=capturePolicy(settings,currentGsi,{calibrating:controlPage==='vision'&&controlWindow?.isVisible(),visible:settings.overlayVisible&&(overlayWindow?.isVisible()||draftWindow?.isVisible()),imported});
  if(!policy.enabled){captureStatus=policy.reason;if(!imported)lastVision=null;}
  const displays=screen.getAllDisplays();
  // Keep reading portraits each frame until independent observations confirm
  // team identities; slowing after one match delays the confirming frame.
  const confirmedRosterIds=new Set([...(rosterCache.teams.radiant||[]),...(rosterCache.teams.dire||[])]);
  const drafting=['DOTA_GAMERULES_STATE_HERO_SELECTION','DOTA_GAMERULES_STATE_STRATEGY_TIME'].includes(currentGsi?.gameState)&&Number.isFinite(currentGsi.receivedAt)&&Date.now()-currentGsi.receivedAt<15000;
  const screenMode=settings.autoLane===true&&settings.captureScope==='game';
  const personalWk=currentGsi?.heroId===42&&currentGsi?.isWraithKing===true&&!currentGsi.isSpectator&&currentGsi.status!=='spectator'&&['radiant','dire'].includes(currentGsi.team)&&Number.isFinite(currentGsi.receivedAt)&&Date.now()-currentGsi.receivedAt<=12000&&currentGsi.receivedAt-Date.now()<=1000;
  const sceneEnabled=!drafting&&(screenMode?lastVision?.player?.confirmed===true||lastVision?.player?.heroId===42&&personalWk:currentGsi?.isWraithKing===true&&!currentGsi.isSpectator&&!currentGsi.isPaused&&Number.isFinite(currentGsi.gameTime)&&currentGsi.gameTime>=0&&currentGsi.gameTime<600&&Date.now()-currentGsi.receivedAt<15000&&laneTrack.inferred.complete!==true);
  try{await captureHost.update({enabled:policy.enabled,capturePhase:drafting?'draft':'game',sourceMode:settings.captureScope==='game'?'dota':'monitor',monitorId:String(displays[settings.monitorIndex]?.id||screen.getPrimaryDisplay().id),intervalMs:policy.intervalMs,rosterConfirmed:!drafting&&confirmedRosterIds.size>=(screenMode?10:8),calibration:{...settings,selfHeroId:42,playerTeam:lastVision?.player?.team||currentGsi?.team||settings.playerTeam,sceneEnabled}});
    if(policy.enabled&&controlPage==='vision'&&controlWindow?.isVisible())captureHost.requestPreview();
  }catch(error){captureError=error.message;captureStatus='Ошибка захвата';}
}
function createCaptureHost(){
  captureHost=new ScreenCaptureHost({electron,onFrame:async packet=>{
    if(busy||settings.demo||imported)return;busy=true;const generation=captureGeneration,started=performance.now();
    if(DIAGNOSTICS_ENABLED){
      // Opt-in debugging retains only already-bounded public HUD/icon crops.
      // Never retain the full scene, hero names or the captured window image.
      try{const target=path.join(RUNTIME,'recognition-roi');fs.mkdirSync(target,{recursive:true});
        for(const region of packet.regions){if(!['selected_hero_label','roster','scene'].includes(region.kind))continue;const pixels=region.data instanceof ArrayBuffer?Buffer.from(region.data):Buffer.from(region.data.buffer,region.data.byteOffset,region.data.byteLength);fs.writeFileSync(path.join(target,`${region.kind}-${region.index??0}.png`),nativeImage.createFromBitmap(pixels,{width:region.width,height:region.height}).toPNG());}
        fs.writeFileSync(path.join(target,'metadata.json'),JSON.stringify({timestamp:packet.timestamp,originalSize:packet.originalSize,regions:packet.regions.filter(region=>region.kind!=='minimap').map(({kind,index,rect,anchor,healthColor})=>({kind,index,rect,anchor,healthColor}))},null,2));
      }catch{}
    }
    try{const own=currentGsi?.team||settings.playerTeam,enemy=own==='dire'?'radiant':'dire',gsiPlayer=currentGsi?{heroId:currentGsi.heroId,isWraithKing:currentGsi.isWraithKing,isSpectator:currentGsi.isSpectator,status:currentGsi.status,team:currentGsi.team,receivedAt:currentGsi.receivedAt}:null;const analyzed=await runAnalysis(packet,{...settings,gsiPlayer,playerTeam:own,selfHeroId:42,allyHeroIds:settings.alliedHeroIds.length?settings.alliedHeroIds:rosterCache.teams[own]||[],enemyHeroIds:settings.enemyHeroIds.length?settings.enemyHeroIds:rosterCache.teams[enemy]||[]},lastVision?.state,'regions');if(generation!==captureGeneration||imported||settings.demo)return;lastVision=analyzed;lastVision.capturedAt=packet.timestamp;rosterCache=updateRosterCache(rosterCache,{state:currentGsi,vision:lastVision,now:Date.now()});captureSize=packet.originalSize;lastAnalysisMs=Math.round(performance.now()-started);captureStatus=analyzed.quality?.usable?'Анализ HUD активен':'Проверь калибровку HUD';captureError=null;}catch(error){captureError=error.message;lastVision=null;}finally{busy=false;publish();}
    if(HERO_PROFILE.id!==42&&lastVision){draftCache=updateDraftCache(draftCache,{state:currentGsi,vision:lastVision,now:Date.now()});publish(true);}
    if(lastVision&&[PICK,STRATEGY].includes(currentGsi?.gameState)){pickTrack=updatePickTrack(pickTrack,{state:currentGsi,vision:lastVision});publish(true);}
  },onStatus:status=>{captureMetrics=status;sourceName=status.sourceName;if(status.state==='capture-error'){captureError=status.reason;captureStatus='Ошибка захвата';}else if(status.state==='waiting-source')captureStatus=settings.captureScope==='game'?'Ожидаю окно Dota 2':'Монитор недоступен';},onPreview:preview=>{if(controlPage==='vision'&&controlWindow?.isVisible()){lastPreview=preview.dataUrl;captureSize=preview.originalSize||captureSize||{width:preview.width,height:preview.height};publish();}}});
}
async function importScreenshot() {
  const choice = await dialog.showOpenDialog(controlWindow, { title: 'Скриншот Dota 2 для проверки распознавания', filters: [{ name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'webp'] }], properties: ['openFile'] });
  if (choice.canceled) return { cancelled: true };
  const img = nativeImage.createFromPath(choice.filePaths[0]); if (img.isEmpty()) throw new Error('Изображение не удалось открыть.');
  const size = img.getSize(); if (size.width > 8000 || size.height > 8000) throw new Error('Выбери изображение до 8000 × 8000 пикселей.');
  imported=true;captureGeneration++;captureHost?.stop();
  const capturePhase=[PICK,STRATEGY].includes(currentGsi?.gameState)?'draft':'game';
  lastVision = await runAnalysis({ ...size, data: img.toBitmap() }, { ...settings, capturePhase, selfHeroId: 42 });
  lastVision.capturedAt = Date.now(); lastPreview = img.resize({ width: 850 }).toDataURL(); captureSize = size; captureStatus = 'Проверка по скриншоту'; sourceName = path.basename(choice.filePaths[0]); imported = true; publish(); return { ok: true };
}
function trustedEvent(event) { return [controlWindow, overlayWindow,draftWindow].some(win => win && !win.isDestroyed()&&win.webContents === event.sender) && event.senderFrame?.url.startsWith(pathToFileURL(__dirname + path.sep).href); }
function trustedControlEvent(event){return controlWindow&&!controlWindow.isDestroyed()&&event.sender===controlWindow.webContents&&event.senderFrame?.url===pathToFileURL(path.join(__dirname,'index.html')).href;}
function trustedOverlayEvent(event){return overlayWindow&&!overlayWindow.isDestroyed()&&event.sender===overlayWindow.webContents&&event.senderFrame?.url===pathToFileURL(path.join(__dirname,'overlay.html')).href;}
function trustedDraftEvent(event){return draftWindow&&!draftWindow.isDestroyed()&&event.sender===draftWindow.webContents&&event.senderFrame?.url===pathToFileURL(path.join(__dirname,'draft-window.html')).href;}
ipcMain.on('coach:overlay-hit-areas',(event,value)=>{
  const isDraft=trustedDraftEvent(event);if((!isDraft&&!trustedOverlayEvent(event))||closing)return;
  const win=isDraft?draftWindow:overlayWindow,bounds=win.getBounds(),zoom=win.webContents.getZoomFactor()||1;
  const areas=normalizeHitAreasForZoom(value,bounds,zoom,{surface:isDraft?'draft':'coach'});
  if(isDraft)draftHitAreas=areas;else overlayHitAreas=areas;refreshOverlayPointer();
});
ipcMain.on('coach:overlay-pointer',event=>{if((trustedOverlayEvent(event)||trustedDraftEvent(event))&&!closing)refreshOverlayPointer();});
ipcMain.handle('coach:state', event => {if(!trustedEvent(event))return null;const state=stateSnapshot();return trustedDraftEvent(event)?draftWindowSnapshot(state):trustedOverlayEvent(event)?overlaySnapshot(state):state;});
ipcMain.handle('coach:settings', (event, value) => {
  if(!trustedEvent(event))return;
  if(trustedDraftEvent(event)){
    if(eligibleOverlay()?.surface!=='draft')return{error:'Выбор героев завершён. Изменения состава доступны в основном окне.'};
    const keys=['draftAllyHeroIds','draftEnemyHeroIds','draftBannedHeroIds','draftOwnTeam','draftPositionId','draftRankId'];
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))return{error:'Недопустимая настройка пикера.'};
  }
  if(trustedOverlayEvent(event)&&value&&typeof value==='object'){
    const state=stateSnapshot(false),allies=new Set([...(state.draftRoster?.alliedHeroIds||[]),settings.laneAllyHeroId]),enemies=new Set([...(state.draftRoster?.enemyHeroIds||[]),...settings.laneEnemyHeroIds]);
    if(value.laneAllyHeroId!=null&&!allies.has(value.laneAllyHeroId)||Array.isArray(value.laneEnemyHeroIds)&&value.laneEnemyHeroIds.some(id=>!enemies.has(id)))return{error:'Состав команды изменился. Выбери героя из текущих портретов.'};
  }
  return updateSettings(value);
});
ipcMain.handle('coach:command', async (event, { name, value } = {}) => {
  if (!trustedEvent(event)) return null;
  try {
    if(trustedDraftEvent(event)&&!['draft-search-focus','hide-draft-overlay','draft-reset','toggle-edit','show-settings'].includes(name))return{error:'Эта команда недоступна в пикере.'};
    if(name==='draft-search-focus'){
      if(!trustedDraftEvent(event)||typeof value!=='boolean')return{error:'Ввод доступен в окне пикера.'};
      if(!value){releaseDraftFocus();return{ok:true};}
      if(eligibleOverlay()?.surface!=='draft'||!draftWindow.isVisible()||manualHidden.draft||editOverlay)return{error:'Поиск доступен во время выбора героев.'};
      draftSearching=true;refreshOverlayPointer();if(!draftPointerFocusable){draftSearching=false;refreshOverlayPointer();return{error:'Открой каталог героев перед поиском.'};}
      draftWindow.focus();return{ok:true};
    }
    if(name==='hide-draft-overlay'){
      if(!trustedDraftEvent(event))return{error:'Команда доступна в пикере.'};manualHidden.draft=true;releaseDraftFocus();publish(true);void captureTick();return{ok:true};
    }
    if (name === 'install-gsi') return await installGsi();
    if (name === 'export-gsi') { const file = path.join(RUNTIME, 'gamestate_integration_wraith_coach.cfg'); fs.writeFileSync(file, gsiConfig()); note(`Конфиг сохранён: ${file}`); return { path: file }; }
    if (name === 'reload-data') { loadData(); note('Локальный датасет перечитан.'); return { ok: true }; }
    if (name === 'set-page') { controlPage=['home','builds','vision','draft','settings'].includes(value)?value:'home';if(controlPage!=='vision'&&!imported)lastPreview=null;void captureTick();return{ok:true}; }
    if(name==='draft-refresh'){
      if(activeMatch(currentGsi))return{error:'Обнови статистику пика после матча. Сохранённая выборка доступна.'};
      void draftSources.refresh({force:true,positionId:settings.draftPositionId,rankId:settings.draftRankId}).catch(()=>{});return{ok:true};
    }
    if(name==='draft-reset'){if(trustedDraftEvent(event)&&eligibleOverlay()?.surface!=='draft')return{error:'Выбор героев уже завершён.'};clearDraftOverrides(settings);saveSettings();publish(true);return{ok:true};}
    if(name==='draft-finish-preview'){settings.draftMode='auto';saveSettings();publish(true);return{ok:true};}
    if (name === 'open-protracker') { await shell.openExternal('https://dota2protracker.com/builds/wraith-king-pos1-1');return{ok:true}; }
    if(name==='open-stratz'){await shell.openExternal('https://stratz.com/api');return{ok:true};}
    if(name==='set-stratz-token'){if(activeMatch(currentGsi))throw new Error('Настрой источник вне активного матча.');buildSources.setToken(value);void draftSources?.refresh({force:true,rankId:settings.draftRankId}).catch(()=>{});note('Токен STRATZ сохранён в защищённом хранилище.');void buildSources.refresh({state:currentGsi,catalog:dataset.items,manual:false}).then(()=>note(buildSources.getState().message)).catch(error=>note(error.message));return{ok:true};}
    if(name==='clear-stratz-token'){buildSources.clearToken();note('Токен STRATZ удалён. Сохранённые сборки доступны.');return{ok:true};}
    if(name==='test-stratz')return await buildSources.test(currentGsi);
    if(name==='reset-auto-lane'){laneTrack=newLaneTrack();sessionLane=null;note('Автоопределение линии начато заново.');return{ok:true};}
    if(name==='resume-auto-roster'){settings.enemyHeroIds=[];settings.alliedHeroIds=[];settings.laneEnemyHeroIds=[];settings.laneAllyHeroId=null;settings.autoLane=true;saveSettings();note('Состав определяется по наблюдениям экрана.');return{ok:true};}
    if(name==='resume-auto-lineup'){settings.laneEnemyHeroIds=[];settings.laneAllyHeroId=null;settings.autoLane=true;saveSettings();note('Ручной выбор участников снят. Состав команд сохранён.');return{ok:true};}
    if(name==='import-build'){
      if(currentGsi?.status==='live'&&Date.now()-currentGsi.receivedAt<15000)throw new Error('Меняй источник сборки вне активного матча.');
      const choice=await dialog.showOpenDialog(controlWindow,{title:'Личная сборка или разрешённый экспорт',filters:[{name:'Сборка JSON',extensions:['json']}],properties:['openFile']});if(choice.canceled)return{cancelled:true};
      const {importBuildFile}=require('./build-import.cjs');await importBuildFile(choice.filePaths[0],customBuildPath(),dataset.items,{profile:HERO_PROFILE,heroId:HERO_PROFILE.id});loadData();note('Сборка и порядок навыков импортированы.');return{ok:true};
    }
    if(name==='use-observed-build'){const customFile=customBuildPath();if(fs.existsSync(customFile))fs.renameSync(customFile,customFile+'.backup-'+Date.now());loadData();note('Выбран доступный кеш carry-матчей: STRATZ имеет приоритет.');return{ok:true};}
    if (name === 'refresh-build') { const result=await buildSources.refresh({state:currentGsi,catalog:dataset.items,manual:true});note(buildSources.getState().message+(cachedDataset.customBuild?' Личная сборка остаётся выбранной.':''));return result; }
    if (name === 'show-settings') { showControl(); return { ok: true }; }
    if (name === 'open-overlay-picker') {openOverlayPicker();return{ok:true};}
    if (name === 'toggle-overlay') { toggleOverlay(); return { ok: true }; }
    if (name === 'toggle-edit') { toggleEdit(); return { ok: true }; }
    if (name === 'import-screenshot') return await importScreenshot();
    if (name === 'resume-capture') { imported = false; lastVision = null; await captureTick(); return { ok: true }; }
    if (name === 'reset-calibration') { updateSettings({minimapRect:null,rosterRects:null,draftRosterRects:null}); note('Калибровка сброшена.'); return { ok: true }; }
    if (name === 'quit') { quit(); return { ok: true }; }
    return { error: 'Неизвестная команда' };
  } catch (error) { note(error.message); return { error: error.message }; }
});
app.setName(PRODUCT.name);
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
else {
  app.on('second-instance', () => { if (controlWindow)showControl(); });
  app.whenReady().then(() => {
    settings = { ...DEFAULTS, ...loadJson(SETTINGS_PATH, {}) }; settings.demo = false;
    settings.selectedHeroId=getHeroProfile(settings.selectedHeroId)?.id||PRODUCT.defaultHeroId;HERO_PROFILE=getHeroProfile(settings.selectedHeroId);
    if(repairLegacyPortraitCalibration(settings))statusNote='Области верхних портретов обновлены для HUD Dota 2. Миникарта и остальные настройки сохранены.';
    if(settings.laneAutomationVersion!==2){settings.laneResult='auto';settings.laneEnemyHeroIds=[];settings.laneAllyHeroId=null;settings.enemyHeroIds=[];settings.alliedHeroIds=[];settings.autoLane=true;settings.laneAutomationVersion=2;}
    if (typeof settings.authToken !== 'string' || settings.authToken.length < 20) settings.authToken = crypto.randomBytes(24).toString('hex');
    settings.performanceMode=['economy','balanced','gsi'].includes(settings.performanceMode)?settings.performanceMode:'economy';
    settings.draftMode='auto';clearDraftOverrides(settings);
    settings.draftPreferredHeroIds=(Array.isArray(settings.draftPreferredHeroIds)?settings.draftPreferredHeroIds:[]).filter(id=>getHeroProfile(id));
    settings.draftOwnTeam=['auto','radiant','dire'].includes(settings.draftOwnTeam)?settings.draftOwnTeam:'auto';
    settings.draftPositionId=Number.isInteger(settings.draftPositionId)&&settings.draftPositionId>=1&&settings.draftPositionId<=5?settings.draftPositionId:1;
    if(!['all','UNCALIBRATED','HERALD_GUARDIAN','CRUSADER_ARCHON','LEGEND_ANCIENT','DIVINE_IMMORTAL'].includes(settings.draftRankId))settings.draftRankId='all';
    saveSettings();createBuildSources();loadData();createPickSources();createWindows();registerShortcuts();createGsiServer();createCaptureHost();
    timers.push(setInterval(()=>publish(),1000));timers.push(setInterval(captureTick,3000));timers.push(setInterval(buildRefreshTick,60000));timers.push(setTimeout(buildRefreshTick,12000));
    timers.push(setInterval(()=>void draftRefreshTick().catch(()=>{}),60000));timers.push(setTimeout(()=>void draftRefreshTick().catch(()=>{}),18000));
    if(!SMOKE_NONCE)timers.push(setInterval(()=>refreshOverlayPointer(),100));
    captureTick();
    if (SMOKE_NONCE) setTimeout(async () => {
      const originalSettings=JSON.parse(JSON.stringify(settings));
      try{
        const send=packet=>new Promise((resolve,reject)=>{
          const request=http.request({hostname:'127.0.0.1',port:PORT,path:'/gsi',method:'POST',headers:{'Content-Type':'application/json','x-core-coach-fixture':SMOKE_NONCE}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});
          request.on('error',reject);request.end(JSON.stringify({...packet,auth:{token:settings.authToken}}));
        });
        await require('../scripts/smoke-overlays.cjs').runSmoke({
          root:ROOT,version:PRODUCT.version,windows:()=>({control:controlWindow,coach:overlayWindow,draft:draftWindow}),
          state:()=>stateSnapshot(),setGsi:value=>{currentGsi=value;},updateSettings,publish,send,profiles:supportedProfiles,
          shortcuts:()=>shortcuts,internal:()=>({manualHidden,editOverlay,editSurface,draftSearching,draftHitAreas,overlayHitAreas}),
          actions:{toggle:toggleOverlay,edit:toggleEdit,picker:openOverlayPicker},
          capturePolicy:()=>capturePolicy(settings,currentGsi,{visible:settings.overlayVisible&&(overlayWindow.isVisible()||draftWindow.isVisible()),imported})
        });
      }finally{settings=originalSettings;settings.demo=false;saveSettings();quit();}
    }, 3500);
  });
  app.on('before-quit', () => { closing = true;timers.forEach(clearInterval);buildSources?.stop();draftSources?.stop();globalShortcut.unregisterAll();if(server)server.close();captureHost?.destroy();if(analysisWorker)analysisWorker.terminate(); });
  app.on('window-all-closed', () => { if (closing) app.quit(); });
}
