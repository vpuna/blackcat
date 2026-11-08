// Lists of the owner's own, and the lists watches fill. Part of the framework, described with a
// manifest like a plugin. The lists are kept with the watches (src/watch/db.js): a watch fills
// one, and a list needs no watch.
const cmd = () => import('./commands.js');
const chat = () => import('./chat.js');
const MANY = { many: true };

export default {
  api: 1,
  name: 'list',
  title: 'Lists',
  description: 'lists of your own (spare electronics, groceries, a trip), with the fields you give them; and the lists your watches fill',
  help: `Examples:
  bc list new Electronics --field quantity:number --field specs --field "kept in"
  bc list add Electronics --title "Raspberry Pi 4" --set type=pi --set quantity=2 --set "specs=4 GB"
  bc list show Electronics --by type
  bc list edit 12 --set quantity=3
  bc list mark 12 done                    or open (still to do), drop
  bc list edit 12 --set type=restaurants  move it to another type
  bc list find dentist                    what every list says about something
  bc list link 40 --msg <message-id>      a booking mail, on the flight of a trip
  bc list list --unused 90d               lists nobody has touched in 90 days

Every entry has a title and may have a type, note, date (YYYY-MM-DD), place, area, link and
ref. Anything else is a field you add to the list: text, number or date.`,

  commands: {
    list: {
      summary: 'every list, with when it was last used',
      access: 'allow',
      options: [['--unused <days>', 'only lists not changed or looked at for this long: 90d']],
      run: async (_c, i) => (await cmd()).listAll(i),
    },
    new: {
      changes: true,
      summary: 'make a list',
      access: 'allow',
      usage: '<name...>',
      options: [
        ['--field <name[:kind]>', 'a field of its own: text (the default), number or date, e.g. quantity:number (repeatable)', [], MANY],
      ],
      run: async (_c, i) => (await cmd()).create(i.name, i),
    },
    show: {
      summary: "what's on a list",
      access: 'allow',
      usage: '<list>',
      options: [
        ['--by <field>', 'group by this field (by type, when entries have one)'],
        ['--type <type>', 'only entries of this type'],
        ['--status <which>', 'open, done, dropped, expired, or all (comma-separated)', 'open'],
        ['--find <words>', 'only entries that say all of these words'],
      ],
      run: async (_c, i) => (await cmd()).show(i.list, i),
    },
    find: {
      summary: 'what every list says about something: the entries that say all of these words',
      access: 'allow',
      usage: '<words...>',
      options: [['--status <which>', 'open, done, dropped, expired, or all (comma-separated)', 'open']],
      run: async (_c, i) => (await cmd()).find(i.words, i),
    },
    entry: {
      summary: 'one entry with everything it has, and the messages linked to it',
      access: 'allow',
      usage: '<entry>',
      run: async (_c, i) => (await cmd()).entryCmd(i.entry, i),
    },
    add: {
      changes: true,
      summary: 'put something on a list',
      access: 'allow',
      usage: '<list>',
      options: [
        ['--title <title>', 'what it is'],
        ['--set <name=value>', "a field: type, note, date, place, area, link, ref, or one of the list's own (repeatable)", [], MANY],
        ['--msg <messageId>', 'a message from the archive it comes from (its link and title are used)'],
        ['--file <path>', 'a picture or document that belongs with it'],
        ['--anyway', 'add it even though it looks like something on this list already'],
      ],
      run: async (_c, i) => (await cmd()).add(i.list, i),
    },
    edit: {
      changes: true,
      summary: 'change an entry: its title or any field (it stays the same entry)',
      access: 'allow',
      usage: '<entry>',
      options: [
        ['--title <title>', 'a new title'],
        ['--set <name=value>', 'give a field a value (repeatable)', [], MANY],
        ['--unset <name>', "take a field's value away (repeatable)", [], MANY],
        ['--file <path>', 'a picture or document that belongs with it ("" takes it away)'],
      ],
      run: async (_c, i) => (await cmd()).edit(i.entry, i),
    },
    mark: {
      changes: true,
      summary: 'mark an entry done, open again, or drop it',
      access: 'allow',
      usage: '<entry> <how>',
      run: async (_c, i) => (await cmd()).mark(i.entry, i.how, i),
    },
    field: {
      changes: true,
      summary: "a list's own fields: add, rename or remove one",
      access: 'allow',
      usage: '<list> <action> <field...>',
      run: async (_c, i) => (await cmd()).field(i.list, i.action, i.field, i),
    },
    link: {
      changes: true,
      summary: 'link a message or mail to an entry (or unlink it)',
      access: 'allow',
      usage: '<entry>',
      options: [
        ['--msg <messageId>', 'a message from the archive (repeatable)', [], MANY],
        ['--unlink <messageId>', 'take a link away (repeatable)', [], MANY],
      ],
      run: async (_c, i) => (await cmd()).link(i.entry, i),
    },
    briefing: {
      changes: true,
      summary:
        "put a list's dated entries in the daily briefing on their days, or take them out (a list kept by hand is out until you say)",
      access: 'allow',
      usage: '<list> <onOff>',
      run: async (_c, i) => (await cmd()).briefing(i.list, i.onOff, i),
    },
    rename: {
      changes: true,
      summary: 'give a list a new name',
      access: 'allow',
      usage: '<list> <name...>',
      run: async (_c, i) => (await cmd()).rename(i.list, i.name, i),
    },
    remove: {
      changes: true,
      summary: 'delete a list and everything on it (not one a watch fills)',
      access: 'ask',
      usage: '<list>',
      run: async (_c, i) => (await cmd()).remove(i.list, i),
    },
  },

  // `/list` in the chat: the lists, and a list's entries with buttons.
  chat: {
    commands: [{ command: 'list', description: 'Your lists: open one, tick things off (/list help: its commands)' }],
    install: async (ui) => {
      const t = await chat();
      t.installLists(ui);
      // `/list` alone is the screen. With words after it, it is a command typed in the chat.
      ui.command('list', (c, next) => (String(c.match ?? '').trim() ? next() : t.showLists(c)));
    },
  },
};
