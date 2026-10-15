'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const argument = process.argv.find((value) => /^--wk-capture-id=\d+$/.test(value));
const id = argument ? argument.slice('--wk-capture-id='.length) : 'invalid';
const channel = (name) => `wk-capture:${id}:${name}`;

contextBridge.exposeInMainWorld('captureBridge', {
  onCommand(callback) {
    if (typeof callback !== 'function') return;
    ipcRenderer.on(channel('command'), (_event, command) => callback(command));
  },
  sendFrame(frame) { ipcRenderer.send(channel('frame'), frame); },
  sendStatus(status) { ipcRenderer.send(channel('status'), status); },
  sendPreview(preview) { ipcRenderer.send(channel('preview'), preview); },
});
