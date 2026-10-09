import fs from 'node:fs';
import bigInt from 'big-integer';
import { openRequestsDb } from './requests.js';
import { chatRef, describe, displayName, kindOf, msgId } from './map.js';
import { readSession, tgaSettings, wanted } from './paired.js';
import {
  archiveStatements,
  mediaPaths,
  now,
  openArchiveForWriting as openWrite,
  serviceConnected,
  setArchiveMeta as setMeta,
  settingsChangedAt,
  sleep,
} from '../../src/api.js';

// READ-ONLY by design: this file never sends a message, marks anything read, or
// changes anything on the account. It logs in as the owner (like Telegram Desktop
// would) and only fetches: dialogs, message history, live updates, and media on request.

const MAX_PER_CHAT = 5000; // history messages per chat, a guard against enormous groups

export async function connect() {
  const { TelegramClient } = await import('telegram');
  const { StringSession } = await import('telegram/sessions/index.js');
  const { Logger } = await import('telegram/extensions/index.js');
  const s = tgaSettings();
  const client = new TelegramClient(new StringSession(readSession()), Number(s.apiId), s.apiHash, {
    connectionRetries: 10,
    floodSleepThreshold: 120, // if Telegram says "slow down" for up to 2 minutes, wait rather than fail
    deviceModel: 'blackcat (read-only)',
    appVersion: '0.1',
    baseLogger: new Logger('error'),
  });
  return client;
}

