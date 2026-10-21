'use strict';
// Server di prova che riproducono il comportamento reale di Icecast 2.4, Shoutcast v1,
// Shoutcast v2, siti web di radio/TV, playlist, HLS (anche protetto da Referer) e HTTPS.
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MP3_RATE = 12000; // 96 kbit/s

/** Invia l'MP3 a velocità reale; con metaint inserisce i metadati ICY come i server veri. */
function liveSend(sock, mp3, metaint, title) {
  let off = 0, sinceMeta = 0;
  const meta = () => {
    const txt = Buffer.from(`StreamTitle='${title}';`);
    const len = Math.ceil(txt.length / 16);
    const block = Buffer.alloc(1 + len * 16);
    block[0] = len; txt.copy(block, 1);
    return block;
  };
  const send = () => {
    if (sock.destroyed || sock.writableEnded) return clearInterval(timer);
    let chunk = Buffer.alloc(0);
    let need = MP3_RATE / 4;
    while (need > 0) {
      const take = Math.min(need, mp3.length - off, metaint ? metaint - sinceMeta : Infinity);
      chunk = Buffer.concat([chunk, mp3.subarray(off, off + take)]);
      off = (off + take) % mp3.length; need -= take; sinceMeta += take;
      if (metaint && sinceMeta === metaint) { chunk = Buffer.concat([chunk, meta()]); sinceMeta = 0; }
    }
    sock.write(chunk);
  };
  const timer = setInterval(send, 250);
  send();
  sock.on('error', () => clearInterval(timer));
  sock.on('close', () => clearInterval(timer));
}

