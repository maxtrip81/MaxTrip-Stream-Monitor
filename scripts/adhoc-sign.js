'use strict';
// Firma "ad-hoc" dell'app macOS prima della creazione del .dmg.
// Senza un certificato Apple Developer ID i Mac Apple Silicon rifiutano le app
// con firma assente o non valida ("app danneggiata"): la firma ad-hoc lo evita.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • firma ad-hoc  ${app}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};
