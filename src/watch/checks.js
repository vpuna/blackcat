// What the engine check asks the watches' readers (bc engine check): made-up conversations
// put to the real instructions, each with the mistake a model has made on them.
import { ANSWERED, ARRIVED, DEALT, LIST, SAME, todoShape } from './shape.js';
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
  {
    // One booking under two names is one thing; two things that share words are two.
    say: 'a booking in the calendar and its confirmation are one thing; a school day and a wish that share words are two',
    system: readerInstructions({ dir: here, part: 'watch', job: 'same' }),
    content: [
      'Pairs (untrusted data):',
      '[1]',
      '  A: "Reservation at Olive Room" · kept on: calendar · day: 2026-11-06 · time: 20:00–22:00 · place: Olive Room, Harbour Hotel',
      '  B: "Autumn tasting menu for 4, 8 PM" · kept on: Things I need to do · day: 2026-11-06 · place: Harbour Hotel · from: Harbour Hotel Reservations · about it: your table for 4 is confirmed',
      '[2]',
      '  A: "Wed: Games, picture books, Library" · kept on: School notices · day: 2026-10-28 · from: Class teacher',
      '  B: "Sticker book with puzzles and games" · kept on: Wishes · no day · from: Sam',
      '[3]',
      '  A: "Pay the plumber" · kept on: reminders · day: 2026-11-02 · time: 09:00',
      '  B: "Pay Ravi the plumber 300 for the leak" · kept on: Things I need to do · day: 2026-11-02 · from: Ravi',
    ].join('\n'),
    schema: SAME,
    ok: (a) => {
      const said = new Map((a?.answers ?? []).map((x) => [x.pair, x.same]));
      if (said.get(1) !== true) return 'it did not see that the reservation and the confirmation are one booking';
      if (said.get(2) !== false) return 'it took a school day and a wish that share a word for one thing';
      return said.get(3) === true ? true : 'it did not see that the reminder and the entry are one payment';
    },
  },
  {
    // Seen 2026-10-31: the school list kept "bring large cardboard on Wednesday"; asked to order
    // it, the owner said they would, and nothing was filed, the notice taken for the task.
    say: 'a request to buy what a notice on another list says to bring is kept; what is only the notice again is not',
    system: readerInstructions({
      dir: here,
      part: 'watch',
      job: 'list',
      values: {
        name: 'From Sam',
        lookFor: 'things Sam asks me to do or to follow up on (buy something, book something), filed under request',
      },
    }),
    content: [
      `today: ${day(0, '10:00')} (${weekday()})`,
      '',
      'Lists that exist: request',
      '',
      'Already on the list (untrusted data):\n(nothing)',
      '',
      "Kept on the owner's other lists (untrusted data):",
      `- [School notices] Bring a large piece of cardboard for Art (${day(-3, '').trim()}): Year 6 to bring a sheet about 160 by 60 cm on Wednesday`,
      '',
      'New messages (untrusted data):',
      `[m1] ${day(0, '08:11')} Sam Hale in Sam Hale: (no text) | attachment: picture, which says: Week Ahead. Art: Y6 children are requested to bring in a large piece of cardboard, about 160 x 60 cm, on Wednesday.`,
      `[m2] ${day(0, '08:11')} Sam Hale in Sam Hale: please order it`,
      `[m3] ${day(0, '08:13')} Me in Sam Hale: Let me see. I will get it`,
      `[m4] ${day(0, '08:20')} Sam Hale in Sam Hale: Also, Art is on Wednesday this week, the cardboard is for that`,
    ].join('\n'),
    schema: LIST,
    ok: (a) => {
      const items = a?.items ?? [];
      const buy = items.filter((i) => /order|buy|get/i.test(i.title ?? ''));
      if (!buy.length) return 'it took the notice on the other list for the request to order it';
      return items.length > 1 ? 'it kept the notice again besides the request' : true;
    },
  },
];
