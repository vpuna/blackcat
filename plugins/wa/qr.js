import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const QRCode = require('qrcode-terminal/vendor/QRCode/index.js');
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js');

const QUIET = 4; // blank border in modules; phone scanners need about 4

// Two QR rows per text line using half blocks, drawn white-on-black with
// explicit colours so it scans the same on light and dark terminal themes.
// About 57 columns wide for a WhatsApp link, so it fits an 80-column terminal.
export function renderQr(text) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.L);
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const dark = (r, c) => r >= 0 && c >= 0 && r < n && c < n && qr.modules[r][c];

  const lines = [];
  for (let r = -QUIET; r < n + QUIET; r += 2) {
    let line = '';
    for (let c = -QUIET; c < n + QUIET; c++) {
      const top = dark(r, c);
      const bottom = dark(r + 1, c);
      line += top && bottom ? ' ' : top ? '▄' : bottom ? '▀' : '█';
    }
    lines.push(`  \x1b[97;40m${line}\x1b[0m`);
  }
  return lines.join('\n');
}
