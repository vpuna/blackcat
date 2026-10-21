// Replaying a routine with no model: the same start and end around every run, each step
// waiting for what it needs instead of pausing, and a stop at the confirmation screen where
// only the owner's answer presses the button.
import path from 'node:path';
import { sleep } from '../../src/api.js';
import { AndroidError } from './device.js';
import { headline } from './after.js';
import { checkedAction, MODEL_PICTURE, proposedFix } from './recover.js';
import { commits, signsOf } from './routines.js';
import { appOnly, elements, find, labelOf, middle, parse, spoken, spokenAny, walk } from './screen.js';

export class StepFailed extends AndroidError {}
// A `stop` step was reached: the routine itself says why it goes no further (an order already under way).
export class Stopped extends AndroidError {}

const POLL_MS = 150;
// After a tap: what was on the screen before it is not taken for what came of it until this
// long has passed (an element that is new, or has moved, is taken at once).
const SETTLE_MS = 500;
const END_PICTURE_WAIT_MS = 1000; // before the picture at the end (`picture: true`)
// A step for a screen that may not come (if_shown) ends early when what a later step waits
// for has been on the screen this long, and it was not before the last tap.
const SKIP_AFTER_MS = 1500;
const RETAP_AFTER_MS = 3000;
const MAX_RETAPS = 3; // (an app just started can ignore taps for several seconds)
const MAX_RECOVERIES = 2;
const OWNER_PICTURE = 2400;
const KEY_GAP_MS = 250; // between presses of a remote's key
// After the press: a screen is the app's last one when it has stayed the same this long (unless
// the routine names what its last one shows); waited for at most, unless the routine says.
const STEADY_MS = 3000;
const RESULT_WAIT_S = 60;
const NAMED_RESULT_WAIT_S = 120;
const DONE_SETTLE_MS = 10_000; // at most, for the app's last screen to stay the same before its picture
const STILL_WAITING_MS = 20_000; // how often the owner is told it is still waiting
const MAX_JUDGED = 3;

// The same start and end around every run: the screen kept on while it works (the device's own
// setting put back after), the app from its first screen, and at the end the device as the
// routine says (`after`): by default a phone on its home screen with the screen off, and a TV
// as the routine left it. Whatever happens in between, also a failure.
const KEPT_STAY_ON = 'blackcat_stay_on_while_plugged_in';

export async function session(dev, routine, fn, { log = () => {}, tv = false } = {}) {
  const app = routine.app;
  const after = routine.after ?? (tv ? 'stay' : 'sleep');
  // (The device's own value is kept on the device while a run works: one cut off before its
  // end, by the service being stopped say, leaves it there, and the next run puts it back,
  // not the "stay on" it found.)
  const kept = await dev.setting('global', KEPT_STAY_ON);
  const stayOn = /^\d+$/.test(kept) ? kept : await dev.setting('global', 'stay_on_while_plugged_in');
  if (!/^\d+$/.test(kept) && /^\d+$/.test(stayOn)) await dev.setting('global', KEPT_STAY_ON, stayOn);
  await dev.ensureServer();
  // (`start: running`: nothing is woken, closed or opened; it goes on from what is showing.)
  if (routine.start === 'running') {
    if ((await dev.wakefulness()) !== 'Awake')
      throw new AndroidError('the device is asleep, and this routine goes on from what is showing');
    const front = await dev.foreground();
    if (front !== app) throw new AndroidError(`${app} is not in front (${front ?? 'nothing'} is), and this routine goes on from it`);
  }
  if (routine.start !== 'running') await dev.wake();
  await dev.setting('global', 'stay_on_while_plugged_in', 7); // only while it works
  try {
    if (!(await dev.installed(app))) throw new AndroidError(`${app} is not installed on the device`);
    // Always from the app's first screen, whatever was on top (unless it goes on from it).
    if (routine.start !== 'running') {
      await dev.stopApp(app);
      await dev.startApp(app);
      log(`started ${app}`);
    }
    return await fn();
  } finally {
    await dev.setting('global', 'stay_on_while_plugged_in', /^\d+$/.test(stayOn) ? stayOn : 0).catch(() => {});
    await dev.unset('global', KEPT_STAY_ON).catch(() => {});
    if (after !== 'stay') await dev.key('HOME').catch(() => {});
    if (after === 'sleep') await dev.sleep().catch(() => {});
    log(
      {
        sleep: 'home screen, screen off, settings put back',
        home: 'home screen, settings put back',
        stay: 'left as it is, settings put back',
      }[after],
    );
  }
}

