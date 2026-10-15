'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {BuildSourceManager,activeMatch,REFRESH_INTERVAL_MS,RETRY_INTERVAL_MS}=require('../src/build-sources.cjs');
const START=Date.parse('2026-10-12T12:00:00Z');
const TOKEN='test-only-secret-token-not-a-real-key';
// Mock codec exercises backend persistence, not the actual Windows cipher.
const codec={encode:token=>({mock:true,payload:Buffer.from(token).toString('base64')}),decode:record=>Buffer.from(record.payload,'base64').toString()};
function build(provider='opendota',extra={}){return{heroId:42,role:'carry',status:'available',providerId:provider,source:provider==='stratz'?'STRATZ curated guides':'OpenDota recent carry',fetchedAt:new Date(START).toISOString(),builds:[{id:provider,sequence:[{key:'phase_boots'}],skills:[]}],...extra};}
function fixture(t,options={}){
  const parent=path.resolve(os.tmpdir()),root=fs.mkdtempSync(path.join(parent,'core-coach-sources-'));
  const runtime=path.join(root,'runtime'),data=path.join(root,'data');fs.mkdirSync(runtime);fs.mkdirSync(data);
  fs.writeFileSync(path.join(data,'d2pt-wraith-king.json'),JSON.stringify(build()));
  t.after(()=>{assert.ok(path.resolve(root).startsWith(parent+path.sep)&&path.basename(root).startsWith('core-coach-sources-'));fs.rmSync(root,{recursive:true,force:true});});
  const calls={stratz:0,fallback:0,test:0};
  const manager=new BuildSourceManager({runtimeDir:runtime,dataDir:data,secretCodec:codec,now:()=>START,
    refreshStratz:async()=>{calls.stratz++;return build('stratz',{validation:{schemaVerified:true}});},
    refreshFallback:async()=>{calls.fallback++;return build();},testConnection:async()=>{calls.test++;return{connected:true,schemaVerified:true};},...options});
  return{manager,runtime,data,calls};
}
test('no credentials selects truthful OpenDota fallback and makes no automatic requests',async t=>{
  const{manager,calls}=fixture(t);assert.equal(manager.select().source,'OpenDota recent carry');
  assert.equal(manager.getState().preferred,'stratz');assert.equal(manager.getState().active,'opendota');assert.equal(manager.getState().tokenConfigured,false);
  await manager.tick();assert.deepEqual(calls,{stratz:0,fallback:0,test:0});assert.equal(manager.getState().nextRefreshAt,null);
});
test('valid STRATZ cache wins over fallback and personal import has explicit priority',t=>{
  const{manager,runtime}=fixture(t);fs.writeFileSync(manager.stratzPath,JSON.stringify(build('stratz')));manager.reload();
  assert.equal(manager.select().providerId,'stratz');assert.equal(manager.getState().active,'stratz');
  const personal=build('personal');assert.equal(manager.select(personal),personal);assert.equal(manager.getState().active,'personal');
  assert.equal(manager.select(build('personal',{heroId:1})).providerId,'stratz');
  fs.writeFileSync(path.join(runtime,'opendota-wraith-king.json'),'{bad');manager.reload();assert.equal(manager.fallback.providerId,'opendota');
  fs.writeFileSync(path.join(runtime,'opendota-wraith-king.json'),'{}');manager.reload();assert.equal(manager.fallback.providerId,'opendota');
});
test('credential file is separate, state never contains token, valid replacement persists',t=>{
  const{manager,runtime,data}=fixture(t);manager.setToken('Bearer '+TOKEN);
  assert.equal(manager.getState().tokenConfigured,true);assert.ok(!JSON.stringify(manager.getState()).includes(TOKEN));
  assert.ok(!fs.readFileSync(manager.credentialsPath,'utf8').includes(TOKEN));
  const restored=new BuildSourceManager({runtimeDir:runtime,dataDir:data,secretCodec:codec,now:()=>START});assert.equal(restored.getState().tokenConfigured,true);
  assert.throws(()=>manager.setToken('invalid\nheader'),/API-токен/);assert.equal(manager.getState().tokenConfigured,true);
  manager.clearToken();assert.equal(fs.existsSync(manager.credentialsPath),false);assert.equal(manager.getState().tokenConfigured,false);
});
test('automatic refresh uses STRATZ, records verified schema and respects six-hour cache interval',async t=>{
  let now=START;const{manager,calls}=fixture(t,{now:()=>now});manager.setToken(TOKEN);
  assert.equal((await manager.tick()).provider,'stratz');assert.equal(manager.select().providerId,'stratz');assert.equal(manager.getState().schemaVerified,true);
  assert.equal(Date.parse(manager.getState().nextRefreshAt),START+REFRESH_INTERVAL_MS);await manager.tick();assert.equal(calls.stratz,1);assert.equal(calls.fallback,0);
  now+=REFRESH_INTERVAL_MS;await manager.tick();assert.equal(calls.stratz,2);
});
test('active playing sessions block every refresh including another hero and a paused game',async t=>{
  const{manager,calls}=fixture(t);manager.setToken(TOKEN);
  const state={receivedAt:START,gameState:'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS',status:'wrong_hero',isPaused:true};
  assert.equal(activeMatch(state,START),true);await manager.tick({state});await assert.rejects(manager.refresh({state}),/вне активного/);await assert.rejects(manager.test(state),/вне активного/);
  assert.deepEqual(calls,{stratz:0,fallback:0,test:0});assert.equal(activeMatch({...state,receivedAt:START-16000},START),false);
});
test('automatic failure keeps cache, sanitizes token and backs off without extra fallback traffic',async t=>{
  const{manager,calls}=fixture(t,{refreshStratz:async()=>{throw new Error('Denied Bearer '+TOKEN);}});manager.setToken(TOKEN);
  assert.equal((await manager.tick()).ok,false);assert.equal(manager.select().providerId,'opendota');assert.equal(calls.fallback,0);
  assert.equal(Date.parse(manager.getState().nextRefreshAt),START+RETRY_INTERVAL_MS);assert.ok(!JSON.stringify(manager.getState()).includes(TOKEN));
});
test('manual fallback updates backup without displacing good STRATZ cache after primary failure',async t=>{
  const{manager,calls}=fixture(t,{refreshStratz:async()=>{throw new Error('No sample');}});fs.writeFileSync(manager.stratzPath,JSON.stringify(build('stratz')));manager.reload();manager.setToken(TOKEN);
  const result=await manager.refresh();assert.equal(result.fallback,true);assert.equal(calls.fallback,1);assert.equal(manager.select().providerId,'stratz');assert.equal(manager.getState().status,'fallback');
});
test('manual fallback failure preserves prior selection and bounded error',async t=>{
  const{manager}=fixture(t,{refreshFallback:async()=>{throw new Error('Network unavailable');}});const before=manager.select();
  const result=await manager.refresh();assert.equal(result.ok,false);assert.equal(manager.select(),before);assert.match(manager.getState().message,/Кеш сохранён/);
});
test('match arrival cancels an in-flight refresh and prevents its result replacing cache',async t=>{
  let resolve;const{manager}=fixture(t,{refreshStratz:()=>new Promise(r=>{resolve=r;})});manager.setToken(TOKEN);const pending=manager.refresh({manual:false});
  assert.equal(manager.getState().refreshing,true);manager.deferForMatch();resolve(build('stratz'));
  assert.equal((await pending).cancelled,true);assert.equal(manager.select().providerId,'opendota');assert.equal(manager.getState().status,'paused_match');
});
test('concurrent refresh requests share one job and clearing token cancels late response',async t=>{
  let resolve,calls=0;const{manager}=fixture(t,{refreshStratz:()=>{calls++;return new Promise(r=>{resolve=r;});}});manager.setToken(TOKEN);
  const first=manager.refresh({manual:false}),second=manager.refresh({manual:false});assert.equal(calls,1);manager.clearToken();resolve(build('stratz'));
  assert.equal((await first).cancelled,true);assert.equal((await second).cancelled,true);assert.equal(manager.getState().tokenConfigured,false);
});
test('connection check requires credentials and emits no raw account or token data',async t=>{
  const{manager,calls}=fixture(t);await assert.rejects(manager.test(),/API-токен/);manager.setToken(TOKEN);
  assert.deepEqual(await manager.test(),{ok:true,schemaVerified:true});assert.equal(calls.test,1);assert.equal(manager.getState().status,'connected');
});

