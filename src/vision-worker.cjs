'use strict';
const { parentPort } = require('node:worker_threads');
const { analyzeScreen } = require('./vision.cjs');
const { analyzeRegions } = require('./vision-regions.cjs');
let templates = { portraits: [], minimap: [] };
parentPort.on('message', message => {
  if (message.kind === 'templates') { templates = message.templates; return; }
  if (!['analyze','regions'].includes(message.kind)) return;
  try { parentPort.postMessage({ id: message.id, result: message.kind==='regions'?analyzeRegions(message.frame,message.settings,templates,message.previous):analyzeScreen(message.frame, message.settings, templates, message.previous) }); }
  catch (error) { parentPort.postMessage({ id: message.id, error: error.message }); }
});
