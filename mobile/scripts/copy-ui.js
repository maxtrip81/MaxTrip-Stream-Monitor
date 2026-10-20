// Copia l'interfaccia condivisa (../ui) nella cartella www usata da Capacitor.
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, '..', '..', 'ui');
const dst = path.join(__dirname, '..', 'www');
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true });
console.log('UI copiata in', dst);
