// The public archive of the Raspberry Shake network (FDSN), against a recorded
// miniSEED answer and the fake server of test/helpers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FdsnClient, FdsnError, lastSampleTime } from '../src/fdsn.js';
import { STATION, createArchive, fixturePath, mseedRecord } from './helpers/world.js';

const NOW = Date.parse('2026-11-15T16:20:00Z');
const MIN = 60_000;

test('the last sample of a recorded dataselect answer (three 512-byte records)', () => {
  const bytes = new Uint8Array(readFileSync(fixturePath('shake/r7482-dataselect-tail.mseed')));
  assert.equal(new Date(lastSampleTime(bytes)).toISOString(), '2026-11-15T15:51:06.384Z');
});

test('the header of a record gives its last sample; garbage gives null', () => {
  const start = Date.parse('2026-08-03T06:49:00.123Z');
  assert.equal(lastSampleTime(mseedRecord(start, 101)), start + 1000);
  assert.equal(lastSampleTime(new TextEncoder().encode('<html>Error</html>'.repeat(10))), null);
  assert.equal(lastSampleTime(new Uint8Array(0)), null);
});

test('the station metadata: known and open, or unknown (204)', async () => {
  const archive = createArchive();
  const client = new FdsnClient({ fetch: archive.fetch });
  assert.deepEqual(await client.station(STATION), { code: STATION, open: true });
  assert.equal(await client.station('ZZZZ9'), null);
  const url = archive.requests[0];
  assert.equal(url.origin + url.pathname, 'https://data.raspberryshake.org/fdsnws/station/1/query');
  assert.equal(url.searchParams.get('network'), 'AM');
});

test('a station online is found in one small request', async () => {
  const archive = createArchive({ lastData: NOW - 30 * MIN });
  const client = new FdsnClient({ fetch: archive.fetch });
  assert.equal(await client.lastData(STATION, NOW), NOW - 30 * MIN);
  assert.equal(archive.requests.length, 1);
  assert.equal(archive.requests[0].searchParams.get('starttime'), '2026-11-15T15:49:00');
});

test('an offline station is probed further back, stopping at the last data known', async () => {
  const archive = createArchive({ lastData: NOW - 100 * MIN });
  const client = new FdsnClient({ fetch: archive.fetch });
  const found = await client.lastData(STATION, NOW);
  // The probe ending 120 minutes ago holds no data newer than its end.
  assert.equal(found, NOW - 120 * MIN);
  assert.equal(archive.requests.length, 4);
  archive.requests.length = 0;
  // An hour later: the probes stop where the known last data is newer than them.
  assert.equal(await client.lastData(STATION, NOW + 60 * MIN, found), found);
  assert.equal(archive.requests.length, 4);
});

test('a station silent for more than a day: null, six requests at most', async () => {
  const archive = createArchive({ lastData: null });
  const client = new FdsnClient({ fetch: archive.fetch });
  assert.equal(await client.lastData(STATION, NOW), null);
  assert.equal(archive.requests.length, 6);
});

test('a known recent last data narrows the first window', async () => {
  const archive = createArchive({ lastData: NOW - 2 * MIN });
  const client = new FdsnClient({ fetch: archive.fetch });
  assert.equal(await client.lastData(STATION, NOW, NOW - 5 * MIN), NOW - 2 * MIN);
  assert.equal(archive.requests[0].searchParams.get('starttime'), '2026-11-15T16:14:00');
});

test('errors of the service are FdsnError, without the address of the house', async () => {
  const archive = createArchive();
  const client = new FdsnClient({ fetch: archive.fetch });
  archive.down = 503;
  await assert.rejects(client.station(STATION), (err) => {
    assert.ok(err instanceof FdsnError);
    assert.equal(err.message, 'data.raspberryshake.org: HTTP 503');
    return true;
  });
  archive.down = 'network';
  await assert.rejects(client.lastData(STATION, NOW), /data.raspberryshake.org: ECONNREFUSED/);
});
