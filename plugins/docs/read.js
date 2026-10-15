// Reading the text of a document, on this machine. A Word or text file has its text taken
// out (an old .doc by antiword, where that is installed). A PDF is gone through page by page: where a page has text of its own, that is taken,
// exactly; a page that is a picture (a scan, a designed page) is made into a picture for
// whatever reads pictures; a page with text and a large image is both. The pictures inside
// a Word file are handed on the same way. This file reads no picture itself.
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const MAX_PAGES = 30; // of a PDF; the rest is not read
export const MAX_PICTURES = 10; // inside a Word file
const MAX_CHARS = 400_000; // of text taken from one document
const FEW_WORDS = 15; // a page with fewer has no text of its own to speak of
const BIG_IMAGE = 0.25; // of the page: an image this large may hold text
const SMALL_FILE = 15 * 1024; // bytes: a picture inside a Word file smaller than this is a logo or an icon
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOC = 'application/msword';

const has = {};
// Is a program on this machine? (Asked once in each process.)
export function installed(name) {
  if (has[name] == null) {
    try {
      has[name] = spawnSync(name, ['-v'], { stdio: 'ignore' }).error == null;
    } catch {
      has[name] = false;
    }
  }
  return has[name];
}
const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { maxBuffer: 64 * 1024 ** 2, timeout: 120_000, ...opts }, (err, stdout) =>
      err
        ? reject(new Error(err.killed ? `${cmd} took too long` : String(err.message).split('\n').slice(0, 2).join(' ')))
        : resolve(stdout),
    ),
  );
