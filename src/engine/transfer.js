'use strict';
// Esportazione e importazione dei flussi tra computer, Mac, smartphone e server.
// Formato del file: JSON "trip-streaming-monitor/streams". In importazione sono accettati
// anche il file config.json dell'app e le playlist .m3u / .pls con più stazioni.
const { sanitizeStream } = require('./store');
const { normalizeUrl } = require('./resolve');

const FORMAT = 'trip-streaming-monitor/streams';
const FIELDS = ['name', 'url', 'enabled', 'silenceThresholdDb', 'silenceSeconds', 'offAirSeconds', 'userAgent', 'headers'];

function pick(s) {
  const clean = sanitizeStream(s);
  return { id: s.id || undefined, ...Object.fromEntries(FIELDS.map(f => [f, clean[f]])) };
}

/** File di esportazione: tutti i flussi o solo quelli indicati. */
function buildExport(streams, ids, about = {}) {
  const sel = ids && ids.length ? streams.filter(s => ids.includes(s.id)) : streams;
  return {
    format: FORMAT,
    version: 1,
    app: about.app || 'TRIP Streaming Monitor',
    appVersion: about.version,
    author: 'Massimiliano Mascioli Trippa — max@maxtrip.it',
    exportedAt: new Date().toISOString(),
    count: sel.length,
    streams: sel.map(pick)
  };
}

function nameFromUrl(url) {
  try { const u = new URL(url); return (u.hostname + (u.pathname.length > 1 ? u.pathname : '')).slice(0, 120); } catch (_) { return url.slice(0, 120); }
}

