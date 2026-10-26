'use strict';
// Motore: gestisce tutti i flussi, gli allarmi, il log eventi, le notifiche
// ed espone API REST + WebSocket + interfaccia web.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');
const { Store } = require('./store');
const { spawn } = require('child_process');
const { StreamMonitor, STATE, FFMPEG, inputArgs, streamOptions } = require('./monitor');
const { resolveStream, findYtDlp } = require('./resolve');
const { sendAll } = require('./notifier');
const { describe } = require('./i18n');
const transfer = require('./transfer');
const pkg = require('../../package.json');

const UI_DIR = path.join(__dirname, '..', '..', 'ui');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

const ABOUT = {
  app: 'TRIP Streaming Monitor',
  get ytdlp() { return !!findYtDlp(); },
  version: pkg.version,
  author: 'Massimiliano Mascioli Trippa',
  email: 'max@maxtrip.it'
};

class Engine extends EventEmitter {
  constructor({ dataDir, port, host }) {
    super();
    this.store = new Store(dataDir);
    this.port = Number(port || process.env.PORT || this.store.settings.port || 8686);
    this.hostOverride = host || process.env.HOST || null;
    this.monitors = new Map();
    this.clients = new Set();
    this.listenErrors = new Map();
  }

  // ---------- flussi ----------
  _options(stream) {
    return () => {
      const s = this.store.settings;
      return {
      silenceThresholdDb: stream.silenceThresholdDb ?? s.silenceThresholdDb,
      silenceSeconds: stream.silenceSeconds ?? s.silenceSeconds,
      offAirSeconds: stream.offAirSeconds ?? s.offAirSeconds,
      recoverSeconds: s.recoverSeconds
      };
    };
  }

  _attach(stream) {
    const m = new StreamMonitor(stream, this._options(stream));
    m.on('state', () => this._broadcastStream(m));
    m.on('event', ev => this._onMonitorEvent(m, ev));
    m.on('info', () => this._broadcastStream(m));
    this.monitors.set(stream.id, m);
    if (stream.enabled && stream.url) m.start();
    return m;
  }

  _detach(id) {
    const m = this.monitors.get(id);
    if (m) { m.removeAllListeners(); m.stop(); this.monitors.delete(id); }
  }

  _onMonitorEvent(m, ev) {
    const full = { ...ev, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      streamId: m.stream.id, name: m.stream.name, url: m.stream.url, time: Date.now() };
    if (ev.type === 'online') return; // prima connessione: nessun allarme
    const { title, body } = describe(full, this.store.settings.language);
    full.title = title; full.message = body;
    if (ev.type === 'offair' || ev.type === 'silence') {
      m.alarm = { type: ev.type, time: full.time, acknowledged: false };
    } else if (ev.type === 'recovered') {
      if (m.alarm) m.alarm = { ...m.alarm, recovered: true, acknowledged: true };
    }
    this.store.addEvent(full);
    this._broadcast({ type: 'event', event: full });
    this._broadcastStream(m);
    this.emit('alarm', full);
    const st = this.store.settings;
    if (ev.type !== 'recovered' || st.notifyOnRecovery) {
      sendAll(full, st, this._notifyCtx()).then(r => {
        const failed = r.filter(x => !x.ok);
        if (failed.length) console.warn('[notify]', JSON.stringify(failed));
      });
    }
  }

  _notifyCtx() {
    return {
      devices: this.store.devices,
      onInvalidDevices: tokens => {
        // token non più validi (app disinstallata, permessi revocati): vengono rimossi
        if (this.store.removeDevices(d => tokens.includes(d.token))) this._broadcastState();
      }
    };
  }

  start() {
    for (const s of this.store.streams) this._attach(s);
    this._levelTimer = setInterval(() => this._broadcastLevels(), 100);
    return this._listen();
  }

  stop() {
    clearInterval(this._levelTimer);
    for (const id of [...this.monitors.keys()]) this._detach(id);
    if (this.wss) this.wss.close();
    if (this.server) this.server.close();
  }