function start(dir, P) {
  const mp3 = fs.readFileSync(path.join(dir, 'radio.mp3'));
  const servers = [];
  const html = (res, body, extra = {}) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...extra }); res.end(body); };

  // ---- Icecast 2.4 ----
  servers.push(http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const H = { Server: 'Icecast 2.4.4' };
    if (u.pathname === '/status-json.xsl') {
      res.writeHead(200, { ...H, 'Content-Type': 'application/json' });
      // come nei server reali, listenurl usa il nome host configurato (qui sbagliato di proposito)
      return res.end(JSON.stringify({ icestats: { admin: 'icemaster@localhost', host: 'localhost', server_id: 'Icecast 2.4.4', source: [
        { listenurl: 'http://localhost:8000/live.mp3', server_name: 'Radio Icecast', server_type: 'audio/mpeg' },
        { listenurl: 'http://localhost:8000/backup.mp3', server_name: 'Radio Icecast Backup', server_type: 'audio/mpeg' }] } }));
    }
    if (u.pathname === '/live.mp3' || u.pathname === '/backup.mp3') {
      const metaint = req.headers['icy-metadata'] === '1' ? 8192 : 0;
      res.writeHead(200, { ...H, 'Content-Type': 'audio/mpeg', 'icy-name': 'Radio Icecast', 'icy-genre': 'Test', 'icy-br': '96', ...(metaint ? { 'icy-metaint': String(metaint) } : {}) });
      return liveSend(res, mp3, metaint, 'Artista - Brano');
    }
    if (u.pathname === '/') return html(res, '<html><head><title>Icecast Streaming Media Server</title></head><body>Icecast2 Status</body></html>', H);
    res.writeHead(404, H); res.end('<html><body><b>404 - The file you requested could not be found</b></body></html>');
  }).listen(P.icecast));

  // ---- Shoutcast v2 ----
  servers.push(http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const H = { Server: 'Shoutcast v2.6.1.777/posix(linux x64)' };
    if (u.pathname === '/statistics' && u.searchParams.get('json') === '1') {
      res.writeHead(200, { ...H, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ totalstreams: 1, activestreams: 1, streams: [{ id: 1, servertitle: 'Radio Shoutcast 2', streampath: '/stream', streamstatus: 1 }] }));
    }
    if (u.pathname === '/stream') {
      res.writeHead(200, { ...H, 'Content-Type': 'audio/mpeg', 'icy-name': 'Radio Shoutcast 2', 'icy-br': '96' });
      return liveSend(res, mp3, 0);
    }
    if (u.pathname === '/listen.pls') {
      res.writeHead(200, { ...H, 'Content-Type': 'audio/x-scpls' });
      return res.end(`[playlist]\nNumberOfEntries=1\nFile1=http://localhost:${P.sc2}/stream\nTitle1=Radio Shoutcast 2\nLength1=-1\nVersion=2\n`);
    }
    html(res, '<html><head><title>SHOUTcast Server</title></head><body>SHOUTcast D.N.A.S. Status</body></html>', H);
  }).listen(P.sc2));

  // ---- Shoutcast v1 (risposta "ICY 200 OK", non HTTP standard) ----
  servers.push(net.createServer(sock => {
    sock.on('error', () => {});
    sock.once('data', d => {
      const req = d.toString('latin1');
      const p = (req.match(/^GET (\S+)/) || [])[1] || '/';
      const browser = /user-agent:[^\r\n]*mozilla/i.test(req);
      if (p === '/7.html') {
        sock.end('HTTP/1.0 200 OK\r\nContent-Type: text/html\r\n\r\n<html><body>1,1,12,100,1,96,Artista - Brano</body></html>');
      } else if (p === '/index.html' || ((p === '/' ) && browser)) {
        sock.end('HTTP/1.0 200 OK\r\nContent-Type: text/html\r\n\r\n<html><head><title>SHOUTcast Administrator</title></head><body>SHOUTcast D.N.A.S. Status</body></html>');
      } else if (p === '/' || p === '/;' || p.startsWith('/;')) {
        const metaint = /icy-metadata:\s*1/i.test(req) ? 8192 : 0;
        sock.write(`ICY 200 OK\r\nicy-notice1:<BR>This stream requires Winamp<BR>\r\nicy-name:Radio Shoutcast 1\r\nicy-genre:Test\r\ncontent-type:audio/mpeg\r\nicy-pub:1\r\nicy-br:96\r\n${metaint ? `icy-metaint:${metaint}\r\n` : ''}\r\n`);
        liveSend(sock, mp3, metaint, 'Artista - Brano');
      } else {
        sock.end('HTTP/1.0 404 Not Found\r\n\r\n');
      }
    });
  }).listen(P.sc1));

  // ---- siti web, playlist, redirect, HLS ----
  servers.push(http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    if (p === '/radio-page') return html(res, `<!doctype html><html><body><h1>Radio Uno</h1><audio controls preload="none"><source src="http://localhost:${P.icecast}/live.mp3" type="audio/mpeg"></audio></body></html>`);
    if (p === '/tv-page') return html(res, `<!doctype html><html><body><div id="player"></div><script>var cfg = {"source":"http:\\/\\/localhost:${P.web}\\/tv\\/master.m3u8","poster":"\\/img\\/poster.jpg"};</script><script src="/js/player.min.js"></script></body></html>`);
    if (p === '/empty-page') return html(res, '<!doctype html><html><body>Nessun player qui</body></html>');
    if (p === '/failover.pls') {
      res.writeHead(200, { 'Content-Type': 'audio/x-scpls' });
      return res.end(`[playlist]\nNumberOfEntries=2\nFile1=http://127.0.0.1:${P.dead}/down.mp3\nFile2=http://localhost:${P.icecast}/live.mp3\nVersion=2\n`);
    }
    if (p === '/redirect') { res.writeHead(302, { Location: `http://localhost:${P.sc2}/listen.pls?sid=1` }); return res.end(); }
    if (p.startsWith('/tv/') || p.startsWith('/protected/')) {
      if (p.startsWith('/protected/') && req.headers.referer !== 'https://tv.example/') { res.writeHead(403); return res.end('Forbidden'); }
      const f = path.join(dir, 'tv', p.replace(/^\/(tv|protected)\//, ''));
      return fs.readFile(f, (err, buf) => {
        if (err) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': f.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t' });
        res.end(buf);
      });
    }
    res.writeHead(404); res.end();
  }).listen(P.web));

  // ---- HTTPS con certificato autofirmato (se openssl è disponibile) ----
  let httpsOk = false;
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=localhost',
      '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
    servers.push(https.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) }, (req, res) => {
      res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' });
      res.end(`#EXTM3U\n#EXTINF:-1,Radio\nhttp://localhost:${P.icecast}/live.mp3\n`);
    }).listen(P.https));
    httpsOk = true;
  } catch (_) { /* openssl assente */ }

  return { httpsOk, close: () => servers.forEach(s => s.close()) };
}

module.exports = { start };
