'use strict';
// Test end-to-end di tutti i tipi di link con l'FFmpeg incluso nell'app:
// Icecast 2.4, Shoutcast v1/v2, indirizzi del server senza mountpoint, pagine web,
// playlist (anche con server di riserva), redirect, HTTPS autofirmato, HLS con più qualità
// e video (anteprima), HLS protetto da Referer, RTMP, SRT, UDP. Controlla monitoraggio e ascolto.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { FFMPEG } = require('../src/engine/monitor');
const { Engine } = require('../src/engine');
const servers = require('./servers');

const P = { icecast: 9481, sc2: 9482, sc1: 9483, web: 9484, https: 9485, dead: 9486, api: 9487, rtmp: 19350, srt: 9488, udp: 9489 };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-test-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const procs = [];
const ff = (args, opts = {}) => { const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', ...args], { stdio: 'ignore', ...opts }); procs.push(p); return p; };

const protocols = execFileSync(FFMPEG, ['-hide_banner', '-protocols'], { encoding: 'utf8' });
const has = proto => new RegExp(`^\\s*${proto}\\s*$`, 'm').test(protocols.split('Output:')[0]);

(async () => {
  console.log('ffmpeg:', FFMPEG);
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=44100:duration=120',
    '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '96k', path.join(dir, 'radio.mp3')]);
  fs.mkdirSync(path.join(dir, 'tv'));
  // web TV: HLS con due qualità video (640x360 e 320x180), audio in ogni variante
  ff(['-re', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=f=550:sample_rate=48000',
    '-filter_complex', '[0:v]split=2[v1][v2];[v2]scale=320:180[v2o]', '-map', '[v1]', '-map', '1:a', '-map', '[v2o]', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-b:v:0', '800k', '-b:v:1', '200k', '-c:a', 'aac', '-b:a', '64k', '-ac', '2',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '6', '-hls_flags', 'delete_segments', '-var_stream_map', 'v:0,a:0 v:1,a:1',
    '-master_pl_name', 'master.m3u8', path.join(dir, 'tv', 'v%v', 'index.m3u8')]);
  const srv = servers.start(dir, P);
  const tone = ['-re', '-f', 'lavfi', '-i', 'sine=f=660:sample_rate=44100', '-ac', '2', '-c:a', 'aac', '-b:a', '96k'];
  ff([...tone, '-f', 'flv', '-listen', '1', `rtmp://127.0.0.1:${P.rtmp}/live/radio`]);
  if (has('srt')) ff([...tone, '-f', 'mpegts', `srt://127.0.0.1:${P.srt}?mode=listener`]);
  ff([...tone, '-f', 'mpegts', `udp://127.0.0.1:${P.udp}?pkt_size=1316`]);
  for (let i = 0; i < 60 && !fs.existsSync(path.join(dir, 'tv', 'master.m3u8')); i++) await sleep(250);
  await sleep(5000);

  const L = 'localhost';
  const cases = [
    // [nome, url, opzioni, controlli]
    ['Icecast 2.4 mountpoint', `http://${L}:${P.icecast}/live.mp3`, {}, { listen: true, name: 'Radio Icecast' }],
    ['Icecast 2.4 solo server', `http://${L}:${P.icecast}/`, {}, { kind: 'icecast', listen: true }],
    ['Icecast mount spento', `http://${L}:${P.icecast}/offline.mp3`, {}, { offair: /404/ }],
    ['Shoutcast v2 solo server', `${L}:${P.sc2}`, {}, { kind: 'shoutcast2', listen: true }],
    ['Shoutcast v2 listen.pls', `http://${L}:${P.sc2}/listen.pls?sid=1`, {}, { kind: 'playlist' }],
    ['Shoutcast v1 (ICY 200)', `http://${L}:${P.sc1}/`, {}, { kind: 'shoutcast1', listen: true, name: 'Radio Shoutcast 1' }],
    ['Shoutcast v1 /;', `http://${L}:${P.sc1}/;`, {}, {}],
    ['Shoutcast v1 pagina stato', `http://${L}:${P.sc1}/index.html`, {}, { kind: 'shoutcast1' }],
    ['icy:// link', `icy://${L}:${P.icecast}/live.mp3`, {}, {}],
    ['Pagina web radio', `http://${L}:${P.web}/radio-page`, {}, { kind: /^page/, listen: true }],
    ['Pagina web TV (HLS)', `http://${L}:${P.web}/tv-page`, {}, { kind: /^page/, video: true }],
    ['Pagina senza flussi', `http://${L}:${P.web}/empty-page`, {}, { offair: /nessun flusso|no stream/i }],
    ['Playlist con server di riserva', `http://${L}:${P.web}/failover.pls`, {}, { kind: 'playlist' }],
    ['Redirect → playlist', `http://${L}:${P.web}/redirect`, {}, {}],
    ['HLS master (più qualità)', `http://${L}:${P.web}/tv/master.m3u8`, {}, { kind: 'hls-variant', video: true, listen: true, thumb: true }],
    ['HLS protetto (Referer)', `http://${L}:${P.web}/protected/master.m3u8`, { headers: 'Referer: https://tv.example/' }, {}],
    ['HLS protetto senza Referer', `http://${L}:${P.web}/protected/v1/index.m3u8`, {}, { offair: /403|Forbidden/ }],
    ['RTMP', `rtmp://127.0.0.1:${P.rtmp}/live/radio`, {}, {}],
    ['UDP (MPEG-TS)', `udp://127.0.0.1:${P.udp}`, {}, {}]
  ];
  if (srv.httpsOk) cases.push(['HTTPS autofirmato → M3U', `https://${L}:${P.https}/radio.m3u`, {}, { kind: 'playlist' }]);
  if (has('srt')) cases.push(['SRT', `srt://127.0.0.1:${P.srt}`, {}, {}]);

  const engine = new Engine({ dataDir: path.join(dir, 'data'), port: P.api, host: '127.0.0.1' });
  await engine.start();
  const ids = cases.map(([name, url, o]) => engine.addStream({ name, url, ...o }).id);
  await sleep(25000);

  let failed = 0;
  const check = (ok, msg) => { console.log(`${ok ? '  ok  ' : '  FAIL'} ${msg}`); if (!ok) failed++; };
  const listen = id => new Promise(resolve => {
    let n = 0;
    const req = http.get(`http://127.0.0.1:${P.api}/api/streams/${id}/listen`, res => {
      if (res.statusCode !== 200) { res.resume(); return resolve(-res.statusCode); }
      res.on('data', c => { n += c.length; });
    });
    req.on('error', () => resolve(-1));
    setTimeout(() => { req.destroy(); resolve(n); }, 5000);
  });

  for (let i = 0; i < cases.length; i++) {
    const [name, , , exp] = cases[i];
    const s = engine.state().streams.find(x => x.id === ids[i]);
    const info = s.info || {};
    const detail = [info.kind, info.audio && `${info.audio.codec} ${info.audio.bitrate || ''}`.trim(), info.video && `${info.video.width}x${info.video.height}`, info.name].filter(Boolean).join(' · ');
    if (exp.offair) {
      check(s.state === 'offair' && exp.offair.test(s.lastError), `${name.padEnd(30)} offair ← ${s.state}: ${s.lastError}`);
      continue;
    }
    check(s.state === 'onair', `${name.padEnd(30)} ${s.state.padEnd(7)} ${detail} ${s.state !== 'onair' ? s.lastError : ''}`);
    if (exp.kind) check(exp.kind instanceof RegExp ? exp.kind.test(info.kind) : info.kind === exp.kind, `${''.padEnd(30)} tipo: ${info.kind}`);
    if (exp.name) check(info.name === exp.name, `${''.padEnd(30)} nome stazione: ${info.name}`);
    if (exp.video) check(!!(info.video || info.hlsMaster), `${''.padEnd(30)} video rilevato`);
    if (exp.listen) { const b = await listen(ids[i]); check(b > 8000, `${''.padEnd(30)} ascolto MP3: ${b} byte`); }
    if (exp.thumb) check(s.thumbAt > 0, `${''.padEnd(30)} anteprima video`);
  }
  console.log(`protocolli FFmpeg: srt=${has('srt')} rist=${has('rist')} rtmps=${has('rtmps')} mmsh=${has('mmsh')} https=${has('https')} | HTTPS test: ${srv.httpsOk}`);

  engine.stop(); srv.close(); procs.forEach(p => p.kill());
  await sleep(500);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  if (failed) { console.error(`${failed} controlli falliti`); process.exit(1); }
  console.log('OK');
  process.exit(0);
})().catch(e => { console.error(e); procs.forEach(p => p.kill()); process.exit(1); });
