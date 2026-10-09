// The shape of what a reader gives a watch. One definition of an entry for a list, whichever
// reader fills it in: each job asks for the fields it needs, under the same names, and those
// are the names of the list's own columns. (What each field means is said here, where the
// model sees it with the shape; how to decide what belongs is in readers/*.md.)
const DAY = '^\\d{4}-\\d{2}-\\d{2}$';
const MOMENT = '^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$';

export const FIELDS = {
  message_id: { type: 'string', description: 'The id of the message this comes from, exactly as given in square brackets.' },
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
export const TODO_KINDS = ['note to self', 'event', 'commitment', 'reply', 'deadline', 'other'];
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
