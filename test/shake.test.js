// The UDP packet format of the Shake, and the analysis of a real recording.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Analyzer } from '../src/analysis.js';
import { SENSITIVITIES } from '../src/config.js';
import { formatPacket, parsePacket } from '../src/shake.js';
import { RECORDING, packetsOf } from './helpers/world.js';

// The example of the Raspberry Shake manual (manual.raspberryshake.org/udp.html).
const MANUAL = "{'SHZ', 1507760140.530, 614, 916, 1095, 1156, 839, 923, 861, 856, 861, 789}";

test('a packet of the manual is parsed', () => {
  assert.deepEqual(parsePacket(MANUAL), {
    channel: 'SHZ',
    time: 1507760140530,
    samples: [614, 916, 1095, 1156, 839, 923, 861, 856, 861, 789],
  });
  assert.deepEqual(parsePacket(Buffer.from(`${MANUAL}\n`))?.channel, 'SHZ');
});

test('what is not a Shake packet is refused', () => {
  for (const bad of [
    '',
    'hello',
    "{'EHZ', 1507760140.530}",
    "{'EHZ', abc, 1, 2}",
    "{'EHZ', 1507760140.530, 1, 2.5}",
    "{'E', 1507760140.530, 1, 2}",
    `{'EHZ', 1507760140.530, ${Array(1001).fill(1).join(', ')}}`,
  ]) {
    assert.equal(parsePacket(bad), null, bad);
  }
});

test('formatPacket writes what parsePacket reads', () => {
  const packet = { channel: 'EHZ', time: 1785739708538, samples: [9866, -11560, 0] };
  assert.equal(formatPacket(packet), "{'EHZ', 1785739708.538, 9866, -11560, 0}");
  assert.deepEqual(parsePacket(formatPacket(packet)), packet);
});

const run = (analyzer, packets) => packets.flatMap((packet) => analyzer.push(packet));
const hhmmss = (time) => new Date(time).toISOString().slice(11, 19);

test('the recorded M3.7 earthquake triggers once, then calm comes back', () => {
  const events = run(new Analyzer(SENSITIVITIES.normal), packetsOf());
  const triggers = events.filter((event) => event.type !== 'minute');
  assert.deepEqual(
    triggers.map((event) => [event.type, hhmmss(event.time)]),
    [
      ['on', '06:49:52'],
      ['off', '06:51:45'],
    ],
  );
  assert.equal(triggers[0].ratio, 5.3);
  assert.equal(triggers[1].peak, 1163603);
  assert.equal(Math.round(triggers[1].durationMs / 1000), 114);
  assert.deepEqual(
    events.filter((event) => event.type === 'minute').map((e) => [hhmmss(e.time), e.rsam, e.peak]),
    [
      ['06:48:00', 887.6, 6321],
      ['06:49:00', 18893.9, 1163603],
      ['06:50:00', 6621.2, 134500],
      ['06:51:00', 1091.5, 11376],
    ],
  );
});

test('every sensitivity catches the earthquake, none triggers on the noise before it', () => {
  for (const [name, trigger] of Object.entries(SENSITIVITIES)) {
    const noise = run(new Analyzer(trigger), packetsOf(RECORDING, { to: 78 }));
    assert.deepEqual(
      noise.filter((event) => event.type === 'on'),
      [],
      name,
    );
    const all = run(new Analyzer(trigger), packetsOf());
    assert.equal(all.filter((event) => event.type === 'on').length, 1, name);
  }
});

test('the sample rate comes from the spacing of the packets', () => {
  const analyzer = new Analyzer();
  const packets = packetsOf(RECORDING, { to: 10, size: 50 }).map((packet, index) => ({
    ...packet,
    time: RECORDING.start + index * 1000, // 50 samples a second
  }));
  run(analyzer, packets);
  assert.equal(analyzer.rate, 50);
});

test('a gap restarts the filters and ends a running trigger', () => {
  const analyzer = new Analyzer();
  run(analyzer, packetsOf(RECORDING, { to: 90 }));
  assert.ok(analyzer.triggered);
  const later = packetsOf(RECORDING, { from: 200 }).map((packet) => ({
    ...packet,
    time: packet.time + 60_000,
  }));
  const events = run(analyzer, later.slice(0, 1));
  assert.equal(events.find((event) => event.type === 'off')?.peak > 1_000_000, true);
  assert.equal(analyzer.triggered, null);
  assert.ok(analyzer.warm <= 25);
});

test('late or repeated packets are dropped', () => {
  const analyzer = new Analyzer();
  const packets = packetsOf(RECORDING, { to: 5 });
  run(analyzer, packets);
  const warm = analyzer.warm;
  analyzer.push(packets[3]);
  assert.equal(analyzer.warm, warm);
});

test('the vertical geophone is preferred, the infrasound channel ignored', () => {
  const analyzer = new Analyzer();
  const [first] = packetsOf(RECORDING, { to: 1 });
  analyzer.push({ ...first, channel: 'HDF' });
  assert.equal(analyzer.channel, null);
  analyzer.push({ ...first, channel: 'EHN' });
  assert.equal(analyzer.channel, 'EHN');
  analyzer.push({ ...first, channel: 'EHZ', time: first.time + 250 });
  assert.equal(analyzer.channel, 'EHZ');
  analyzer.push({ ...first, channel: 'EHN', time: first.time + 500 });
  assert.equal(analyzer.channel, 'EHZ');
  // EHZ silent for long: another channel takes over.
  analyzer.push({ ...first, channel: 'EHN', time: first.time + 20_000 });
  assert.equal(analyzer.channel, 'EHN');
});