// Currency signs newer than most fonts, as their letters, so that a value read off a screen
// shows wherever it is sent.
const NEW_SIGNS = { '\u20C3': 'AED ', '\u20CE': 'AED ' };
// What a screen shows, in words: to tell the same screen (still loading) from another.
const labelsOf = (root) => new Set([...walk(root ?? {})].map(labelOf).filter(Boolean));
const sameScreen = (was, now) => !!was?.size && [...was].filter((l) => !now.has(l)).length <= Math.max(2, 0.2 * was.size);
const same = (a, b) => !!a && !!b && a.every((x, k) => x === b[k]);
// (The same element after the screen under it moved, as a home screen still loading does: the same size, anywhere.)
const sameSize = (a, b) => !!a && !!b && a[2] - a[0] === b[2] - b[0] && a[3] - a[1] === b[3] - b[1];
const asLetters = (v) => [...v].map((c) => NEW_SIGNS[c] ?? c).join('');

export class Runner {
  // answer: async ({ values, shot, routine }) => 'confirm' | 'cancel' | 'timeout'
  // recover: async ({ routine, step, n, error, els, shot }) => a diagnosis (recover.js), or null
  // onStep / onDone: ({ n, step, text }) as each step starts and ends (for the owner to follow).
  // judge: async ({ els, shot }) => whether the screen after the press is the app's last one
  //   ({ final, summary, result }, after.js), for a routine that does not say; or null.
  // onWait: (seconds) while it waits for that screen.
  constructor(
    dev,
    routine,
    app,
    {
      answer,
      log = () => {},
      media,
      onStep = () => {},
      onDone = () => {},
      recover = null,
      judge = null,
      onWait = () => {},
      steadyMs = STEADY_MS,
    },
  ) {
    Object.assign(this, { dev, routine, app, answer, log, media, onStep, onDone, recover, judge, onWait, steadyMs });
    this.steps = [];
    this.recoveries = [];
    this.started = Date.now();
  }

  async screen() {
    this.seen = parse(await this.dev.dump());
    return this.seen;
  }

  // Whether this element of the screen now was on the screen before the last tap, in the
  // same place: until the tap has had time to land, that is the old screen still.
  landing() {
    return !!this.tapped && Date.now() - this.tapped.at < SETTLE_MS;
  }

  stale(target, hit) {
    const t = this.tapped;
    if (!this.landing()) return false;
    return find(t.before, target).some((o) => same(o.bounds, hit.bounds) && labelOf(o) === labelOf(hit));
  }

