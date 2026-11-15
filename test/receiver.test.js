// The receiver (src/receiver.js) and the link of the main container
// (src/link.js), with real sockets on the loopback interface: UDP datagrams
// of the Shake in, the same text out to the main container, the flood cap.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { ReceiverLink } from '../src/link.js';
import { MAX_RATE_PER_IP, Receiver } from '../src/receiver.js';
import { formatPacket } from '../src/shake.js';
import { RECORDING, packetsOf } from './helpers/world.js';

process.env.LOG_LEVEL ??= 'silent';

async function until(predicate, what) {
  for (let i = 0; i < 300; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function setup(t, options = {}) {
  const receiver = new Receiver({ udpPort: 0, linkPort: 0, host: '127.0.0.1', ...options });
  await receiver.start();
  const link = new ReceiverLink({ host: '127.0.0.1', port: receiver.linkPort, minDelayMs: 20 });
  const packets = [];
  link.on('packet', (item) => packets.push(item));
  link.start();
  const socket = dgram.createSocket('udp4');
  t.after(async () => {
    link.stop();
    socket.close();
    await receiver.stop();
  });
  await until(() => link.connected && receiver.link, 'the link');
  const send = (text) =>
    new Promise((resolve, reject) =>
      socket.send(Buffer.from(text), receiver.udpPort, '127.0.0.1', (err) =>
        err ? reject(err) : resolve(),
      ),
    );
  return { receiver, link, packets, send };
}

test('the datagrams of the Shake reach the main container, as they are', async (t) => {
  const { packets, send } = await setup(t);
  const sent = packetsOf(RECORDING, { to: 2 }).map(formatPacket);
  for (const text of sent) {
    await send(text);
  }
  await until(() => packets.length === sent.length, 'the packets');
  assert.deepEqual(
    packets.map((item) => item.data),
    sent,
  );
  assert.equal(packets[0].ip, '127.0.0.1');
});

test('a flood is capped, and nothing is kept while the main container is away', async (t) => {
  let now = 1_000_000;
  const { receiver, link, packets, send } = await setup(t, { now: () => now });
  // One sender is capped on its own.
  for (let i = 0; i < MAX_RATE_PER_IP + 50; i += 1) {
    await send(`{'EHZ', 1.0, ${i}}`);
  }
  await until(() => receiver.count === MAX_RATE_PER_IP + 50, 'every datagram counted');
  await until(() => packets.length === MAX_RATE_PER_IP, 'the capped packets');
  assert.equal(receiver.dropped, 50);
  link.stop();
  await until(() => !receiver.link, 'the link closed');
  now += 1000;
  await send("{'EHZ', 2.0, 1}");
  await until(() => receiver.count === 1, 'the datagram counted');
  assert.equal(packets.length, MAX_RATE_PER_IP);
});

test('a chatty sender does not starve another one', () => {
  const receiver = new Receiver({ now: () => 5_000 });
  for (let i = 0; i < 100; i += 1) {
    receiver.admit('198.51.100.7');
  }
  assert.equal(receiver.admit('192.0.2.10'), true);
  assert.equal(receiver.admit('198.51.100.7'), false);
});
