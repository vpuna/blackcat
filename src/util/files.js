import fs from 'node:fs';

// Write a whole file so that a reader sees the old one or the new one, never half of one:
// into a temporary file of this process's own (two writers can't write into the same one),
// then renamed into place. Private to the owner unless said otherwise.
export function writeAtomic(file, text, mode = 0o600) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
