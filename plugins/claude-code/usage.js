// What Claude Code reports at the end of a call (its "result" message) → what blackcat
// keeps about any engine's call: tokens, the model, cost, and a few details.
export function usageOf(res) {
  const u = res?.usage ?? {};
  const models = Object.entries(res?.modelUsage ?? {}).map(([name, m]) => ({
    name,
    cost: m.costUSD ?? 0,
    window: m.contextWindow ?? null,
  }));
  models.sort((a, b) => b.cost - a.cost);
  // How full the conversation is: what the last step sent, against what the model can hold.
  const last = (u.iterations ?? []).at(-1) ?? u;
  const held = (last.input_tokens ?? 0) + (last.cache_read_input_tokens ?? 0) + (last.cache_creation_input_tokens ?? 0);
  return {
    ok: !res?.is_error,
    model: models[0]?.name ?? null,
    tokensIn: u.input_tokens ?? 0,
    tokensOut: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    cost: res?.total_cost_usd ?? null,
    data: {
      ...(res?.duration_ms != null ? { claudeMs: res.duration_ms } : {}),
      ...(res?.duration_api_ms != null ? { apiMs: res.duration_api_ms } : {}),
      ...(res?.num_turns != null ? { steps: res.num_turns } : {}),
      ...(u.output_tokens_details?.thinking_tokens ? { thinking: u.output_tokens_details.thinking_tokens } : {}),
      ...(res?.stop_reason && res.stop_reason !== 'end_turn' ? { stopped: res.stop_reason } : {}),
      ...(res?.terminal_reason && res.terminal_reason !== 'completed' ? { ended: res.terminal_reason } : {}),
      ...(res?.permission_denials?.length ? { refused: res.permission_denials.length } : {}),
      ...(models.length > 1 ? { models: Object.fromEntries(models.map((m) => [m.name, Math.round(m.cost * 1e6) / 1e6])) } : {}),
      ...(models[0]?.window && held ? { contextUsed: Math.round((held / models[0].window) * 1000) / 10 } : {}),
    },
  };
}