  // The first element the target names, waiting up to `seconds`; a known pop-up in the way is cleared.
  // `retap`: a step that needs it. A tap on an app that is still starting can be lost: when
  // what this step needs has not come three seconds after the last tap, and the element tapped
  // is still on the screen, the same size (it may have moved, as a screen that loads does), it is
  // tapped again, up to MAX_RETAPS times, three seconds apart; when it is not, why goes on the
  // run's record. Nothing is waited for when all goes well.
  // `steady`: for an element about to be tapped, found while the last tap may still be landing:
  // taken once it is in the same place on two looks in a row (not while it slides in). `ahead`: for a screen that may not come, what later
  // steps wait for; when one of those is on the screen (and stays), it is not waited for longer.
  async waitFor(target, seconds, { retap = false, steady = false, ahead = [] } = {}) {
    const end = Date.now() + seconds * 1000;
    let prev = null;
    let later = null; // (what a later step waits for, and since when it has been there)
    this.skippedFor = null;
    for (;;) {
      const root = await this.screen();
      const found = find(root, target).find((h) => !this.stale(target, h)) ?? null;
      if (found) this.lastTap = null; // (what the tap was for has come)
      const hit = found && (!steady || !this.landing() || (prev && same(prev.bounds, found.bounds))) ? found : null;
      prev = found;
      if (hit || Date.now() > end) return hit ?? found ?? null;
      // (Only once something has been tapped: at the app's start what shows first says little.)
      if (!found && ahead.length && this.tapped) {
        const sign = ahead.find((t) => find(root, t).some((h) => !this.stale(t, h) && !this.before(t, h)));
        if (!sign || sign !== later?.sign) later = sign ? { sign, since: Date.now() } : null;
        else if (Date.now() - later.since >= SKIP_AFTER_MS) {
          this.skippedFor = sign;
          return null;
        }
      }
      const t = this.lastTap;
      if (retap && t && Date.now() - t.at > RETAP_AFTER_MS) {
        // Only on the screen it was tapped on: the element where it was, and most of what was
        // around it still there (a home screen still loading offers is the same screen; another is not).
        const now = labelsOf(root);
        const onIt = sameScreen(t.labels, now);
        const again = onIt ? find(root, t.target).find((n) => sameSize(n.bounds, t.bounds)) : null;
        // (Why not, with the step's failure should it fail: on the run's record and for a model's look.)
        if (!again) {
          this.untapped = `${spoken(t.target)} was not tapped again: ${
            onIt
              ? 'it is not on the screen, the same size'
              : `the screen changed (${[...t.labels].filter((l) => !now.has(l)).length} of ${t.labels.size} things on it are gone)`
          }`;
          this.log(this.untapped);
        }
        const times = (t.times ?? 1) + 1;
        this.lastTap = again && times <= MAX_RETAPS ? { ...t, at: Date.now(), times } : null;
        if (again) {
          await this.tapNode(again);
          const step = this.steps[t.n];
          if (step) step.text = `${step.text.replace(/ \(tapped \d+ times: .*\)$/, '')} (tapped ${times} times: the first did nothing)`;
          this.log(`tapped ${spoken(t.target)} again (${times}): the tap before did nothing`);
          continue;
        }
      }
      await this.clearPopup(root);
      await sleep(POLL_MS);
    }
  }

  // Whether the element was there before the last tap at all (anywhere): what a later step
  // waits for that was there already says nothing of where the app has gone.
  before(target, hit) {
    return !!this.tapped && find(this.tapped.before, target).some((o) => labelOf(o) === labelOf(hit));
  }

  async clearPopup(root) {
    for (const p of this.app.popups) {
      if (!find(root, p.when).length) continue;
      const b = find(root, p.tap)[0];
      if (!b) continue;
      this.log(`a pop-up (${spoken(p.when)}): tapped ${spoken(p.tap)}`);
      await this.dev.tap(...middle(b));
      await sleep(SETTLE_MS);
      return true;
    }
    return false;
  }

  // (Not paused after: the next step waits for its own target, and what was there before the
  // tap is not taken for it until the tap has had time to land.)
  async tapNode(n) {
    const before = this.seen;
    await this.dev.tap(...middle(n));
    this.tapped = { at: Date.now(), before };
  }

  // After a field is tapped, until it has the focus (what is typed goes to the field that has
  // it, which may be another one until then), for at most as long as a tap is given to land.
  async focused(field) {
    const end = Date.now() + SETTLE_MS;
    while (Date.now() < end) {
      if ([...walk(await this.screen())].some((n) => n.focused === 'true' && same(n.bounds, field.bounds))) return;
      await sleep(50);
    }
  }

