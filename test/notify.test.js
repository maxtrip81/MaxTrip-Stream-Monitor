'use strict';
// Test dei canali di notifica contro server simulati in locale:
// email (SMTP), push Android (OAuth + FCM v1), push iPhone (APNs HTTP/2), SMS/WhatsApp (Twilio),
// ntfy, Discord, Slack, webhook. Verifica contenuti, firme JWT e rimozione dei token non validi.
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const http2 = require('http2');
const { SMTPServer } = require('smtp-server');

const PORT = { http: 9481, h2: 9482, smtp: 9483 };
process.env.SM_FCM_API = `http://127.0.0.1:${PORT.http}/fcm`;
process.env.SM_TWILIO_API = `http://127.0.0.1:${PORT.http}/twilio`;
process.env.SM_APNS_HOST = `http://127.0.0.1:${PORT.h2}`;
const { sendAll } = require('../src/engine/notifier');

const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pem = k => k.export({ type: 'pkcs8', format: 'pem' });

function verifyJwt(token, key, alg) {
  const [h, c, sig] = token.split('.');
  const s = Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const ok = alg === 'RS256'
    ? crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), key, s)
    : crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, s);
  assert.ok(ok, `firma ${alg} non valida`);
  return JSON.parse(Buffer.from(c, 'base64').toString());
}

const got = { http: [], apns: [], mail: [] };

const httpSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    got.http.push({ url: req.url, headers: req.headers, body });
    if (req.url === '/oauth') {
      const claims = verifyJwt(new URLSearchParams(body).get('assertion'), rsa.publicKey, 'RS256');
      assert.strictEqual(claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }));
    }
    if (req.url.startsWith('/fcm/') && JSON.parse(body).message.token === 'android-old') {
      res.writeHead(404); return res.end('{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
}).listen(PORT.http);

const h2 = http2.createServer().listen(PORT.h2);
h2.on('stream', (stream, headers) => {
  let body = '';
  stream.on('data', d => { body += d; });
  stream.on('end', () => {
    got.apns.push({ headers, body });
    const bad = headers[':path'].endsWith('/ios-old');
    stream.respond({ ':status': bad ? 410 : 200 });
    stream.end(bad ? '{"reason":"Unregistered"}' : '');
  });
});

const smtp = new SMTPServer({
  authOptional: true, disabledCommands: ['STARTTLS'],
  onAuth(auth, session, cb) { cb(null, { user: auth.username }); },
  onData(stream, session, cb) {
    let data = '';
    stream.on('data', d => { data += d; });
    stream.on('end', () => { got.mail.push({ to: session.envelope.rcptTo.map(r => r.address), data }); cb(); });
  }
}).listen(PORT.smtp);

const base = `http://127.0.0.1:${PORT.http}`;
const settings = {
  language: 'it',
  notify: {
    mobile: {
      enabled: true,
      fcm: { serviceAccount: JSON.stringify({ project_id: 'demo-sm', client_email: 'sm@demo.iam.gserviceaccount.com', private_key: pem(rsa.privateKey), token_uri: `${base}/oauth` }) },
      apns: { keyId: 'ABC123DEFG', teamId: 'TEAM123456', bundleId: 'it.maxtrip.streammonitor', privateKey: pem(ec.privateKey), production: false }
    },
    email: { enabled: true, host: '127.0.0.1', port: PORT.smtp, user: 'u', pass: 'p', from: 'monitor@maxtrip.it', to: 'a@x.it, b@x.it' },
    twilio: { enabled: true, accountSid: 'AC123', authToken: 'tok', from: '+15550001', to: '+393331112222, +393334445555' },
    ntfy: { enabled: true, server: `${base}/ntfy`, topic: 'radio-test' },
    discord: { enabled: true, url: `${base}/discord` },
    slack: { enabled: true, url: `${base}/slack` },
    webhook: { enabled: true, url: `${base}/hook` }
  }
};
const devices = [
  { token: 'android-1', platform: 'android', lang: 'en', name: 'Pixel' },
  { token: 'android-old', platform: 'android', lang: 'it', name: 'Vecchio' },
  { token: 'ios-1', platform: 'ios', lang: 'it', name: 'iPhone' },
  { token: 'ios-old', platform: 'ios', lang: 'it', name: 'iPad' }
];

