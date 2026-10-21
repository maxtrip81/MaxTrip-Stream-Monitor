'use strict';
// Test end-to-end del rilevamento: un ffmpeg locale trasmette un flusso MP3 via HTTP
// (4 s di tono, poi silenzio), poi viene interrotto e riavviato.
const { spawn } = require('child_process');
const assert = require('assert');
const { StreamMonitor, FFMPEG } = require('../src/engine/monitor');

const PORT = 9123;
const URL = `http://127.0.0.1:${PORT}/live.mp3`;

function source(expr) {
  return spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i',
    `aevalsrc='${expr}':s=44100:c=stereo`, '-c:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3',
    '-listen', '1', URL], { stdio: 'ignore' });
}

(async () => {
  let src = source('if(lt(t,4),0.5*sin(2*PI*440*t),0)');
  await new Promise(r => setTimeout(r, 2500)); // tempo per avviare la sorgente di prova
  const m = new StreamMonitor({ id: 't', name: 'Test', url: URL },
    () => ({ silenceThresholdDb: -50, silenceSeconds: 3, offAirSeconds: 4, recoverSeconds: 2 }));
  const events = [];
  let maxPeak = -99;
  m.on('event', e => { events.push(e.type + (e.from ? ':' + e.from : '')); console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s  event`, e.type, e.from || '', e.reason || ''); });
  m.on('state', s => console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s  state ->`, s));
  const lv = setInterval(() => { maxPeak = Math.max(maxPeak, m.levels.peakL); }, 100);
  const t0 = Date.now();
  m.start();
  await new Promise(r => setTimeout(r, 9000));      // tono 4 s + silenzio
  src.kill('SIGKILL');                               // interruzione
  await new Promise(r => setTimeout(r, 6000));
  src = source('0.5*sin(2*PI*440*t)');               // ripresa
  await new Promise(r => setTimeout(r, 20000));
  m.stop(); src.kill('SIGKILL'); clearInterval(lv);
  console.log('events:', events, 'max peak dBFS:', maxPeak.toFixed(1));
  assert.ok(maxPeak > -8 && maxPeak < 0, 'peak level of a 0.5 sine should be ~ -6 dBFS');
  assert.deepStrictEqual(events.slice(0, 4), ['online', 'silence', 'offair', 'recovered:offair']);
  console.log('OK');
})();
