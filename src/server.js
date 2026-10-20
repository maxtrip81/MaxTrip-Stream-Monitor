#!/usr/bin/env node
'use strict';
// Avvio "headless" (server / Raspberry / Docker) per il monitoraggio 24/7.
//   node src/server.js            → dati in ./data, porta 8686
//   DATA_DIR=/var/lib/sm HOST=0.0.0.0 PORT=8686 node src/server.js
const path = require('path');
const { Engine } = require('./engine');

const engine = new Engine({
  dataDir: process.env.DATA_DIR || path.join(process.cwd(), 'data'),
  port: process.env.PORT,
  host: process.env.HOST
});

engine.on('alarm', ev => console.log(`[${new Date().toISOString()}] ${ev.title} — ${ev.message || ''}`));
engine.start().catch(e => { console.error(e); process.exit(1); });

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { engine.stop(); process.exit(0); });