// `client` is a logged-in TelegramClient (or a stand-in with the same methods, in tests).
export async function startTgService({ client, log, events, utils } = {}) {
  if (!events)
    events = {
      ...(await import('telegram/events/index.js')),
      ...(await import('telegram/events/EditedMessage.js')),
      ...(await import('telegram/events/DeletedMessage.js')),
    };
  if (!utils) ({ utils } = await import('telegram'));
  const db = openWrite();
  const toJpg = utils.strippedPhotoToJpg;
  let stopped = false;
  const me = await client.getMe();
  const meRef = chatRef(String(me.id));
  // Rows stored before the rule above existed: the owner's own messages recorded as someone else's.
  db.prepare('UPDATE messages SET from_me = 1, sender_ref = NULL WHERE sender_ref = ? AND from_me = 0').run(meRef);

  const q = {
    ...archiveStatements(db),
    info: db.prepare(`INSERT INTO chat_info (ref, kind, members, username) VALUES (@ref, @kind, @members, @username)
      ON CONFLICT (ref) DO UPDATE SET kind = excluded.kind, members = COALESCE(excluded.members, chat_info.members), username = COALESCE(excluded.username, chat_info.username)`),
    getInfo: db.prepare('SELECT * FROM chat_info WHERE ref = ?'),
    setCutoff: db.prepare('UPDATE chat_info SET backfill_cutoff = ? WHERE ref = ?'),
    // A deletion outside channels only names message numbers, not the chat.
    // ("_" is a wildcard in LIKE, so it is escaped to match the literal separator.)
    delAnywhere: db.prepare(
      `UPDATE messages SET deleted = 1 WHERE id LIKE ? ESCAPE '\\' AND chat_ref >= 'tg:' AND chat_ref < 'tg;' AND chat_ref NOT LIKE 'tg:-100%'`,
    ),
  };

  // Record a chat and what kind it is. Returns { ref, kind, members }.
  function noteChat(entity, { ts = null } = {}) {
    const marked = String(utils.getPeerId(entity));
    const ref = chatRef(marked);
    const kind = kindOf(entity);
    const isPerson = kind === 'user' || kind === 'bot';
    const name = entity.self ? 'Saved Messages' : displayName(entity);
    q.chat.run({ ref, name: isPerson && !entity.self ? null : name, isGroup: isPerson ? 0 : 1, ts });
    q.info.run({ ref, kind, members: entity.participantsCount ?? null, username: entity.username ?? null });
    if (isPerson) q.contact.run({ ref, name, notify: entity.username ?? null, phone: entity.phone ?? null });
    return { ref, kind, members: entity.participantsCount ?? null, marked };
  }

  function store(msg, chat, { edit = false } = {}) {
    const d = describe(msg, { toJpg });
    if (!d) return 0;
    const id = msgId(chat.marked, msg.id);
    const l = d.link;
    if (edit && q.exists.get(chat.ref, id)) {
      q.edit.run({
        text: d.text,
        chat: chat.ref,
        id,
        linkUrl: l?.url ?? null,
        linkTitle: l?.title ?? null,
        linkDesc: l?.description ?? null,
      });
      return 0;
    }
    const senderRef = msg.senderId != null ? chatRef(String(msg.senderId)) : chat.kind === 'user' || chat.kind === 'bot' ? chat.ref : null;
    // Telegram doesn't flag messages in Saved Messages as outgoing, so go by who sent it:
    // anything from the owner's own account is theirs.
    const mine = !!msg.out || senderRef === meRef || chat.ref === meRef;
    const sender = mine ? null : senderRef;
    const quoted = msg.replyTo?.replyToMsgId ? msgId(chat.marked, msg.replyTo.replyToMsgId) : null;
    const r = q.msg.run({
      chat: chat.ref,
      id,
      sender,
      fromMe: mine ? 1 : 0,
      ts: msg.date,
      type: d.type,
      text: d.text,
      quoted,
      linkUrl: l?.url ?? null,
      linkTitle: l?.title ?? null,
      linkDesc: l?.description ?? null,
    });
    if (r.changes && d.media) q.media.run({ rowid: r.lastInsertRowid, ...d.media });
    q.chat.run({ ref: chat.ref, name: null, isGroup: chat.kind === 'user' || chat.kind === 'bot' ? 0 : 1, ts: msg.date });
    return r.changes;
  }

  // A live message: work out its chat (asking Telegram once if we haven't seen it), then store it.
  async function ingestLive(msg, opts) {
    if (!msg?.peerId) return;
    const marked = String(utils.getPeerId(msg.peerId));
    const ref = chatRef(marked);
    let info = q.getInfo.get(ref);
    if (!info) {
      const entity = await msg.getChat?.().catch(() => null);
      if (entity) noteChat(entity);
      info = q.getInfo.get(ref) ?? { kind: 'user', members: null };
    }
    if (!wanted(ref, info.kind, info.members)) return;
    // In groups, learn the sender's name as we go.
    if (!msg.out && info.kind !== 'user' && info.kind !== 'bot' && chatRef(String(msg.senderId)) !== meRef) {
      const who = await msg.getSender?.().catch(() => null);
      if (who?.className === 'User')
        q.contact.run({ ref: chatRef(String(who.id)), name: displayName(who), notify: who.username ?? null, phone: null });
    }
    if (store(msg, { ref, marked, kind: info.kind }, opts)) setMeta(db, { tg_last_message_at: now() });
  }

  client.addEventHandler(
    (e) => ingestLive(e.message).catch((err) => log?.(`message not stored: ${err.message}`)),
    new events.NewMessage({}),
  );
  client.addEventHandler((e) => ingestLive(e.message, { edit: true }).catch(() => {}), new events.EditedMessage({}));
  client.addEventHandler((e) => {
    for (const n of e.deletedIds ?? []) {
      if (e.peer) q.del.run(chatRef(String(utils.getPeerId(e.peer))), msgId(String(utils.getPeerId(e.peer)), n));
      else q.delAnywhere.run(`tg%\\_${n}`);
    }
  }, new events.DeletedMessage({}));

  // Fetch history for every collected chat, back to the chosen number of days. Runs at
  // start and whenever the selection changes; chats already covered are skipped.
  async function backfill() {
    const s = tgaSettings();
    const cutoff = s.days ? now() - s.days * 86400 : 0;
    const todo = [];
    for await (const dialog of client.iterDialogs({})) {
      if (stopped) return;
      const entity = dialog.entity;
      if (!entity) continue;
      const chat = noteChat(entity, { ts: dialog.date ?? null });
      if (!wanted(chat.ref, chat.kind, chat.members, s)) continue;
      const done = q.getInfo.get(chat.ref)?.backfill_cutoff;
      // Covered if we've already gone back at least this far (a day's slack, since "30 days ago" moves).
      if (done != null && done <= cutoff + 86400) continue;
      if ((dialog.date ?? now()) < cutoff) {
        q.setCutoff.run(cutoff, chat.ref);
        continue;
      } // nothing in range
      todo.push({ entity, chat });
    }
    let n = 0;
    for (const { entity, chat } of todo) {
      if (stopped) return;
      setMeta(db, { tg_backfill: `${n}/${todo.length}` });
      let stored = 0;
      const batch = [];
      for await (const msg of client.iterMessages(entity, { limit: MAX_PER_CHAT, waitTime: 1 })) {
        if (stopped) return;
        if (msg.date < cutoff) break;
        batch.push(msg);
      }
      // People who spoke in a group come with the messages; record their names.
      db.transaction(() => {
        for (const msg of batch) {
          const who = msg.sender;
          if (who?.className === 'User' && !msg.out && !who.self)
            q.contact.run({ ref: chatRef(String(who.id)), name: displayName(who), notify: who.username ?? null, phone: null });
          stored += store(msg, chat);
        }
        q.setCutoff.run(cutoff, chat.ref);
      })();
      n++;
      if (stored) log?.(`history: ${stored} messages from one chat (${n}/${todo.length})`);
      await sleep(700); // go gently: Telegram rate-limits history requests
    }
    setMeta(db, { tg_backfill: todo.length ? `done ${todo.length}/${todo.length}` : 'done', tg_backfill_at: now() });
  }

  // `bc msg media <id>` can't log in itself (one login, one process), so it leaves a
  // request and we download the file here.
  // One connection to that database for as long as the service runs. It is looked at every
  // second and a half, so opening it afresh each time (as this used to) meant tens of
  // thousands of opens and writes a day for a table that is nearly always empty.
  const adb = openRequestsDb();
  const pending = adb.prepare("SELECT * FROM tg_requests WHERE status = 'pending' ORDER BY id LIMIT 3");
  const answer = adb.prepare('UPDATE tg_requests SET status = ?, path = ?, error = ? WHERE id = ?');
  const purge = adb.prepare('DELETE FROM tg_requests WHERE created_ts < ?');
  let purgedAt = 0;
  async function serveRequests() {
    {
      for (const r of pending.all()) {
        const finish = (status, extra) => answer.run(status, extra.path ?? null, extra.error ?? null, r.id);
        try {
          const m = /^tg(-?\d+)_(\d+)$/.exec(r.msg_id);
          if (!m) throw new Error('not a Telegram message id');
          const row = db
            .prepare('SELECT m.id, m.type, md.* FROM messages m JOIN media md ON md.msg_rowid = m.rowid WHERE m.id = ?')
            .get(r.msg_id);
          if (!row) throw new Error('that message has no media');
          const [msg] = await client.getMessages(await client.getInputEntity(bigInt(m[1])), { ids: [Number(m[2])] });
          if (!msg?.media) throw new Error('Telegram no longer has that message or its media');
          const data = await client.downloadMedia(msg, {});
          if (!data?.length) throw new Error('the download came back empty');
          const paths = mediaPaths(r.msg_id, row);
          fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
          fs.writeFileSync(paths.full, data, { mode: 0o600 });
          finish('done', { path: paths.full });
        } catch (e) {
          finish('error', { error: e.message });
        }
      }
      // Old answers are cleared out every ten minutes, not on every look.
      if (now() - purgedAt >= 600) {
        purgedAt = now();
        purge.run(now() - 3600);
      }
    }
  }

  setMeta(db, { tg_state: 'connected', tg_connected_at: now(), tg_me: meRef, tg_name: displayName(me) });
  log?.(`connected as ${displayName(me)}`);
  serviceConnected();

  let lastSettings = JSON.stringify(tgaSettings());
  // The settings are read again only when the config file has actually been written.
  const configChanged = settingsChangedAt;
  let configSeen = configChanged();
  let busy = false;
  const runBackfill = async () => {
    if (busy) return;
    busy = true;
    try {
      await backfill();
    } catch (e) {
      log?.(`history fetch stopped: ${e.message}`);
    } finally {
      busy = false;
    }
  };
  runBackfill();
  const timer = setInterval(() => {
    serveRequests().catch((e) => log?.(`media request failed: ${e.message}`));
    // A change made with `bc tg account select` is picked up here: fetch history for newly included chats.
    const stamp = configChanged();
    if (stamp === configSeen) return;
    configSeen = stamp;
    const settings = tgaSettings();
    // Settings that have vanished (the config being rewritten, or moved by an update while
    // this process still runs the old code) are not a choice to keep everything: an empty
    // selection has no day limit, and acting on it would fetch years of history. Wait for
    // real settings, or for the restart that follows an update.
    if (!settings.apiId) return;
    const cur = JSON.stringify(settings);
    if (cur !== lastSettings) {
      lastSettings = cur;
      runBackfill();
    }
  }, 1500);

  return {
    backfill: runBackfill,
    async stop() {
      stopped = true;
      clearInterval(timer);
      setMeta(db, { tg_state: 'stopped' });
      await client.disconnect().catch(() => {});
      db.close();
      adb.close();
    },
  };
}
