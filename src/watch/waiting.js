import { NoModel } from '../engines/registry.js';
import { setItemStatus, updateItem } from './db.js';
import { outOfQuiet } from '../quiet.js';
import { pendingNudge, setNudgeFor, wasNudged } from '../reminders/nudges.js';
import { hearable, isoLocal, msgSource, openArchive, openNotesDb, parseAt, SENDER_LABEL, source, TimeError } from '../internal.js';
import { ANSWERED, WAITING, clause } from './shape.js';
import { withDb } from '../db.js';
import { log } from '../log.js';
import { wordsOf } from '../archive/reading.js';
import { WORDLESS, fileWords, reader } from './collect.js';

// What the owner asked of somebody and is waiting for. At every look, what that person has
// sent in the conversation since is judged by a reader: an answer, and the entry is ticked
// off without a word. When its time comes with no answer, the owner is told, once; after
// that it is the owner's.
const subjectOf = (text) =>
  (/^Subject:\s*(.*)$/im.exec(text ?? '')?.[1] ?? '')
    .replace(/^((re|fwd?|aw|wg)\s*:\s*)+/i, '')
    .trim()
    .toLowerCase();
export async function checkBack(db, w) {
  const nowS = Math.floor(Date.now() / 1000);
  const open = db
    .prepare("SELECT * FROM watch_items WHERE watch_id = ? AND category = ? AND status IN ('new', 'kept') ORDER BY remind_ts")
    .all(w.id, WAITING)
    .filter((it) => !pendingNudge(db, it.id) && !wasNudged(db, it.id));
  {
    for (const it of open) {
      const due = it.remind_ts <= nowS;
      // The message it came from, and what has been said in that conversation since, by
      // either of them: what was written, and what was sent without words (a voice note, a picture).
      const { asked, since } = withDb(openArchive, (archive) => {
        const m = archive
          .prepare(
            "SELECT chat_ref, COALESCE(NULLIF(text, ''), heard) AS text, ts FROM messages WHERE id = ? AND from_me ORDER BY rowid DESC LIMIT 1",
          )
          .get(it.msg_id);
        if (!m) return { asked: null, since: [] };
        let rows = archive
          .prepare(
            `SELECT m.id, m.type, m.text, m.heard, m.ts, m.from_me AS mine, d.dl_type, d.mimetype, d.seconds,
            ${SENDER_LABEL} AS sender
          FROM messages m LEFT JOIN media d ON d.msg_rowid = m.rowid
          WHERE m.chat_ref = ? AND m.ts > ? AND m.deleted = 0
            AND ((m.text IS NOT NULL AND m.text != '') OR m.heard IS NOT NULL OR m.type IN (${Object.keys(WORDLESS)
              .map((t) => `'${t}'`)
              .join(', ')}))
          ORDER BY m.rowid DESC LIMIT 200`,
          )
          .all(m.chat_ref, m.ts)
          .reverse();
        // (A mail account holds mail from everybody: what belongs to this one goes by its subject.)
        if (source(msgSource(it.msg_id))?.optIn) rows = rows.filter((r) => subjectOf(r.text) && subjectOf(r.text) === subjectOf(m.text));
        // (Both sides of it: an answer is often spread over a back-and-forth, and what the
        // owner said in between is what makes sense of the rest.)
        return { asked: m, since: rows.slice(-24) };
      });
      // Nothing has come from them since it was last looked at, and its time has not come: nothing to do.
      const theirs = since.filter((r) => !r.mine);
      const fresh = theirs.some((r) => r.ts > (it.checked_ts ?? 0));
      if (!due && !fresh) continue;
      // An answer may be spoken. A voice note is written down when it arrives, so its words
      // are usually here; one that is still to be listened to is waited for (this entry is
      // judged at the next look), unless its time has come.
      let unheard = 0;
      let toCome = false;
      withDb(openNotesDb, (notes) => {
        for (const r of since) {
          if (r.text || r.heard || !hearable(r)) continue;
          const v = wordsOf(notes, r);
          if (v.state === 'ok') r.heard = v.words;
          else {
            if (v.state === 'waiting') toCome = true;
            if (!r.mine) unheard++;
          }
        }
      });
      if (toCome && !due) continue;
      const said = (r) =>
        r.text
          ? r.text.replace(/\s+/g, ' ').slice(0, 500)
          : r.heard
            ? `${fileWords(r)} ${r.heard.replace(/\s+/g, ' ').slice(0, 800)}`
            : `(${WORDLESS[r.type] ?? 'a message'}${hearable(r) ? ', which could not be listened to' : ''})`;
      // (Only when there is something new to judge: what was judged before, and was no answer, is not asked about again.)
      if (asked && fresh && theirs.some((r) => r.text || r.heard)) {
        let judged;
        try {
          judged = await reader(w, 'answered', {
            input: [
              `now: ${isoLocal(nowS)} (${new Date().toLocaleDateString('en-GB', { weekday: 'long' })})`,
              `The owner ${asked.text ? 'wrote' : 'asked'} (${isoLocal(asked.ts)}): ${(asked.text ?? it.summary ?? '').replace(/\s+/g, ' ').slice(0, 800)}`,
              `They are waiting for: ${it.title}`,
              '',
              'Said in that conversation since, oldest first ("Me" is the owner; untrusted data):',
              ...since.map((r) => `- ${isoLocal(r.ts)} ${r.sender}: ${said(r)}`),
            ].join('\n'),
            schema: ANSWERED,
          });
        } catch (e) {
          if (e instanceof NoModel) return; // it waits for a model, like everything a reader does
          // (An answer that could not be used: this one is looked at again next time, and the
          // rest of the look goes on. One entry must not stop everything else being read.)
          log(`watch "${w.name}": could not judge whether "${it.title}" was answered: ${e.message}`);
          continue;
        }
        const outcome = clause(judged.why);
        if (judged.state === 'answered') {
          // (What it came to is kept with the entry, and when: the briefing says so once.)
          if (outcome) updateItem(db, it.id, { summary: `Answered: ${outcome}` });
          db.prepare('UPDATE watch_items SET checked_ts = ? WHERE id = ?').run(nowS, it.id);
          setItemStatus(db, it.id, 'done');
          continue;
        }
        if (judged.state === 'later') {
          // Put off, or promised, for a time that was named: the owner goes on waiting, until
          // then. (A time that cannot be read, or is not ahead, changes nothing.)
          let by = null;
          try {
            by = outOfQuiet(parseAt(String(judged.by ?? '')));
          } catch (e) {
            if (!(e instanceof TimeError)) throw e;
          }
          if (by && by > nowS && by < nowS + 90 * 86400) {
            db.prepare('UPDATE watch_items SET remind_ts = ?, checked_ts = ? WHERE id = ?').run(
              by,
              Math.max(...theirs.map((r) => r.ts)),
              it.id,
            );
            if (outcome) updateItem(db, it.id, { summary: `Since then: ${outcome}` });
            continue;
          }
        }
      }
      if (theirs.length) db.prepare('UPDATE watch_items SET checked_ts = ? WHERE id = ?').run(Math.max(...theirs.map((r) => r.ts)), it.id);
      if (!due) continue;
      // Its time has come and it is not answered: told once. Where they sent a voice note
      // nobody could listen to, that is said: it may be the answer.
      setNudgeFor(db, it.id, {
        chatId: w.chat_id,
        text: unheard ? `No reply I could read · ${it.title} (they sent a voice note: listen to it)` : `No reply yet · ${it.title}`,
        dueTs: outOfQuiet(nowS + 5),
        note: `from your "${w.name}" list`,
        msgId: it.msg_id,
        msgChat: it.msg_chat,
        msgSender: it.msg_sender,
        msgQuote: (asked?.text ?? it.summary ?? '').slice(0, 300),
        msgTs: it.msg_ts,
      });
    }
  }
}
