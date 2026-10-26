'use strict';
// Notifiche push native verso l'app TRIP Streaming Monitor per smartphone:
//  - Android → Firebase Cloud Messaging (API HTTP v1, account di servizio Google)
//  - iPhone  → Apple Push Notification service (chiave .p8, HTTP/2)
// Nessuna dipendenza esterna: i token JWT sono firmati con il modulo crypto di Node.
const crypto = require('crypto');
const http2 = require('http2');

const FCM_API = () => process.env.SM_FCM_API || 'https://fcm.googleapis.com';
const APNS_HOST = prod => process.env.SM_APNS_HOST || (prod ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com');

const b64url = buf => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

function jwt(header, claims, sign) {
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  return `${data}.${b64url(sign(data))}`;
}

// ---------- Firebase Cloud Messaging (Android) ----------
let fcmCache = { key: '', token: '', exp: 0, pending: null, pendingKey: '' };

function parseServiceAccount(json) {
  const sa = typeof json === 'string' ? JSON.parse(json) : json;
  if (!sa || !sa.project_id || !sa.client_email || !sa.private_key) throw new Error('service account JSON non valido / invalid');
  return sa;
}

function fcmAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  if (fcmCache.key === sa.client_email && fcmCache.exp - 60 > now) return fcmCache.token;
  // richiesta condivisa: più dispositivi in parallelo usano lo stesso token
  if (fcmCache.pending && fcmCache.pendingKey === sa.client_email) return fcmCache.pending;
  const pending = requestFcmToken(sa, now).finally(() => { if (fcmCache.pending === pending) fcmCache.pending = null; });
  fcmCache.pending = pending;
  fcmCache.pendingKey = sa.client_email;
  return pending;
}

async function requestFcmToken(sa, now) {
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const assertion = jwt({ alg: 'RS256', typ: 'JWT' }, {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: tokenUri, iat: now, exp: now + 3600
  }, data => crypto.sign('RSA-SHA256', Buffer.from(data), sa.private_key));
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(10000)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`OAuth ${res.status} ${body.error_description || body.error || ''}`.trim());
  Object.assign(fcmCache, { key: sa.client_email, token: body.access_token, exp: now + (body.expires_in || 3600) });
  return body.access_token;
}

/** @returns {Promise<'ok'|'invalid'>} */
async function sendFcm(cfg, device, msg) {
  const sa = parseServiceAccount(cfg.serviceAccount);
  const access = await fcmAccessToken(sa);
  const res = await fetch(`${FCM_API()}/v1/projects/${sa.project_id}/messages:send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access}` },
    body: JSON.stringify({
      message: {
        token: device.token,
        notification: { title: msg.title, body: msg.body },
        data: msg.data,
        android: {
          priority: 'HIGH',
          notification: { channel_id: msg.urgent ? 'alarms' : 'events', sound: 'default', tag: msg.data.streamId }
        }
      }
    }),
    signal: AbortSignal.timeout(10000)
  });
  if (res.ok) return 'ok';
  const text = await res.text();
  if (res.status === 404 || /UNREGISTERED|registration-token-not-registered/i.test(text)) return 'invalid';
  throw new Error(`FCM ${res.status} ${text.slice(0, 200)}`);
}

// ---------- Apple Push Notification service (iOS) ----------
let apnsCache = { key: '', token: '', iat: 0 };

function apnsJwt(cfg) {
  const now = Math.floor(Date.now() / 1000);
  const cacheKey = cfg.keyId + cfg.teamId;
  if (apnsCache.key === cacheKey && now - apnsCache.iat < 45 * 60) return apnsCache.token;
  const token = jwt({ alg: 'ES256', kid: cfg.keyId }, { iss: cfg.teamId, iat: now },
    data => crypto.sign('sha256', Buffer.from(data), { key: cfg.privateKey, dsaEncoding: 'ieee-p1363' }));
  apnsCache = { key: cacheKey, token, iat: now };
  return token;
}

function sendApns(cfg, device, msg) {
  if (!cfg.keyId || !cfg.teamId || !cfg.bundleId || !cfg.privateKey) throw new Error('APNs: configurazione incompleta / incomplete');
  const auth = apnsJwt(cfg);
  return new Promise((resolve, reject) => {
    const client = http2.connect(APNS_HOST(cfg.production));
    const done = (fn, v) => { client.close(); fn(v); };
    client.on('error', e => done(reject, e));
    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${device.token}`,
      authorization: `bearer ${auth}`,
      'apns-topic': cfg.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-collapse-id': msg.data.streamId.slice(0, 64),
      'content-type': 'application/json'
    });
    let status = 0, body = '';
    req.setTimeout(10000, () => { req.close(); done(reject, new Error('APNs timeout')); });
    req.on('response', h => { status = h[':status']; });
    req.on('data', d => { body += d; });
    req.on('end', () => {
      if (status === 200) return done(resolve, 'ok');
      if (status === 410 || /BadDeviceToken|Unregistered|DeviceTokenNotForTopic/.test(body)) return done(resolve, 'invalid');
      done(reject, new Error(`APNs ${status} ${body.slice(0, 200)}`));
    });
    req.on('error', e => done(reject, e));
    req.end(JSON.stringify({
      aps: { alert: { title: msg.title, body: msg.body }, sound: 'default', 'thread-id': msg.data.streamId },
      ...msg.data
    }));
  });
}

/**
 * Invia la notifica a tutti i dispositivi registrati.
 * @param {object} cfg settings.notify.mobile
 * @param {Array} devices [{token, platform, lang}]
 * @param {(device) => {title, body}} textFor  testo nella lingua del dispositivo
 * @returns {Promise<{sent:number, failed:string[], invalid:string[]}>}
 */
async function sendMobile(cfg, devices, ev, textFor) {
  const out = { sent: 0, failed: [], invalid: [] };
  const data = { streamId: String(ev.streamId || 'test'), type: String(ev.type) };
  await Promise.all(devices.map(async d => {
    const msg = { ...textFor(d), data, urgent: ev.type === 'offair' || ev.type === 'silence' };
    try {
      let r;
      if (d.platform === 'android' && cfg.fcm && cfg.fcm.serviceAccount) r = await sendFcm(cfg.fcm, d, msg);
      else if (d.platform === 'ios' && cfg.apns && cfg.apns.privateKey) r = await sendApns(cfg.apns, d, msg);
      else return out.failed.push(`${d.name || d.platform}: ${d.platform === 'ios' ? 'APNs' : 'FCM'} non configurato / not configured`);
      if (r === 'invalid') out.invalid.push(d.token); else out.sent++;
    } catch (e) {
      out.failed.push(`${d.name || d.platform}: ${e.message}`);
    }
  }));
  return out;
}

module.exports = { sendMobile, sendFcm, sendApns, parseServiceAccount };
