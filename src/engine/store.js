'use strict';
// Persistenza della configurazione (flussi + impostazioni) su file JSON.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
    url: String(s.url || '').trim(),
    enabled: s.enabled !== false,
    silenceThresholdDb: numOrNull(s.silenceThresholdDb),
    silenceSeconds: numOrNull(s.silenceSeconds),
    offAirSeconds: numOrNull(s.offAirSeconds)
  };
}

module.exports = { Store, DEFAULT_SETTINGS };
