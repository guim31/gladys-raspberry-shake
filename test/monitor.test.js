// The integration against the SDK's fake Gladys: the recorded earthquake
// replayed as UDP packets, the public archive, the online state, the scene
// events, the connection status and the "Check now" action.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_ACTION } from '../src/app.js';
import { RECEIVER_CONTAINER, TRIGGERS } from '../src/monitor.js';
import { formatPacket } from '../src/shake.js';
import {
  RECORDING,
  SHAKE_IP,
  STATION,
  createArchive,
  createWorld,
  create,
  featureId,
  packetsOf,
  replay,
  settle,
  tick,
  valuesOf,
} from './helpers/world.js';

const MIN = 60_000;

async function world(t, options = {}) {
  const w = await createWorld(options);
  t.after(() => w.app.stop());
  return w;
}

test('one device per station, identified by its code', async (t) => {
  const w = await world(t, { config: { station: 'am.r6881', language: 'en' } });
  const [device] = w.fake.discoveredDevices;
  assert.match(device.external_id, /:station:R6881$/);
  assert.equal(device.name, 'Raspberry Shake R6881');
  assert.equal(device.model, 'AM.R6881');
  assert.equal(device.should_poll, false);
  assert.deepEqual(
    device.features.map((feature) => feature.external_id.split(':').pop()),
    ['online', 'last_data', 'rsam', 'peak', 'shaking'],
  );
});

test('without the UDP output, only the online state and the last data', async (t) => {
  const w = await world(t, { config: { station: STATION, udp: false } });
  const [device] = w.fake.discoveredDevices;
  assert.deepEqual(
    device.features.map((feature) => feature.external_id.split(':').pop()),
    ['online', 'last_data'],
  );
  assert.equal(w.link.started, false);
});

