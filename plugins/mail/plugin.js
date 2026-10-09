// Mail: reads your email accounts over IMAP (Gmail, iCloud, Yahoo, Fastmail and most
// others), read-only. Nothing is ever sent, deleted, moved or marked as read.
//
// Most of an inbox is not worth reading, so mail is sorted by its headers first, with no
// AI involved: a header line (who, when, subject) is kept for everything, and the text
// only for mail that passes (see rules.js). Kept mail goes into the message archive as
// the chat "Mail: <account>", where search and watches can use it.
import { hostFor, judge, matches, unchanged, validRule } from './rules.js';
import { archive, chatName, filesOf, forget, openStore, setState, stateOf, storedText, unarchive } from './store.js';
import { ago, fromEvery, now, withDb } from '../../src/api.js';

const NAME = /^[a-z][a-z0-9_-]{0,24}$/;
const TEXTS_PER_RUN = 150; // mails whose text is fetched in one go; the rest follow next time
const KNOWN_DAYS = 365; // people you wrote to in this long count as known
const KNOWN_REFRESH_S = 86400;
const TELL_AFTER_S = 3600;

// The mail libraries are large (over a second to load on a Pi). They are loaded when a
// command actually talks to a mail server, not whenever any `bc` command starts.
const imap = () => import('./imap.js');

