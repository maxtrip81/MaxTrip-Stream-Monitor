'use strict';
// Testi lato motore (notifiche push) in italiano e inglese.
const T = {
  it: {
    offair: '🔴 OFF AIR — {name}',
    offairBody: 'Interruzione del segnale streaming.{reason}',
    silence: '🟡 SILENZIO — {name}',
    silenceBody: 'Nessun audio da almeno {sec} s (livello {lvl} dBFS, soglia {thr} dBFS).',
    recovered: '🟢 RIPRESA — {name}',
    recoveredOffair: 'Segnale ripristinato dopo un\'interruzione di {dur}.',
    recoveredSilence: 'Audio ripristinato dopo {dur} di silenzio.',
    reason: ' Causa: {r}',
    test: '✅ Test notifica — TRIP Streaming Monitor',
    testBody: 'Le notifiche funzionano correttamente.',
    url: 'URL'
  },
  en: {
    offair: '🔴 OFF AIR — {name}',
    offairBody: 'Stream signal interrupted.{reason}',
    silence: '🟡 SILENCE — {name}',
    silenceBody: 'No audio for at least {sec} s (level {lvl} dBFS, threshold {thr} dBFS).',
    recovered: '🟢 RECOVERED — {name}',
    recoveredOffair: 'Signal restored after a {dur} interruption.',
    recoveredSilence: 'Audio restored after {dur} of silence.',
    reason: ' Cause: {r}',
    test: '✅ Test notification — TRIP Streaming Monitor',
    testBody: 'Notifications are working correctly.',
    url: 'URL'
  }
};

function fmt(str, vars) {
  return str.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : ''));
}

function duration(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (h) return `${h}h ${m}m ${r}s`;
  if (m) return `${m}m ${r}s`;
  return `${r}s`;
}

/** Costruisce titolo e testo localizzati per un evento. */
function describe(ev, lang) {
  const t = T[lang] || T.it;
  const v = { name: ev.name };
  switch (ev.type) {
    case 'offair':
      return { title: fmt(t.offair, v), body: fmt(t.offairBody, { reason: ev.reason ? fmt(t.reason, { r: ev.reason }) : '' }) };
    case 'silence':
      return {
        title: fmt(t.silence, v),
        body: fmt(t.silenceBody, { sec: ev.seconds, lvl: Math.round(ev.level), thr: ev.threshold })
      };
    case 'recovered':
      return {
        title: fmt(t.recovered, v),
        body: fmt(ev.from === 'silence' ? t.recoveredSilence : t.recoveredOffair, { dur: duration(ev.duration || 0) })
      };
    case 'test':
      return { title: t.test, body: t.testBody };
    default:
      return { title: ev.name || 'TRIP Streaming Monitor', body: ev.type };
  }
}

module.exports = { describe, duration };
