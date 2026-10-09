// Which thing in the home a name means, when several fit. A real case: a temperature and
// humidity sensor shows up in Home Assistant as a handful of entries (its readings, its
// battery, a firmware update, an "identify" button), and "living room temperature" must
// mean a temperature reading, never the button.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from '../plugins/ha/catalogue.js';

const E = (id, name, extra = {}) => ({
  id,
  name,
  area: 'living',
  domain: id.split('.')[0],
  available: true,
  category: null,
  hidden: false,
  ...extra,
});
const areas = [
  { id: 'living', name: 'Living Room' },
  { id: 'bed', name: 'Bedroom' },
];
const sensorDevice = (available) => [
  E('sensor.lr_th_battery', 'Living Room Temperature Humidity Battery', { deviceClass: 'battery', category: 'diagnostic', available }),
  E('update.lr_th_firmware', 'Living Room Temperature Humidity Firmware', { deviceClass: 'firmware', category: 'config', available }),
  E('sensor.lr_th_humidity', 'Living Room Temperature Humidity Humidity', { deviceClass: 'humidity', available }),
  E('button.lr_th_identify', 'Living Room Temperature Humidity Identify', { deviceClass: 'identify', category: 'diagnostic', available }),
  E('sensor.lr_th_temperature', 'Living Room Temperature Humidity Temperature', { deviceClass: 'temperature', available }),
];
const cat = (entities) => ({ areas, entities });

test('a word that names what a sensor measures means the sensor that measures it', () => {
  const c = cat(sensorDevice(true));
  assert.equal(resolve(c, 'living room temperature').entity.id, 'sensor.lr_th_temperature');
  assert.equal(resolve(c, 'living room humidity').entity.id, 'sensor.lr_th_humidity');
  assert.equal(resolve(c, 'living room battery').entity.id, 'sensor.lr_th_battery', 'said by name, a diagnostic is still found');
  assert.equal(resolve(c, ['living', 'room', 'temperature', 'humidity', 'identify']).entity.id, 'button.lr_th_identify');
});

test("asked what something reads, a device's button is never the answer", () => {
  // the device is offline (nothing of it is reachable): it is still its reading that is meant
  const c = cat(sensorDevice(false));
  assert.equal(resolve(c, 'living room temperature').entity.id, 'sensor.lr_th_temperature');
  // only a setting and a button fit: neither is guessed at
  const odd = cat([
    E('button.x_identify', 'Hall sensor Identify', { category: 'diagnostic' }),
    E('update.x_fw', 'Hall sensor Firmware', { category: 'config' }),
  ]);
  assert.match(resolve(odd, 'hall sensor').error, /"hall sensor" could be 2 things/);
  // for an action, the one thing that can be acted on is still the one meant
  assert.equal(resolve(odd, 'hall sensor', { domains: ['button'] }).entity.id, 'button.x_identify');
});

test('several readings that fit: the reachable one is meant; if several are, they are named, likeliest only', () => {
  const two = cat([...sensorDevice(false), E('sensor.tv_cabinet_temperature', 'TV Cabinet Temperature', { deviceClass: 'temperature' })]);
  assert.equal(
    resolve(two, 'living room temperature').entity.id,
    'sensor.tv_cabinet_temperature',
    'the only temperature there that can be read now',
  );
  const three = cat([
    ...sensorDevice(false),
    E('sensor.tv_cabinet_temperature', 'TV Cabinet Temperature', { deviceClass: 'temperature' }),
    E('sensor.lr_f', 'Living Room Temperature In Fahrenheit', { deviceClass: 'temperature' }),
  ]);
  const r = resolve(three, 'living room temperature');
  assert.match(
    r.error,
    /^"living room temperature" could be 2 things: TV Cabinet Temperature \(Living Room\) \[sensor\.tv_cabinet_temperature\]; Living Room Temperature In Fahrenheit \(Living Room\) \[sensor\.lr_f\]\. Say which, or use the id in brackets\.$/,
  );
  assert.doesNotMatch(r.error, /Identify|Firmware|Battery/, "not the device's other entries");
  assert.equal(resolve(three, 'tv cabinet temperature').entity.id, 'sensor.tv_cabinet_temperature');
  assert.equal(resolve(three, 'sensor.lr_f').entity.id, 'sensor.lr_f', 'an id always means that thing');
});

test('what worked before still does: a light among its sensors, and the same name twice', () => {
  const c = cat([
    E('light.lamp', 'Lamp'),
    E('sensor.lamp_power', 'Lamp Power', { deviceClass: 'power' }),
    E('sensor.lamp_signal', 'Lamp Signal', { category: 'diagnostic' }),
    E('media_player.speaker_3', 'Speaker', { available: false, area: 'bed' }),
    E('media_player.speaker', 'Speaker', { area: 'bed' }),
  ]);
  assert.equal(resolve(c, 'lamp').entity.id, 'light.lamp', 'an exact name');
  assert.equal(resolve(c, 'living room lamp', { domains: ['light', 'switch'] }).entity.id, 'light.lamp');
  assert.equal(resolve(c, 'bedroom speaker').entity.id, 'media_player.speaker', 'of two with one name, the one that is there');
  assert.match(resolve(c, 'kettle').error, /Nothing here is called "kettle"/);
  assert.match(resolve(c, '').error, /Which one\?/);
});
