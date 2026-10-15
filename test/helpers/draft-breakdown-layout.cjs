'use strict';
function fixture(){
  const {pathToFileURL}=require('node:url'),path=require('node:path');
  const entries=[[112,'Winter Wyvern','winter_wyvern'],[83,'Treant Protector','treant'],[101,'Skywrath Mage','skywrath_mage'],[90,'Keeper of the Light','keeper_of_the_light'],[68,'Ancient Apparition','ancient_apparition'],[97,'Magnus','magnataur'],[39,'Queen of Pain','queenofpain'],[54,'Lifestealer','life_stealer'],[52,'Leshrac','leshrac'],[6,'Drow Ranger','drow_ranger'],[1,'Anti-Mage','antimage'],[95,'Troll Warlord','troll_warlord'],[42,'Wraith King','skeleton_king']];
  const heroes=entries.map(([id,name,key])=>({id,name,image:pathToFileURL(path.resolve(__dirname,'../../data/assets/portraits',key+'.png')).href}));
  const candidates=entries.slice(0,5).map(([heroId,name],index)=>{
    const negative=index===1||index===4,mixed=index===3,empty=index===2;
    const evidence=empty?[]:[{heroId:52,name:'Leshrac',side:'enemy',games:1200,wins:650,advantagePp:negative?-4.2:2.8,contribution:negative?-.8:.7,displayRelevant:true},{heroId:6,name:'Drow Ranger',side:'enemy',games:1800,wins:900,advantagePp:negative||mixed?-2.7:1.8,contribution:negative||mixed?-.7:.5,displayRelevant:true},{heroId:97,name:'Magnus',side:'ally',games:1400,wins:750,advantagePp:1.8,contribution:.3,displayRelevant:true},{heroId:39,name:'Queen of Pain',side:'ally',games:1100,wins:550,advantagePp:-.01,contribution:-.001,displayRelevant:false}];
    return{heroId,name,score:56-index,positionId:4,roleFiltered:true,baselineWinRate:[.542,.527,.498,.534,.512][index],baselineGames:12000-index*500,confidence:'low',reasons:['STRATZ: подробная техническая причина.'],risks:['STRATZ: дополнительные ограничения выборки.'],scoreBreakdown:{initial:50,baseline:2.2,enemies:empty?0:negative?-1.5:mixed?0:1.2,allies:empty?0:.3,total:56-index},matchupEvidence:evidence,dataCoverage:{baseline:{available:true,used:true,games:12000},enemies:{known:5,used:empty?0:2,missing:empty?5:3},allies:{known:3,used:empty?0:2,missing:empty?3:1}},dataFreshness:{baseline:{observedThrough:'2026-10-10T00:00:00Z',scope:{patch:'7.41f',rank:'HERALD_GUARDIAN',role:'POSITION_4'}},pairs:{observedThrough:null,roleFiltered:false,scope:{patch:'7.41f',rank:'HERALD_GUARDIAN',role:null}}},comparison:{closeScore:true,nearestGap:.1,threshold:.5}};
  });
  return{heroes,settings:{draftPositionId:4,draftRankId:'HERALD_GUARDIAN'},draft:{phase:'pick',active:true,windowVisible:true,positionId:4,ownTeam:'radiant',allyHeroIds:[97,39,54],enemyHeroIds:[52,6,1,95,42],recommendations:candidates,candidates,confidence:'low',sourceLabel:'STRATZ',stats:{providerId:'stratz',observedThrough:'2026-10-10T00:00:00Z',updatedAt:'2026-10-14T12:00:00Z'}}};
}
if(process.type==='renderer'){
  const{contextBridge}=require('electron');
  contextBridge.exposeInMainWorld('coach',{getState:async()=>fixture(),onState(){},onOverlayPicker(){},setOverlayHitAreas(){},notifyOverlayPointer(){},command:async()=>({ok:true})});
}else{
  const fs=require('node:fs'),path=require('node:path'),{app,BrowserWindow}=require('electron');
  app.disableHardwareAcceleration();
  app.whenReady().then(async()=>{
    const win=new BrowserWindow({width:860,height:520,frame:false,show:false,webPreferences:{preload:__filename,sandbox:false}});
    await win.loadFile(path.resolve(__dirname,'../../src/draft-window.html'));
    await win.webContents.executeJavaScript(`Promise.all([...document.images].map(image=>image.decode().catch(()=>{})))`);
    const probe=()=>win.webContents.executeJavaScript(`(()=>{const footer=document.querySelector('footer').getBoundingClientRect();return{bodyOverflow:document.body.scrollHeight>innerHeight,cards:[...document.querySelectorAll('.draft-recommendation')].map(el=>{const rect=el.getBoundingClientRect(),children=[...el.querySelectorAll('*')].map(child=>({className:child.className,bottom:child.getBoundingClientRect().bottom,top:child.getBoundingClientRect().top,height:child.getBoundingClientRect().height}));return{hero:el.querySelector('strong').textContent,height:rect.height,bottom:rect.bottom,clientHeight:el.clientHeight,scrollHeight:el.scrollHeight,childrenFit:children.every(child=>child.bottom<=rect.bottom+1&&child.top>=rect.top-1),aboveFooter:rect.bottom<footer.top,whyFont:Number.parseFloat(getComputedStyle(el.querySelector('.draft-why')).fontSize),riskFont:Number.parseFloat(getComputedStyle(el.querySelector('.draft-risk')).fontSize),label:el.querySelector('.draft-fit').textContent,children};}),visibleProviderNames:/STRATZ|OpenDota/.test(document.body.innerText),scoreVisible:/\\/\\s*100/.test(document.body.innerText),hitAreas:window.draftWindowUI.hitAreas()};})()`);
    const artifacts=path.resolve(__dirname,'../../artifacts');fs.mkdirSync(artifacts,{recursive:true});
    const normal=await probe();
    fs.writeFileSync(path.join(artifacts,'draft-five-rows-520.png'),(await win.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(artifacts,'draft-data-coverage-layout.png'),(await win.webContents.capturePage()).toPNG());
    win.setSize(860,450);await new Promise(resolve=>setTimeout(resolve,70));
    const short=await probe();
    fs.writeFileSync(path.join(artifacts,'draft-five-rows-450.png'),(await win.webContents.capturePage()).toPNG());
    const noSide=fixture();noSide.draft.ownTeam=null;await win.webContents.executeJavaScript(`window.draftWindowUI.render(${JSON.stringify(noSide)})`);const compactSide=await probe();
    const editing=fixture();editing.overlayEditing=true;await win.webContents.executeJavaScript(`window.draftWindowUI.render(${JSON.stringify(editing)})`);const compactEditing=await probe();
    const fits=result=>!result.bodyOverflow&&!result.visibleProviderNames&&!result.scoreVisible&&result.cards.length===5&&result.cards.every(card=>card.childrenFit&&card.aboveFooter&&card.scrollHeight<=card.clientHeight+1&&card.whyFont>=11.5&&card.riskFont>=10.5);
    const report={normal,short,compactSide,compactEditing,ok:[normal,short,compactSide,compactEditing].every(fits)};
    fs.writeFileSync(path.join(artifacts,'draft-breakdown-layout.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({ok:report.ok,normal:normal.cards.map(card=>({hero:card.hero,height:card.height,childrenFit:card.childrenFit,overflow:card.scrollHeight-card.clientHeight})),short:short.cards.map(card=>({hero:card.hero,height:card.height,childrenFit:card.childrenFit,overflow:card.scrollHeight-card.clientHeight}))}));
    app.exit(report.ok?0:1);
  }).catch(error=>{console.error(error.message);app.exit(1);});
}