  async shot(name) {
    // (For the owner: full size, up to OWNER_PICTURE on its long side, so a 4K TV's is not a huge file.)
    return this.dev.screenshot(path.join(this.media, `${this.routine.name}-${name}-${Date.now()}.jpg`), { longEdge: OWNER_PICTURE });
  }

  async run() {
    const ended = await this.steps_(this.routine.steps, '');
    // (`picture: true`: the screen as the routine left it, for the owner.)
    // (After a moment: a TV's picture can follow its banner; a routine waits for what says it plays.)
    const shot = this.routine.picture ? await sleep(END_PICTURE_WAIT_MS).then(() => this.shot('end').catch(() => null)) : null;
    return {
      outcome: 'finished',
      ...ended,
      ...(shot ? { shot } : {}),
      steps: this.steps,
      seconds: Math.round((Date.now() - this.started) / 1000),
    };
  }

  // Each step in turn. One that fails is looked at (`recover`): when a safe action gets past
  // what is in the way, it is done and the step tried again; at most MAX_RECOVERIES in a run.
  // `outer`: what the steps after this list wait for (for a list inside another step).
  async steps_(steps, where, outer = []) {
    for (const [i, s] of steps.entries()) {
      const n = `${where}${i + 1}`;
      // (A step for when an optional value is given, or for when it is not.)
      if (this.notNeeded(s)) {
        this.steps.push({
          n,
          do: s.do,
          ms: 0,
          text: `not needed: ${s.only_with ? `no ${s.only_with} was given` : `${s.only_without} was given`}`,
        });
        continue;
      }
      for (;;) {
        try {
          const r = await this.step(s, n, this.ahead(steps, i + 1, outer));
          if (r) return r;
          break;
        } catch (e) {
          const got = await this.recovered(s, n, e);
          if (!got) throw e;
          if (got === 'done') break; // (the tap that got past it was the step's own)
        }
      }
    }
    return null;
  }

  async recovered(s, n, e) {
    if (!(e instanceof StepFailed) || e.handled || e.final || !this.recover) return false;
    e.handled = true; // (a step inside if_shown is looked at once, not again for the if_shown around it)
    if (this.recoveries.length >= MAX_RECOVERIES) return false;
    const root = await this.screen();
    const els = elements(root);
    // (The model is shown a smaller picture; the owner is sent the full one.)
    const small = await this.dev
      .screenshot(path.join(this.media, `${this.routine.name}-look-${Date.now()}.jpg`), { longEdge: MODEL_PICTURE })
      .catch(() => e.shot);
    const d = await this.recover({ routine: this.routine, step: s, n, error: e.message, els, shot: small });
    if (!d) return false;
    const a = checkedAction(d, els, this.app);
    const entry = {
      n,
      kind: d.kind,
      summary: d.summary,
      did: a.refused ? null : a.said,
      refused: a.refused ?? null,
      fix: proposedFix(d, els, this.app, s, root),
      shot: e.shot,
    };
    this.recoveries.push(entry);
    e.diagnosis = entry;
    if (a.refused) return false;
    if (a.do === 'tap')
      await this.dev.tap((a.element.bounds[0] + a.element.bounds[2]) / 2, (a.element.bounds[1] + a.element.bounds[3]) / 2);
    else if (a.do === 'back') await this.dev.key('BACK');
    await sleep(a.do === 'wait' ? a.seconds * 1000 : SETTLE_MS);
    const failed = this.steps.findLast((x) => x.n === n && x.failed);
    if (failed) failed.recovered = a.said;
    // What the step looked for is there, named otherwise (an app update, other spelling): the
    // tap that got past it was the step itself.
    if (d.kind === 'changed' && a.do === 'tap' && s.do === 'tap') {
      this.steps.push({ n, do: s.do, ms: 0, text: `${a.said} (what step ${n} looks for, named otherwise)` });
      this.log(`step ${n}: ${d.summary} → ${a.said}, as the step`);
      return 'done';
    }
    this.log(`step ${n}: ${d.summary} → ${a.said}, and again`);
    return true;
  }

