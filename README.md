# MaxTrip Stream Monitor

**Creato da Massimiliano Mascioli Trippa — [max@maxtrip.it](mailto:max@maxtrip.it)**

🇮🇹 [Italiano](#italiano) · 🇬🇧 [English](#english)

---

## Italiano

Monitoraggio professionale di **web radio, web TV e qualsiasi segnale live**.

- Aggiungi un numero illimitato di flussi, ciascuno con **nome** e **indirizzo (URL)**.
- Tutti i flussi vengono monitorati **contemporaneamente**.
- Ogni flusso ha un **VU meter stereo** (picco + RMS, con tenuta del picco) e tre segnalatori:
  **ON AIR**, **SILENZIO** e **OFF AIR**.
- Ogni segnalatore funziona da **allarme**: il riquadro lampeggia, compare un banner e suona un allarme acustico fino a quando non premi "Tacita".
- **Notifiche push** per ogni flusso con l'errore specifico: silenzio, interruzione del segnale (con la causa) e **ripresa** (con la durata dell'anomalia).
- **Bilingue**: italiano (predefinito) e inglese, anche nei testi delle notifiche.
- Registro eventi con data e ora.

### Formati e link supportati

Puoi inserire **qualsiasi tipo di link**: l'app riconosce da sola il tipo di sorgente e trova il flusso audio/video.

