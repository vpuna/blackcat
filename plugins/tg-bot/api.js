// Where Telegram's Bot API is. Always Telegram itself, except in blackcat's own tests,
// which point this at a stand-in server so the real bot code can be driven end to end.
export const API_ROOT = process.env.BLACKCAT_TELEGRAM_API || 'https://api.telegram.org';

// Options for grammY's Bot, so it talks to the same place.
export const botOptions = () => (process.env.BLACKCAT_TELEGRAM_API ? { client: { apiRoot: API_ROOT } } : {});
