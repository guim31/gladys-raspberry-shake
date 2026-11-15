// -----------------------------------------------------------------------------
// The UDP receiver: runs in the `receiver` sub-container (manifest
// `containers`), the only kind of container Gladys publishes ports for. It
// listens for the datagrams of the Shake's UDP output and streams them, as
// they are, to the main container over a private link (one JSON object per
// line, TCP, on the private network of the integration, never published on
// the host). The main container parses and analyses them.
//
//   receiver → main   {"type":"packet","ip":"192.0.2.10","data":"{'EHZ', 1785739788.538, ...}"}
//
// Nothing is kept: without the main container, packets are dropped (the data
// is real time, a late packet is useless). A flood is capped: a Shake sends
// about 4 packets per second and per channel, 20 at most: 40 per sender and
// 200 in all are kept each second.
// -----------------------------------------------------------------------------

import dgram from 'node:dgram';
import net from 'node:net';
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'shake-receiver' });

export const UDP_PORT = 8888;
export const LINK_PORT = 8889;
// Datagrams per second, every sender together, and per sender (a Shake sends
// 4 per channel, 20 at most): one chatty device cannot starve the Shake.
export const MAX_RATE = 200;
export const MAX_RATE_PER_IP = 40;
const MAX_SENDERS = 256;
export const MAX_DATAGRAM = 8192;
// Beyond this many bytes waiting on the link, packets are dropped.
const LINK_HIGH_WATER = 256 * 1024;

export class Receiver {
  constructor({ udpPort = UDP_PORT, linkPort = LINK_PORT, host = '0.0.0.0', now } = {}) {
    this.options = { udpPort, linkPort, host };
    this.now = now ?? (() => Date.now());
    this.link = null;
    this.second = 0;
    this.count = 0;
    this.dropped = 0;
    this.perIp = new Map();
  }

  async start() {
    const { udpPort, linkPort, host } = this.options;
    this.udp = dgram.createSocket({ type: 'udp4', recvBufferSize: 1 << 20 });
    this.udp.on('message', (data, rinfo) => this.receive(data, rinfo.address));
    await new Promise((resolve, reject) => {
      this.udp.once('error', reject);
      this.udp.bind(udpPort, host, () => {
        this.udp.off('error', reject);
        resolve();
      });
    });
    this.udp.on('error', (err) => logger.error(`UDP socket error: ${err.message}`));
    this.linkServer = net.createServer((socket) => this.acceptLink(socket));
    this.linkServer.maxConnections = 4;
    await new Promise((resolve, reject) => {
      this.linkServer.once('error', reject);
      this.linkServer.listen(linkPort, host, () => {
        this.linkServer.off('error', reject);
        resolve();
      });
    });
    this.linkServer.on('error', (err) => logger.error(`Link server error: ${err.message}`));
    logger.info(`Listening for the Shake on UDP port ${this.udpPort}`);
  }

  get udpPort() {
    return this.udp.address().port;
  }

  get linkPort() {
    return this.linkServer.address().port;
  }

  async stop() {
    this.link?.destroy();
    await Promise.all([
      new Promise((resolve) => (this.udp ? this.udp.close(() => resolve()) : resolve())),
      new Promise((resolve) =>
        this.linkServer ? this.linkServer.close(() => resolve()) : resolve(),
      ),
    ]);
  }

  /** Counts the datagrams of the current second; false beyond a cap. */
  admit(ip) {
    const second = Math.floor(this.now() / 1000);
    if (second !== this.second) {
      if (this.dropped > 0) {
        logger.debug(`${this.dropped} datagram(s) dropped in the last second`);
      }
      this.second = second;
      this.count = 0;
      this.dropped = 0;
      this.perIp.clear();
    }
    this.count += 1;
    const fromIp = (this.perIp.get(ip) ?? 0) + 1;
    if (this.perIp.size < MAX_SENDERS || this.perIp.has(ip)) {
      this.perIp.set(ip, fromIp);
    }
    if (this.count > MAX_RATE || fromIp > MAX_RATE_PER_IP) {
      this.dropped += 1;
      return false;
    }
    return true;
  }

  receive(data, ip) {
    if (data.length === 0 || data.length > MAX_DATAGRAM || !this.admit(ip)) {
      return;
    }
    const link = this.link;
    if (!link || link.destroyed || link.writableLength > LINK_HIGH_WATER) {
      return;
    }
    link.write(`${JSON.stringify({ type: 'packet', ip, data: data.toString('latin1') })}\n`);
  }

  acceptLink(socket) {
    // One main container: a new connection replaces the old one (a restarted
    // main container leaves its old socket half-open for a while).
    if (this.link && this.link !== socket) {
      this.link.destroy();
    }
    this.link = socket;
    logger.info('Main container connected');
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    socket.on('error', () => {});
    // Nothing is expected from the main container.
    socket.on('data', () => {});
    socket.on('close', () => {
      if (this.link === socket) {
        this.link = null;
        logger.info('Main container disconnected');
      }
    });
  }
}
