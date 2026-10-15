// Reading the text in a picture on this machine: two readings of it, and one score from how
// far they agree. What the score is made of is tested on tables of words as Tesseract gives
// them; Tesseract itself is tried on a picture made here, where it is installed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { available, combine, parseTsv, readPicture } from '../plugins/ocr/read.js';

// A table as Tesseract prints it: a heading, then a row for each word.
const tsv = (words) =>
  [
    'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
    '1\t1\t0\t0\t0\t0\t0\t0\t100\t100\t-1\t',
  ]
    .concat(words.map(([text, conf, line = 1], i) => `5\t1\t1\t1\t${line}\t${i + 1}\t0\t0\t10\t10\t${conf}\t${text}`))
    .join('\n');
const words = (...w) => parseTsv(tsv(w));

test('a page both readings agree on is sure, and comes out in its lines', () => {
  const page = words(
    ['Your', 96, 1],
    ['appointment', 95, 1],
    ['is', 96, 1],
    ['confirmed', 94, 1],
    ['Saturday', 96, 2],
    ['at', 96, 2],
    ['08:00', 93, 2],
  );
  const r = combine(page, page);
  assert.equal(r.text, 'Your appointment is confirmed\nSaturday at 08:00');
  assert.deepEqual(r.extra, []);
  assert.ok(r.score >= 90, `sure of it: ${r.score}`);
  assert.equal(r.words, 5, 'the words that count: three letters or more, a time, a date');
});

test('what only the second reading found is added apart, and pulls the score down', () => {
  // (the spelling list: as a page, the heading and two words; scattered, the rest of them)
  const page = words(['Statutory', 96, 1], ['words', 96, 1], ['1', 96, 1], ['equipped', 71, 2], ['harass', 96, 3]);
  const sparse = words(
    ['exaggerate', 96],
    ['occur', 96],
    ['correspond.', 88],
    ['interrupt', 96],
    ['embarrass]', 50],
    ['immediate', 96],
    ['equipped', 71],
    ['harass', 96],
    ['profession', 95],
  );
  const r = combine(page, sparse);
  assert.equal(r.text, 'Statutory words 1\nequipped\nharass');
  assert.deepEqual(
    r.extra,
    ['exaggerate', 'occur', 'correspond', 'interrupt', 'immediate', 'profession'],
    'in order, once each, without what was not read surely',
  );
  assert.ok(r.score < 50, `not sure it got everything: ${r.score}`);
});

test('words read without confidence, and marks taken for letters, count against it and stay out of the text', () => {
  const page = words(
    ['Meeting', 95, 1],
    ['moved', 93, 1],
    ['to', 96, 1],
    ['Lmmediate', 45, 2],
    ['ft', 30, 3],
    ['©', 20, 3],
    ['Thursday', 92, 4],
  );
  const r = combine(page, page);
  assert.equal(r.text, 'Meeting moved to\nLmmediate\nThursday', 'one read badly is still shown; marks are not');
  assert.ok(r.score < 80 && r.score > 50, `one of four words was not read surely: ${r.score}`);
});

test('a photo, where neither reading finds three words, has no text: and that is sure', () => {
  assert.deepEqual(combine(words(), words(['fat', 70], ['HIG', 62])), { text: '', extra: [], score: 100, words: 0 });
  assert.deepEqual(combine(words(['|', 80], ['7', 90]), words()), { text: '', extra: [], score: 100, words: 0 });
  // an invitation card: nothing as a page, a sentence when looked for
  const card = combine(words(), words(['come', 90], ['celebrate', 92], ['with', 95], ['Sunday', 91], ['25th', 90]));
  assert.equal(card.text, '');
  assert.deepEqual(card.extra, ['come', 'celebrate', 'with', 'Sunday', '25th']);
  assert.equal(card.score, 0, 'there is text, and the reading as a page got none of it');
});

test('Tesseract itself, where it is installed: a picture made here is read, and a blank one has no text', async (t) => {
  if (!available()) return t.skip('Tesseract is not installed on this machine');
  const { default: sharp } = await import('sharp');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-ocr-test-'));
  try {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="360"><rect width="100%" height="100%" fill="white"/>
      <text x="40" y="100" font-size="46" font-family="DejaVu Sans, sans-serif">Your appointment is confirmed</text>
      <text x="40" y="200" font-size="46" font-family="DejaVu Sans, sans-serif">Saturday 17 October at 08:00</text></svg>`;
    await sharp(Buffer.from(svg)).jpeg().toFile(path.join(dir, 'text.jpg'));
    await sharp({ create: { width: 600, height: 400, channels: 3, background: { r: 90, g: 140, b: 200 } } })
      .webp()
      .toFile(path.join(dir, 'blank.webp'));
    const r = await readPicture(path.join(dir, 'text.jpg'));
    assert.match(r.text, /appointment is confirmed/);
    assert.match(r.text, /Saturday 17 October/);
    assert.ok(r.score >= 80, `a clean picture: ${r.score}`);
    const blank = await readPicture(path.join(dir, 'blank.webp'));
    assert.deepEqual([blank.text, blank.score, blank.words], ['', 100, 0]);
    assert.match((await readPicture(path.join(dir, 'missing.jpg'))).error, /./, 'one that is not there is an error, not a throw');
    assert.deepEqual(
      fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('blackcat-ocr-') && !f.startsWith('blackcat-ocr-test-')),
      [],
      'nothing is left behind',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