  // What the screen shows once the steps from `from` on are reached: the element each waits
  // for, through those for a screen that may not come or that are not needed this time, up to
  // the first that must come; at the end of the list, what comes after it (`outer`).
  ahead(steps, from, outer) {
    const out = [];
    for (const s of steps.slice(from)) {
      if (this.notNeeded(s)) continue;
      const t = s.do === 'confirm' ? s.button : ['tap', 'type', 'wait', 'check', 'if_shown'].includes(s.do) ? s.target : null;
      if (!t) return out;
      out.push(t);
      if (s.do !== 'if_shown') return out;
    }
    return [...out, ...outer];
  }

  notNeeded(s) {
    const given = (k) => !!this.routine.values?.[k];
    return (s.only_with && !given(s.only_with)) || (s.only_without && given(s.only_without));
  }

  async step(s, n, ahead = []) {
    const t0 = Date.now();
    const said = s.why ? ` (${s.why})` : '';
    this.onStep({ n, step: s, of: this.routine.steps.length });
    const done = (text) => {
      this.steps.push({ n, do: s.do, ms: Date.now() - t0, text });
      this.log(`${n} ${text}`);
      this.onDone({ n, step: s, text });
    };
    // (`final`: the step may not be tried again, whatever is on the screen.)
    const fail = async (text, { final = false } = {}) => {
      this.steps.push({ n, do: s.do, ms: Date.now() - t0, text, failed: true });
      throw Object.assign(new StepFailed(`Step ${n} failed: ${text}${said}${this.untapped ? `. ${this.untapped}` : ''}`), {
        step: n,
        final,
        shot: await this.shot('failed').catch(() => null),
      });
    };
    switch (s.do) {
      case 'tap': {
        const node = await this.waitFor(s.target, s.wait ?? 10, { retap: true, steady: true });
        if (!node) await fail(`${spoken(s.target)} did not show`);
        if (commits(this.app, { text: labelOf(node) }))
          await fail(`"${labelOf(node)}" books, pays or sends: only the confirmation step may press it`);
        await this.tapNode(node);
        // (Kept for the next step: should what it waits for not come, this tap may have been lost.)
        // (With where it was and what else was on the screen: it is tapped again only on that screen.)
        this.untapped = null;
        this.lastTap =
          s.retry === false
            ? null
            : { target: s.target, at: Date.now(), n: this.steps.length, bounds: node.bounds, labels: labelsOf(this.seen) };
        done(`tapped ${spoken(s.target)}`);
        break;
      }
      case 'type': {
        let field = null;
        if (s.target) {
          field = await this.waitFor(s.target, s.wait ?? 10, { retap: true, steady: true });
          if (!field) await fail(`the field ${spoken(s.target)} did not show`);
          await this.tapNode(field);
          await this.focused(field);
        }
        await this.dev.type(s.text, { had: field?.text?.length ?? 40 });
        // The keyboard the field brought up is closed once the text is in (Back closes only the
        // keyboard): what the app shows next is not then hidden under it. ("keyboard": "keep"
        // for an app that needs it open.)
        const closed = s.keyboard !== 'keep' && (await this.dev.hideKeyboard?.());
        done(`typed "${s.text}"${closed ? ', and closed the keyboard' : ''}`);
        break;
      }
      case 'wait':
        if (!(await this.waitFor(s.target, s.wait ?? 10, { retap: true }))) await fail(`${spoken(s.target)} never showed`);
        done(`${spoken(s.target)} is there`);
        break;
      case 'check': {
        // (Waited for with the text it should have: a field is often drawn before it is filled in.)
        const want = s.text_contains == null ? s.target : { ...s.target, textContains: s.text_contains };
        const node = (await this.waitFor(want, s.wait ?? 5, { retap: true })) ?? find(await this.screen(), s.target)[0] ?? null;
        const text = node ? labelOf(node) : '';
        if (!node || (s.text_contains != null && !text.includes(s.text_contains)))
          await fail(
            `${spoken(s.target)} ${node ? `says "${text}"` : 'is not there'}${s.text_contains != null ? `, not "${s.text_contains}"` : ''}`,
          );
        done(`checked ${spoken(s.target)}: "${text}"`);
        break;
      }
      // The steps that bring something about, unless it is on the screen already (a field that
      // holds the value asked for already): looked at once, before any of them, without waiting.
      case 'unless_shown':
        // (Given a moment to show: a screen that has just opened may still be drawing it.)
        if (await this.waitFor(s.target, s.wait ?? 3)) done(`${spoken(s.target)} is there already: not needed`);
        else {
          done(`${spoken(s.target)} is not there yet`);
          const r = await this.steps_(s.then ?? [], `${n}.`, ahead);
          if (r) return r;
        }
        break;
      case 'if_shown':
        if (await this.waitFor(s.target, s.wait ?? 3, { ahead })) {
          done(`${spoken(s.target)} showed`);
          const r = await this.steps_(s.then ?? [], `${n}.`, ahead);
          if (r) return r;
        } else
          done(`${spoken(s.target)} did not show${this.skippedFor ? ` (${spoken(this.skippedFor)}, of a later step, did)` : ''}: skipped`);
        break;
      case 'choose':
        await this.choose(s, fail, done);
        break;
      case 'scroll': {
        let found = null;
        for (let k = 0; k <= (s.max ?? 5) && !found; k++) {
          found = find(await this.screen(), s.until)[0];
          if (!found) await this.swipeUp(s.direction ?? 'down');
        }
        if (!found) await fail(`${spoken(s.until)} was not found by scrolling`);
        done(`scrolled to ${spoken(s.until)}`);
        break;
      }
      case 'back':
        await this.dev.key('BACK');
        await sleep(SETTLE_MS);
        done('pressed Back');
        break;
      case 'key':
        for (let k = 0; k < (s.times ?? 1); k++) {
          await this.dev.key(s.key);
          await sleep(s.times > 1 ? KEY_GAP_MS : SETTLE_MS);
        }
        done(`pressed ${s.key}${s.times > 1 ? ` ${s.times} times` : ''}`);
        break;
      case 'digits': {
        if (!/^\d{1,6}$/.test(s.number)) await fail(`"${s.number}" is not a number of up to 6 digits`, { final: true });
        await this.dev.shell(`input keyevent ${[...s.number].map((d) => `KEYCODE_${d}`).join(' ')}`);
        await sleep(SETTLE_MS);
        done(`pressed ${s.number}`);
        break;
      }
      case 'focus': {
        // A TV's way to an element: the arrow pressed until the element has the focus.
        const key = s.key ?? 'DPAD_DOWN';
        let k = 0;
        for (; k <= (s.max ?? 10); k++) {
          const hit = find(await this.screen(), s.target)[0];
          if (hit && (hit.focused === 'true' || [...walk(hit)].some((c) => c.focused === 'true'))) break;
          if (k === (s.max ?? 10)) await fail(`${spoken(s.target)} never had the focus after ${k} presses of ${key}`);
          await this.dev.key(key);
          await sleep(KEY_GAP_MS);
        }
        done(`moved to ${spoken(s.target)}${k ? ` (${k} × ${key.replace('DPAD_', '').toLowerCase()})` : ''}`);
        break;
      }
      case 'stop':
        done(`stopped: ${s.say}`);
        throw Object.assign(new Stopped(s.say), { step: n });
      case 'close_app':
        await this.dev.stopApp(this.routine.app);
        done(`closed ${this.routine.app}`);
        break;
      case 'confirm':
        return this.confirm(s, fail, done);
    }
    return null;
  }

