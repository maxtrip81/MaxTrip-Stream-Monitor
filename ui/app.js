/* TRIP Streaming Monitor — interfaccia
 * Creato da Massimiliano Mascioli Trippa — max@maxtrip.it
 * La stessa interfaccia gira su desktop (Electron), app mobile (Capacitor) e browser:
 * si collega al motore di monitoraggio tramite API REST + WebSocket. */
(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  const ELECTRON = /Electron/i.test(navigator.userAgent);
  const FLOOR = -60;

  const ls = {
    get: k => { try { return localStorage.getItem('sm.' + k); } catch (_) { return null; } },
    set: (k, v) => { try { localStorage.setItem('sm.' + k, v); } catch (_) {} }
  };

  let lang = ls.get('lang') || 'it';
  let server = ls.get('server') || (NATIVE || location.protocol === 'file:' ? '' : location.origin);
  let token = new URLSearchParams(location.search).get('token') || ls.get('token') || '';
  let settings = null;
  let about = null;
  let ws = null;
  let retryTimer = null;
  const cards = new Map();    // id -> { stream, el, lv, disp }
  let events = [];
  let devices = [];
  let drag = null;          // trascinamento in corso di un riquadro
  let themeReady = false;

  // ---------- i18n ----------
  function t(key, vars) {
    const d = window.I18N[lang] || window.I18N.it;
    let s = d[key] !== undefined ? d[key] : (window.I18N.it[key] || key);
    if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : ''));
    return s;
  }
  function applyI18n(root = document) {
    document.documentElement.lang = lang;
    root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    root.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); el.setAttribute('aria-label', el.title); });
    $('#langSelect').value = lang;
    $('#langSelect2').value = lang;
  }
  function setLang(l, persist) {
    lang = l === 'en' ? 'en' : 'it';
    ls.set('lang', lang);
    applyI18n();
    for (const c of cards.values()) updateCard(c);
    renderEvents(); renderSummary();
    if (persist && settings) api('PUT', '/api/settings', { language: lang }).catch(() => {});
    if (typeof applyTheme === 'function' && themeReady) applyTheme();
    if (NATIVE) mobile.registerDevice();
  }

  // ---------- API ----------
  async function api(method, path, body) {
    const res = await fetch(server + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 401) { const e = new Error(t('unauthorized')); e.code = 401; throw e; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  async function connect() {
    clearTimeout(retryTimer);
    if (!server) return showConnect('');
    try {
      const st = await api('GET', '/api/state');
      onState(st);
    } catch (e) {
      if (e.code === 401 || NATIVE || server !== location.origin) {
        if (!cards.size || e.code === 401) return showConnect(e.message);
      }
      $('#connBanner').classList.remove('hidden');
      retryTimer = setTimeout(connect, 3000);
      return;
    }
    openSocket();
  }

  function openSocket() {
    if (ws) { ws.onclose = null; ws.close(); }
    const url = server.replace(/^http/i, 'ws') + '/ws' + (token ? '?token=' + encodeURIComponent(token) : '');
    ws = new WebSocket(url);
    ws.onopen = () => $('#connBanner').classList.add('hidden');
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'levels') onLevels(msg.levels);
      else if (msg.type === 'state') onState(msg.state);
      else if (msg.type === 'stream') onStream(msg.stream);
      else if (msg.type === 'events') { events = msg.events.slice().reverse(); renderEvents(); }
      else if (msg.type === 'event') onEvent(msg.event);
    };
    ws.onclose = () => {
      $('#connBanner').classList.remove('hidden');
      retryTimer = setTimeout(connect, 3000);
    };
  }

  function showConnect(err) {
    const f = $('#connectForm');
    f.server.value = server || '';
    f.token.value = token || '';
    $('#connectError').textContent = err ? t('connectError', { e: err }) : '';
    if (!$('#connectDialog').open) $('#connectDialog').showModal();
  }

  $('#connectForm').addEventListener('submit', e => {
    const f = e.target;
    server = f.server.value.trim().replace(/\/+$/, '');
    if (server && !/^https?:\/\//i.test(server)) server = 'http://' + server;
    token = f.token.value.trim();
    ls.set('server', server); ls.set('token', token);
    setTimeout(connect, 50);
  });
  $('#connectDialog').addEventListener('cancel', e => e.preventDefault());

  // ---------- stato ----------
  function onState(st) {
    about = st.about;
    settings = st.settings;
    devices = st.devices || [];
    if ($('#settingsDialog').open) renderDevices();
    if (NATIVE) mobile.onConnected();
    if (settings.language && settings.language !== lang) setLang(settings.language, false);
    const ids = new Set(st.streams.map(s => s.id));
    for (const [id, c] of cards) if (!ids.has(id)) { stopListen(c); c.el.remove(); cards.delete(id); }
    st.streams.forEach(onStream);
    // mantiene l'ordine di configurazione
    if (!drag) st.streams.forEach(s => $('#grid').appendChild(cards.get(s.id).el));
    $('#empty').classList.toggle('hidden', st.streams.length > 0);
    renderSummary();
  }

  function onStream(s) {
    let c = cards.get(s.id);
    if (!c) {
      c = createCard(s);
      cards.set(s.id, c);
      $('#grid').appendChild(c.el);
      $('#empty').classList.add('hidden');
    }
    c.stream = s;
    updateCard(c);
    renderSummary();
    updateAlarm();
  }

  function onLevels(levels) {
    for (const [id, v] of Object.entries(levels)) {
      const c = cards.get(id);
      if (c) c.lv = v;
    }
  }

  function onEvent(ev) {
    events.unshift(ev);
    if (events.length > 300) events.length = 300;
    renderEvents();
    if (NATIVE ? mobile.pushState !== 'on' : !ELECTRON && settings && settings.notify.desktop) localNotify(ev);
  }

  // ---------- card ----------
  function createCard(s) {
    const el = $('#cardTpl').content.firstElementChild.cloneNode(true);
    applyI18n(el);
    el.dataset.id = s.id;
    const c = { stream: s, el, lv: [-90, -90, -90, -90], disp: { pL: FLOOR, pR: FLOOR, rL: FLOOR, rR: FLOOR, hL: FLOOR, hR: FLOOR, hLt: 0, hRt: 0 }, audio: null };
    initDrag(c);
    $('.toggle', el).addEventListener('change', e => api('PUT', '/api/streams/' + c.stream.id, { enabled: e.target.checked }).catch(alertErr));
    $('.edit', el).addEventListener('click', () => openStreamDialog(c.stream));
    $('.del', el).addEventListener('click', () => {
      if (confirm(t('confirmDelete', { name: c.stream.name }))) api('DELETE', '/api/streams/' + c.stream.id).catch(alertErr);
    });
    $('.restart', el).addEventListener('click', () => api('POST', `/api/streams/${c.stream.id}/restart`).catch(alertErr));
    $('.ack', el).addEventListener('click', () => api('POST', `/api/streams/${c.stream.id}/ack`).catch(alertErr));
    $('.listen', el).addEventListener('click', () => (c.audio ? stopListen(c) : startListen(c)));
    return c;
  }

  function updateCard(c) {
    const s = c.stream, el = c.el;
    $('.name', el).textContent = s.name;
    $('.url', el).textContent = s.url;
    $('.toggle', el).checked = !!s.enabled;
    el.className = 'card st-' + s.state + (drag && drag.el === el ? ' dragging' : '');
    const alarming = s.alarm && !s.alarm.acknowledged;
    el.classList.toggle('alarming', !!alarming);
    const on = { onair: s.state === 'onair' || s.state === 'silence', silence: s.state === 'silence', offair: s.state === 'offair' };
    for (const k of Object.keys(on)) {
      const led = $('.led.' + k, el);
      led.classList.toggle('on', on[k]);
      led.classList.toggle('blink', on[k] && k !== 'onair' && !!alarming);
    }
    $('.ack', el).classList.toggle('hidden', !alarming);
    $('.err', el).textContent = s.state === 'offair' && s.lastError ? `${t('reason')}: ${s.lastError}` : '';
    $('.listen-msg', el).textContent = c.listenMsg || '';
    $('.info', el).textContent = s.state === 'stopped' ? '' : streamInfo(s.info);
    const img = $('.thumb', el);
    const showThumb = s.thumbAt && s.state !== 'stopped' && s.state !== 'offair';
    img.classList.toggle('hidden', !showThumb);
    if (showThumb && img.dataset.at !== String(s.thumbAt)) {
      img.dataset.at = String(s.thumbAt);
      img.src = `${server}/api/streams/${s.id}/thumb?t=${s.thumbAt}${token ? '&token=' + encodeURIComponent(token) : ''}`;
    }
    $('.url', el).title = s.resolvedUrl ? `${s.url}\n→ ${s.resolvedUrl}` : s.url;
    $('.listen', el).textContent = c.audio ? t('stopListen') : t('listen');
    $('.listen', el).classList.toggle('playing', !!c.audio);
    updateStatusText(c);
  }

  /** Riga informativa: tipo di sorgente, codec, bitrate, video, nome stazione, brano. */
  function streamInfo(info) {
    if (!info) return '';
    const a = info.audio, v = info.video;
    const parts = [t('kind_' + String(info.kind || 'direct').replace(/^page→.*/, 'page').replace(/-/g, '_'))];
    if (a) parts.push([a.codec && a.codec.toUpperCase(), a.bitrate && `${a.bitrate} kbps`, a.rate && `${(a.rate / 1000).toFixed(a.rate % 1000 ? 1 : 0)} kHz`, a.channels].filter(Boolean).join(' '));
    if (v) parts.push(`${t('video')} ${v.width}×${v.height}${v.fps ? ` ${Math.round(v.fps)}fps` : ''}`);
    if (info.alternates > 1) parts.push(t('alternates', { n: info.alternates }));
    let line = parts.filter(Boolean).join(' · ');
    if (info.name) line = `📻 ${info.name}\n${line}`;
    if (info.nowPlaying) line += `\n♪ ${info.nowPlaying}`;
    return line;
  }

  function updateStatusText(c) {
    const s = c.stream;
    const label = t(s.state === 'stopped' ? 'stopped' : s.state);
    const dur = s.state !== 'stopped' && s.since ? ` · ${t('since')} ${fmtDur(Date.now() - s.since)}` : '';
    $('.status', c.el).textContent = label + dur;
  }

  function fmtDur(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    if (d) return `${d}g ${h}h`.replace('g', lang === 'en' ? 'd' : 'g');
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${r}s`;
    return `${r}s`;
  }

  function renderSummary() {
    const counts = { onair: 0, silence: 0, offair: 0 };
    for (const c of cards.values()) if (counts[c.stream.state] !== undefined) counts[c.stream.state]++;
    $('#summary').innerHTML = Object.entries(counts)
      .map(([k, n]) => `<span class="pill ${k}">${t(k)}: ${n}</span>`).join('');
  }

  // ---------- VU meter ----------
  function dbColor(db) { return db >= -6 ? '#ff3b30' : db >= -18 ? '#f5b301' : '#2ecc71'; }

  function drawMeter(c, dt) {
    const cv = $('.vu', c.el);
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
    if (!w) return;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const g = cv.getContext('2d');
    const d = c.disp, now = performance.now();
    const [pL, pR, rL, rR] = c.stream.state === 'stopped' ? [-90, -90, -90, -90] : c.lv;
    const fall = 26 * dt; // dB/s di rilascio
    const ball = (cur, target) => (target > cur ? target : Math.max(target, cur - fall));
    d.pL = ball(d.pL, pL); d.pR = ball(d.pR, pR);
    d.rL += (Math.max(rL, -90) - d.rL) * Math.min(1, dt * 8);
    d.rR += (Math.max(rR, -90) - d.rR) * Math.min(1, dt * 8);
    if (d.pL >= d.hL || now - d.hLt > 1500) { d.hL = d.pL; d.hLt = now; }
    if (d.pR >= d.hR || now - d.hRt > 1500) { d.hR = d.pR; d.hRt = now; }

    g.clearRect(0, 0, w, h);
    const pad = 22 * dpr, scaleH = 14 * dpr, gap = 4 * dpr;
    const barH = (h - scaleH - gap * 3) / 2;
    const x0 = pad, x1 = w - 6 * dpr, bw = x1 - x0;
    const X = db => x0 + (Math.min(0, Math.max(FLOOR, db)) - FLOOR) / -FLOOR * bw;
    const seg = 3 * dpr, sgap = 1 * dpr;

    g.font = `${10 * dpr}px system-ui, sans-serif`;
    g.textBaseline = 'middle';
    [['L', d.pL, d.rL, d.hL], ['R', d.pR, d.rR, d.hR]].forEach(([lab, pk, rms, hold], i) => {
      const y = gap + i * (barH + gap);
      g.fillStyle = '#8b949e';
      g.fillText(lab, 6 * dpr, y + barH / 2);
      const xp = X(pk), xr = X(rms);
      for (let x = x0; x < x1; x += seg + sgap) {
        const db = FLOOR + (x - x0) / bw * -FLOOR;
        g.globalAlpha = x < xr ? 1 : x < xp ? 0.55 : 0.12;
        g.fillStyle = dbColor(db);
        g.fillRect(x, y, seg, barH);
      }
      g.globalAlpha = 1;
      if (hold > FLOOR) {
        g.fillStyle = dbColor(hold);
        g.fillRect(X(hold) - dpr, y, 2 * dpr, barH);
      }
    });
    // scala
    const ys = h - scaleH / 2;
    g.fillStyle = '#8b949e';
    g.textAlign = 'center';
    for (const db of [-60, -48, -36, -24, -18, -12, -6, 0]) {
      g.fillText(String(db), Math.min(X(db), x1 - 6 * dpr), ys);
    }
    g.textAlign = 'start';
    const dbEl = $('.db', c.el);
    const txt = c.stream.state === 'stopped' || pL <= -89 ? '' : `L ${pL.toFixed(1)}  R ${pR.toFixed(1)} dBFS`;
    if (dbEl.textContent !== txt) dbEl.textContent = txt;
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    for (const c of cards.values()) drawMeter(c, dt);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  setInterval(() => { for (const c of cards.values()) updateStatusText(c); }, 1000);

  // ---------- allarmi ----------
  let actx = null, beepTimer = null;
  function ensureAudioCtx() {
    if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {} }
    if (actx && actx.state === 'suspended') actx.resume();
  }
  document.addEventListener('pointerdown', ensureAudioCtx, { once: false });

  function beep() {
    if (!actx) return;
    const t0 = actx.currentTime;
    [0, 0.25].forEach(off => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'square'; o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, t0 + off);
      g.gain.exponentialRampToValueAtTime(0.15, t0 + off + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + off + 0.18);
      o.connect(g).connect(actx.destination);
      o.start(t0 + off); o.stop(t0 + off + 0.2);
    });
  }

  function updateAlarm() {
    const active = [...cards.values()].filter(c => c.stream.alarm && !c.stream.alarm.acknowledged);
    $('#alarmBanner').classList.toggle('hidden', !active.length);
    $('#alarmText').textContent = active.length === 1
      ? `${t('activeAlarm')}: ${active[0].stream.name} — ${t(active[0].stream.alarm.type)}`
      : t('activeAlarms', { n: active.length });
    const sound = active.length && settings && settings.alarmSound;
    if (sound && !beepTimer) { beep(); beepTimer = setInterval(beep, 2000); }
    if (!sound && beepTimer) { clearInterval(beepTimer); beepTimer = null; }
  }
  $('#btnAckAll').addEventListener('click', () => api('POST', '/api/ack').catch(alertErr));

  async function localNotify(ev) {
    const title = ev.title || ev.name, body = ev.message || '';
    try {
      const LN = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications;
      if (LN) {
        await LN.schedule({ notifications: [{ id: Math.floor(Math.random() * 2e9), title, body, extra: { streamId: ev.streamId } }] });
      } else if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, { body, icon: 'icon.png', tag: ev.streamId + ev.type });
      }
    } catch (_) {}
  }
  function requestNotifyPermission() {
    try {
      const LN = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications;
      if (LN) LN.requestPermissions();
      else if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    } catch (_) {}
  }
  if (!ELECTRON) document.addEventListener('click', requestNotifyPermission, { once: true });

  // ---------- registro eventi ----------
  function renderEvents() {
    const ul = $('#eventsList');
    if (!events.length) { ul.innerHTML = `<li>${t('noEvents')}</li>`; return; }
    const locale = lang === 'en' ? 'en-GB' : 'it-IT';
    ul.innerHTML = '';
    for (const ev of events.slice(0, 300)) {
      const li = document.createElement('li');
      li.className = ev.type;
      const tm = document.createElement('time');
      tm.textContent = new Date(ev.time).toLocaleString(locale);
      const b = document.createElement('b');
      b.textContent = `${ev.name} — ${t('evt_' + ev.type)}${ev.type === 'recovered' ? ` (${fmtDur(ev.duration || 0)})` : ''}`;
      const sp = document.createElement('span');
      sp.textContent = ev.type === 'offair' && ev.reason ? `${t('reason')}: ${ev.reason}`
        : ev.type === 'silence' ? `${t('level')}: ${Math.round(ev.level)} dBFS` : '';
      li.append(tm, b, sp);
      ul.appendChild(li);
    }
  }
  $('#btnEvents').addEventListener('click', () => $('#eventsDrawer').classList.toggle('hidden'));
  $('#btnCloseEvents').addEventListener('click', () => $('#eventsDrawer').classList.add('hidden'));
  $('#btnClearEvents').addEventListener('click', () => api('DELETE', '/api/events').catch(alertErr));

  // ---------- ascolto ----------
  // L'audio passa dal motore: FFmpeg legge qualsiasi formato (playlist .pls/.m3u, HLS,
  // RTMP, RTSP, SRT, web TV...) e lo converte in MP3, riproducibile ovunque.
  function listenUrl(c) {
    const q = new URLSearchParams({ t: Date.now() });
    if (token) q.set('token', token);
    return `${server}/api/streams/${c.stream.id}/listen?${q}`;
  }
  function startListen(c) {
    for (const o of cards.values()) if (o !== c && o.audio) stopListen(o);
    const a = new Audio();
    c.audio = a;
    c.listenMsg = t('listenLoading');
    a.addEventListener('playing', () => { c.listenMsg = ''; updateCard(c); });
    a.addEventListener('waiting', () => { c.listenMsg = t('listenLoading'); updateCard(c); });
    a.addEventListener('error', async () => {
      if (c.audio !== a) return;
      let reason = '';
      try { reason = (await api('GET', `/api/streams/${c.stream.id}/listen-error`)).error; } catch (_) {}
      stopListen(c);
      c.listenMsg = t('listenError') + (reason ? ` — ${reason}` : '');
      updateCard(c);
    });
    a.src = listenUrl(c);
    a.play().catch(e => {
      if (c.audio !== a || e.name === 'AbortError') return;
      stopListen(c);
      c.listenMsg = `${t('listenError')} — ${e.message}`;
      updateCard(c);
    });
    updateCard(c);
  }
  function stopListen(c) {
    if (c.audio) {
      const a = c.audio;
      c.audio = null;
      a.pause(); a.removeAttribute('src'); a.load();
    }
    c.listenMsg = '';
    updateCard(c);
  }

  // ---------- modale flusso ----------
  let editingId = null;
  function openStreamDialog(s) {
    editingId = s ? s.id : null;
    const f = $('#streamForm');
    f.reset();
    $('#streamDialogTitle').textContent = t(s ? 'editStream' : 'newStream');
    f.name.value = s ? s.name : '';
    f.url.value = s ? s.url : '';
    f.enabled.checked = s ? s.enabled : true;
    for (const k of ['silenceThresholdDb', 'silenceSeconds', 'offAirSeconds', 'userAgent', 'headers']) f[k].value = s && s[k] != null ? s[k] : '';
    f.querySelector('.advanced').open = !!(s && (s.userAgent || s.headers));
    f.querySelector('.ytdlp-hint').classList.toggle('hidden', !!(about && about.ytdlp));
    $('#streamDialog').showModal();
  }
  $('#btnAdd').addEventListener('click', () => openStreamDialog(null));
  $('#streamForm').addEventListener('submit', e => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    const f = e.target;
    const body = {
      name: f.name.value.trim(), url: f.url.value.trim(), enabled: f.enabled.checked,
      silenceThresholdDb: f.silenceThresholdDb.value, silenceSeconds: f.silenceSeconds.value, offAirSeconds: f.offAirSeconds.value,
      userAgent: f.userAgent.value.trim(), headers: f.headers.value.trim()
    };
    (editingId ? api('PUT', '/api/streams/' + editingId, body) : api('POST', '/api/streams', body)).catch(alertErr);
  });

  // ---------- impostazioni ----------
  const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  function setPath(o, p, v) {
    const ks = p.split('.'); let cur = o;
    ks.slice(0, -1).forEach(k => { cur = cur[k] = cur[k] || {}; });
    cur[ks[ks.length - 1]] = v;
  }
  function openSettings() {
    if (!settings) return;
    const f = $('#settingsForm');
    for (const el of f.elements) {
      if (!el.name) continue;
      const v = getPath(settings, el.name);
      if (el.type === 'checkbox') el.checked = !!v; else el.value = v == null ? '' : v;
    }
    const isRemoteClient = NATIVE || server !== location.origin || !isLocalHost();
    $('#clientFieldset').classList.toggle('hidden', !isRemoteClient);
    $('#clientServer').value = server; $('#clientToken').value = token;
    const port = (() => { try { return new URL(server).port || '8686'; } catch (_) { return '8686'; } })();
    $('#remoteHint').textContent = t('remoteHint', { port });
    $('#testResult').textContent = '';
    renderDevices();
    $('#settingsDialog').showModal();
  }
  function renderDevices() {
    const ul = $('#devicesList');
    ul.innerHTML = '';
    if (!devices.length) { ul.innerHTML = `<li><span>${t('noDevices')}</span></li>`; }
    const locale = lang === 'en' ? 'en-GB' : 'it-IT';
    for (const d of devices) {
      const li = document.createElement('li');
      li.classList.toggle('me', !!(mobile.token && mobile.token.endsWith(d.tokenTail)));
      const sp = document.createElement('span');
      sp.textContent = `${d.platform === 'ios' ? '🍏' : '🤖'} ${d.name || d.platform} · ${d.lang.toUpperCase()} · ${new Date(d.lastSeen).toLocaleDateString(locale)}`;
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn small danger'; b.textContent = t('removeDevice');
      b.addEventListener('click', () => api('DELETE', '/api/devices/' + d.id).catch(alertErr));
      li.append(sp, b);
      ul.appendChild(li);
    }
    const me = $('#thisDevice');
    me.textContent = !NATIVE ? '' : mobile.pushState === 'on' ? t('thisDeviceOn')
      : mobile.pushState === 'denied' ? t('thisDeviceOff') : mobile.pushState === 'nopush' ? t('thisDeviceNoPush') : '';
  }
  function isLocalHost() { return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname); }
  function collectSettings() {
    const f = $('#settingsForm'), out = {};
    for (const el of f.elements) {
      if (!el.name) continue;
      let v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value.trim();
      if (el.type === 'number' && !Number.isFinite(v)) continue;
      setPath(out, el.name, v);
    }
    return out;
  }
  $('#btnSettings').addEventListener('click', openSettings);
  $('#btnGenToken').addEventListener('click', () => {
    const a = new Uint8Array(18); crypto.getRandomValues(a);
    $('#settingsForm').accessToken.value = btoa(String.fromCharCode(...a)).replace(/[+/=]/g, '').slice(0, 24);
  });
  $('#btnTestNotify').addEventListener('click', async () => {
    const out = $('#testResult');
    out.textContent = '…';
    try {
      await api('PUT', '/api/settings', collectSettings());
      const { results } = await api('POST', '/api/test-notify');
      out.textContent = !results.length ? t('testNone') : results.map(r => r.ok
        ? `✅ ${r.channel}: ${t('testSent')}${r.info ? ` (${r.info})` : ''}`
        : `❌ ${r.channel}: ${r.error}`).join('\n');
      if (!ELECTRON && !(NATIVE && mobile.pushState === 'on')) localNotify({ title: '✅ TRIP Streaming Monitor', message: t('testSent'), streamId: 'test', type: 'test' });
    } catch (e) { out.textContent = t('testFailed', { e: e.message }); }
  });
  $('#settingsForm').addEventListener('submit', async e => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    const s = collectSettings();
    if (s.remoteAccess && !s.accessToken) { $('#btnGenToken').click(); s.accessToken = $('#settingsForm').accessToken.value; }
    const newServer = $('#clientServer').value.trim().replace(/\/+$/, '');
    const newToken = $('#clientToken').value.trim();
    const clientChanged = !$('#clientFieldset').classList.contains('hidden') && (newServer !== server || newToken !== token);
    try {
      if (!clientChanged) await api('PUT', '/api/settings', s);
      if (s.language) setLang(s.language, false);
    } catch (err) { alertErr(err); }
    if (clientChanged) {
      server = newServer; token = newToken;
      ls.set('server', server); ls.set('token', token);
      connect();
    }
  });

  // ---------- varie ----------
  $('#btnAbout').addEventListener('click', () => {
    $('#aboutVersion').textContent = about ? 'v' + about.version : '';
    $('#aboutDialog').showModal();
  });
  $('#langSelect').addEventListener('change', e => setLang(e.target.value, true));
  $('#langSelect2').addEventListener('change', e => setLang(e.target.value, false));
  function alertErr(e) { alert(e.message || e); }

  if (location.search.includes('token=') && !NATIVE) ls.set('token', token);
  // ---------- esporta / importa flussi ----------
  const FIELD_LABEL = {
    name: 'streamName', url: 'streamUrl', enabled: 'enable', silenceThresholdDb: 'silenceThreshold',
    silenceSeconds: 'silenceSeconds', offAirSeconds: 'offAirSeconds', userAgent: 'User-Agent', headers: 'httpHeaders'
  };
  const esc = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fieldVal = (f, v) => v == null || v === '' ? '—' : f === 'enabled' ? t(v ? 'yes' : 'no') : String(v);

  function openTransfer() {
    const ul = $('#exportList');
    ul.innerHTML = '';
    for (const c of cards.values()) {
      const li = document.createElement('li');
      li.innerHTML = `<label><input type="checkbox" checked value="${esc(c.stream.id)}"><span>${esc(c.stream.name)}<small>${esc(c.stream.url)}</small></span></label>`;
      ul.appendChild(li);
    }
    $('#importError').textContent = '';
    updateExportBtn();
    $('#transferDialog').showModal();
  }
  function selectedIds() { return [...$('#exportList').querySelectorAll('input:checked')].map(i => i.value); }
  function updateExportBtn() {
    const n = selectedIds().length;
    const b = $('#btnDoExport');
    b.textContent = n === 1 ? t('exportBtn1') : t('exportBtn', { n });
    b.disabled = !n;
  }
  $('#btnTransfer').addEventListener('click', openTransfer);
  $('#exportList').addEventListener('change', updateExportBtn);
  $('#btnSelAll').addEventListener('click', () => { $('#exportList').querySelectorAll('input').forEach(i => { i.checked = true; }); updateExportBtn(); });
  $('#btnSelNone').addEventListener('click', () => { $('#exportList').querySelectorAll('input').forEach(i => { i.checked = false; }); updateExportBtn(); });

  $('#btnDoExport').addEventListener('click', async () => {
    const ids = selectedIds();
    const all = ids.length === cards.size;
    try {
      const res = await fetch(`${server}/api/export${all ? '' : '?ids=' + ids.join(',')}`, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      const name = ((res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/) || [])[1] || 'TRIP-Streaming-Monitor.json';
      await saveFile(name, text);
    } catch (e) { alertErr(e); }
  });

  /** Salva il file: sul telefono apre la condivisione (File, Drive, email…), altrove lo scarica. */
  async function saveFile(name, text) {
    const { Filesystem, Share } = (window.Capacitor && window.Capacitor.Plugins) || {};
    if (NATIVE && Filesystem && Share) {
      await Filesystem.writeFile({ path: name, data: text, directory: 'CACHE', encoding: 'utf8' });
      const { uri } = await Filesystem.getUri({ path: name, directory: 'CACHE' });
      await Share.share({ title: name, files: [uri] });
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  let importItems = [];
  $('#btnChooseImport').addEventListener('click', () => { $('#importFile').value = ''; $('#importFile').click(); });
  $('#importFile').addEventListener('change', async e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    $('#importError').textContent = '';
    try {
      const { items, errors } = await api('POST', '/api/import/preview', { text: await file.text() });
      if (!items.length) { $('#importError').textContent = t('impErr') + (errors.length ? ` (${errors.join(', ')})` : ''); return; }
      importItems = items;
      $('#transferDialog').close();
      renderImport();
      $('#importDialog').showModal();
    } catch (err) { $('#importError').textContent = err.message; }
  });

  function renderImport() {
    const by = st => importItems.filter(i => i.status === st);
    const news = by('new'), same = by('identical'), conf = by('conflict');
    $('#importSummary').textContent = t('impSummary', { new: news.length, same: same.length, conf: conf.length });
    $('#impNewSec').classList.toggle('hidden', !news.length);
    $('#impConflictSec').classList.toggle('hidden', !conf.length);
    $('#impSameSec').classList.toggle('hidden', !same.length);
    $('#impNewList').innerHTML = news.map(i => `<li><label><input type="checkbox" checked data-index="${i.index}"><span>${esc(i.incoming.name)}<small>${esc(i.incoming.url)}</small></span></label></li>`).join('');
    $('#impSameSec summary').textContent = same.length === 1 ? t('impIdentical1') : t('impIdentical', { n: same.length });
    $('#impSameList').innerHTML = same.map(i => `<li>${esc(i.incoming.name)}<small>${esc(i.incoming.url)}</small></li>`).join('');
    $('#impApplyAll').value = '';
    $('#impConflictList').innerHTML = conf.map(i => {
      const rows = i.diffs.map(f => `<tr><th>${esc(f in FIELD_LABEL && FIELD_LABEL[f] !== 'User-Agent' ? t(FIELD_LABEL[f]) : 'User-Agent')}</th>` +
        `<td>${esc(fieldVal(f, i.existing[f]))}</td><td class="new">${esc(fieldVal(f, i.incoming[f]))}</td></tr>`).join('');
      const acts = ['keep', 'replace', 'duplicate', 'delete'].map(a =>
        `<label><input type="radio" name="act-${i.index}" value="${a}"${a === 'keep' ? ' checked' : ''}> ${t('act' + a[0].toUpperCase() + a.slice(1))}</label>`).join('');
      return `<div class="conflict" data-index="${i.index}">
        <div class="head">${esc(i.existing.name)} <small>· ${t('match' + i.match[0].toUpperCase() + i.match.slice(1))}</small></div>
        <table class="diff"><tr><th></th><th>${t('current')}</th><th>${t('inFile')}</th></tr>${rows}</table>
        <div class="actions-row">${acts}</div></div>`;
    }).join('');
  }
  $('#impApplyAll').addEventListener('change', e => {
    if (!e.target.value) return;
    $('#impConflictList').querySelectorAll(`input[value="${e.target.value}"]`).forEach(r => { r.checked = true; });
  });

  $('#importForm').addEventListener('submit', async e => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    const decisions = [];
    for (const i of importItems) {
      if (i.status === 'new') {
        if ($(`#impNewList input[data-index="${i.index}"]`).checked) decisions.push({ incoming: i.incoming, action: 'add' });
      } else if (i.status === 'conflict') {
        const r = $(`#impConflictList input[name="act-${i.index}"]:checked`);
        decisions.push({ incoming: i.incoming, action: r ? r.value : 'keep', existingId: i.existing.id });
      }
    }
    if (!decisions.some(d => d.action !== 'keep')) { alert(t('importNothing')); return; }
    try {
      const { summary } = await api('POST', '/api/import/apply', { decisions });
      alert(t('importDone', summary));
    } catch (err) { alertErr(err); }
  });

  // ---------- app per smartphone (Capacitor: iOS / Android) ----------
  const mobile = {
    token: ls.get('pushToken'),
    pushState: 'unknown',   // on | denied | nopush | error | unknown
    started: false,
    plugins: (window.Capacitor && window.Capacitor.Plugins) || {},
    platform: NATIVE ? window.Capacitor.getPlatform() : 'web',
    deviceName: '',

    async onConnected() {
      this.registerDevice();
      if (this.started) return;
      this.started = true;
      const { Device } = this.plugins;
      try { const i = await Device.getInfo(); this.deviceName = [i.manufacturer, i.name || i.model].filter(Boolean).join(' '); } catch (_) {}
      this.setupPush();
    },

    async setupPush() {
      const PN = this.plugins.PushNotifications;
      const build = window.SM_BUILD || {};
      if (!PN || build[this.platform] === false) { this.pushState = 'nopush'; return; }
      try {
        if (this.platform === 'android') {
          await PN.createChannel({ id: 'alarms', name: lang === 'en' ? 'Alarms (OFF AIR, silence)' : 'Allarmi (OFF AIR, silenzio)', importance: 5, visibility: 1, vibration: true, lights: true, lightColor: '#FF3B30' });
          await PN.createChannel({ id: 'events', name: lang === 'en' ? 'Recovery and tests' : 'Ripresa e test', importance: 3, visibility: 1 });
        }
        let perm = await PN.checkPermissions();
        if (perm.receive !== 'granted') perm = await PN.requestPermissions();
        if (perm.receive !== 'granted') { this.pushState = 'denied'; return; }
        await PN.addListener('registration', ({ value }) => {
          this.token = value; ls.set('pushToken', value);
          this.pushState = 'on';
          this.registerDevice();
        });
        await PN.addListener('registrationError', e => { this.pushState = 'error'; console.warn('push', e); });
        await PN.addListener('pushNotificationActionPerformed', a => focusStream(a.notification && a.notification.data && a.notification.data.streamId));
        await PN.register();
      } catch (e) {
        this.pushState = 'error';
        console.warn('push', e);
      }
    },

    registerDevice() {
      if (!this.token || !settings) return;
      api('POST', '/api/devices', { token: this.token, platform: this.platform, name: this.deviceName, lang })
        .then(() => { this.pushState = 'on'; }).catch(() => {});
    }
  };

  function focusStream(id) {
    const c = id && cards.get(id);
    if (!c) return;
    c.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    c.el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.03)' }, { transform: 'scale(1)' }], { duration: 600, iterations: 2 });
  }

  if (NATIVE) {
    const { App, LocalNotifications } = mobile.plugins;
    if (App) {
      // al ritorno in primo piano la connessione (sospesa dal sistema) viene ripristinata subito
      App.addListener('appStateChange', ({ isActive }) => {
        if (isActive && (!ws || ws.readyState > 1)) connect();
      });
      App.addListener('backButton', () => {
        const open = document.querySelector('dialog[open]');
        if (open && open.id !== 'connectDialog') open.close();
        else if (!$('#eventsDrawer').classList.contains('hidden')) $('#eventsDrawer').classList.add('hidden');
        else App.minimizeApp();
      });
    }
    if (LocalNotifications) {
      LocalNotifications.addListener('localNotificationActionPerformed', a => focusStream(a.notification.extra && a.notification.extra.streamId));
    }
    document.documentElement.classList.add('native', 'platform-' + mobile.platform);
  }

  // ---------- tema chiaro / scuro (preferenza di questo dispositivo) ----------
  const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
  let theme = ['dark', 'light'].includes(ls.get('theme')) ? ls.get('theme') : 'system';

  function applyTheme() {
    const root = document.documentElement;
    if (theme === 'system') delete root.dataset.theme; else root.dataset.theme = theme;
    const dark = theme === 'dark' || (theme === 'system' && darkMq.matches);
    document.querySelector('meta[name="theme-color"]').content = dark ? '#0d1117' : '#f3f5f8';
    const btn = $('#btnTheme');
    btn.textContent = theme === 'system' ? '◐' : theme === 'dark' ? '☾' : '☀';
    btn.title = t('themeNow', { t: t(theme === 'system' ? 'themeSystem' : theme === 'dark' ? 'themeDark' : 'themeLight') });
    btn.setAttribute('aria-label', btn.title);
    $('#themeSelect').value = theme;
    // app desktop: anche la cornice della finestra segue il tema
    if (window.tripDesktop) window.tripDesktop.setTheme(theme);
    // app mobile: colore e icone della barra di stato
    const SB = NATIVE && mobile.plugins.StatusBar;
    if (SB) {
      SB.setStyle({ style: dark ? 'DARK' : 'LIGHT' }).catch(() => {});
      if (mobile.platform === 'android') SB.setBackgroundColor({ color: dark ? '#161b22' : '#ffffff' }).catch(() => {});
    }
  }
  function setTheme(v) {
    theme = ['dark', 'light'].includes(v) ? v : 'system';
    ls.set('theme', theme);
    applyTheme();
  }
  darkMq.addEventListener('change', () => { if (theme === 'system') applyTheme(); });
  $('#btnTheme').addEventListener('click', () => setTheme({ system: 'dark', dark: 'light', light: 'system' }[theme]));
  $('#themeSelect').addEventListener('change', e => setTheme(e.target.value));

  // ---------- ordinamento dei riquadri: trascinamento (mouse e touch) e tastiera ----------
  function currentOrder() { return [...$('#grid').querySelectorAll('.card')].map(el => el.dataset.id); }
  function saveOrder(order) { api('PUT', '/api/streams/order', { ids: order }).catch(alertErr); }

  function initDrag(c) {
    const handle = $('.drag-handle', c.el);
    handle.addEventListener('pointerdown', e => startDrag(e, c, handle));
    handle.addEventListener('keydown', e => {
      const el = c.el, grid = $('#grid');
      const back = e.key === 'ArrowUp' || e.key === 'ArrowLeft', fwd = e.key === 'ArrowDown' || e.key === 'ArrowRight';
      if (!back && !fwd) return;
      e.preventDefault();
      if (back && el.previousElementSibling) grid.insertBefore(el, el.previousElementSibling);
      else if (fwd && el.nextElementSibling) grid.insertBefore(el.nextElementSibling, el);
      else return;
      handle.focus();
      el.scrollIntoView({ block: 'nearest' });
      flashMoved(el);
      saveOrder(currentOrder());
    });
  }

  function flashMoved(el) {
    el.classList.remove('moved'); void el.offsetWidth; el.classList.add('moved');
    setTimeout(() => el.classList.remove('moved'), 600);
  }

  function startDrag(e, c, handle) {
    if (drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    const el = c.el, r = el.getBoundingClientRect();
    const ph = document.createElement('div');
    ph.className = 'card-placeholder';
    ph.style.height = r.height + 'px';
    el.parentNode.insertBefore(ph, el);
    drag = { el, ph, handle, dx: e.clientX - r.left, dy: e.clientY - r.top, x: e.clientX, y: e.clientY, start: currentOrder().join() };
    Object.assign(el.style, { width: r.width + 'px', height: r.height + 'px' });
    el.classList.add('dragging');
    document.body.classList.add('is-dragging');
    try { handle.setPointerCapture(e.pointerId); } catch (_) {}
    handle.addEventListener('pointermove', onDragMove);
    handle.addEventListener('pointerup', onDragEnd);
    handle.addEventListener('pointercancel', onDragEnd);
    moveDrag();
    requestAnimationFrame(autoScroll);
  }

  function onDragMove(e) { if (drag) { drag.x = e.clientX; drag.y = e.clientY; moveDrag(); } }

  function moveDrag() {
    const { el, ph, x, y } = drag;
    el.style.left = (x - drag.dx) + 'px';
    el.style.top = (y - drag.dy) + 'px';
    const grid = $('#grid');
    const hit = document.elementFromPoint(x, y);
    const target = hit && hit.closest('.card, .card-placeholder');
    if (!target || target === ph || target === el || target.parentNode !== grid) return;
    const tr = target.getBoundingClientRect();
    // griglia a una colonna (telefono): decide la metà verticale; a più colonne: quella orizzontale
    const singleColumn = tr.width > grid.clientWidth * 0.6;
    const after = singleColumn ? y > tr.top + tr.height / 2 : x > tr.left + tr.width / 2;
    grid.insertBefore(ph, after ? target.nextSibling : target);
  }

  function autoScroll() {
    if (!drag) return;
    const edge = 70, speed = 14;
    if (drag.y < edge) window.scrollBy(0, -speed);
    else if (drag.y > window.innerHeight - edge) window.scrollBy(0, speed);
    if (drag.y < edge || drag.y > window.innerHeight - edge) moveDrag();
    requestAnimationFrame(autoScroll);
  }

  function onDragEnd() {
    if (!drag) return;
    const { el, ph, handle, start } = drag;
    handle.removeEventListener('pointermove', onDragMove);
    handle.removeEventListener('pointerup', onDragEnd);
    handle.removeEventListener('pointercancel', onDragEnd);
    ph.parentNode.insertBefore(el, ph);
    ph.remove();
    el.classList.remove('dragging');
    for (const k of ['width', 'height', 'left', 'top']) el.style[k] = '';
    document.body.classList.remove('is-dragging');
    drag = null;
    const order = currentOrder();
    if (order.join() !== start) { flashMoved(el); saveOrder(order); }
  }

  applyI18n();
  renderEvents();
  connect();
  themeReady = true;
  applyTheme();
})();
