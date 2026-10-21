// Learning a routine from words: a model is shown the goal, the owner's values, the steps so
// far and the screen (a picture and the numbered elements), and answers with one action. The
// plugin checks it, does it, and looks again, until the confirmation screen (or the goal) is
// reached. What worked becomes the routine: dead ends are taken off, closing a notice becomes
// one of the app's pop-ups, and each value the owner gave becomes a {{value}} of the routine.
//
// The model only names elements by their number. It types only the owner's values, and the
// guard refuses any tap on what could book, buy, pay, send or leave the app: the button that
// commits is named by the model at the confirmation screen, never tapped.
import fs from 'node:fs';
import path from 'node:path';
import { sleep } from '../../src/api.js';
import { byPlace, listed, MODEL_PICTURE, targetOf } from './recover.js';
import { commits, KEYS } from './routines.js';
import { elements, find, packageOf, parse } from './screen.js';

export const MAX_ACTIONS = 40;
// How long a step that is done only on some screens waits for that screen to come.
const ONLY_IF_WAIT = 10;
export const MAX_MINUTES = 12; // (a command from the chat is stopped at 15)
const SETTLE_MS = 1500;
// Words on what learning may never tap (beside the app's own buttons that book, pay or send).
const NEVER =
  /\b(pay|buy|purchase|order|checkout|check out|subscribe|send|book|install|uninstall|delete|remove|sign ?out|log ?out|call)\b/i;
// The keyboards: typing brings one up, which is not leaving the app.
const KEYBOARDS = /inputmethod|honeyboard|keyboard|swiftkey/i;
export const PATTERNS = {
  money: '([A-Z]{3}|[$€£⃃⃎])\\s*[\\d.,]+(\\s*-\\s*[\\d.,]+)?|[\\d.,]+\\s*[A-Z]{3}',
  time: '\\d{1,2}:\\d{2}|\\d+\\s*min',
};