  // The app's own screens after the press, until its last one: the one the routine names
  // (`result.shows`, or any one of those it names), else the first that stays the same for a few seconds (and, for a routine
  // that does not say, that a model takes for the last one). Only the app's own screen counts,
  // not a notification over it; a screen the routine names as one it shows while still working
  // (`result.waiting`) is waited past; and the named one is taken once it has stayed the same
  // for a few seconds (a banner can carry its words while the screen under it is still the old
  // one). → { shot, values, words, shown, seconds, changed, judged }: `shown` is whether the
  // named one came, `changed` whether the screen moved on from the confirmation screen at all.
  async afterPress(s, pressed) {
    const r = s.result ?? {};
    const signs = signsOf(r.shows);
    const holds = signsOf(r.waiting);
    const t0 = Date.now();
    const until = t0 + (r.wait ?? (r.shows ? NAMED_RESULT_WAIT_S : RESULT_WAIT_S)) * 1000;
    // (Its words without numbers: a clock or a count on a waiting screen is not a new screen.)
    const looks = (root) => JSON.stringify(elements(root).map((e) => [e.text, e.description].map((w) => w?.replace(/\d/g, ''))));
    const first = looks(appOnly(pressed, this.routine.app));
    let from = first; // (a screen it has moved on from)
    let last = null;
    let since = t0;
    let tell = t0 + STILL_WAITING_MS;
    let shown = r.shows ? false : null;
    let judged = null;
    let asked = 0;
    let came = null; // (when the named screen showed, while it is still being drawn)
    let root;
    this.onWait(0);
    for (;;) {
      root = appOnly(await this.screen(), this.routine.app);
      const now = looks(root);
      if (now !== last) [last, since] = [now, Date.now()];
      const working = holds.some((t) => find(root, t).length);
      if (!working && signs.some((t) => find(root, t).length)) {
        came ??= Date.now();
        if (Date.now() - since >= this.steadyMs || Date.now() - came >= DONE_SETTLE_MS) {
          shown = true;
          break;
        }
      } else came = null;
      if (!r.shows && !working && now !== from && Date.now() - since >= this.steadyMs) {
        if (!this.judge || asked >= MAX_JUDGED) break;
        asked++;
        const small = await this.dev
          .screenshot(path.join(this.media, `${this.routine.name}-after-${Date.now()}.jpg`), { longEdge: MODEL_PICTURE })
          .catch(() => null);
        judged = await this.judge({ els: elements(root), shot: small });
        if (!judged || judged.final) break;
        this.log(`after the press: ${judged.summary}`);
        from = now; // (not its last screen yet: the next one is waited for)
      }
      if (Date.now() > until) {
        shown = r.shows ? came != null : shown;
        break;
      }
      if (Date.now() > tell) {
        tell += STILL_WAITING_MS;
        this.onWait(Math.round((Date.now() - t0) / 1000));
      }
      await sleep(came ? POLL_MS * 2 : Math.min(1000, this.steadyMs / 3));
    }
    const els = elements(root);
    const shot = await this.shot('after').catch(() => null);
    const out = {
      shot,
      values: r.read ? this.readValues(root, r.read) : {},
      words: headline(els),
      shown,
      changed: looks(root) !== first,
      seconds: Math.round((Date.now() - t0) / 1000),
      judged,
    };
    this.log(
      `after the press, ${out.seconds}s: ${shown === false ? `${spokenAny(r.shows)} did not show; ` : ''}${out.words.slice(0, 3).join(' · ')}`,
    );
    return out;
  }

