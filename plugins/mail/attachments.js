// Fetching one attachment of a kept mail from the mail server, when something asks for it
// (bc msg media <id>, or a watch that reads attachments). Reached through the plugin's
// `source.fetchMedia`.
import { download, withMailbox } from './imap.js';

// id: "mail:<account>:<uid>:<n>"; part: where in the mail the file is.
export async function fetchAttachment(ctx, id, part, dest) {
  const m = /^mail:([a-z0-9_-]+):(\d+):\d+$/.exec(id);
  const acct = m && ctx.config.get().accounts?.[m[1]];
  if (!acct) throw new Error('its mail account is no longer connected');
  await withMailbox({ host: acct.host, port: acct.port ?? 993, user: acct.address, pass: ctx.secrets.get(`password:${m[1]}`) }, (c) =>
    download(c, Number(m[2]), part, dest),
  );
}
