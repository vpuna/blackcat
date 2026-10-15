import { execFile } from 'node:child_process';
import { dataPath, settingsFor } from '../../src/api.js';

// Speech to text, on this machine: Whisper, run through the same library as the search
// index. The audio never leaves this machine. A model can't listen, so a voice note becomes
// text here before anything is passed on.

export const MODELS = {
  tiny: { id: 'Xenova/whisper-tiny', hint: 'fastest, weakest on names and accents' },
  base: { id: 'Xenova/whisper-base', hint: 'a good balance on a Pi' },
  small: { id: 'Xenova/whisper-small', hint: 'more accurate, several times slower' },
};
export const MAX_SECONDS = 10 * 60;
// Four threads: a voice note is a few seconds of work, and the services already run at a
// lower priority than Allsky.
export const voiceSettings = () => ({ model: 'base', language: 'english', threads: 4, ...settingsFor(import.meta.url).get() });

// Decode anything ffmpeg understands (Telegram's OGG/Opus, WhatsApp voice notes, mp3,
// m4a) into what Whisper wants: 16 kHz mono samples.
const decode = (file) =>
  new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      ['-v', 'error', '-i', file, '-t', String(MAX_SECONDS), '-f', 'f32le', '-ac', '1', '-ar', '16000', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: MAX_SECONDS * 16000 * 4 + 1024, timeout: 120_000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`could not read the audio: ${String(stderr).trim().split('\n').pop() || err.message}`));
        resolve(new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 4)));
      },
    );
  });

let loaded = null; // { key, pipe }

// → { text, seconds (of audio), took (seconds to transcribe), model, language }
export async function transcribe(file, opts = {}) {
  const s = { ...voiceSettings(), ...opts };
  // Only the models offered: a model name is a download from the internet and code to run.
  const spec = MODELS[s.model];
  if (!spec) throw new Error(`"${s.model}" is not one of the speech models: ${Object.keys(MODELS).join(', ')}`);
  const t0 = Date.now();
  const audio = await decode(file);
  if (audio.length < 1600) return { text: '', seconds: 0, took: 0, model: s.model, language: s.language };

  if (loaded?.key !== spec.id) {
    const { env, pipeline } = await import('@huggingface/transformers');
    env.cacheDir = dataPath('models'); // downloaded once, then used offline
    loaded = {
      key: spec.id,
      pipe: await pipeline('automatic-speech-recognition', spec.id, {
        dtype: 'q8',
        session_options: { intraOpNumThreads: s.threads, interOpNumThreads: 1 },
      }),
    };
  }
  // `language: null` lets Whisper work it out, which the small models do poorly.
  const out = await loaded.pipe(audio, {
    chunk_length_s: 30,
    stride_length_s: 5,
    task: 'transcribe',
    ...(s.language && s.language !== 'auto' ? { language: s.language } : {}),
  });
  return {
    text: String(out.text ?? '')
      .replace(/\s+/g, ' ')
      .trim(),
    seconds: +(audio.length / 16000).toFixed(1),
    took: +((Date.now() - t0) / 1000).toFixed(1),
    model: s.model,
    language: s.language,
  };
}
