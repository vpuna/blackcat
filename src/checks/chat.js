// Checks in the chat: /check lists them with how each is doing; a check's card says what it
// looks at and offers to look now or to pause it.
import { checkText, lasted, runCheck, stateText } from './check.js';
import { currentFindings, getCheck, getFinding, listChecks, openChecksDb, pastFindings, updateCheck } from './db.js';
import { actions, describeSchedule, errMsg, esc, fmtWhen, log } from '../internal.js';
import { withDb } from '../db.js';

const mark = (c) => (!c.active ? '⏸' : c.wrong?.open ? '⚠️' : c.wrong ? '😴' : c.state?.checked ? '✅' : '❔');
const cmds = () => import('./commands.js');

// The buttons under an alert, or a finding's card: snooze, "I fixed it", and its fix again.
export function findingButtons(id, fix) {
  const kb = actions().add('😴 Snooze', `cf:${id}:s`).add('🛠 I fixed it', `cf:${id}:x`);
  if (fix) kb.row().add('🔁 Try the fix again', `cf:${id}:r`);
  return kb;
}
const SNOOZES = [
  ['1 hour', 's1', { for: '1h' }],
  ['4 hours', 's4', { for: '4h' }],
  ['Until tomorrow morning', 'sm', {}],
  ['Until it works again', 'sf', { untilFixed: true }],
];
const findingCard = (k, f) =>
  [
    `🩺 <b>${esc(k.name)}</b>: ${f.state === 'resolved' ? 'working again' : 'not working'}`,
    esc(f.title),
    `<i>since ${esc(fmtWhen(f.first_seen))}${f.times > 1 ? `, found ${f.times} times` : ''}${f.state === 'snoozed' ? ` · snoozed ${f.snoozed_until ? `until ${esc(fmtWhen(f.snoozed_until))}` : 'until it works again'}` : ''}${f.fix_note ? ` · ${esc(f.fix_note)}` : ''}</i>`,
  ].join('\n');

function card(c) {
  return {
    text: [
      `🩺 <b>${esc(c.name)}</b>${c.active ? '' : ' · ⏸ paused'}`,
      `<b>Looks at:</b> ${esc(checkText(c))}`,
      ...(c.look_for ? [`<b>Working means:</b> ${esc(c.look_for)}`] : []),
      `<b>Looks:</b> ${esc(describeSchedule(c.every).replace(/^./, (x) => x.toLowerCase()))}`,
      `<b>State:</b> ${esc(stateText(c))}`,
      'Tells you when it stops working, is fixed, or recovers.',
    ].join('\n'),
    keyboard: actions()
      .add('🔄 Look now', `ck:${c.id}:c`)
      .add(c.active ? '⏸ Pause' : '▶️ Resume', `ck:${c.id}:p`)
      .row()
      .add('📋 What went wrong', `ck:${c.id}:l`),
  };
}

// /check: every check with how it is doing, and a button for each.
export async function showChecks(c) {
  return withDb(openChecksDb, (db) => {
    const mine = listChecks(db).filter((x) => x.chat_id === c.chat);
    if (!mine.length)
      return c.reply(
        'No checks yet. Ask me to keep an eye on something ("tell me if the camera stops working"), or set one up with <code>bc check add</code>.',
        { html: true },
      );
    if (mine.length === 1) {
      const one = card(mine[0]);
      return c.reply(one.text, { html: true, actions: one.keyboard });
    }
    const kb = actions();
    mine.forEach((x, n) => {
      kb.add(`${n + 1}. ${x.name}`.slice(0, 40), `ck:${x.id}:o`);
      if (n % 2 === 1) kb.row();
    });
    return c.reply(
      ['🩺 <b>Your checks</b>', '', ...mine.map((x, n) => `${n + 1}. ${mark(x)} <b>${esc(x.name)}</b> · ${esc(stateText(x))}`)].join('\n'),
      { html: true, actions: kb },
    );
  });
}

