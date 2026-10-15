import fs from 'node:fs';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isLidUser,
  isPnUser,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  proto,
  useMultiFileAuthState,
} from 'baileys';
import pino from 'pino';
import {
  archiveMeta as getMeta,
  archiveStatements,
  now,
  openArchiveForWriting as openWrite,
  serveRecovery,
  serviceConnected,
  setArchiveMeta as setMeta,
  sleep,
  sourceSql,
} from '../../src/api.js';
import { hushSessions } from './hush.js';
import { openRequestsDb } from './requests.js';
import { AUTH_DIR } from './paired.js';
import { describe, protocolChange, toNum, unkept } from './message.js';
import { cutoff, waSettings } from './settings.js';

// READ-ONLY by design: this file never sends messages, reactions, read receipts
// or presence. Baileys itself only sends the passive "delivered" ack that every
// offline linked device sends (the grey double tick). The one thing asked for is asked of
// the owner's own phone, never of anyone else: older messages of a chat, when the owner
// runs `bc wa recover` (what WhatsApp Web asks when a chat is scrolled up).

const ON_DEMAND = proto.HistorySync.HistorySyncType.ON_DEMAND;
const PAGE = 50; // messages asked for at a time
const MAX_PAGES = 200; // per chat, so that one endless chat cannot hold the rest up

export { isPaired } from './paired.js';

const skipJid = (ref) => !ref || isJidBroadcast(ref) || isJidNewsletter(ref);

