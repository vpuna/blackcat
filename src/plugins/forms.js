// A form is a list of questions. Declaring them as data, rather than writing prompt
// code, is what lets the same setup run in the terminal and in the Telegram bot.
//
//   { id: 'host', type: 'text', message: 'Address', default: '…', validate: (v, answers) => 'problem' | undefined,
//     when: (answers) => boolean }
//
// Types:
//   text     a line of text
//   secret   a line of text that is never echoed, logged, or shown to the agent.
//            `keep: true` when the answer is stored with ctx.secrets under the question's id
//            (or `keep: (answers, ctx) => boolean` to say yourself whether one is saved):
//            when one is saved the question says so, and an empty answer keeps it. The
//            command is then given '' for it, and must leave the saved one alone.
//   select   one of `options: [{ value, label, hint? }]`
//   confirm  yes / no
//   browse   pick a folder by walking through folders: go into one, go up, make a new one.
//            `list: async (dir, answers, ctx) => [names]` gives a folder's sub-folders,
//            `create: async (dir, answers, ctx)` makes one (leave it out to forbid that),
//            `start` is where to begin. The folders can be anywhere: another machine, say.
//   note     no answer: just shows `message` (use for instructions)
//
// `help: 'text'` on a question: what `bc <plugin> <command> --help` says of its option (the
// values it takes, say), when the question as asked would not read well there.
//
// `sticky: true` on a question: given as an option it is set; left out, away from a terminal,
// it stays as it is (its `default`). For something rarely changed, so that it need not be
// repeated whenever another answer is.

export const TYPES = ['text', 'secret', 'select', 'confirm', 'browse', 'note'];

// A value given up front (as a command-line option) that a question would have rejected.
export class FormError extends Error {}

export function validateSteps(steps) {
  const out = [];
  if (!Array.isArray(steps)) return ['must be a list of steps'];
  const ids = new Set();
  steps.forEach((s, i) => {
    const at = `step ${i + 1}${s?.id ? ` (${s.id})` : ''}`;
    if (!s || typeof s !== 'object') return out.push(`${at} must be an object`);
    if (!TYPES.includes(s.type)) out.push(`${at}: type must be one of ${TYPES.join(', ')}`);
    if (typeof s.message !== 'string' && typeof s.message !== 'function') out.push(`${at}: message is required`);
    if (s.type !== 'note') {
      if (typeof s.id !== 'string' || !/^[a-z][a-zA-Z0-9]*$/.test(s.id)) out.push(`${at}: id must be a camelCase name`);
      else if (ids.has(s.id)) out.push(`${at}: id is used twice`);
      ids.add(s.id);
    }
    if (s.type === 'select' && typeof s.options !== 'function' && !(Array.isArray(s.options) && s.options.length))
      out.push(`${at}: select needs options`);
    if (s.type === 'browse' && typeof s.list !== 'function') out.push(`${at}: browse needs a list function`);
  });
  return out;
}

const resolve = (v, ...args) => (typeof v === 'function' ? v(...args) : v);

export const messageOf = (step, answers, ctx) => resolve(step.message, answers, ctx);
export const optionsOf = (step, answers, ctx) => resolve(step.options, answers, ctx) ?? [];
export const defaultOf = (step, answers, ctx) => resolve(step.default, answers, ctx);
export const applies = (step, answers, ctx) => !step.when || !!step.when(answers, ctx);
// Is there a secret already saved for this question, that an empty answer would keep?
export function savedOf(step, answers, ctx) {
  if (step.type !== 'secret' || !step.keep) return false;
  try {
    return typeof step.keep === 'function' ? !!step.keep(answers, ctx) : !!ctx?.secrets?.has(step.id);
  } catch {
    return false;
  }
}
export const KEEP_HINT = 'one is saved: leave this empty to keep it';

// Check one answer. Returns { value } or { error }.
export function check(step, raw, answers, ctx) {
  let value = raw;
  if (step.type === 'text' || step.type === 'secret' || step.type === 'browse') {
    value = String(raw ?? '').trim();
    // Nothing given: what is set now (or the usual) stands. But an optional answer that was
    // deliberately emptied is empty: that is how something optional is cleared.
    if (!value && defaultOf(step, answers, ctx) != null && !(step.optional && raw != null)) value = String(defaultOf(step, answers, ctx));
    if (!value && savedOf(step, answers, ctx)) return { value: '' }; // keep the one that is saved
    if (!value && !step.optional) return { error: 'This is needed.' };
  } else if (step.type === 'select') {
    const opt = optionsOf(step, answers, ctx).find((o) => String(o.value) === String(raw));
    if (!opt)
      return {
        error: `Choose one of: ${optionsOf(step, answers, ctx)
          .map((o) => o.value)
          .join(', ')}`,
      };
    value = opt.value;
  } else if (step.type === 'confirm') {
    if (typeof raw !== 'boolean') {
      const s = String(raw).toLowerCase();
      if (['y', 'yes', 'true', '1'].includes(s)) value = true;
      else if (['n', 'no', 'false', '0'].includes(s)) value = false;
      else return { error: 'Answer yes or no.' };
    }
  }
  const problem = step.validate?.(value, answers, ctx);
  return problem ? { error: problem } : { value };
}

// The questions that still have to be asked, given the answers already supplied as options.
// Questions skipped by their `when` don't count.
export function unanswered(steps, preset = {}, ctx) {
  const answers = {};
  const out = [];
  for (const step of steps) {
    if (step.type === 'note' || !applies(step, answers, ctx)) continue;
    if (preset[step.id] === undefined) out.push(step);
    else answers[step.id] = check(step, preset[step.id], answers, ctx).value ?? preset[step.id];
  }
  return out;
}

