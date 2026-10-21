// Pictures of an app the owner sends when a routine is learned or changed: screens taken at
// another time, on any device. A model with no tools looks at them once, before anything is
// done, and says in words what they show for the goal; those words go with every step after.
// The pictures say what to expect, never where to tap: taps are always found on the live screen.
// Some of them may be the app's screen after the confirmation button is pressed, which learning
// never reaches (in one state or another: the driver on the way, the driver there): it then says
// what that screen shows and what to read there.
import fs from 'node:fs';
import path from 'node:path';
import { fit } from './device.js';
import { MODEL_PICTURE } from './recover.js';
import { MAX_NEXT, MAX_SIGNS } from './routines.js';

export const MAX_PICTURES = 4;
const KINDS = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

export const STUDY = {
  type: 'object',
  required: ['notes', 'after_confirm'],
  additionalProperties: false,
  properties: {
    notes: { type: 'string', maxLength: 1200 },
    after_confirm: {
      type: ['object', 'null'],
      required: ['pictures', 'shows', 'waiting', 'read'],
      additionalProperties: false,
      properties: {
        pictures: { type: 'array', minItems: 1, maxItems: MAX_PICTURES, items: { type: 'integer', minimum: 1 } },
        shows: { type: 'array', minItems: 1, maxItems: MAX_SIGNS, items: { type: 'string', maxLength: 60 } },
        waiting: { type: 'array', maxItems: MAX_SIGNS, items: { type: 'string', maxLength: 60 } },
        read: {
          type: 'array',
          maxItems: 6,
          items: {
            type: 'object',
            required: ['name', 'label', 'lines'],
            additionalProperties: false,
            properties: {
              name: { type: 'string', maxLength: 30 },
              label: { type: 'string', maxLength: 40 },
              lines: { type: 'integer', minimum: 1, maximum: MAX_NEXT },
              kind: { enum: ['money', 'time', 'any'] },
            },
          },
        },
      },
    },
  },
};

// The owner's pictures, copied into the plugin's folder at the size a model is shown.
// → the copies' paths. Fails (with why) on one that is not a picture or not there.
export async function takePictures(files, media) {
  const list = [files ?? []].flat().filter(Boolean);
  if (list.length > MAX_PICTURES) throw new Error(`At most ${MAX_PICTURES} pictures at a time.`);
  const out = [];
  for (const [k, f] of list.entries()) {
    const ext = path.extname(f).toLowerCase();
    if (!KINDS[ext]) throw new Error(`${f} is not a picture (JPEG, PNG or WebP).`);
    if (!fs.existsSync(f)) throw new Error(`There is no file ${f}.`);
    const copy = path.join(media, `owner-${Date.now()}-${k + 1}${ext}`);
    fs.copyFileSync(f, copy);
    fs.chmodSync(copy, 0o600);
    await fit(copy, MODEL_PICTURE);
    out.push(copy);
  }
  return out;
}

export const imageBlock = (file) => ({
  type: 'image',
  source: {
    type: 'base64',
    media_type: KINDS[path.extname(file).toLowerCase()] ?? 'image/jpeg',
    data: fs.readFileSync(file).toString('base64'),
  },
});

// What the pictures show, from a model: { notes, after_confirm } (STUDY), or null.
// `routine`: the routine being changed, if one is.
export async function study(ctx, { pictures, goal, app, routine = null }) {
  if (!pictures?.length) return null;
  const input = [
    ...pictures.map(imageBlock),
    {
      type: 'text',
      text: [
        `The app: ${app.label ?? app.package} (${app.package}).${app.commit.length ? ` Its buttons that book, pay or send: ${app.commit.map((c) => `"${c}"`).join(', ')}.` : ''}`,
        `What the owner wants, in their words: ${goal}`,
        ...(routine ? [`The routine as it is now: ${JSON.stringify(routine.steps)}`] : []),
        `The owner sent ${pictures.length === 1 ? 'one picture' : `${pictures.length} pictures, numbered 1 to ${pictures.length} in the order above`}.`,
      ].join('\n'),
    },
  ];
  try {
    return await ctx.reader('pictures', { input, schema: STUDY });
  } catch (e) {
    ctx.log(`the pictures could not be looked at: ${e.message}`);
    return null;
  }
}

// The screen after the press, as the pictures show it, as a confirmation step's `result`: the
// words that show the app is done (any of them, when the pictures show it in more than one
// state), those of a screen it shows while still working (to wait past), and the values beside
// their labels, or a few lines under them. (Words read off a
// picture, not yet seen on the device: when they never show, the screen there is sent anyway.)
const before = (w) => w?.split(/\d/)[0].trim();
export function resultFromPicture(a, patterns) {
  const signs = [...new Set([a?.shows ?? []].flat().map(before))].filter((w) => w && w.length >= 3).slice(0, MAX_SIGNS);
  if (!signs.length) return null;
  const read = {};
  for (const r of a.read ?? []) {
    const label = before(r.label);
    if (!label || label.length < 2 || !/^[A-Za-z][\w ]{0,29}$/.test(r.name ?? '')) continue;
    const next = Number.isInteger(r.lines) && r.lines > 1 && r.lines <= MAX_NEXT ? { next: r.lines } : {};
    read[r.name] = { after: { textContains: label }, ...next, ...(patterns[r.kind] ? { pattern: patterns[r.kind] } : {}) };
  }
  const shows = signs.map((w) => ({ textContains: w }));
  const busy = [...new Set([a.waiting ?? []].flat().map(before))]
    .filter((w) => w && w.length >= 3 && !signs.includes(w))
    .slice(0, MAX_SIGNS)
    .map((w) => ({ textContains: w }));
  return {
    shows: shows.length === 1 ? shows[0] : shows,
    ...(busy.length ? { waiting: busy.length === 1 ? busy[0] : busy } : {}),
    ...(Object.keys(read).length ? { read } : {}),
  };
}