const accounts = (ctx) => ctx.config.get().accounts ?? {};
// How often new mail is fetched: the owner's choice (bc mail setup), every 5 minutes until then.
const EVERY = { '5m': 'every 5 minutes', '15m': 'every 15 minutes', '30m': 'every 30 minutes', '1h': 'every hour' };
const every = (ctx) => (EVERY[ctx.config.get().every] ? ctx.config.get().every : '5m');
const rules = (ctx) => ({ allow: ctx.config.get().allow ?? [], block: ctx.config.get().block ?? [] });
const when = (ts) => new Date(ts * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
// (Without its password there is nothing to try: said at once, not after the mail server has
// been kept waiting for a login that cannot succeed.)
const login = (ctx, name) => {
  const a = accounts(ctx)[name];
  const pass = ctx.secrets.get(`password:${name}`);
  if (!pass) throw new Error(`no app password is saved for "${name}" (connect it again: bc mail add)`);
  return { host: a.host, port: a.port ?? 993, user: a.address, pass };
};
const need = (ctx) => {
  if (!Object.keys(accounts(ctx)).length) ctx.fail('No mail account is connected yet. Connect one: bc mail add');
};
const pickAccount = (ctx, name) => {
  if (name && !accounts(ctx)[name]) ctx.fail(`There is no mail account called "${name}". See: bc mail list`);
  return name ? [name] : Object.keys(accounts(ctx));
};

// Bring one account up to date. → { fresh, kept, skipped, more, sent }
async function syncAccount(ctx, name, { full = false } = {}) {
  const acct = accounts(ctx)[name];
  return withDb(
    () => openStore(ctx),
    async (db) => {
      try {
        const since = Date.now() - (acct.days ?? 30) * 86400000;
        const { mailboxMark, newHeaders, sentHeaders, sentMark, texts, withMailbox, writtenTo } = await imap();
        const result = await withMailbox(login(ctx, name), async (client) => {
          const st = stateOf(db, name);
          const myRules = rules(ctx);
          // Most fetches find the mailbox exactly as it was. Then there is nothing to ask for and
          // nothing to sort again, as long as the rules are the same too, no mail is still waiting
          // for its text, and a full pass has been made in the last few hours.
          // (The Sent folder is part of what is looked at: a mail the owner sent is a change too.)
          const seen = `${await mailboxMark(client)}+${await sentMark(client)}|${acct.days ?? 30}|${JSON.stringify(myRules)}`;
          const knownDue = !st.known_at || now() - st.known_at > KNOWN_REFRESH_S;
          const waiting =
            db.prepare('SELECT COUNT(*) FROM mail WHERE account = ? AND kept = 1 AND stored = 0').pluck().get(name) +
            db.prepare('SELECT COUNT(*) FROM sent WHERE account = ? AND stored = 0').pluck().get(name);
          if (unchanged({ state: st, seen, waiting, knownDue, full, nowS: now() })) return { fresh: 0, kept: 0, more: 0, unchanged: true };

          const have = () => new Set(db.prepare('SELECT uid FROM mail WHERE account = ?').pluck().all(name));
          let h = await newHeaders(client, { sinceMs: since, have: have(), me: acct.address });
          // The server renumbered the mailbox (rare): what was stored no longer lines up.
          if (st.uid_validity && st.uid_validity !== h.uidValidity) {
            forget(db, name);
            h = await newHeaders(client, { sinceMs: since, have: new Set(), me: acct.address });
          }
          if (!st.known_at || now() - st.known_at > KNOWN_REFRESH_S) {
            const addrs = await writtenTo(client, Date.now() - KNOWN_DAYS * 86400000);
            db.transaction(() => {
              db.prepare('DELETE FROM known WHERE account = ?').run(name);
              const ins = db.prepare('INSERT OR IGNORE INTO known (account, addr) VALUES (?, ?)');
              addrs.forEach((a) => ins.run(name, a));
            })();
            setState(db, name, { known_at: now() });
          }
          const ins =
            db.prepare(`INSERT OR IGNORE INTO mail (account, uid, ts, from_addr, from_name, subject, files, bulk, is_primary, from_me)
        VALUES (@account, @uid, @ts, @from, @fromName, @subject, @files, @bulk, @primary, @fromMe)`);
          db.transaction(() =>
            h.fresh.forEach((m) =>
              ins.run({
                account: name,
                uid: m.uid,
                ts: m.ts,
                from: m.from,
                fromName: m.fromName,
                subject: m.subject,
                files: JSON.stringify(m.files),
                bulk: m.bulk,
                primary: m.primary == null ? null : m.primary ? 1 : 0,
                fromMe: m.fromMe ? 1 : 0,
              }),
            ),
          )();
          setState(db, name, { uid_validity: h.uidValidity, gmail: h.gmail ? 1 : 0 });
          if (h.primary) {
            // Only the mails whose tab changed are written.
            const was = new Map(db.prepare('SELECT uid, is_primary FROM mail WHERE account = ?').raw().all(name));
            const setP = db.prepare('UPDATE mail SET is_primary = ? WHERE account = ? AND uid = ?');
            db.transaction(() =>
              h.uids.forEach((u) => {
                const p = h.primary.has(u) ? 1 : 0;
                if (was.has(u) && was.get(u) !== p) setP.run(p, name, u);
              }),
            )();
          }
          // The server answers "since" by whole days, so mail is dropped two days later than it stops
          // being asked for; otherwise the boundary day would be fetched and dropped on every run.
          forget(db, name, Math.floor(since / 1000) - 2 * 86400);

          // Judge everything again each time, so a rule you add or remove applies to mail already here.
          const known = new Set(db.prepare('SELECT addr FROM known WHERE account = ?').pluck().all(name));
          const all = db.prepare('SELECT * FROM mail WHERE account = ? ORDER BY ts DESC').all(name);
          const set = db.prepare('UPDATE mail SET kept = ?, reason = ? WHERE account = ? AND uid = ?');
          const drop = [];
          db.transaction(() => {
            for (const m of all) {
              const j = judge(
                { from: m.from_addr, bulk: m.bulk, primary: !!m.is_primary, fromMe: !!m.from_me },
                { ...myRules, known, gmail: h.gmail },
              );
              if (m.kept !== (j.keep ? 1 : 0) || m.reason !== j.reason) set.run(j.keep ? 1 : 0, j.reason, name, m.uid);
              m.kept = j.keep ? 1 : 0;
              if (!j.keep && m.stored) drop.push(m.uid);
            }
          })();
          unarchive(name, drop);
          if (drop.length) db.prepare(`UPDATE mail SET stored = 0 WHERE account = ? AND uid IN (${drop.join(',')})`).run(name);

          const wanted = all.filter((m) => m.kept && !m.stored);
          const batch = wanted.slice(0, TEXTS_PER_RUN);
          const got = await texts(
            client,
            batch.map((m) => m.uid),
          );
          // Oldest first, so the archive (and what watches read next) is in the order it arrived.
          archive(name, batch.filter((m) => got.has(m.uid)).reverse(), (m) => got.get(m.uid));
          const mark = db.prepare('UPDATE mail SET stored = 1 WHERE account = ? AND uid = ?');
          db.transaction(() => batch.forEach((m) => got.has(m.uid) && mark.run(name, m.uid)))();
          // And what the owner sent, with whatever room is left in this run.
          const { syncSent } = await import('./sent.js');
          const sent = await syncSent(db, client, name, acct.address, {
            since,
            room: TEXTS_PER_RUN - batch.length,
            imap: { sentHeaders, texts },
          });
          setState(db, name, { mark: seen, full_at: now() });
          return {
            fresh: h.fresh.length,
            kept: h.fresh.filter((f) => all.find((m) => m.uid === f.uid)?.kept).length,
            more: wanted.length - batch.length + sent.more,
            sent: sent.fresh,
          };
        });
        setState(db, name, { synced_at: now(), error: null, error_since: null, told: 0 });
        return { ...result, skipped: result.fresh - result.kept };
      } catch (e) {
        const st = stateOf(db, name);
        setState(db, name, { error: e.message, error_since: st.error_since ?? now() });
        throw e;
      }
    },
  );
}

const line = (m, many) =>
  `${m.kept ? '●' : '○'} ${when(m.ts)}  ${(m.from_name || m.from_addr || 'unknown').slice(0, 28)}: ${m.subject || '(no subject)'}${many ? ` [${m.account}]` : ''}  ‹mail:${m.account}:${m.uid}›${m.kept ? '' : `  (skipped: ${m.reason})`}`;

export default {
  api: 1,
  name: 'mail',
  title: 'Mail',
  // Its own, and private: the agent is kept from it by name, whether or not the plugin is switched on.
  privateData: ['mail.db'],
  description:
    'reads your email accounts (Gmail and others, over IMAP), read-only; keeps the mail worth reading and skips newsletters and promotions without any AI',
  help: `Examples:
  bc mail add                        # connect an account (asks for a name, the address and an app password)
  bc mail recent                     # what arrived: ● kept, ○ skipped (and why)
  bc mail senders --skipped          # who is being skipped, most mail first
  bc mail allow school.example       # always keep mail from this domain or address
  bc mail block shop@deals.example   # never keep it
  bc mail find invoice               # search senders and subjects, skipped mail included
  bc mail show mail:personal:4812    # one mail's text

Kept mail is in the archive as the chat "Mail: <account>":
  bc msg find school trip --source mail
  bc watch add School emails --look-for "anything a parent must act on" --chat "Mail: personal" --from school.example --attachments

Read-only: nothing is sent, deleted, moved or marked as read.`,

  commands: {
    setup: {
      summary: 'how often new mail is fetched',
      // A preference, not a connection or a permission: the agent may change it when you ask, with your say each time.
      access: () => ({ level: 'ask', describe: 'change how often new mail is fetched' }),
      form: [
        {
          id: 'every',
          type: 'select',
          message: 'How often should new mail be fetched?',
          default: (_a, ctx) => every(ctx),
          options: Object.entries(EVERY).map(([value, label]) => ({ value, label })),
        },
      ],
      run: (ctx, a) => {
        if (!EVERY[a.every]) ctx.fail(`--every is one of: ${Object.keys(EVERY).join(', ')}.`);
        ctx.config.set({ every: a.every });
        return { text: `New mail is fetched ${EVERY[a.every]} from now on. (Now, at any time: bc mail sync)`, data: { every: a.every } };
      },
    },
    add: {
      summary: 'connect a mail account with an app password',
      access: 'owner',
      working: 'Signing in and reading your Inbox. The first time can take a minute or two…',
      form: [
        {
          type: 'note',
          message:
            'You need an app password, not your normal one. Gmail: myaccount.google.com → Security → 2-Step Verification must be on → search "App passwords" → create one called blackcat, and copy the 16 letters. iCloud and Yahoo have the same under their security settings. It is stored as a secret and never shown; you can revoke it from your account at any time.',
        },
        {
          id: 'name',
          type: 'text',
          message: 'A short name for this account (personal, work)',
          validate: (v) =>
            NAME.test(String(v).trim().toLowerCase()) ? undefined : 'Lowercase letters, digits, - or _, starting with a letter',
        },
        {
          id: 'address',
          type: 'text',
          message: 'The email address',
          validate: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim()) ? undefined : 'An address like you@gmail.com'),
        },
        { id: 'password', type: 'secret', message: 'The app password' },
        {
          id: 'host',
          type: 'text',
          message: 'The mail server (leave as it is unless you know otherwise)',
          default: (a) => hostFor(String(a.address ?? '').trim()),
        },
        {
          id: 'days',
          type: 'select',
          message: 'How far back to keep mail?',
          default: '30',
          options: [
            { value: '7', label: 'a week' },
            { value: '30', label: '30 days' },
            { value: '90', label: '90 days' },
          ],
        },
      ],
      run: async (ctx, a) => {
        const name = String(a.name).trim().toLowerCase();
        // "imap.example.com", or "imap.example.com:1993" for a server on another port.
        const [host, port] = String(a.host || hostFor(String(a.address).trim()))
          .trim()
          .split(':');
        const acct = { address: String(a.address).trim(), host, ...(port ? { port: Number(port) } : {}), days: Number(a.days) || 30 };
        const pass = String(a.password).replace(/\s+/g, ''); // Google shows it in groups of four
        const { withMailbox } = await imap();
        try {
          await withMailbox({ host: acct.host, port: acct.port, user: acct.address, pass }, async (c) =>
            c.mailboxOpen('INBOX', { readOnly: true }),
          );
        } catch (e) {
          ctx.fail(`Could not sign in to ${acct.address}: ${e.message}.`);
        }
        ctx.secrets.set(`password:${name}`, pass);
        ctx.config.set({ accounts: { ...accounts(ctx), [name]: acct } });
        const r = await syncAccount(ctx, name);
        return [
          `Connected ${acct.address} as ${name}.`,
          `Looked at the last ${acct.days} days of the Inbox: ${r.fresh} mails, of which ${r.kept} are kept and ${r.skipped} skipped (newsletters, promotions, automatic mail).${r.more ? ` The text of ${r.more} more is still being fetched.` : ''}`,
          'See what was skipped, and keep a sender you care about:  bc mail senders --skipped   ·   bc mail allow <address or domain>',
          `New mail is fetched ${EVERY[every(ctx)]} (bc mail setup changes that). Kept mail is the chat "${chatName(name)}" for search and watches.`,
        ].join('\n');
      },
    },

    remove: {
      summary: 'disconnect an account and forget its mail',
      access: 'ask',
      usage: '<name>',
      run: (ctx, i) => {
        const all = { ...accounts(ctx) };
        if (!all[i.name]) ctx.fail(`There is no mail account called "${i.name}". See: bc mail list`);
        withDb(
          () => openStore(ctx),
          (db) => forget(db, i.name),
        );
        delete all[i.name];
        ctx.config.set({ accounts: all });
        ctx.secrets.delete(`password:${i.name}`);
        return `Disconnected ${i.name}. Its mail and its app password are forgotten here. (Revoke the app password in your account too.) Watches that named "${chatName(i.name)}" no longer receive anything.`;
      },
    },

    list: {
      summary: 'the accounts that are connected',
      access: 'allow',
      untrusted: false,
      run: (ctx) => {
        const rows = withDb(
          () => openStore(ctx),
          (db) =>
            Object.entries(accounts(ctx)).map(([n, a]) => {
              const st = stateOf(db, n);
              const c = db.prepare('SELECT COUNT(*) AS all_, SUM(kept) AS kept FROM mail WHERE account = ?').get(n);
              return {
                name: n,
                address: a.address,
                days: a.days,
                mails: c.all_,
                kept: c.kept ?? 0,
                syncedAt: st.synced_at ?? null,
                error: st.error ?? null,
                errorSince: st.error_since ?? null,
              };
            }),
        );
        return {
          text: rows.length
            ? rows
                .map(
                  (r) =>
                    `${r.name}: ${r.address} · last ${r.days} days · ${r.mails} mails, ${r.kept} kept · ${r.error ? `NOT UPDATING since ${ago(r.errorSince)}: ${r.error}` : r.syncedAt ? `fetched ${ago(r.syncedAt)}` : 'not fetched yet'}`,
                )
                .join('\n')
            : 'No mail account is connected yet. Connect one: bc mail add',
          data: { accounts: rows },
        };
      },
    },

    sync: {
      summary: 'fetch new mail now',
      access: 'allow',
      untrusted: false,
      options: [['--account <name>', 'only this account']],
      run: async (ctx, i) => {
        need(ctx);
        const out = [];
        for (const n of pickAccount(ctx, i.account)) {
          try {
            const r = await syncAccount(ctx, n, { full: true }); // asked for by hand: go through everything
            out.push(
              `${n}: ${r.fresh} new, ${r.kept} kept, ${r.skipped} skipped${r.sent ? `, ${r.sent} you sent` : ''}${r.more ? ` (${r.more} more texts to fetch next time)` : ''}`,
            );
          } catch (e) {
            out.push(`${n}: could not be fetched: ${e.message}`);
          }
        }
        return out.join('\n');
      },
    },

    recent: {
      summary: 'what arrived lately: kept (●) and skipped (○, with the reason)',
      access: 'allow',
      options: [
        ['--account <name>', 'only this account'],
        ['-n, --limit <n>', 'how many', '25'],
        ['--kept', 'only kept mail'],
        ['--skipped', 'only skipped mail'],
      ],
      run: (ctx, i) => {
        need(ctx);
        const names = pickAccount(ctx, i.account);
        const rows = withDb(
          () => openStore(ctx),
          (db) =>
            db
              .prepare(
                `SELECT * FROM mail WHERE account IN (${names.map(() => '?').join(',')})${i.kept ? ' AND kept = 1' : i.skipped ? ' AND kept = 0' : ''} ORDER BY ts DESC LIMIT ?`,
              )
              .all(...names, Math.min(Number(i.limit) || 25, 200)),
        );
        return {
          text: rows.length ? rows.map((m) => line(m, names.length > 1)).join('\n') : 'Nothing yet.',
          data: {
            mails: rows.map((m) => ({
              id: `mail:${m.account}:${m.uid}`,
              account: m.account,
              ts: m.ts,
              from: m.from_addr,
              fromName: m.from_name,
              subject: m.subject,
              kept: !!m.kept,
              reason: m.reason,
              files: filesOf(m).map((f) => f.name),
            })),
          },
        };
      },
    },

    senders: {
      summary: 'who sends you mail, most first, and whether it is kept',
      access: 'allow',
      options: [
        ['--account <name>', 'only this account'],
        ['--skipped', 'only senders that are skipped'],
        ['--kept', 'only senders that are kept'],
        ['-n, --limit <n>', 'how many', '30'],
      ],
      run: (ctx, i) => {
        need(ctx);
        const names = pickAccount(ctx, i.account);
        const rows = withDb(
          () => openStore(ctx),
          (db) =>
            db
              .prepare(
                `SELECT from_addr AS addr, MAX(from_name) AS name, COUNT(*) AS n, SUM(kept) AS kept, MAX(reason) AS reason, MAX(ts) AS last FROM mail
          WHERE account IN (${names.map(() => '?').join(',')}) GROUP BY from_addr HAVING ${i.skipped ? 'SUM(kept) = 0' : i.kept ? 'SUM(kept) > 0' : '1'} ORDER BY n DESC LIMIT ?`,
              )
              .all(...names, Math.min(Number(i.limit) || 30, 200)),
        );
        return {
          text: rows.length
            ? [
                ...rows.map(
                  (r) =>
                    `${String(r.n).padStart(4)}  ${r.kept ? '●' : '○'} ${(r.name ? `${r.name} <${r.addr}>` : r.addr).slice(0, 60)}${r.kept ? '' : `  (${r.reason})`}`,
                ),
                '● kept   ○ skipped.   Keep a sender: bc mail allow <address or domain>   ·   skip one: bc mail block <address or domain>',
              ].join('\n')
            : 'Nothing yet.',
          data: { senders: rows },
        };
      },
    },

    find: {
      summary: 'search senders and subjects, skipped mail included',
      access: 'allow',
      usage: '<text...>',
      options: [['--account <name>', 'only this account']],
      run: (ctx, i) => {
        need(ctx);
        const names = pickAccount(ctx, i.account);
        const words = i.text.join(' ').toLowerCase().split(/\s+/).filter(Boolean);
        const rows = withDb(
          () => openStore(ctx),
          (db) =>
            db
              .prepare(
                `SELECT * FROM mail WHERE account IN (${names.map(() => '?').join(',')}) AND ${words.map(() => "lower(coalesce(subject,'') || ' ' || coalesce(from_name,'') || ' ' || coalesce(from_addr,'')) LIKE ?").join(' AND ')} ORDER BY ts DESC LIMIT 30`,
              )
              .all(...names, ...words.map((w) => `%${w}%`)),
        );
        return {
          text: rows.length
            ? [
                ...rows.map((m) => line(m, names.length > 1)),
                'Read one: bc mail show <id>. To search the text of kept mail: bc msg find <words> --source mail',
              ].join('\n')
            : `No mail's sender or subject matches "${i.text.join(' ')}". To search the text of kept mail: bc msg find ${i.text.join(' ')} --source mail`,
          data: {
            mails: rows.map((m) => ({
              id: `mail:${m.account}:${m.uid}`,
              ts: m.ts,
              from: m.from_addr,
              fromName: m.from_name,
              subject: m.subject,
              kept: !!m.kept,
              reason: m.reason,
            })),
          },
        };
      },
    },

    show: {
      summary: 'the text of one mail (a skipped one is fetched just for this, and not kept)',
      access: 'allow',
      usage: '<id>',
      run: async (ctx, i) => {
        need(ctx);
        const m = /^mail:([a-z0-9_-]+):(\d+)$/.exec(i.id);
        if (!m || !accounts(ctx)[m[1]])
          ctx.fail('The id looks like mail:personal:4812. Get it from: bc mail recent, or bc mail find <words>');
        const row = withDb(
          () => openStore(ctx),
          (db) => db.prepare('SELECT * FROM mail WHERE account = ? AND uid = ?').get(m[1], Number(m[2])),
        );
        if (!row) ctx.fail('There is no such mail (it may be older than what is kept).');
        let text = row.stored ? storedText(m[1], row.uid) : null;
        if (!text) {
          const { texts, withMailbox } = await imap();
          const got = await withMailbox(login(ctx, m[1]), (c) => texts(c, [row.uid])).catch((e) =>
            ctx.fail(`Could not fetch it: ${e.message}.`),
          );
          const files = filesOf(row);
          text = `Subject: ${row.subject || '(no subject)'}\n\n${got.get(row.uid) || '(this mail has no readable text, or it is no longer in the Inbox)'}${files.length ? `\n\n[attached: ${files.map((f) => f.name).join(', ')}]` : ''}`;
        }
        // A kept mail's attachments can be opened: each has an id of its own.
        const files = row.stored ? filesOf(row).map((f, n) => ({ id: `${i.id}:${n + 1}`, name: f.name, type: f.type, size: f.size })) : [];
        if (files.length) text += `\n${files.map((f) => `  ${f.name}: bc msg media ${f.id}`).join('\n')}`;
        return {
          text: `From: ${row.from_name ? `${row.from_name} <${row.from_addr}>` : row.from_addr}\nDate: ${when(row.ts)}\n${text}`,
          data: { id: i.id, from: row.from_addr, fromName: row.from_name, ts: row.ts, kept: !!row.kept, text, attachments: files },
        };
      },
    },

    allow: rule('allow', 'always keep mail from an address or a whole domain'),
    block: rule('block', 'never keep mail from an address or a whole domain'),

    unrule: {
      summary: 'remove a sender from your allow and block lists',
      access: 'ask',
      usage: '<sender...>',
      run: async (ctx, i) => {
        const r = rules(ctx);
        const gone = i.sender.filter((s) => [...r.allow, ...r.block].some((x) => x === s.toLowerCase().replace(/^@/, '')));
        if (!gone.length) ctx.fail(`None of those is on your lists. See: bc mail rules`);
        const strip = (l) => l.filter((x) => !gone.map((g) => g.toLowerCase().replace(/^@/, '')).includes(x));
        ctx.config.set({ allow: strip(r.allow), block: strip(r.block) });
        return `Removed: ${gone.join(', ')}.\n${await reapply(ctx)}`;
      },
    },

    rules: {
      summary: 'how mail is sorted, and your allow and block lists',
      access: 'allow',
      untrusted: false,
      run: (ctx) => {
        const r = rules(ctx);
        return {
          text: [
            'Mail is kept, in this order of precedence, when it is:',
            `  1. not from a sender you blocked:   ${r.block.join(', ') || '(none)'}`,
            `  2. from a sender you chose:          ${r.allow.join(', ') || '(none)'}`,
            '  3. from someone you have written to in the last year',
            '  4. otherwise: not a newsletter, promotion or automatic mail, and (Gmail) in the Primary tab',
            'Everything else is skipped: only its sender, date and subject are kept, never its text.',
          ].join('\n'),
          data: r,
        };
      },
    },
  },

  // Mail as a source of messages in the archive. It is not part of "all chats": a watch reads
  // it by naming the account. A mail is longer than a chat message, so readers are shown more of it.
  // Whose address is this? The name most of its mail came under. (For another plugin to show
  // beside the address: the calendar, for who an invitation is from.)
  names: (ctx, address) => {
    if (!Object.keys(accounts(ctx)).length) return null;
    return withDb(
      () => openStore(ctx),
      (db) => {
        return (
          db
            .prepare(
              "SELECT from_name FROM mail WHERE lower(from_addr) = ? AND from_me = 0 AND from_name IS NOT NULL AND trim(from_name) != '' AND lower(from_name) != lower(from_addr) GROUP BY from_name ORDER BY COUNT(*) DESC, MAX(ts) DESC LIMIT 1",
            )
            .pluck()
            .get(address) ?? null
        );
      },
    );
  },

  source: {
    id: 'mail',
    label: 'Email',
    optIn: true,
    textLimit: 3000,
    todoLimit: 1500,
    todoText: 'kept email',
    todoQuestion:
      'Also look at your email? (Only the mail that is kept: from people, and from senders you chose. Mail another watch reads is left to that watch.)',
    connected: (ctx) => Object.keys(accounts(ctx)).length > 0,
    // One attachment of a kept mail, fetched from the mail server when something asks for it.
    fetchMedia: async (ctx, { row, dest, id }) => {
      try {
        await (await import('./attachments.js')).fetchAttachment(ctx, id, row.direct_path, dest);
      } catch (e) {
        throw new Error(`${e.message}; a mail moved out of the Inbox can no longer be reached`);
      }
    },
  },

  jobs: [
    {
      id: 'sync',
      cron: (ctx) => fromEvery(every(ctx)),
      summary: 'fetch new mail',
      when: (ctx) => Object.keys(accounts(ctx)).length > 0,
      run: async (ctx) => {
        const did = [];
        for (const n of Object.keys(accounts(ctx))) {
          try {
            const r = await syncAccount(ctx, n);
            // (Worth noting only when mail actually arrived: the server often reports a change that brings nothing new.)
            if (r.fresh) did.push(`${n}: ${r.fresh} new, ${r.kept} kept`);
          } catch (e) {
            did.push(`${n}: could not be fetched`);
            // Say so once: straight away when the password was refused, otherwise after an hour of failing.
            const refused = /app password|not accepted/.test(e.message);
            const tell = withDb(
              () => openStore(ctx),
              (db) => {
                const st = stateOf(db, n);
                if (st.told || !(refused || now() - (st.error_since ?? now()) >= TELL_AFTER_S)) return false;
                setState(db, n, { told: 1 });
                return true;
              },
            );
            if (tell)
              await ctx.notify(
                `📭 I can't read your "${n}" mail: ${e.message}. ${refused ? 'Connect it again with a new app password: /setup → Mail, or bc mail add.' : 'I will keep trying.'}`,
              );
            ctx.log(`${n}: ${e.message}`);
          }
        }
        return did.length ? { did: did.join(' · ') } : { idle: true };
      },
    },
  ],

  // `bc selftest`: every account, logged in to and its mailbox looked at. Nothing is fetched or marked.
  selftest: (ctx) =>
    Object.entries(accounts(ctx)).map(([name, a]) => ({
      name: `${name} (${a.address})`,
      run: async () => {
        const { withMailbox, mailboxMark } = await imap();
        const mark = await withMailbox(login(ctx, name), (client) => mailboxMark(client));
        return `logged in · the mailbox answers${mark ? '' : ' (empty)'}`;
      },
    })),

  status: (ctx) => {
    const names = Object.keys(accounts(ctx));
    if (!names.length) return 'no account connected (bc mail add)';
    const { c, bad, last } = withDb(
      () => openStore(ctx),
      (db) => ({
        c: db.prepare('SELECT COUNT(*) AS n, SUM(kept) AS kept FROM mail').get(),
        bad: names.filter((n) => stateOf(db, n).error),
        last: Math.max(0, ...names.map((n) => stateOf(db, n).synced_at ?? 0)),
      }),
    );
    return `${names.length} account${names.length === 1 ? '' : 's'} · ${c.n} mails, ${c.kept ?? 0} kept · ${last ? `fetched ${ago(last)}` : 'not fetched yet'}${bad.length ? ` · NOT UPDATING: ${bad.join(', ')}` : ''}`;
  },
  settings: (ctx) => ({
    'new mail is fetched': EVERY[every(ctx)],
    ...Object.fromEntries(Object.entries(accounts(ctx)).map(([n, a]) => [n, `${a.address} via ${a.host}, the last ${a.days} days`])),
    'always keep': rules(ctx).allow.join(', ') || 'none',
    'never keep': rules(ctx).block.join(', ') || 'none',
  }),

  // For `bc engine check`: what the owner might say, and the command it should lead to.
  checks: (ctx) =>
    Object.keys(accounts(ctx)).length ? [{ say: 'any new mail from the school?', expect: /blackcat mail (recent|find|senders)\b/ }] : [],
  agent: {
    fill: (ctx) => ({
      ready: Object.keys(accounts(ctx)).length > 0,
      every: EVERY[every(ctx)],
      accounts: Object.keys(accounts(ctx)).join(', '),
      chats: Object.keys(accounts(ctx)).map((n) => `    "${chatName(n)}"`),
    }),
  },
};

