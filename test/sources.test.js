'use strict';
// Test end-to-end dei tipi di link: MP3 diretto, playlist .pls/.m3u/.asx, HLS live.
// Usa il nome "localhost" (verifica la risoluzione DNS di FFmpeg) e controlla sia il
// monitoraggio (ON AIR) sia l'ascolto (conversione in MP3) con l'FFmpeg incluso nell'app.
const { spawn, execFileSync } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { FFMPEG } = require('../src/engine/monitor');
const { Engine } = require('../src/engine');

const SRC_PORT = 9471, API_PORT = 9472;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-test-'));
const base = `http://localhost:${SRC_PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TYPES = { '.mp3': 'audio/mpeg', '.pls': 'audio/x-scpls', '.m3u': 'audio/x-mpegurl', '.asx': 'video/x-ms-asf',
  '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t' };

(async () => {
  console.log('ffmpeg:', FFMPEG);
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=44100:duration=120',
    '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '96k', path.join(dir, 'radio.mp3')]);
  fs.writeFileSync(path.join(dir, 'radio.pls'), `[playlist]\nNumberOfEntries=1\nFile1=${base}/radio.mp3\nLength1=-1\nVersion=2\n`);
  fs.writeFileSync(path.join(dir, 'radio.m3u'), `#EXTM3U\n#EXTINF:-1,Test\n${base}/radio.mp3\n`);
  fs.writeFileSync(path.join(dir, 'radio.asx'), '<asx version="3.0"><entry><ref href="radio.pls"/></entry></asx>\n');
  fs.mkdirSync(path.join(dir, 'hls'));
  const hls = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'sine=f=660:sample_rate=44100',
    '-ac', '2', '-c:a', 'aac', '-b:a', '96k', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '5',
    path.join(dir, 'hls', 'live.m3u8')], { stdio: 'ignore' });

  const srv = http.createServer((req, res) => {
    const f = path.join(dir, decodeURIComponent(new URL(req.url, base).pathname));
    fs.readFile(f, (err, buf) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
      res.end(buf);
    });
  }).listen(SRC_PORT);

  for (let i = 0; i < 40 && !fs.existsSync(path.join(dir, 'hls', 'live.m3u8')); i++) await sleep(250);
  await sleep(3000);

  const engine = new Engine({ dataDir: path.join(dir, 'data'), port: API_PORT, host: '127.0.0.1' });
  await engine.start();
  const cases = {
    'MP3 diretto (senza http://)': `localhost:${SRC_PORT}/radio.mp3`,
    'Playlist PLS': `${base}/radio.pls`,
    'Playlist M3U': `${base}/radio.m3u`,
    'Playlist ASX → PLS': `${base}/radio.asx`,
    'HLS live': `${base}/hls/live.m3u8`
  };
  const ids = {};
  for (const [name, url] of Object.entries(cases)) ids[name] = engine.addStream({ name, url }).id;
  ids['Link errato'] = engine.addStream({ name: 'Link errato', url: `${base}/missing.mp3` }).id;
  await sleep(12000);

  let failed = 0;
  const check = (ok, msg) => { console.log(`${ok ? '  ok  ' : '  FAIL'} ${msg}`); if (!ok) failed++; };
  const state = engine.state().streams;
  for (const name of Object.keys(cases)) {
    const s = state.find(x => x.id === ids[name]);
    check(s.state === 'onair', `monitor  ${name.padEnd(28)} ${s.state} ${s.lastError || ''}`);
    const bytes = await new Promise(resolve => {
      let n = 0;
      const req = http.get(`http://127.0.0.1:${API_PORT}/api/streams/${ids[name]}/listen`, res => {
        if (res.statusCode !== 200 || res.headers['content-type'] !== 'audio/mpeg') { res.resume(); return resolve(-res.statusCode); }
        res.on('data', c => { n += c.length; });
      });
      req.on('error', () => resolve(-1));
      setTimeout(() => { req.destroy(); resolve(n); }, 5000);
    });
    check(bytes > 8000, `ascolto  ${name.padEnd(28)} ${bytes} byte MP3`);
  }
  const bad = state.find(x => x.id === ids['Link errato']);
  check(bad.state === 'offair' && /404/.test(bad.lastError), `link errato → ${bad.state}: ${bad.lastError}`);

  engine.stop(); srv.close(); hls.kill();
  await sleep(300);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  if (failed) { console.error(`${failed} controlli falliti`); process.exit(1); }
  console.log('OK');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
