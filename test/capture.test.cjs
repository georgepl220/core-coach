'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { analyzeRegions } = require('../src/vision-regions.cjs');
const { validateRegionFrame } = require('../src/capture-policy.cjs');

function rendererFixture({ frameRate = 1 } = {}) {
  const frames = [], statuses = [], previews = [], draws = [], constraints = [];
  const timers = new Map(); let timerId = 0; let command; let now = 100000; let stops = 0;
  const track = { stop: () => { stops++; }, applyConstraints: async value => constraints.push(value), addEventListener() {}, getSettings: () => ({ width: 1280, height: 720, frameRate }) };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const video = { readyState: 2, videoWidth: 1280, videoHeight: 720, pause() {}, play: async () => {} };
  function canvas() {
    const surface = { width: 1, height: 1, toDataURL: () => 'data:image/jpeg;base64,AA==' };
    surface.getContext = () => ({ drawImage: (...args) => draws.push(args), getImageData: () => ({ data: new Uint8ClampedArray(surface.width * surface.height * 4) }) });
    return surface;
  }
  const context = { window: { captureBridge: { onCommand: callback => { command = callback; }, sendFrame: packet => frames.push(structuredClone(packet)), sendStatus: status => statuses.push(status), sendPreview: preview => previews.push(preview) }, addEventListener() {} }, document: { getElementById: () => video, createElement: canvas }, navigator: { mediaDevices: { getDisplayMedia: async () => stream } }, setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; }, clearTimeout: id => timers.delete(id), Date: { now: () => now }, performance: { now: () => now }, Uint8ClampedArray };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/hud-calibration.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/scene-proposals.js'), 'utf8'), context);context.window.SceneProposals=context.SceneProposals;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/capture.js'), 'utf8'), context);
  return { frames, statuses, previews, draws, constraints, stops: () => stops, send: value => command({ generation: 1, ...value }), tick(ms) { now += ms; const entry = [...timers.entries()][0]; assert.ok(entry, 'renderer scheduled its next sampling interval'); timers.delete(entry[0]); entry[1].callback(); }, video };
}

test('persistent stream is capped to 1 FPS and 1280 by 720, and only ROI pixels leave the renderer', async () => {
  const fixture = rendererFixture();
  fixture.send({ type: 'start', intervalMs: 3000, rosterConfirmed: true });
  await new Promise(setImmediate);
  assert.equal(fixture.frames.length, 1);
  assert.equal(fixture.constraints[0].frameRate.max, 1);
  assert.equal(fixture.constraints[0].width.max, 1280);
  assert.equal(fixture.constraints[0].height.max, 720);
  const first = fixture.frames[0];
  assert.equal(validateRegionFrame(first), null);
  assert.equal(first.regions.length, 12);
  assert.ok(first.diagnostics.roiBytes < 200000);
  assert.equal(fixture.draws.length, 12);
  const title = first.regions.find(region => region.kind === 'selected_hero_label');
  assert.deepEqual(title.rect, { x: 372, y: 609, width: 91, height: 19, units: 'px' });
  assert.equal(title.width, title.rect.width);
  assert.equal(title.height, title.rect.height);
  assert.equal(title.data.byteLength, 91 * 19 * 4, 'selected identity retains only its native small title crop');
  assert.ok(fixture.draws.every(args => args.length === 9), 'every readback crops a source region');
  assert.equal(fixture.previews.length, 0, 'normal capture never generates full-screen previews');
  fixture.send({ type: 'stop', generation: 2 });
  assert.equal(fixture.stops(), 1);
  assert.equal(fixture.video.srcObject, null);
});

test('scene probe stays inside capture renderer and obeys worker backpressure',async()=>{
  const fixture=rendererFixture();fixture.send({type:'start',calibration:{sceneEnabled:true}});await new Promise(setImmediate);
  assert.equal(fixture.frames.length,1);assert.equal(fixture.frames[0].regions.length,12);
  assert.equal(fixture.draws.length,13,'one temporary scan in addition to twelve transmitted ROI crops');
  assert.ok(fixture.frames[0].diagnostics.roiBytes<200000);
  fixture.tick(5000);assert.equal(fixture.draws.length,13,'no probe when a previous frame has no acknowledgement');
  fixture.send({type:'ack',sequence:1});fixture.send({type:'configure',calibration:{sceneEnabled:false}});fixture.tick(5000);
  assert.equal(fixture.draws.length,25,'once disabled, only the twelve HUD regions are read');
  fixture.send({type:'stop',generation:2});
});

