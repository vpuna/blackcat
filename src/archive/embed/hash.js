import { sleep } from '../../util/wait.js';
// A stand-in for a real embedding model: each text becomes a vector worked out from its
// words alone, at once and with nothing to download. Texts that share words come out near
// each other; it knows nothing about meaning. It is here so the index can be tested (and
// tried out) without the model:  "archive": { "embedder": { "provider": "hash" } }
const DIMS = 64;

export function create(cfg) {
  return {
    id: 'hash-64',
    dims: DIMS,
    async embed(texts) {
      globalThis.__blackcatEmbedded = (globalThis.__blackcatEmbedded ?? 0) + texts.length; // counted, for the tests
      if (cfg.delayMs) await sleep(cfg.delayMs * texts.length);
      return texts.map((t) => {
        const v = new Float32Array(DIMS);
        for (const w of String(t)
          .toLowerCase()
          .split(/[^\p{L}\p{N}]+/u)
          .filter(Boolean)) {
          let h = 2166136261;
          for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619);
          v[(h >>> 0) % DIMS] += 1;
        }
        const n = Math.hypot(...v) || 1;
        return v.map((x) => x / n);
      });
    },
  };
}
