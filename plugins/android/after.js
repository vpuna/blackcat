// The screen after the confirmation button is pressed. The app shows its own screens for a
// while ("finding a driver", a spinner) and then its last one (the driver on the way, the order
// placed): that one is sent to the owner, with what is read on it. A routine that does not yet
// say which screen that is has a model look, the first time, whether the screen is the last
// one; the owner may keep what it found, as the routine's `result`, for next time.
import { readSpec, steady } from './learn.js';
import { listed, targetOf } from './recover.js';

export const RESULT = {
  type: 'object',
  required: ['final', 'summary'],
  additionalProperties: false,
  properties: {
    final: { type: 'boolean' },
    summary: { type: 'string', maxLength: 300 },
    shows: { type: ['integer', 'null'], minimum: 0 },
    read: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        required: ['name', 'anchor', 'how'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', maxLength: 30 },
          anchor: { type: 'integer', minimum: 0 },
          how: { enum: ['after', 'row'] },
          kind: { enum: ['money', 'time', 'any'] },
        },
      },
    },
  },
};

// The main words on a screen, top to bottom, for the owner when nothing says what to read.
export function headline(els, most = 8) {
  const seen = new Set();
  const out = [];
  for (const e of els) {
    const t = (e.text ?? '').replace(/\s+/g, ' ').trim();
    if (!t || e.field || seen.has(t)) continue;
    seen.add(t);
    out.push(t.length > 80 ? `${t.slice(0, 79)}…` : t);
    if (out.length >= most) break;
  }
  return out;
}

// Ask the model whether this is the app's last screen after the press. → its answer (RESULT)
// with `result`, what the routine would keep (or null), or null when no model could be asked.
export async function judgeResult(ctx, { routine, button, els, shot, imageBlock }) {
  const input = [
    ...(shot ? [imageBlock(shot)] : []),
    {
      type: 'text',
      text: [
        `The app: ${routine.app}. The routine's goal: ${routine.goal ?? routine.name}.`,
        `The owner said yes, and ${button} was pressed. This is the screen now.`,
        '',
        'On the screen now:',
        listed(els),
      ].join('\n'),
    },
  ];
  let d;
  try {
    d = await ctx.reader('result', { input, schema: RESULT });
  } catch (e) {
    ctx.log(`the screen after the press was not looked at: ${e.message}`);
    return null;
  }
  const sign = d.final && d.shows != null ? steady(targetOf(els[d.shows] ?? {})) : null;
  const read = readSpec(d.read, els);
  return { ...d, result: sign ? { shows: sign, ...(Object.keys(read).length ? { read } : {}) } : null };
}
