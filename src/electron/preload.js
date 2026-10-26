'use strict';
// Ponte minimo tra l'interfaccia e l'app desktop: tema della finestra (chiaro/scuro/automatico).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tripDesktop', {
  setTheme: mode => ipcRenderer.send('theme', mode)
});
