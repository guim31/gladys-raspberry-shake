// -----------------------------------------------------------------------------
// Sends the recorded earthquake of test/fixtures as a Raspberry Shake would:
// one UDP datagram of 25 samples every quarter of a second, timestamps moved
// to now. For a real test without a Shake: point it at the address and the
// port shown in the configuration screen of the integration.
//
//   node tools/replay.js <host> <port> [speed]
//
// `speed` 2 sends twice as fast (the timestamps keep their spacing).
// -----------------------------------------------------------------------------

import dgram from 'node:dgram';
import { readFileSync } from 'node:fs';
import { formatPacket } from '../src/shake.js';

const [host, portText, speedText = '1'] = process.argv.slice(2);
const port = Number(portText);
const speed = Number(speedText);
if (!host || !Number.isInteger(port) || !(speed > 0)) {
  console.error('Usage: node tools/replay.js <host> <port> [speed]');
  process.exit(2);
}

const recording = JSON.parse(
  readFileSync(new URL('../test/fixtures/shake/r6881-ehz-2026-08-03.json', import.meta.url)),
);
const size = 25;
const period = 1000 / recording.rate;
const shift = Date.now() - recording.start;
const socket = dgram.createSocket('udp4');
const started = Date.now();
let index = 0;

function next() {
  if (index >= recording.samples.length) {
    socket.close();
    console.log(`Sent ${Math.ceil(recording.samples.length / size)} packets`);
    return;
  }
  const packet = {
    channel: recording.channel,
    time: Math.round(recording.start + shift + index * period),
    samples: recording.samples.slice(index, index + size),
  };
  socket.send(formatPacket(packet), port, host);
  index += size;
  const due = started + (index * period) / speed;
  setTimeout(next, Math.max(0, due - Date.now()));
}

console.log(`Replaying ${recording.station} ${recording.channel} to ${host}:${port}...`);
next();