(async () => {
  let invalid = [];
  const ev = { type: 'offair', streamId: 's1', name: 'Radio Uno', url: 'http://radio.example/live', reason: 'Connection refused', time: Date.now() };
  const results = await sendAll(ev, settings, { devices, onInvalidDevices: t => { invalid = t; } });
  console.table(results);
  for (const r of results) assert.ok(r.ok, `${r.channel}: ${r.error}`);
  assert.deepStrictEqual(results.map(r => r.channel).sort(), ['app', 'discord', 'email', 'ntfy', 'slack', 'sms', 'webhook']);
  assert.strictEqual(results.find(r => r.channel === 'app').info, '2/4');
  assert.deepStrictEqual(invalid.sort(), ['android-old', 'ios-old']);

  // push Android: lingua del dispositivo (en), canale "alarms", token OAuth
  const fcm = got.http.filter(r => r.url === '/fcm/v1/projects/demo-sm/messages:send').map(r => ({ ...r, msg: JSON.parse(r.body).message }));
  const pixel = fcm.find(r => r.msg.token === 'android-1');
  assert.strictEqual(pixel.headers.authorization, 'Bearer ya29.test');
  assert.strictEqual(pixel.msg.notification.title, '🔴 OFF AIR — Radio Uno');
  assert.match(pixel.msg.notification.body, /Stream signal interrupted/);
  assert.strictEqual(pixel.msg.android.notification.channel_id, 'alarms');
  assert.strictEqual(got.http.filter(r => r.url === '/oauth').length, 1, 'token OAuth riutilizzato');

  // push iPhone: JWT ES256, topic, testo italiano
  const ios = got.apns.find(r => r.headers[':path'] === '/3/device/ios-1');
  const claims = verifyJwt(ios.headers.authorization.replace('bearer ', ''), ec.publicKey, 'ES256');
  assert.strictEqual(claims.iss, 'TEAM123456');
  assert.strictEqual(ios.headers['apns-topic'], 'it.maxtrip.streammonitor');
  const aps = JSON.parse(ios.body).aps;
  assert.strictEqual(aps.alert.title, '🔴 OFF AIR — Radio Uno');
  assert.match(aps.alert.body, /Interruzione del segnale/);

  // email a due destinatari
  assert.strictEqual(got.mail.length, 1);
  assert.deepStrictEqual(got.mail[0].to, ['a@x.it', 'b@x.it']);
  assert.match(got.mail[0].data, /Subject: =\?UTF-8\?/);
  assert.match(got.mail[0].data, /Massimiliano Mascioli Trippa/);

  // SMS: un messaggio per destinatario, autenticazione Basic
  const sms = got.http.filter(r => r.url === '/twilio/2010-04-01/Accounts/AC123/Messages.json');
  assert.strictEqual(sms.length, 2);
  assert.strictEqual(sms[0].headers.authorization, 'Basic ' + Buffer.from('AC123:tok').toString('base64'));
  assert.match(new URLSearchParams(sms[0].body).get('Body'), /OFF AIR — Radio Uno/);

  // WhatsApp tramite Twilio
  got.http.length = 0;
  const wa = await sendAll(ev, { language: 'it', notify: { twilio: { ...settings.notify.twilio, from: 'whatsapp:+14155238886' } } });
  assert.deepStrictEqual(wa, [{ channel: 'whatsapp', ok: true }]);
  assert.strictEqual(new URLSearchParams(got.http[0].body).get('To'), 'whatsapp:+393331112222');

  // canale non configurato → errore leggibile, gli altri continuano
  const partial = await sendAll(ev, { language: 'it', notify: { mobile: { enabled: true }, slack: settings.notify.slack } },
    { devices: [devices[0]] });
  assert.ok(partial.find(r => r.channel === 'slack').ok);
  assert.match(partial.find(r => r.channel === 'app').error, /FCM non configurato/);

  console.log('OK');
  httpSrv.close(); h2.close(); smtp.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
