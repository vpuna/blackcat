import {
  agoShort as ago,
  countChats,
  listChats,
  openArchive as open,
  openArchiveForWriting as openWrite,
  plural,
  prompts,
  recordActivity,
  sourceSql,
  withDb,
} from '../../src/api.js';

const { askDays, orExit } = await prompts();
export { askDays };
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { saveWaSettings, waSettings } from './settings.js';

const PAGE = 50;

// Page through chats (most recent first), 50 at a time, keeping picks across pages.
async function pickChats(db, since, preselected, what = 'to collect') {
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
        message: `Pick chats ${what} · ${offset + 1}–${offset + rows.length} of ${total}, most recent first`,
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

    const nav = [{ value: 'done', label: `Done · ${plural(chosen.size, 'chat')} picked` }];
    if (offset + PAGE < total) nav.push({ value: 'next', label: `Next ${Math.min(PAGE, total - offset - PAGE)} chats` });
    if (offset > 0) nav.push({ value: 'prev', label: 'Previous page' });
    const go = nav.length === 1 ? 'done' : orExit(await p.select({ message: 'Next?', options: nav }));
    if (go === 'done') return [...chosen];
    offset += go === 'next' ? PAGE : -PAGE;
  }
}

// Returns true if settings were saved. Nothing stored is deleted for the days: they say how far
// back history is fetched, and what is kept stays. A chat no longer collected keeps what it has,
// unless the owner says to delete it. More days than before are fetched by linking again, which
// is offered (`relink`, called with the days, is bc wa pair's).
// `days` is passed when the caller (bc wa pair) already asked for it.
export async function select({ standalone = true, days, relink = null } = {}) {
  if (standalone) p.intro(pc.bgGreen(pc.black(' blackcat · WhatsApp chats ')));
  const w = waSettings();
  days ??= await askDays(w.days ?? 30);
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const mode = orExit(
    await p.select({
      message: 'Which chats?',
      initialValue: w.mode ?? w.lastMode ?? 'selected',
      options: [
        { value: 'all', label: 'All chats', hint: 'new chats are included automatically' },
        { value: 'selected', label: 'Only chats I pick', hint: 'most recent first, 50 per page' },
      ],
    }),
  );
  const chats = mode === 'selected' ? await withDb(open, (db) => pickChats(db, since, w.chats ?? [])) : [];
  // With all chats: any single ones left out (a bot or a group nobody needs read). With only
  // some picked, none is.
  const was = w.mode === 'selected' ? [] : (w.exclude ?? []);
  const leaveOut =
    mode === 'all' &&
    orExit(
      await p.confirm({
        message: `Leave any chats out?${was.length ? ` (${was.length} left out now)` : ''}`,
        initialValue: was.length > 0,
      }),
    );
  const exclude = leaveOut ? await withDb(open, (db) => pickChats(db, since, was, 'to leave out')) : [];

  const next = { days, mode, chats, exclude, selectedAt: new Date().toISOString() };
  const summary =
    mode === 'all'
      ? `all chats${exclude.length ? ` but ${plural(exclude.length, 'chat')}` : ''}, ${days} days of history`
      : `${plural(chats.length, 'chat')}, ${days} days of history`;
  const ok = orExit(await p.confirm({ message: `Collect ${summary}? What is stored is kept.` }));
  if (!ok) {
    p.cancel('Nothing changed');
    return false;
  }
  // Chats no longer collected: what they have is kept, unless the owner says otherwise.
  const left = withDb(openWrite, (wdb) => countOutside(wdb, next, w));
  const wipe =
    left.messages > 0 &&
    orExit(
      await p.select({
        message: `${plural(left.chats, 'chat')} you no longer collect ${left.chats === 1 ? 'has' : 'have'} ${plural(left.messages, 'stored message')}.`,
        initialValue: 'keep',
        options: [
          { value: 'keep', label: 'Keep them', hint: 'still searchable; nothing new is added' },
          { value: 'delete', label: 'Delete them' },
        ],
      }),
    ) === 'delete';

  const before = w.days ?? 30;
  saveWaSettings(next);
  if (wipe) withDb(openWrite, (wdb) => deleteOutside(wdb, next, w));
  recordActivity({
    kind: 'event',
    category: 'messages: wa',
    summary: `WhatsApp: collecting ${summary}${days !== before ? ` (history was ${before} days back)` : ''}${left.messages ? `; ${plural(left.messages, 'stored message')} of ${plural(left.chats, 'chat')} no longer collected ${wipe ? 'deleted, as the owner chose' : 'kept'}` : ''}`,
    data: { days, before, mode, chats: chats.length, deleted: wipe ? left.messages : 0 },
  });
  p.log.success(`Saved. The service applies this straight away.${wipe ? ` ${plural(left.messages, 'message')} deleted.` : ''}`);
  if (mode === 'selected')
    p.log.info(pc.dim('Chats you add later collect new messages from then on; bc wa recover fetches their history.'));
  // More days than before: the phone sends history when it is linked.
  if (relink && days > before) {
    const now = orExit(
      await p.confirm({
        message: `Fetching ${days} days of history means linking WhatsApp again: you scan a QR code with your phone, and your stored messages are kept. (Until it is linked again, nothing new is collected.) Link again now?`,
      }),
    );
    if (now) return relink(days);
    p.log.info(`Saved for later: when you are at your phone, ${pc.cyan('bc wa pair')} links again and fetches it.`);
  }
  if (standalone) p.outro('Done');
  return true;
}

// The stored messages of chats collected under `was` and no longer under `w`: outside those
// picked now, or left out now; and among those picked then, and not left out then. Only ever
// WhatsApp rows: this must not touch messages from other sources.
function outsideClause(w, was) {
  const params = {};
  const among = (name, refs) => {
    refs.forEach((j, i) => (params[`${name}${i}`] = j));
    return refs.map((_, i) => `@${name}${i}`).join(', ');
  };
  const isIn = (name, refs) => (refs.length ? `chat_ref IN (${among(name, refs)})` : '0');
  const notIn = (name, refs) => (refs.length ? `chat_ref NOT IN (${among(name, refs)})` : '1');
  const leftNow = isIn('x', w.exclude ?? []);
  return {
    sql: [
      w.mode === 'selected' ? `(${notIn('c', w.chats ?? [])} OR ${leftNow})` : leftNow,
      was?.mode === 'selected' ? isIn('w', was.chats ?? []) : '1',
      notIn('y', was?.exclude ?? []),
      sourceSql('chat_ref', 'wa'),
    ].join(' AND '),
    params,
  };
}

export function countOutside(db, w, was) {
  const c = outsideClause(w, was);
  return db.prepare(`SELECT COUNT(*) AS messages, COUNT(DISTINCT chat_ref) AS chats FROM messages WHERE ${c.sql}`).get(c.params);
}

export function deleteOutside(db, w, was) {
  const c = outsideClause(w, was);
  db.prepare(`DELETE FROM messages WHERE ${c.sql}`).run(c.params);
  db.pragma('wal_checkpoint(TRUNCATE)');
}
