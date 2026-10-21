'use strict';
// Risoluzione di qualsiasi tipo di link nel flusso audio/video da passare a FFmpeg:
//  - flussi diretti Icecast / Shoutcast v1 ("ICY 200 OK") / Shoutcast v2 / HTTP(S)
//  - playlist .pls .m3u .asx .wax .wvx .xspf .strm (con server alternativi)
//  - HLS (.m3u8): nelle playlist "master" sceglie la traccia solo audio o la qualità più leggera
//  - indirizzo del server senza mountpoint: Icecast 2.x (status-json.xsl),
//    Shoutcast v2 (statistics?json=1), Shoutcast v1 (7.html → "/;")
//  - pagine web delle radio/TV: cerca il flusso nel codice HTML
//  - YouTube, Twitch, Facebook, TuneIn, RaiPlay…: tramite yt-dlp, se installato
//  - mms:// icy:// rtmp:// rtsp:// srt:// udp:// rtp:// rist:// …: passati a FFmpeg
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DEFAULT_UA = 'VLC/3.0.21 LibVLC/3.0.21';
const PLAYLIST_TYPES = /(scpls|pls\+xml|mpegurl|x-ms-asf|x-ms-wax|x-ms-wvx|asx|xspf)/i;
const PLAYLIST_EXT = /\.(pls|m3u|asx|wax|wvx|xspf|strm)(\?|#|$)/i;
const MEDIA_EXT = /\.(mp3|aac|aacp|ogg|oga|opus|flac|wav|m4a|mp4|ts|mpd|webm|mkv|flv)(\?|#|$)/i;
const STREAM_TYPE = /^(audio\/(?!x-scpls|x-mpegurl|mpegurl|scpls)|video\/(?!x-ms-asf|x-ms-wvx)|application\/(ogg|octet-stream|x-flv|dash\+xml))/i;
const HLS_TYPE = /(application\/(vnd\.apple\.mpegurl|x-mpegurl))/i;
const VIDEO_SITES = /(^|\.)(youtube\.com|youtu\.be|twitch\.tv|facebook\.com|fb\.watch|instagram\.com|dailymotion\.com|vimeo\.com|kick\.com|rumble\.com|tunein\.com|mixcloud\.com|soundcloud\.com|raiplay\.it|rainews\.it|mediasetinfinity\.mediaset\.it|la7\.it|rtve\.es|arte\.tv|bbc\.co\.uk|cbsnews\.com|nbcnews\.com|bloomberg\.com|euronews\.com|ok\.ru|vk\.com|bilibili\.com|streamable\.com)$/i;
const MAX_BODY = 512 * 1024;

/** Corregge l'indirizzo inserito: spazi, virgolette, protocolli "icy://", "mms://", http mancante. */
function normalizeUrl(url) {
  let u = String(url || '').trim().replace(/^[<"'\s]+|[>"'\s]+$/g, '');
  if (!u) return u;
  u = u.replace(/^icy:\/\//i, 'http://').replace(/^icyx:\/\//i, 'https://').replace(/^itpc:\/\//i, 'http://');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return u;
  if (/^(udp|rtp|srt|rist):/i.test(u)) return u;
  return 'http://' + u.replace(/^\/+/, '');
}

function absolute(link, base) {
  try {
    const u = new URL(String(link).trim().replace(/\\\//g, '/').replace(/&amp;/g, '&'), base);
    return /^(https?|rtmps?|rtsps?|srt|mmsh?|mmst|udp|rtp|rist|icy):/i.test(u.protocol) ? normalizeUrl(u.href) : null;
  } catch (_) { return null; }
}

const uniq = arr => [...new Set(arr.filter(Boolean))];

function parseHeaderLines(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*([\w-]+)\s*:\s*(.+?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Client HTTP tollerante: certificati non validi, gzip, redirect, risposte "ICY 200 OK"
// ---------------------------------------------------------------------------

/** Legge solo le intestazioni di un server Shoutcast v1 ("ICY 200 OK"), che Node non sa interpretare. */
function rawProbe(url, headers, timeout) {
  return new Promise(resolve => {
    const u = new URL(url);
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    const sock = u.protocol === 'https:'
      ? tls.connect({ host: u.hostname, port, servername: u.hostname, rejectUnauthorized: false })
      : net.connect({ host: u.hostname, port });
    let buf = '';
    const done = r => { sock.destroy(); resolve(r); };
    sock.setTimeout(timeout, () => done(null));
    sock.on('error', () => done(null));
    sock.once(u.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
      const h = Object.entries({ Host: u.host, ...headers, Connection: 'close' }).map(([k, v]) => `${k}: ${v}`).join('\r\n');
      sock.write(`GET ${u.pathname}${u.search} HTTP/1.0\r\n${h}\r\n\r\n`);
    });
    sock.on('data', d => {
      buf += d.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0 && buf.length < 16384) return;
      const [status, ...lines] = buf.slice(0, end < 0 ? buf.length : end).split('\r\n');
      const code = Number((status.match(/^\S+\s+(\d{3})/) || [])[1]) || 0;
      const hdrs = {};
      for (const l of lines) { const i = l.indexOf(':'); if (i > 0) hdrs[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
      done({ status: code, headers: hdrs, body: '', url, icy: /^ICY/i.test(status) });
    });
  });
}

/**
 * GET con lettura limitata del corpo. Per i flussi audio/video non legge il corpo.
 * @returns {Promise<{status, headers, body, url, icy, stream}>}
 */
function httpGet(url, { headers = {}, timeout = 8000, redirects = 6, maxBytes = MAX_BODY } = {}) {
  return new Promise(resolve => {
    let u;
    try { u = new URL(url); } catch (_) { return resolve({ status: 0, error: 'URL non valido / invalid URL', headers: {}, body: '', url }); }
    const mod = u.protocol === 'https:' ? https : http;
    const reqHeaders = { 'User-Agent': DEFAULT_UA, Accept: '*/*', 'Accept-Encoding': 'gzip, deflate', 'Icy-MetaData': '0', ...headers };
    let finished = false;
    const finish = r => { if (!finished) { finished = true; clearTimeout(timer); resolve({ url, headers: {}, body: '', ...r }); } };
    const req = mod.get(u, { headers: reqHeaders, rejectUnauthorized: false, timeout }, res => {
      const loc = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && loc && redirects > 0) {
        res.resume(); req.destroy();
        return httpGet(new URL(loc, u).href, { headers, timeout, redirects: redirects - 1, maxBytes }).then(finish);
      }
      const type = res.headers['content-type'] || '';
      const isStream = STREAM_TYPE.test(type) || Object.keys(res.headers).some(h => h.startsWith('icy-'));
      if (isStream && !PLAYLIST_TYPES.test(type) && !HLS_TYPE.test(type)) {
        req.destroy();
        return finish({ status: res.statusCode, headers: res.headers, stream: true });
      }
      let src = res;
      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      if (enc === 'gzip' || enc === 'deflate') { src = res.pipe(enc === 'gzip' ? zlib.createGunzip() : zlib.createInflate()); src.on('error', () => {}); }
      const chunks = []; let size = 0;
      src.on('data', c => {
        chunks.push(c); size += c.length;
        if (size >= maxBytes) { req.destroy(); finish({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }); }
      });
      src.on('end', () => finish({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      src.on('error', () => finish({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    const timer = setTimeout(() => { req.destroy(); finish({ status: 0, error: 'timeout' }); }, timeout + 2000);
    req.on('timeout', () => { req.destroy(); finish({ status: 0, error: 'timeout' }); });
    req.on('error', async e => {
      if (finished) return;
      if (/HPE_INVALID_CONSTANT|HPE_INVALID_VERSION|Expected HTTP/i.test(`${e.code} ${e.message}`)) {
        // Shoutcast v1: "ICY 200 OK"
        const r = await rawProbe(url, reqHeaders, timeout);
        return finish(r ? { ...r, stream: r.status === 200 } : { status: 0, error: e.message });
      }
      finish({ status: 0, error: e.code || e.message });
    });
  });
}

// ---------------------------------------------------------------------------
// Playlist
// ---------------------------------------------------------------------------

/** Restituisce gli URL contenuti in una playlist (pls, m3u, asx, xspf, strm), nell'ordine. */
function parsePlaylist(text, base) {
  if (/#EXT-X-/i.test(text)) return { hls: true, urls: [] };
  const pick = arr => uniq(arr.map(x => absolute(x, base)));
  const pls = [...text.matchAll(/^\s*File\d+\s*=\s*(\S+)/gim)].map(m => m[1]);
  if (pls.length) return { urls: pick(pls) };
  const asx = [...text.matchAll(/<ref\s+href\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]);
  if (asx.length) return { urls: pick(asx) };
  const xspf = [...text.matchAll(/<location>\s*([^<\s]+)\s*<\/location>/gi)].map(m => m[1]);
  if (xspf.length) return { urls: pick(xspf) };
  if (/^\s*<(!doctype|html)/i.test(text)) return { urls: [] };
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('['));
  return { urls: pick(lines.filter(l => /^[a-z][a-z0-9+.-]*:\/\//i.test(l) || /^[\w./;:-]+$/.test(l))) };
}

/** HLS: nelle playlist master sceglie la traccia audio separata o la variante più leggera. */
function pickHlsVariant(text, base) {
  if (!/#EXT-X-STREAM-INF/i.test(text)) return null;
  const attrs = line => Object.fromEntries([...line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)].map(m => [m[1], m[2].replace(/^"|"$/g, '')]));
  const audio = [...text.matchAll(/^#EXT-X-MEDIA:(.*)$/gim)].map(m => attrs(m[1])).filter(a => a.TYPE === 'AUDIO' && a.URI);
  if (audio.length) {
    const a = audio.find(x => x.DEFAULT === 'YES') || audio[0];
    return { url: absolute(a.URI, base), kind: 'hls-audio' };
  }
  const lines = text.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^#EXT-X-STREAM-INF:/i.test(lines[i])) continue;
    const a = attrs(lines[i].slice(lines[i].indexOf(':') + 1));
    const next = lines.slice(i + 1).find(l => l.trim() && !l.startsWith('#'));
    if (next) variants.push({ url: absolute(next.trim(), base), bw: Number(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH) || 1e12, codecs: a.CODECS || '' });
  }
  const withAudio = variants.filter(v => !v.codecs || /mp4a|ac-3|ec-3|opus|mp3|flac/i.test(v.codecs));
  const best = (withAudio.length ? withAudio : variants).sort((x, y) => x.bw - y.bw)[0];
  return best ? { url: best.url, kind: 'hls-variant' } : null;
}

// ---------------------------------------------------------------------------
// Server Icecast / Shoutcast e pagine web
// ---------------------------------------------------------------------------

function parseLooseJson(text) {
  try { return JSON.parse(text); } catch (_) {}
  // Icecast < 2.4.1 genera JSON non valido con valori "-" senza virgolette
  try { return JSON.parse(text.replace(/:\s*-\s*([,}])/g, ':null$1')); } catch (_) { return null; }
}

async function discoverServer(u, headers, page) {
  const origin = `${u.protocol}//${u.host}`;
  const server = `${(page && page.headers.server) || ''} ${(page && page.body) || ''}`.slice(0, 20000);
  const candidates = [];
  const looksIcecast = /icecast/i.test(server);
  const looksShoutcast = /shoutcast/i.test(server);
  const tryAll = !looksIcecast && !looksShoutcast;

  if (looksIcecast || tryAll) {
    const r = await httpGet(`${origin}/status-json.xsl`, { headers, timeout: 5000 });
    const j = r.status === 200 && parseLooseJson(r.body);
    let src = j && j.icestats && j.icestats.source;
    if (src) {
      src = Array.isArray(src) ? src : [src];
      // listenurl usa il nome host configurato sul server (spesso "localhost"): si usa quello inserito
      const mounts = src.map(s => {
        try { const l = new URL(s.listenurl); return { url: origin + l.pathname, audio: /audio|ogg/i.test(s.server_type || 'audio'), name: s.server_name }; } catch (_) { return null; }
      }).filter(Boolean);
      const same = mounts.find(m => new URL(m.url).pathname === u.pathname);
      const ordered = [same, ...mounts.filter(m => m.audio), ...mounts].filter(Boolean);
      // solo il mountpoint principale: passare a un altro mountpoint nasconderebbe lo spegnimento del flusso
      if (ordered.length) return { urls: [ordered[0].url], kind: 'icecast', name: ordered[0].name };
    }
  }
  if (looksShoutcast || tryAll) {
    const r = await httpGet(`${origin}/statistics?json=1`, { headers, timeout: 5000 });
    const j = r.status === 200 && parseLooseJson(r.body);
    if (j && Array.isArray(j.streams) && j.streams.length) {
      const sid = Number(u.searchParams.get('sid')) || 0;
      const ordered = [...j.streams.filter(s => s.id === sid), ...j.streams];
      return { urls: [origin + (ordered[0].streampath || `/stream/${ordered[0].id}/`)], kind: 'shoutcast2', name: ordered[0].servertitle };
    }
    const v1 = await httpGet(`${origin}/7.html`, { headers, timeout: 5000 });
    if (v1.status === 200 && /<body>\s*\d+,\d+,/i.test(v1.body)) candidates.push({ url: `${origin}/;`, kind: 'shoutcast1' });
    else if (looksShoutcast) candidates.push({ url: `${origin}/;`, kind: 'shoutcast1' }, { url: `${origin}/stream`, kind: 'shoutcast2' });
  }
  if (candidates.length) return { urls: candidates.map(c => c.url), kind: candidates[0].kind };
  return null;
}

/** Cerca indirizzi di flussi nel codice di una pagina web. */
function scanHtml(html, base) {
  const found = [];
  const add = (url, score) => { const a = absolute(url, base); if (a) found.push({ url: a, score }); };
  for (const m of html.matchAll(/<(audio|video|source)\b[^>]*?\s(?:data-)?src\s*=\s*["']([^"']+)["']/gi)) add(m[2], 10);
  const text = html.replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
  for (const m of text.matchAll(/(?:https?:)?\/\/[^\s"'<>()\\]+|(?<=["'=])\/[^\s"'<>()\\]+/gi)) {
    const s = m[0];
    if (/\.(js|css|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|html?|php|json|xml)(\?|$)/i.test(s) && !/\.(m3u8|mp3|aac|pls|m3u)/i.test(s)) continue;
    if (/\.m3u8(\?|$)/i.test(s)) add(s, 9);
    else if (/\.(mp3|aac|aacp|ogg|opus|flac)(\?|$)/i.test(s)) add(s, 8);
    else if (/\.(pls|m3u|xspf|asx)(\?|$)/i.test(s)) add(s, 7);
    else if (/\.mpd(\?|$)/i.test(s)) add(s, 6);
    else if (/(\/;|\/stream\b|\/live\b|\/listen\b|icecast|shoutcast|streamtheworld|zeno\.fm|radiojar|mixlr|stream\.|:\d{4,5}\/)/i.test(s)) add(s, 4);
  }
  const best = new Map();
  for (const f of found) if (!best.has(f.url) || best.get(f.url) < f.score) best.set(f.url, f.score);
  return [...best.entries()].sort((a, b) => b[1] - a[1]).map(([url]) => url).slice(0, 10);
}

// ---------------------------------------------------------------------------
// yt-dlp (opzionale) per YouTube, Twitch, Facebook, TuneIn, RaiPlay…
// ---------------------------------------------------------------------------
let ytdlpPath;
function findYtDlp() {
  if (ytdlpPath !== undefined) return ytdlpPath;
  ytdlpPath = process.env.YTDLP_PATH || null;
  if (!ytdlpPath) {
    const names = process.platform === 'win32' ? ['yt-dlp.exe'] : ['yt-dlp'];
    const dirs = (process.env.PATH || '').split(path.delimiter).concat(['/opt/homebrew/bin', '/usr/local/bin']);
    for (const d of dirs) for (const n of names) {
      const f = path.join(d, n);
      try { fs.accessSync(f, fs.constants.X_OK); ytdlpPath = f; return f; } catch (_) {}
    }
  }
  return ytdlpPath;
}

function ytdlp(url) {
  const bin = findYtDlp();
  if (!bin) return Promise.resolve(null);
  return new Promise(resolve => {
    execFile(bin, ['-g', '-f', 'bestaudio/best', '--no-playlist', '--no-warnings', url], { timeout: 45000, windowsHide: true },
      (err, stdout) => resolve(err ? null : (String(stdout).split(/\r?\n/).find(l => /^https?:\/\//.test(l)) || null)));
  });
}

// ---------------------------------------------------------------------------
// Risoluzione
// ---------------------------------------------------------------------------

/**
 * @param {string} input   indirizzo inserito dall'utente
 * @param {object} opts    { headers: {}, userAgent }
 * @returns {Promise<{url:string, urls:string[], kind:string, name?:string, error?:string}>}
 *   urls = alternative in ordine di preferenza (es. server di riserva di una playlist)
 */
async function resolveStream(input, opts = {}, depth = 0) {
  const url = normalizeUrl(input);
  const headers = { ...(opts.headers || {}), ...(opts.userAgent ? { 'User-Agent': opts.userAgent } : {}) };
  const out = (urls, kind, extra = {}) => ({ url: urls[0], urls: uniq(urls), kind, ...extra });

  if (/^mms:\/\//i.test(url)) return out([url.replace(/^mms:/i, 'mmsh:'), url.replace(/^mms:/i, 'mmst:')], 'mms');
  if (!/^https?:\/\//i.test(url) || depth > 4) return out([url], 'direct');

  let u;
  try { u = new URL(url); } catch (_) { return out([url], 'direct', { error: 'URL non valido / invalid URL' }); }

  if (VIDEO_SITES.test(u.hostname)) {
    const direct = await ytdlp(url);
    if (direct) return out([direct], 'yt-dlp');
    return out([url], 'site', { error: findYtDlp() ? 'yt-dlp: flusso non trovato / stream not found' : 'yt-dlp non installato / not installed (https://github.com/yt-dlp/yt-dlp)' });
  }
  if (MEDIA_EXT.test(u.pathname)) return out([url], 'direct');

  const r = await httpGet(url, { headers });
  if (r.stream) return out([r.url], r.icy ? 'shoutcast1' : 'direct', { name: r.headers['icy-name'] });
  if (!r.status) return out([url], 'direct', { error: r.error });
  const type = r.headers['content-type'] || '';
  const body = r.body || '';

  if (r.status === 200 && (HLS_TYPE.test(type) || /^\s*#EXTM3U[\s\S]*#EXT-X-/i.test(body))) {
    const v = pickHlsVariant(body, r.url);
    return v ? out([v.url, r.url], v.kind) : out([r.url], 'hls');
  }

  if (r.status === 200 && (PLAYLIST_TYPES.test(type) || PLAYLIST_EXT.test(u.pathname) ||
      (/^text\/plain/i.test(type) && /^\s*(\[playlist\]|#EXTM3U|https?:\/\/)/i.test(body)))) {
    const p = parsePlaylist(body, r.url);
    if (p.urls.length) {
      const inner = await resolveStream(p.urls[0], opts, depth + 1);
      return out([...inner.urls, ...p.urls.slice(1)], 'playlist', { name: inner.name });
    }
  }

  const isHtml = r.status === 200 && (/html/i.test(type) || /^\s*<(!doctype|html)/i.test(body));
  const isServerRoot = u.pathname === '/' || u.pathname === '';
  // Un mountpoint che risponde 404 è un flusso spento (Icecast lo fa quando la sorgente si stacca):
  // non si cerca un altro mountpoint, altrimenti l'allarme OFF AIR verrebbe nascosto.
  if (isHtml || (isServerRoot && r.status >= 400)) {
    // indirizzo del server Icecast/Shoutcast (pagina di stato) o sito della radio/TV
    const disc = await discoverServer(u, headers, r);
    if (disc) {
      const inner = await resolveStream(disc.urls[0], opts, depth + 1);
      return out([...inner.urls, ...disc.urls.slice(1)], disc.kind, { name: disc.name || inner.name });
    }
    if (isHtml) {
      for (const c of scanHtml(body, r.url)) {
        if (c === url) continue;
        const inner = await resolveStream(c, opts, depth + 1);
        if (!inner.error && inner.kind !== 'html') {
          const check = /^https?:/i.test(inner.url) && inner.kind === 'direct' ? await httpGet(inner.url, { headers, timeout: 5000 }) : { stream: true };
          if (check.stream || /^#EXTM3U/.test(check.body || '')) return { ...inner, kind: `page→${inner.kind}` };
        }
      }
      const direct = await ytdlp(url);
      if (direct) return out([direct], 'yt-dlp');
      return out([url], 'html', { error: 'Pagina web: nessun flusso trovato / Web page: no stream found' });
    }
  }
  return out([r.url || url], 'direct');
}

/** Compatibilità: { url, playlist } */
async function resolveStreamUrl(input, opts) {
  const r = await resolveStream(input, opts);
  return { url: r.url, playlist: r.url !== normalizeUrl(input), ...r };
}

module.exports = { resolveStream, resolveStreamUrl, normalizeUrl, parsePlaylist, pickHlsVariant, scanHtml, httpGet, findYtDlp, parseHeaderLines, DEFAULT_UA };
