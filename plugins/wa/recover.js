// `bc wa recover`: ask the phone again for the messages of the days of history chosen (bc wa
// select), and keep what is missing. The asking is done by the service (the one process linked to WhatsApp); how the
// work is left for it and waited for is the same for every source (src/archive/recovery.js).
import { plural, recoverCommand, recoveredText } from '../../src/api.js';
import { isPaired } from './paired.js';
import { openRequestsDb } from './requests.js';
import { waSettings } from './settings.js';

const head = (days, chats) => `Asked your phone for ${days} days of history of ${plural(chats, 'chat')}`;
export const say = (r, { days }) => recoveredText(r, head(days, r.chats));

export const recover = (ctx, i) =>
  recoverCommand(ctx, i, {
    source: 'wa',
    label: 'WhatsApp',
    linked: isPaired,
    notLinked: 'WhatsApp is not linked: bc wa pair',
    keptDays: waSettings().days,
    stored: true,
    stateKey: 'state',
    notConnected: 'WhatsApp is not connected right now, so the phone cannot be asked: bc status',
    open: openRequestsDb,
    table: 'wa_requests',
    head,
  });
