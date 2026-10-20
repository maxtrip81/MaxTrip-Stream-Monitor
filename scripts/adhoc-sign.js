'use strict';
// Firma "ad-hoc" dell'app macOS prima della creazione del .dmg.
// Senza un certificato Apple Developer ID i Mac Apple Silicon rifiutano le app
// con firma assente o non valida ("app danneggiata"): la firma ad-hoc lo evita.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • firma ad-hoc  ${app}`);
  // FFmpeg si trova fuori dalle cartelle che --deep firma: va firmato a parte
  const ffmpeg = path.join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg');
  if (fs.existsSync(ffmpeg)) execFileSync('codesign', ['--force', '--sign', '-', ffmpeg], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};
