'use strict';
// Esportazione/importazione dei flussi tra due "computer" (due motori con dati separati),
// tramite le API HTTP: selezione, nuovi flussi, copie esatte, conflitti e le quattro scelte
// (mantieni, sostituisci, duplica, elimina); importazione di playlist M3U/PLS e config.json.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Engine } = require('../src/engine');
const { parseImportFile } = require('../src/engine/transfer');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-transfer-'));
const api = (port, method, p, body) => fetch(`http://127.0.0.1:${port}${p}`, {
  method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
}).then(async r => ({ status: r.status, headers: r.headers, data: await r.json() }));

(async () => {
  // flussi disattivati: il test non deve collegarsi a server reali
  const off = { enabled: false };
  const A = new Engine({ dataDir: path.join(dir, 'pc-a'), port: 9591, host: '127.0.0.1' });
  const B = new Engine({ dataDir: path.join(dir, 'mac-b'), port: 9592, host: '127.0.0.1' });
  await A.start(); await B.start();

  const radio1 = A.addStream({ name: 'Radio Uno', url: 'http://radio1.example:8000/live.mp3', ...off });
  const radio2 = A.addStream({ name: 'Radio Due', url: 'https://radio2.example/stream', silenceSeconds: 15, ...off });
  const tv = A.addStream({ name: 'Web TV', url: 'https://tv.example/master.m3u8', headers: 'Referer: https://tv.example/', ...off });
  const radio4 = A.addStream({ name: 'Radio Quattro', url: 'http://radio4.example:8000/', ...off });
  A.addStream({ name: 'Non selezionato', url: 'http://other.example/x.mp3', ...off });

  // ---- esportazione di una selezione ----
  const ids = [radio1.id, radio2.id, tv.id, radio4.id];
  const exp = await api(9591, 'GET', `/api/export?ids=${ids.join(',')}`);
  assert.strictEqual(exp.status, 200);
  assert.match(exp.headers.get('content-disposition'), /attachment; filename="TRIP-Streaming-Monitor-\d{4}-\d\d-\d\d-4\.json"/);
  assert.strictEqual(exp.data.format, 'trip-streaming-monitor/streams');
  assert.strictEqual(exp.data.count, 4);
  assert.deepStrictEqual(exp.data.streams.map(s => s.name), ['Radio Uno', 'Radio Due', 'Web TV', 'Radio Quattro']);
  assert.strictEqual(exp.data.streams[2].headers, 'Referer: https://tv.example/');
  const all = await api(9591, 'GET', '/api/export');
  assert.strictEqual(all.data.count, 5, 'esportazione completa');
  const file = JSON.stringify(exp.data, null, 2);

  // ---- sul secondo computer: un flusso identico, uno modificato, uno con lo stesso URL, uno diverso ----
  B.addStream({ ...exp.data.streams[0] }, radio1.id);                                   // copia esatta (stesso id)
  B.addStream({ ...exp.data.streams[1], silenceSeconds: 30, name: 'Radio 2' }, radio2.id); // stesso id, dati diversi
  const tvB = B.addStream({ name: 'TV locale', url: 'https://TV.example/master.m3u8', ...off }); // stesso URL, altro id
  const r4B = B.addStream({ name: 'radio quattro', url: 'http://radio4-new.example/', ...off }); // stesso nome, URL diverso
  B.addStream({ name: 'Solo sul Mac', url: 'http://mac.example/a.mp3', ...off });

  const pre = await api(9592, 'POST', '/api/import/preview', { text: file });
  assert.strictEqual(pre.status, 200);
  const st = pre.data.items.map(i => `${i.incoming.name}:${i.status}${i.match ? '/' + i.match : ''}`);
  assert.deepStrictEqual(st, ['Radio Uno:identical/id', 'Radio Due:conflict/id', 'Web TV:conflict/url', 'Radio Quattro:conflict/name']);
  assert.deepStrictEqual(pre.data.items[1].diffs, ['name', 'silenceSeconds']);
  assert.deepStrictEqual(pre.data.items[2].diffs, ['name', 'url', 'headers']);
  assert.strictEqual(pre.data.items[2].existing.id, tvB.id);

  // ---- scelte: identico → nessuna azione, Radio Due → sostituisci, Web TV → duplica, Radio Quattro → elimina ----
  const decisions = [
    { incoming: pre.data.items[0].incoming, action: 'keep', existingId: radio1.id },
    { incoming: pre.data.items[1].incoming, action: 'replace', existingId: radio2.id },
    { incoming: pre.data.items[2].incoming, action: 'duplicate', existingId: tvB.id },
    { incoming: pre.data.items[3].incoming, action: 'delete', existingId: r4B.id }
  ];
  const app = await api(9592, 'POST', '/api/import/apply', { decisions });
  assert.deepStrictEqual(app.data.summary, { added: 0, replaced: 1, duplicated: 1, deleted: 1, kept: 1, skipped: 0 });
  const after = B.store.streams.map(s => s.name);
  assert.deepStrictEqual(after, ['Radio Uno', 'Radio Due', 'TV locale', 'Solo sul Mac', 'Web TV']);
  const r2 = B.store.streams.find(s => s.id === radio2.id);
  assert.strictEqual(r2.silenceSeconds, 15, 'sostituito con i dati importati');
  assert.strictEqual(B.store.streams.find(s => s.name === 'Web TV').headers, 'Referer: https://tv.example/');

  // ---- importazione su un computer vuoto: ritornano i flussi originali, con gli stessi id ----
  const C = new Engine({ dataDir: path.join(dir, 'pc-c'), port: 9593, host: '127.0.0.1' });
  await C.start();
  const preC = await api(9593, 'POST', '/api/import/preview', { text: JSON.stringify(all.data) });
  assert.ok(preC.data.items.every(i => i.status === 'new'));
  await api(9593, 'POST', '/api/import/apply', { decisions: preC.data.items.map(i => ({ incoming: i.incoming, action: 'add' })) });
  assert.deepStrictEqual(C.store.streams.map(s => [s.id, s.name, s.url]), A.store.streams.map(s => [s.id, s.name, s.url]));
  // reimportando lo stesso file risultano tutte copie esatte
  const again = await api(9593, 'POST', '/api/import/preview', { text: JSON.stringify(all.data) });
  assert.ok(again.data.items.every(i => i.status === 'identical'));
  // "aggiungi" su un nome già presente → nome reso univoco
  await api(9593, 'POST', '/api/import/apply', { decisions: [{ incoming: { name: 'Radio Uno', url: 'http://x.example/' }, action: 'add' }] });
  assert.ok(C.store.streams.some(s => s.name === 'Radio Uno (2)'));

  // ---- altri formati ----
  const m3u = parseImportFile('#EXTM3U\n#EXTINF:-1,Radio Alfa\nhttp://alfa.example/live\n#EXTINF:-1,Radio Beta\nbeta.example:8000/;\n');
  assert.strictEqual(m3u.source, 'm3u');
  assert.deepStrictEqual(m3u.streams.map(s => [s.name, s.url]), [['Radio Alfa', 'http://alfa.example/live'], ['Radio Beta', 'http://beta.example:8000/;']]);
  const pls = parseImportFile('[playlist]\nFile1=http://a.example/1\nTitle1=Uno\nFile2=http://a.example/2\nNumberOfEntries=2\n');
  assert.deepStrictEqual(pls.streams.map(s => s.name), ['Uno', 'a.example/2']);
  const cfg = parseImportFile(fs.readFileSync(path.join(dir, 'pc-a', 'config.json'), 'utf8'));
  assert.strictEqual(cfg.source, 'config');
  assert.strictEqual(cfg.streams.length, 5);
  assert.deepStrictEqual(parseImportFile('{bad').errors, ['invalid-json']);
  assert.deepStrictEqual(parseImportFile('{"foo":1}').errors, ['unknown-format']);
  assert.deepStrictEqual(parseImportFile('#EXTM3U\n#EXT-X-VERSION:3\nseg.ts').errors, ['hls-not-list']);

  console.log('OK');
  A.stop(); B.stop(); C.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
