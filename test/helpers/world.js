// -----------------------------------------------------------------------------
// A complete test world: the SDK's fake Gladys, a fake receiver link (the UDP
// packets are pushed by the test), a fake Raspberry Shake FDSN server (the
// recorded station answer, miniSEED headers built for the asked window), a
// manual clock, and the integration wired on top through registerHandlers.
// Nothing touches the network.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';
import { formatPacket } from '../../src/shake.js';

process.env.LOG_LEVEL ??= 'silent';
process.env.TZ = 'Europe/Paris';

export const fixturePath = (name) => new URL(`../fixtures/${name}`, import.meta.url);
export const fixture = (name) => JSON.parse(readFileSync(fixturePath(name), 'utf8'));
export const fixtureText = (name) => readFileSync(fixturePath(name), 'utf8');

// The recording of station R6881: the M3.7 Pyrenees earthquake of 03/08/2026
// 06:49:49 UTC, 5 km away. Samples from 06:48:28.538 to 06:52:30 UTC.
export const RECORDING = fixture('shake/r6881-ehz-2026-08-03.json');
export const STATION = 'R6881';
export const SHAKE_IP = '192.0.2.10';

/** The recording as Shake packets (25 samples, a quarter of a second). */
export function packetsOf(recording = RECORDING, { from = 0, to = Infinity, size = 25 } = {}) {
  const packets = [];
  const period = 1000 / recording.rate;
  const end = Math.min(recording.samples.length, to * recording.rate);
  for (let i = from * recording.rate; i < end; i += size) {
    packets.push({
      channel: recording.channel,
      time: Math.round(recording.start + i * period),
      samples: recording.samples.slice(i, i + size),
    });
  }
  return packets;
}

/** One miniSEED (v2) record header: start, sample count, 100 sps, 512 bytes. */
export function mseedRecord(start, count, rate = 100) {
  const bytes = new Uint8Array(512);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('000001D '), 0);
  bytes.set(new TextEncoder().encode(`${STATION}  EHZAM`), 8);
  const date = new Date(start);
  const year = date.getUTCFullYear();
  const day = Math.floor((start - Date.UTC(year, 0, 1)) / 86400000) + 1;
  view.setUint16(20, year);
  view.setUint16(22, day);
  bytes[24] = date.getUTCHours();
  bytes[25] = date.getUTCMinutes();
  bytes[26] = date.getUTCSeconds();
  view.setUint16(28, date.getUTCMilliseconds() * 10);
  view.setUint16(30, count);
  view.setInt16(32, rate);
  view.setInt16(34, 1);
  view.setUint16(44, 64);
  view.setUint16(46, 48);
  view.setUint16(48, 1000);
  bytes[52] = 11;
  bytes[53] = 1;
  bytes[54] = 9;
  return bytes;
}

/**
 * Fake FDSN server. `archive.lastData`: the last sample the archive holds (ms)
 * or null; `archive.known`: the station exists; `archive.down`: 'network',
 * a status, or false.
 */
export function createArchive({ lastData = null, known = true } = {}) {
  const archive = {
    lastData,
    known,
    down: false,
    requests: [],
    async fetch(input) {
      const url = new URL(input);
      archive.requests.push(url);
      if (archive.down === 'network') {
        throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
      }
      if (archive.down) {
        return { status: archive.down, text: async () => 'Service Unavailable' };
      }
      const params = url.searchParams;
      const empty = {
        status: 204,
        text: async () => '',
        arrayBuffer: async () => new ArrayBuffer(0),
      };
      if (params.get('station') !== STATION || !archive.known) {
        return empty;
      }
      if (url.pathname.endsWith('/station/1/query')) {
        return { status: 200, text: async () => fixtureText('shake/station-r6881.txt') };
      }
      const start = Date.parse(`${params.get('starttime')}Z`);
      const end = Date.parse(`${params.get('endtime')}Z`);
      if (archive.lastData === null || archive.lastData < start) {
        return empty;
      }
      const last = Math.min(archive.lastData, end);
      // A record of 3.5 s ending on the last sample.
      const record = mseedRecord(last - 3490, 350);
      return { status: 200, arrayBuffer: async () => record.buffer };
    },
  };
  return archive;
}

/** Fake link to the receiver: the test pushes the packets. */
export class FakeLink extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.failures = 0;
    this.started = false;
  }
  start() {
    this.started = true;
    this.connected = true;
  }
  stop() {
    this.started = false;
    this.connected = false;
  }
}

/** A manual clock. */
export function createClock(start = RECORDING.start) {
  const clock = {
    time: start,
    now: () => clock.time,
    advance(ms) {
      clock.time += ms;
    },
  };
  return clock;
}

/** Lets the microtasks and the zero-delay timers run. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

export const CONFIG = { station: STATION };

/**
 * @param {object} [options]
 * @param {object} [options.config] raw integration config
 * @param {Array} [options.devices] devices already created in Gladys
 */
export async function createWorld({
  config = CONFIG,
  devices = [],
  archive = createArchive({ lastData: RECORDING.start - 30 * 60 * 1000 }),
  connect = true,
  clock = createClock(),
} = {}) {
  const gladys = createFakeGladys({ config, devices });
  const link = new FakeLink();
  const app = registerHandlers(gladys, {
    link,
    fetch: archive.fetch,
    timers: false,
    now: clock.now,
  });
  if (connect) {
    await gladys.connect();
    await app.ready;
    await settle();
  }
  return { gladys, fake: gladys.fake, app, monitor: app.monitor, link, archive, clock };
}

/** Create the device in Gladys, as the user would. */
export async function create(world) {
  const [device] = world.fake.discoveredDevices;
  await world.fake.deviceCreated(device);
  await settle();
  return device;
}

/** External id of one feature of a device. */
export const featureId = (device, key) =>
  device.features.find((feature) => feature.external_id.endsWith(`:${key}`))?.external_id;

/** The packets, as the receiver forwards them, the clock following their time. */
export async function replay(world, packets, { ip = SHAKE_IP, lag = 300 } = {}) {
  for (const packet of packets) {
    world.clock.time = packet.time + lag;
    world.link.emit('packet', { ip, data: formatPacket(packet) });
  }
  await settle();
  await settle();
}

/** One tick of the monitor's timer, `seconds` later. */
export async function tick(world, seconds = 15) {
  world.clock.advance(seconds * 1000);
  await world.monitor.tick();
  await settle();
}

/** The values published for one feature, in order. */
export const valuesOf = (world, device, key) => {
  const id = featureId(device, key);
  return world.fake.states
    .filter((state) => state.device_feature_external_id === id)
    .map((state) => state.text ?? state.state);
};

/**
 * Capture the integration's log lines at `level` and above (LOG_LEVEL is read
 * at every call). Returns the lines as `{ level, text }`.
 */
export function captureLogs(t, level = 'info') {
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = level;
  const lines = [];
  const record = (...args) => {
    const text = args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' ');
    const match = /^\[[^\]]+\] \[(\w+)\]/.exec(text);
    lines.push({ level: match ? match[1].toLowerCase() : 'raw', text });
  };
  t.mock.method(console, 'log', record);
  t.mock.method(console, 'error', record);
  t.after(() => {
    process.env.LOG_LEVEL = previous;
  });
  return lines;
}