// Folder paths, for the browse question.
export const joinPath = (dir, name) => `${dir.replace(/\/+$/, '')}/${name}`;
export const parentPath = (dir) => dir.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/';
export const folderName = (v) =>
  /^[^/\0'"\\]{1,80}$/.test(String(v).trim()) && !/^\.+$/.test(String(v).trim()) ? undefined : 'A plain folder name, without / or quotes';
// Where browsing starts: the given place if it can be listed, otherwise the top.
export async function browseStart(step, answers, ctx) {
  const start = String(resolve(step.start, answers, ctx) ?? '/') || '/';
  try {
    return { dir: start, entries: await step.list(start, answers, ctx) };
  } catch {
    return { dir: '/', entries: await step.list('/', answers, ctx) };
  }
}

// Walk through folders in the terminal until one is chosen. → the path, or null if cancelled.
async function browseInTerminal(p, step, message, answers, ctx) {
  let { dir, entries } = await browseStart(step, answers, ctx);
  // Each move would otherwise leave its own answered question on screen, so that browsing
  // three folders deep looks like three questions. The finished prompt is wiped after each
  // move, and one line is written at the end.
  const wipe = (text) => {
    if (!process.stdout.isTTY) return;
    const cols = process.stdout.columns || 80;
    const rows = text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil((l.length + 3) / cols)), 0) + 2; // + the answer and the spacer
    process.stdout.write(`\x1b[${rows}A\x1b[J`);
  };
  for (;;) {
    const prompt = `${message}\n  now in: ${dir}   (↑↓ to move, Enter to choose)`;
    const choice = await p.select({
      message: prompt,
      maxItems: 14,
      options: [
        { value: '\0use', label: `✓ Use this folder`, hint: dir },
        ...(dir !== '/' ? [{ value: '\0up', label: '↑ Go up', hint: parentPath(dir) }] : []),
        ...(step.create ? [{ value: '\0new', label: '+ Make a new folder here', hint: `inside ${dir}` }] : []),
        { value: '\0type', label: '⌨ Type a path' },
        ...entries.map((n) => ({ value: n, label: `📁 ${n}` })),
      ],
    });
    if (p.isCancel(choice)) return null;
    wipe(prompt);
    if (choice === '\0use') {
      const r = check(step, dir, answers, ctx);
      if (!r.error) {
        p.log.step(`${message}\n${r.value}`);
        return r.value;
      }
      p.log.warn(r.error);
      continue;
    }
    let next = dir;
    if (choice === '\0up') next = parentPath(dir);
    else if (choice === '\0new') {
      const name = await p.text({ message: `Name of the new folder in ${dir}`, validate: folderName });
      if (p.isCancel(name)) continue;
      next = joinPath(dir, name.trim());
      try {
        await step.create(next, answers, ctx);
      } catch (e) {
        p.log.warn(`Could not make it: ${e.message}`);
        continue;
      }
    } else if (choice === '\0type') {
      const typed = await p.text({
        message: 'The full path',
        initialValue: dir,
        validate: (v) => (String(v).startsWith('/') ? undefined : 'A full path, starting with /'),
      });
      if (p.isCancel(typed)) continue;
      next = typed.trim().replace(/(.)\/+$/, '$1');
    } else next = joinPath(dir, choice);
    try {
      entries = await step.list(next, answers, ctx);
      dir = next;
    } catch (e) {
      p.log.warn(`Can't open ${next}: ${e.message}`);
    }
  }
}

// Ask the questions in the terminal. `preset` holds answers already given as options.
// Returns the answers, or null if the person cancelled.
export async function runInTerminal(steps, preset = {}, ctx) {
  const p = await import('@clack/prompts');
  const answers = {};
  const asking = unanswered(steps, preset, ctx).length > 0; // notes are only shown alongside questions
  for (const step of steps) {
    if (!applies(step, answers, ctx)) continue;
    const message = messageOf(step, answers, ctx);
    if (step.type === 'note') {
      if (asking) p.note(message);
      continue;
    }
    if (preset[step.id] !== undefined) {
      const r = check(step, preset[step.id], answers, ctx);
      if (r.error) throw new FormError(`${step.id}: ${r.error}`);
      answers[step.id] = r.value;
      continue;
    }
    const validate = (v) => check(step, v, answers, ctx).error;
    const def = defaultOf(step, answers, ctx);
    let raw;
    if (step.type === 'browse') {
      const picked = await browseInTerminal(p, step, message, answers, ctx);
      if (picked == null) return null;
      answers[step.id] = picked;
      continue;
    }
    if (step.type === 'text') raw = await p.text({ message, initialValue: def != null ? String(def) : undefined, validate });
    else if (step.type === 'secret')
      raw = await p.password({ message: savedOf(step, answers, ctx) ? `${message} (${KEEP_HINT})` : message, validate });
    else if (step.type === 'confirm') raw = await p.confirm({ message, initialValue: def ?? true });
    else
      raw = await p.select({
        message,
        options: optionsOf(step, answers, ctx).map((o) => ({ value: o.value, label: o.label ?? String(o.value), hint: o.hint })),
        initialValue: def,
      });
    if (p.isCancel(raw)) return null;
    answers[step.id] = check(step, raw, answers, ctx).value;
  }
  return answers;
}
