// The six things the agent can do, as they are offered to a model: a name, what it is for,
// and what it takes. They are blackcat's own: whichever engine runs the model, these are
// the tools, and a call to one arrives in blackcat, is put to the policy, and is carried
// out here (src/tools/run.js). The names and inputs are the ones the policy judges by
// (src/agent/policy.js): `bash { command }` is `Bash { command }` there, and so on.
const T = (name, description, properties, required = []) => ({
  name,
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
});

export const DEFS = [
  T(
    'bash',
    'Run one shell command on this machine and get what it printed. Each command starts fresh, in your own folder: a `cd` or a variable does not carry over to the next. Commands that change something, or that are not blackcat commands, are put to the owner first. To look at a file, use `read`, `glob` or `grep`, not cat or ls.',
    {
      command: { type: 'string', description: 'The command, exactly as it should be run.' },
      description: { type: 'string', description: 'A few words on why, shown to the owner when their say is needed.' },
      timeout: { type: 'number', description: 'Seconds to allow it (default 120, at most 280).' },
    },
    ['command'],
  ),
  T(
    'read',
    'Read a file: text comes back with line numbers; a picture (jpg, png, gif, webp) is shown to you; a PDF comes back as its text. Look at a picture before describing it.',
    {
      file_path: { type: 'string', description: 'The file, by its full path or relative to your own folder.' },
      offset: { type: 'number', description: 'The line to start at (the first is 1), for a long file.' },
      limit: { type: 'number', description: 'How many lines (default 2000).' },
    },
    ['file_path'],
  ),
  T(
    'glob',
    'Find files by name pattern, newest first: "*.md", "images/**/*.jpg".',
    {
      pattern: { type: 'string', description: 'The pattern. ** matches any depth of folders.' },
      path: { type: 'string', description: 'The folder to look in (default: your own folder).' },
    },
    ['pattern'],
  ),
  T(
    'grep',
    'Search inside files for a pattern (a regular expression).',
    {
      pattern: { type: 'string', description: 'What to look for.' },
      path: { type: 'string', description: 'The file or folder to search (default: your own folder).' },
      glob: { type: 'string', description: 'Only files whose name matches, e.g. "*.md".' },
      ignore_case: { type: 'boolean' },
      files_only: { type: 'boolean', description: 'Give only the names of the files that match.' },
    },
    ['pattern'],
  ),
  T(
    'write',
    "Write a file, replacing what was there. For your memory folder; anywhere else needs the owner's say.",
    { file_path: { type: 'string' }, content: { type: 'string' } },
    ['file_path', 'content'],
  ),
  T(
    'edit',
    'Change part of a file: `old_string`, exactly as it stands in the file, becomes `new_string`. It must be there, and once only, unless `replace_all` is set.',
    { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } },
    ['file_path', 'old_string', 'new_string'],
  ),
];

// The name the policy and the activity record know each by.
export const POLICY_NAME = { bash: 'Bash', read: 'Read', glob: 'Glob', grep: 'Grep', write: 'Write', edit: 'Edit' };
export const SERVER_NAME = 'blackcat';
