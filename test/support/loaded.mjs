// Which packages does a bc command load? Run as: node --import ./loaded.mjs bin/bc.js …
import { registerHooks } from 'node:module';
const seen = new Map();
registerHooks({
  load(url, context, next) {
    const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(url);
    if (m) seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
    return next(url, context);
  },
});
process.on('exit', () =>
  process.stderr.write(
    `PACKAGES ${[...seen.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}:${n}`)
      .join(' ')}\n`,
  ),
);
