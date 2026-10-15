// Unlinking or stopping WhatsApp: the connection closing afterwards, as it does a moment
// later, changes nothing. What was said (unlinked, stopped) stands, and nothing falls over
// on a database that is already closed.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { home } from './helpers.js';

home();
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
