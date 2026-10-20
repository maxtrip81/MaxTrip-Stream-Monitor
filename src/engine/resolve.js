'use strict';
// Risoluzione dei link "playlist" che le radio pubblicano sui loro siti
// (.pls, .m3u, .asx, .xspf): restituisce l'URL del flusso audio vero e proprio.
// HLS (.m3u8 con #EXT-X-) e flussi diretti vengono restituiti invariati.

const PLAYLIST_TYPES = /(scpls|x-scpls|pls\+xml|x-mpegurl|mpegurl|x-ms-asf|x-ms-wax|asx|xspf|text\/plain|text\/html)/i;
const PLAYLIST_EXT = /\.(pls|m3u|asx|wax|wvx|xspf)(\?|#|$)/i;
const MEDIA_EXT = /\.(mp3|aac|aacp|ogg|oga|opus|flac|wav|m4a|mp4|m3u8|mpd|ts)(\?|#|$)/i;
const MAX_BYTES = 64 * 1024;

/** Aggiunge http:// se l'utente ha inserito l'indirizzo senza protocollo. */
function normalizeUrl(url) {
  const u = String(url || '').trim();
  if (!u) return u;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return u;
  return 'http://' + u.replace(/^\/+/, '');
}

function absolute(link, base) {
  try { return new URL(link.trim(), base).href; } catch (_) { return null; }
}

function parsePlaylist(text, base) {
  if (/#EXT-X-/i.test(text)) return { hls: true };
  const first = arr => arr.map(x => absolute(x, base)).find(Boolean) || null;
  // PLS
  const pls = [...text.matchAll(/^\s*File\d+\s*=\s*(\S+)/gim)].map(m => m[1]);
  if (pls.length) return { url: first(pls) };
  // ASX / WAX
  const asx = [...text.matchAll(/<ref\s+href\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]);
  if (asx.length) return { url: first(asx) };
  // XSPF
  const xspf = [...text.matchAll(/<location>\s*([^<\s]+)\s*<\/location>/gi)].map(m => m[1]);
  if (xspf.length) return { url: first(xspf) };
  // M3U semplice: prima riga che non è un commento
  if (/^\s*<(!doctype|html)/i.test(text)) return {};
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const urls = lines.filter(l => /^[a-z][a-z0-9+.-]*:\/\//i.test(l) || /^[\w./-]+$/.test(l));
  return urls.length ? { url: first(urls) } : {};
}

async function readHead(res) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Restituisce { url, playlist } dove url è l'indirizzo da passare a FFmpeg.
 * In caso di errore restituisce l'URL originale: sarà FFmpeg a segnalare il problema.
 */
async function resolveStreamUrl(input, depth = 0) {
  const url = normalizeUrl(input);
  if (!/^https?:\/\//i.test(url) || depth > 3) return { url, playlist: false };
  // estensione audio/video nota: è già il flusso, nessuna verifica necessaria
  try { if (MEDIA_EXT.test(new URL(url).pathname)) return { url, playlist: false }; } catch (_) {}
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'MaxTripStreamMonitor/1.0', 'Icy-MetaData': '0' }
    });
    const type = res.headers.get('content-type') || '';
    const looksPlaylist = PLAYLIST_EXT.test(new URL(res.url || url).pathname) || PLAYLIST_TYPES.test(type);
    if (!res.ok || !looksPlaylist || /^(audio\/(mpeg|mp3|aac|aacp|ogg|opus|flac|wav)|video\/(mp2t|mp4))\s*(;|$)/i.test(type)) {
      ctrl.abort();
      return { url, playlist: false };
    }
    const text = await readHead(res);
    const parsed = parsePlaylist(text, res.url || url);
    if (parsed.hls || !parsed.url) return { url, playlist: false };
    const inner = await resolveStreamUrl(parsed.url, depth + 1);
    return { url: inner.url, playlist: true };
  } catch (_) {
    // es. server Shoutcast v1 che risponde "ICY 200 OK": è un flusso diretto
    return { url, playlist: false };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { resolveStreamUrl, normalizeUrl, parsePlaylist };
