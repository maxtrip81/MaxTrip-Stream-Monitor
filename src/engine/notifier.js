'use strict';
// Invio delle notifiche: push sull'app per smartphone (Android/iOS), email, SMS/WhatsApp,
// ntfy, Telegram, Pushover, Discord, Slack e webhook generico.
const { describe } = require('./i18n');
const { sendMobile } = require('./mobilepush');

const PRIORITY = { offair: 5, silence: 4, recovered: 3, test: 3 };
const TAGS = { offair: 'red_circle,rotating_light', silence: 'yellow_circle,mute', recovered: 'green_circle', test: 'white_check_mark' };
const COLOR = { offair: '#ff3b30', silence: '#f5b301', recovered: '#2ecc71', test: '#2f81f7' };
const TWILIO_API = () => process.env.SM_TWILIO_API || 'https://api.twilio.com';
const FOOTER = 'MaxTrip Stream Monitor — Massimiliano Mascioli Trippa — max@maxtrip.it';

async function post(url, opts) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return true;
}

const list = s => String(s || '').split(/[,;\s]+/).map(x => x.trim()).filter(Boolean);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function sendEmail(cfg, ev, title, body) {
  const nodemailer = require('nodemailer');
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: Number(cfg.port) || 587,
    secure: Number(cfg.port) === 465 || cfg.secure === true,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000
  });
  const when = new Date(ev.time || Date.now()).toLocaleString();
  await transport.sendMail({
    from: cfg.from || cfg.user,
    to: list(cfg.to).join(', '),
    subject: title,
    text: `${title}\n\n${body}\n${ev.url ? ev.url + '\n' : ''}${when}\n\n— ${FOOTER}`,
    html: `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif">
      <h2 style="margin:0 0 8px;color:${COLOR[ev.type] || '#333'}">${esc(title)}</h2>
      <p style="font-size:15px">${esc(body)}</p>
      ${ev.url ? `<p style="color:#666;font-size:13px">${esc(ev.url)}</p>` : ''}
      <p style="color:#666;font-size:13px">${esc(when)}</p>
      <hr style="border:0;border-top:1px solid #ddd"><p style="color:#999;font-size:12px">${esc(FOOTER)}</p></div>`
  });
  transport.close();
}

async function sendTwilio(cfg, title, body) {
  const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64');
  const wa = /^whatsapp:/i.test(cfg.from);
  await Promise.all(list(cfg.to).map(to => post(`${TWILIO_API()}/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ From: cfg.from, To: wa && !/^whatsapp:/i.test(to) ? `whatsapp:${to}` : to, Body: `${title}\n${body}` })
  })));
}

/**
 * Invia l'evento su tutti i canali abilitati.
 * @param {object} ctx { devices: [], onInvalidDevices: (tokens) => void }
 * @returns {Promise<Array<{channel:string, ok:boolean, error?:string, info?:string}>>}
 */
async function sendAll(ev, settings, ctx = {}) {
  const n = settings.notify || {};
  const { title, body } = describe(ev, settings.language);
  const text = ev.url ? `${body}\n${ev.url}` : body;
  const jobs = [];
  const on = c => c && c.enabled;

  const mobile = n.mobile || {};
  const devices = ctx.devices || [];
  if (on(mobile) && devices.length) {
    jobs.push(['app', sendMobile(mobile, devices, ev, d => describe(ev, d.lang || settings.language)).then(r => {
      if (r.invalid.length && ctx.onInvalidDevices) ctx.onInvalidDevices(r.invalid);
      if (!r.sent && r.failed.length) throw new Error(r.failed.join('; '));
      return `${r.sent}/${devices.length}` + (r.failed.length ? ` — ${r.failed.join('; ')}` : '');
    })]);
  }

  if (on(n.email) && n.email.host && n.email.to) jobs.push(['email', sendEmail(n.email, ev, title, body)]);

  if (on(n.twilio) && n.twilio.accountSid && n.twilio.authToken && n.twilio.from && n.twilio.to) {
    jobs.push([/^whatsapp:/i.test(n.twilio.from) ? 'whatsapp' : 'sms', sendTwilio(n.twilio, title, text)]);
  }

  if (on(n.ntfy) && n.ntfy.topic) {
    const server = (n.ntfy.server || 'https://ntfy.sh').replace(/\/+$/, '');
    const headers = { 'Content-Type': 'application/json' };
    if (n.ntfy.token) headers.Authorization = `Bearer ${n.ntfy.token}`;
    jobs.push(['ntfy', post(server, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        topic: n.ntfy.topic, title, message: text,
        priority: PRIORITY[ev.type] || 3, tags: (TAGS[ev.type] || '').split(',').filter(Boolean)
      })
    })]);
  }

  if (on(n.telegram) && n.telegram.botToken && n.telegram.chatId) {
    jobs.push(['telegram', post(`https://api.telegram.org/bot${n.telegram.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: n.telegram.chatId, text: `${title}\n${text}`, disable_web_page_preview: true })
    })]);
  }

  if (on(n.pushover) && n.pushover.userKey && n.pushover.appToken) {
    const prio = ev.type === 'offair' ? 1 : 0;
    jobs.push(['pushover', post('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: n.pushover.appToken, user: n.pushover.userKey, title, message: text, priority: prio })
    })]);
  }

  if (on(n.discord) && n.discord.url) {
    jobs.push(['discord', post(n.discord.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'MaxTrip Stream Monitor', content: `**${title}**\n${text}` })
    })]);
  }

  if (on(n.slack) && n.slack.url) {
    jobs.push(['slack', post(n.slack.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `*${title}*\n${text}` })
    })]);
  }

  if (on(n.webhook) && n.webhook.url) {
    jobs.push(['webhook', post(n.webhook.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...ev, title, message: body })
    })]);
  }

  return Promise.all(jobs.map(([channel, p]) =>
    p.then(info => ({ channel, ok: true, ...(typeof info === 'string' ? { info } : {}) }),
      e => ({ channel, ok: false, error: e.message }))));
}

module.exports = { sendAll };
