'use strict';
// Monitor di un singolo flusso: decodifica l'audio con FFmpeg (qualsiasi formato:
// Icecast/Shoutcast MP3/AAC/OGG, HLS, DASH, RTMP, RTSP, SRT, flussi video web TV...)
// e calcola livelli di picco/RMS per canale, rilevando OFF AIR e SILENZIO.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { resolveStreamUrl } = require('./resolve');

const SAMPLE_RATE = 11025;
const CHANNELS = 2;
const WINDOW_FRAMES = Math.round(SAMPLE_RATE / 10); // 100 ms
const FLOOR_DB = -90;

const STATE = {
  STOPPED: 'stopped',
  CONNECTING: 'connecting',
  ON_AIR: 'onair',
  SILENCE: 'silence',
  OFF_AIR: 'offair'
};

function toDb(x) {
  if (x <= 0) return FLOOR_DB;
  return Math.max(FLOOR_DB, 20 * Math.log10(x));
}

function findInPath(name) {
  const fs = require('fs');
  const path = require('path');
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const f = path.join(dir, name);
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch (_) {}
  }
  return null;
}

function resolveFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  // Su Linux il binario statico di ffmpeg-static perde la risoluzione DNS (va in crash
  // con indirizzi come "radio.example.com"): si preferisce FFmpeg di sistema.
  if (process.platform === 'linux') {
    const sys = findInPath('ffmpeg');
    if (sys) return sys;
  }
  try {
    const p = require('ffmpeg-static');
    if (p) return p.replace('app.asar' + require('path').sep, 'app.asar.unpacked' + require('path').sep);
  } catch (_) { /* non installato */ }
  return 'ffmpeg';
}

const FFMPEG = resolveFfmpeg();

/** Opzioni di ingresso FFmpeg comuni a monitoraggio e ascolto. */
function inputArgs(url) {
  const a = ['-hide_banner', '-nostdin', '-loglevel', 'error'];
  if (/^https?:/i.test(url)) {
    a.push('-user_agent', 'MaxTripStreamMonitor/1.0', '-rw_timeout', '15000000');
  } else if (/^rtsp:/i.test(url)) {
    a.push('-rtsp_transport', 'tcp', '-timeout', '15000000');
  }
  a.push('-i', url);
  return a;
}

class StreamMonitor extends EventEmitter {
  /**
   * @param {object} stream  {id,name,url,...}
   * @param {() => object} getOptions  restituisce soglie effettive
   */
  constructor(stream, getOptions) {
    super();
    this.stream = stream;
    this.getOptions = getOptions;
    this.state = STATE.STOPPED;
    this.levels = { peakL: FLOOR_DB, peakR: FLOOR_DB, rmsL: FLOOR_DB, rmsR: FLOOR_DB };
    this.proc = null;
    this.running = false;
    this.lastError = '';
    this.since = Date.now();          // inizio stato corrente
    this.lastDataAt = 0;
    this.attemptStartedAt = 0;
    this.silentSince = 0;
    this.loudSince = 0;
    this.backoff = 1000;
    this.restartTimer = null;
    this.watchdog = null;
    this.bytesTotal = 0;
    this._buf = Buffer.alloc(0);
    this._acc = this._newAcc();
    this.alarm = null;                // allarme attivo non ancora tacitato
  }

  _newAcc() {
    return { n: 0, pkL: 0, pkR: 0, sqL: 0, sqR: 0 };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.attemptStartedAt = Date.now();
    this._setState(STATE.CONNECTING);
    this._spawn();
    this.watchdog = setInterval(() => this._tick(), 500);
  }

  stop() {
    this.running = false;
    this._gen = (this._gen || 0) + 1;
    clearTimeout(this.restartTimer);
    clearInterval(this.watchdog);
    this._kill();
    this.levels = { peakL: FLOOR_DB, peakR: FLOOR_DB, rmsL: FLOOR_DB, rmsR: FLOOR_DB };
    this.alarm = null;
    this._setState(STATE.STOPPED);
  }

  restart() {
    this.stop();
    this.start();
  }

