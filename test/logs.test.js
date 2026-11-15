// -----------------------------------------------------------------------------
// What the integration writes to `docker logs`: at info, only the lifecycle
// (the start, the UDP stream there or gone, the station online or offline, a
// user action), never one line per packet, minute or shaking; a failure that
// repeats is logged once, plus one line when it is over.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_ACTION } from '../src/app.js';
import {
  RECORDING,
  captureLogs,
  create,
  createArchive,
  createWorld,
  packetsOf,
  replay,
  tick,
} from './helpers/world.js';

const strip = (line) => line.text.replace(/^\[[^\]]+\] /, '');

async function world(t, options = {}) {
  const w = await createWorld(options);
  t.after(() => w.app.stop());
  return w;
}

test('the start, then the UDP stream: a few info lines, then nothing for the earthquake', async (t) => {
  const lines = captureLogs(t, 'info');
  const w = await world(t);
  await create(w);
  await replay(w, packetsOf());
  for (let i = 0; i < 3; i += 1) {
    await tick(w, 15);
  }
  assert.equal(w.fake.sceneEvents.length, 2);
  assert.deepEqual(lines.map(strip), [
    '[INFO] [raspberry-shake] Started: station AM.R6881, UDP output on',
    '[INFO] [raspberry-shake] Receiving UDP data from the Shake (channel EHZ)',
  ]);
});

test('LOG_LEVEL=debug shows the minutes and the shaking', async (t) => {
  const lines = captureLogs(t, 'debug');
  const w = await world(t);
  await replay(w, packetsOf());
  const all = lines.map((line) => line.text).join('\n');
  assert.match(all, /Minute 2026-08-03T06:49:00.000Z: RSAM 18893.9, peak 1163603/);
  assert.match(all, /Shaking detected \(STA\/LTA 5.3\)/);
  assert.match(all, /Back to calm: peak 1163603, 114 s/);
});

test('the archive down at every read: one warning, then one line when it answers', async (t) => {
  const archive = createArchive({ lastData: RECORDING.start - 30 * 60 * 1000 });
  const w = await world(t, {
    archive,
    config: { station: 'R6881', udp: false, offline_after: '360' },
  });
  const lines = captureLogs(t, 'info');
  archive.down = 503;
  for (let i = 0; i < 3; i += 1) {
    await tick(w, 10 * 60);
  }
  archive.down = false;
  await tick(w, 10 * 60);
  assert.deepEqual(lines.map(strip), [
    '[WARN] [raspberry-shake] Raspberry Shake data service unreachable: data.raspberryshake.org: HTTP 503',
    '[INFO] [raspberry-shake] The Raspberry Shake data service answers again',
  ]);
});

test('states refused: one warning, then one line at recovery', async (t) => {
  const w = await world(t);
  await create(w);
  const lines = captureLogs(t, 'info');
  const publish = t.mock.method(w.gladys, 'publishChangedStates', async () => {
    throw new Error('Gladys unreachable');
  });
  await replay(w, packetsOf());
  assert.ok(publish.mock.callCount() >= 3);
  publish.mock.restore();
  // What Gladys refused is sent again at the next tick.
  await tick(w, 15);
  assert.deepEqual(lines.map(strip), [
    '[INFO] [raspberry-shake] Receiving UDP data from the Shake (channel EHZ)',
    '[WARN] [raspberry-shake] Publishing the states failed: Gladys unreachable',
    '[INFO] [raspberry-shake] Publishing the states works again',
  ]);
});

test('a user action is one info line; a stranger on the port is said once', async (t) => {
  const w = await world(t, { config: { station: 'R6881', shake_ip: '192.0.2.10' } });
  const lines = captureLogs(t, 'info');
  await w.fake.action(CONFIG_ACTION, {});
  await replay(w, packetsOf(RECORDING, { to: 5 }), { ip: '198.51.100.7' });
  assert.deepEqual(lines.map(strip), [
    '[INFO] [raspberry-shake] Check requested',
    '[WARN] [raspberry-shake] UDP packets from 198.51.100.7 ignored: not the address of the Shake',
  ]);
});

test('a Shake whose clock is days off: one warning, whatever the dates', async (t) => {
  const w = await world(t);
  const lines = captureLogs(t, 'info');
  const packets = packetsOf(RECORDING, { to: 3 }).map((p) => ({
    ...p,
    time: p.time - 3 * 86_400_000,
  }));
  await replay(w, packets, { lag: 3 * 86_400_000 + 300 });
  assert.deepEqual(lines.map(strip), [
    '[WARN] [raspberry-shake] UDP packets from 192.0.2.10 ignored: their date is more than a day off, check the clock (NTP) of the Shake',
  ]);
});
