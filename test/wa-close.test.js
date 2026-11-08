// Unlinking or stopping WhatsApp: the connection closing afterwards, as it does a moment
// later, changes nothing. What was said (unlinked, stopped) stands, and nothing falls over
// on a database that is already closed.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { home } from './helpers.js';

home();
await (await import('../src/plugins/registry.js')).loadPlugins(); // (the sources are the plugins')
const db = await import('../src/archive/db.js');
const { startService } = await import('../plugins/wa/service.js');
const state = () => {
  const d = db.openRead();
  try {
    return db.getMeta(d).state;
  } finally {
    d.close();
  }
};

function linked() {
  const ev = new EventEmitter();
  const sock = {
    ev,
    end: () => {},
    ws: { close: () => {} },
    logout: async () => {},
    groupFetchAllParticipating: async () => ({}),
    user: { id: '15550000000:1@s.whatsapp.net' },
  };
  const c = startService({ socketFactory: () => sock, logLevel: 'silent', log: () => {}, requestPollMs: 50 });
  return { c, ev };
}
const closed = (ev) =>
  ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 }, message: 'logged out' } } });

test('unlinked: the close that follows is let be, and it stays unlinked', async () => {
  const { c, ev } = linked();
  await c.ready;
  ev.emit('connection.update', { connection: 'open' });
  assert.equal(state(), 'connected');
  await c.logout();
  assert.doesNotThrow(() => closed(ev));
  assert.equal(state(), 'unlinked');
});

test('stopped: the same', async () => {
  const { c, ev } = linked();
  await c.ready;
  ev.emit('connection.update', { connection: 'open' });
  await c.stop();
  assert.doesNotThrow(() => closed(ev));
  assert.equal(state(), 'stopped');
});

// (W10 of the audit of 2026-10-24: stopping slept half a second before closing the databases,
// whether anything was still being written or not.)
test('stopped: what is still being written is waited for, and nothing is waited for when nothing is', async () => {
  const ev = new EventEmitter();
  let names;
  const sock = {
    ev,
    end: () => {},
    ws: { close: () => {} },
    logout: async () => {},
    groupFetchAllParticipating: () => new Promise((ok) => (names = ok)),
    user: { id: '15550000000:1@s.whatsapp.net' },
  };
  const c = startService({ socketFactory: () => sock, logLevel: 'silent', log: () => {}, requestPollMs: 50 });
  await c.ready;
  ev.emit('connection.update', { connection: 'open' });
  let stoppedAt = null;
  const stopping = c.stop().then(() => (stoppedAt = Date.now()));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(stoppedAt, null, 'still waiting for the group names asked for');
  names({ 'g1@g.us': { id: 'g1@g.us', subject: 'Book club' } });
  await stopping;
  const d = db.openRead();
  try {
    assert.equal(d.prepare("SELECT name FROM chats WHERE ref = 'wa:g1@g.us'").pluck().get(), 'Book club', 'and written');
  } finally {
    d.close();
  }
  assert.doesNotThrow(() => ev.emit('messages.upsert', { messages: [], type: 'notify' }), 'what arrives after is not written');
  const quick = linked();
  await quick.c.ready;
  const t0 = Date.now();
  await quick.c.stop();
  assert.ok(Date.now() - t0 < 300, `nothing to wait for: stopped at once (${Date.now() - t0} ms)`);
});
