import fs from 'node:fs';
import path from 'node:path';
import { dataPath } from '../../src/api.js';

export const AUTH_DIR = dataPath('wa-auth');

// Linked once WhatsApp has signed this device's identity (`account`). `me` alone
// isn't enough: requesting a pairing code sets it before the phone confirms.
export function isPaired() {
  try {
    return !!JSON.parse(fs.readFileSync(path.join(AUTH_DIR, 'creds.json'), 'utf8')).account;
  } catch {
    return false;
  }
}