export function startService({
  log,
  logLevel = 'warn',
  onQr,
  onOpen,
  onClose,
  onHistory,
  onLoggedOut,
  socketFactory = makeWASocket,
  // (Shortened in tests.) How long the phone is given to answer, the pause between two
  // questions, and how often a request left by `bc wa recover` is looked for.
  answerWaitMs = 25_000,
  askGapMs = 1500,
  requestPollMs = 3000,
} = {}) {
  hushSessions();
  const db = openWrite();
  const lidMap = new Map(
    db
      .prepare('SELECT lid, pn FROM lid_map')
      .all()
      .map((r) => [r.lid, r.pn]),
  );
  let sock;
  let stopped = false;
  let retry = 0;
  let dropped = null; // when the connection was lost, until it is back

  const q = {
    lid: db.prepare('INSERT OR REPLACE INTO lid_map (lid, pn) VALUES (?, ?)'),
    moveChatMsgs: db.prepare('UPDATE OR IGNORE messages SET chat_ref = ? WHERE chat_ref = ?'),
    moveSender: db.prepare('UPDATE messages SET sender_ref = ? WHERE sender_ref = ?'),
    mergeChat: db.prepare(`INSERT INTO chats (ref, name, is_group, last_ts) SELECT ?, name, is_group, last_ts FROM chats WHERE ref = ?
      ON CONFLICT (ref) DO UPDATE SET name = COALESCE(chats.name, excluded.name), last_ts = MAX(COALESCE(chats.last_ts, 0), COALESCE(excluded.last_ts, 0))`),
    dropChat: db.prepare('DELETE FROM chats WHERE ref = ?'),
    ...archiveStatements(db),
    thumb: db.prepare('INSERT OR IGNORE INTO link_thumbs (msg_rowid, jpeg, width, height) VALUES (?, ?, ?, ?)'),
    raw: db.prepare('INSERT OR IGNORE INTO raw (msg_rowid, proto) VALUES (?, ?)'),
  };

  // Once we learn a hidden ID's phone number, fold anything stored under the hidden ID into it,
  // so one person or chat never shows up twice.
  function addLid(lid, pn) {
    if (!lid || !pn || !isLidUser(lid) || !isPnUser(pn)) return;
    lid = jidNormalizedUser(lid);
    pn = jidNormalizedUser(pn);
    if (lidMap.get(lid) === pn) return;
    lidMap.set(lid, pn);
    q.lid.run(lid, pn);
    q.mergeChat.run(pn, lid);
    q.dropChat.run(lid);
    q.moveChatMsgs.run(pn, lid);
    q.moveSender.run(pn, lid);
  }

  function canon(ref, alt) {
    if (!ref) return ref;
    ref = jidNormalizedUser(ref);
    if (isLidUser(ref)) {
      if (alt && isPnUser(alt)) {
        addLid(ref, alt);
        return jidNormalizedUser(alt);
      }
      return lidMap.get(ref) ?? ref;
    }
    return ref;
  }

  // While older messages are being recovered, how far back they are kept: that may be
  // further than the days chosen for what arrives by itself.
  let reach = null;
  const wanted = (w, chat, ts) => ts >= Math.min(cutoff(w), reach ?? Infinity) && (w.mode !== 'selected' || (w.chats ?? []).includes(chat));

  const ingestContacts = db.transaction((contacts) => {
    for (const c of contacts ?? []) {
      if (!c?.id || skipJid(c.id)) continue;
      if (c.lid && c.phoneNumber) addLid(c.lid, c.phoneNumber);
      const ref = canon(c.id, c.phoneNumber);
      q.contact.run({
        ref,
        name: c.name ?? null,
        notify: c.notify ?? c.verifiedName ?? null,
        phone: c.phoneNumber ?? (isPnUser(ref) ? ref.split('@')[0] : null),
      });
    }
  });

  const ingestChats = db.transaction((chats) => {
    for (const c of chats ?? []) {
      if (!c?.id || skipJid(c.id)) continue;
      if (c.lidJid && c.pnJid) addLid(c.lidJid, c.pnJid);
      const ref = canon(c.id, c.pnJid);
      q.chat.run({
        ref,
        name: (isJidGroup(ref) ? (c.name ?? c.subject) : c.name) ?? c.displayName ?? null,
        isGroup: isJidGroup(ref) ? 1 : 0,
        ts: toNum(c.conversationTimestamp) || toNum(c.lastMsgTimestamp) || toNum(c.lastMessageRecvTimestamp) || null,
      });
    }
  });

  const notKept = new Set();
  const ingestMessages = db.transaction((messages) => {
    const w = waSettings(); // re-read, so `bc wa select` applies without a restart
    let stored = 0;
    let filled = 0; // already-stored messages that gained a sender or link preview details
    for (const m of messages ?? []) {
      const k = m?.key;
      if (!k?.remoteJid || skipJid(k.remoteJid)) continue;
      const chat = canon(k.remoteJid, k.remoteJidAlt);

      const change = protocolChange(m.message);
      if (change) {
        if (change.kind === 'delete') q.del.run(chat, change.id);
        else
          q.edit.run({
            text: change.text,
            chat,
            id: change.id,
            linkUrl: change.link?.url ?? null,
            linkTitle: change.link?.title ?? null,
            linkDesc: change.link?.description ?? null,
          });
        continue;
      }

      const d = describe(m.message);
      const ts = toNum(m.messageTimestamp);
      if (!d) {
        // A kind of message nothing here reads: said once in the log (the kind, not what it
        // said), so that something being missed can be found out.
        const kind = unkept(m.message);
        if (kind && !notKept.has(kind)) {
          notKept.add(kind);
          log?.(`a kind of message that is not kept arrived: ${kind}`);
        }
      }
      if (!d || !ts || !wanted(w, chat, ts)) continue;

      // In groups the sender is the participant: on the key for live messages, but on the
      // message itself (WebMessageInfo.participant) for history. Never the group's own JID.
      const group = isJidGroup(chat);
      const rawSender = k.fromMe ? null : group ? k.participant || m.participant : k.remoteJid;
      const sender = rawSender && !isJidGroup(rawSender) ? canon(rawSender, group ? k.participantAlt : k.remoteJidAlt) : null;
      if (sender && m.pushName) q.contact.run({ ref: sender, name: null, notify: m.pushName, phone: null });
      q.chat.run({ ref: chat, name: null, isGroup: isJidGroup(chat) ? 1 : 0, ts });
      const l = d.link;
      const had = q.exists.get(chat, k.id);
      const r = q.msgFill.run({
        chat,
        id: k.id,
        sender,
        fromMe: k.fromMe ? 1 : 0,
        ts,
        type: d.type,
        text: d.text,
        quoted: d.quoted,
        linkUrl: l?.url ?? null,
        linkTitle: l?.title ?? null,
        linkDesc: l?.description ?? null,
      });
      const { rowid } = had ?? q.exists.get(chat, k.id);
      if (l?.thumb) q.thumb.run(rowid, l.thumb, l.width, l.height);
      const gotMedia = d.media ? q.media.run({ rowid, ...d.media }).changes : 0;
      try {
        q.raw.run(rowid, Buffer.from(proto.WebMessageInfo.encode(m).finish()));
      } catch {
        // An odd message we can't re-encode still has its extracted fields.
      }
      if (!had) stored++;
      else if (r.changes || gotMedia) filled++;
    }
    return { stored, filled };
  });

  async function connect() {
    if (stopped) return;
    fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const logger = pino({ level: logLevel });
    const version =
      socketFactory === makeWASocket
        ? await fetchLatestWaWebVersion()
            .then((r) => r.version)
            .catch(() => undefined)
        : undefined;

    sock = socketFactory({
      version,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      logger,
      // Shows up as WhatsApp Web in Chrome on a Mac. ('Desktop' would claim to be the
      // native macOS app, and WhatsApp rejects that from Baileys with a 428.)
      browser: Browsers.macOS('Chrome'),
      syncFullHistory: true,
      markOnlineOnConnect: false, // never appear online
      shouldIgnoreJid: skipJid, // status updates and channels
      getMessage: async () => undefined, // we never resend anything
      generateHighQualityLinkPreview: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (u) => {
      // Stopped or unlinked on purpose: that already said so, and the database may be closed.
      if (stopped) return;
      if (u.qr) onQr?.(u.qr);
      if (u.connection === 'open') {
        retry = 0;
        setMeta(db, { state: 'connected', connected_at: now(), me: sock.user?.id, last_error: null });
        log?.(`connected as ${sock.user?.id?.split(':')[0]}`);
        serviceConnected({ offlineMs: dropped ? Date.now() - dropped : null });
        dropped = null;
        onOpen?.(sock.user);
        // Group names aren't always in the history sync. This only reads group info.
        sock
          .groupFetchAllParticipating()
          .then((groups) => ingestChats(Object.values(groups).map((g) => ({ id: g.id, name: g.subject }))))
          .catch(() => {});
      }
      if (u.connection === 'close') {
        dropped ??= Date.now();
        const code = u.lastDisconnect?.error?.output?.statusCode;
        // disconnected_at is when it first dropped, kept across failed attempts to reconnect.
        const was = getMeta(db);
        setMeta(db, {
          state: 'disconnected',
          last_error: `${code ?? ''} ${u.lastDisconnect?.error?.message ?? ''}`.trim(),
          disconnected_at: was.state === 'disconnected' && was.disconnected_at ? was.disconnected_at : now(),
        });
        onClose?.(code, u.lastDisconnect?.error?.message);
        if (code === DisconnectReason.loggedOut) {
          setMeta(db, { state: 'logged_out' });
          onLoggedOut?.();
          return;
        }
        // 515 is the normal "restart" right after pairing. 440 means another copy took over.
        const delay =
          code === DisconnectReason.restartRequired
            ? 0
            : code === DisconnectReason.connectionReplaced
              ? 60_000
              : Math.min(60, 2 ** retry++) * 1000;
        log?.(`disconnected (${code ?? 'unknown'}), reconnecting in ${delay / 1000}s`);
        setTimeout(() => connect().catch((e) => log?.(`reconnect failed: ${e.message}`)), delay);
      }
    });

    // What arrives is written to the archive, which the Telegram and mail sources write to
    // as well. A write that finds it busy is tried again; one that still fails is logged and
    // skipped, instead of ending the service (and the WhatsApp connection with it).
    const on = (event, handler) =>
      sock.ev.on(event, (arg) => {
        for (let attempt = 1; ; attempt++) {
          try {
            return handler(arg);
          } catch (e) {
            if (e?.code === 'SQLITE_BUSY' && attempt < 3) continue;
            return log?.(`${event} could not be stored: ${e?.message ?? e}`);
          }
        }
      });

    on('messaging-history.set', ({ chats, contacts, messages, lidPnMappings, progress, syncType }) => {
      for (const { lid, pn } of lidPnMappings ?? []) addLid(lid, pn);
      ingestContacts(contacts);
      ingestChats(chats);
      const { stored, filled } = ingestMessages(messages);
      setMeta(db, { last_history_at: now() });
      // The phone's answer to a question about one chat (see recover): how much came, and the oldest of it.
      if (asking && syncType === ON_DEMAND) {
        const mine = (messages ?? []).filter((m) => m?.key?.remoteJid && canon(m.key.remoteJid, m.key.remoteJidAlt) === asking.chat);
        const oldest = mine.reduce((a, m) => (!a || toNum(m.messageTimestamp) < toNum(a.messageTimestamp) ? m : a), null);
        asking.answer({ got: mine.length, stored, oldest: oldest && { key: oldest.key, ts: toNum(oldest.messageTimestamp) } });
      }
      onHistory?.({ chats: chats?.length ?? 0, messages: messages?.length ?? 0, stored, filled, progress, syncType });
    });

    on('messages.upsert', ({ messages }) => {
      if (ingestMessages(messages).stored) setMeta(db, { last_message_at: now() });
    });
    on('messages.delete', (e) => {
      for (const k of e.keys ?? []) q.del.run(canon(k.remoteJid, k.remoteJidAlt), k.id);
    });
    on('chats.upsert', ingestChats);
    on('chats.update', ingestChats);
    on('contacts.upsert', ingestContacts);
    on('contacts.update', ingestContacts);
    on('groups.upsert', (gs) => ingestChats(gs.map((g) => ({ id: g.id, name: g.subject }))));
    on('groups.update', (gs) => ingestChats(gs.filter((g) => g.subject).map((g) => ({ id: g.id, name: g.subject }))));
    on('lid-mapping.update', ({ lid, pn }) => addLid(lid, pn));
  }

  // ---------- recovering what is missing ----------
  // The phone is asked for the messages of a chat older than one that is kept, fifty at a
  // time, back to the day asked for. What comes is stored like history: one already there
  // is not stored twice, so only what was missing is added. A chat is started from its
  // newest kept message, so what is newer than that cannot be reached this way.
  let asking = null;
  const newestOf = db.prepare(
    `SELECT m.id, m.from_me AS fromMe, m.ts, r.proto FROM messages m LEFT JOIN raw r ON r.msg_rowid = m.rowid
     WHERE m.chat_ref = ? ORDER BY m.ts DESC, m.rowid DESC LIMIT 1`,
  );
  const chatLabel = db.prepare('SELECT name FROM chats WHERE ref = ?').pluck();
  const contactLabel = db.prepare('SELECT COALESCE(name, notify) FROM contacts WHERE ref = ?').pluck();
  // A person's chat has no name of its own: the name they are saved under, or their number.
  const nameOf = (ref) => contactLabel.get(ref) || (isPnUser(ref) ? `+${ref.split('@')[0]}` : ref.split('@')[0]);
  function anchorOf(ref) {
    const m = newestOf.get(ref);
    if (!m) return null;
    let key = { remoteJid: ref, id: m.id, fromMe: !!m.fromMe };
    try {
      // As it arrived: a chat may be known to the phone under a hidden id.
      if (m.proto) key = proto.WebMessageInfo.decode(m.proto).key ?? key;
    } catch {}
    return { key, ts: m.ts };
  }
  async function ask(chat, anchor) {
    const answered = new Promise((resolve) => (asking = { chat, answer: resolve }));
    try {
      await sock.fetchMessageHistory(PAGE, anchor.key, anchor.ts);
      return await Promise.race([answered, sleep(answerWaitMs).then(() => null)]);
    } finally {
      asking = null;
    }
  }
  async function recover({ days, chats: only = null } = {}, progress = () => {}) {
    if (!sock || getMeta(db).state !== 'connected') throw new Error('WhatsApp is not connected right now');
    const from = now() - days * 86400;
    const w = waSettings();
    const chats = db
      .prepare(
        `SELECT chat_ref AS ref, MAX(ts) AS newest FROM messages WHERE ${sourceSql('chat_ref', 'wa')} GROUP BY chat_ref HAVING newest >= ? ORDER BY newest DESC`,
      )
      .all(from)
      .filter((c) => (!only || only.includes(c.ref)) && (w.mode !== 'selected' || (w.chats ?? []).includes(c.ref)));
    const out = { days, chats: chats.length, looked: 0, asked: 0, recovered: 0, silent: 0, per: [] };
    let quiet = 0; // questions in a row that got no answer
    reach = from;
    try {
      for (const c of chats) {
        if (stopped) break;
        let anchor = anchorOf(c.ref);
        let got = 0;
        for (let page = 0; anchor && anchor.ts >= from && page < MAX_PAGES && !stopped; page++) {
          const a = await ask(c.ref, anchor);
          out.asked++;
          if (!a) {
            // No answer to the first question of all: the phone is not there. Later on, a chat
            // that has nothing older may simply not be answered; several in a row is the phone gone.
            if (++quiet >= 3 || out.asked === 1) throw new Error('your phone did not answer: it has to be switched on and connected');
            if (!page) out.silent++;
            break;
          }
          quiet = 0;
          got += a.stored;
          if (!a.got || !a.oldest || a.oldest.ts > anchor.ts || a.oldest.key.id === anchor.key.id) break; // nothing older
          anchor = a.oldest;
          await sleep(askGapMs);
        }
        out.looked++;
        out.recovered += got;
        if (got) out.per.push({ chat: chatLabel.get(c.ref) || nameOf(c.ref), recovered: got });
        progress(out);
        await sleep(askGapMs);
      }
    } finally {
      reach = null;
    }
    if (out.recovered) setMeta(db, { last_message_at: now() });
    return out;
  }

  // `bc wa recover` cannot link itself (one link, one process), so it leaves a request and
  // the work is done here, one at a time.
  const rdb = openRequestsDb();
  const serveRequests = serveRecovery({
    db: rdb,
    table: 'wa_requests',
    source: 'wa',
    label: 'WhatsApp',
    recover,
    log,
    ready: () => !stopped && getMeta(db).state === 'connected',
  });
  const requestTimer = setInterval(() => serveRequests().catch((e) => log?.(`a request failed: ${e.message}`)), requestPollMs);
  requestTimer.unref?.();

  const ready = connect();

  return {
    ready,
    recover,
    // Disconnect but stay linked.
    async stop() {
      stopped = true;
      clearInterval(requestTimer);
      try {
        sock?.end(undefined);
      } catch {}
      setMeta(db, { state: 'stopped' });
      await sleep(500);
      db.close();
      rdb.close();
    },
    // Alternative to the QR code: an 8-character code typed into WhatsApp on the phone.
    requestPairingCode: (phone) => sock.requestPairingCode(phone),
    // Unlink this device from WhatsApp.
    async logout() {
      stopped = true;
      clearInterval(requestTimer);
      await sock?.logout().catch(() => {});
      setMeta(db, { state: 'unlinked' }); // by the owner, on purpose
      db.close();
      rdb.close();
    },
  };
}
