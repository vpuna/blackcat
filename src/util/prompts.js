// Questions asked in a terminal by more than one source.
import * as p from '@clack/prompts';

// The answer to a question, or leave if it was cancelled (Ctrl+C).
export function orExit(value) {
  if (p.isCancel(value)) {
    p.cancel('Cancelled');
    process.exit(0);
  }
  return value;
}

// How many days of history to keep.
export async function askDays(current = 30) {
  const presets = [7, 14, 30, 90];
  const choice = orExit(
    await p.select({
      message: 'How far back should blackcat keep messages?',
      initialValue: presets.includes(current) ? current : 'custom',
      options: [
        ...presets.map((d) => ({ value: d, label: `Last ${d} days` })),
        { value: 'custom', label: 'Custom…', hint: presets.includes(current) ? undefined : `now ${current}` },
      ],
    }),
  );
  if (choice !== 'custom') return choice;
  return Number(
    orExit(
      await p.text({
        message: 'How many days?',
        initialValue: String(current),
        validate: (v) => (/^\d+$/.test(v) && +v >= 1 && +v <= 3650 ? undefined : 'A whole number from 1 to 3650'),
      }),
    ),
  );
}
