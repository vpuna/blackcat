// The one setting that is the reminders' own: quiet hours.

import { describeQuiet, quiet, QUIET_CHOICES, setQuiet } from '../internal.js';
const current = () => (quiet() ? `${quiet().from}-${quiet().to}` : 'none');

export const FORM = [
  {
    type: 'note',
    message:
      'Quiet hours are when nudges wait: anything a watch would nudge you about during them arrives when they end. Reminders you set yourself are not held back. (What gets picked up from your messages, and when, is the "Things I need to do" watch: /setup → Watches, or bc watch setup.)',
  },
  {
    id: 'quiet',
    type: 'select',
    message: 'Quiet hours',
    default: current,
    options: () =>
      [...new Set([...QUIET_CHOICES, ...(quiet() ? [current()] : [])])]
        .map((v) => ({ value: v, label: v.replace('-', ' to ') }))
        .concat({ value: 'none', label: 'No quiet hours' }),
  },
];

export function apply(a) {
  const problem = setQuiet(a.quiet);
  return (
    problem ??
    `Saved: ${describeQuiet()}.\nWhat is picked up from your messages, and when, is set on the "Things I need to do" watch: bc watch setup, or /setup → Watches.`
  );
}
