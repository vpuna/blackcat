// Waiting: for a while, or until something is so.

// Come back after a while: `await sleep(500)`. Everything else carries on meanwhile.
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Until `check()` is true, looking every `every` ms, for `ms` at most. → whether it came true
export async function until(check, { ms, every = 100 }) {
  const end = Date.now() + ms;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= end) return false;
    await sleep(every);
  }
}

// Stop this process for a while, everything in it: only for code that cannot be async and
// has a moment to wait out (another process holds a lock on a file or a database).
export const pause = (ms) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
