// `bc activity …`: reading the activity record.
import pc from 'picocolors';
import { clear as wipe, recent as read, settings, totals } from './log.js';
import { parseDuration } from '../util/when.js';

const short = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n ?? 0));
const took = (ms) =>
  ms == null ? '' : ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
const at = (ts) =>
  new Date(ts * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const money = (x) => `$${(x ?? 0).toFixed(x >= 10 ? 0 : 2)}`;
const COST_NOTE = 'Cost is the list price of each call: a measure of how much of the plan it used, not a charge.';

// One entry, as a line a person can read.
function line(e, showCost) {
  const d = e.data;
  if (e.kind === 'model') {
    const bits = [
      e.model,
      `${short(e.tokens_in + e.cache_read + e.cache_write)} in (${short(e.cache_read)} reused)`,
      `${short(e.tokens_out)} out`,
      showCost && e.cost != null ? money(e.cost) : null,
      d.steps > 1 ? `${d.steps} steps` : null,
      d.commands ? `${d.commands} command${d.commands === 1 ? '' : 's'} (${took(d.commandMs)})` : null,
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
    d.offlineS ? `after ${took(d.offlineS * 1000)} cut off` : null,
  ].filter(Boolean);
  return `${e.category}${e.summary ? `: ${e.summary}` : ''}${more.length ? ` · ${more.join(' · ')}` : ''}`;
}

export function recent(opts) {
  let sinceTs;
  if (opts.since) {
    try {
      sinceTs = Math.floor(Date.now() / 1000) - parseDuration(opts.since);
    } catch (e) {
      return { text: e.message, data: { error: e.message } };
    }
  }
  const s = settings();
  const rows = read({ kind: opts.kind, category: opts.category, sinceTs, failed: !!opts.failed, limit: opts.limit });
  const data = {
    recording: s.on,
    ...(s.cost ? { costNote: COST_NOTE } : {}),
    entries: rows.map((e) => ({
      at: at(e.ts),
      kind: e.kind,
      category: e.category,
      ok: e.ok,
      took: took(e.ms),
      ms: e.ms,
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
    })),
  };
  if (!rows.length) return { text: s.on ? 'Nothing recorded for that.' : 'The record is off (bc activity setup).', data };
  const mark = { model: '✦', command: '›', job: '⟳', event: '•', owner: '◆', sent: '→' };
  const text = rows
    .map(
      (e) =>
        `${pc.dim(at(e.ts))}  ${e.ok ? ' ' : pc.red('✗')}${mark[e.kind]} ${line(e, s.cost)}${e.ms != null ? pc.dim(`  ${took(e.ms)}`) : ''}`,
    )
    .join('\n');
  return {
    text: `${text}\n\n${pc.dim('✦ a call to the model   › a command the agent ran   ⟳ scheduled work   ◆ something you did   → sent to you   • an event   ✗ failed or refused')}`,
    data,
  };
}

export function usage(opts) {
  const s = settings();
  const by = ['category', 'model', 'day', 'kind'].includes(opts.by) ? opts.by : 'category';
  // --since 7d is --days 7 (whole days, today included); a part of a day counts as one.
  const days = opts.since ? Math.max(1, Math.ceil(parseDuration(opts.since) / 86400)) : (opts.days ?? 7);
  const t = totals({ days, by });
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
    })),
    total: { calls: all.n, tokens: all.tokens, ...(s.cost ? { cost: Math.round(all.cost * 100) / 100 } : {}) },
  };
  if (!t.rows.length)
    return {
      text: s.on ? `Nothing recorded in the last ${t.days} day${t.days === 1 ? '' : 's'}.` : 'The record is off (bc activity setup).',
      data,
    };
  const w = Math.max(by.length, ...t.rows.map((r) => (r.name || '(none)').length));
  const head = `${by.padEnd(w)}  ${'calls'.padStart(6)}  ${'input'.padStart(8)}  ${'reused'.padStart(8)}  ${'output'.padStart(7)}${s.cost ? `  ${'cost'.padStart(7)}` : ''}  ${'time'.padStart(7)}`;
  const body = t.rows.map(
    (r) =>
      `${(r.name || '(none)').padEnd(w)}  ${String(r.n).padStart(6)}  ${short(r.tokensIn + r.cacheWrite).padStart(8)}  ${short(r.cacheRead).padStart(8)}  ${short(r.tokensOut).padStart(7)}${s.cost ? `  ${money(r.cost).padStart(7)}` : ''}  ${took(r.ms).padStart(7)}`,
  );
  const what = by === 'kind' ? 'Everything recorded' : 'Calls to the model';
  return {
    text: [
      `${what} since ${t.from} (${t.days} day${t.days === 1 ? '' : 's'}), by ${by}:`,
      '',
      pc.dim(head),
      ...body,
      '',
      `Total: ${all.n} calls, ${short(all.tokens)} tokens${s.cost ? `, ${money(all.cost)}` : ''}.`,
      ...(s.cost ? [pc.dim(COST_NOTE)] : []),
    ].join('\n'),
    data,
  };
}

export function clear() {
  const n = wipe();
  return `Deleted ${n} entr${n === 1 ? 'y' : 'ies'} and the daily totals.`;
}
