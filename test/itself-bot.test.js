// The check "blackcat health" in Telegram: what it found arrives as an alert with buttons, and
// "I fixed it" closes it, since what came before the fix no longer counts.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { home } from './helpers.js';
import { startBot } from './support/bot.js';

const dir = home();
let bot;
let tg;
before(async () => {
  // Something failing again and again, already on the record when blackcat starts.
  const { openActivityDb } = await import('../src/activity/log.js');
  const db = openActivityDb();
  const put = db.prepare(
    "INSERT INTO activity (ts, kind, category, surface, ok, summary, who, lead) VALUES (?, 'job', 'mail/sync', 'job', 0, 'could not reach the server', 'blackcat', 1)",
  );
  for (let k = 0; k < 3; k++) put.run(Math.floor(Date.now() / 1000) - 600 + k);
  db.close();
  bot = await startBot(dir, { itself: true });
  tg = bot.tg;
});
after(() => bot?.stop());

test('an alert from "blackcat health" has buttons, and "I fixed it" closes what it found', async () => {
  const alert = await tg.next((c) => c.method === 'sendMessage' && /blackcat health/.test(c.text ?? ''), { ms: 90_000 });
  assert.equal(alert.text, '⚠️ blackcat health: mail/sync failed 3 times in the last day, the latest: could not reach the server.');
  assert.deepEqual(tg.buttons(alert), ['😴 Snooze', '🛠 I fixed it']);
  const mark = tg.mark();
  tg.tap(alert, 'I fixed it');
  const answer = await tg.next((c) => c.method === 'sendMessage' && /working/.test(c.text ?? ''), { after: mark, ms: 30_000 });
  assert.match(answer.text, /^✅ blackcat health: working again\./);
});
