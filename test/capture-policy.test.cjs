'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCaptureConfig, selectCaptureSource, validateRegionFrame } = require('../src/capture-policy.cjs');
const { ScreenCaptureHost } = require('../src/capture-host.cjs');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

test('Dota capture never falls back to browsers or desktop', () => {
  const sources = [{ id: 'window:1:0', name: 'Wraith King - Dota 2 - Chrome' }, { id: 'window:2:0', name: 'Dota 2 guide' }, { id: 'screen:0:0', name: 'Dota 2' }];
  const config = normalizeCaptureConfig({ enabled: true });
  assert.equal(selectCaptureSource(sources, config), null);
  sources.push({ id: 'window:3:0', name: 'Dota 2' });
  assert.equal(selectCaptureSource(sources, config).id, 'window:3:0');
  assert.equal(selectCaptureSource(sources, normalizeCaptureConfig({ enabled: false })), null);
});

test('monitor capture requires explicit mode and honors the selected monitor', () => {
  const sources = [{ id: 'screen:0:0', display_id: '20', name: 'Screen 1' }, { id: 'screen:1:0', display_id: '21', name: 'Screen 2' }];
  assert.equal(selectCaptureSource(sources, normalizeCaptureConfig({ enabled: true })), null);
  assert.equal(selectCaptureSource(sources, normalizeCaptureConfig({ enabled: true, sourceMode: 'monitor' }), 21).id, 'screen:1:0');
  assert.equal(selectCaptureSource(sources, normalizeCaptureConfig({ enabled: true, sourceMode: 'monitor', monitorId: 'missing' }), 21), null);
});

test('capture frequency remains capped even if legacy settings request 30 FPS', () => {
  assert.equal(normalizeCaptureConfig({ enabled: true, intervalMs: 33 }).intervalMs, 2000);
  assert.equal(normalizeCaptureConfig({ enabled: true }).intervalMs, 2500);
  assert.equal(normalizeCaptureConfig({ intervalMs: Infinity }).intervalMs, 2500);
});

test('draft capture phase is explicit and normalized independently of game calibration', () => {
  assert.equal(normalizeCaptureConfig({capturePhase:'draft'}).capturePhase,'draft');
  assert.equal(normalizeCaptureConfig({drafting:true}).capturePhase,'draft');
  assert.equal(normalizeCaptureConfig({capturePhase:'other'}).capturePhase,'game');
});

test('draft packets contain only bounded portraits, while game packets still require a minimap', () => {
  const packet=frame();packet.regions=packet.regions.filter(region=>region.kind==='roster');
  assert.equal(validateRegionFrame(packet),'Missing minimap crop');
  packet.capturePhase='draft';assert.equal(validateRegionFrame(packet),null);
  packet.regions.push(frame().regions[0]);assert.equal(validateRegionFrame(packet),'Draft capture accepts portrait regions only');
  packet.regions.pop();packet.capturePhase='strategy';assert.equal(validateRegionFrame(packet),'Invalid capture phase');
});

function frame() {
  return { originalSize: { width: 1920, height: 1080 }, regions: [{ kind: 'minimap', width: 275, height: 275, rect: { x: 13, y: 790, width: 275, height: 275 }, data: new Uint8ClampedArray(275 * 275 * 4) }, ...Array.from({ length: 10 }, (_, index) => ({ kind: 'roster', index, width: 46, height: 32, rect: { x: 600 + index * 50, y: 8, width: 46, height: 32 }, data: Buffer.alloc(46 * 32 * 4) }))] };
}

function titleCrop() {
  return { kind: 'selected_hero_label', width: 136, height: 28, rect: { x: 558, y: 914, width: 136, height: 28 }, data: Buffer.alloc(136 * 28 * 4) };
}

