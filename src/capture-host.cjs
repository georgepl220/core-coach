'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DISCOVERY_INTERVAL_MS, normalizeCaptureConfig, selectCaptureSource, validateRegionFrame } = require('./capture-policy.cjs');

let nextHostId = 0;

/**
 * Persistent, isolated, low-FPS Dota capture. Calling update while disabled does
 * no source discovery and creates no BrowserWindow. onFrame's Promise is the
 * backpressure acknowledgement, so slow vision never queues pixel buffers.
 */
class ScreenCaptureHost {
  constructor({ electron, onFrame, onStatus, onPreview, directory = __dirname, discoveryIntervalMs = DISCOVERY_INTERVAL_MS, fixtureSourceId = null } = {}) {
    if (!electron?.BrowserWindow || !electron.desktopCapturer || !electron.ipcMain || !electron.session) throw new TypeError('Capture host needs the Electron main-process APIs');
    this.electron = electron;
    this.onFrame = typeof onFrame === 'function' ? onFrame : async () => {};
    this.onStatus = typeof onStatus === 'function' ? onStatus : () => {};
    this.onPreview = typeof onPreview === 'function' ? onPreview : () => {};
    this.directory = directory;
    this.captureUrl = pathToFileURL(path.join(directory, 'capture.html')).href;
    this.discoveryIntervalMs = Math.max(DISCOVERY_INTERVAL_MS, Number(discoveryIntervalMs) || DISCOVERY_INTERVAL_MS);
    // Fixtures are opt-in constructor input for the smoke test, never a setting.
    this.fixtureSourceId = fixtureSourceId;
    this.id = ++nextHostId;
    this.config = normalizeCaptureConfig();
    this.generation = 0;
    this.window = null;
    this.selectedSource = null;
    this.ready = false;
    this.creating = null;
    this.discovering = false;
    this.processing = false;
    this.destroyed = false;
    this.timer = null;
    this.lastDiscoveryAt = 0;
    this.stats = { discoveries: 0, frames: 0, bytes: 0, captureFps: null };
    this.channels = Object.fromEntries(['command', 'frame', 'status', 'preview'].map((name) => [name, `wk-capture:${this.id}:${name}`]));
    this.frameListener = (event, packet) => { void this._acceptFrame(event, packet); };
    this.statusListener = (event, status) => this._acceptStatus(event, status);
    this.previewListener = (event, preview) => this._acceptPreview(event, preview);
    this.lastPreviewRequestAt = 0;
    this.previewPending = false;
    this.displayGrantPending = false;
    electron.ipcMain.on(this.channels.frame, this.frameListener);
    electron.ipcMain.on(this.channels.status, this.statusListener);
    electron.ipcMain.on(this.channels.preview, this.previewListener);
  }

  _isTrustedContents(contents) {
    return !!this.window && !this.window.isDestroyed() && contents === this.window.webContents && !contents.isDestroyed() && contents.getURL() === this.captureUrl;
  }

  _notify(state, detail = {}) {
    try {
      this.onStatus({ state, enabled: this.config.enabled, active: !!this.selectedSource, capturePhase: this.config.capturePhase, sourceType: this.config.sourceMode === 'monitor' ? 'screen' : 'window', sourceName: this.selectedSource?.name || null, intervalMs: this.config.intervalMs, ...this.stats, ...detail });
    } catch (_) { /* UI diagnostics must not break capture cleanup. */ }
  }

  _send(command) {
    if (this.ready && this.window && !this.window.isDestroyed()) this.window.webContents.send(this.channels.command, { generation: this.generation, ...command });
  }

  async update(value = {}) {
    if (this.destroyed) return;
    const next = normalizeCaptureConfig(value);
    const changedSource = next.sourceMode !== this.config.sourceMode || next.monitorId !== this.config.monitorId;
    const wasEnabled = this.config.enabled;
    const changedSettings = next.capturePhase !== this.config.capturePhase || next.intervalMs !== this.config.intervalMs || next.rosterConfirmed !== this.config.rosterConfirmed || JSON.stringify(next.calibration) !== JSON.stringify(this.config.calibration);
    this.config = next;
    if (!next.enabled) {
      if (wasEnabled || this.window || this.selectedSource) this._stopStream('inactive', true);
      return;
    }
    if (changedSource) this._stopStream('source-changed', true);
    if (!wasEnabled || changedSource) this.lastDiscoveryAt = 0;
    if (this.selectedSource) {
      if (changedSettings) this._send({ type: 'configure', capturePhase: this.config.capturePhase, calibration: this.config.calibration, intervalMs: this.config.intervalMs, rosterConfirmed: this.config.rosterConfirmed });
      return;
    }
    await this._discover();
  }

