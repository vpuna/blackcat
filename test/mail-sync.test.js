// A scheduled mail fetch runs every five minutes and nearly always finds nothing. It may
// stop after one look at the mailbox only when that is certain to change nothing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FULL_EVERY_S, unchanged } from '../plugins/mail/rules.js';

const nowS = 1_800_000_000;
const seen = '2:167782:121534:17646932|30|{"allow":[],"block":[]}';
const base = { state: { mark: seen, full_at: nowS - 600 }, seen, waiting: 0, knownDue: false, full: false, nowS };

test('stops early only when the mailbox, the rules and the work left are all as they were', () => {
  assert.equal(unchanged(base), true);
  // a mail arrived (next number moved on), one was deleted (count), one was moved or relabelled (change counter)
  for (const other of ['2:167783:121535:17646940', '2:167782:121533:17646935', '2:167782:121534:17646933', '3:1:0:1']) {
    assert.equal(unchanged({ ...base, seen: seen.replace(/^[^|]+/, other) }), false, other);
  }
  // the owner changed a rule, or how far back mail is kept
  assert.equal(unchanged({ ...base, seen: seen.replace('"allow":[]', '"allow":["school.example"]') }), false);
  assert.equal(unchanged({ ...base, seen: seen.replace('|30|', '|7|') }), false);
  // a kept mail still has no text; the list of people written to is due; asked for by hand
  assert.equal(unchanged({ ...base, waiting: 1 }), false);
  assert.equal(unchanged({ ...base, knownDue: true }), false);
  assert.equal(unchanged({ ...base, full: true }), false);
  // never fetched before, or stored before this existed
  assert.equal(unchanged({ ...base, state: { account: 'new' } }), false);
  assert.equal(unchanged({ ...base, state: { mark: null, full_at: nowS } }), false);
  // however unchanged it looks, everything is gone through every few hours
  assert.equal(unchanged({ ...base, state: { mark: seen, full_at: nowS - FULL_EVERY_S + 1 } }), true);
  assert.equal(unchanged({ ...base, state: { mark: seen, full_at: nowS - FULL_EVERY_S } }), false);
});

test('the mail parsers are not loaded just to look at a mailbox', async () => {
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../plugins/mail/imap.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(src, /^import .* from 'mailparser'/m);
  assert.doesNotMatch(src, /^import .* from 'html-to-text'/m);
  assert.match(src, /import\('mailparser'\)/);
});

test('an account whose password is not saved is said so at once, and the mail server is never tried', async () => {
  const { home } = await import('./helpers.js');
  const dir = home();
  const { save } = await import('../src/config.js');
  // An address nothing answers on: reaching for it would take seconds; it must not be reached for.
  save({
    plugins: {
      enabled: ['mail'],
      settings: { mail: { accounts: { home: { address: 'me@example.com', host: '10.255.255.1', days: 30 } } } },
    },
  });
  const { spawn } = await import('node:child_process');
  const root = new URL('..', import.meta.url).pathname;
  const t0 = Date.now();
  const r = await new Promise((resolve) => {
    const c = spawn(process.execPath, [`${root}bin/bc.js`, 'mail', 'sync'], { env: { ...process.env, BLACKCAT_HOME: dir } });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('close', (code) => resolve({ code, out }));
  });
  assert.ok(Date.now() - t0 < 8000, `it took ${Date.now() - t0} ms`);
  assert.match(r.out, /no app password is saved for "home" \(connect it again: bc mail add\)/);

  // Going through the mail again: the same fetch, made in full, for the days the account fetches.
  const { spawnSync } = await import('node:child_process');
  const bc = (...args) =>
    spawnSync(process.execPath, [`${root}bin/bc.js`, 'mail', ...args], { encoding: 'utf8', env: { ...process.env, BLACKCAT_HOME: dir } });
  assert.match(
    bc('recover').stdout,
    /home: could not be fetched: no app password is saved for "home"/,
    'it reaches for the account as a fetch does',
  );
  // How far back mail is fetched is changed for one account, with nothing else of it; only the
  // lengths on offer. Further back is fetched at once (here it cannot be: no password).
  const kept = bc('history', 'home', '180', '--json');
  const { account, days, was } = JSON.parse(kept.stdout);
  assert.deepEqual({ account, days, was }, { account: 'home', days: 180, was: 30 }, kept.stderr);
  assert.match(bc('history', 'home', '180').stdout, /home: mail is fetched 6 months back from now on; what is stored is kept\.$/m);
  assert.match(bc('list').stdout, /home: me@example\.com · fetched 180 days back/);
  assert.notEqual(bc('history', 'home', '45').status, 0);
  assert.doesNotMatch(bc('history', 'home', '30').stdout, /forgotten|deleted/, 'fewer days delete nothing');
  const { recent } = await import('../src/activity/log.js');
  assert.ok(
    recent({ category: 'messages: mail' }).some((e) => e.summary === 'mail home: fetched 30 days back (was 180)'),
    'each change on the record',
  );
  await (await import('../src/plugins/registry.js')).loadPlugins();
  const { decide } = await import('../src/agent/policy.js');
  assert.equal(decide('Bash', { command: 'blackcat mail history home 180 --json' }).action, 'ask');
  assert.notEqual(bc('recover', '--since', '90d').status, 0, "how far back is the account's, not asked for");
  assert.match(bc('recover', '--help').stdout, /go through the mail of the days fetched again/);
});

test('how often new mail is fetched is a setting: every 5 minutes until chosen, and the job, the notes and the settings follow it', async () => {
  const { spawnSync } = await import('node:child_process');
  const root = new URL('..', import.meta.url).pathname;
  const { FORCE_COLOR: _f, ...env } = process.env;
  const bc = (...args) => spawnSync(process.execPath, [`${root}bin/bc.js`, ...args], { encoding: 'utf8', env });
  const { loadPlugins, makeCtx } = await import('../src/plugins/registry.js');
  const { jobSchedule } = await import('../src/util/schedule.js');
  const { notesOf } = await import('../src/plugins/notes.js');
  const mail = (await loadPlugins()).find((p) => p.name === 'mail');
  const job = mail.manifest.jobs.find((j) => j.id === 'sync');
  const cron = () => jobSchedule(job, makeCtx(mail, { caller: 'job' }));
  assert.deepEqual(cron(), ['*/5 * * * *']);
  assert.match(notesOf(mail, makeCtx(mail, { caller: 'agent' })), /are read over IMAP every 5 minutes, read-only/);

  const set = bc('mail', 'setup', '--every', '1h', '--json');
  assert.equal(JSON.parse(set.stdout).every, '1h', set.stderr);
  assert.deepEqual(cron(), ['0 * * * *']);
  assert.match(notesOf(mail, makeCtx(mail, { caller: 'agent' })), /are read over IMAP every hour, read-only/);
  assert.match(bc('mail', 'settings').stdout, /new mail is fetched: every hour/);
  // the account is still there: one setting was changed, not the rest
  assert.match(bc('mail', 'settings').stdout, /me@example\.com via 10\.255\.255\.1/);
  // only the lengths on offer; and a value in the settings file that is none of them counts as the usual one
  assert.match(
    bc('mail', 'setup', '--every', '2m').stderr + bc('mail', 'setup', '--every', '2m').stdout,
    /5m, 15m, 30m, 1h|one of|Choose/i,
  );
  assert.deepEqual(cron(), ['0 * * * *']);
  // the agent may change it, with the owner's say each time
  const { decide } = await import('../src/agent/policy.js');
  assert.equal(decide('Bash', { command: 'blackcat mail setup --every 30m --json' }).action, 'ask');
});
