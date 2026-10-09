import { load } from '../../config.js';

// Embedding providers are plug-ins. Each exports create(config) returning:
//   { id, dims, embed(texts, { kind: 'document' | 'query' }) → Promise<Float32Array[]> }
// `id` names the model; every model gets its own vector table, so switching models
// (bc msg index --rebuild after changing archive.embedder in the config) never mixes vectors.
const PROVIDERS = {
  transformers: () => import('./transformers.js'), // local ONNX model on this machine (default)
  hash: () => import('./hash.js'), // no model at all: words only, for tests
  // ollama: () => import('./ollama.js'),          // e.g. a multilingual model served from another box
};

export const DEFAULT_EMBEDDER = { provider: 'transformers', model: 'Xenova/bge-small-en-v1.5' };

export async function getEmbedder() {
  const cfg = { ...DEFAULT_EMBEDDER, ...load().archive?.embedder };
  const loadProvider = PROVIDERS[cfg.provider];
  if (!loadProvider) throw new Error(`Unknown embedder provider "${cfg.provider}". Available: ${Object.keys(PROVIDERS).join(', ')}`);
  return (await loadProvider()).create(cfg);
}
