// The earlier part of a long conversation, as a summary. When a conversation is carried on
// from blackcat's record, its most recent exchanges are handed over whole; what came before
// them is too much to send, so a reader (a model with no tools) writes what matters of it.
//
// The summary is kept with the conversation and added to: the next time, only the
// exchanges since it was written are read, with the summary so far. A conversation of any
// length is therefore summarised a piece at a time, and never from the beginning twice.
//
// What is summarised may quote other people (a message, a page, a file). It is read without
// tools, and what comes back is handed to the agent as part of the record, never as an
// instruction.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { askReader } from '../readers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
import * as store from './store.js';

const PIECE = 40_000; // characters of exchanges read in one go
const EACH = 4_000; // of one exchange: a very long reply is cut
const MOST = 4_000; // of a summary that is kept

// The summary of everything before `firstShown` (a turn id) in conversation `conv`.
// → its text, or null (switched off, nothing to summarise, or the reader failed).
export async function earlierPart(conv, firstShown) {
  if (store.settings().summary === false || !conv || firstShown == null) return null;
  let summary = conv.summary ?? null;
  let upto = conv.summary_upto ?? 0;
  const rest = store.safe(() => store.between(conv.id, upto, firstShown), []);
  if (!rest.length) return summary;
  // A piece at a time, each with the summary so far.
  for (let i = 0; i < rest.length;) {
    const piece = [];
    let size = 0;
    while (i < rest.length && (size + Math.min(EACH, store.written(rest[i]).length) <= PIECE || !piece.length)) {
      const text = store.written(rest[i], EACH);
      piece.push(text);
      size += text.length;
      i++;
    }
    const input = `${summary ? `Summary so far:\n${summary}\n\n` : ''}Exchanges, oldest first:\n\n${piece.join('\n\n')}`;
    let out;
    try {
      out = String(await askReader({ dir: here, part: 'conversations', job: 'summary', input, category: 'conversation summary' })).trim();
    } catch {
      return summary; // what there was before, if anything: the rest stays unsummarised
    }
    // (A reader sometimes repeats the label it was shown: that is not part of what it found.)
    out = out.replace(/^\s*(\*\*)?summary( so far)?:?(\*\*)?\s*\n+/i, '').trim();
    if (!out) return summary;
    summary = out.slice(0, MOST);
    upto = rest[i - 1].id;
    store.safe(() => store.setSummary(conv.id, summary, upto));
  }
  return summary;
}