  async _spawn() {
    if (!this.running) return;
    const gen = this._gen = (this._gen || 0) + 1;
    // risolve i link playlist (.pls/.m3u/...) a ogni tentativo: alcune radio ruotano i server
    const { url, playlist } = await resolveStreamUrl(this.stream.url);
    if (!this.running || gen !== this._gen) return;
    this.resolvedUrl = playlist ? url : null;
    let proc;
    try {
      proc = spawn(FFMPEG, [...inputArgs(url), '-vn', '-sn', '-dn', '-ac', String(CHANNELS), '-ar', String(SAMPLE_RATE),
        '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      this.lastError = e.message;
      return this._scheduleRestart();
    }
    this.proc = proc;
    this._buf = Buffer.alloc(0);
    proc.stdout.on('data', chunk => this._onPcm(chunk));
    proc.stderr.on('data', d => {
      const line = d.toString().trim().split(/\r?\n/).filter(Boolean).pop();
      if (line) this.lastError = line.slice(0, 300);
    });
    proc.on('error', e => {
      this.lastError = e.code === 'ENOENT' ? 'FFmpeg non trovato / FFmpeg not found' : e.message;
    });
    proc.on('close', (code, signal) => {
      if (signal === 'SIGSEGV') this.lastError = 'FFmpeg crash (SIGSEGV)' + (process.platform === 'linux' ? ' — sudo apt install ffmpeg' : '');
      if (this.proc === proc) this.proc = null;
      this._scheduleRestart();
    });
  }

  _kill() {
    if (this.proc) {
      const p = this.proc;
      this.proc = null;
      try { p.kill('SIGKILL'); } catch (_) {}
    }
  }

  _scheduleRestart() {
    if (!this.running) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this._spawn();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, 15000);
  }

  _onPcm(chunk) {
    this.bytesTotal += chunk.length;
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    const frameBytes = 2 * CHANNELS;
    const usable = this._buf.length - (this._buf.length % frameBytes);
    const acc = this._acc;
    for (let o = 0; o < usable; o += frameBytes) {
      const l = this._buf.readInt16LE(o) / 32768;
      const r = this._buf.readInt16LE(o + 2) / 32768;
      const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
      if (al > acc.pkL) acc.pkL = al;
      if (ar > acc.pkR) acc.pkR = ar;
      acc.sqL += l * l; acc.sqR += r * r;
      if (++acc.n >= WINDOW_FRAMES) {
        this._onWindow(acc);
        Object.assign(acc, this._newAcc());
      }
    }
    this._buf = this._buf.subarray(usable);
  }

  _onWindow(acc) {
    const now = Date.now();
    this.lastDataAt = now;
    this.backoff = 1000;
    this.levels = {
      peakL: toDb(acc.pkL), peakR: toDb(acc.pkR),
      rmsL: toDb(Math.sqrt(acc.sqL / acc.n)), rmsR: toDb(Math.sqrt(acc.sqR / acc.n))
    };
    const o = this.getOptions();
    const loudness = Math.max(this.levels.rmsL, this.levels.rmsR);
    const silent = loudness < o.silenceThresholdDb;

    if (silent) {
      this.loudSince = 0;
      if (!this.silentSince) this.silentSince = now;
    } else {
      this.silentSince = 0;
      if (!this.loudSince) this.loudSince = now;
    }

    if (this.state === STATE.CONNECTING) {
      this._setState(STATE.ON_AIR);
      this.emit('event', { type: 'online' });
    } else if (this.state === STATE.OFF_AIR) {
      const downFor = now - this.since;
      this._setState(STATE.ON_AIR);
      this.emit('event', { type: 'recovered', from: 'offair', duration: downFor });
    }

    if (this.state === STATE.ON_AIR && this.silentSince && now - this.silentSince >= o.silenceSeconds * 1000) {
      this._setState(STATE.SILENCE, this.silentSince);
      this.emit('event', { type: 'silence', level: loudness, threshold: o.silenceThresholdDb, seconds: o.silenceSeconds });
    } else if (this.state === STATE.SILENCE && this.loudSince && now - this.loudSince >= o.recoverSeconds * 1000) {
      const dur = now - this.since;
      this._setState(STATE.ON_AIR);
      this.emit('event', { type: 'recovered', from: 'silence', duration: dur });
    }
  }

  _tick() {
    if (!this.running) return;
    const o = this.getOptions();
    const now = Date.now();
    const ref = this.lastDataAt || this.attemptStartedAt;
    if (now - ref > o.offAirSeconds * 1000 && this.state !== STATE.OFF_AIR) {
      this._setState(STATE.OFF_AIR, this.lastDataAt || this.attemptStartedAt);
      this.silentSince = 0; this.loudSince = 0;
      this.levels = { peakL: FLOOR_DB, peakR: FLOOR_DB, rmsL: FLOOR_DB, rmsR: FLOOR_DB };
      this.emit('event', { type: 'offair', reason: this.lastError || '' });
      if (this.proc) this._kill(); // flusso bloccato: forza la riconnessione
    }
    if (this.state === STATE.OFF_AIR && now - (this.lastDataAt || 0) > 1000) {
      this.levels = { peakL: FLOOR_DB, peakR: FLOOR_DB, rmsL: FLOOR_DB, rmsR: FLOOR_DB };
    }
  }

  _setState(s, since) {
    if (this.state === s) return;
    this.state = s;
    this.since = since || Date.now();
    this.emit('state', s);
  }

  snapshot() {
    return {
      ...this.stream,
      state: this.state,
      since: this.since,
      lastError: this.lastError,
      resolvedUrl: this.resolvedUrl || null,
      alarm: this.alarm,
      bytesTotal: this.bytesTotal
    };
  }
}

module.exports = { StreamMonitor, STATE, FLOOR_DB, FFMPEG, inputArgs };
