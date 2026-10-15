// What a speaker can be asked to play from Home Assistant's own media folder ("My media").
// Home Assistant lists it through a media player, so the listing is asked of one.
import { HaError } from './api.js';

export const ROOT = 'media-source://media_source';
const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
// A name as it is shown: without the file ending, and without what would not fit on a line.
export const shown = (title) =>
  String(title ?? '')
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/\.(mp3|m4a|flac|wav|ogg|opus|aac|mp4|mkv|webm)$/i, '')
    .trim()
    .slice(0, 140);

// Everything playable under "My media", folders walked a few levels down.
// → [{ title, id, type, folder }]
export async function library(api, entityId, { maxDepth = 3, max = 400 } = {}) {
  const out = [];
  const walk = async (id, folder, depth) => {
    const node = await api.browse(entityId, id);
    for (const c of node?.children ?? []) {
      if (out.length >= max) return;
      // (A folder of sounds often holds their cover pictures too: those are not for a speaker.)
      if (/^image\//i.test(String(c.media_content_type ?? '')) || /\.(webp|jpe?g|png|gif)$/i.test(String(c.title ?? ''))) continue;
      if (c.can_play && !c.can_expand)
        out.push({ title: String(c.title ?? ''), id: String(c.media_content_id), type: String(c.media_content_type ?? 'music'), folder });
      else if (c.can_expand && depth < maxDepth)
        await walk(String(c.media_content_id), folder ? `${folder}/${c.title}` : String(c.title ?? ''), depth + 1);
    }
  };
  await walk(ROOT, '', 0);
  // Only what is in Home Assistant's own media folder: never an address of somewhere else.
  return out.filter((m) => m.id.startsWith(`${ROOT}/`));
}

// The same, asked of whichever media player will answer (some cannot list media).
export async function libraryVia(api, entityIds) {
  let last = null;
  for (const id of entityIds.slice(0, 6)) {
    try {
      return await library(api, id);
    } catch (e) {
      if (!(e instanceof HaError)) throw e;
      last = e;
    }
  }
  throw last ?? new HaError('There is no speaker or TV in Home Assistant to list the media folder through.');
}

// The files whose name has every one of these words. An exact name wins outright.
export function matching(items, words) {
  const q = norm([words].flat().join(' '));
  if (!q) return items;
  const exact = items.filter((m) => norm(m.title) === q || norm(shown(m.title)) === q);
  if (exact.length) return exact;
  const terms = q.split(' ');
  return items.filter((m) => terms.every((t) => norm(`${m.folder} ${m.title}`).includes(t)));
}
