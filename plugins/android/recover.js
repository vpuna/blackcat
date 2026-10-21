// When a step fails: a model with no tools looks at the screen (a picture and the list of
// elements) and says what is in the way, whether one action would get past it, and what to keep
// for next time. The model only names elements by their number in the list, and whatever it
// names goes through the guard below before anything is done: it can close a notice, never
// book, pay or leave the app.
import fs from 'node:fs';
import { commits } from './routines.js';
import { find, spoken } from './screen.js';

// The long side of the picture a model is shown, in pixels, whatever the device's resolution:
// about 1,000 keeps an app's text readable, at a fraction of what the full picture costs.
export const MODEL_PICTURE = 1000;

export const KINDS = ['popup', 'system', 'changed', 'loading', 'needs_owner', 'unknown'];

export const DIAGNOSIS = {
  type: 'object',
  required: ['kind', 'summary', 'recoverable', 'action', 'fix'],
  additionalProperties: false,
  properties: {
    kind: { enum: KINDS },
    summary: { type: 'string', maxLength: 400 },
    recoverable: { type: 'boolean' },
    action: {
      type: ['object', 'null'],
      required: ['do'],
      additionalProperties: false,
      properties: {
        do: { enum: ['tap', 'back', 'wait'] },
        element: { type: 'integer', minimum: 0 },
        seconds: { type: 'integer', minimum: 1, maximum: 10 },
      },
    },
    fix: {
      type: ['object', 'null'],
      required: ['kind'],
      additionalProperties: false,
      properties: {
        kind: { enum: ['popup', 'changed'] },
        when: { type: 'integer', minimum: 0 },
        contains: { type: 'string', maxLength: 60 },
        tap: { type: 'integer', minimum: 0 },
        target: { type: 'integer', minimum: 0 },
        by_position: { type: 'boolean' },
        heading: { type: 'integer', minimum: 0 },
      },
    },
  },
};

// Words on what a recovery may never tap, whatever the model says (beside the app's own
// buttons that book, pay or send).
const NEVER =
  /\b(pay|book|buy|order|send|subscribe|purchase|checkout|check out|confirm|accept|agree|allow|install|update|upgrade|sign|log ?in|log ?out|delete|remove|cancel|call|yes|ok|continue|start|go|done)\b/i;

// The list the model is shown: numbered, the words and what each is.
export const listed = (els) =>
  els
    .map((e, i) => {
      const words = [e.text && `"${e.text}"`, e.description && `(${e.description})`, e.label && `[${e.label}]`].filter(Boolean).join(' ');
      return `${i}. ${words || '(no words)'}${e.tap ? ' · tap' : ''}${e.field ? ' · field' : ''}${e.id ? ` · id ${e.id}` : ''}`;
    })
    .join('\n');

// An element as a routine names it: by its id, else its exact text, else its description.
// One whose words are its children's (a tile, a button drawn from a picture and a label) is
// found by the first of them: a tap on that lands on the element around it.
export function targetOf(e) {
  if (e.id) return { resourceId: e.id };
  if (e.text) return { text: e.text };
  if (e.description) return { description: e.description };
  if (e.inner?.text) return { textContains: e.inner.text };
  if (e.inner?.description) return { descriptionContains: e.inner.description };
  const first = e.label?.split(' · ')[0]?.trim();
  if (first) return { textContains: first };
  return null;
}

// → null when the element may be tapped to get past something, else why not.
export function refuseTap(e, app) {
  if (!e) return 'there is no such element';
  if (!e.tap) return 'it cannot be tapped';
  if (e.field) return 'it is a field';
  const words = [e.text, e.description, e.label].filter(Boolean);
  if (!words.length) return 'it has no words to tell what it does';
  if (words.some((w) => commits(app, { text: w }))) return `"${words[0]}" books, pays or sends`;
  if (words.some((w) => NEVER.test(w))) return `"${words[0]}" could do more than close something`;
  return null;
}