test('selected hero title is a single bounded native crop within the same pixel budget', () => {
  const packet = frame();
  packet.regions.push(titleCrop());
  for (let index = 0; index < 10; index++) packet.regions.push({ kind: 'scene', index, anchor: { x: 325, y: 320 }, healthColor: 'ally', width: 40, height: 40, rect: { x: 300, y: 300, width: 40, height: 40 }, data: Buffer.alloc(40 * 40 * 4) });
  assert.equal(packet.regions.length, 22);
  assert.equal(validateRegionFrame(packet), null, 'map, ten portraits, title and ten tiny heads fit together');
  packet.regions.push(titleCrop());
  assert.equal(validateRegionFrame(packet), 'Invalid region count');
  const duplicate = frame(); duplicate.regions.push(titleCrop(), titleCrop());
  assert.equal(validateRegionFrame(duplicate), 'Invalid selected hero title crop');
});

test('selected title rejects scaling, oversized reads and malformed pixel data', () => {
  for (const patch of [{ width: 161 }, { height: 49 }]) {
    const packet = frame(); packet.regions.push({ ...titleCrop(), ...patch });
    assert.equal(validateRegionFrame(packet), 'Invalid selected hero title crop');
  }
  const scaled = frame(); scaled.regions.push({ ...titleCrop(), width: 68, height: 14, data: Buffer.alloc(68 * 14 * 4) });
  assert.equal(validateRegionFrame(scaled), 'Selected hero title must retain native pixels');
  const malformed = frame(); malformed.regions.push({ ...titleCrop(), data: Buffer.alloc(3) });
  assert.equal(validateRegionFrame(malformed), 'Invalid BGRA crop buffer');
  const clipped = frame(); const crop = titleCrop(); crop.rect.x = 1900; clipped.regions.push(crop);
  assert.equal(validateRegionFrame(clipped), 'Invalid source rectangle');
});

test('healthbar head crops remain bounded, unique and inside the original source',()=>{
  const packet=frame();packet.regions.push({kind:'scene',index:0,anchor:{x:325,y:320},healthColor:'ally',width:40,height:40,rect:{x:300,y:300,width:40,height:40},data:Buffer.alloc(40*40*4)});
  assert.equal(validateRegionFrame(packet),null);
  packet.regions.push({...packet.regions.at(-1)});assert.equal(validateRegionFrame(packet),'Invalid scene slot');
  packet.regions.pop();packet.regions.at(-1).width=1280;assert.equal(validateRegionFrame(packet),'Oversized scene crop');
});

test('only bounded ROI buffers are accepted, with no full-screen IPC frame', () => {
  assert.equal(validateRegionFrame(frame()), null);
  const oversized = frame(); oversized.regions[0].width = 1920; oversized.regions[0].height = 1080; oversized.regions[0].data = Buffer.alloc(1920 * 1080 * 4);
  assert.equal(validateRegionFrame(oversized), 'Oversized minimap crop');
  const corrupted = frame(); corrupted.regions[0].data = Buffer.alloc(3);
  assert.equal(validateRegionFrame(corrupted), 'Invalid BGRA crop buffer');
  const duplicate = frame(); duplicate.regions[2].index = 0;
  assert.equal(validateRegionFrame(duplicate), 'Invalid portrait slot');
  const clipped = frame(); clipped.regions[0].rect.x = 1800;
  assert.equal(validateRegionFrame(clipped), 'Invalid source rectangle');
});

function mockElectron(sources) {
  const requests = []; const windows = []; const mediaHandlers = []; const permissionRequests = []; const permissionChecks = [];
  const ipcMain = new EventEmitter();
  class BrowserWindow extends EventEmitter {
    constructor() {
      super(); this.destroyed = false; this.messages = [];
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = { url: '' };
      this.webContents.isDestroyed = () => this.destroyed;
      this.webContents.getURL = () => this.webContents.mainFrame.url;
      this.webContents.send = (channel, command) => this.messages.push({ channel, command });
      this.webContents.setWindowOpenHandler = () => {};
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    async loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(path.resolve(file)).href; }
  }
  const electron = {
    BrowserWindow, ipcMain,
    screen: { getPrimaryDisplay: () => ({ id: 21 }) },
    desktopCapturer: { getSources: async (options) => { requests.push(options); return sources; } },
    session: { fromPartition: () => ({ setPermissionRequestHandler(handler) { permissionRequests.push(handler); }, setPermissionCheckHandler(handler) { permissionChecks.push(handler); }, setDisplayMediaRequestHandler(handler) { mediaHandlers.push(handler); } }) },
  };
  return { electron, requests, windows, mediaHandlers, permissionRequests, permissionChecks };
}

