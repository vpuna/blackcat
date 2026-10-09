import { record } from '../activity/log.js';
import { NoModel, engineFor, noModelText, whyNoModel } from '../engines/registry.js';
import { loadPlugins } from '../plugins/registry.js';

// Ask the model one question with NO tools, and get its text answer. Used for the readers
// that go through content written by other people (messages, mail, files): with no tools,
// the worst a hostile message can do is skew the answer, which the caller validates.
// That there are no tools is not left to the caller, or to the model that is asked: the
// engine's `ask` has no way to be given any.
//
// `content` is the question as text, or a list of content blocks (an image or document
// followed by the question). `model`: leave it out for the one chosen for the readers
// (`bc engine`). `meta` says what this is for, for the activity record:
// { category: 'watch: School notices', reader: 'watch/list' }. With `meta.schema` the engine is
// asked for an answer of that shape (see src/readers.js). Nothing of what is sent or
// answered is recorded, only how large it was and what it used.
async function ask(system, content, model, meta = {}) {
  const started = Date.now();
  const sent = typeof content === 'string' ? content.length : content.reduce((n, b) => n + (b.type === 'text' ? b.text.length : 0), 0);
  let e = null;
  const note = (usage, error) =>
    record({
      kind: 'model',
      category: meta.category ?? 'reader',
      surface: meta.surface ?? 'job',
      ms: Date.now() - started,
      ...(usage ?? { ok: false, model: model ?? e?.model ?? null }),
      summary: error ? `failed: ${error}` : null,
      data: {
        ...usage?.data,
        ...(meta.reader ? { reader: meta.reader } : {}),
        ...(e ? { engine: e.name } : {}),
        sentChars: sent + system.length,
        ...(typeof content === 'string' ? {} : { file: content[0]?.type }),
      },
    });
  let res;
  try {
    await loadPlugins();
    e = await engineFor('readers');
    // (An engine that cannot enforce a shape is told what it is, and its answer is checked by the caller.)
    const shaped = meta.schema && !e.def.shapes;
    res = await e.def.ask(e.ctx, {
      system: shaped
        ? `${system}\n\nAnswer with ONLY a JSON object, and no other text, that fits this schema:\n${JSON.stringify(meta.schema)}`
        : system,
      content,
      model: model ?? e.model ?? undefined,
      options: e.options,
      ...(meta.schema && e.def.shapes ? { schema: meta.schema } : {}),
    });
  } catch (err) {
    // With no model at all there is nothing to note, call after call: whoever asked is told so.
    const st = await whyNoModel('readers');
    if (st) throw new NoModel(noModelText(st));
    note(null, err.reason ?? String(err.message).slice(0, 80));
    throw err;
  }
  // (An engine that is not signed in may start, and answer that it is not: that is "no model" too.)
  if (res.isError) {
    const st = await whyNoModel('readers');
    if (st) throw new NoModel(noModelText(st));
  }
  note(res.usage, res.isError ? 'the model returned an error' : null);
  if (res.isError) throw new Error(res.text || 'the model returned an error');
  return { text: res.text ?? '', data: res.data };
}

// (The whole of what came back, for src/readers.js: { text, data }.)
export const askFor = ask;

export const askModel = async (system, input, model, meta) => (await ask(system, input, model, meta)).text;

// The same, for a file: the model is given the image or PDF itself, still with no tools.
// `block` is an Anthropic content block ({ type: 'image' | 'document', source: … }).
export const askModelAbout = async (system, block, question, model, meta) =>
  (await ask(system, [block, { type: 'text', text: question }], model, meta)).text;

// Pull the JSON list out of an answer, tolerating code fences or a stray sentence around it.
export function parseJsonList(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end < start) throw new Error('the model did not return a JSON list');
  const items = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(items)) throw new Error('the model did not return a JSON list');
  return items;
}
