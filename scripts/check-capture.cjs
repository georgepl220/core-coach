'use strict';

// Opt-in local diagnostics. Run with Electron, never Electron-as-Node. Captures
// the selected primary display briefly; writes numeric metrics, never images.
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const electron = require('electron');
const { app, desktopCapturer, nativeImage, screen } = electron;
const { ScreenCaptureHost } = require('../src/capture-host.cjs');
const ROOT = path.resolve(__dirname, '..');
const report = { measuredAt: new Date().toISOString(), electron: process.versions.electron, scope: 'primary-display', frameLimit: '1 FPS / 1280 × 720', samples: [], frames: [], statuses: [] };
let host, worker;
let timeout;
app.on('window-all-closed', () => {});
const pending = new Map();
let nextRequest = 0;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function finish(error) {
  clearTimeout(timeout);
  host?.destroy();
  if (worker) await worker.terminate();
  if (error) report.error = error.stack || String(error);
  const mean = values => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 100) / 100 : null;
  report.summary = { frames: report.frames.length, averageCaptureMs: mean(report.frames.map(frame => frame.captureMs)), averageAnalysisMs: mean(report.frames.map(frame => frame.analysisMs)), averageRoiBytes: mean(report.frames.map(frame => frame.roiBytes)), fullFrameBytes: 1280 * 720 * 4 };
  for (const phase of ['idle', 'active', 'stopped']) {
    const samples = report.samples.filter(sample => sample.phase === phase);
    report.summary[phase] = { averageCpuPercent: mean(samples.map(sample => sample.cpuPercent)), averageWorkingSetMiB: mean(samples.map(sample => sample.workingSetMiB)) };
  }
  const artifact = path.join(ROOT, 'artifacts', 'capture-performance.json');
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  fs.writeFileSync(artifact, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ path: artifact, summary: report.summary, captureStatus: report.statuses.at(-1), error: report.error }, null, 2));
  app.exit(error ? 1 : 0);
}

async function samples(phase, seconds) {
  for (let second = 0; second < seconds; second++) {
    await sleep(1000);
    const metrics = app.getAppMetrics();
    report.samples.push({ phase, second, cpuPercent: metrics.reduce((sum, metric) => sum + Math.max(0,metric.cpu.percentCPUUsage), 0), workingSetMiB: metrics.reduce((sum, metric) => sum + metric.memory.workingSetSize / 1024, 0), processes: metrics.length });
  }
}

app.whenReady().then(async () => {
  timeout = setTimeout(() => { void finish(new Error('Capture smoke test timed out')); }, 40000);
  try {
    await samples('idle', 3);
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'assets', 'manifest.json'), 'utf8'));
    const templates = { portraits: [], minimap: [] };
    for (const kind of ['portraits', 'minimap']) for (const entry of manifest[kind] || []) {
      const image = nativeImage.createFromPath(path.join(ROOT, 'data', 'assets', entry.file));
      if (!image.isEmpty()) templates[kind].push({ id: entry.heroId, name: entry.localizedName || entry.name, ...image.getSize(), data: image.toBitmap() });
    }
    worker = new Worker(path.join(ROOT, 'src', 'vision-worker.cjs'));
    worker.on('message', message => { const request = pending.get(message.id); if (!request) return; pending.delete(message.id); message.error ? request.reject(new Error(message.error)) : request.resolve(message.result); });
    worker.on('error', error => { for (const request of pending.values()) request.reject(error); pending.clear(); });
    worker.postMessage({ kind: 'templates', templates });
    let previous = null;
    host = new ScreenCaptureHost({ electron, onStatus: status => report.statuses.push({ ...status, timestamp: Date.now() }), onFrame: async packet => {
      const started = performance.now();
      const id = ++nextRequest;
      const analyzed = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      const transfers = packet.regions.map(region => region.data instanceof ArrayBuffer ? region.data : region.data.buffer);
      worker.postMessage({ kind: 'regions', id, frame: packet, settings: { playerTeam: 'radiant', selfHeroId: 42 }, previous }, transfers);
      const result = await analyzed;
      previous = result.state;
      report.frames.push({ timestamp: packet.timestamp, size: packet.originalSize, roiBytes: packet.diagnostics.roiBytes, captureMs: packet.diagnostics.captureMs, analysisMs: Math.round((performance.now() - started) * 10) / 10, rosterRefreshed: result.diagnostics.rosterRefreshed, templates: result.diagnostics.templateCount });
    } });
    const discoveryStarted = performance.now();
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
    report.zeroThumbnailDiscoveryMs = Math.round((performance.now() - discoveryStarted) * 10) / 10;
    report.displaySources = sources.length;
    await host.update({ enabled: true, sourceMode: 'monitor', monitorId: String(screen.getPrimaryDisplay().id), intervalMs: 3000, rosterConfirmed: true });
    await samples('active', 12);
    host.stop();
    await samples('stopped', 3);
    if (!report.frames.length) throw new Error('No region frame captured; see statuses');
    await finish();
  } catch (error) { await finish(error); }
});

