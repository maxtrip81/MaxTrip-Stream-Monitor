// Copia l'interfaccia condivisa (../ui) nella cartella www usata da Capacitor
// e genera build-config.js con le funzioni disponibili nella build.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = path.join(root, '..', 'ui');
const dst = path.join(root, 'www');
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true });
// Android: le notifiche push richiedono google-services.json (Firebase). Senza il file
// l'app funziona comunque, ma non tenta la registrazione (che la farebbe chiudere).
const build = {
  android: fs.existsSync(path.join(root, 'android', 'app', 'google-services.json')),
  ios: true
};
fs.writeFileSync(path.join(dst, 'build-config.js'), `window.SM_BUILD = ${JSON.stringify(build)};\n`);
console.log('UI copiata in', dst, build);
