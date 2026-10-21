'use strict';
// Monitor di un singolo flusso: decodifica l'audio con FFmpeg (qualsiasi formato:
// Icecast/Shoutcast MP3/AAC/OGG, HLS, DASH, RTMP, RTSP, SRT, flussi video web TV...)
// e calcola livelli di picco/RMS per canale, rilevando OFF AIR e SILENZIO.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { resolveStream, parseHeaderLines, DEFAULT_UA } = require('./resolve');

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

/** Opzioni HTTP del flusso (User-Agent e intestazioni personalizzate, es. Referer per le web TV). */
function streamOptions(stream) {
  return { headers: parseHeaderLines(stream.headers), userAgent: (stream.userAgent || '').trim() || undefined };
}

/**
 * Opzioni di ingresso FFmpeg comuni a monitoraggio, ascolto e anteprima.
 * @param {string[]} pre  opzioni aggiuntive prima di -i (es. decoder)
 */
function inputArgs(url, opts = {}, pre = []) {
  const a = ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'level+info', '-fflags', '+discardcorrupt'];
  if (/^https?:/i.test(url)) {
    a.push('-user_agent', opts.userAgent || DEFAULT_UA, '-rw_timeout', '15000000');
    const h = Object.entries(opts.headers || {}).filter(([k]) => k.toLowerCase() !== 'user-agent');
    if (h.length) a.push('-headers', h.map(([k, v]) => `${k}: ${v}\r\n`).join(''));
  } else if (/^rtsps?:/i.test(url)) {
    a.push('-rtsp_transport', 'tcp', '-timeout', '15000000');
  } else if (/^rtmpt?s?:/i.test(url)) {
    a.push('-rw_timeout', '15000000');
  } else if (/^(udp|rtp):/i.test(url)) {
    a.push('-timeout', '15000000');
  }
  a.push(...pre, '-i', url);
  return a;
}

const ERROR_LINE = /\[(error|fatal|panic)\]\s*/;
const META_KEYS = /^(icy-name|icy-genre|icy-description|icy-br|icy-url|StreamTitle|service_name|service_provider|title)$/i;

