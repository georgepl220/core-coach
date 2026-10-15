'use strict';
// Offline regression using only top hero cards from the authorized screenshot.
// Player names, chat, account data and the rest of the game are not retained.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {app,nativeImage,BrowserWindow}=require('electron');
const {draftCalibration,defaultCalibration}=require('../src/hud-calibration.js');
const {resolveRect,analyzeScreen}=require('../src/vision.cjs');
const {analyzeRegions}=require('../src/vision-regions.cjs');
const root=path.resolve(__dirname,'..'),expected=[3,36,6,49,26,30,31,43,29,8];
app.whenReady().then(async()=>{
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'data/assets/manifest.json'),'utf8'));
  const templates={portraits:manifest.portraits.map(entry=>{const image=nativeImage.createFromPath(path.join(root,'data/assets',entry.file));return{id:entry.heroId,name:entry.localizedName,...image.getSize(),data:image.toBitmap()};}),minimap:[]};
  assert.equal(templates.portraits.length,127);
  const strip=nativeImage.createFromPath(path.join(__dirname,'fixtures/draft-hud-strip.png'));
  assert.equal(strip.isEmpty(),false);
  assert.equal(strip.getSize().height,74);
  const width=1920,height=1080,pixels=Buffer.alloc(width*height*4,18);for(let i=3;i<pixels.length;i+=4)pixels[i]=255;
  const bytes=strip.toBitmap(),size=strip.getSize();for(let y=0;y<size.height;y++)bytes.copy(pixels,(y*width+195)*4,y*size.width*4,(y+1)*size.width*4);
  const native=nativeImage.createFromBitmap(pixels,{width,height});
  const direct=analyzeScreen({width,height,data:pixels},{capturePhase:'draft',portraitThreshold:.99,portraitMargin:.3,rosterRects:[{x:-10,y:-10,width:4,height:4,units:'px'}]},templates);
  assert.deepEqual(direct.roster.slots.map(slot=>slot.hero?.id),expected,'full screenshot imports automatically use draft cards and ignore game calibration');
  const window=new BrowserWindow({show:false,webPreferences:{nodeIntegration:true,contextIsolation:false,sandbox:false}});
  await window.loadURL('about:blank');
  function makePacket(image,definitions){
    const size=image.getSize();return{capturePhase:'draft',timestamp:100000,originalSize:size,regions:definitions.map((definition,index)=>{
      const rect=resolveRect(definition,size.width,size.height),factor=Math.min(1,64/rect.width,48/rect.height);
      const crop=image.crop(rect).resize({width:Math.round(rect.width*factor),height:Math.round(rect.height*factor),quality:'best'});
      return{kind:'roster',index,team:definition.team,rect,...crop.getSize(),data:crop.toBitmap()};
    })};
  }
  const packets=[];
  for(const [rendering,image]of[['native',native],['area-downsample',native.resize({width:1280,height:720,quality:'best'})]])packets.push([rendering,makePacket(image,draftCalibration(image.getSize().width,image.getSize().height).rosterRects)]);
  // Render the complete downsample and each ROI through Chromium's canvas,
  // matching the real capture renderer rather than only nativeImage resizing.
  const definitions=draftCalibration(1280,720).rosterRects;
  const captured=await window.webContents.executeJavaScript(`(async()=>{
    const image=new Image();image.src=${JSON.stringify(native.toDataURL())};await image.decode();
    const source=document.createElement('canvas');source.width=1280;source.height=720;source.getContext('2d',{alpha:false}).drawImage(image,0,0,1280,720);
    return ${JSON.stringify(definitions)}.map((definition,index)=>{
      const rect={x:Math.round(definition.x*1280),y:Math.round(definition.y*720),width:Math.round(definition.width*1280),height:Math.round(definition.height*720)};
      const factor=Math.min(1,64/rect.width,48/rect.height),canvas=document.createElement('canvas');canvas.width=Math.round(rect.width*factor);canvas.height=Math.round(rect.height*factor);
      const context=canvas.getContext('2d',{alpha:false});context.drawImage(source,rect.x,rect.y,rect.width,rect.height,0,0,canvas.width,canvas.height);
      const data=context.getImageData(0,0,canvas.width,canvas.height).data;for(let p=0;p<data.length;p+=4){const r=data[p];data[p]=data[p+2];data[p+2]=r;}
      return {kind:'roster',index,team:definition.team,rect,width:canvas.width,height:canvas.height,data:Buffer.from(data).toString('base64')};
    });
  })()`);
  window.destroy();
  packets.push(['chromium-canvas',{capturePhase:'draft',timestamp:100000,originalSize:{width:1280,height:720},regions:captured.map(region=>({...region,data:Buffer.from(region.data,'base64')}))}]);
  const report=[];
  for(const [rendering,packet]of packets){
    const elapsed=[],settings={portraitThreshold:.96,portraitMargin:.08};let result;
    for(let repeat=0;repeat<3;repeat++){
      const start=performance.now();result=analyzeRegions({...packet,timestamp:100000+repeat*3000},settings,templates,result?.state);elapsed.push(Math.round((performance.now()-start)*10)/10);
      assert.deepEqual(result.roster.slots.map(slot=>slot.hero?.id),expected,rendering);
      assert.ok(result.roster.slots.every(slot=>slot.hero.confidence>=.96&&slot.hero.margin>=.08),rendering);
      assert.equal(result.minimap.heroes.length,0);assert.equal(result.player.confirmed,false);assert.equal(result.scene.heroes.length,0);
      assert.ok(result.diagnostics.roiBytes<=120000);
    }
    const blank={...packet,timestamp:110000,regions:packet.regions.map(region=>({...region,data:Buffer.alloc(region.width*region.height*4,40)}))};
    const empty=analyzeRegions(blank,settings,templates,result.state);assert.ok(empty.roster.slots.every(slot=>!slot.hero&&!slot.fromCache),'blank/unpicked cards cannot retain old identities');
    report.push({rendering,size:packet.originalSize,ids:expected,similarities:result.roster.slots.map(slot=>Math.round(slot.hero.confidence*1000)/1000),margins:result.roster.slots.map(slot=>Math.round(slot.hero.margin*1000)/1000),elapsedMs:elapsed,roiBytes:result.diagnostics.roiBytes});
  }
  const wrong=makePacket(native,defaultCalibration(width,height).rosterRects);const wrongResult=analyzeRegions(wrong,{portraitThreshold:.96,portraitMargin:.08},templates);
  assert.ok(wrongResult.roster.slots.filter(slot=>slot.hero).length<10,'in-game rectangles cannot correctly determine this draft');
  fs.writeFileSync(path.join(root,'artifacts/real-draft-fixtures-results.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:true,report},null,2));app.exit(0);
}).catch(error=>{console.error(error.stack);app.exit(1);});
