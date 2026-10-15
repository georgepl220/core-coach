'use strict';
// Real screen regression keeps only public in-game HUD/map crops. Synthetic
// timestamps replay one still image; they do not claim repeated live sightings.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { app, nativeImage, BrowserWindow } = require('electron');
const { defaultCalibration, resolveRect } = require('../src/vision.cjs');
const { analyzeRegions } = require('../src/vision-regions.cjs');
const ROOT = path.resolve(__dirname, '..');
const expectedDraft = [42,36,6,37,26,43,2,22,18,20];
app.setName('Core Coach Real Minimap Test');
app.whenReady().then(async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT,'data/assets/manifest.json')));
  const bank = {};
  for (const kind of ['portraits','minimap']) bank[kind] = manifest[kind].map(entry => {
    const image = nativeImage.createFromPath(path.join(ROOT,'data/assets',entry.file));
    return { id:entry.heroId, name:entry.localizedName, ...image.getSize(), data:image.toBitmap() };
  });
  const width = 1919, height = 1079, data = Buffer.alloc(width * height * 4,18);
  for (let offset = 3; offset < data.length; offset += 4) data[offset] = 255;
  for (const crop of [{file:'lane-hud-strip.png',x:518,y:0},{file:'lane-minimap.png',x:8,y:843}]) {
    const image = nativeImage.createFromPath(path.join(__dirname,'fixtures',crop.file));
    assert.ok(!image.isEmpty(),crop.file);
    const pixels = image.toBitmap(), size = image.getSize();
    for (let row = 0; row < size.height; row++) pixels.copy(data,((crop.y+row)*width+crop.x)*4,row*size.width*4,(row+1)*size.width*4);
  }
  const native = nativeImage.createFromBitmap(data,{width,height});
  const browser = new BrowserWindow({show:false,webPreferences:{nodeIntegration:true,contextIsolation:false,sandbox:false}});
  await browser.loadURL('about:blank');
  const bytes = await browser.webContents.executeJavaScript(`(async()=>{
    const image=new Image();image.src=${JSON.stringify(native.toDataURL())};await image.decode();
    const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;
    const ctx=canvas.getContext('2d',{alpha:false});ctx.drawImage(image,0,0,1280,720);
    return Buffer.from(ctx.getImageData(0,0,1280,720).data).toString('base64');
  })()`);
  browser.destroy();
  const rgba = Buffer.from(bytes,'base64');
  for (let offset = 0; offset < rgba.length; offset += 4) { const red=rgba[offset];rgba[offset]=rgba[offset+2];rgba[offset+2]=red; }
  const chromium = nativeImage.createFromBitmap(rgba,{width:1280,height:720});
  const report = [];
  for (const [rendering,image] of [['native',native],['area-downsample',native.resize({width:1280,height:720,quality:'best'})],['chromium-canvas',chromium]]) {
    const size=image.getSize(),defaults=defaultCalibration(size.width,size.height);
    // Saved rectangle came from the calibration UI; it differs slightly from
    // defaults, exercising coarse-grid phase and translation invariance.
    for (const [geometry,map] of [['default',defaults.minimapRect],['saved',{x:0.003537735849056604,y:0.7735849056603774,width:0.1214622641509434,height:0.2264150943396226}]]) {
      const packet={timestamp:100000,originalSize:size,regions:[]};
      for (const [kind,definitions] of [['minimap',[map]],['roster',defaults.rosterRects]]) definitions.forEach((definition,index)=>{
        const rect=resolveRect(definition,size.width,size.height);
        const factor=kind==='minimap'?Math.min(1,352/rect.width,352/rect.height):Math.min(1,64/rect.width,48/rect.height);
        const crop=image.crop(rect).resize({width:Math.round(rect.width*factor),height:Math.round(rect.height*factor),quality:'best'});
        packet.regions.push({kind,rect,index,team:definition.team,...crop.getSize(),data:crop.toBitmap()});
      });
      const times=[];let result;
      for (let attempt=0;attempt<3;attempt++) {
        const start=performance.now();result=analyzeRegions(packet,{selfHeroId:42,playerTeam:'radiant'},bank);times.push(Math.round(performance.now()-start));
        assert.deepEqual(result.roster.slots.map(s=>s.hero?.id),expectedDraft);
        const ids=result.minimap.heroes.map(h=>h.id);
        assert.ok(ids.includes(20)&&ids.includes(37)&&ids.includes(43),`${rendering}/${geometry}: ${ids}`);
        assert.ok(ids.every(id=>expectedDraft.includes(id)),`${rendering}/${geometry} invented identity`);
        // WK/Lion/Axe icons are obscured in this minimap still. Recognizing a
        // global draft must never turn them into positioned lane observations.
        assert.ok(!ids.some(id=>[42,26,2].includes(id)),`${rendering}/${geometry} guessed an occluded icon`);
        assert.ok(result.minimap.heroes.every(h=>h.confidence>=0.88));
      }
      const retained=analyzeRegions({...packet,timestamp:110000,regions:packet.regions.filter(r=>r.kind==='minimap')},{selfHeroId:42,playerTeam:'radiant'},bank,result.state);
      assert.equal(retained.diagnostics.templateCount,10);
      assert.deepEqual(retained.roster.slots.map(s=>s.hero?.id),expectedDraft);
      report.push({rendering,geometry,size,timesMs:times,heroes:result.minimap.heroes.map(h=>({id:h.id,score:Math.round(h.confidence*1000)/1000})),comparisons:result.diagnostics.fullComparisons,roiBytes:result.diagnostics.roiBytes});
    }
  }
  fs.writeFileSync(path.join(ROOT,'artifacts/real-minimap-fixtures-results.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:true,report},null,2));app.exit(0);
}).catch(error=>{console.error(error.stack);app.exit(1)});