| Tipo di link | Esempi | Cosa fa l'app |
|---|---|---|
| **Icecast 2.x** (2.4 compreso) | `http://server:8000/live.mp3` · `http://server:8000` | mountpoint diretto; con il solo indirizzo del server legge `status-json.xsl` e usa il mountpoint principale |
| **Shoutcast v1** | `http://server:8000` · `http://server:8000/;` | gestisce la risposta non standard `ICY 200 OK`; dalla pagina di stato passa a `/;` |
| **Shoutcast v2** | `http://server:8000` · `/stream` · `/listen.pls?sid=1` | con il solo indirizzo legge `statistics?json=1` |
| **Playlist** | `.pls` `.m3u` `.asx` `.wax` `.wvx` `.xspf` `.strm` | apre la playlist; se contiene più server e il primo non risponde passa al successivo |
| **HLS** (web TV, radio) | `.m3u8` | nelle playlist "master" sceglie la traccia solo audio o la qualità più leggera |
| **Pagina web** della radio/TV | `https://www.radio.it/ascolta` | cerca il player nel codice della pagina (`<audio>`, `<video>`, link `.m3u8`, `.pls`, mountpoint…) |
| **YouTube, Twitch, Facebook, TuneIn, RaiPlay…** | link alla diretta | tramite [yt-dlp](https://github.com/yt-dlp/yt-dlp), se installato sul computer del motore |
| **Altri protocolli** | `rtmp://` `rtmps://` `rtsp://` `srt://` `udp://` `rtp://` `rist://` `mms://` `icy://` · DASH `.mpd` | passati direttamente a FFmpeg |

Inoltre:
- Funzionano HTTPS con certificati scaduti o autofirmati, i redirect, i link senza `http://` e le credenziali nel link (`http://utente:password@server/…`).
- Per le web TV protette, nelle *Opzioni avanzate* del flusso puoi impostare User-Agent e intestazioni HTTP (es. `Referer`).
- Per ogni flusso vengono mostrati tipo di sorgente, codec, bitrate, frequenza, canali, nome della stazione, brano in onda e, per le web TV, risoluzione e anteprima dell'immagine (aggiornata ogni minuto).
- Un mountpoint Icecast spento (404) resta **OFF AIR**: l'app non lo sostituisce mai con un altro mountpoint, così l'allarme non viene nascosto.

### Come funziona

```
 ┌───────────────────────── Motore di monitoraggio ─────────────────────────┐
 │  FFmpeg (un processo per flusso) → PCM → livelli, ON AIR/OFF AIR/SILENZIO │
 │  allarmi · registro eventi · notifiche push · API REST + WebSocket        │
 └───────────────▲──────────────────────────────▲───────────────────────────┘
                 │                              │ rete locale / Internet (token)
   App desktop Windows / macOS          App iOS / Android, browser
   (motore integrato)                   (collegate al motore)
```

- **Windows e macOS (e Linux)**: l'app desktop contiene il motore. Chiudendo la finestra il monitoraggio continua nell'area di notifica / barra dei menu.
- **iOS e Android**: l'app mobile si collega al motore (sul PC della regia o su un server) e mostra VU meter, segnalatori e allarmi in tempo reale.
  iOS e Android sospendono le app in background, quindi un telefono non può garantire un monitoraggio 24/7: per questo l'analisi viene sempre eseguita dal motore, che invia le notifiche push anche ad app chiusa.
- **Server 24/7** (opzionale): lo stesso motore gira senza interfaccia su un server, NAS o Raspberry Pi (Docker).

### Notifiche (push, email, SMS e altri sistemi)

Imposta i canali in **Impostazioni → Notifiche**. Ogni anomalia (OFF AIR, silenzio) e ogni ripresa viene inviata su tutti i canali attivi, con il nome del flusso e il dettaglio dell'errore.

| Canale | Configurazione |
|---|---|
| **App per smartphone** (iPhone / Android) | Notifiche push native, anche ad app chiusa, nella lingua scelta su ogni telefono. Vedi la [guida dell'app mobile](mobile/README.md). |
| **Email** | Server SMTP (Gmail, Outlook/Microsoft 365, Aruba, qualsiasi provider), più destinatari separati da virgola. |
| **SMS / WhatsApp** | Tramite un account Twilio (a pagamento per messaggio). Per WhatsApp usa un mittente `whatsapp:+…`. |
| **ntfy** (gratuito) | Installa l'app *ntfy* su iPhone/Android/desktop, iscriviti a un topic (nome univoco), inserisci lo stesso topic nelle impostazioni. |
| **Telegram** | Crea un bot con @BotFather, inserisci il bot token e il tuo chat ID. |
| **Discord / Slack** | URL del webhook del canale. |
| **Notifiche di sistema** | Notifiche native di Windows/macOS e notifiche locali dell'app mobile. |

Usa **"Invia notifica di prova"** per verificare la configurazione.

Esempio di notifica:

> 🔴 OFF AIR — Radio Rock
> Interruzione del segnale streaming. Causa: Connection refused

> 🟢 RIPRESA — Radio Rock
> Segnale ripristinato dopo un'interruzione di 2m 14s.

### Soglie (modificabili, anche per singolo flusso)

| Parametro | Predefinito | Significato |
|---|---|---|
| Soglia silenzio | −50 dBFS | Sotto questo livello RMS l'audio è considerato silenzio |
| Durata silenzio | 10 s | Tempo di silenzio continuo prima dell'allarme |
| Timeout interruzione | 8 s | Tempo senza dati audio prima di dichiarare OFF AIR |
| Conferma ripresa | 3 s | Audio continuo necessario per chiudere un allarme di silenzio |

### Installazione e compilazione

Requisiti: [Node.js](https://nodejs.org) 20 o superiore.

**Desktop (Windows / macOS / Linux)**

```bash
npm install          # scarica anche FFmpeg per la piattaforma corrente
npm start            # avvia l'app
npm run dist:win     # installer Windows (.exe)  — da eseguire su Windows
npm run dist:mac     # immagine macOS (.dmg)     — da eseguire su macOS
```

Ogni installer va creato sulla propria piattaforma (FFmpeg viene incluso per il sistema su cui si compila).
In alternativa, il workflow GitHub Actions `.github/workflows/build.yml` crea automaticamente gli installer per Windows, macOS e Linux a ogni tag `v*`.

**Quale file scaricare**

| Sistema | File |
|---|---|
| Windows 10/11 | `MaxTrip-Stream-Monitor-Setup-<versione>-win-x64.exe` |
| Mac con Apple Silicon (M1, M2, M3, M4…) | `MaxTrip-Stream-Monitor-<versione>-mac-arm64.dmg` |
| Mac con processore Intel | `MaxTrip-Stream-Monitor-<versione>-mac-x64.dmg` |
| Linux | `MaxTrip-Stream-Monitor-<versione>-linux-x86_64.AppImage` |

Per sapere che Mac hai: menu  → *Informazioni su questo Mac* → "Chip Apple M…" = Apple Silicon, "Processore Intel" = Intel.

**Primo avvio su macOS** — l'app ha una firma "ad-hoc" ma non è firmata con un Apple Developer ID, quindi macOS la blocca la prima volta:
1. trascina l'app in *Applicazioni* e aprila: comparirà un avviso;
2. apri *Impostazioni di Sistema → Privacy e sicurezza*, scorri in basso e premi **Apri comunque**.

Se macOS dice che l'app "è danneggiata", apri il Terminale ed esegui:
`xattr -cr "/Applications/MaxTrip Stream Monitor.app"`

Per distribuire su macOS senza avvisi serve la firma con un Apple Developer ID (99 $/anno) e la notarizzazione.

**App per smartphone (iOS / Android)** — cartella `mobile/`, basata su Capacitor.
Installazione, notifiche push (Firebase / Apple) e pubblicazione sugli store sono spiegate nella **[guida dell'app mobile](mobile/README.md)**.
A ogni compilazione GitHub crea l'APK Android installabile e verifica che l'app iOS compili.

**Collegare l'app mobile**

1. Sull'app desktop: *Impostazioni → Accesso remoto* → attiva "Consenti connessioni dalla rete" e genera un token.
2. Sul telefono: inserisci `http://IP-DEL-COMPUTER:8686` e il token.

Per l'accesso da fuori rete usa una VPN (es. Tailscale/WireGuard) o un reverse proxy HTTPS verso il motore.
L'interfaccia funziona anche da qualsiasi browser all'indirizzo `http://IP:8686/?token=IL-TUO-TOKEN` (installabile come app web).

**Server 24/7 (Docker)**

```bash
docker build -t maxtrip-stream-monitor .
docker run -d --restart unless-stopped -p 8686:8686 -v sm-data:/data --name stream-monitor maxtrip-stream-monitor
```

Oppure senza Docker: `npm install --omit=dev && HOST=0.0.0.0 npm run server` (richiede `ffmpeg` installato o il pacchetto `ffmpeg-static`).
Al primo avvio da remoto imposta un token: le connessioni non locali senza token vengono rifiutate. Da `localhost` l'accesso è sempre consentito, quindi con Docker puoi impostare il token aprendo l'interfaccia dalla macchina stessa, oppure modificando `accessToken` in `/data/config.json`.

### Test

```bash
npm test   # stati ON AIR → SILENZIO → OFF AIR → RIPRESA; server simulati Icecast 2.4, Shoutcast v1/v2,
           # pagine web, playlist con server di riserva, HLS (anche protetto), HTTPS, RTMP, SRT, UDP; ascolto;
           # e tutti i canali di notifica (push Android/iPhone, email, SMS, Discord, Slack…) su server simulati
```

---

## English

Professional monitoring of **web radio, web TV and any live signal**.

- Add as many streams as you need, each with a **name** and a **stream address (URL)**.
- All streams are monitored **at the same time**.
- Each stream has a **stereo VU meter** (peak + RMS with peak hold) and three indicators:
  **ON AIR**, **SILENCE** and **OFF AIR**.
- Each indicator works as an **alarm**: the card flashes, a banner appears and an audible alarm sounds until you press "Acknowledge".
- **Push notifications** for each stream with the specific error: silence, signal interruption (with the cause) and **recovery** (with the outage duration).
- **Bilingual**: Italian (default) and English, notification texts included.
- Timestamped event log.

### Supported sources

Any link works: **Icecast 2.x** (mountpoint or just `server:port`, via `status-json.xsl`), **Shoutcast v1** (`ICY 200 OK`, `/;`), **Shoutcast v2** (`statistics?json=1`, `listen.pls`), playlists (`.pls .m3u .asx .wax .wvx .xspf .strm`, with fallback servers), **HLS** (lightest rendition or audio-only track), **radio/TV web pages** (the stream is found in the page code), YouTube/Twitch/Facebook/TuneIn/RaiPlay via optional [yt-dlp](https://github.com/yt-dlp/yt-dlp), and `rtmp(s)`, `rtsp`, `srt`, `udp`, `rtp`, `rist`, `mms`, `icy`, DASH. Self-signed HTTPS, redirects and custom HTTP headers (Referer, User-Agent) are supported. Each card shows codec, bitrate, station name, now playing and, for web TV, resolution and a video preview.

### Architecture

- **Windows and macOS (and Linux)**: the desktop app embeds the monitoring engine. Closing the window keeps monitoring running from the tray / menu bar.
- **iOS and Android**: the mobile app connects to the engine (on the studio PC or a server) and shows live VU meters, indicators and alarms.
  iOS and Android suspend background apps, so a phone cannot guarantee 24/7 monitoring: analysis always runs in the engine, which sends push notifications even when the mobile app is closed.
- **24/7 server** (optional): the same engine runs headless on a server, NAS or Raspberry Pi (Docker).

### Push notifications

Configure them in **Settings → Notifications**: native push to the **smartphone app** (iPhone / Android, see the [mobile app guide](mobile/README.md)), **email** (any SMTP server), **SMS / WhatsApp** (Twilio), ntfy, Telegram, Pushover, Discord, Slack, generic JSON webhook, plus desktop notifications. Use **"Send test notification"** to check every channel.

### Build

```bash
npm install && npm start          # desktop app
npm run dist:win / dist:mac       # installers (build each on its own OS, or use the GitHub Actions workflow)
cd mobile && npm install && npm run android   # Android (Android Studio)
cd mobile && npm install && npm run ios       # iOS (macOS + Xcode)
docker build -t maxtrip-stream-monitor . && docker run -d -p 8686:8686 -v sm-data:/data maxtrip-stream-monitor
```

Downloads: `…-win-x64.exe` (Windows), `…-mac-arm64.dmg` (Apple Silicon Macs: M1/M2/M3/M4), `…-mac-x64.dmg` (Intel Macs), `…-linux-x86_64.AppImage` (Linux).
On first launch on macOS, open *System Settings → Privacy & Security* and click **Open Anyway** (the app is ad-hoc signed, not signed with an Apple Developer ID). If macOS reports the app as "damaged", run `xattr -cr "/Applications/MaxTrip Stream Monitor.app"`.

To connect the mobile app: in the desktop app enable *Settings → Remote access*, generate a token, then enter `http://COMPUTER-IP:8686` and the token on the phone.
See the [mobile app guide](mobile/README.md) for installation, push notifications and store publishing.

---

© Massimiliano Mascioli Trippa — max@maxtrip.it