// An element by its place in a list, whatever it says: the n-th thing to tap below the list's
// heading. → null when it cannot be named so.
export function byPlace(root, e, heading) {
  const words = heading && (heading.text || heading.description || heading.inner?.text);
  if (!root || !e || !words) return null;
  const over = { textContains: words.split(/\s+/).slice(0, 5).join(' ') };
  const t = { below: over, clickable: true, width: e.bounds[2] - e.bounds[0] };
  const at = find(root, t).findIndex((n) => n.bounds.join() === e.bounds.join());
  return at >= 0 ? { ...t, instance: at } : null;
}

// The one action a diagnosis asks for, checked. → { do, element?, seconds?, said } or { refused }.
export function checkedAction(d, els, app) {
  const a = d?.recoverable ? d.action : null;
  if (!a) return { refused: 'nothing to do' };
  if (a.do === 'back') return { do: 'back', said: 'pressed Back' };
  if (a.do === 'wait') return { do: 'wait', seconds: Math.min(10, a.seconds ?? 5), said: `waited ${Math.min(10, a.seconds ?? 5)}s` };
  const e = els[a.element];
  const why = refuseTap(e, app);
  if (why) return { refused: `the tap it suggested was not made: ${why}` };
  return { do: 'tap', element: e, said: `tapped "${e.text || e.description || e.label}"` };
}

// What to keep for next time, from a diagnosis: a pop-up for the app's file, or a step's new
// target. Only words that are on the screen, as the elements say them. → null or { kind, … }.
export function proposedFix(d, els, app, step, root = null) {
  const f = d?.fix;
  if (!f) return null;
  if (f.kind === 'popup') {
    const when = els[f.when];
    const tap = els[f.tap];
    const text = when?.text || when?.description || '';
    const contains = f.contains && text.includes(f.contains) ? f.contains : null;
    if (!when || !contains || refuseTap(tap, app)) return null;
    const by = when.text ? { textContains: contains } : { descriptionContains: contains };
    const close = targetOf(tap);
    if (!close) return null;
    if (app.popups.some((p) => JSON.stringify(p.when) === JSON.stringify(by))) return null;
    return { kind: 'popup', popup: { when: by, tap: close }, said: `when ${describe(by)} shows, tap ${describe(close)}` };
  }
  if (f.kind === 'changed' && step && 'target' in step) {
    const e = els[f.target];
    // (Chosen for its place in a list: the n-th below the heading, so that another time the
    // one in that place is chosen, whatever it says then.)
    const target = e && ((f.by_position && byPlace(root, e, els[f.heading])) || targetOf(e));
    if (!target || commits(app, { text: e.text ?? '' })) return null;
    return { kind: 'changed', target, said: `use ${describe(target)} instead of ${describe(step.target)}` };
  }
  return null;
}

const describe = (t) => spoken(t);

// Ask the model. `shot` is the picture of the screen. → a diagnosis, or null (no model).
export async function diagnose(ctx, { routine, step, n, error, els, shot }) {
  const input = [];
  if (shot && fs.existsSync(shot))
    input.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: shot.endsWith('.png') ? 'image/png' : 'image/jpeg',
        data: fs.readFileSync(shot).toString('base64'),
      },
    });
  input.push({
    type: 'text',
    text: [
      `The app: ${routine.app}. The routine's goal: ${routine.goal ?? routine.name}.`,
      `The step that failed (step ${n}): ${JSON.stringify(step)}`,
      ...(/\b(first|top|second|third|last)\b/i.test(routine.goal ?? '')
        ? [
            "The routine's goal asks for a choice by its place in a list: when the fix is such a choice, set by_position and give the number of the list's heading.",
          ]
        : []),
      `Why: ${error}`,
      '',
      'On the screen now:',
      listed(els),
    ].join('\n'),
  });
  try {
    return await ctx.reader('diagnose', { input, schema: DIAGNOSIS });
  } catch (e) {
    ctx.log(`no diagnosis: ${e.message}`);
    return null;
  }
}
