// Changing a routine from the owner's words (and pictures). A model with no tools reads the
// routine and the change, and says how it is made:
//   steps          in the steps alone: a step left out, a value made optional, a longer wait, other
//                  words for a button. The steps as they will be are checked like any routine.
//   live           new steps, in the app: the routine is gone through on the device up to where
//                  they go, and they are learned from there, one action at a time (learn.js).
//   after_confirm  the screen after the press, from a picture of it (pictures.js).
//   unclear        a question for the owner.
// Whatever it is, the routine is then tried again (--dry) before the owner approves it.
import { spoken } from './screen.js';

export const EDIT = {
  type: 'object',
  required: ['summary', 'how'],
  additionalProperties: false,
  properties: {
    summary: { type: 'string', maxLength: 300 },
    how: { enum: ['steps', 'live', 'after_confirm', 'unclear'] },
    steps: { type: 'string', maxLength: 20000 },
    params: { type: 'string', maxLength: 4000 },
    at: { type: 'integer', minimum: 0 },
    replace: { type: 'integer', minimum: 0 },
    goal: { type: 'string', maxLength: 400 },
    question: { type: 'string', maxLength: 300 },
  },
};

// A step in a few plain words: its own `why`, else what it does.
export const said = (s) =>
  s.why ??
  `${s.do.replace('_', ' ')}${s.target ? ` ${spoken(s.target)}` : s.button ? ` ${spoken(s.button)}` : s.text ? ` "${s.text}"` : s.key ? ` ${s.key}` : ''}`;

// The routine's steps, numbered, as the model is shown them.
export const numbered = (steps) => steps.map((s, k) => `${k + 1}. ${said(s)}: ${JSON.stringify(s)}`).join('\n');

// How the model says to make the change. → its answer (EDIT), or null when none could be asked.
export async function planEdit(ctx, { routine, app, change, told, picture }) {
  const input = [
    {
      type: 'text',
      text: [
        `The app: ${app.label ?? app.package} (${app.package}).${app.commit.length ? ` Its buttons that book, pay or send: ${app.commit.map((c) => `"${c}"`).join(', ')}.` : ''}`,
        `The routine "${routine.name}": ${routine.goal ?? '(no goal written)'}`,
        `Its values: ${JSON.stringify(routine.params ?? {})}`,
        'Its steps:',
        numbered(routine.steps),
        '',
        `The change, in the owner's words: ${change}`,
        ...(told ? [`What the owner's pictures of the app show: ${told}`] : []),
        picture
          ? 'One of the pictures is the screen after the confirmation button is pressed.'
          : 'No picture of the screen after the press was sent.',
      ].join('\n'),
    },
  ];
  try {
    return await ctx.reader('edit', { input, schema: EDIT });
  } catch (e) {
    ctx.log(`no plan for the change: ${e.message}`);
    return null;
  }
}

// The steps as they will be: `learned` in place of `replace` steps after the first `at`.
export const spliced = (steps, at, replace, learned) => [...steps.slice(0, at), ...learned, ...steps.slice(at + replace)];

// What changed between two lists of steps, in plain words, one line each: "+ 4. …" for a step
// that is new, "− 5. …" for one taken out (numbered as in the list it is in).
export function changes(before, after) {
  const key = (s) => JSON.stringify(s);
  const left = new Set(after.map(key));
  const right = new Set(before.map(key));
  return [
    ...before.flatMap((s, k) => (left.has(key(s)) ? [] : [`− ${k + 1}. ${said(s)}`])),
    ...after.flatMap((s, k) => (right.has(key(s)) ? [] : [`+ ${k + 1}. ${said(s)}`])),
  ];
}
