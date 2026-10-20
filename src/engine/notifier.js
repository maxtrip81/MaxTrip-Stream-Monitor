'use strict';
// Invio delle notifiche push: ntfy (app iOS/Android/desktop), Telegram, Pushover, webhook.
const { describe } = require('./i18n');

const PRIORITY = { offair: 5, silence: 4, recovered: 3, test: 3 };
const TAGS = { offair: 'red_circle,rotating_light', silence: 'yellow_circle,mute', recovered: 'green_circle', test: 'white_check_mark' };

async function post(url, opts) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return true;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Invia l'evento su tutti i canali abilitati.
 * @returns {Promise<Array<{channel:string, ok:boolean, error?:string}>>}
 */
async function sendAll(ev, settings) {
  const n = settings.notify || {};
  const { title, body } = describe(ev, settings.language);
  const text = ev.url ? `${body}\n${ev.url}` : body;
  const jobs = [];

  if (n.ntfy && n.ntfy.enabled && n.ntfy.topic) {
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

  if (n.telegram && n.telegram.enabled && n.telegram.botToken && n.telegram.chatId) {
    jobs.push(['telegram', post(`https://api.telegram.org/bot${n.telegram.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: n.telegram.chatId, text: `${title}\n${text}`, disable_web_page_preview: true })
    })]);
  }

  if (n.pushover && n.pushover.enabled && n.pushover.userKey && n.pushover.appToken) {
    const prio = ev.type === 'offair' ? 1 : 0;
    jobs.push(['pushover', post('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: n.pushover.appToken, user: n.pushover.userKey, title, message: text, priority: prio })
    })]);
  }

  if (n.webhook && n.webhook.enabled && n.webhook.url) {
    jobs.push(['webhook', post(n.webhook.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...ev, title, message: body })
    })]);
  }

  const results = await Promise.all(jobs.map(([channel, p]) =>
    p.then(() => ({ channel, ok: true }), e => ({ channel, ok: false, error: e.message }))));
  return results;
}

module.exports = { sendAll };