  addStream(data, keepId) {
    const s = this.store.addStream(data, keepId);
    this._attach(s);
    this._broadcastState();
    return s;
  }

  updateStream(id, data) {
    const s = this.store.updateStream(id, data);
    if (!s) return null;
    this._detach(id);
    this._attach(s);
    this._broadcastState();
    return s;
  }

  removeStream(id) {
    this._detach(id);
    const ok = this.store.removeStream(id);
    this._broadcastState();
    return ok;
  }

  acknowledge(id) {
    const list = id ? [this.monitors.get(id)].filter(Boolean) : [...this.monitors.values()];
    for (const m of list) if (m.alarm) m.alarm = { ...m.alarm, acknowledged: true };
    this._broadcastState();
  }

  state() {
    return {
      about: ABOUT,
      settings: this.store.settings,
      devices: this.store.devices.map(({ id, platform, name, lang, addedAt, lastSeen, token }) =>
        ({ id, platform, name, lang, addedAt, lastSeen, tokenTail: token.slice(-12) })),
      streams: this.store.streams.map(s => {
        const m = this.monitors.get(s.id);
        return m ? m.snapshot() : { ...s, state: STATE.STOPPED };
      })
    };
  }

  // ---------- WebSocket ----------
  _broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) if (ws.readyState === 1) ws.send(data);
  }
  _broadcastState() { this._broadcast({ type: 'state', state: this.state() }); }
  _broadcastStream(m) { this._broadcast({ type: 'stream', stream: m.snapshot() }); }
  _broadcastLevels() {
    if (!this.clients.size) return;
    const lv = {};
    for (const [id, m] of this.monitors) {
      const l = m.levels;
      lv[id] = [l.peakL, l.peakR, l.rmsL, l.rmsR].map(x => Math.round(x * 10) / 10);
    }
    this._broadcast({ type: 'levels', levels: lv });
  }

  // ---------- HTTP ----------
  _isLocal(req) {
    const a = req.socket.remoteAddress || '';
    return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  }

  _authorized(req, url) {
    if (this._isLocal(req)) return true;
    const tok = this.store.settings.accessToken;
    if (!tok) return false; // accesso remoto senza token non consentito
    const h = req.headers.authorization || '';
    const given = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token');
    return given === tok;
  }

  _listen() {
    const host = this.hostOverride || (this.store.settings.remoteAccess ? '0.0.0.0' : '127.0.0.1');
    this.server = http.createServer((req, res) => this._handle(req, res).catch(e => {
      this._json(res, 500, { error: e.message });
    }));
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, sock, head) => {
      const url = new URL(req.url, 'http://x');
      if (url.pathname !== '/ws' || !this._authorized(req, url)) { sock.destroy(); return; }
      this.wss.handleUpgrade(req, sock, head, ws => {
        this.clients.add(ws);
        ws.on('close', () => this.clients.delete(ws));
        ws.on('error', () => this.clients.delete(ws));
        ws.send(JSON.stringify({ type: 'state', state: this.state() }));
        ws.send(JSON.stringify({ type: 'events', events: this.store.events.slice(-200) }));
      });
    });
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, host, () => {
        console.log(`[engine] ${ABOUT.app} v${ABOUT.version} — http://${host}:${this.port}  (ffmpeg: ${FFMPEG})`);
        resolve({ host, port: this.port });
      });
    });
  }

  _relisten() {
    // cambia l'interfaccia di ascolto (solo locale / rete) senza riavviare l'app
    setTimeout(() => {
      for (const ws of this.clients) ws.terminate();
      this.server.close();
      this.server.closeAllConnections && this.server.closeAllConnections();
      this.wss.close();
      this._listen().catch(e => console.error('[engine] relisten', e.message));
    }, 300);
  }

  /**
   * Ascolto: FFmpeg legge il flusso (qualsiasi formato, playlist comprese) e lo
   * converte in MP3, riproducibile da desktop, app mobile e browser.
   */
  async _serveListen(req, res, id) {
    const mon = this.monitors.get(id);
    if (!mon) return this._json(res, 404, { error: 'not found' });
    this.listenErrors.delete(id);
    // riusa il link già risolto dal monitor (se recente), altrimenti lo risolve ora
    let url, opts = streamOptions(mon.stream);
    if (mon.current && mon.gotData && Date.now() - mon.current.at < 10 * 60000) ({ url, opts } = mon.current);
    else {
      const r = await resolveStream(mon.stream.url, opts);
      if (r.error && (r.kind === 'html' || r.kind === 'site')) {
        this.listenErrors.set(id, r.error);
        return this._json(res, 502, { error: r.error });
      }
      url = r.url;
    }
    if (res.destroyed) return;
    const ff = spawn(FFMPEG, [...inputArgs(url, opts), '-vn', '-sn', '-dn', '-ac', '2', '-ar', '44100',
      '-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let err = '', started = false;
    const fail = msg => {
      this.listenErrors.set(id, msg);
      if (!res.headersSent) this._json(res, 502, { error: msg });
      else res.end();
    };
    const timer = setTimeout(() => { if (!started) { fail('timeout'); ff.kill('SIGKILL'); } }, 20000);
    ff.on('error', e => fail(e.code === 'ENOENT' ? 'FFmpeg not found' : e.message));
    ff.stderr.on('data', d => { err = (err + d).slice(-4000); });
    ff.stdout.on('data', chunk => {
      if (!started) {
        started = true;
        clearTimeout(timer);
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', ...CORS });
      }
      res.write(chunk);
    });
    ff.on('close', () => {
      clearTimeout(timer);
      const errLine = err.split(/\r?\n/).filter(l => /\[(error|fatal)\]/.test(l)).pop();
      if (!started) fail((errLine || err.trim().split(/\r?\n/).pop() || 'stream unavailable').replace(/^.*\[(error|fatal)\]\s*/, ''));
      else res.end();
    });
    res.on('close', () => { clearTimeout(timer); ff.kill('SIGKILL'); });
  }

  _json(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify(obj));
  }

  async _body(req) {
    let data = '';
    for await (const c of req) { data += c; if (data.length > 5e6) throw new Error('too large'); }
    return data ? JSON.parse(data) : {};
  }

  async _handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

    if (p.startsWith('/api/')) {
      if (p === '/api/info') return this._json(res, 200, ABOUT);
      if (!this._authorized(req, url)) return this._json(res, 401, { error: 'unauthorized' });
      const m = p.match(/^\/api\/streams\/([\w-]+)(\/ack|\/restart|\/listen|\/listen-error|\/thumb)?$/);

      if (p === '/api/state' && req.method === 'GET') return this._json(res, 200, this.state());
      if (p === '/api/events' && req.method === 'GET') return this._json(res, 200, this.store.events);
      if (p === '/api/events' && req.method === 'DELETE') {
        this.store.clearEvents();
        this._broadcast({ type: 'events', events: [] });
        return this._json(res, 200, { ok: true });
      }
      if (p === '/api/streams/order' && req.method === 'PUT') {
        const { ids } = await this._body(req);
        if (!Array.isArray(ids)) return this._json(res, 400, { error: 'ids required' });
        this.store.reorder(ids.map(String));
        this._broadcastState();
        return this._json(res, 200, { ok: true });
      }
      if (p === '/api/streams' && req.method === 'POST') {
        const b = await this._body(req);
        if (!b.url) return this._json(res, 400, { error: 'url required' });
        return this._json(res, 201, this.addStream(b));
      }
      if (p === '/api/devices' && req.method === 'POST') {
        const d = this.store.registerDevice(await this._body(req));
        if (!d) return this._json(res, 400, { error: 'token/platform required' });
        this._broadcastState();
        return this._json(res, 200, { id: d.id });
      }
      const dm = p.match(/^\/api\/devices\/([\w-]+)$/);
      if (dm && req.method === 'DELETE') {
        const n = this.store.removeDevices(d => d.id === dm[1]);
        this._broadcastState();
        return this._json(res, n ? 200 : 404, { ok: !!n });
      }
      // ---------- esportazione / importazione dei flussi ----------
      if (p === '/api/export' && req.method === 'GET') {
        const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
        const data = transfer.buildExport(this.store.streams, ids, ABOUT);
        const name = `TRIP-Streaming-Monitor-${new Date().toISOString().slice(0, 10)}-${data.count}.json`;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, ...CORS });
        return res.end(JSON.stringify(data, null, 2));
      }
      if (p === '/api/import/preview' && req.method === 'POST') {
        const { text } = await this._body(req);
        const parsed = transfer.parseImportFile(text);
        return this._json(res, 200, { source: parsed.source, errors: parsed.errors, items: transfer.analyzeImport(this.store.streams, parsed.streams) });
      }
      if (p === '/api/import/apply' && req.method === 'POST') {
        const { decisions } = await this._body(req);
        const summary = transfer.applyImport({
          streams: () => this.store.streams,
          addStream: (d, keepId) => this.addStream(d, keepId),
          updateStream: (id, d) => this.updateStream(id, d),
          removeStream: id => this.removeStream(id)
        }, decisions);
        return this._json(res, 200, { summary });
      }
      if (p === '/api/ack' && req.method === 'POST') { this.acknowledge(null); return this._json(res, 200, { ok: true }); }
      if (m && m[2] === '/ack' && req.method === 'POST') { this.acknowledge(m[1]); return this._json(res, 200, { ok: true }); }
      if (m && m[2] === '/listen' && req.method === 'GET') return this._serveListen(req, res, m[1]);
      if (m && m[2] === '/thumb' && req.method === 'GET') {
        const mon = this.monitors.get(m[1]);
        if (!mon || !mon.thumb) { res.writeHead(404, CORS); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', ...CORS });
        return res.end(mon.thumb);
      }
      if (m && m[2] === '/listen-error' && req.method === 'GET') {
        return this._json(res, 200, { error: this.listenErrors.get(m[1]) || '' });
      }
      if (m && m[2] === '/restart' && req.method === 'POST') {
        const mon = this.monitors.get(m[1]);
        if (mon && mon.stream.enabled) mon.restart();
        return this._json(res, 200, { ok: !!mon });
      }
      if (m && !m[2] && req.method === 'PUT') {
        const s = this.updateStream(m[1], await this._body(req));
        return s ? this._json(res, 200, s) : this._json(res, 404, { error: 'not found' });
      }
      if (m && !m[2] && req.method === 'DELETE') {
        return this.removeStream(m[1]) ? this._json(res, 200, { ok: true }) : this._json(res, 404, { error: 'not found' });
      }
      if (p === '/api/settings' && req.method === 'PUT') {
        const b = await this._body(req);
        const before = this.store.settings;
        const s = this.store.updateSettings(b);
        this._broadcastState();
        this.emit('settings', s);
        this._json(res, 200, { settings: s });
        if (before.remoteAccess !== s.remoteAccess && !this.hostOverride) this._relisten();
        return;
      }
      if (p === '/api/test-notify' && req.method === 'POST') {
        const results = await sendAll({ type: 'test', name: ABOUT.app, time: Date.now() }, this.store.settings, this._notifyCtx());
        this.emit('alarm', { type: 'test', ...describe({ type: 'test' }, this.store.settings.language) });
        return this._json(res, 200, { results });
      }
      return this._json(res, 404, { error: 'not found' });
    }

    // file statici dell'interfaccia
    let file = path.normalize(path.join(UI_DIR, p === '/' ? 'index.html' : decodeURIComponent(p)));
    if (!file.startsWith(UI_DIR)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization'
};

module.exports = { Engine, ABOUT };
