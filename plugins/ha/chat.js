// /ha in the ui: walk through rooms and things with buttons, see what each is doing,
// and act on it. The agent is not involved. `/ha` followed by words is the direct command
// (`/ha off living room light`), which blackcat handles itself.
import { HaError, client } from './api.js';
import { ACTIONS, areaName, controllable, inArea, levelFor, main, primary, readCatalogue } from './catalogue.js';
import { describe } from './plugin.js';
import { actions, esc, sleep } from '../../src/api.js';

const ICON = {
  light: '💡',
  switch: '🔌',
  fan: '🌀',
  cover: '🪟',
  climate: '🌡',
  lock: '🔒',
  media_player: '📺',
  scene: '🎬',
  script: '▶️',
  sensor: '📈',
  binary_sensor: '◉',
  vacuum: '🧹',
  camera: '📷',
  weather: '⛅',
  person: '🧍',
};
const icon = (e) => ICON[e.domain] ?? '•';
const MAX_BUTTONS = 60;

export function install(ui, ctx) {
  const api = () => client({ url: ctx.config.get().url, token: ctx.secrets.get('token') });
  // Buttons carry positions in the catalogue, stamped with its sync time: after a sync
  // an old message's buttons say so instead of pointing at the wrong thing.
  const stamp = (cat) => String(cat.synced % 100000);
  const edit = (c, text, kb) => c.edit(text, { html: true, actions: kb }).catch(() => c.reply(text, { html: true, actions: kb }));

  function roomsView(cat) {
    const kb = actions();
    const shown = (e) => main(e) || (primary(e) && ['sensor', 'binary_sensor'].includes(e.domain));
    const rooms = [
      ...cat.areas.map((a, i) => ({ name: a.name, key: i, things: inArea(cat, a.id).filter(shown) })),
      { name: 'No room', key: 'n', things: inArea(cat, null).filter(main) },
    ].filter((r) => r.things.length);
    rooms.forEach((r, i) => {
      kb.add(`${r.name} · ${r.things.filter(main).length}`.slice(0, 32), `ha:a:${stamp(cat)}:${r.key}`);
      if (i % 2 === 1) kb.row();
    });
    return { text: `🏠 <b>${esc(cat.location ?? 'Home')}</b>\nChoose a room. The number is how many things in it can be controlled.`, kb };
  }

  async function roomView(cat, key) {
    const area = key === 'n' ? null : cat.areas[Number(key)];
    const things = inArea(cat, area?.id ?? null).filter(
      (e) => main(e) || (area && primary(e) && ['sensor', 'binary_sensor', 'weather', 'person'].includes(e.domain)),
    );
    const states = new Map((await api().states()).map((s) => [s.entity_id, s]));
    // Things you can control first, then what can only be read.
    const sorted = [...things.filter(main), ...things.filter((e) => !main(e))].slice(0, MAX_BUTTONS);
    const kb = actions();
    sorted.forEach((e) => {
      const s = states.get(e.id);
      kb.add(`${icon(e)} ${e.name} · ${s ? describe(s, e) : '?'}`.slice(0, 44), `ha:e:${stamp(cat)}:${cat.entities.indexOf(e)}`);
      kb.row();
    });
    kb.add('⬅ Rooms', 'ha:r');
    return {
      text: `🏠 <b>${esc(area?.name ?? 'No room')}</b>${sorted.length < things.length ? `\n(showing ${sorted.length} of ${things.length})` : ''}\nTap a thing to see it and act on it.`,
      kb,
    };
  }

  async function thingView(cat, idx) {
    const e = cat.entities[idx];
    const s = await api().state(e.id);
    const a = s.attributes ?? {};
    const st = stamp(cat);
    const b = (label, code) => [label, `ha:x:${st}:${idx}:${code}`];
    const rows = [];
    const has = (act) => !!ACTIONS[e.domain]?.[act];
    if (e.domain === 'light') rows.push([b('On', 'on'), b('Off', 'off')], [b('25%', 'b25'), b('50%', 'b50'), b('100%', 'b100')]);
    else if (e.domain === 'climate')
      rows.push(
        [b('− 1°', 't-'), b('+ 1°', 't+'), b('Off', 'off')],
        (a.hvac_modes ?? [])
          .filter((m) => m !== 'off')
          .slice(0, 4)
          .map((m) => b(m, `m:${m}`)),
      );
    else if (e.domain === 'media_player')
      rows.push([b('▶ Play', 'play'), b('⏸ Pause', 'pause'), b('Off', 'off')], [b('Vol −', 'v-'), b('Vol +', 'v+')]);
    else if (has('open')) rows.push([b('Open', 'open'), b('Close', 'close'), ...(has('stop') ? [b('Stop', 'stop')] : [])]);
    else if (has('lock')) rows.push([b('🔒 Lock', 'lock'), b('🔓 Unlock', 'unlock')]);
    else if (has('run') && !has('off')) rows.push([b('▶ Run', 'run')]);
    else if (has('on')) rows.push([b('On', 'on'), b('Off', 'off')]);
    const kb = actions();
    for (const row of rows.filter((r) => r.length)) {
      for (const [label, data] of row) kb.add(label, data);
      kb.row();
    }
    kb.add('🔄 Refresh', `ha:e:${st}:${idx}`);
    if (['sensor', 'binary_sensor', 'climate'].includes(e.domain)) kb.add('📈 Last 24h', `ha:x:${st}:${idx}:hist`);
    kb.row()
      .add('⬅ Room', `ha:a:${st}:${e.area ? cat.areas.findIndex((x) => x.id === e.area) : 'n'}`)
      .add('🏠 Rooms', 'ha:r');
    const level = controllable(e) ? levelFor(e, ctx.config.get()) : null;
    const lines = [
      `${icon(e)} <b>${esc(e.name)}</b>${e.area ? ` · ${esc(areaName(cat, e.area))}` : ''}`,
      `<b>${esc(describe(s, e))}</b>`,
      `<i>${esc(e.domain.replace(/_/g, ' '))} · changed ${esc(new Date(s.last_changed).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}${level ? ` · the agent ${level === 'free' ? 'may switch it' : level === 'ask' ? 'asks first' : 'asks every time'}` : ''}</i>`,
    ];
    return { text: lines.join('\n'), kb, e, s };
  }

  // Do what a button says. → nothing, or text to show (history).
  async function perform(e, s, code) {
    const a = s.attributes ?? {};
    const id = { entity_id: e.id };
    const h = api();
    if (ACTIONS[e.domain]?.[code]) return void (await h.call(...ACTIONS[e.domain][code], id));
    if (/^b\d+$/.test(code)) return void (await h.call('light', 'turn_on', { ...id, brightness_pct: Number(code.slice(1)) }));
    if (code === 't+' || code === 't-')
      return void (await h.call('climate', 'set_temperature', {
        ...id,
        temperature: (a.temperature ?? a.current_temperature ?? 22) + (code === 't+' ? 1 : -1),
      }));
    if (code.startsWith('m:')) return void (await h.call('climate', 'set_hvac_mode', { ...id, hvac_mode: code.slice(2) }));
    if (code === 'v+' || code === 'v-')
      return void (await h.call('media_player', 'volume_set', {
        ...id,
        volume_level: Math.min(1, Math.max(0, (a.volume_level ?? 0.3) + (code === 'v+' ? 0.05 : -0.05))),
      }));
    if (code === 'hist') {
      const rows = ((await h.history(e.id, new Date(Date.now() - 24 * 3600_000).toISOString()))?.[0] ?? []).filter(
        (r) => !['unknown', 'unavailable'].includes(r.state),
      );
      const nums = rows.map((r) => Number(r.state)).filter(Number.isFinite);
      return nums.length > 2 && nums.length === rows.length
        ? `Last 24h: min ${Math.min(...nums)} · max ${Math.max(...nums)} · now ${nums.at(-1)}${e.unit ? ` ${e.unit}` : ''}`
        : `Last 24h:\n${
            rows
              .slice(-10)
              .map((r) => `${new Date(r.last_changed).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} ${r.state}`)
              .join('\n') || 'no changes'
          }`;
    }
    throw new HaError('That button no longer applies.');
  }

  const current = async (c, st) => {
    const cat = readCatalogue(ctx);
    if (!cat) return (await c.toast('Not synced yet: bc ha sync'), null);
    if (st != null && st !== stamp(cat)) return (await c.toast('The device list has changed. Send /ha again.'), null);
    return cat;
  };
  const safely = (fn) => async (c) => {
    try {
      await fn(c);
    } catch (e) {
      await c.toast(e instanceof HaError ? e.message.slice(0, 190) : 'Something went wrong.').catch(() => {});
      if (!(e instanceof HaError)) ctx.log(`browser: ${e.stack ?? e.message}`);
    }
  };

  // `/ha` alone opens the browser. With words after it, it is a direct command.
  ui.command('ha', (c, next) => {
    if (String(c.match ?? '').trim()) return next();
    const cat = readCatalogue(ctx);
    if (!cat)
      return c.reply('Home Assistant is not set up yet. Send /setup and choose Home Assistant, or run `bc ha setup` on this machine.');
    const v = roomsView(cat);
    return c.reply(v.text, { html: true, actions: v.kb });
  });

  ui.action(
    'ha:r',
    safely(async (c) => {
      const cat = await current(c);
      if (!cat) return;
      await c.toast();
      const v = roomsView(cat);
      await edit(c, v.text, v.kb);
    }),
  );
  ui.action(
    /^ha:a:(\d+):(\d+|n)$/,
    safely(async (c) => {
      const cat = await current(c, c.match[1]);
      if (!cat) return;
      await c.toast();
      const v = await roomView(cat, c.match[2]);
      await edit(c, v.text, v.kb);
    }),
  );
  ui.action(
    /^ha:e:(\d+):(\d+)$/,
    safely(async (c) => {
      const cat = await current(c, c.match[1]);
      if (!cat || !cat.entities[Number(c.match[2])]) return;
      await c.toast();
      const v = await thingView(cat, Number(c.match[2]));
      await edit(c, v.text, v.kb);
    }),
  );
  // x = a button was tapped; y = the confirming tap for something that isn't switched freely.
  ui.action(
    /^ha:([xy]):(\d+):(\d+):(.+)$/,
    safely(async (c) => {
      const [, stage, st, idxS, code] = c.match;
      const cat = await current(c, st);
      const idx = Number(idxS);
      const e = cat?.entities[idx];
      if (!e) return;
      const acting = code !== 'hist';
      if (acting && stage === 'x' && levelFor(e, ctx.config.get()) !== 'free') {
        await c.toast();
        return void (await c.reply(`${icon(e)} <b>${esc(e.name)}</b>: ${esc(code)}?`, {
          html: true,
          actions: actions().add('✅ Yes, do it', `ha:y:${st}:${idx}:${code}`).add('✖ No', 'ha:no'),
        }));
      }
      const s = await api().state(e.id);
      const said = await perform(e, s, code);
      await c.toast(said ? undefined : 'Done');
      if (said) return void (await c.reply(`${icon(e)} <b>${esc(e.name)}</b>\n${esc(said)}`, { html: true }));
      if (acting) ctx.log(`${e.name}: ${code} (from the /ha buttons)`);
      await sleep(800); // let it take effect, then show what it is now
      const v = await thingView(cat, idx);
      await (stage === 'y' ? c.edit(`${v.text}`, { html: true, actions: v.kb }).catch(() => {}) : edit(c, v.text, v.kb));
    }),
  );
  ui.action('ha:no', async (c) => {
    await c.toast('Not done');
    await c.clearActions().catch(() => {});
  });
}