  async swipeUp(direction) {
    const root = await this.screen();
    const [w, h] = [root.children[0]?.bounds[2] ?? 1080, root.children[0]?.bounds[3] ?? 2000];
    if (direction === 'up') await this.dev.swipe(w / 2, h * 0.3, w / 2, h * 0.7);
    else await this.dev.swipe(w / 2, h * 0.7, w / 2, h * 0.3);
    await sleep(SETTLE_MS);
  }

  // An option that is usually already chosen: tapped only when another one is. Which is
  // chosen is read from the screen: "selected" or "checked", or, for an app that reports
  // neither, the one drawn larger than the rest ("larger").
  async choose(s, fail, done) {
    const root = await this.screen();
    const want = find(root, s.option)[0];
    if (!want) await fail(`the option ${spoken(s.option)} is not shown`);
    const shown = s.options.map((o) => find(root, o)[0]).filter(Boolean);
    const by = s.chosen_by ?? 'selected';
    const isChosen = (node) => {
      if (by === 'larger') {
        const size = (x) => (x.bounds[2] - x.bounds[0]) * (x.bounds[3] - x.bounds[1]);
        return shown.every((o) => o === node || size(o) < size(node));
      }
      const attr = by === 'checked' ? 'checked' : 'selected';
      return node[attr] === 'true' || [...walk(node)].some((c) => c[attr] === 'true');
    };
    if (isChosen(want)) return done(`${spoken(s.option)} was already chosen`);
    await this.tapNode(want);
    done(`chose ${spoken(s.option)}`);
  }