const words = (t) => (String(t).match(/[\p{L}\p{N}]{2,}/gu) ?? []).length;
const mimeOf = (m) =>
  String(m ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();

// What kind of document it is, from its type and name. → 'pdf' | 'docx' | 'doc' | 'text' | null
export function kindOf(mime, name = '') {
  const t = mimeOf(mime);
  if (t === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if (t === DOCX || /\.docx$/i.test(name)) return 'docx';
  if (t === DOC || /\.doc$/i.test(name)) return 'doc';
  if (t.startsWith('text/') || /\.(txt|md|csv)$/i.test(name)) return 'text';
  return null;
}

// How much of each page its images cover, from `pdfimages -list` and the page's size in
// points. → Map(page → share, 0 to 1). (A picture's soft mask is listed beside it and not counted.)
export function imageCover(list, pageArea) {
  const cover = new Map();
  for (const line of String(list).split('\n').slice(2)) {
    const c = line.trim().split(/\s+/);
    if (c.length < 14 || c[2] !== 'image') continue;
    const [page, w, h, xppi, yppi] = [Number(c[0]), Number(c[3]), Number(c[4]), Number(c[12]), Number(c[13])];
    if (!(page && w && h && xppi && yppi)) continue;
    const area = (w / xppi) * 72 * ((h / yppi) * 72);
    cover.set(page, Math.min(1, (cover.get(page) ?? 0) + area / pageArea));
  }
  return cover;
}

// What to do with a page: take its text, read it as a picture, or both.
// → 'text' | 'picture' | 'both' | 'nothing'
export function pagePlan(text, cover) {
  const n = words(text);
  if (n < FEW_WORDS) return cover > 0.05 ? 'picture' : n ? 'text' : 'nothing';
  return cover >= BIG_IMAGE ? 'both' : 'text';
}

async function readPdf(file, tmp) {
  if (!installed('pdftotext')) return { error: 'the PDF tools are not installed on this machine (poppler-utils)' };
  const info = await run('pdfinfo', [file]);
  const pages = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1] ?? 0);
  if (!pages) return { error: 'the PDF has no pages that can be read' };
  const size = /^Page size:\s+([\d.]+) x ([\d.]+) pts/m.exec(info);
  const pageArea = size ? Number(size[1]) * Number(size[2]) : 595 * 842;
  const upTo = Math.min(pages, MAX_PAGES);
  // (One page after another, with a form feed between them.)
  const texts = (await run('pdftotext', ['-layout', '-f', '1', '-l', String(upTo), file, '-'])).split('\f');
  const cover = imageCover(await run('pdfimages', ['-list', '-f', '1', '-l', String(upTo), file]).catch(() => ''), pageArea);
  const out = [];
  for (let p = 1; p <= upTo; p++) {
    const text = (texts[p - 1] ?? '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    const plan = pagePlan(text, cover.get(p) ?? 0);
    if (plan === 'nothing') continue;
    const part = { label: pages > 1 ? `page ${p}` : null, text: plan === 'picture' ? '' : text };
    if (plan !== 'text') {
      // (At 150 dots to the inch: enough for print to be read, and quick.)
      const base = path.join(tmp, `p${p}`);
      await run('pdftoppm', ['-r', '150', '-png', '-singlefile', '-f', String(p), '-l', String(p), file, base]);
      part.picture = `${base}.png`;
      part.whole = true; // the picture is the whole page: where the page has text too, most of what is read in it is that text again
    }
    out.push(part);
  }
  return { parts: out, pages, ...(pages > upTo ? { cut: `only its first ${upTo} pages of ${pages} were read` } : {}) };
}

const untag = (xml) =>
  xml
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
const tidy = (t) => t.replace(/\n{3,}/g, '\n\n').trim();
const MARK = '\u0001';

// A Word file (.docx) is a zip: its text is one file in it, its pictures are others, and the
// text says where each picture stands. The parts come out in the order of the document:
// text, a picture, the text after it, and so on. A picture that is small (a logo, an icon)
// is left out, and the text on either side of it stays together.
async function readDocx(file, tmp) {
  if (!installed('unzip')) return { error: 'unzip is not installed on this machine' };
  const xml = await run('unzip', ['-p', file, 'word/document.xml']).catch(() => null);
  if (xml == null) return { error: 'the document could not be opened' };
  // Which file each picture in the text is, and how large each is.
  const rels = await run('unzip', ['-p', file, 'word/_rels/document.xml.rels']).catch(() => '');
  const fileOf = new Map();
  for (const [tag] of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(tag)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(tag)?.[1];
    if (id && target && /\.(png|jpe?g|gif|webp)$/i.test(target))
      fileOf.set(id, target.startsWith('/') ? target.slice(1) : `word/${target}`);
  }
  const listing = await run('unzip', ['-l', file]).catch(() => '');
  const sizeOf = new Map([...listing.matchAll(/^\s*(\d+)\s+\S+\s+\S+\s+(\S.*)$/gm)].map((m) => [m[2].trim(), Number(m[1])]));
  // The text, with a mark where each picture stands.
  const marked = xml.replace(/<(?:a:blip|v:imagedata)\b[^>]*?\br:(?:embed|id)="([^"]+)"[^>]*>/g, (_, id) => `${MARK}${id}${MARK}`);
  const pieces = untag(marked).split(new RegExp(`${MARK}([^${MARK}]+)${MARK}`));
  // The pictures worth reading: each once, the largest ones if there are many, in the order they stand.
  const ids = [...new Set(pieces.filter((_, i) => i % 2))].filter((id) => (sizeOf.get(fileOf.get(id)) ?? 0) >= SMALL_FILE);
  const keep = new Set([...ids].sort((a, b) => sizeOf.get(fileOf.get(b)) - sizeOf.get(fileOf.get(a))).slice(0, MAX_PICTURES));
  const parts = [];
  let text = '';
  let n = 0;
  for (const [i, piece] of pieces.entries()) {
    if (i % 2 === 0) {
      text += piece;
      continue;
    }
    if (!keep.has(piece)) continue;
    keep.delete(piece); // (one that stands in the text twice is read where it first stands)
    const name = fileOf.get(piece);
    const data = await run('unzip', ['-p', file, name], { encoding: 'buffer' }).catch(() => null);
    if (!data?.length) continue;
    // (Its name is the document's own: only its ending is used, under a name of ours.)
    const dest = path.join(tmp, `in${n++}${path.extname(name).toLowerCase()}`);
    fs.writeFileSync(dest, data, { mode: 0o600 });
    if (tidy(text)) parts.push({ label: null, text: tidy(text) });
    text = '';
    parts.push({ label: 'a picture in the document', text: '', picture: dest });
  }
  if (tidy(text) || !parts.length) parts.push({ label: null, text: tidy(text) });
  return { parts };
}

// An old Word file (.doc): its text, by antiword. The pictures in it are not read.
async function readDoc(file) {
  if (!installed('antiword'))
    return { error: 'antiword is not installed on this machine, which reads old Word files (sudo apt install antiword)' };
  // (No folding of lines, and in UTF-8 whatever this machine's language is set to.)
  const text = await run('antiword', ['-w', '0', '-m', 'UTF-8.txt', file]);
  return { parts: [{ label: null, text: tidy(text.slice(0, MAX_CHARS)) }] };
}

// Read one document. `tmp` is an empty folder for the pictures made from it, which the
// caller clears away. → { parts: [{ label, text, picture?, whole? }], pages?, cut? } or { error }
// Each part is a page, or a picture inside the document; `picture` is a file for whatever
// reads pictures, whose words belong where that part is.
export async function readDocument(file, { mime, name, tmp }) {
  try {
    const kind = kindOf(mime, name);
    if (kind === 'pdf') return await readPdf(file, tmp);
    if (kind === 'docx') return await readDocx(file, tmp);
    if (kind === 'doc') return await readDoc(file);
    if (kind === 'text') return { parts: [{ label: null, text: fs.readFileSync(file, 'utf8').slice(0, MAX_CHARS).trim() }] };
    return { error: 'not a kind of document that is read here', final: true };
  } catch (e) {
    return { error: e.message };
  }
}
