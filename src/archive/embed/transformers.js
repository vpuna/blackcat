import path from 'node:path';
import { DATA } from '../../config.js';

// Per-model details: vector size, how to pool, and the prefix some models want on queries.
const MODELS = {
  'Xenova/bge-small-en-v1.5': { dims: 384, pooling: 'cls', queryPrefix: 'Represent this sentence for searching relevant passages: ' },
  'Xenova/bge-base-en-v1.5': { dims: 768, pooling: 'cls', queryPrefix: 'Represent this sentence for searching relevant passages: ' },
  'Xenova/all-MiniLM-L6-v2': { dims: 384, pooling: 'mean', queryPrefix: '' },
  'Xenova/multilingual-e5-small': { dims: 384, pooling: 'mean', queryPrefix: 'query: ', docPrefix: 'passage: ' },
};

const BATCH = 8;

export function create(cfg) {
  const spec = MODELS[cfg.model];
  if (!spec) throw new Error(`No settings for model "${cfg.model}". Known: ${Object.keys(MODELS).join(', ')}`);
  let extractor;

  async function ready() {
    if (extractor) return extractor;
    // Loaded lazily: onnxruntime is large, and most commands never need it.
    const { env, pipeline } = await import('@huggingface/transformers');
    env.cacheDir = path.join(DATA, 'models'); // downloaded once, then used offline
    // Two threads by default: leave half this machine's cores for the bot and whatever else it is for.
    extractor = await pipeline('feature-extraction', cfg.model, {
      dtype: 'q8',
      session_options: { intraOpNumThreads: cfg.threads ?? 2, interOpNumThreads: 1 },
    });
    return extractor;
  }

  return {
    id: cfg.model,
    dims: spec.dims,
    async embed(texts, { kind = 'document' } = {}) {
      const fe = await ready();
      const prefix = (kind === 'query' ? spec.queryPrefix : spec.docPrefix) ?? '';
      const out = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        const t = await fe(
          texts.slice(i, i + BATCH).map((x) => prefix + x),
          { pooling: spec.pooling, normalize: true },
        );
        for (const row of t.tolist()) out.push(Float32Array.from(row));
      }
      return out;
    },
  };
}
