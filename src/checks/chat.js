// Checks in the chat: /check lists them with how each is doing; a check's card says what it
// looks at and offers to look now or to pause it.
import { checkText, runCheck, stateText } from './check.js';
import { getCheck, incidents, listChecks, openChecksDb, updateCheck } from './db.js';
import { actions, describeSchedule, errMsg, esc, fmtWhen, log } from '../internal.js';
import { withDb } from '../db.js';

const mark = (c) => (!c.active ? '⏸' : c.state?.status === 'failing' ? '⚠️' : c.state?.checked ? '✅' : '❔');

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
          const past = incidents(db, k.id, 15);
          return c.reply(
            past.length
              ? [
                  `📋 <b>${esc(k.name)}</b>: what went wrong, most recent first`,
                  '',
                  ...past.map((p) => `• <i>${esc(fmtWhen(p.ts))}</i> ${esc(p.title)}${p.open ? ' <b>(still so)</b>' : ''}`),
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
        return c.reply([`${head} ${r.result.reason}`, ...r.notices].join('\n\n'));
      } catch (e) {
        log(`check ${id}: ${errMsg(e)}`);
        return c.reply(`That did not work: ${errMsg(e)}`).catch(() => {});
      }
    });
  });
}

// For the daily briefing: what is not working, and one line to say so when all is well.
// → { problems: [html], fine: html | null }
export function forBriefing() {
  return withDb(openChecksDb, (db) => {
    const all = listChecks(db, { activeOnly: true });
    const bad = all.filter((c) => c.state?.status === 'failing');
    return {
      problems: bad.map((c) => `⚠️ <b>${esc(c.name)}</b>: not working since ${esc(fmtWhen(c.state.since))}. ${esc(c.state.reason ?? '')}`),
      fine: all.length && !bad.length ? `✅ ${all.length === 1 ? esc(all[0].name) : `All ${all.length} checks`}: fine` : null,
    };
  });
}
