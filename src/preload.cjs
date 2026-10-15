'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('coach', {
  getState: () => ipcRenderer.invoke('coach:state'),
  updateSettings: value => ipcRenderer.invoke('coach:settings', value),
  command: (name, value) => ipcRenderer.invoke('coach:command', { name, value }),
  setOverlayHitAreas: value => ipcRenderer.send('coach:overlay-hit-areas',value),
  notifyOverlayPointer: () => ipcRenderer.send('coach:overlay-pointer'),
  onOverlayPicker: callback => {const listener=(_event,value)=>callback(value);ipcRenderer.on('coach:overlay-picker',listener);return()=>ipcRenderer.removeListener('coach:overlay-picker',listener);},
  onState: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('coach:state', listener); return () => ipcRenderer.removeListener('coach:state', listener); },
});