test('host forwards draft phase at start and phase changes, and acknowledges old phase without analyzing it',async()=>{
  const mock=mockElectron([{id:'window:3:0',name:'Dota 2'}]),accepted=[];
  const host=new ScreenCaptureHost({electron:mock.electron,onFrame:packet=>accepted.push(packet)});
  try{
    await host.update({enabled:true,capturePhase:'draft'});const win=mock.windows[0];
    assert.equal(win.messages.find(entry=>entry.command.type==='start').command.capturePhase,'draft');
    await host.update({enabled:true,capturePhase:'game'});
    assert.equal(win.messages.at(-1).command.capturePhase,'game');
    await host._acceptFrame({sender:win.webContents},{...frame(),capturePhase:'draft',generation:host.generation,sequence:7});
    assert.equal(accepted.length,0);assert.equal(win.messages.at(-1).command.type,'ack');assert.equal(win.messages.at(-1).command.sequence,7);
    await host._acceptFrame({sender:win.webContents},{...frame(),capturePhase:'game',generation:host.generation,sequence:8});
    assert.equal(accepted.length,1);
  }finally{host.destroy();}
});
test('idle capture does no discovery; active capture discovers without thumbnails once', async () => {
  const mock = mockElectron([{ id: 'window:3:0', name: 'Dota 2' }]);
  const host = new ScreenCaptureHost({ electron: mock.electron });
  try {
    await host.update({ enabled: false });
    assert.equal(mock.requests.length, 0);
    assert.equal(mock.windows.length, 0);
    await host.update({ enabled: true });
    assert.deepEqual(mock.requests[0], { types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
    assert.equal(mock.windows.length, 1);
    for (let index = 0; index < 30; index++) await host.update({ enabled: true });
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.windows[0].messages.filter((entry) => entry.command.type === 'start').length, 1);
    host.stop();
    assert.equal(mock.windows[0].isDestroyed(), true);
  } finally { host.destroy(); }
});

test('only the isolated capture page can request the selected window, without audio', async () => {
  const source = { id: 'window:3:0', name: 'Dota 2' };
  const mock = mockElectron([source]);
  const host = new ScreenCaptureHost({ electron: mock.electron });
  try {
    await host.update({ enabled: true });
    const frame = mock.windows[0].webContents.mainFrame;
    let granted;
    mock.mediaHandlers[0]({ frame, videoRequested: true, audioRequested: false }, (value) => { granted = value; });
    assert.deepEqual(granted, { video: source });
    mock.mediaHandlers[0]({ frame, videoRequested: true, audioRequested: true }, (value) => { granted = value; });
    assert.equal(granted, null);
    mock.mediaHandlers[0]({ frame: { url: frame.url }, videoRequested: true, audioRequested: false }, (value) => { granted = value; });
    assert.equal(granted, null);
    host.stop();
    mock.mediaHandlers[0]({ frame, videoRequested: true, audioRequested: false }, (value) => { granted = value; });
    assert.equal(granted, null);
  } finally { host.destroy(); }
});

test('worker backpressure acknowledges only after processing, and drops extra work', async () => {
  const mock = mockElectron([{ id: 'window:3:0', name: 'Dota 2' }]);
  let finish; let analyses = 0;
  const blocked = new Promise((resolve) => { finish = resolve; });
  const host = new ScreenCaptureHost({ electron: mock.electron, onFrame: async () => { analyses++; await blocked; } });
  try {
    await host.update({ enabled: true });
    const window = mock.windows[0];
    const event = { sender: window.webContents };
    const first = host._acceptFrame(event, { ...frame(), generation: host.generation, sequence: 1 });
    assert.equal(analyses, 1);
    assert.equal(window.messages.filter((entry) => entry.command.type === 'ack').length, 0);
    await host._acceptFrame(event, { ...frame(), generation: host.generation, sequence: 2 });
    assert.equal(analyses, 1);
    assert.equal(window.messages.at(-1).command.sequence, 2);
    finish(); await first;
    assert.equal(window.messages.at(-1).command.sequence, 1);
  } finally { finish(); host.destroy(); }
});

test('missing Dota is retried no more often than the discovery interval', async () => {
  const mock = mockElectron([]);
  const host = new ScreenCaptureHost({ electron: mock.electron });
  try {
    for (let index = 0; index < 30; index++) await host.update({ enabled: true });
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.windows.length, 0);
  } finally { host.destroy(); }
});

