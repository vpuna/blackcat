// A stand-in for `claude` asked one question with no tools (a reader). It answers with
// nothing found: text "[]", and, when an answer of a given shape was asked for
// (--json-schema), the emptiest object that fits it. Each call is noted in FAKE_READER_LOG.
import fs from 'node:fs';
const args = process.argv.slice(2);
const i = args.indexOf('--json-schema');
const empty = (s) =>
  s.type === 'array'
    ? []
    : s.type === 'boolean'
      ? true
      : s.type === 'number' || s.type === 'integer'
        ? 0
        : s.type === 'object'
          ? Object.fromEntries((s.required ?? []).map((k) => [k, empty(s.properties?.[k] ?? {})]))
          : 'nothing to report';
process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  if (process.env.FAKE_READER_LOG) fs.appendFileSync(process.env.FAKE_READER_LOG, 'x\n');
  const out = { type: 'result', is_error: false, result: '[]' };
  if (i >= 0) out.structured_output = empty(JSON.parse(args[i + 1]));
  console.log(JSON.stringify(out));
});