  readValues(root, spec = {}) {
    const texts = [...walk(root)].filter((n) => n.text);
    const out = {};
    for (const [name, how] of Object.entries(spec)) {
      let v = null;
      const re = how.pattern ? new RegExp(how.pattern) : null;
      const pick = (t) => (re ? (re.exec(t)?.[0] ?? null) : t);
      if (how.row_of) {
        const a = find(root, how.row_of)[0];
        if (a) {
          const top = a.bounds[1];
          for (const n of texts) if (!v && n.bounds[1] >= top - 40 && n.bounds[1] <= top + 140) v = pick(n.text);
        }
      } else if (how.after) {
        const a = find(root, how.after)[0];
        const i = a ? texts.indexOf(a) : -1;
        if (i >= 0 && texts[i + (how.next ?? 1)]) v = pick(texts[i + (how.next ?? 1)].text);
      } else if (how.target) {
        const a = find(root, how.target)[0];
        if (a) v = pick(labelOf(a));
      }
      out[name] = v ? asLetters(v).replace(/\s+/g, ' ').trim() : null;
    }
    return out;
  }

  async confirm(s, fail, done) {
    const button = await this.waitFor(s.button, s.wait ?? 15, { retap: true });
    const root = await this.screen();
    const missing = (s.must_show ?? []).filter((t) => !find(root, t).length);
    if (!button || missing.length)
      await fail(
        `this is not the confirmation screen: ${button ? '' : `${spoken(s.button)} is not there`}${missing.length ? `${button ? '' : '; '}missing ${missing.map(spoken).join(', ')}` : ''}`,
      );
    const values = this.readValues(root, s.read);
    const shot = await this.shot('confirm');
    done(`at the confirmation screen (${Math.round((Date.now() - this.started) / 1000)}s)`);
    const reply = await this.answer({ values, shot, routine: this.routine, seconds: Math.round((Date.now() - this.started) / 1000) });
    if (reply === 'confirm') {
      // Looked for again: the screen may have moved on while the owner was reading.
      const again = await this.waitFor(s.button, 5);
      if (!again) await fail('the button was gone when the answer came: nothing was pressed', { final: true });
      const pressed = await this.screen();
      await this.tapNode(again);
      done(`pressed ${spoken(s.button)}, on the owner's word`);
      const after = await this.afterPress(s, pressed);
      return { outcome: 'confirmed', values, shot, after };
    }
    done(
      { timeout: 'no answer in time: not pressed', declined: 'declined by itself (--dry): not pressed' }[reply] ?? 'cancelled: not pressed',
    );
    await this.steps_(s.cancel?.length ? s.cancel : [{ do: 'close_app' }], 'cancel ');
    return { outcome: reply === 'timeout' ? 'expired' : 'cancelled', values, shot };
  }
}
