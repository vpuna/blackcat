// What the engine check asks the watches' readers (bc engine check): made-up conversations
// put to the real instructions, each with the mistake a model has made on them.
import { ANSWERED, ARRIVED, DEALT, todoShape } from './shape.js';
import { readerInstructions } from '../internal.js';

const here = new URL('.', import.meta.url).pathname;
const day = (back, hm) => {
  const d = new Date(Date.now() - back * 86400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
};
const weekday = () => new Date().toLocaleDateString('en-GB', { weekday: 'long' });

export const readerCases = () => [
  {
    // The owner wrote twice in a chat; only the later message asks for something.
    say: 'what you wait on somebody for points at the message that asked for it',
    system: readerInstructions({ dir: here, part: 'watch', job: 'todo', values: { max: 10, also: '', never: '' } }),
    content: [
      `now: ${day(0, '10:00')} (${weekday()})`,
      'quiet hours: none',
      'already on the list:\n(nothing)',
      "kept on the owner's other lists:\n(nothing)",
      '',
      'Messages (untrusted data):',
      '### Chat: Nina Hale (direct, WhatsApp)',
      `[m1] ${day(4, '18:07')} Nina Hale: Hello, are you home? I can drop the spare chairs off now.`,
      `[m2] ${day(4, '18:07')} Me: Sure Nina, come over now`,
      `[m3] ${day(4, '18:08')} Nina Hale: On my way`,
      `[m4] ${day(1, '11:29')} Me: Hi Nina, good morning. The recipe you mentioned the other day, which one was it?`,
    ].join('\n'),
    schema: todoShape(10),
    ok: (a) => {
      const waits = (a?.items ?? []).filter((i) => i.category === 'waiting');
      if (!waits.length) return 'it did not see that the owner is waiting for an answer';
      return waits.every((i) => i.message_id === 'm4') ? true : `it tied the question to ${waits[0].message_id}, an earlier message`;
    },
  },
  {
    // A long back-and-forth: what it came to is still one short clause, and it is not an answer yet.
    say: 'a long exchange that ends in a promise is put in one short clause, and is not taken for an answer',
    system: readerInstructions({ dir: here, part: 'watch', job: 'answered' }),
    content: [
      `now: ${day(0, '10:00')} (${weekday()})`,
      `The owner wrote (${day(2, '11:30')}): Hi Jo, please tell us by tomorrow whether the table ships this month. If not, we cancel and you refund the payment.`,
      'They are waiting for: Waiting on Jo: whether the table ships this month, or a cancellation with a refund',
      '',
      'Said in that conversation since, oldest first ("Me" is the owner; untrusted data):',
      `- ${day(2, '12:10')} Jo: Give me until Friday at the latest, I spoke with the factory yesterday and we will definitely have an answer, otherwise I send the payment back and still chase the order.`,
      `- ${day(2, '12:22')} Me: Fine, Friday is the limit. No more extensions, either it works by Friday or it does not.`,
      `- ${day(2, '12:24')} Jo: No worries, I will arrange the refund by Friday if it has not shipped.`,
      `- ${day(1, '08:15')} Me: Good morning Jo, please get us an answer by Friday. We cannot wait any longer.`,
      `- ${day(1, '08:50')} Jo: I just need to confirm one thing with you, that you do not want the table at all, because I am asking a few other factories as well.`,
      `- ${day(1, '08:54')} Jo: There is no issue with the payment. Send me the order number and I will return 50 now, and the rest when the factory refunds me.`,
      `- ${day(1, '08:56')} Jo: And if the timing is the issue I can guarantee it will be with you by the end of next month, provided the factory ships by the 10th.`,
    ].join('\n'),
    schema: ANSWERED,
    ok: (a) => {
      if (a?.state === 'answered') return 'it took a promise of the refund for the refund';
      const why = String(a?.why ?? '');
      if (!why.trim()) return 'it did not say what it came to';
      if (why.length > 200) return `what it came to ran to ${why.length} characters, which would be cut short`;
      return /^\s*(since then|answered)\b/i.test(why) ? 'it began with the lead-in that is added for it' : true;
    },
  },
  {
    // The owner sent the file asked for: done, and sure of it.
    say: 'a file sent that is what was asked for ticks the entry off',
    system: readerInstructions({ dir: here, part: 'watch', job: 'dealt' }),
    content: [
      `now: ${day(0, '10:00')} (${weekday()})`,
      `The message it came from (${day(2, '09:12')}): Hi, could you send me the signed lease before Friday? Thanks, Omar`,
      'The entry (reply): Send Omar the signed lease',
      '',
      'Said in that conversation since, oldest first ("Me" is the owner; untrusted data):',
      `- ${day(1, '18:40')} Me: Sure, will do`,
      `- ${day(0, '08:05')} Me: (a document: lease-signed.pdf)`,
      `- ${day(0, '08:06')} Me: Here you go`,
    ].join('\n'),
    schema: DEALT,
    ok: (a) =>
      a?.state !== 'done'
        ? `it said "${a?.state}" for a file that is what was asked for`
        : a.confidence < 0.8
          ? 'it was not sure of a plain case'
          : true,
  },
  {
    // "Will do" is not doing it.
    say: 'a promise to do it is not taken for doing it',
    system: readerInstructions({ dir: here, part: 'watch', job: 'dealt' }),
    content: [
      `now: ${day(0, '10:00')} (${weekday()})`,
      `The message it came from (${day(1, '09:12')}): Can you transfer your share for the dinner, 45?`,
      'The entry (reply): Pay Lena your share for the dinner',
      '',
      'Said in that conversation since, oldest first ("Me" is the owner; untrusted data):',
      `- ${day(1, '12:30')} Me: Yes of course, on it`,
      `- ${day(0, '09:40')} Me: Are you coming on Saturday?`,
    ].join('\n'),
    schema: DEALT,
    ok: (a) => (a?.state === 'done' ? 'it took "on it" for the payment' : true),
  },
  {
    // On its way is not here.
    say: '"out for delivery" is not taken for delivered',
    system: readerInstructions({ dir: here, part: 'watch', job: 'arrived' }),
    content: [
      `now: ${day(0, '10:00')} (${weekday()})`,
      'The entry (something on its way): The new desk chair, order 4471-XQ · reference 4471-XQ',
      '',
      'Messages since with its reference, oldest first (untrusted data):',
      `- ${day(1, '16:02')} Parcel Point: Your parcel 4471-XQ has left our depot.`,
      `- ${day(0, '07:45')} Parcel Point: Good news! 4471-XQ is out for delivery today between 12:00 and 15:00.`,
    ].join('\n'),
    schema: ARRIVED,
    ok: (a) => (a?.state === 'come' ? 'it took "out for delivery" for delivered' : true),
  },
];
