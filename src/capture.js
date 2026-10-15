'use strict';

// Only this isolated renderer holds a video stream. Pixel reads are restricted
// to the minimap, portraits and small proposed healthbar heads. A temporary
// scene probe stays here and is never sent to the worker or encoded as JPEG.
(() => {
  const bridge = window.captureBridge;
  const video = document.getElementById('source');
  const canvases = new Map();
  let stream = null;
  let generation = 0;
  let sequence = 0;
  let outstanding = null;
  let timer = null;
  let settings = {};
  let intervalMs = 2500;
  let starting = false;
  let rosterConfirmed = false;
  let capturePhase = 'game';
  let lastRosterAt = 0;
  let previewCanvas = null;
  let sceneCanvas = null;
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

  function status(state, detail = {}) { bridge.sendStatus({ generation, state, ...detail }); }

  function defaults(width, height) {
    return capturePhase === 'draft' ? window.HudCalibration.draftCalibration(width, height) : window.HudCalibration.defaultCalibration(width, height, !!settings.minimapOnRight);
  }

  function resolve(rect, width, height) {
    if (!rect) return null;
    const rw = rect.width ?? rect.w; const rh = rect.height ?? rect.h;
    if (![rect.x, rect.y, rw, rh].every((value) => Number.isFinite(Number(value))) || Number(rw) <= 0 || Number(rh) <= 0) return null;
    const normalized = rect.units !== 'px' && Math.abs(Number(rect.x)) <= 1 && Math.abs(Number(rect.y)) <= 1 && Number(rw) <= 1 && Number(rh) <= 1;
    const x = Math.round(Number(rect.x) * (normalized ? width : 1));
    const y = Math.round(Number(rect.y) * (normalized ? height : 1));
    const w = Math.round(Number(rw) * (normalized ? width : 1));
    const h = Math.round(Number(rh) * (normalized ? height : 1));
    // A clipped region means calibration is wrong; do not identify partial icons.
    if (x < 0 || y < 0 || w < 4 || h < 4 || x + w > width || y + h > height) return null;
    return { x, y, width: w, height: h };
  }

  function crop(kind, index, definition, rect) {
    const factor = kind==='selected_hero_label'?1:kind === 'minimap' ? Math.min(1, 352 / rect.width, 352 / rect.height) : kind==='scene'?Math.min(1,64/rect.width,64/rect.height):Math.min(1, 64 / rect.width, 48 / rect.height);
    const width = Math.max(4, Math.round(rect.width * factor));
    const height = Math.max(4, Math.round(rect.height * factor));
    const key = kind === 'minimap' ? 'minimap' : `${kind}:${index}`;
    let canvas = canvases.get(key);
    if (!canvas) { canvas = document.createElement('canvas'); canvases.set(key, canvas); }
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const context = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
    context.drawImage(video, rect.x, rect.y, rect.width, rect.height, 0, 0, width, height);
    const rgba = context.getImageData(0, 0, width, height).data;
    // Existing vision templates use BGRA; swizzle only these small crops.
    for (let offset = 0; offset < rgba.length; offset += 4) { const red = rgba[offset]; rgba[offset] = rgba[offset + 2]; rgba[offset + 2] = red; }
    return { kind, ...(kind === 'roster' ? { index, team: definition.team || (index < 5 ? 'radiant' : 'dire') } : kind==='scene'?{index,anchor:definition.anchor,healthColor:definition.healthColor}:{}), rect, width, height, data: rgba.buffer };
  }

  function schedule() {
    clearTimeout(timer);
    if (stream) timer = setTimeout(capture, intervalMs);
  }

  function capture() {
    timer = null;
    if (!stream) return;
    try {
      if (!outstanding && video.readyState >= 2 && video.videoWidth >= 8 && video.videoHeight >= 8) {
        const started = performance.now();
        const timestamp = Date.now();
        const width = video.videoWidth; const height = video.videoHeight;
        const fallback = defaults(width, height);
        const regions = [];
        if (capturePhase !== 'draft') {
          const mapDefinition = settings.minimapRect || fallback.minimapRect;
          const map = resolve(mapDefinition, width, height);
          if (!map) { status('calibration-error', { reason: 'Minimap calibration is outside the captured Dota window' }); schedule(); return; }
          regions.push(crop('minimap', null, mapDefinition, map));
        }
        const selectedRect=capturePhase === 'draft' ? null : window.HudCalibration.selectedHeroLabelRect(width,height);
        if(selectedRect)regions.push(crop('selected_hero_label',null,{},selectedRect));
        if (capturePhase === 'draft' || !rosterConfirmed || !lastRosterAt || timestamp - lastRosterAt >= 10000) {
          const definitions = capturePhase === 'draft' ? settings.draftRosterRects || fallback.rosterRects : settings.rosterRects || fallback.rosterRects;
          definitions.slice(0, 10).forEach((definition, index) => {
            const rect = resolve(definition, width, height);
            if (rect) regions.push(crop('roster', index, definition, rect));
          });
          lastRosterAt = timestamp;
        }
        if(capturePhase !== 'draft' && settings.sceneEnabled===true){
          if(!sceneCanvas)sceneCanvas=document.createElement('canvas');
          if(sceneCanvas.width!==width||sceneCanvas.height!==height){sceneCanvas.width=width;sceneCanvas.height=height;}
          const context=sceneCanvas.getContext('2d',{willReadFrequently:true,alpha:false});
          context.drawImage(video,0,0,width,height);
          const pixels=context.getImageData(0,0,width,height).data;
          const heads=window.SceneProposals.findHealthBarHeads({width,height,data:pixels,format:'rgba'});
          for(const head of heads)regions.push(crop('scene',head.index,head,head.rect));
        }
        const id = ++sequence;
        outstanding = id;
        bridge.sendFrame({ generation, sequence: id, timestamp, capturePhase, originalSize: { width, height }, regions, diagnostics: { captureMs: Math.round((performance.now() - started) * 10) / 10, roiBytes: regions.reduce((sum, region) => sum + region.data.byteLength, 0) } });
      }
    } catch (error) { status('capture-error', { reason: String(error.message || error).slice(0, 240) }); }
    schedule();
  }

  function stop(nextGeneration) {
    generation = nextGeneration;
    clearTimeout(timer); timer = null;
    if (stream) stream.getTracks().forEach((track) => track.stop());
    stream = null; outstanding = null;
    lastRosterAt = 0;
    video.pause(); video.srcObject = null;
    canvases.forEach((canvas) => { canvas.width = 1; canvas.height = 1; });
    canvases.clear();
    if (previewCanvas) { previewCanvas.width = 1; previewCanvas.height = 1; previewCanvas = null; }
  }

  async function start(command) {
    stop(command.generation);
    settings = command.calibration || {};
    capturePhase = command.capturePhase === 'draft' || command.drafting === true ? 'draft' : 'game';
    intervalMs = clamp(Number(command.intervalMs) || 2500, 2000, 15000);
    rosterConfirmed = command.rosterConfirmed === true;
    if (starting) { status('capture-error', { reason: 'Capture start is already pending' }); return; }
    const requestedGeneration = generation;
    starting = true;
    try {
      // Chromium captures just one selected window. The track itself is capped,
      // not merely a 30 FPS stream read by a slower analysis timer.
      // Apply hard limits to the resulting track before starting video.
      const obtained = await navigator.mediaDevices.getDisplayMedia({ audio: false, video: { frameRate: { ideal: 1 }, width: { ideal: 1280 }, height: { ideal: 720 } } });
      if (generation !== requestedGeneration) { obtained.getTracks().forEach((track) => track.stop()); return; }
      stream = obtained;
      const track = stream.getVideoTracks()[0];
      await track.applyConstraints({ frameRate: { ideal: 1, max: 1 }, width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 } });
      if (generation !== requestedGeneration) { obtained.getTracks().forEach((item) => item.stop()); return; }
      track.addEventListener('ended', () => {
        if (stream === obtained) { stop(generation); status('source-ended'); }
      }, { once: true });
      video.srcObject = stream;
      await video.play();
      if (generation !== requestedGeneration) return;
      const actual = track.getSettings();
      if (actual.frameRate > 1.5 || actual.width > 1280 || actual.height > 720) throw new Error('The capture driver did not honor the 1 FPS / 1280 × 720 limits');
      status('streaming', { frameRate: actual.frameRate ?? null, width: actual.width ?? null, height: actual.height ?? null });
      capture();
    } catch (error) {
      if (generation === requestedGeneration) { stop(generation); status('capture-error', { reason: String(error.message || error).slice(0, 240) }); }
    } finally { starting = false; }
  }

  function preview() {
    if (!stream || video.readyState < 2 || !video.videoWidth || !video.videoHeight) { bridge.sendPreview({ generation, dataUrl: null }); return; }
    try {
      if (!previewCanvas) previewCanvas = document.createElement('canvas');
      const scale = Math.min(1, 640 / video.videoWidth, 640 / video.videoHeight);
      previewCanvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      previewCanvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      previewCanvas.getContext('2d', { alpha: false }).drawImage(video, 0, 0, previewCanvas.width, previewCanvas.height);
      bridge.sendPreview({ generation, timestamp: Date.now(), width: previewCanvas.width, height: previewCanvas.height, originalSize: { width: video.videoWidth, height: video.videoHeight }, dataUrl: previewCanvas.toDataURL('image/jpeg', 0.6) });
    } catch (_) { bridge.sendPreview({ generation, dataUrl: null }); }
  }

  bridge.onCommand((command) => {
    if (!command || !Number.isInteger(command.generation)) return;
    if (command.type === 'start') void start(command);
    else if (command.type === 'stop') stop(command.generation);
    else if (command.type === 'configure' && command.generation === generation) {
      const nextPhase = command.capturePhase === 'draft' || command.drafting === true ? 'draft' : 'game';
      if (capturePhase !== nextPhase || JSON.stringify(settings) !== JSON.stringify(command.calibration || {})) lastRosterAt = 0;
      capturePhase = nextPhase;
      settings = command.calibration || {};
      rosterConfirmed = command.rosterConfirmed === true;
      const nextInterval = clamp(Number(command.intervalMs) || 2500, 2000, 15000);
      if (nextInterval !== intervalMs) { intervalMs = nextInterval; schedule(); }
    }
    else if (command.type === 'preview' && command.generation === generation) preview();
    else if (command.type === 'ack' && command.generation === generation && command.sequence === outstanding) outstanding = null;
  });
  window.addEventListener('pagehide', () => stop(generation));
  status('ready');
})();
