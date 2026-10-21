# MaxTrip Stream Monitor — App per smartphone (iOS / Android)

**Creato da Massimiliano Mascioli Trippa — [max@maxtrip.it](mailto:max@maxtrip.it)**

🇮🇹 [Italiano](#italiano) · 🇬🇧 [English](#english)

---

## Italiano

L'app per iPhone e Android ha la stessa interfaccia dell'app desktop: elenco dei flussi, VU meter stereo in tempo reale, segnalatori **ON AIR / SILENZIO / OFF AIR**, allarme acustico, ascolto dei flussi, registro eventi, impostazioni, italiano / inglese.

Il telefono si collega al **motore di monitoraggio** (l'app desktop sul computer della regia oppure il server Docker), che analizza i flussi 24 ore su 24 e invia le **notifiche push** al telefono anche quando l'app è chiusa. iOS e Android sospendono le app in background: per questo l'analisi non viene fatta sul telefono, che altrimenti smetterebbe di controllare i flussi dopo pochi minuti.

### 1. Installare l'app

| | Come |
|---|---|
| **Android** | Scarica `MaxTrip-Stream-Monitor-<versione>-android.apk` dalla Release (o dagli *Artifacts* della compilazione su GitHub), aprilo sul telefono e consenti l'installazione da "origini sconosciute". Per pubblicarla su Google Play vedi il punto 4. |
| **iPhone** | Apple non consente di installare app fuori dall'App Store senza firma. Serve un account [Apple Developer](https://developer.apple.com/programs/) (99 $/anno): apri il progetto con `npm run ios` su un Mac, seleziona il tuo Team in *Signing & Capabilities* e installa sull'iPhone collegato, oppure distribuisci con **TestFlight** / App Store (*Product → Archive*). |

### 2. Collegare l'app al motore

1. Sull'app desktop: *Impostazioni → Accesso remoto* → attiva "Consenti connessioni dalla rete" e genera un token.
2. Sul telefono, al primo avvio: inserisci `http://IP-DEL-COMPUTER:8686` e il token.
3. Consenti le notifiche quando richiesto. Il telefono compare in *Impostazioni → Notifiche → App per smartphone* con il suo nome.

Fuori dalla rete locale usa una VPN (Tailscale, WireGuard) o un indirizzo HTTPS pubblico del motore.

### 3. Attivare le notifiche push

Le notifiche push vengono inviate dal motore direttamente ai server di Google e Apple. Configurazione da fare una volta sola:

**Android — Firebase Cloud Messaging (gratuito)**

1. Crea un progetto su [console.firebase.google.com](https://console.firebase.google.com) e aggiungi un'app **Android** con package `it.maxtrip.streammonitor`.
2. Scarica `google-services.json`:
   - compilazione su GitHub: *Settings → Secrets and variables → Actions → New repository secret* con nome `GOOGLE_SERVICES_JSON` e come valore il contenuto del file;
   - compilazione locale: copia il file in `mobile/android/app/google-services.json`.
3. In Firebase: *Impostazioni progetto → Account di servizio → Genera nuova chiave privata*. Incolla il contenuto del file JSON nell'app desktop in *Impostazioni → Notifiche → App per smartphone → Android*.

Senza `google-services.json` l'APK funziona comunque (monitoraggio, allarmi e notifiche ad app aperta), ma non riceve notifiche push ad app chiusa.

**iPhone — Apple Push Notification service**

1. Su [developer.apple.com](https://developer.apple.com/account/resources/authkeys/list) → *Keys* → crea una chiave con **Apple Push Notifications service (APNs)** e scarica il file `.p8`.
2. Nell'app desktop, *Impostazioni → Notifiche → App per smartphone → iPhone*: inserisci **Key ID**, **Team ID**, Bundle ID `it.maxtrip.streammonitor` e il contenuto del file `.p8`.
3. Attiva "Produzione" per le app installate da TestFlight / App Store; disattivala per quelle installate direttamente da Xcode.

Premi **Invia notifica di prova**: per ogni canale vedi l'esito (es. `✅ app: 2/2`).

### 4. Pubblicare sugli store (facoltativo)

- **Google Play**: crea una chiave di firma (`keytool -genkey -v -keystore release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias streammonitor`) e aggiungi su GitHub i segreti `ANDROID_KEYSTORE_BASE64` (il file codificato in base64), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. La compilazione produrrà anche `…-android-play.aab` da caricare su Google Play Console.
- **App Store**: da Xcode, *Product → Archive → Distribute App*.

### Sviluppo

```bash
cd mobile
npm install
npm run android        # copia l'interfaccia (../ui), sincronizza e apre Android Studio
npm run ios            # idem con Xcode (solo macOS)
npm run build:android  # APK di debug da riga di comando (richiede Android SDK e Java 21)
npm run icons          # rigenera icone e schermata di avvio da assets/
node scripts/patch-native.js   # riapplica le personalizzazioni native dopo "npx cap add"
```

Requisiti: Android 7.0 o successivo, iOS 15 o successivo.

---

## English

The iPhone and Android app has the same interface as the desktop app: stream list, real-time stereo VU meters, **ON AIR / SILENCE / OFF AIR** indicators, audible alarm, stream listening, event log, settings, Italian / English.

The phone connects to the **monitoring engine** (the desktop app on the studio computer or the Docker server), which analyses the streams 24/7 and sends **push notifications** to the phone even when the app is closed. iOS and Android suspend background apps, so analysis does not run on the phone.

1. **Install** — Android: download `MaxTrip-Stream-Monitor-<version>-android.apk` from the Release (or the GitHub build *Artifacts*) and allow installation from unknown sources. iPhone: requires an Apple Developer account; open the project with `npm run ios` on a Mac, select your Team under *Signing & Capabilities*, run on your device or distribute via TestFlight / App Store.
2. **Connect** — in the desktop app enable *Settings → Remote access* and generate a token; on the phone enter `http://COMPUTER-IP:8686` and the token, then allow notifications.
3. **Push notifications**
   - Android: create a Firebase project, add an Android app `it.maxtrip.streammonitor`, store `google-services.json` as the GitHub secret `GOOGLE_SERVICES_JSON` (or copy it to `mobile/android/app/`), then paste a Firebase **service account** JSON in *Settings → Notifications → Smartphone app → Android*.
   - iPhone: create an **APNs key** (.p8) on developer.apple.com and enter Key ID, Team ID, Bundle ID and key in *Settings → Notifications → Smartphone app → iPhone*.
   - Press **Send test notification** to check every channel.
4. **Store publishing** — Google Play: add the `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` secrets to get a signed `.aab`. App Store: *Product → Archive* in Xcode.

Requirements: Android 7.0+, iOS 15+.

---

© Massimiliano Mascioli Trippa — max@maxtrip.it