export function installChecks(ui) {
  // A finding: snooze it, say it is fixed, or run the fix again.
  ui.action(/^cf:(\d+):(o|s|s1|s4|sm|sf|x|r)$/, async (c) => {
    const [, id, what] = c.match;
    return withDb(openChecksDb, async (db) => {
      try {
        const f = getFinding(db, Number(id));
        const k = f && getCheck(db, f.check_id);
        if (!k || k.chat_id !== c.chat) return c.toast('That is no longer there.');
        const { lookAgain, fixNow, snoozeEnd, snoozeIds, untilText } = await cmds();
        if (what === 'o') {
          await c.toast();
          return c.reply(findingCard(k, f), { html: true, ...(f.state !== 'resolved' ? { actions: findingButtons(f.id, !!k.fix) } : {}) });
        }
        if (f.state === 'resolved' && what !== 'x') return c.toast('It is working again.');
        if (what === 's') {
          await c.toast();
          const kb = actions();
          SNOOZES.forEach(([label, code]) => kb.add(label, `cf:${f.id}:${code}`).row());
          return c.reply(`😴 Snooze "${k.name}" for how long?`, { actions: kb });
        }
        if (what.startsWith('s')) {
          const until = snoozeEnd(SNOOZES.find((x) => x[1] === what)[2]);
          snoozeIds(db, [f.id], until);
          await c.toast('Snoozed');
          return c.edit(`😴 ${k.name}: snoozed ${untilText(until)}. I'll tell you when it works again.`).catch(() => {});
        }
        await c.toast('Looking…');
        await c.clearActions().catch(() => {});
        await c.working().catch(() => {});
        const r =
          what === 'r'
            ? await fixNow(db, k)
            : await lookAgain(db, k, { fixed: [f], onWait: (s) => c.reply(`⏳ Still not working; looking again in ${lasted(s)}…`) });
        if (r.result.ok === false) {
          const still = currentFindings(db, k.id)[0];
          return c.reply(
            `✗ ${k.name}: still not working. ${r.result.reason}${what === 'r' ? '' : '\nIf it needs more time, snooze it, and you will be told when it works.'}`,
            still ? { actions: findingButtons(still.id, !!k.fix) } : {},
          );
        }
        return c.reply(r.notices.length ? r.notices.map((n) => n.text).join('\n\n') : `✅ ${k.name}: working. ${r.result.reason}`);
      } catch (e) {
        log(`check finding ${id}: ${errMsg(e)}`);
        return c.reply(`That did not work: ${errMsg(e)}`).catch(() => {});
      }
    });
  });

  // The ui's middleware has already checked this is a paired account in a private chat.
  ui.action(/^ck:(\d+):([oclp])$/, async (c) => {
    const [, id, what] = c.match;
    return withDb(openChecksDb, async (db) => {
      try {
        let k = getCheck(db, Number(id));
        if (!k || k.chat_id !== c.chat) return c.toast('That check no longer exists.');
        if (what === 'o') {
          await c.toast();
          const one = card(k);
          return c.reply(one.text, { html: true, actions: one.keyboard });
        }
        if (what === 'l') {
          await c.toast();
          const past = pastFindings(db, k.id, 15);
          return c.reply(
            past.length
              ? [
                  `📋 <b>${esc(k.name)}</b>: what went wrong, most recent first`,
                  '',
                  ...past.map(
                    (p) =>
                      `• <i>${esc(fmtWhen(p.first_seen))}</i> ${esc(p.title)}${p.state === 'open' ? ' <b>(still so)</b>' : p.state === 'snoozed' ? ' <b>(still so, snoozed)</b>' : p.resolved_ts ? ` <i>(over after ${esc(lasted(p.resolved_ts - p.first_seen))})</i>` : ''}`,
                  ),
                ]
                  .join('\n')
                  .slice(0, 4000)
              : `Nothing has gone wrong with "${esc(k.name)}" since it was set up.`,
            { html: true },
          );
        }
        if (what === 'p') {
          k = updateCheck(db, k.id, { active: !k.active });
          await c.toast(k.active ? 'Resumed' : 'Paused');
          const one = card(k);
          return c.edit(one.text, { html: true, actions: one.keyboard }).catch(() => {});
        }
        // 'c': look now. This can take a little while, so answer first.
        await c.toast('Looking…');
        await c.working().catch(() => {});
        updateCheck(db, k.id, { last_run: Math.floor(Date.now() / 1000) });
        const r = await runCheck(db, k);
        const head = r.result.ok === true ? '✅ Working.' : r.result.ok === false ? '⚠️ Not working.' : '❔ Could not tell.';
        return c.reply([`${head} ${r.result.reason}`, ...r.notices.map((n) => n.text)].join('\n\n'));
      } catch (e) {
        log(`check ${id}: ${errMsg(e)}`);
        return c.reply(`That did not work: ${errMsg(e)}`).catch(() => {});
      }
    });
  });
}

// For the daily briefing: what is not working (snoozed or not), a button for each that is
// not snoozed, and one line to say so when all is well.
// → { problems: [html], fine: html | null, buttons: [{ label, id }] }
export function forBriefing() {
  return withDb(openChecksDb, (db) => {
    const all = listChecks(db, { activeOnly: true });
    const problems = [];
    const buttons = [];
    for (const c of all.filter((x) => x.wrong))
      for (const f of currentFindings(db, c.id)) {
        const many = c.wrong.open + c.wrong.snoozed > 1;
        problems.push(
          `${f.state === 'open' ? '⚠️' : '😴'} <b>${esc(c.name)}</b>: not working since ${esc(fmtWhen(f.first_seen))}${f.state === 'snoozed' ? ' (snoozed)' : ''}. ${esc(f.title)}`,
        );
        if (f.state === 'open') buttons.push({ label: `🩺 ${c.name}${many ? `: ${f.title}` : ''}`.slice(0, 40), id: `cf:${f.id}:o` });
      }
    return {
      problems,
      fine: all.length && !problems.length ? `✅ ${all.length === 1 ? esc(all[0].name) : `All ${all.length} checks`}: fine` : null,
      buttons,
    };
  });
}
