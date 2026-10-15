// `bc activity …`: reading the activity record.
import pc from 'picocolors';
import { KINDS, clear as wipe, ofWork, recent as read, settings, slowest, split, timings as timed, totals } from './log.js';
import { sinceTs as since } from '../util/when.js';
import { count, plural, took, usd } from '../util/format.js';

const at = (ts) =>
  new Date(ts * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const COST_NOTE = 'Cost is the list price of each call: a measure of how much of the plan it used, not a charge.';

// One entry, as a line a person can read.
function line(e, showCost) {
  const d = e.data;
  if (e.kind === 'model') {
    const bits = [
      e.model,
      `${count(e.tokens_in + e.cache_read + e.cache_write)} in (${count(e.cache_read)} reused)`,
      `${count(e.tokens_out)} out`,
      showCost && e.cost != null ? usd(e.cost) : null,
      d.steps > 1 ? `${d.steps} steps` : null,
      d.commands ? `${plural(d.commands, 'command')} (${took(d.commandMs)})` : null,
      d.waitedForYouMs ? `waited ${took(d.waitedForYouMs)} for you` : null,
      d.queuedMs ? `${took(d.queuedMs)} behind an earlier message` : null,
      d.waitedS ? `reached blackcat ${took(d.waitedS * 1000)} after it was written` : null,
      d.newConversation ? 'new conversation' : null,
      d.contextUsed >= 50 ? `conversation ${d.contextUsed}% full` : null,
      d.stopped ? `stopped: ${d.stopped}` : null,
      d.refused ? `${d.refused} refused` : null,
      e.summary,
    ].filter(Boolean);
    return `${e.category} · ${bits.join(' · ')}`;
  }
  if (e.kind === 'command')
    return `${e.summary}${d.decision && d.decision !== 'allowed' ? ` · ${d.decision}` : ''}${d.waitedForYouMs ? ` · waited ${took(d.waitedForYouMs)} for you` : ''}`;
  const more = [
    d.error ? d.error : null,
    d.lateS ? `${took(d.lateS * 1000)} late` : null,
    d.waitedS ? `reached blackcat ${took(d.waitedS * 1000)} after it was written` : null,
    d.by === 'agent' ? 'left to the agent' : null,
    d.unknown ? 'no longer known' : null,
    d.gone ? 'what it was about is gone' : null,
    d.again ? 'tried again later' : null,
    d.offlineS ? `after ${took(d.offlineS * 1000)} cut off` : null,
  ].filter(Boolean);
  return `${e.category}${e.summary ? `: ${e.summary}` : ''}${more.length ? ` · ${more.join(' · ')}` : ''}`;
}

const devOf = (opts) => (opts.dev ? 'only' : opts.all ? 'all' : false);
const WHO_SAID = { owner: 'you', agent: 'the agent', blackcat: 'blackcat itself', dev: 'a developer session' };
// Where the time of a piece of work went, in a few words.
function whereText(sp) {
  const bits = [
    sp.modelMs ? `${took(sp.modelMs)} at the model${sp.calls > 1 ? ` (${sp.calls} calls)` : ''}` : null,
    sp.commandMs ? `${took(sp.commandMs)} in ${plural(sp.commands, 'command')}` : null,
    sp.waitedMs ? `${took(sp.waitedMs)} waiting for you` : null,
    sp.restMs && (sp.modelMs || sp.commandMs) ? `${took(sp.restMs)} in blackcat` : null,
  ].filter(Boolean);
  return bits.join(' + ');
}
const whereData = (sp) => ({
  ms: sp.ms,
  modelMs: sp.modelMs,
  commandMs: sp.commandMs,
  waitedForYouMs: sp.waitedMs,
  blackcatMs: sp.restMs,
  callsToTheModel: sp.calls,
  commands: sp.commands,
  failed: sp.failed,
  tokens: sp.tokens,
});
const sinceOf = (opts, fallback) => since(opts.since ?? fallback);

// One entry, for a program.
function entryData(e, s) {
  return {
    number: e.id,
    at: at(e.ts),
    kind: e.kind,
    category: e.category,
    ok: e.ok,
    took: took(e.ms),
    ms: e.ms,
    ...(e.who ? { who: e.who } : {}),
    ...(e.work ? { work: e.work } : {}),
    ...(e.surface ? { from: e.surface } : {}),
    ...(e.summary ? { summary: e.summary } : {}),
    ...(e.kind === 'model'
      ? {
          model: e.model,
          tokens: { freshInput: e.tokens_in, reusedInput: e.cache_read, storedForReuse: e.cache_write, output: e.tokens_out },
          ...(s.cost ? { cost: e.cost } : {}),
        }
      : {}),
    ...e.data,
  };
}
const MARK = { model: '✦', command: '›', job: '⟳', event: '•', owner: '◆', sent: '→' };
const LEGEND =
  '✦ a call to the model   › a command the agent ran   ⟳ scheduled work   ◆ something you did   → sent to you   • an event   ✗ failed or refused';

// One piece of work: everything recorded for it, in order, and where its time went.
export function show(ref) {
  const s = settings();
  const w = ofWork(ref);
  if (!w) return { text: `Nothing on the record with the number ${ref}.`, data: { error: 'not found' } };
  const sp = split(w.entries);
  const lead = w.entries.find((e) => e.lead) ?? w.entries[0];
  const t0 = Math.min(...w.entries.map((e) => e.ts - Math.round((e.ms ?? 0) / 1000)));
  const data = {
    work: w.id,
    what: `${lead.kind}: ${lead.category}`,
    setOffBy: lead.who ?? null,
    began: at(t0),
    ok: !sp.failed,
    where: whereData(sp),
    ...(s.cost && sp.cost != null ? { cost: Math.round(sp.cost * 1000) / 1000 } : {}),
    entries: w.entries.map((e) => entryData(e, s)),
  };
  const head = [
    `${pc.bold(`${lead.category}${lead.summary ? `: ${lead.summary}` : ''}`)}`,
    `${at(t0)} · ${took(sp.ms)}${lead.who ? ` · set off by ${WHO_SAID[lead.who] ?? lead.who}` : ''}${sp.failed ? pc.red(` · ${sp.failed} failed`) : ''}`,
    whereText(sp) ? `where the time went: ${whereText(sp)}` : null,
    s.cost && sp.cost ? `${count(sp.tokens)} tokens, ${usd(sp.cost)} at list price` : null,
  ].filter(Boolean);
  const steps = w.entries.map(
    (e) =>
      `${pc.dim(`${String(e.id).padStart(6)}  ${at(e.ts)}`)}  ${e.ok ? ' ' : pc.red('✗')}${MARK[e.kind]} ${line(e, s.cost)}${e.ms != null ? pc.dim(`  ${took(e.ms)}`) : ''}${e.lead ? pc.dim('  (the whole of it)') : ''}`,
  );
  return { text: [...head, '', ...steps, '', pc.dim(LEGEND)].join('\n'), data };
}

// The slowest pieces of work, each with where its time went.
export function slow(opts) {
  const s = settings();
  let sinceTs;
  try {
    sinceTs = sinceOf(opts, '7d');
  } catch (e) {
    return { text: e.message, data: { error: e.message } };
  }
  const rows = slowest({ sinceTs, limit: opts.limit, kind: opts.kind, category: opts.category, dev: devOf(opts) });
  const data = {
    since: at(sinceTs),
    work: rows.map((e) => ({
      number: e.id,
      at: at(e.ts),
      what: `${e.kind}: ${e.category}`,
      ...(e.summary ? { summary: e.summary } : {}),
      ...(e.who ? { who: e.who } : {}),
      ok: e.ok,
      took: took(e.ms),
      where: whereData(e.split),
    })),
  };
  if (!rows.length) return { text: s.on ? 'Nothing recorded for that.' : 'The record is off (bc activity setup).', data };
  const text = rows.map(
    (e) =>
      `${pc.dim(`${String(e.id).padStart(6)}  ${at(e.ts)}`)}  ${took(e.ms).padStart(6)}  ${e.ok ? '' : pc.red('✗ ')}${e.category}${e.summary ? pc.dim(`: ${e.summary.slice(0, 60)}`) : ''}${whereText(e.split) ? `\n${' '.repeat(40)}${pc.dim(whereText(e.split))}` : ''}`,
  );
  return {
    text: [`The slowest since ${at(sinceTs)}:`, '', ...text, '', pc.dim('One of them, step by step: bc activity show <number>')].join('\n'),
    data,
  };
}

// How long each kind of work takes.
export function timings(opts) {
  const s = settings();
  let sinceTs;
  try {
    sinceTs = sinceOf(opts, '7d');
  } catch (e) {
    return { text: e.message, data: { error: e.message } };
  }
  const rows = timed({ sinceTs, dev: devOf(opts) });
  const data = {
    since: at(sinceTs),
    rows: rows.map((r) => ({
      what: `${r.kind}: ${r.category}`,
      n: r.n,
      failed: r.failed,
      middleMs: r.middleMs,
      slowestMs: r.slowestMs,
      totalMs: r.totalMs,
    })),
  };
  if (!rows.length) return { text: s.on ? 'Nothing recorded for that.' : 'The record is off (bc activity setup).', data };
  const w = Math.min(46, Math.max(...rows.map((r) => r.category.length)));
  const head = `${'what'.padEnd(w)}  ${'times'.padStart(6)}  ${'failed'.padStart(6)}  ${'middle'.padStart(7)}  ${'slowest'.padStart(7)}  ${'in all'.padStart(7)}`;
  const body = rows.map(
    (r) =>
      `${r.category.slice(0, w).padEnd(w)}  ${String(r.n).padStart(6)}  ${String(r.failed || '').padStart(6)}  ${took(r.middleMs).padStart(7)}  ${took(r.slowestMs).padStart(7)}  ${took(r.totalMs).padStart(7)}`,
  );
  return { text: [`How long each kind of work took since ${at(sinceTs)}:`, '', pc.dim(head), ...body].join('\n'), data };
}

export function recent(opts) {
  let sinceTs;
  if (opts.since) {
    try {
      sinceTs = since(opts.since);
    } catch (e) {
      return { text: e.message, data: { error: e.message } };
    }
  }
  const s = settings();
  if (opts.who && !Object.hasOwn(WHO_SAID, opts.who))
    return { text: `--who is one of: ${Object.keys(WHO_SAID).join(', ')}.`, data: { error: 'unknown --who' } };
  const rows = read({
    kind: opts.kind,
    category: opts.category,
    sinceTs,
    failed: !!opts.failed,
    limit: opts.limit,
    dev: devOf(opts),
    who: opts.who,
    lead: !!opts.work,
    before: opts.before,
  });
  const data = { recording: s.on, ...(s.cost ? { costNote: COST_NOTE } : {}), entries: rows.map((e) => entryData(e, s)) };
  if (!rows.length) return { text: s.on ? 'Nothing recorded for that.' : 'The record is off (bc activity setup).', data };
  const text = rows
    .map(
      (e) =>
        `${pc.dim(`${String(e.id).padStart(6)}  ${at(e.ts)}`)}  ${e.ok ? ' ' : pc.red('✗')}${MARK[e.kind]} ${line(e, s.cost)}${e.ms != null ? pc.dim(`  ${took(e.ms)}`) : ''}${e.who === 'dev' ? pc.dim('  (developer session)') : ''}`,
    )
    .join('\n');
  // (More than was asked for may be there: say how to see the page before.)
  const full = rows.length >= Math.min(Math.max(Number(opts.limit) || 30, 1), 5000);
  if (full) data.older = { before: rows.at(-1).id };
  return {
    text: `${text}\n\n${pc.dim(LEGEND)}\n${pc.dim(`One of them, step by step: bc activity show <number>${full ? ` · older: --before ${rows.at(-1).id}` : ''}`)}`,
    data,
  };
}

export function usage(opts) {
  const s = settings();
  const by = ['category', 'model', 'day', 'kind', 'who'].includes(opts.by) ? opts.by : 'category';
  // --since 7d is --days 7 (whole days, today included); a part of a day counts as one.
  let days = opts.days ?? 7;
  if (opts.since) {
    try {
      const t = Date.now(); // (one moment for both: 30d is 30 days, not a little over)
      days = Math.max(1, Math.ceil((Math.floor(t / 1000) - since(opts.since, t)) / 86400));
    } catch (e) {
      return { text: e.message, data: { error: e.message } };
    }
  }
  // What is counted: calls to the model unless another kind is asked for (jobs, events, what the owner did).
  const kind = KINDS.includes(opts.kind) ? opts.kind : 'model';
  const t = totals({ days, by, kind, dev: devOf(opts) });
  const all = t.rows.reduce(
    (a, r) => ({ n: a.n + r.n, cost: a.cost + r.cost, tokens: a.tokens + r.tokensIn + r.tokensOut + r.cacheRead + r.cacheWrite }),
    { n: 0, cost: 0, tokens: 0 },
  );
  const data = {
    days: t.days,
    from: t.from,
    by,
    ...(s.cost ? { costNote: COST_NOTE } : {}),
    rows: t.rows.map((r) => ({
      [by]: r.name || '(none)',
      calls: r.n,
      failed: r.failed,
      tokens: { freshInput: r.tokensIn, reusedInput: r.cacheRead, storedForReuse: r.cacheWrite, output: r.tokensOut },
      ...(s.cost ? { cost: Math.round(r.cost * 100) / 100 } : {}),
      seconds: Math.round(r.ms / 1000),
      slowestSeconds: Math.round((r.slowest ?? 0) / 100) / 10,
    })),
    total: { calls: all.n, tokens: all.tokens, ...(s.cost ? { cost: Math.round(all.cost * 100) / 100 } : {}) },
  };
  if (!t.rows.length)
    return {
      text: s.on ? `Nothing recorded in the last ${plural(t.days, 'day')}.` : 'The record is off (bc activity setup).',
      data,
    };
  const w = Math.max(by.length, ...t.rows.map((r) => (r.name || '(none)').length));
  const head = `${by.padEnd(w)}  ${'calls'.padStart(6)}  ${'input'.padStart(8)}  ${'reused'.padStart(8)}  ${'output'.padStart(7)}${s.cost ? `  ${'cost'.padStart(7)}` : ''}  ${'time'.padStart(7)}`;
  const body = t.rows.map(
    (r) =>
      `${(r.name || '(none)').padEnd(w)}  ${String(r.n).padStart(6)}  ${count(r.tokensIn + r.cacheWrite).padStart(8)}  ${count(r.cacheRead).padStart(8)}  ${count(r.tokensOut).padStart(7)}${s.cost ? `  ${usd(r.cost).padStart(7)}` : ''}  ${took(r.ms).padStart(7)}`,
  );
  const what =
    by === 'kind'
      ? 'Everything recorded'
      : {
          model: 'Calls to the model',
          command: 'Commands the agent ran',
          job: 'Scheduled work',
          event: 'Events',
          owner: 'What you did',
          sent: 'What was sent to you',
        }[kind];
  return {
    text: [
      `${what} since ${t.from} (${plural(t.days, 'day')}), by ${by}:`,
      '',
      pc.dim(head),
      ...body,
      '',
      `Total: ${all.n} calls, ${count(all.tokens)} tokens${s.cost ? `, ${usd(all.cost)}` : ''}.`,
      ...(s.cost ? [pc.dim(COST_NOTE)] : []),
    ].join('\n'),
    data,
  };
}

export function clear({ dev = false } = {}) {
  const n = wipe({ dev });
  const said = `${n} entr${n === 1 ? 'y' : 'ies'}`;
  return dev
    ? `Deleted what developer sessions did: ${said}, and their part of the daily totals.`
    : `Deleted ${said} and the daily totals.`;
}

// What looks wrong, by plain rules. Something found is a failure (exit 1), for a check to run.
export async function problems() {
  const { problems: find } = await import('./problems.js');
  const found = find();
  if (found.length) process.exitCode = 1;
  return {
    text: found.length
      ? [`${plural(found.length, 'thing')} look${found.length === 1 ? 's' : ''} wrong:`, ...found.map((p) => `  ✗ ${p.title}`)].join('\n')
      : 'Nothing looks wrong in the last day.',
    data: { problems: found },
  };
}
