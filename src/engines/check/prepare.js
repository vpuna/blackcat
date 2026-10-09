// Run once inside a new temporary copy, before anything else is started in it: the made-up
// messages are loaded, so that every later process there finds an archive (and the message
// commands) from its first moment.
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from '../../config.js';
import * as sample from './sample.js';
import * as security from './security.js';

// (Only in a copy made for a check: anywhere else there is nothing for it to do.)
const made = path.join(HOME, 'check.json');
if (fs.existsSync(made)) sample.load(security.plan(HOME, JSON.parse(fs.readFileSync(made, 'utf8')).token).planted);
