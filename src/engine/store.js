'use strict';
// Persistenza della configurazione (flussi + impostazioni) su file JSON.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeUrl } = require('./resolve');

const DEFAULT_SETTINGS = {
  language: 'it',
  silenceThresholdDb: -50,
  silenceSeconds: 10,
  offAirSeconds: 8,
  recoverSeconds: 3,
  alarmSound: true,
  notifyOnRecovery: true,
  remoteAccess: false,
  accessToken: '',
  port: 8686,
  notify: {
    desktop: true,
    mobile: {
      enabled: true,
      fcm: { serviceAccount: '' },
      apns: { keyId: '', teamId: '', bundleId: 'it.maxtrip.streammonitor', privateKey: '', production: true }
    },
    email: { enabled: false, host: '', port: 587, user: '', pass: '', from: '', to: '' },
    twilio: { enabled: false, accountSid: '', authToken: '', from: '', to: '' },
    discord: { enabled: false, url: '' },
    slack: { enabled: false, url: '' },
    ntfy: { enabled: false, server: 'https://ntfy.sh', topic: '', token: '' },
    telegram: { enabled: false, botToken: '', chatId: '' },
    pushover: { enabled: false, userKey: '', appToken: '' },
    webhook: { enabled: false, url: '' }
  }
};

function deepMerge(base, extra) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'config.json');
    this.eventsFile = path.join(dataDir, 'events.json');
    this.devicesFile = path.join(dataDir, 'devices.json');
    this.devices = [];
    this.settings = deepMerge(DEFAULT_SETTINGS, {});
    this.streams = [];
    this.events = [];
    this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.settings = deepMerge(DEFAULT_SETTINGS, raw.settings || {});
      this.streams = Array.isArray(raw.streams) ? raw.streams : [];
    } catch (_) { /* primo avvio */ }
    try {
      const dv = JSON.parse(fs.readFileSync(this.devicesFile, 'utf8'));
      if (Array.isArray(dv)) this.devices = dv;
    } catch (_) { /* nessun dispositivo */ }
    try {
      const ev = JSON.parse(fs.readFileSync(this.eventsFile, 'utf8'));
      if (Array.isArray(ev)) this.events = ev.slice(-500);
    } catch (_) { /* nessun log */ }
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ settings: this.settings, streams: this.streams }, null, 2));
    fs.renameSync(tmp, this.file);
  }

  saveEvents() {
    clearTimeout(this._evTimer);
    this._evTimer = setTimeout(() => {
      try { fs.writeFileSync(this.eventsFile, JSON.stringify(this.events.slice(-500))); } catch (_) {}
    }, 1000);
  }

  addEvent(ev) {
    this.events.push(ev);
    if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
    this.saveEvents();
  }

  clearEvents() {
    this.events = [];
    this.saveEvents();
  }

  updateSettings(patch) {
    this.settings = deepMerge(this.settings, patch || {});
    this.save();
    return this.settings;
  }

  // ---------- dispositivi mobili registrati per le notifiche push ----------
  saveDevices() {
    fs.writeFileSync(this.devicesFile, JSON.stringify(this.devices, null, 2));
  }

  registerDevice({ token, platform, name, lang }) {
    token = String(token || '').trim();
    if (!token || !['android', 'ios'].includes(platform)) return null;
    const now = Date.now();
    let d = this.devices.find(x => x.token === token);
    if (!d) {
      d = { id: crypto.randomUUID(), token, platform, addedAt: now };
      this.devices.push(d);
    }
    Object.assign(d, { platform, name: String(name || '').slice(0, 80), lang: lang === 'en' ? 'en' : 'it', lastSeen: now });
    this.saveDevices();
    return d;
  }

  removeDevices(pred) {
    const n = this.devices.length;
    this.devices = this.devices.filter(d => !pred(d));
    if (this.devices.length !== n) this.saveDevices();
    return n - this.devices.length;
  }

  addStream(data) {
    const s = sanitizeStream({ ...data, id: crypto.randomUUID() });
    this.streams.push(s);
    this.save();
    return s;
  }

  updateStream(id, data) {
    const i = this.streams.findIndex(s => s.id === id);
    if (i < 0) return null;
    this.streams[i] = sanitizeStream({ ...this.streams[i], ...data, id });
    this.save();
    return this.streams[i];
  }

  removeStream(id) {
    const n = this.streams.length;
    this.streams = this.streams.filter(s => s.id !== id);
    this.save();
    return this.streams.length !== n;
  }
}

function numOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function sanitizeStream(s) {
  return {
    id: s.id,
    name: String(s.name || '').trim().slice(0, 120) || 'Stream',
    url: normalizeUrl(s.url),
    enabled: s.enabled !== false,
    silenceThresholdDb: numOrNull(s.silenceThresholdDb),
    silenceSeconds: numOrNull(s.silenceSeconds),
    offAirSeconds: numOrNull(s.offAirSeconds),
    userAgent: String(s.userAgent || '').trim().slice(0, 300),
    headers: String(s.headers || '').trim().slice(0, 2000)
  };
}

module.exports = { Store, DEFAULT_SETTINGS };