  _scheduleDiscovery() {
    clearTimeout(this.timer);
    if (!this.config.enabled || this.destroyed || this.selectedSource) { this.timer = null; return; }
    const delay = Math.max(100, this.discoveryIntervalMs - (Date.now() - this.lastDiscoveryAt));
    this.timer = setTimeout(() => { this.timer = null; void this._discover(); }, delay);
    this.timer.unref?.();
  }

  async _discover() {
    if (this.destroyed || !this.config.enabled || this.selectedSource || this.discovering) return;
    if (this.lastDiscoveryAt && Date.now() - this.lastDiscoveryAt < this.discoveryIntervalMs) { this._scheduleDiscovery(); return; }
    this.discovering = true;
    this.lastDiscoveryAt = Date.now();
    const generation = this.generation;
    const mode = this.config.sourceMode;
    this.stats.discoveries++;
    try {
      // Electron explicitly recommends zero thumbnail size to avoid capturing
      // every application's content just to enumerate window names and IDs.
      const sources = await this.electron.desktopCapturer.getSources({ types: mode === 'monitor' ? ['screen'] : ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
      if (this.destroyed || !this.config.enabled || generation !== this.generation || mode !== this.config.sourceMode) return;
      const primary = this.electron.screen?.getPrimaryDisplay?.().id;
      const source = this.fixtureSourceId ? sources.find((entry) => entry.id === this.fixtureSourceId) : selectCaptureSource(sources, this.config, primary);
      if (!source) { this._notify('waiting-source', { reason: mode === 'monitor' ? 'The explicitly selected monitor is unavailable' : 'Dota 2 window is not available' }); return; }
      this.selectedSource = source;
      await this._ensureWindow();
      if (this.destroyed || !this.config.enabled || generation !== this.generation || this.selectedSource !== source) return;
      this.displayGrantPending = true;
      this._send({ type: 'start', capturePhase: this.config.capturePhase, calibration: this.config.calibration, intervalMs: this.config.intervalMs, rosterConfirmed: this.config.rosterConfirmed });
      this._notify('starting');
    } catch (error) {
      if (!this.destroyed && this.config.enabled && generation === this.generation) {
        this.selectedSource = null;
        this._notify('capture-error', { reason: String(error.message || error).slice(0, 240) });
      }
    } finally { this.discovering = false; this._scheduleDiscovery(); }
  }

  async _ensureWindow() {
    if (this.window && !this.window.isDestroyed() && this.ready) return;
    if (this.creating) return this.creating;
    this.creating = this._createWindow();
    try { await this.creating; } finally { this.creating = null; }
  }

  async _createWindow() {
    const captureSession = this.electron.session.fromPartition(`wk-capture-${this.id}`);
    captureSession.setPermissionRequestHandler((contents, permission, callback, details = {}) => {
      // Electron 44 reports an empty mediaTypes list for getDisplayMedia. That
      // grant is allowed only during our selected-source acquisition; the
      // display request handler below still denies every audio request.
      const videoOnly=Array.isArray(details.mediaTypes)?details.mediaTypes.every(type=>type==='video')&&(details.mediaTypes.length>0||this.displayGrantPending):this.displayGrantPending;
      const allowed=this.config.enabled&&!!this.selectedSource&&this._isTrustedContents(contents)&&details.isMainFrame!==false&&(!details.requestingUrl||details.requestingUrl===this.captureUrl)&&(permission==='display-capture'||permission==='media'&&videoOnly);
      if(!allowed)this._notify('permission-denied',{reason:`Denied ${permission} permission for capture renderer (${JSON.stringify(details.mediaTypes||[])})`});
      callback(allowed);
    });
    captureSession.setPermissionCheckHandler((contents, permission, _origin, details = {}) => {
      const videoOnly=details.mediaType==='video'||this.displayGrantPending&&(!details.mediaType||details.mediaType==='unknown');
      const allowed=this.config.enabled&&!!this.selectedSource&&this._isTrustedContents(contents)&&details.isMainFrame!==false&&(!details.requestingUrl||details.requestingUrl===this.captureUrl)&&(permission==='display-capture'||permission==='media'&&videoOnly);
      if(!allowed)this._notify('permission-denied',{reason:`Denied ${permission} permission check for capture renderer`});
      return allowed;
    });
    captureSession.setDisplayMediaRequestHandler((request, callback) => {
      const trusted = this.window && !this.window.isDestroyed() && request.frame === this.window.webContents.mainFrame && request.frame?.url === this.captureUrl;
      this.displayGrantPending=false;
      if (!trusted || !this.config.enabled || !this.selectedSource || request.audioRequested || !request.videoRequested) { this._notify('permission-denied',{reason:`Capture source request denied: trusted=${!!trusted},audio=${!!request.audioRequested},video=${!!request.videoRequested}`});callback(null); return; }
      callback({ video: this.selectedSource });
    }, { useSystemPicker: false });
    const window = new this.electron.BrowserWindow({
      width: 320, height: 240, show: false, skipTaskbar: true,
      webPreferences: { session: captureSession, preload: path.join(this.directory, 'capture-preload.cjs'), additionalArguments: [`--wk-capture-id=${this.id}`], nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false },
    });
    this.window = window;
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (url !== this.captureUrl) event.preventDefault(); });
    window.webContents.on('render-process-gone', (_event, detail) => {
      if (this.window === window && !this.destroyed) { this._stopStream('capture-error', true); this._notify('capture-error', { reason: `Capture renderer exited (${detail.reason})` }); this._scheduleDiscovery(); }
    });
    window.on('closed', () => { if (this.window === window) { this.window = null; this.ready = false; } });
    await window.loadFile(path.join(this.directory, 'capture.html'));
    if (this.window !== window || window.isDestroyed()) return;
    this.ready = true;
    if (!this.config.enabled || this.destroyed) this._stopStream('inactive', true);
  }

