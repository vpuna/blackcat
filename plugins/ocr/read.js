// Reading the text in a picture, on this machine, with Tesseract. A picture is read twice:
// once as a page (lines and paragraphs, in order), once looking for scattered bits of text.
// Neither finds everything: the first passes over what is not laid out as a page (words on
// a poster, a designed graphic), the second loses the order and sees words that are not
// there. What the first gives is the text; what only the second found is added after it,
// marked as less sure. How far the two agree says how much of the text the first one got,
// which is most of how sure the reading is.
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_SIDE = 2000; // pixels: a larger picture is made smaller first (it reads no better, only slower)
const TIMEOUT_MS = 90_000; // each reading
const SURE = 60; // Tesseract's own confidence in a word, 0 to 100: under this it is not counted as read
const KEPT = 40; // under this a word is left out of the text altogether (mostly icons taken for letters)
const TEXT_AT = 3; // fewer different words than this, by both readings together: there is no text in it

let found = null;
// Is Tesseract on this machine? (Asked once in each process.)
export function available() {
  if (found == null) {
    try {
      found = spawnSync('tesseract', ['--version'], { stdio: 'ignore' }).status === 0;
    } catch {
      found = false;
    }
  }
  return found;
}
// The languages it can read here. → ['eng', 'ara', …]
export function languages() {
  try {
    const out = spawnSync('tesseract', ['--list-langs'], { encoding: 'utf8' });
    return `${out.stdout}${out.stderr}`
      .split('\n')
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => /^[a-z_]{3,}$/i.test(l) && l !== 'osd');
  } catch {
    return [];
  }
}

// Tesseract's table of what it found: one row for each word, with how sure it is and the
// line it is on. → [{ text, conf, line }]
export function parseTsv(tsv) {
  return String(tsv)
    .split('\n')
    .slice(1)
    .map((l) => l.split('\t'))
    .filter((c) => c[0] === '5' && (c[11] ?? '').trim())
    .map((c) => ({ text: c[11].trim(), conf: Number(c[10]), line: `${c[2]}.${c[3]}.${c[4]}` }));
}

const core = (t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
// Does it look like a word, a number, a time or a date (and not like marks on the picture)?
const wordlike = (t) => /^\p{L}[\p{L}'’-]{2,}$/u.test(core(t)) || /^\d{1,4}([.:/-]\d{1,4})*(st|nd|rd|th|am|pm)?$/i.test(core(t));
const same = (t) => core(t).toLowerCase();

// What the two readings come to. `page` and `sparse` are parseTsv() of each.
// → { text, extra, score, words }: the text in reading order; the words only the second
// reading found; how sure this is that everything was read, 0 to 100; how many different
// words were read. No text at all in the picture is { text: '', score: 100, words: 0 }.
export function combine(page, sparse) {
  const looks = page.filter((w) => wordlike(w.text));
  const read = looks.filter((w) => w.conf >= SURE);
  const also = sparse.filter((w) => wordlike(w.text) && w.conf >= SURE);
  const got = new Set(read.map((w) => same(w.text)));
  const all = new Set([...got, ...also.map((w) => same(w.text))]);
  if (all.size < TEXT_AT) return { text: '', extra: [], score: 100, words: 0 };

  // Of all the words either reading found, how many the reading as a page got; how sure it
  // was of those; and of what looked like a word to it, how much it read with confidence.
  const cover = got.size / all.size;
  const conf = read.length ? read.reduce((s, w) => s + w.conf, 0) / read.length / 100 : 0;
  const sure = looks.length ? read.length / looks.length : 0;

  const lines = [];
  let at = null;
  for (const w of page.filter((x) => x.conf >= KEPT)) {
    if (w.line !== at) lines.push([]);
    at = w.line;
    lines.at(-1).push(w.text);
  }
  const seen = new Set(got);
  const extra = [];
  for (const w of also) {
    if (seen.has(same(w.text))) continue;
    seen.add(same(w.text));
    extra.push(core(w.text));
  }
  return { text: lines.map((l) => l.join(' ')).join('\n'), extra, score: Math.round(100 * cover * conf * sure), words: all.size };
}

const run = (args) =>
  new Promise((resolve, reject) =>
    // At the lowest priority and on one core: this is background work, and one core is as quick.
    execFile(
      'nice',
      ['-n', '19', 'tesseract', ...args],
      { env: { ...process.env, OMP_THREAD_LIMIT: '1' }, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 ** 2 },
      (err, stdout) =>
        err ? reject(new Error(err.killed ? 'reading it took too long' : String(err.message).split('\n')[0])) : resolve(stdout),
    ),
  );

// Read one picture. → { text, extra, score, words, took } or { error }
export async function readPicture(file, { langs = ['eng'] } = {}) {
  if (!available()) return { error: 'Tesseract is not installed on this machine' };
  const t0 = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-ocr-'));
  try {
    // Turned the right way up, no larger than needed, and in a format Tesseract always reads.
    const png = path.join(dir, 'p.png');
    const { default: sharp } = await import('sharp');
    await sharp(file, { failOn: 'none' })
      .rotate()
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .png()
      .toFile(png);
    const l = langs.join('+');
    const page = parseTsv(await run([png, '-', '-l', l, 'tsv']));
    const sparse = parseTsv(await run([png, '-', '-l', l, '--psm', '11', 'tsv']));
    return { ...combine(page, sparse), took: Math.round((Date.now() - t0) / 100) / 10 };
  } catch (e) {
    return { error: e.message };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