/** Estrae dall'output di FFmpeg le informazioni sul flusso (codec, bitrate, video, metadati ICY). */
function parseInfoLine(line, info) {
  const clean = line.replace(/^\[[^\]]+\]\s*/, '').replace(/^\[[^\]]+\]\s*/, '');
  let m;
  if ((m = clean.match(/^Input #0, ([^,]+(?:,[^,]+)*?), from/))) { info.format = m[1].split(',')[0]; return; }
  if ((m = clean.match(/Stream #0:\d+.*?: Audio: (\w+)[^,]*(?:, (\d+) Hz)?(?:, ([^,]+))?(?:, [^,]+)?(?:, (\d+) kb\/s)?/)) && !info.audio) {
    info.audio = { codec: m[1], rate: Number(m[2]) || null, channels: m[3] || null, bitrate: Number(m[4]) || null };
    return;
  }
  if ((m = clean.match(/Stream #0:\d+.*?: Video: (\w+).*?, (\d{2,5})x(\d{2,5})/)) && !info.video) {
    const fps = clean.match(/([\d.]+) fps/);
    info.video = { codec: m[1], width: Number(m[2]), height: Number(m[3]), fps: fps ? Number(fps[1]) : null };
    return;
  }
  if ((m = clean.match(/^\s*([\w-]+)\s*:\s*(.+)$/)) && META_KEYS.test(m[1])) {
    const k = m[1].toLowerCase();
    if (k === 'icy-name' || k === 'service_name' || (k === 'title' && !info.name)) info.name = m[2].trim();
    else if (k === 'streamtitle') info.nowPlaying = m[2].trim();
    else if (k === 'icy-genre') info.genre = m[2].trim();
    else if (k === 'icy-br' && info.audio && !info.audio.bitrate) info.audio.bitrate = Number(m[2]) || null;
  }
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
    this.altIndex = 0;                // server alternativo in uso (playlist con più server)
    this.info = null;
    this.thumb = null;
    this.thumbAt = 0;
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
    this.thumbTimer = setInterval(() => this._grabThumb(), 60000);
  }

  stop() {
    this.running = false;
    this._gen = (this._gen || 0) + 1;
    clearTimeout(this.restartTimer);
    clearInterval(this.watchdog);
    clearInterval(this.thumbTimer);
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
    // il link viene risolto a ogni tentativo: playlist, server Icecast/Shoutcast, pagine web, HLS…
    const opts = streamOptions(this.stream);
    const r = await resolveStream(this.stream.url, opts);
    if (!this.running || gen !== this._gen) return;
    if (r.error && (r.kind === 'html' || r.kind === 'site')) {
      this.lastError = r.error;
      return this._scheduleRestart();
    }
    const urls = r.urls && r.urls.length ? r.urls : [r.url];
    // playlist con più server: se un tentativo fallisce si passa al server successivo
    const url = urls[this.altIndex % urls.length];
    this.current = { url, opts, at: Date.now(), kind: r.kind,
      videoUrl: r.kind === 'hls-audio' ? urls[urls.length - 1] : url };
    this.info = { kind: r.kind, url: url !== this.stream.url ? url : null, name: r.name || null,
      alternates: r.kind === 'playlist' ? urls.length : 1, audio: null, video: null, format: null, hlsMaster: r.kind === 'hls-audio' };
    this.gotData = false;
    let proc;
    try {
      proc = spawn(FFMPEG, [...inputArgs(url, opts), '-vn', '-sn', '-dn', '-ac', String(CHANNELS), '-ar', String(SAMPLE_RATE),
        '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      this.lastError = e.message;
      return this._scheduleRestart();
    }
    this.proc = proc;
    this._buf = Buffer.alloc(0);
    let inInput = true, tail = '';
    proc.stdout.on('data', chunk => this._onPcm(chunk));
    proc.stderr.on('data', d => {
      const lines = (tail + d.toString()).split(/\r?\n/);
      tail = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        if (ERROR_LINE.test(line)) this.lastError = line.slice(line.search(ERROR_LINE)).replace(ERROR_LINE, '').slice(0, 300);
        if (/Output #0|Stream mapping/.test(line)) { inInput = false; this.emit('info'); }
        if (inInput) parseInfoLine(line, this.info);
      }
    });
    proc.on('error', e => {
      this.lastError = e.code === 'ENOENT' ? 'FFmpeg non trovato / FFmpeg not found' : e.message;
    });
    proc.on('close', (code, signal) => {
      if (signal === 'SIGSEGV') this.lastError = 'FFmpeg crash (SIGSEGV)' + (process.platform === 'linux' ? ' — sudo apt install ffmpeg' : '');
      if (!this.gotData) this.altIndex++;
      if (this.proc === proc) this.proc = null;
      this._scheduleRestart();
    });
  }

  /** Anteprima delle web TV: un fotogramma chiave ogni minuto (decodifica minima). */
  _grabThumb() {
    if (!this.running || this._thumbBusy || !this.current) return;
    if (!(this.info && (this.info.video || this.info.hlsMaster)) || this.state === STATE.OFF_AIR) return;
    this._thumbBusy = true;
    const { videoUrl, opts } = this.current;
    const p = spawn(FFMPEG, [...inputArgs(videoUrl, opts, ['-skip_frame', 'nokey']), '-map', '0:v:0', '-frames:v', '1',
      '-vf', 'scale=480:-2', '-q:v', '6', '-f', 'mjpeg', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const chunks = [];
    const timer = setTimeout(() => p.kill('SIGKILL'), 25000);
    p.stdout.on('data', c => chunks.push(c));
    p.on('error', () => {});
    p.on('close', () => {
      clearTimeout(timer);
      this._thumbBusy = false;
      const buf = Buffer.concat(chunks);
      if (buf.length > 500 && buf[0] === 0xff && buf[1] === 0xd8) {
        this.thumb = buf; this.thumbAt = Date.now();
        this.emit('info');
      }
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
    if (!this.gotData) {
      this.gotData = true;
      setTimeout(() => this._grabThumb(), 2000);
    }
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
      resolvedUrl: this.info && this.info.url,
      info: this.info,
      thumbAt: this.thumbAt || 0,
      alarm: this.alarm,
      bytesTotal: this.bytesTotal
    };
  }
}

module.exports = { StreamMonitor, STATE, FLOOR_DB, FFMPEG, inputArgs, streamOptions, parseInfoLine };
