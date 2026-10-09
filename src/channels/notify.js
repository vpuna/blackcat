// `bc notify`: a message to the owner from outside blackcat: a script, a cron job, another
// program on this machine. It goes to the channel in use, like anything blackcat says by
// itself. It is the owner's (and their programs'): the agent has its own way of answering.
import { activeName, labelOf } from './registry.js';
import { record as recordActivity } from '../activity/log.js';
import { notifyOwner } from './send.js';

const fromStdin = () =>
  new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (text += d));
    process.stdin.on('end', () => resolve(text));
    process.stdin.on('error', () => resolve(text));
    return undefined;
  });

// Who a message is from: a short name the sender gives itself ("backup", "media server").
// It is a label for the owner and the record, not proof: anything running as the owner on
// this machine can give any name.
const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,29}$/;

export async function notify(words, opts) {
  const done = (ok, said, code) => {
    if (opts.json) console.log(JSON.stringify({ sent: ok, ...(ok ? { channel: activeName(), from: opts.from } : { why: said }) }));
    else (ok ? console.log : console.error)(said);
    process.exit(code);
  };
  if (process.env.BLACKCAT_CALLER === 'agent')
    done(false, 'bc notify is for you and your own programs. The agent answers in the conversation.', 1);
  const from = String(opts.from ?? '').trim();
  if (!from) done(false, 'Say who it is from: bc notify --from backup "the backup finished"', 2);
  if (!NAME.test(from)) done(false, '--from is a short name: letters, digits, spaces, dots, dashes; up to 30 characters.', 2);
  const text = (words.length ? words.join(' ') : await fromStdin()).trim();
  if (!text)
    done(
      false,
      'Say what to send: bc notify --from backup "the backup finished", or pipe it in: some-command | bc notify --from backup',
      2,
    );
  // Every one is noted, sent or not: who it said it was from, and how long it was. Never what it said.
  const t0 = Date.now();
  const note = (ok, why) =>
    recordActivity({
      kind: 'sent',
      category: `notify: ${from}`,
      surface: 'job',
      ok,
      ms: Date.now() - t0,
      summary: ok ? `sent (${text.length} character${text.length === 1 ? '' : 's'})` : `not sent: ${why}`,
      data: { from, chars: text.length },
    });
  if (!activeName()) {
    note(false, 'no channel is in use');
    done(false, 'No channel is in use, so there is nowhere to send it. See: bc channel', 3);
  }
  const sent = await notifyOwner(`${from}: ${text}`);
  if (!sent) {
    note(false, `${labelOf(activeName())} did not take it`);
    done(false, `It could not be sent through ${labelOf(activeName())}. See: bc status`, 3);
  }
  note(true);
  done(true, `Sent to you through ${labelOf(activeName())}.`, 0);
}