// After a rule changes, sort the stored mail again and fetch what is now wanted.
async function reapply(ctx) {
  const out = [];
  for (const n of Object.keys(accounts(ctx))) {
    try {
      await syncAccount(ctx, n);
      const c = withDb(
        () => openStore(ctx),
        (db) => db.prepare('SELECT COUNT(*) AS n, SUM(kept) AS kept FROM mail WHERE account = ?').get(n),
      );
      out.push(`${n}: ${c.kept ?? 0} of ${c.n} mails are now kept.`);
    } catch (e) {
      out.push(`${n}: saved, but the mail could not be fetched just now (${e.message}). It applies at the next fetch.`);
    }
  }
  return out.join('\n');
}

function rule(kind, summary) {
  return {
    summary,
    // Keeping a sender puts the text of their mail where the agent can read it.
    access: 'ask',
    usage: '<sender...>',
    run: async (ctx, i) => {
      const bad = i.sender.find((s) => !validRule(s));
      if (bad) ctx.fail(`"${bad}" is not an address or a domain. Use e.g. office@school.example, or school.example for everyone there.`);
      const add = i.sender.map((s) => s.toLowerCase().replace(/^@/, ''));
      const r = rules(ctx);
      const other = kind === 'allow' ? 'block' : 'allow';
      ctx.config.set({ [kind]: [...new Set([...r[kind], ...add])].sort(), [other]: r[other].filter((x) => !add.includes(x)) });
      // How much mail already here it touches.
      const n = withDb(
        () => openStore(ctx),
        (db) =>
          db
            .prepare('SELECT from_addr FROM mail')
            .pluck()
            .all()
            .filter((a) => add.some((x) => matches(x, a))).length,
      );
      return `${kind === 'allow' ? 'Mail from these is now always kept' : 'Mail from these is now never kept'}: ${add.join(', ')} (${n} mail${n === 1 ? '' : 's'} already here).\n${await reapply(ctx)}`;
    },
  };
}
