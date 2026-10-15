// Taking the text out of a document on this machine: a PDF page by page (its own text where
// it has some, a picture of the page where it is one), a Word file with the pictures in it,
// a text file as it is. The rules are tested on their own; the tools themselves are tried on
// documents made here, where they are installed.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { after, test } from 'node:test';
import { imageCover, installed, kindOf, pagePlan, readDocument } from '../plugins/docs/read.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-docs-test-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const tmp = (name) => {
  const d = path.join(dir, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

test('what kind of document it is, from its type or its name', () => {
  assert.equal(kindOf('application/pdf'), 'pdf');
  assert.equal(kindOf('application/octet-stream', 'Week Ahead.PDF'), 'pdf');
  assert.equal(kindOf('application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'docx');
  assert.equal(kindOf('text/markdown; charset=utf-8'), 'text');
  assert.equal(kindOf(null, 'notes.txt'), 'text');
  assert.equal(kindOf('application/zip', 'photos.zip'), null);
  assert.equal(kindOf('application/msword', 'old.doc'), 'doc');
  assert.equal(kindOf('application/octet-stream', 'Letter.DOC'), 'doc');
  assert.equal(kindOf('application/vnd.ms-excel', 'sums.xls'), null, 'a spreadsheet is not read');
});

test('what is done with a page: its text, a picture of it, both, or nothing', () => {
  const many = 'The school will be closed on Monday for a training day and reopens on Tuesday at the usual time for all pupils.';
  assert.equal(pagePlan(many, 0), 'text');
  assert.equal(pagePlan(many, 0.1), 'text', 'a small image beside the text: a logo');
  assert.equal(pagePlan(many, 0.6), 'both', 'text, and an image large enough to hold more');
  assert.equal(pagePlan('', 0.9), 'picture', 'a scan');
  assert.equal(pagePlan('Page 3', 0.9), 'picture', 'a page number is not the text of a page');
  assert.equal(pagePlan('Page 3', 0), 'text', 'a few words and nothing else: they are all there is');
  assert.equal(pagePlan('', 0), 'nothing');
});

test("how much of a page its images cover, from the PDF's own list of them", () => {
  const list = `page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio
--------------------------------------------------------------------------------------------
   1     0 image    1240  1754  rgb     3   8  jpeg   no         7  0   150   150  210K 3.2%
   1     1 smask    1240  1754  gray    1   8  image  no         7  0   150   150 12.1K 0.6%
   2     2 image     300   300  rgb     3   8  jpeg   no         9  0   150   150   20K 7.4%
   2     3 image     300   300  rgb     3   8  jpeg   no        10  0   150   150   20K 7.4%`;
  const cover = imageCover(list, 595 * 842);
  assert.ok(cover.get(1) > 0.99, 'a full-page scan; its mask beside it is not counted twice');
  assert.ok(cover.get(2) > 0.07 && cover.get(2) < 0.1, 'two small images, added up');
  assert.equal(cover.get(3), undefined);
});

// A PDF written here by hand: pages of text, and pages that are one picture.
function pdf(pages) {
  const objs = [];
  const add = (body) => objs.push(body) && objs.length;
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  const pagesId = pages.length * 3 + 3; // reserved below
  for (const p of pages) {
    let res;
    let stream;
    if (p.jpeg) {
      const img = add(null);
      objs[img - 1] = {
        dict: `<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>`,
        data: p.jpeg,
      };
      res = `<< /XObject << /Im0 ${img} 0 R >> >>`;
      stream = Buffer.from('q 595 0 0 842 0 0 cm /Im0 Do Q');
    } else {
      add('<< >>'); // (so that every page takes three objects)
      res = `<< /Font << /F1 ${font} 0 R >> >>`;
      stream = Buffer.from(`BT /F1 14 Tf 50 780 Td 18 TL ${p.lines.map((l) => `(${l.replace(/[()\\]/g, '\\$&')}) Tj T*`).join(' ')} ET`);
    }
    const content = add({ dict: `<< /Length ${stream.length} >>`, data: stream });
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources ${res} /Contents ${content} 0 R >>`));
  }
  while (objs.length < pagesId - 1) add('<< >>');
  add(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const parts = [Buffer.from('%PDF-1.4\n')];
  const at = [];
  let pos = parts[0].length;
  objs.forEach((o, i) => {
    at.push(pos);
    const chunk =
      typeof o === 'string'
        ? Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`)
        : Buffer.concat([Buffer.from(`${i + 1} 0 obj\n${o.dict}\nstream\n`), o.data, Buffer.from('\nendstream\nendobj\n')]);
    parts.push(chunk);
    pos += chunk.length;
  });
  parts.push(
    Buffer.from(
      `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((a) => `${String(a).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${pos}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(parts);
}

test('a PDF, where the tools are installed: text pages give their text, a page that is a picture is made into one', async (t) => {
  if (!installed('pdftotext') || !installed('pdftoppm')) return t.skip('the PDF tools are not installed on this machine');
  const { default: sharp } = await import('sharp');
  const jpeg = await sharp({ create: { width: 400, height: 566, channels: 3, background: { r: 250, g: 200, b: 60 } } })
    .jpeg()
    .toBuffer();
  const file = path.join(dir, 'pack.pdf');
  fs.writeFileSync(
    file,
    pdf([
      {
        lines: [
          'Week Ahead',
          'The school will be closed on Monday for a training day.',
          'It reopens on Tuesday at the usual time for all pupils and staff.',
          'Spelling test on Friday.',
        ],
      },
      { jpeg, w: 400, h: 566 },
    ]),
  );
  const r = await readDocument(file, { mime: 'application/pdf', name: 'pack.pdf', tmp: tmp('a') });
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.pages, 2);
  assert.deepEqual(
    r.parts.map((p) => [p.label, !!p.picture]),
    [
      ['page 1', false],
      ['page 2', true],
    ],
  );
  assert.match(r.parts[0].text, /^Week Ahead\nThe school will be closed on Monday for a training day\.\nIt reopens on Tuesday/);
  assert.equal(r.parts[1].text, '');
  assert.ok(fs.statSync(r.parts[1].picture).size > 1000, 'the page as a picture, in the folder it was given');
  assert.equal(path.dirname(r.parts[1].picture), path.join(dir, 'a'));
  // what is not a PDF at all is an error, not a throw
  fs.writeFileSync(path.join(dir, 'not.pdf'), 'just some words');
  assert.match((await readDocument(path.join(dir, 'not.pdf'), { mime: 'application/pdf', name: 'not.pdf', tmp: tmp('b') })).error, /./);
});

test('a Word file: its text, and the pictures in it that are not just a logo; a text file as it is', async (t) => {
  fs.writeFileSync(path.join(dir, 'notes.md'), '# Shopping\n\n- milk\n- two lemons\n');
  assert.deepEqual(await readDocument(path.join(dir, 'notes.md'), { mime: 'text/markdown', name: 'notes.md', tmp: tmp('c') }), {
    parts: [{ label: null, text: '# Shopping\n\n- milk\n- two lemons' }],
  });
  if (spawnSync('zip', ['-v'], { stdio: 'ignore' }).error || !installed('unzip'))
    return t.skip('zip and unzip are not both installed on this machine');
  const { default: sharp } = await import('sharp');
  const src = tmp('docx');
  fs.mkdirSync(path.join(src, 'word/media'), { recursive: true });
  fs.mkdirSync(path.join(src, 'word/_rels'), { recursive: true });
  const p = (t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
  const pic = (id) =>
    `<w:p><w:r><w:drawing><a:graphic><pic:pic><pic:blipFill><a:blip r:embed="${id}"/></pic:blipFill></pic:pic></a:graphic></w:drawing></w:r></w:p>`;
  // As it stands in the document: a logo, a heading, the first picture, text, the second picture, text, and the first one again.
  fs.writeFileSync(
    path.join(src, 'word/document.xml'),
    `<w:document><w:body>${pic('rId9')}${p('Permission slip')}${pic('rId5')}${p('Return it by Friday &amp; keep a copy.')}${pic('rId6')}${p('Thank you.')}${pic('rId5')}</w:body></w:document>`,
  );
  fs.writeFileSync(
    path.join(src, 'word/_rels/document.xml.rels'),
    `<Relationships><Relationship Id="rId5" Type="x/image" Target="media/image1.png"/><Relationship Id="rId6" Type="x/image" Target="media/image2.jpeg"/><Relationship Id="rId9" Type="x/image" Target="media/logo.png"/><Relationship Id="rId1" Type="x/styles" Target="styles.xml"/></Relationships>`,
  );
  // (noise, so that it does not shrink to nothing: a real picture is tens of kilobytes)
  const noise = () => crypto.randomBytes(300 * 300 * 3);
  await sharp(noise(), { raw: { width: 300, height: 300, channels: 3 } })
    .png()
    .toFile(path.join(src, 'word/media/image1.png'));
  await sharp(noise(), { raw: { width: 300, height: 300, channels: 3 } })
    .jpeg({ quality: 95 })
    .toFile(path.join(src, 'word/media/image2.jpeg'));
  await sharp({ create: { width: 16, height: 16, channels: 3, background: '#ffffff' } })
    .png()
    .toFile(path.join(src, 'word/media/logo.png'));
  const file = path.join(dir, 'slip.docx');
  execFileSync('zip', ['-q', '-r', file, 'word'], { cwd: src });
  const r = await readDocument(file, {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    name: 'slip.docx',
    tmp: tmp('d'),
  });
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual(
    r.parts.map((x) => (x.picture ? `<${path.extname(x.picture)}>` : x.text)),
    ['Permission slip', '<.png>', 'Return it by Friday & keep a copy.', '<.jpeg>', 'Thank you.'],
    'in the order of the document: text, the picture that stands there, the text after it; the logo left out, and one that stands twice read once',
  );
  assert.ok(
    r.parts.filter((x) => x.picture).every((x) => x.label === 'a picture in the document' && fs.statSync(x.picture).size > 15 * 1024),
  );
  // with no pictures worth reading, the text is one piece
  fs.writeFileSync(
    path.join(src, 'word/document.xml'),
    `<w:document><w:body>${p('First.')}${pic('rId9')}${p('Second.')}</w:body></w:document>`,
  );
  fs.rmSync(file);
  execFileSync('zip', ['-q', '-r', file, 'word'], { cwd: src });
  assert.deepEqual((await readDocument(file, { name: 'slip.docx', tmp: tmp('f') })).parts, [{ label: null, text: 'First.\n\nSecond.' }]);
  assert.deepEqual(
    await readDocument(path.join(dir, 'x.zip'), { mime: 'application/zip', name: 'x.zip', tmp: tmp('e') }),
    { error: 'not a kind of document that is read here', final: true },
    'final: it is not tried again',
  );
});

test('an old Word file (.doc), where antiword is installed: its text', async (t) => {
  if (!installed('antiword')) return t.skip('antiword is not installed on this machine');
  // (A .doc made for this test with LibreOffice, kept packed: test/support/slip.doc.gz.)
  const file = path.join(dir, 'slip.doc');
  fs.writeFileSync(file, zlib.gunzipSync(fs.readFileSync(new URL('./support/slip.doc.gz', import.meta.url))));
  const r = await readDocument(file, { mime: 'application/msword', name: 'slip.doc', tmp: tmp('g') });
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.parts.length, 1);
  assert.match(
    r.parts[0].text,
    /^Permission slip\n\nReturn it by Friday 16 October, signed by a parent\.\n\nBring a packed lunch and a water bottle\.\n\nLine 1 of the notes: the coach leaves from the main gate at half past eight and is back by four\.\n/,
  );
  assert.match(r.parts[0].text, /Line 60 of the notes[^\n]*$/, 'all of it, and no line folded');
  fs.writeFileSync(path.join(dir, 'fake.doc'), 'not a Word file at all');
  assert.match(
    (await readDocument(path.join(dir, 'fake.doc'), { name: 'fake.doc', tmp: tmp('h') })).error,
    /./,
    'what is not one is an error, not a throw',
  );
});
