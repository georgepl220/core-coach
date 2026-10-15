'use strict';

// One still image is replayed at synthetic 5-second timestamps to regression
// test the confirmation policy. This is not four real live observations.
// Only hero-health-bar patches, public HUD strips and minimap pixels are kept.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { app, nativeImage, BrowserWindow } = require('electron');
const { defaultCalibration, resolveRect } = require('../src/vision.cjs');
const { analyzeRegions } = require('../src/vision-regions.cjs');
const { findHealthBarHeads } = require('../src/scene-proposals.js');
const { newRosterCache, updateRosterCache } = require('../src/roster-cache.cjs');
const { newLaneTrack, updateLaneTrack } = require('../src/lane-tracker.cjs');
const { recommend } = require('../src/core.cjs');
const { selectedHeroLabelRect } = require('../src/screen-identity.cjs');
const selectedFixture = require('./fixtures/selected-wk-label-real.json');
const fixture = require('./fixtures/scene-lane-real.json');
const dataset = require('../data/wraith-king.json');
const ROOT = path.resolve(__dirname, '..');
const EXPECTED_DRAFT = [42, 36, 6, 37, 26, 43, 2, 22, 18, 20];

app.setName('Core Coach Real Lane Integration');
app.whenReady().then(async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/assets/manifest.json'), 'utf8'));
  const templates = {};
  for (const kind of ['portraits', 'minimap']) templates[kind] = manifest[kind].map((entry) => {
    const image = nativeImage.createFromPath(path.join(ROOT, 'data/assets', entry.file));
    assert.equal(image.isEmpty(), false, entry.file);
    return { id: entry.heroId, name: entry.localizedName, ...image.getSize(), data: image.toBitmap() };
  });
  assert.equal(templates.portraits.length, 127);
  assert.equal(templates.minimap.length, 127);

  const f = fixture.frames.find((frame) => frame.width === 1919);
  const data = zlib.gunzipSync(Buffer.from(f.patchFrame, 'base64'));
  for (let p = 3; p < data.length; p += 4) data[p] = 255;
  for (const patch of [{ file: 'lane-hud-strip.png', x: 518, y: 0 }, { file: 'lane-minimap.png', x: 8, y: 843 }]) {
    const image = nativeImage.createFromPath(path.join(__dirname, 'fixtures', patch.file));
    assert.equal(image.isEmpty(), false, patch.file);
    const pixels = image.toBitmap(); const size = image.getSize();
    for (let row = 0; row < size.height; row++) pixels.copy(data, ((patch.y + row) * f.width + patch.x) * 4, row * size.width * 4, (row + 1) * size.width * 4);
  }
  const selected = selectedFixture.frames.find(frame => frame.name === 'game-0-native').region;
  const titlePixels = Buffer.from(selected.data, 'base64');
  for(let row=0;row<selected.height;row++)titlePixels.copy(data,((selected.rect.y+row)*f.width+selected.rect.x)*4,row*selected.width*4,(row+1)*selected.width*4);
  const native = nativeImage.createFromBitmap(data, { width: f.width, height: f.height });
  const browser = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
  await browser.loadURL('about:blank');
  const chromiumRgba = await browser.webContents.executeJavaScript(`(async () => {
    const image = new Image(); image.src = ${JSON.stringify(native.toDataURL())}; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
    const context = canvas.getContext('2d', { alpha: false }); context.drawImage(image, 0, 0, 1280, 720);
    const rgba = context.getImageData(0, 0, 1280, 720);
    const proposals = require(${JSON.stringify(path.join(ROOT, 'src/scene-proposals.js'))}).findHealthBarHeads({ width: 1280, height: 720, data: rgba.data, format: 'rgba' });
    return { base64: Buffer.from(rgba.data).toString('base64'), proposals };
  })()`);
  browser.destroy();
  const chromiumPixels = Buffer.from(chromiumRgba.base64, 'base64');
  for (let p = 0; p < chromiumPixels.length; p += 4) { const red = chromiumPixels[p]; chromiumPixels[p] = chromiumPixels[p + 2]; chromiumPixels[p + 2] = red; }
  const chromium = nativeImage.createFromBitmap(chromiumPixels, { width: 1280, height: 720 });

  const report = [];
  for (const [rendering, image] of [['native', native], ['chromium-canvas', chromium]]) {
    const size = image.getSize();
    const defaults = defaultCalibration(size.width, size.height);
    const proposals = findHealthBarHeads({ ...size, data: image.toBitmap() });
    if (rendering === 'chromium-canvas') assert.deepEqual(proposals, chromiumRgba.proposals);
    assert.equal(proposals.length, 4, `${rendering}: automatically proposed heads`);
    const regions = [];
    for (const [kind, definitions] of [['minimap', [defaults.minimapRect]], ['roster', defaults.rosterRects]]) definitions.forEach((definition, index) => {
      const rect = resolveRect(definition, size.width, size.height);
      const bitmap = image.crop(rect);
      regions.push({ kind, index, team: definition.team, rect, ...bitmap.getSize(), data: bitmap.toBitmap() });
    });
    for (const proposal of proposals) {
      const bitmap = image.crop(proposal.rect);
      regions.push({ ...proposal, kind: 'scene', ...bitmap.getSize(), data: bitmap.toBitmap() });
    }
    const titleRect=selectedHeroLabelRect(size.width,size.height),titleImage=image.crop(titleRect);
    regions.push({kind:'selected_hero_label',rect:titleRect,...titleImage.getSize(),data:titleImage.toBitmap()});
    assert.ok(regions.length <= 22);
    assert.ok(regions.filter((region) => region.kind === 'scene').every((region) => region.width <= 64 && region.height <= 64));
    let cache = newRosterCache(); let track = newLaneTrack(); let previous = null; let result; let advice; let state;
    const frames = [];
    for (const offset of [0, 5000, 10000, 15000]) {
      const now = 100000 + offset;
      state = { heroId: 42, heroName: 'npc_dota_hero_skeleton_king', isWraithKing: true, isSpectator: false, status: 'live', team: 'radiant', matchId: 'offline-real-lane-regression', receivedAt: now, gameTime: 504 + offset / 1000, gameState: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS', isPaused: false, alive: true, healthPercent: 100, manaPercent: 74, health: 1000, maxHealth: 1000, level: 5, lastHits: 17, denies: 1, kills: 1, deaths: 1, assists: 1, gold: 2014, inventory: [], abilities: [{ name: 'skeleton_king_hellfire_blast', level: 1, cooldown: 0, canCast: true }], dataQuality: { inventory: true } };
      const start = performance.now();
      result = analyzeRegions({ timestamp: now, originalSize: size, regions }, { selfHeroId: 42, playerTeam: 'radiant', allyHeroIds: cache.teams.radiant, enemyHeroIds: cache.teams.dire }, templates, previous);
      const analysisMs = Math.round(performance.now() - start);
      assert.deepEqual(result.roster.slots.map((slot) => slot.hero?.id), EXPECTED_DRAFT, `${rendering}: full HUD`);
      assert.ok(result.roster.slots.every((slot) => slot.hero.confidence >= 0.90), `${rendering}: HUD strict confidence`);
      assert.deepEqual(result.scene.heroes.map((hero) => hero.id).sort((a, b) => a - b), [2, 22, 26, 42], `${rendering}: scene heads ${JSON.stringify(result.scene.observations)}`);
      assert.ok(result.scene.heroes.every((hero) => hero.confidence >= 0.90));
      assert.equal(result.scene.usable, true);
      assert.equal(result.player.confirmed,true,`${rendering}: selected WK title`);
      assert.equal(result.player.team,'radiant');
      cache = updateRosterCache(cache, { state, vision: result, now });
      track = updateLaneTrack(track, { state, vision: result, enemyHeroIds: cache.teams.dire, alliedHeroIds: cache.teams.radiant, playerTeam: 'radiant', requireConfirmedRoster: true, now });
      if (offset === 0) { assert.deepEqual(cache.teams.radiant, []); assert.equal(track.inferred.allyHeroId, null); }
      if (offset < 15000) assert.notEqual(track.inferred.status, 'confirmed', `${rendering}: no premature repeated-frame confirmation`);
      frames.push({ offsetMs: offset, analysisMs, rosterCache: cache.teams, scene: result.scene.heroes.map((hero) => ({ id: hero.id, confidence: hero.confidence, margin: hero.margin })), inferred: track.inferred });
      previous = result.state;
    }
    assert.deepEqual(cache.teams.radiant, [42, 36, 6, 37, 26]);
    assert.deepEqual(cache.teams.dire, [43, 2, 22, 18, 20]);
    assert.equal(track.inferred.status, 'confirmed');
    assert.equal(track.inferred.source, 'screen_scene');
    assert.equal(track.inferred.allyHeroId, 26);
    assert.deepEqual(track.inferred.enemyHeroIds, [2, 22]);
    advice = recommend(state, dataset, { now: state.receivedAt, enemyHeroIds: cache.teams.dire, alliedHeroIds: cache.teams.radiant, playerTeam: 'radiant', vision: result, laneEnemyHeroIds: track.inferred.enemyHeroIds, laneAllyHeroId: track.inferred.allyHeroId, laneSource: track.inferred.source, laneStatus: track.inferred.status, laneConfidence: track.inferred.confidence, laneObservedAt: track.inferred.lastSeenAt, laneResult: 'auto', farmTargets: { cs10: 50, cs20: 140, cs30: 230 } });
    assert.equal(advice.lane.detectionSource, 'screen_scene');
    assert.deepEqual(advice.lane.opponents.map((hero) => hero.id), [2, 22]);
    assert.equal(advice.lane.ally.id, 26);
    assert.match(advice.lane.source, /полосок здоровья/);
    assert.match(JSON.stringify(advice.lane), /Axe/);
    assert.match(JSON.stringify(advice.lane), /Zeus/);
    assert.equal(advice.action.source, 'lane');
    report.push({ rendering, size, sceneRoiBytes: regions.filter((region) => region.kind === 'scene').reduce((sum, region) => sum + region.data.length, 0), frames, lane: advice.lane, action: advice.action });
    for(const mode of ['missing-gsi','stale-gsi','paused-gsi','late-gsi','gsi-dimmed-wk-portrait']){
      let screenCache=newRosterCache(),screenTrack=newLaneTrack(),screenPrevious=null,screenResult,screenState,now;
      for(const offset of [0,5000,10000,15000]){
        now=200000+offset;
        screenState=mode==='missing-gsi'?{}:{...state,receivedAt:mode==='stale-gsi'?100000:now,gameTime:mode==='late-gsi'?1500:state.gameTime,isPaused:mode==='paused-gsi'};
        const sampleRegions=mode==='gsi-dimmed-wk-portrait'?regions.map(region=>region.kind==='roster'&&region.index===0?{...region,data:Buffer.alloc(region.data.length)}:region):regions;
        screenResult=analyzeRegions({timestamp:now,originalSize:size,regions:sampleRegions},{gsiPlayer:mode==='gsi-dimmed-wk-portrait'?screenState:null,selfHeroId:42,playerTeam:'radiant',allyHeroIds:screenCache.teams.radiant,enemyHeroIds:screenCache.teams.dire},templates,screenPrevious);
        if(mode==='gsi-dimmed-wk-portrait'){assert.equal(screenResult.roster.slots[0].hero,null);assert.equal(screenResult.player.confirmed,true);assert.equal(screenResult.player.teamSource,'gsi');}
        screenCache=updateRosterCache(screenCache,{state:screenState,vision:screenResult,now});
        screenTrack=updateLaneTrack(screenTrack,{state:screenState,vision:screenResult,enemyHeroIds:screenCache.teams.dire,alliedHeroIds:screenCache.teams.radiant,playerTeam:'radiant',requireConfirmedRoster:true,now});
        screenPrevious=screenResult.state;
      }
      assert.equal(screenTrack.inferred.complete,true,`${rendering}/${mode}: current nearby group`);
      const expectedSource=mode==='gsi-dimmed-wk-portrait'?'screen_scene':'screen_current';
      assert.equal(screenTrack.inferred.source,expectedSource);
      assert.equal(screenTrack.inferred.allyHeroId,26);assert.deepEqual(screenTrack.inferred.enemyHeroIds,[2,22]);
      const currentAdvice=recommend(screenState,dataset,{now,screenPlayer:screenResult.player,vision:screenResult,enemyHeroIds:screenCache.teams.dire,alliedHeroIds:screenCache.teams.radiant,laneEnemyHeroIds:screenTrack.inferred.enemyHeroIds,laneAllyHeroId:screenTrack.inferred.allyHeroId,laneSource:screenTrack.inferred.source,laneStatus:screenTrack.inferred.status,laneConfidence:screenTrack.inferred.confidence,laneObservedAt:screenTrack.inferred.lastSeenAt,laneResult:'auto'});
      assert.equal(currentAdvice.lane.detectionSource,expectedSource,`${rendering}/${mode}: static advice`);
      assert.deepEqual(currentAdvice.lane.opponents.map(hero=>hero.id),[2,22]);assert.equal(currentAdvice.lane.ally.id,26);
      if(!['late-gsi','gsi-dimmed-wk-portrait'].includes(mode)){assert.equal(currentAdvice.item,null);assert.equal(currentAdvice.skills.next,null);}
      report.push({rendering,mode,selectedHero:screenResult.player,source:screenTrack.inferred.source,allyId:26,enemyIds:[2,22],lane:currentAdvice.lane});
    }
  }
  const output = { passed: report.every((entry) => entry.lane.stance !== 'unknown'), recognitionPipelinePassed: true, evidence: 'One real still image composed from retained patches, synthetic 0/5/10/15s replay verifies integration only, not live recognition quality.', installedTemplateCounts: { portraits: templates.portraits.length, minimap: templates.minimap.length }, report };
  fs.writeFileSync(path.join(ROOT, 'artifacts/real-lane-integration-results.json'), JSON.stringify(output, null, 2));
  assert.ok(report.every((entry) => entry.lane.stance !== 'unknown'), 'Both known opponents need specific coaching rules');
  console.log(JSON.stringify(output, null, 2)); app.exit(0);
}).catch((error) => { console.error(error.stack); app.exit(1); });