test('draft capture uses its own large cards, no minimap/title/scene, and refreshes every observation', async () => {
  const fixture=rendererFixture();
  fixture.send({type:'start',capturePhase:'draft',rosterConfirmed:true,calibration:{sceneEnabled:true,minimapRect:{x:-1},rosterRects:[{x:-1}]}});
  await new Promise(setImmediate);
  assert.equal(fixture.frames.length,1);
  const first=fixture.frames[0];assert.equal(first.capturePhase,'draft');assert.equal(validateRegionFrame(first),null);
  assert.equal(first.regions.length,10);assert.ok(first.regions.every(region=>region.kind==='roster'));
  assert.deepEqual(first.regions[0].rect,{x:140,y:4,width:77,height:44});
  assert.deepEqual(first.regions[5].rect,{x:735,y:4,width:72,height:44});
  assert.ok(first.diagnostics.roiBytes<=120000);
  assert.equal(fixture.draws.length,10,'draft never scans the game world');
  fixture.send({type:'ack',sequence:1});fixture.tick(2500);
  assert.equal(fixture.frames[1].regions.length,10,'a new pick must be observed immediately even when old roster was complete');
  fixture.send({type:'ack',sequence:2});fixture.send({type:'configure',capturePhase:'game',rosterConfirmed:true,calibration:{}});fixture.tick(2500);
  assert.equal(fixture.frames[2].capturePhase,'game');assert.equal(fixture.frames[2].regions.length,12,'phase changes invalidate capture cadence');
  assert.deepEqual(fixture.frames[2].regions.find(region=>region.kind==='roster').rect,{x:365,y:3,width:39,height:24});
  fixture.send({type:'stop',generation:2});
});

test('draft custom calibration does not change game portrait crops', async () => {
  const fixture=rendererFixture();const rects=Array.from({length:10},(_,index)=>({x:100+index*70,y:8,width:64,height:40,units:'px'}));
  fixture.send({type:'start',capturePhase:'draft',calibration:{draftRosterRects:rects}});await new Promise(setImmediate);
  assert.equal(fixture.frames[0].regions[0].rect.x,100);
  fixture.send({type:'ack',sequence:1});fixture.send({type:'configure',capturePhase:'game',calibration:{draftRosterRects:rects}});fixture.tick(2500);
  assert.equal(fixture.frames[1].regions.find(region=>region.kind==='roster').rect.x,365);
  fixture.send({type:'stop',generation:2});
});

test('roster is sampled at most once per ten seconds after confirmation and worker backpressure drops sampling', async () => {
  const fixture = rendererFixture();
  fixture.send({ type: 'start', intervalMs: 3000, rosterConfirmed: true });
  await new Promise(setImmediate);
  fixture.tick(3000);
  assert.equal(fixture.frames.length, 1, 'unacknowledged frame prevents another readback');
  fixture.send({ type: 'ack', sequence: 1 });
  fixture.tick(3000);
  assert.deepEqual(fixture.frames[1].regions.map(region => region.kind), ['minimap', 'selected_hero_label'], 'selection proof refreshes on every sampled frame between roster intervals');
  fixture.send({ type: 'ack', sequence: 2 });
  fixture.tick(6000);
  assert.equal(fixture.frames[2].regions.length, 12);
  fixture.send({ type: 'stop', generation: 2 });
});

test('preview is an explicit bounded JPEG, and unsupported high-rate drivers stop immediately', async () => {
  const fixture = rendererFixture();
  fixture.send({ type: 'start' });
  await new Promise(setImmediate);
  fixture.send({ type: 'preview' });
  assert.equal(fixture.previews.length, 1);
  assert.equal(fixture.previews[0].width, 640);
  assert.equal(fixture.previews[0].height, 360);
  assert.deepEqual(structuredClone(fixture.previews[0].originalSize), { width: 1280, height: 720 });
  fixture.send({ type: 'stop', generation: 2 });
  const bad = rendererFixture({ frameRate: 30 });
  bad.send({ type: 'start' });
  await new Promise(setImmediate);
  assert.equal(bad.frames.length, 0);
  assert.equal(bad.stops(), 1);
  assert.equal(bad.statuses.at(-1).state, 'capture-error');
});

function mapPacket(timestamp = 200000) {
  const data = new Uint8Array(80 * 80 * 4).fill(40);
  for (let offset = 3; offset < data.length; offset += 4) data[offset] = 255;
  return { timestamp, originalSize: { width: 1280, height: 720 }, regions: [{ kind: 'minimap', rect: { x: 8, y: 528, width: 184, height: 184 }, width: 80, height: 80, data: data.buffer }] };
}

test('minimap-only analysis keeps known draft and its original observation time without rerunning portraits', () => {
  const slot = { index: 5, team: 'dire', rect: { x: 900, y: 5, width: 31, height: 22 }, hero: { id: 2, name: 'Axe', confidence: 0.95 }, observedAt: 195000 };
  const previous = { lastSeen: [], roster: { slots: [slot], observedAt: 195000, originalSize: { width: 1280, height: 720 } } };
  const result = analyzeRegions(mapPacket(), { playerTeam: 'radiant', selfHeroId: 42 }, { portraits: [], minimap: [] }, previous);
  assert.equal(result.roster.slots[0].hero.id, 2);
  assert.equal(result.roster.slots[0].observedAt, 195000);
  assert.equal(result.roster.slots[0].fromCache, true);
  assert.equal(result.diagnostics.rosterRefreshed, false);
  assert.equal(result.state.roster.observedAt, 195000);
  const resized = mapPacket(); resized.originalSize.width = 1920;
  assert.equal(analyzeRegions(resized, { playerTeam: 'radiant' }, { portraits: [], minimap: [] }, previous).roster.slots.length, 0);
});