/** Legge il file importato. @returns {{source, streams, errors}} */
function parseImportFile(text) {
  const errors = [];
  let source, list = [];
  const raw = String(text || '').replace(/^﻿/, '').trim();
  if (!raw) return { source: 'empty', streams: [], errors: ['empty'] };

  if (!/^\[playlist\]/i.test(raw) && (raw.startsWith('{') || raw.startsWith('['))) {
    let data;
    try { data = JSON.parse(raw); } catch (e) { return { source: 'json', streams: [], errors: ['invalid-json'] }; }
    if (Array.isArray(data)) { source = 'json'; list = data; }
    else if (data && data.format === FORMAT) { source = 'trip'; list = data.streams || []; }
    else if (data && Array.isArray(data.streams)) { source = data.settings ? 'config' : 'json'; list = data.streams; }
    else return { source: 'json', streams: [], errors: ['unknown-format'] };
  } else if (/^\[playlist\]/im.test(raw)) {
    source = 'pls';
    const files = {}, titles = {};
    for (const m of raw.matchAll(/^\s*File(\d+)\s*=\s*(.+?)\s*$/gim)) files[m[1]] = m[2];
    for (const m of raw.matchAll(/^\s*Title(\d+)\s*=\s*(.+?)\s*$/gim)) titles[m[1]] = m[2];
    list = Object.keys(files).sort((a, b) => a - b).map(k => ({ url: files[k], name: titles[k] }));
  } else {
    source = /^#EXTM3U/i.test(raw) ? 'm3u' : 'text';
    if (/#EXT-X-/i.test(raw)) return { source: 'hls', streams: [], errors: ['hls-not-list'] };
    let name = null;
    for (const line of raw.split(/\r?\n/).map(l => l.trim())) {
      const inf = line.match(/^#EXTINF:[^,]*,(.*)$/i);
      if (inf) { name = inf[1].trim() || null; continue; }
      if (!line || line.startsWith('#')) continue;
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(line) || /^[\w.-]+(:\d+)?(\/\S*)?$/.test(line)) list.push({ url: line, name });
      name = null;
    }
  }

  const streams = [];
  list.forEach((s, i) => {
    if (!s || typeof s !== 'object' || !String(s.url || '').trim()) { errors.push(`#${i + 1}: url`); return; }
    const url = normalizeUrl(s.url);
    streams.push(pick({ ...s, url, name: String(s.name || '').trim() || nameFromUrl(url) }));
  });
  if (!streams.length && !errors.length) errors.push('no-streams');
  return { source, streams, errors };
}

const urlKey = u => { try { const x = new URL(normalizeUrl(u)); return `${x.protocol}//${x.host.toLowerCase()}${x.pathname.replace(/\/+$/, '')}${x.search}`; } catch (_) { return String(u).trim(); } };
const nameKey = n => String(n || '').trim().toLowerCase();

/**
 * Confronta i flussi importati con quelli presenti.
 * status: "new" (da aggiungere), "identical" (copia esatta), "conflict" (stesso flusso, dati diversi)
 * match:  "id" (stesso flusso esportato), "url" (stesso indirizzo), "name" (stesso nome)
 */
function analyzeImport(existing, incoming) {
  return incoming.map((inc, index) => {
    const e = (inc.id && existing.find(x => x.id === inc.id) && { s: existing.find(x => x.id === inc.id), by: 'id' }) ||
      (existing.find(x => urlKey(x.url) === urlKey(inc.url)) && { s: existing.find(x => urlKey(x.url) === urlKey(inc.url)), by: 'url' }) ||
      (existing.find(x => nameKey(x.name) === nameKey(inc.name)) && { s: existing.find(x => nameKey(x.name) === nameKey(inc.name)), by: 'name' });
    if (!e) return { index, status: 'new', incoming: inc };
    const cur = pick(e.s);
    const diffs = FIELDS.filter(f => JSON.stringify(cur[f] ?? null) !== JSON.stringify(inc[f] ?? null));
    return { index, status: diffs.length ? 'conflict' : 'identical', match: e.by, incoming: inc, existing: { ...cur, id: e.s.id }, diffs };
  });
}

function uniqueName(name, streams) {
  const taken = new Set(streams.map(s => nameKey(s.name)));
  if (!taken.has(nameKey(name))) return name;
  const base = name.replace(/\s\(\d+\)$/, '');
  for (let i = 2; ; i++) if (!taken.has(nameKey(`${base} (${i})`))) return `${base} (${i})`;
}

/**
 * Applica le scelte dell'utente.
 * action: add | skip | keep | replace | duplicate | delete
 *  - keep: mantiene il flusso esistente e ignora quello importato
 *  - replace: sostituisce i dati del flusso esistente con quelli importati
 *  - duplicate: aggiunge il flusso importato come nuovo flusso (nome reso univoco)
 *  - delete: elimina il flusso esistente e non importa quello del file
 * @param engine oggetto con streams, addStream(data, keepId), updateStream(id, data), removeStream(id)
 */
function applyImport(engine, decisions) {
  const summary = { added: 0, replaced: 0, duplicated: 0, deleted: 0, kept: 0, skipped: 0 };
  for (const d of decisions || []) {
    const inc = pick(d.incoming || {});
    if (!inc.url) { summary.skipped++; continue; }
    const exists = d.existingId && engine.streams().some(s => s.id === d.existingId);
    switch (d.action) {
      case 'add': {
        const keepId = inc.id && !engine.streams().some(s => s.id === inc.id) ? inc.id : null;
        engine.addStream({ ...inc, name: uniqueName(inc.name, engine.streams()) }, keepId);
        summary.added++; break;
      }
      case 'replace':
        if (exists) { engine.updateStream(d.existingId, inc); summary.replaced++; } else summary.skipped++;
        break;
      case 'duplicate':
        engine.addStream({ ...inc, name: uniqueName(inc.name, engine.streams()) });
        summary.duplicated++; break;
      case 'delete':
        if (exists) { engine.removeStream(d.existingId); summary.deleted++; } else summary.skipped++;
        break;
      case 'keep': summary.kept++; break;
      default: summary.skipped++;
    }
  }
  return summary;
}

module.exports = { FORMAT, FIELDS, buildExport, parseImportFile, analyzeImport, applyImport };