  async _acceptFrame(event, packet) {
    if (!this._isTrustedContents(event.sender) || !this.config.enabled || !this.selectedSource || packet?.generation !== this.generation || !Number.isInteger(packet.sequence)) return;
    if ((packet.capturePhase || 'game') !== this.config.capturePhase) { this._send({ type: 'ack', sequence: packet.sequence }); return; }
    // An old worker may still be finishing after capture was stopped/restarted.
    // Drop and acknowledge the new packet rather than deadlocking its renderer.
    if (this.processing) { this._send({ type: 'ack', sequence: packet.sequence }); return; }
    const invalid = validateRegionFrame(packet);
    if (invalid) { this._notify('capture-error', { reason: invalid }); this._send({ type: 'ack', sequence: packet.sequence }); return; }
    this.processing = true;
    const generation = this.generation;
    this.stats.frames++;
    this.stats.bytes = packet.regions.reduce((sum, region) => sum + region.data.byteLength, 0);
    try {
      await this.onFrame({ ...packet, sourceName: this.selectedSource.name, sourceType: this.config.sourceMode === 'monitor' ? 'screen' : 'window' });
    } catch (error) { this._notify('analysis-error', { reason: String(error.message || error).slice(0, 240) }); }
    finally {
      this.processing = false;
      if (generation === this.generation) this._send({ type: 'ack', sequence: packet.sequence });
    }
  }

  _acceptStatus(event, status) {
    if (!this._isTrustedContents(event.sender) || !status || status.generation !== this.generation) return;
    if (status.state === 'streaming') { this.stats.captureFps = Number(status.frameRate) || null; this._notify('streaming', { width: status.width, height: status.height }); }
    else if (status.state === 'source-ended' || status.state === 'capture-error') {
      this._stopStream(status.state, false);
      this.lastDiscoveryAt = Date.now();
      this._notify(status.state, { reason: status.reason || 'Selected capture source ended' });
      this._scheduleDiscovery();
    } else if (status.state !== 'ready') this._notify(status.state, { reason: status.reason });
  }

  requestPreview() {
    if (!this.config.enabled || !this.selectedSource || !this.ready || this.previewPending || Date.now() - this.lastPreviewRequestAt < 5000) return false;
    this.lastPreviewRequestAt = Date.now();
    this.previewPending = true;
    this._send({ type: 'preview' });
    return true;
  }

  _acceptPreview(event, preview) {
    if (!this._isTrustedContents(event.sender) || !this.config.enabled || !this.previewPending || preview?.generation !== this.generation) return;
    this.previewPending = false;
    if (typeof preview.dataUrl !== 'string' || !preview.dataUrl.startsWith('data:image/jpeg;base64,') || preview.dataUrl.length > 700000 || !Number.isInteger(preview.width) || preview.width < 1 || preview.width > 640 || !Number.isInteger(preview.height) || preview.height < 1 || preview.height > 640) return;
    try { this.onPreview(preview); } catch (_) { /* A preview cannot break the capture lifecycle. */ }
  }

  _stopStream(state, releaseWindow) {
    clearTimeout(this.timer); this.timer = null;
    this.generation++;
    this._send({ type: 'stop' });
    this.selectedSource = null;
    this.previewPending = false;
    this.displayGrantPending = false;
    this.stats.captureFps = null;
    if (releaseWindow && this.window && !this.window.isDestroyed()) { const window = this.window; this.window = null; this.ready = false; window.destroy(); }
    this._notify(state);
  }

  stop() {
    this.config = normalizeCaptureConfig({ ...this.config, enabled: false });
    this._stopStream('inactive', true);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop();
    this.electron.ipcMain.removeListener(this.channels.frame, this.frameListener);
    this.electron.ipcMain.removeListener(this.channels.status, this.statusListener);
    this.electron.ipcMain.removeListener(this.channels.preview, this.previewListener);
  }
}

module.exports = { ScreenCaptureHost };