test('without a station code: no device, and the status says what to type', async (t) => {
  const w = await world(t, { config: {} });
  assert.deepEqual(w.fake.discoveredDevices, []);
  assert.equal(w.fake.connectionStatus.connected, false);
  assert.match(w.fake.connectionStatus.message.en, /Type the code of your station/);
  assert.equal(w.archive.requests.length, 0);
  const bad = await world(t, { config: { station: 'not a code' } });
  assert.match(bad.fake.connectionStatus.message.fr, /Ce n'est pas un code de station/);
});

test('the replayed earthquake: levels each minute, shaking on then back to calm', async (t) => {
  const w = await world(t);
  const device = await create(w);
  await replay(w, packetsOf());
  assert.deepEqual(valuesOf(w, device, 'rsam'), [887.6, 18893.9, 6621.2, 1091.5]);
  assert.deepEqual(valuesOf(w, device, 'peak'), [6321, 1163603, 134500, 11376]);
  assert.deepEqual(valuesOf(w, device, 'shaking'), [0, 1, 0]);
  assert.deepEqual(valuesOf(w, device, 'online'), [1]);
  assert.deepEqual(w.fake.sceneEvents, [
    { key: TRIGGERS.SHAKING, data: { station: STATION, ratio: 5.3 } },
    { key: TRIGGERS.CALM, data: { station: STATION, peak: 1163603, duration: 114 } },
  ]);
  assert.deepEqual(w.fake.connectionStatus, { connected: true });
});

test('the packets stop during a shaking: calm after 30 s, offline after the delay', async (t) => {
  const w = await world(t, {
    archive: createArchive({ lastData: RECORDING.start - 3 * 60 * MIN }),
  });
  const device = await create(w);
  await replay(w, packetsOf(RECORDING, { to: 100 }));
  assert.deepEqual(valuesOf(w, device, 'shaking'), [0, 1]);
  // Offline by the archive (3 hours old), online by UDP.
  assert.deepEqual(valuesOf(w, device, 'online'), [0, 1]);
  await tick(w, 15);
  assert.deepEqual(valuesOf(w, device, 'shaking'), [0, 1]);
  await tick(w, 30);
  assert.deepEqual(valuesOf(w, device, 'shaking'), [0, 1, 0]);
  assert.equal(w.fake.sceneEvents.at(-1).key, TRIGGERS.CALM);
  assert.ok(w.fake.sceneEvents.at(-1).data.peak > 1_000_000);
  // 2 minutes without UDP, the archive 3 hours old: offline.
  await tick(w, 90);
  assert.deepEqual(valuesOf(w, device, 'online'), [0, 1, 0]);
  const offline = w.fake.sceneEvents.at(-1);
  assert.equal(offline.key, TRIGGERS.OFFLINE);
  assert.deepEqual(offline.data, { station: STATION, last_data: '03/08/2026 08:50:08' });
  // 5 minutes without UDP: the status says it.
  await tick(w, 200);
  assert.equal(w.fake.connectionStatus.connected, false);
  assert.match(w.fake.connectionStatus.message.en, /No UDP data from the Shake/);
  // The packets come back.
  await replay(
    w,
    packetsOf(RECORDING, { from: 200, to: 201 }).map((p) => ({ ...p, time: w.clock.time })),
  );
  assert.deepEqual(valuesOf(w, device, 'online'), [0, 1, 0, 1]);
  assert.deepEqual(w.fake.connectionStatus, { connected: true });
  assert.equal(w.fake.sceneEvents.filter((e) => e.key === TRIGGERS.OFFLINE).length, 1);
});

test('without UDP, the archive says online, then offline when it gets too old', async (t) => {
  const w = await world(t, {
    config: { station: STATION, udp: false, offline_after: '60' },
    archive: createArchive({ lastData: RECORDING.start - 30 * MIN }),
  });
  const device = await create(w);
  assert.deepEqual(valuesOf(w, device, 'online'), [1]);
  assert.deepEqual(valuesOf(w, device, 'last_data'), ['03/08/2026 08:18:28']);
  // The station stops sending: the archive is read every 10 minutes.
  for (let i = 0; i < 8; i += 1) {
    await tick(w, 5 * 60);
  }
  assert.deepEqual(valuesOf(w, device, 'online'), [1, 0]);
  assert.equal(w.fake.sceneEvents.at(-1).key, TRIGGERS.OFFLINE);
  assert.deepEqual(w.fake.connectionStatus, { connected: true });
  // A few kilobytes per read: one window plus a few probes.
  assert.ok(w.archive.requests.length <= 30, `${w.archive.requests.length} requests`);
  // Data again.
  w.archive.lastData = w.clock.now() - 30 * MIN;
  await tick(w, 10 * 60);
  assert.deepEqual(valuesOf(w, device, 'online'), [1, 0, 1]);
  assert.equal(valuesOf(w, device, 'last_data').length, 2);
});

test('an unknown station: said in the status, UDP keeps working', async (t) => {
  const w = await world(t, { config: { station: 'ZZZZ9' } });
  assert.match(w.fake.connectionStatus.message.en, /Station ZZZZ9 is not on the Raspberry Shake/);
  // One station request, no dataselect.
  assert.equal(w.archive.requests.length, 1);
  const off = await world(t, { config: { station: 'ZZZZ9', udp: false } });
  assert.equal(off.fake.connectionStatus.connected, false);
});

test('the archive down: said in the status, once in the logs, then recovered', async (t) => {
  const archive = createArchive({ lastData: RECORDING.start - 30 * MIN });
  archive.down = 503;
  const w = await world(t, { config: { station: STATION, udp: false }, archive });
  assert.equal(w.fake.connectionStatus.connected, false);
  assert.match(w.fake.connectionStatus.message.en, /data service does not answer/);
  archive.down = false;
  await tick(w, 10 * 60);
  assert.deepEqual(w.fake.connectionStatus, { connected: true });
});

test('the address of the Shake filters the senders', async (t) => {
  const w = await world(t, { config: { station: STATION, shake_ip: SHAKE_IP } });
  const device = await create(w);
  await replay(w, packetsOf(RECORDING, { to: 70 }), { ip: '198.51.100.7' });
  assert.deepEqual(valuesOf(w, device, 'rsam'), []);
  await replay(w, packetsOf(RECORDING, { to: 70 }));
  assert.deepEqual(valuesOf(w, device, 'rsam'), [887.6]);
});

test('garbage on the UDP port is ignored', async (t) => {
  const w = await world(t);
  const device = await create(w);
  w.link.emit('packet', { ip: SHAKE_IP, data: 'GET / HTTP/1.1' });
  await settle();
  assert.equal(w.monitor.udp.lastAt, null);
  assert.deepEqual(valuesOf(w, device, 'shaking'), []);
});

test('the device added in Gladys gets every state again, older devices only theirs', async (t) => {
  const w = await world(t);
  await replay(w, packetsOf(RECORDING, { to: 100 }));
  // Nothing is published before the device is added.
  assert.deepEqual(w.fake.states, []);
  const device = await create(w);
  assert.deepEqual(
    w.fake.states.map((state) => state.device_feature_external_id.split(':').pop()).sort(),
    ['last_data', 'online', 'peak', 'rsam', 'shaking'],
  );
  assert.ok(featureId(device, 'rsam'));
  assert.ok(w.fake.widgetRefreshes.length > 0);
  // A device added without the UDP features (UDP was off): no state for them.
  const old = await world(t, { config: { station: STATION, udp: false } });
  const [oldDevice] = old.fake.discoveredDevices;
  await old.fake.deviceCreated(oldDevice);
  await old.fake.configUpdated({ station: STATION, udp: true });
  await settle();
  await replay(old, packetsOf(RECORDING, { to: 100 }));
  assert.deepEqual(
    [...new Set(old.fake.states.map((s) => s.device_feature_external_id.split(':').pop()))].sort(),
    ['last_data', 'online'],
  );
});

test('a new station code forgets the old one', async (t) => {
  const w = await world(t);
  await replay(w, packetsOf(RECORDING, { to: 100 }));
  assert.equal(w.monitor.shaking, 1);
  await w.fake.configUpdated({ station: 'R7482' });
  await settle();
  assert.equal(w.monitor.shaking, 0);
  assert.equal(w.monitor.udp.lastAt, null);
  assert.match(w.fake.discoveredDevices.at(-1).external_id, /:station:R7482$/);
});

test('the timer of the container publishes without any poll from Gladys', async (t) => {
  const w = await world(t, {
    config: { station: STATION, udp: false },
    archive: createArchive({ lastData: null }),
  });
  const device = await create(w);
  assert.deepEqual(valuesOf(w, device, 'online'), [0]);
  w.archive.lastData = w.clock.now() - 30 * MIN;
  await tick(w, 10 * 60);
  assert.deepEqual(valuesOf(w, device, 'online'), [0, 1]);
  assert.equal(w.fake.sceneEvents.length, 0);
});

test('"Check now" reads the archive at once and answers in four languages', async (t) => {
  const w = await world(t);
  await replay(w, packetsOf(RECORDING, { to: 10 }));
  const before = w.archive.requests.length;
  const {
    data: { message },
  } = await w.fake.action(CONFIG_ACTION, {});
  assert.ok(w.archive.requests.length > before);
  assert.deepEqual(Object.keys(message), ['en', 'fr', 'de', 'es']);
  assert.match(
    message.en,
    /^Station AM\.R6881 online, last data 03\/08\/2026, 08:48:3\d\. UDP: 40 packet\(s\) in the last minute\.$/,
  );
  assert.match(message.fr, /^Station AM\.R6881 en ligne, dernière donnée 03\/08\/2026 08:48:3\d\./);
});

test('the receiver unreachable three times: status, then the sub-container is started', async (t) => {
  const w = await world(t);
  for (let failures = 1; failures <= 3; failures += 1) {
    w.link.failures = failures;
    w.link.emit('down', {
      wasConnected: failures === 1,
      failures,
      error: { code: 'ECONNREFUSED' },
    });
    await settle();
  }
  assert.match(w.fake.connectionStatus.message.en, /UDP receiver does not answer/);
  const calls = w.fake.requests.filter((r) => r.path?.includes(`/container/${RECEIVER_CONTAINER}`));
  assert.equal(calls.length, 1, JSON.stringify(w.fake.requests.map((r) => r.path)));
  w.link.failures = 0;
  w.link.emit('up');
  await settle();
  assert.equal(w.fake.connectionStatus.connected, true);
});

test('a packet as the receiver sends it is the text of the Shake', () => {
  const [packet] = packetsOf(RECORDING, { to: 1 });
  assert.match(formatPacket(packet), /^\{'EHZ', 1785739708\.538, 9866, 11560, /);
});

test('a station changed during a read of the archive gets nothing of the old one', async (t) => {
  const archive = createArchive({ lastData: RECORDING.start - 30 * MIN });
  const w = await world(t, { config: { station: STATION, udp: false }, archive });
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const fetch = archive.fetch;
  archive.fetch = async (url) => (await gate, fetch(url));
  w.monitor.fdsn.fetch = archive.fetch;
  const reading = w.monitor.checkArchive(true);
  const changing = w.fake.configUpdated({ station: 'R7482', udp: false });
  release();
  await Promise.all([reading, changing]);
  await settle();
  assert.equal(w.monitor.config.station, 'R7482');
  assert.equal(w.monitor.archive.lastData, null);
  assert.equal(w.monitor.archive.known, false);
});

test('UDP turned off then on: no false "no UDP data", shaking ended for the old station', async (t) => {
  const w = await world(t);
  await create(w);
  await replay(w, packetsOf(RECORDING, { to: 100 }));
  assert.equal(w.monitor.shaking, 1);
  await w.fake.configUpdated({ station: STATION, udp: false });
  await settle();
  assert.equal(w.fake.sceneEvents.at(-1).key, TRIGGERS.CALM);
  await tick(w, 3600);
  await w.fake.configUpdated({ station: STATION, udp: true });
  await settle();
  assert.doesNotMatch(w.fake.connectionStatus.message?.en ?? '', /No UDP data/);
  const other = await world(t);
  await replay(other, packetsOf(RECORDING, { to: 100 }));
  await other.fake.configUpdated({ station: 'R7482' });
  await settle();
  const ended = other.fake.sceneEvents.at(-1);
  assert.equal(ended.key, TRIGGERS.CALM);
  assert.equal(ended.data.station, STATION);
});

test('packets dated far from the clock of Gladys are ignored', async (t) => {
  const w = await world(t);
  const [packet] = packetsOf(RECORDING, { to: 1 });
  w.link.emit('packet', {
    ip: SHAKE_IP,
    data: formatPacket({ ...packet, time: packet.time - 2 * 3600_000 }),
  });
  await settle();
  assert.equal(w.monitor.udp.lastAt, null);
});