export const ACTION = {
  type: 'object',
  required: ['thought', 'do'],
  additionalProperties: false,
  properties: {
    thought: { type: 'string', maxLength: 400 },
    why: { type: 'string', maxLength: 120 },
    do: { enum: ['tap', 'type', 'scroll', 'back', 'restart', 'wait', 'key', 'confirm_screen', 'done', 'stuck'] },
    element: { type: 'integer', minimum: 0 },
    popup: { type: 'boolean' },
    by_position: { type: 'boolean' },
    heading: { type: 'integer', minimum: 0 },
    only_if: { type: 'integer', minimum: 0 },
    value: { type: 'string', maxLength: 40 },
    direction: { enum: ['up', 'down'] },
    key: { type: 'string', maxLength: 30 },
    button: { type: 'integer', minimum: 0 },
    must_show: { type: 'array', maxItems: 4, items: { type: 'integer', minimum: 0 } },
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

const words = (e) => [e?.text, e?.description, e?.label].filter(Boolean);
const mid = (e) => [(e.bounds[0] + e.bounds[2]) / 2, (e.bounds[1] + e.bounds[3]) / 2];

// An element as the routine will find it, with the owner's values in it as {{value}}: the
// result for "AA batteries" is found next time by whatever `item` is then.
export function targetFor(e, values) {
  for (const [k, v] of Object.entries(values)) if (v && e.text?.includes(v)) return { textContains: `{{${k}}}` };
  for (const [k, v] of Object.entries(values)) if (v && e.description?.includes(v)) return { descriptionContains: `{{${k}}}` };
  for (const [k, v] of Object.entries(values)) if (v && e.label?.includes(v)) return { textContains: `{{${k}}}` };
  return targetOf(e);
}

// A target as `t`, made to name `e` alone: with the n-th (`instance`) when several on the
// screen match it (two search fields with the same id).
// (A target with the owner's values in it is looked for with those values filled in: the
// result "AA batteries" is the second element with those words when the field above
// it holds them too.)
export function alone(root, e, t, values = {}) {
  if (!t || t.instance != null) return t;
  const filled = JSON.parse(JSON.stringify(t).replace(/\{\{(\w+)\}\}/g, (m, k) => (values[k] ?? m).replace(/["\\]/g, '')));
  const all = find(root, filled);
  if (all.length < 2) return t;
  // (The one tapped, or its words inside it: a tile is found by the text within it.)
  const inside = (b, o) => b[0] >= o[0] && b[1] >= o[1] && b[2] <= o[2] && b[3] <= o[3];
  const at = all.findIndex((n) => n.bounds.join() === e.bounds.join() || inside(n.bounds, e.bounds));
  return at >= 0 ? { ...t, instance: at } : t;
}

// A label that will be the same next time: words with a number in them ("Arrive by 21:02",
// "Delivery in 2 days") are this moment's, so only the words before the number are kept.
export function steady(t) {
  const words = t?.text ?? t?.textContains;
  if (!words || !/\d/.test(words)) return t;
  const before = words.split(/\d/)[0].trim();
  return before.length >= 3 ? { textContains: before } : null;
}

// What to read on a screen, from the model's answer (`read`: a name, the number of a fixed label
// beside the value, how it sits, its kind) → { name: { after | row_of, pattern? } }.
export function readSpec(items, els) {
  const read = {};
  for (const r of items ?? []) {
    const anchor = els[r.anchor];
    const t = anchor && steady(targetOf(anchor));
    if (!t || !/^[A-Za-z][\w ]{0,29}$/.test(r.name)) continue;
    read[r.name] = { [r.how === 'row' ? 'row_of' : 'after']: t, ...(PATTERNS[r.kind] ? { pattern: PATTERNS[r.kind] } : {}) };
  }
  return read;
}

// → null when learning may tap it, else why not.
export function refuseLearnTap(e, app) {
  if (!e) return 'there is no element with that number';
  const w = words(e);
  if (!w.length && !e.id) return 'it has no words or id, so the routine could not find it again: choose another';
  if (w.some((x) => commits(app, { text: x }))) return `"${w[0]}" books, pays or sends: name it with confirm_screen instead`;
  if (w.some((x) => NEVER.test(x)))
    return `"${w[0]}" could book, buy, pay, send or delete: if this is the confirmation screen, say confirm_screen`;
  return null;
}

export class Learner {
  // think: async ({ goal, values, steps, notes, els, shot, app }) => an action (ACTION), or null
  // confirmEach: async (what, shot) => true to go on (the owner watching, step by step), or null
  // told: what the owner's pictures of the app show (pictures.js), for the model
  // goingOn: learning only a part of a routine, from where its steps before have brought the
  //   app ({ before, next }: those steps, and the one that comes after the part): the app is
  //   not started again, and the part is done when what comes next can go on
  constructor(
    dev,
    {
      app,
      goal,
      values = {},
      stopAt = null,
      think,
      confirmEach = null,
      log = () => {},
      media,
      max = MAX_ACTIONS,
      minutes = MAX_MINUTES,
      told = null,
      goingOn = null,
    },
  ) {
    Object.assign(this, { dev, app, goal, values, stopAt, think, confirmEach, log, media, max, told, goingOn });
    this.until = Date.now() + minutes * 60_000;
    this.steps = [];
    this.popups = [];
    this.notes = [];
    this.actions = 0;
  }

  // A step, or (`only_if`: on a screen that shows only some times, such as a choice of branch
  // inside a large place) a step under "if that screen shows". Steps on the same such screen go
  // under one.
  record(step, a, els) {
    const sign = a.only_if != null ? els[a.only_if] : null;
    const words0 = sign && (sign.text || sign.description || sign.label?.split(' · ')[0]);
    if (!words0) return void this.steps.push(step);
    const when = { textContains: words0.split(/\s+/).slice(0, 5).join(' ') };
    const last = this.steps.at(-1);
    if (last?.do === 'if_shown' && JSON.stringify(last.target) === JSON.stringify(when)) last.then.push(step);
    else this.steps.push({ do: 'if_shown', target: when, wait: ONLY_IF_WAIT, then: [step] });
  }

  note(text) {
    this.notes.push(text);
    if (this.notes.length > 12) this.notes.shift();
  }

  async run() {
    let scroll = null; // a scroll waiting for the element it was for
    // (Until the app is on the screen: it may take a few seconds to come up.)
    for (let k = 0; k < 10 && packageOf(parse(await this.dev.dump())) !== this.app.package; k++) await sleep(1000);
    let same = 0; // actions in a row after which the screen was as before
    let seen = null;
    for (; this.actions < this.max && Date.now() < this.until; this.actions++) {
      const root = parse(await this.dev.dump());
      const els = elements(root);
      this.root = root;
      // Going nowhere (the same screen after three actions): stopped, not left to spend more.
      const looks = JSON.stringify(els.map((x) => [x.text, x.description, x.id]));
      same = looks === seen ? same + 1 : 0;
      seen = looks;
      if (same >= 3) return { ended: 'stuck', why: `nothing changed on the screen after ${same} tries: ${this.last ?? ''}` };
      const shot = await this.dev
        .screenshot(path.join(this.media, `learn-${Date.now()}.jpg`), { longEdge: MODEL_PICTURE })
        .catch(() => null);
      const a = await this.think({
        goal: this.goal,
        values: this.values,
        stopAt: this.stopAt,
        told: this.told,
        goingOn: this.goingOn,
        steps: this.steps,
        notes: this.notes,
        els,
        shot,
        app: this.app,
      });
      if (!a) return { ended: 'no-model' };
      this.last = a.thought;
      const said = `${this.actions + 1}. ${a.thought}`;
      if (this.confirmEach && !['confirm_screen', 'done', 'stuck'].includes(a.do) && !(await this.confirmEach(said, shot)))
        return { ended: 'stopped', why: 'stopped by the owner' };
      this.log(said);
      const e = a.element != null ? els[a.element] : null;
      switch (a.do) {
        case 'tap': {
          const why = refuseLearnTap(e, this.app);
          if (why) {
            this.note(`not done: ${why}`);
            continue;
          }
          const target = alone(this.root, e, targetFor(e, this.values), this.values);
          if (!target) {
            this.note('not done: that element has nothing the routine could find it by again: choose one with words or an id');
            continue;
          }
          await this.dev.tap(...mid(e));
          if (a.popup) {
            // A notice, kept as one of the app's pop-ups: by a few of its words, closed by this tap.
            // (Known by a line of its own words that will be the same next time: none with
            // digits, which are times, dates and amounts.)
            const title = els.find((x) => x !== e && x.text && !x.tap && !/\d/.test(x.text) && x.text.length >= 8);
            if (title) this.popups.push({ when: { textContains: title.text.split(/\s+/).slice(0, 4).join(' ') }, tap: target });
            this.note(`closed ${words(e)[0]} (a pop-up)`);
          } else {
            // Chosen by its place in a list ("the first suggestion"), not by what it says.
            const at = a.by_position && e.id ? els.filter((x) => x.id === e.id).indexOf(e) : -1;
            const placed = a.by_position && at < 0 ? byPlace(this.root, e, els[a.heading ?? a.only_if]) : null;
            const step = {
              do: 'tap',
              target: at >= 0 ? { resourceId: e.id, instance: at } : (placed ?? target),
              ...(a.why ? { why: a.why } : {}),
            };
            if (scroll) this.record({ do: 'scroll', until: step.target, ...(scroll === 'up' ? { direction: 'up' } : {}) }, a, els);
            this.record(step, a, els);
            this.note(`tapped ${words(e)[0] ?? e.id}`);
          }
          scroll = null;
          break;
        }
        case 'type': {
          if (!Object.hasOwn(this.values, a.value ?? '')) {
            this.note(`not typed: only the owner's values may be typed (${Object.keys(this.values).join(', ') || 'none were given'})`);
            continue;
          }
          const field = e && e.field ? e : null;
          if (field) await this.dev.tap(...mid(field));
          await this.dev.type(this.values[a.value], { had: field?.text?.length ?? 40 });
          const target = field ? alone(this.root, field, targetOf(field)) : null;
          // (Typed again into the same field, after clearing it: only the last typing is kept.)
          const same = (x) => x.do === 'type' && JSON.stringify(x.target ?? null) === JSON.stringify(target);
          const clears = (x) => x.do === 'tap' && /clear|cross|erase|delete text|×/i.test(JSON.stringify(x.target));
          while (this.steps.length && (same(this.steps.at(-1)) || clears(this.steps.at(-1)))) this.steps.pop();
          this.record({ do: 'type', text: `{{${a.value}}}`, ...(target ? { target } : {}), ...(a.why ? { why: a.why } : {}) }, a, els);
          this.note(`typed the value ${a.value}`);
          break;
        }
        case 'scroll': {
          const [w, h] = [root.children[0]?.bounds[2] || 1080, root.children[0]?.bounds[3] || 2000];
          if (a.direction === 'up') await this.dev.swipe(w / 2, h * 0.3, w / 2, h * 0.7);
          else await this.dev.swipe(w / 2, h * 0.7, w / 2, h * 0.3);
          scroll = a.direction ?? 'down';
          this.note(`scrolled ${scroll}`);
          break;
        }
        case 'back':
          await this.dev.key('BACK');
          this.steps.pop();
          this.note('pressed Back; the last step was taken off');
          break;
        case 'restart':
          if (this.goingOn) {
            this.note('not done: this goes on from where the routine is, so the app is not started again: press Back instead');
            continue;
          }
          await this.dev.stopApp(this.app.package);
          await this.dev.startApp(this.app.package);
          this.steps = [];
          this.note('started the app again; the steps were cleared');
          break;
        case 'wait':
          await sleep(3000);
          break;
        case 'key':
          if (!KEYS.includes(a.key)) {
            this.note(`not pressed: ${a.key} is not one of the keys`);
            continue;
          }
          await this.dev.key(a.key);
          this.steps.push({ do: 'key', key: a.key, ...(a.why ? { why: a.why } : {}) });
          break;
        case 'confirm_screen': {
          // (Going on from a routine's step: its confirmation screen is the routine's own.)
          if (this.goingOn) return { ended: 'done', shot };
          const button = els[a.button];
          // The owner named the button to stop at: this is its screen only when that is the button.
          if (
            this.stopAt &&
            !words(button)
              .flatMap((w) => w.split(' · '))
              .some((w) => w.trim().toLowerCase() === this.stopAt.toLowerCase())
          ) {
            this.note(
              `not taken: the owner said to stop at the screen with the "${this.stopAt}" button, and element ${a.button} is not it: go on until that button shows`,
            );
            continue;
          }
          if (!button || !targetOf(button)) {
            this.note(
              `not taken: element ${a.button} has no words or id; name the confirmation button by an element with words, such as its label`,
            );
            continue;
          }
          // (Only what holds the owner's values: other words on it, a branch's name say,
          // belong to this one time.)
          const mustShow = (a.must_show ?? [])
            .map((i) => els[i])
            .filter(Boolean)
            .map((x) => targetFor(x, this.values))
            .filter((t) => t && JSON.stringify(t).includes('{{'));
          const read = readSpec(a.read, els);
          return {
            ended: 'confirm',
            label: words(button)[0],
            confirm: {
              do: 'confirm',
              button: targetOf(button),
              ...(mustShow.length ? { must_show: mustShow } : {}),
              ...(Object.keys(read).length ? { read } : {}),
            },
            shot,
          };
        }
        case 'done':
          return { ended: 'done', shot };
        case 'stuck':
          return { ended: 'stuck', why: a.thought, shot };
      }
      await sleep(SETTLE_MS);
      // Out of the app (a link, a store page): back into it, and the model is told.
      const now = packageOf(parse(await this.dev.dump()));
      if (now && now !== this.app.package && !KEYBOARDS.test(now) && now !== 'com.android.systemui') {
        await this.dev.key('BACK');
        if (this.steps.at(-1)?.do === 'tap') this.steps.pop();
        this.note(`that opened ${now}, outside the app: went back, and the step was taken off`);
      }
    }
    return { ended: 'budget' };
  }
}

// Ask the model for the next action.
export async function think(ctx, { goal, values, stopAt, told, goingOn, steps, notes, els, shot, app }) {
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
      `The app: ${app.label ?? app.package} (${app.package}).${app.commit.length ? ` Its buttons that book, pay or send: ${app.commit.map((c) => `"${c}"`).join(', ')}.` : ''}`,
      `The goal, in the owner's words: ${goal}`,
      ...(stopAt
        ? [`The owner said: stop at the screen with the "${stopAt}" button, and never tap it. Only that screen is the confirmation screen.`]
        : []),
      ...(goingOn
        ? [
            `This is a change to a routine that is already made: its steps before it have been done (${goingOn.before.length ? JSON.stringify(goingOn.before) : 'none: the app has just been started'}). Learn only the new part. ${goingOn.next ? `After it the routine goes on with ${JSON.stringify(goingOn.next)}: answer done when that can be done on the screen.` : 'Answer done when the new part is done.'}`,
          ]
        : []),
      ...(told ? [`What the owner's pictures of the app show: ${told}`] : []),
      ...(/\b(first|top|second|third|last)\b/i.test(goal)
        ? [
            'The goal asks for a choice by its place in a list: for that tap, set by_position, so that other values get the one in that place.',
          ]
        : []),
      `The owner's values: ${
        Object.keys(values).length
          ? Object.entries(values)
              .map(([k, v]) => `${k} = "${v}"`)
              .join('; ')
          : 'none'
      }`,
      `The steps that worked so far: ${steps.length ? JSON.stringify(steps) : 'none yet (the app has just been started)'}`,
      `Notes: ${notes.length ? notes.join(' · ') : 'none'}`,
      '',
      'On the screen now:',
      listed(els),
    ].join('\n'),
  });
  try {
    return await ctx.reader('learn', { input, schema: ACTION });
  } catch (e) {
    ctx.log(`no next step: ${e.message}`);
    return null;
  }
}
