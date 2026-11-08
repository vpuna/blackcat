// What the Android commands share: the folder for pictures of screens, the device a routine
// runs on, reaching it, and waiting for a condition. (Split out of plugin.js.)
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataPath, sleep } from '../../src/api.js';
import { connect, Device, devices } from './device.js';
import { getDevice, listDevices } from './routines.js';

export const MEDIA = dataPath('android-media');
export const KEEP_PICTURES_S = 7 * 86400;
export const kindOf = (d) => (d.tv ? 'TV' : 'phone');
export const how = (d) => (d.address ? `on the network at ${d.address}` : 'on USB');

// The folder for pictures of screens, private, with those older than a week cleared away.
export function media() {
  fs.mkdirSync(MEDIA, { recursive: true, mode: 0o700 });
  for (const f of fs.readdirSync(MEDIA)) {
    const file = path.join(MEDIA, f);
    if (Date.now() - fs.statSync(file).mtimeMs > KEEP_PICTURES_S * 1000) fs.rmSync(file, { force: true });
  }
  return MEDIA;
}

// The paired device a command is for: the one named, else the routine's, else the only one.
export function chosen(ctx, on, routine) {
  const name = on ?? routine?.device ?? null;
  if (routine?.device && on && on !== routine.device) ctx.fail(`"${routine.name}" is for the ${routine.device}, not the ${on}.`);
  const all = listDevices(ctx);
  if (name) return getDevice(ctx, name) ?? ctx.fail(`No device is paired as "${name}". bc android devices lists them.`);
  if (!all.length) ctx.fail('No device is paired yet → bc android pair');
  if (all.length > 1) ctx.fail(`Which device? Add --on ${all.map((d) => d.name).join(' or --on ')}.`);
  return all[0];
}

// Reach a paired device, connecting to it first when it is on the network. → a Device, or a
// stop with what to do. (On the network, it is made sure the address still leads to it.)
export async function reach(ctx, d) {
  const target = d.address ?? d.serial;
  let found = (await devices(ctx)).find((x) => x.serial === target);
  if (d.address && found?.state !== 'device') {
    try {
      await connect(ctx, d.address);
    } catch (e) {
      ctx.fail(
        `The ${d.name} (${d.label}) cannot be reached at ${d.address}: is it on, on this network, with its debugging on? (${e.message})`,
      );
    }
    found = (await devices(ctx)).find((x) => x.serial === target);
  }
  if (!found) ctx.fail(`The ${d.name} (${d.label}) is not connected: plug it in on USB, with USB debugging on.`);
  if (found.state === 'unauthorized')
    ctx.fail(`The ${d.name} has not allowed this machine: on it, accept "Allow USB debugging?" (tick "Always allow").`);
  if (found.state !== 'device')
    ctx.fail(`The ${d.name} is ${found.state}: ${d.address ? 'turn it off and on' : 'unplug it and plug it in again'}.`);
  const dev = new Device(ctx, target);
  if (d.address) {
    const serial = await dev.shell('getprop ro.serialno');
    if (serial && serial !== d.serial)
      ctx.fail(
        `Another device answers at ${d.address} now (its address changed?). Pair the ${d.name} again: bc android pair --name ${d.name}`,
      );
  }
  return dev;
}

// What the device shows for this machine's key ("RSA key fingerprint"), to compare when it asks.
export function keyFingerprint() {
  try {
    const b64 = fs.readFileSync(path.join(os.homedir(), '.android', 'adbkey.pub'), 'utf8').split(/\s/)[0];
    return crypto.createHash('md5').update(Buffer.from(b64, 'base64')).digest('hex').match(/../g).join(':').toUpperCase();
  } catch {
    return null;
  }
}

// Wait for `test` to give something, checking every two seconds, up to `ms`.
export async function until(test, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(2000)) {
    const v = await test();
    if (v) return v;
  }
  return null;
}
