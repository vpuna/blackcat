// Every line says when: what a service prints is kept in a file of its own (bc logs).
const stamp = () => `${new Date().toISOString()} `;

let quiet = false;
// `bc chat` shares the terminal with the conversation, so it turns the service log off.
export const setQuiet = (on) => (quiet = on);

// (A scheduled job's answer is what it prints, read by whoever started it: its log lines go
// beside that, where they are kept if it fails, and never into the answer.)
const print = (line) => (process.env.BLACKCAT_JOB ? console.error(line) : console.log(line));
export const log = (msg) => quiet || print(`${stamp()}${msg}`);
