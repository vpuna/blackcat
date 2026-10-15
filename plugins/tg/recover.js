// `bc tg account recover`: go through the messages of the last days again and keep what is
// missing. The reading is done by the service (the one process logged in to the account); how
// the work is left for it and waited for is the same for every source (src/archive/recovery.js).
import { plural, recoverCommand, recoveredText } from '../../src/api.js';
import { isLinked, tgaSettings } from './paired.js';
import { openRequestsDb } from './requests.js';

const head = (days, chats) => `Went through the last ${days} days of ${plural(chats, 'chat')} on Telegram again`;
export const say = (r, { days }) => recoveredText(r, head(days, r.chats));

export const recover = (ctx, i) =>
  recoverCommand(ctx, i, {
    source: 'tg',
    label: 'Telegram',
    linked: isLinked,
    notLinked: 'Your Telegram account is not linked: bc tg account pair',
    keptDays: tgaSettings().days,
    stateKey: 'tg_state',
    notConnected: 'Telegram is not connected right now: bc status',
    open: openRequestsDb,
    table: 'tg_jobs',
    head,
  });
