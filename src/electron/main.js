'use strict';
// App desktop (Windows / macOS / Linux): avvia il motore di monitoraggio e mostra l'interfaccia.
// Creato da Massimiliano Mascioli Trippa — max@maxtrip.it
const { app, BrowserWindow, Notification, Tray, Menu, nativeImage, nativeTheme, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const { Engine } = require('../engine');

const ROOT = path.join(__dirname, '..', '..');
const L = {
  it: { show: 'Mostra', quit: 'Esci', running: 'Il monitoraggio continua in background.', author: 'Creato da Massimiliano Mascioli Trippa — max@maxtrip.it' },
  en: { show: 'Show', quit: 'Quit', running: 'Monitoring keeps running in the background.', author: 'Created by Massimiliano Mascioli Trippa — max@maxtrip.it' }
};

let engine, win, tray, quitting = false, trayHintShown = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(start);
}

const txt = () => L[engine && engine.store.settings.language === 'en' ? 'en' : 'it'];

// L'app si chiamava "MaxTrip Stream Monitor": al primo avvio con il nuovo nome
// si copiano flussi, impostazioni, dispositivi e registro eventi dalla vecchia cartella.
function migrateOldData() {
  const fs = require('fs');
  const dst = app.getPath('userData');
  const src = path.join(app.getPath('appData'), 'MaxTrip Stream Monitor');
  if (fs.existsSync(path.join(dst, 'config.json')) || !fs.existsSync(path.join(src, 'config.json'))) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const f of ['config.json', 'events.json', 'devices.json']) {
    try { fs.copyFileSync(path.join(src, f), path.join(dst, f)); } catch (_) { /* file assente */ }
  }
}

async function start() {
  if (process.platform === 'win32') app.setAppUserModelId('it.maxtrip.streammonitor');
  migrateOldData();
  engine = new Engine({ dataDir: app.getPath('userData') });
  try {
    await engine.start();
  } catch (e) {
    dialog.showErrorBox('TRIP Streaming Monitor', `Impossibile avviare il motore / Cannot start engine:\n${e.message}`);
    app.quit();
    return;
  }

  engine.on('alarm', ev => {
    if (!engine.store.settings.notify.desktop || !Notification.isSupported()) return;
    const n = new Notification({
      title: ev.title,
      body: ev.message || '',
      icon: path.join(ROOT, 'build', 'icon.png'),
      urgency: ev.type === 'offair' ? 'critical' : 'normal'
    });
    n.on('click', showWindow);
    n.show();
  });
  engine.on('settings', buildTray);

  createWindow();
  buildTray();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 380,
    minHeight: 500,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d1117' : '#f3f5f8',
    title: 'TRIP Streaming Monitor',
    icon: path.join(ROOT, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required', preload: path.join(__dirname, 'preload.js')
    }
  });
  win.loadURL(`http://127.0.0.1:${engine.port}/`);
  // esportazione dei flussi: finestra "Salva con nome", proposta nella cartella Documenti
  win.webContents.session.on('will-download', (e, item) => {
    item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('documents'), item.getFilename()) });
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${engine.port}`)) { e.preventDefault(); shell.openExternal(url); }
  });
  // Chiudere la finestra non ferma il monitoraggio: l'app resta nell'area di notifica.
  win.on('close', e => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!trayHintShown && Notification.isSupported()) {
      trayHintShown = true;
      new Notification({ title: 'TRIP Streaming Monitor', body: txt().running }).show();
    }
  });
}

// tema scelto nell'interfaccia: cornice della finestra e menu seguono la stessa scelta
ipcMain.on('theme', (e, mode) => {
  nativeTheme.themeSource = ['dark', 'light'].includes(mode) ? mode : 'system';
  if (win) win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#0d1117' : '#f3f5f8');
});

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function buildTray() {
  const img = nativeImage.createFromPath(path.join(ROOT, 'build', process.platform === 'darwin' ? 'tray.png' : 'icon.png'))
    .resize({ width: process.platform === 'darwin' ? 18 : 24 });
  if (!tray) {
    tray = new Tray(img);
    tray.on('click', showWindow);
  }
  tray.setToolTip('TRIP Streaming Monitor');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: txt().show, click: showWindow },
    { label: txt().author, enabled: false },
    { type: 'separator' },
    { label: txt().quit, click: () => { quitting = true; app.quit(); } }
  ]));
}

app.on('activate', showWindow);
app.on('before-quit', () => { quitting = true; if (engine) engine.stop(); });
app.on('window-all-closed', () => { /* resta attiva nella tray */ });
