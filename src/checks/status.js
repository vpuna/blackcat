import { listChecks, openChecksDb } from './db.js';
import { withDb } from '../db.js';

// How many checks there are and how they are doing, for the status line.
export function count() {
  return withDb(openChecksDb, (db) => {
    const all = listChecks(db);
    return {
      all: all.length,
      failing: all.filter((c) => c.active && c.state?.status === 'failing').length,
      paused: all.filter((c) => !c.active).length,
    };
  });
}
