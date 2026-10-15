import { ownerDid } from '../activity/log.js';
import { openAgentDb } from '../agentdb.js';
import { upgrade, withDb } from '../db.js';

// Standing answers the owner has given to an approval prompt: "always allow" or "never
// allow" for one exact command. The agent can neither read nor change them; the owner
// reviews and revokes rules with /permissions in the bot or `bc permissions`.
//
// Kept in agent.db: an answer given in the chat and one given in a terminal at the same
// moment are both kept, and a crash cannot leave half a list.

const norm = (cmd) => String(cmd ?? '').trim();

const STEPS = [
  (db) =>
    db.exec(`CREATE TABLE permissions (
    id      INTEGER PRIMARY KEY,
    effect  TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
    command TEXT NOT NULL UNIQUE,
    created INTEGER NOT NULL,
    via     TEXT)`),
];
function open() {
  const db = openAgentDb();
  upgrade(db, 'permissions', STEPS, { base: 3, owns: ['permissions'] });
  return db;
}

export const listRules = () =>
  withDb(open, (db) => db.prepare('SELECT id, effect, command, created, via FROM permissions ORDER BY id').all());

// The rule for this exact command, if the owner has given one.
export const ruleFor = (command) =>
  withDb(
    open,
    (db) => db.prepare('SELECT id, effect, command, created, via FROM permissions WHERE command = ?').get(norm(command)) ?? null,
  );

// effect: 'allow' | 'deny'. A new answer for the same command replaces the old one.
export function addRule(effect, command, { via = 'chat' } = {}) {
  if (!['allow', 'deny'].includes(effect) || !norm(command))
    throw new Error('a standing permission needs an effect (allow or deny) and a command');
  // (On the record: what the agent may always or never do without asking is the owner's to give.)
  ownerDid('standing permission', `${effect === 'allow' ? 'always allow' : 'never allow'}: ${norm(command).slice(0, 120)}`, {
    data: { via },
  });
  return withDb(open, (db) =>
    db
      .transaction(() => {
        db.prepare('DELETE FROM permissions WHERE command = ?').run(norm(command));
        const id = (db.prepare('SELECT MAX(id) FROM permissions').pluck().get() ?? 0) + 1;
        const rule = { id, effect, command: norm(command), created: Math.floor(Date.now() / 1000), via };
        db.prepare('INSERT INTO permissions (id, effect, command, created, via) VALUES (@id, @effect, @command, @created, @via)').run(rule);
        return rule;
      })
      .immediate(),
  );
}

export function removeRule(id) {
  const gone = withDb(open, (db) =>
    db
      .transaction(() => {
        const rule = db.prepare('SELECT id, effect, command, created, via FROM permissions WHERE id = ?').get(Number(id));
        if (rule) db.prepare('DELETE FROM permissions WHERE id = ?').run(rule.id);
        return rule ?? null;
      })
      .immediate(),
  );
  if (gone)
    ownerDid('standing permission', `removed "${gone.effect === 'allow' ? 'always allow' : 'never allow'}": ${gone.command.slice(0, 120)}`);
  return gone;
}

export const clearRules = () => withDb(open, (db) => db.prepare('DELETE FROM permissions').run().changes);

// `bc permissions`
export async function show(opts) {
  const rules = listRules();
  if (opts.json) return console.log(JSON.stringify(rules, null, 2));
  const pc = (await import('picocolors')).default;
  if (!rules.length) return console.log('No standing permissions. Every action that needs approval asks you each time.');
  for (const r of rules) {
    console.log(
      `${String(r.id).padStart(3)}  ${r.effect === 'allow' ? pc.green('always allow') : pc.red('never allow ')}  ${pc.dim(new Date(r.created * 1000).toISOString().slice(0, 10))}`,
    );
    console.log(`     ${r.command}`);
  }
  console.log(pc.dim('\nRemove one: bc permissions remove <id>   (it will ask you again next time)'));
}

export function remove(id) {
  const r = removeRule(id);
  console.log(r ? `Removed. blackcat will ask again before: ${r.command}` : `No permission ${id}. See: bc permissions`);
}

export function clear() {
  const n = clearRules();
  ownerDid('standing permission', `removed all (${n})`);
  console.log(`Removed ${n} standing permission(s).`);
}
