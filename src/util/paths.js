// A path as a person writes it: `~` at its start is their home folder.
import os from 'node:os';
import path from 'node:path';

// "~/notes" → "/home/me/notes". Anything else is as it was.
export const expandHome = (p) => String(p ?? '').replace(/^~(?=$|\/)/, os.homedir());
// The same, made a full path (relative to where the process is, when it is neither).
export const resolveHome = (p) => path.resolve(expandHome(p));
