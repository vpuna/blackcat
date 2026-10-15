// The shape of what a reader gives a watch. One definition of an entry for a list, whichever
// reader fills it in: each job asks for the fields it needs, under the same names, and those
// are the names of the list's own columns. (What each field means is said here, where the
// model sees it with the shape; how to decide what belongs is in readers/*.md.)
const DAY = '^\\d{4}-\\d{2}-\\d{2}$';
const MOMENT = '^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$';

export const FIELDS = {
  message_id: {
    type: 'string',
    description: 'Which message this comes from: what stands in square brackets before it, exactly as given (for example m4).',
  },
  title: { type: 'string', description: 'A short name for the thing, which stands on its own.' },
  category: { type: 'string', description: 'What it is filed under.' },
  summary: { type: ['string', 'null'], description: 'One sentence about it.' },
  place: { type: ['string', 'null'], description: 'The venue or business, if one is named.' },
  area: { type: ['string', 'null'], description: 'The neighbourhood or city, if one is named.' },
  event_date: {
    type: ['string', 'null'],
    pattern: DAY,
    description: 'The day it happens, as YYYY-MM-DD, if it happens on a particular day.',
  },
  nudge_at: {
    type: ['string', 'null'],
    pattern: MOMENT,
    description: 'When the owner should be nudged about it, local time, as YYYY-MM-DD HH:MM.',
  },
  confidence: { type: 'number', minimum: 0, maximum: 1, description: 'How sure you are, from 0 to 1.' },
  existing_id: {
    type: ['integer', 'null'],
    description: 'Only for an update to an entry already on the list: its #id, as a number. Leave out for a new thing.',
  },
  changed: { type: ['boolean', 'null'], description: 'Only for an update: true when the date, time or place moved, or it was cancelled.' },
};
const pick = (names, over = {}) => Object.fromEntries(names.map((n) => [n, { ...FIELDS[n], ...over[n] }]));
const listOf = (item, max) => ({
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: { type: 'array', ...(max ? { maxItems: max } : {}), items: { type: 'object', additionalProperties: false, ...item } },
  },
});

// A watch judging new messages for its list: new entries, and updates to ones already there.
export const LIST = listOf({
  properties: pick(['message_id', 'title', 'category', 'place', 'area', 'event_date', 'summary', 'confidence', 'existing_id', 'changed'], {
    category: { description: 'The list it is filed under: one or two lowercase words in the singular.' },
  }),
  required: ['message_id'],
});

// "Things I need to do": what it is, of which kind, and when to nudge. An event also says the
// day it is on and where, like an entry on any other list.
export const TODO_KINDS = ['note to self', 'event', 'commitment', 'reply', 'waiting', 'deadline', 'other'];
// What the owner is waiting on somebody else for: kept quietly until its time, then looked at again.
export const WAITING = 'waiting';
export const todoShape = (max) =>
  listOf(
    {
      properties: pick(['message_id', 'title', 'category', 'summary', 'nudge_at', 'event_date', 'place', 'confidence'], {
        category: { enum: TODO_KINDS, description: 'Which kind of thing it is.' },
        summary: { type: 'string', description: 'One short clause: why it is there.' },
        nudge_at: { type: 'string' },
        event_date: { description: 'For an event only: the day it is on, as YYYY-MM-DD.' },
        place: { description: 'For an event only: where it is, if the message says.' },
      }),
      required: ['message_id', 'title', 'category', 'nudge_at', 'confidence'],
    },
    max,
  );

// What a reader said something came to, as it is kept with an entry: without the lead-in
// that is put before it here ("Since then: …"), and never cut in the middle of a word.
export function clause(v, max = 200) {
  if (typeof v !== 'string') return null;
  let s = v
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(since then|answered)\s*[:,]\s*/i, '');
  if (!s || s.toLowerCase() === 'null') return null;
  if (s.length <= max) return s;
  s = s.slice(0, max - 1);
  const stop = Math.max(s.lastIndexOf('. '), s.lastIndexOf('; '));
  // (At the end of a sentence where one ends late enough; otherwise at the last whole word.)
  if (stop > max * 0.6) return s.slice(0, stop + 1);
  return `${s.slice(0, Math.max(s.lastIndexOf(' '), 1)).replace(/[\s,;:]+$/, '')}…`;
}

// Tidying a list: the groups of entries that are the same thing.
export const TIDY = {
  type: 'object',
  additionalProperties: false,
  required: ['groups'],
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ids'],
        properties: {
          ids: { type: 'array', items: { type: 'integer' }, description: 'The #ids of the entries that are the same thing, as numbers.' },
          event_date: FIELDS.event_date,
          place: FIELDS.place,
          summary: { type: ['string', 'null'], description: 'One sentence combining the details of all of them.' },
        },
      },
    },
  },
};

// Looking again at something the owner asked of somebody: where does it stand now?
export const ANSWERED = {
  type: 'object',
  additionalProperties: false,
  required: ['state', 'by', 'why'],
  properties: {
    state: {
      enum: ['answered', 'later', 'waiting'],
      description:
        'answered: the owner has what they were waiting for, or has been told it will not happen. later: it was put off, or promised, for a later time that was named. waiting: neither.',
    },
    by: {
      type: ['string', 'null'],
      description: 'Only for "later": the time it is now expected by, as YYYY-MM-DD HH:MM (18:00 when only a day was named).',
    },
    why: {
      type: 'string',
      description:
        'One short clause, under 150 characters: what it came to, what was promised and for when, or why it is still open. Do not begin it with "Since then" or "Answered".',
    },
  },
};