test('previews require an active trusted stream, are bounded, and are throttled', async () => {
  const mock = mockElectron([{ id: 'window:3:0', name: 'Dota 2' }]);
  const previews = [];
  const host = new ScreenCaptureHost({ electron: mock.electron, onPreview: value => previews.push(value) });
  try {
    assert.equal(host.requestPreview(), false);
    await host.update({ enabled: true });
    assert.equal(host.requestPreview(), true);
    assert.equal(host.requestPreview(), false);
    const packet = { generation: host.generation, width: 640, height: 360, dataUrl: 'data:image/jpeg;base64,AA==' };
    host._acceptPreview({ sender: {} }, packet);
    assert.equal(previews.length, 0);
    host._acceptPreview({ sender: mock.windows[0].webContents }, { ...packet, width: 1920 });
    assert.equal(previews.length, 0);
    host.lastPreviewRequestAt = 0;
    assert.equal(host.requestPreview(), true);
    host._acceptPreview({ sender: mock.windows[0].webContents }, packet);
    assert.equal(previews.length, 1);
    assert.equal(host.requestPreview(), false);
    host.stop();
    assert.equal(host.requestPreview(), false);
  } finally { host.destroy(); }
});

test('Chromium video permissions are granted only for the active isolated capture page; audio and other frames are denied', async () => {
  const mock = mockElectron([{ id: 'window:3:0', name: 'Dota 2' }]);
  const host = new ScreenCaptureHost({ electron: mock.electron });
  try {
    await host.update({ enabled: true });
    const contents = mock.windows[0].webContents;
    const details = { mediaTypes: ['video'], requestingUrl: contents.getURL(), isMainFrame: true };
    let granted;
    const request = value => { granted = value; };
    mock.permissionRequests[0](contents, 'media', request, details);
    assert.equal(granted, true, 'Electron emits media video permission for screen capture');
    mock.permissionRequests[0](contents, 'media', request, { ...details, mediaTypes: [] });
    assert.equal(granted, true, 'Electron 44 emits an empty list during selected-source display acquisition');
    mock.permissionRequests[0](contents, 'media', request, { ...details, mediaTypes: ['video', 'audio'] });
    assert.equal(granted, false);
    mock.permissionRequests[0](contents, 'media', request, { ...details, isMainFrame: false });
    assert.equal(granted, false);
    mock.permissionRequests[0](contents, 'media', request, { ...details, requestingUrl: 'https://untrusted.example/' });
    assert.equal(granted, false);
    assert.equal(mock.permissionChecks[0](contents, 'media', '', { ...details, mediaType: 'video' }), true);
    assert.equal(mock.permissionChecks[0](contents, 'media', '', { ...details, mediaType: 'audio' }), false);
    host.displayGrantPending = false;
    mock.permissionRequests[0](contents, 'media', request, { ...details, mediaTypes: [] });
    assert.equal(granted, false, 'empty-media grants expire immediately after acquisition');
    host.stop();
    mock.permissionRequests[0](contents, 'media', request, details);
    assert.equal(granted, false);
  } finally { host.destroy(); }
});
