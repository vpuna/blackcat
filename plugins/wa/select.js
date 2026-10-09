import {
  agoShort as ago,
  countChats,
  listChats,
  openArchive as open,
  openArchiveForWriting as openWrite,
  prompts,
  sourceSql,
  withDb,
} from '../../src/api.js';

const { askDays, orExit } = await prompts();
export { askDays };
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { cutoff, saveWaSettings, waSettings } from './settings.js';

const PAGE = 50;

// Page through chats (most recent first), 50 at a time, keeping picks across pages.
async function pickChats(db, since, preselected) {
  const total = countChats(db, { since, source: 'wa' });
  if (!total) {
    p.log.warn('No chats with activity in that period yet.');
    return [];
  }
  const chosen = new Set(preselected);
  let offset = 0;
  for (;;) {
    const rows = listChats(db, { since, limit: PAGE, offset, source: 'wa' });
    const picked = orExit(
      await p.multiselect({
        message: `Pick chats to keep · ${offset + 1}–${offset + rows.length} of ${total}, most recent first`,
        options: rows.map((r) => ({
          value: r.ref,
          label: r.name,
          hint: [r.isGroup ? 'group' : null, ago(r.last), `${r.stored} msgs`].filter(Boolean).join(' · '),
        })),
        initialValues: rows.filter((r) => chosen.has(r.ref)).map((r) => r.ref),
        required: false,
        maxItems: 15,
      }),
    );
    for (const r of rows) chosen.delete(r.ref);
    for (const j of picked) chosen.add(j);

    const nav = [{ value: 'done', label: `Done · ${chosen.size} chat${chosen.size === 1 ? '' : 's'} picked` }];
    if (offset + PAGE < total) nav.push({ value: 'next', label: `Next ${Math.min(PAGE, total - offset - PAGE)} chats` });
    if (offset > 0) nav.push({ value: 'prev', label: 'Previous page' });
    const go = nav.length === 1 ? 'done' : orExit(await p.select({ message: 'Next?', options: nav }));
    if (go === 'done') return [...chosen];
    offset += go === 'next' ? PAGE : -PAGE;
  }
}

// Returns true if settings were saved.
// `days` is passed when the caller (bc wa pair) already asked for it.
export async function select({ standalone = true, days } = {}) {
  if (standalone) p.intro(pc.bgGreen(pc.black(' blackcat · WhatsApp chats ')));
  const w = waSettings();
  days ??= await askDays(w.days ?? 30);
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const mode = orExit(
    await p.select({
      message: 'Which chats?',
      initialValue: w.mode ?? w.lastMode ?? 'selected',
      options: [
        { value: 'all', label: `All chats active in the last ${days} days`, hint: 'new chats are included automatically' },
        { value: 'selected', label: 'Only chats I pick', hint: 'most recent first, 50 per page' },
      ],
    }),
  );
  const chats = mode === 'selected' ? await withDb(open, (db) => pickChats(db, since, w.chats ?? [])) : [];

  const next = { days, mode, chats, selectedAt: new Date().toISOString() };
  const doomed = withDb(openWrite, (wdb) => countDoomed(wdb, next));
  const summary = mode === 'all' ? `all chats, last ${days} days` : `${chats.length} chats, last ${days} days`;
  const ok = orExit(
    await p.confirm({
      message: doomed ? `Keep ${summary}? ${doomed} stored messages outside this will be deleted.` : `Keep ${summary}?`,
    }),
  );
  if (!ok) {
    p.cancel('Nothing changed');
    return false;
  }

  saveWaSettings(next);
  withDb(openWrite, (wdb) => prune(wdb, next));
  p.log.success(`Saved. The service applies this straight away.`);
  if (mode === 'selected') {
    p.log.info(pc.dim('Chats you add later only collect new messages from then on.'));
  }
  if (standalone) p.outro('Done');
  return true;
}

function outsideClause(w) {
  const params = { cutoff: cutoff(w) };
  let sql = 'ts < @cutoff';
  if (w.mode === 'selected') {
    const list = w.chats.map((_, i) => `@c${i}`).join(', ');
    w.chats.forEach((j, i) => (params[`c${i}`] = j));
    sql += list ? ` OR chat_ref NOT IN (${list})` : ' OR 1';
  }
  // Only ever WhatsApp rows: this selection must not touch messages from other sources.
  return { sql: `(${sql}) AND ${sourceSql('chat_ref', 'wa')}`, params };
}

export function countDoomed(db, w) {
  const { sql, params } = outsideClause(w);
  return db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${sql}`).get(params).n;
}

export function prune(db, w) {
  const { sql, params } = outsideClause(w);
  db.prepare(`DELETE FROM messages WHERE ${sql}`).run(params);
  db.pragma('wal_checkpoint(TRUNCATE)');
}