test('each carry manager forwards its profile and keeps other hero caches isolated',async t=>{
  const{getHeroProfile}=require('../src/product.cjs');
  const observed=[];
  const{manager,runtime,data}=fixture(t,{profile:getHeroProfile(8),
    refreshStratz:async input=>{observed.push({provider:'stratz',input});return build('stratz',{heroId:8});},
    refreshFallback:async input=>{observed.push({provider:'opendota',input});return build('opendota',{heroId:8});}});
  fs.writeFileSync(path.join(data,'opendota-juggernaut.json'),JSON.stringify(build('opendota',{heroId:8})));
  manager.reload();
  assert.equal(manager.select().heroId,8);
  assert.equal(manager.getState().heroId,8);
  const wkBefore=fs.readFileSync(path.join(data,'d2pt-wraith-king.json'),'utf8');
  await manager.refresh();
  assert.equal(observed[0].input.heroId,8);assert.equal(observed[0].input.profile,getHeroProfile(8));
  assert.equal(path.basename(observed[0].input.destination),'opendota-juggernaut.json');
  manager.setToken(TOKEN);await manager.refresh();
  assert.equal(observed[1].provider,'stratz');assert.equal(observed[1].input.heroId,8);assert.equal(observed[1].input.profile,getHeroProfile(8));
  assert.equal(path.basename(observed[1].input.destination),'stratz-juggernaut.json');
  assert.equal(manager.select().heroId,8);
  assert.equal(fs.readFileSync(path.join(data,'d2pt-wraith-king.json'),'utf8'),wkBefore);
  fs.writeFileSync(manager.stratzPath,JSON.stringify(build('stratz',{heroId:42})));manager.reload();
  assert.equal(manager.select().heroId,8);assert.equal(manager.select(build('personal',{heroId:42})).heroId,8);
  const sven=new BuildSourceManager({runtimeDir:runtime,dataDir:data,profile:getHeroProfile(18),secretCodec:codec,now:()=>START});
  assert.equal(sven.getState().tokenConfigured,true);assert.equal(sven.select().heroId,undefined);
  assert.notEqual(sven.stratzPath,manager.stratzPath);assert.notEqual(sven.fallbackPath,manager.fallbackPath);
});
