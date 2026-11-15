// -----------------------------------------------------------------------------
// The station, seen from Gladys: turns the UDP packets (through the receiver
// link) and the public archive (FDSN) into the states of the device, the scene
// events and the connection status.
//
// Online: a UDP packet in the last 2 minutes, or data in the public archive
// newer than the configured delay (the archive lags about 30 minutes). The
// archive is read every 10 minutes; the timer of the container (15 s) ages
// everything else. States are pushed (should_poll: false), only when they
// change, with a 12-hour heartbeat.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { Analyzer } from './analysis.js';
import { buildDevice, deviceIds } from './device.js';
import { FdsnClient } from './fdsn.js';
import { ProblemLog } from './problems.js';
import { parsePacket } from './shake.js';
import { CHECK, STATUS, formatDate, join, render } from './texts.js';

const logger = createLogger({ name: 'raspberry-shake' });

export const RECEIVER_CONTAINER = 'receiver';
export const WIDGET_KEY = 'station';
export const TRIGGERS = {
  SHAKING: 'shaking_detected',
  CALM: 'shaking_ended',
  OFFLINE: 'station_offline',
};

export const DEFAULT_TIMINGS = {
  tickMs: 15_000,
  fdsnMs: 10 * 60 * 1000,
  // UDP: online while packets come; the status complains after this long.
  udpOnlineMs: 2 * 60 * 1000,
  noUdpStatusMs: 5 * 60 * 1000,
  // A trigger still on when the packets stop ends after this long.
  shakingStaleMs: 30_000,
  lastDataEveryMs: 10 * 60 * 1000,
  heartbeatMs: 12 * 60 * 60 * 1000,
  widgetRefreshMs: 10_000,
  restartAfterFailures: 3,
  restartIntervalMs: 5 * 60 * 1000,
};

export class Monitor {
  constructor({ gladys, link, fetch, timers = true, now, timings } = {}) {
    this.gladys = gladys;
    this.link = link;
    this.fdsn = new FdsnClient({ fetch });
    this.timers = timers;
    this.now = now ?? (() => Date.now());
    this.timings = { ...DEFAULT_TIMINGS, ...timings };
    this.problems = new ProblemLog(logger);
    this.config = null;
    this.stopped = false;
    this.statusKey = undefined;
    this.lastRefreshAt = -Infinity;
    this.restartAt = -Infinity;
    this.startedAt = this.now();
    this.resetStation();
    this.link.on('packet', (item) => this.onPacket(item));
    this.link.on('up', () => this.onLinkUp());
    this.link.on('down', (info) => this.onLinkDown(info));
  }

  /** Everything known about the station: forgotten when the code changes. */
  resetStation() {
    this.analyzer = new Analyzer(this.config?.trigger);
    this.udp = { lastAt: null, receipts: [], channel: null, ignored: new Set() };
    this.archive = { known: undefined, lastData: null, checkedAt: -Infinity, checking: null };
    this.online = null;
    this.shaking = 0;
    this.rsam = null;
    this.peak = null;
    this.lastDataSentAt = -Infinity;
    this.udpSince = this.now();
  }

  // --- Lifecycle -----------------------------------------------------------------

  async start(config) {
    this.config = config;
    this.analyzer.setTrigger(config.trigger);
    this.warnAboutConfig();
    logger.info(
      config.station
        ? `Started: station AM.${config.station}, UDP output ${config.udp ? 'on' : 'off'}`
        : 'Started without a station code: waiting for the configuration',
    );
    if (config.udp) {
      this.link.start();
    }
    await this.publishDiscovered();
    await this.checkArchive();
    await this.evaluate();
    if (this.timers) {
      this.timer = setInterval(() => {
        this.tick().catch((err) => logger.error('Tick failed', err));
      }, this.timings.tickMs);
      this.timer.unref?.();
    }
  }

  /** Gladys restarted: everything is sent again. */
  async resync(config) {
    await this.reconfigure(config, { quiet: true });
    this.gladys.forgetPublishedStates?.();
    await this.publishStates();
  }

  async reconfigure(config, { quiet = false } = {}) {
    const previous = this.config;
    this.config = config;
    if (!quiet) {
      logger.info('Configuration saved');
      this.warnAboutConfig();
    }
    if (previous?.station !== config.station) {
      this.resetStation();
    }
    this.analyzer.setTrigger(config.trigger);
    if (config.udp) {
      this.link.start();
    } else {
      this.link.stop();
      await this.endShaking(this.now());
    }
    this.statusKey = undefined;
    await this.publishDiscovered();
    await this.checkArchive(true);
    await this.evaluate();
    this.requestRefresh();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.refreshTimer);
    this.link.stop();
  }

  warnAboutConfig() {
    if (this.config.invalidStation) {
      logger.warn('The station code of the configuration is not valid');
    }
    if (this.config.invalidIp) {
      logger.warn('The address of the Shake is not a valid IPv4 address: every sender is accepted');
    }
  }

  // --- Device --------------------------------------------------------------------

  async publishDiscovered() {
    if (!this.config.station) {
      await this.gladys.publishDiscoveredDevices([]);
      return;
    }
    await this.gladys.publishDiscoveredDevices([buildDevice(this.gladys, this.config)]);
  }

  ids() {
    return deviceIds(this.gladys, this.config.station);
  }

  /** The device of the station, as added in Gladys (its name there), or null. */
  createdDevice() {
    if (!this.config?.station) {
      return null;
    }
    const id = this.ids().device;
    return (this.gladys.devices ?? []).find((device) => device.external_id === id) ?? null;
  }

  /** The features the device added in Gladys has (an older one may lack the UDP ones). */
  createdFeatures() {
    const device = this.createdDevice();
    return new Set((device?.features ?? []).map((feature) => feature.external_id));
  }

  // --- UDP -----------------------------------------------------------------------

  onPacket({ ip, data }) {
    if (this.stopped || !this.config?.udp || !this.config.station) {
      return;
    }
    if (this.config.shakeIp && ip !== this.config.shakeIp) {
      if (!this.udp.ignored.has(ip) && this.udp.ignored.size < 20) {
        this.udp.ignored.add(ip);
        logger.warn(`UDP packets from ${ip} ignored: not the address of the Shake`);
      }
      return;
    }
    const packet = parsePacket(data);
    if (!packet) {
      logger.debug(`Not a Shake packet from ${ip}`);
      return;
    }
    const now = this.now();
    const wasSilent = this.udp.lastAt === null || now - this.udp.lastAt > this.timings.udpOnlineMs;
    this.udp.lastAt = now;
    this.udp.receipts.push(now);
    if (this.udp.receipts.length > 2000) {
      this.udp.receipts.splice(0, 1000);
    }
    const events = this.analyzer.push(packet);
    if (this.analyzer.channel !== this.udp.channel) {
      this.udp.channel = this.analyzer.channel;
    }
    if (wasSilent) {
      this.problems.recover('udp', 'UDP data from the Shake received again');
      logger.info(`Receiving UDP data from the Shake (channel ${packet.channel})`);
    }
    this.handle(events, wasSilent).catch((err) => logger.error('Handling a packet failed', err));
  }

  async handle(events, wasSilent) {
    for (const event of events) {
      if (event.type === 'minute') {
        this.rsam = event.rsam;
        this.peak = event.peak;
        logger.debug(
          `Minute ${new Date(event.time).toISOString()}: RSAM ${event.rsam}, peak ${event.peak}`,
        );
      } else if (event.type === 'on') {
        await this.startShaking(event);
      } else if (event.type === 'off') {
        await this.endShaking(this.now(), event);
      }
    }
    if (wasSilent) {
      await this.evaluate();
    } else if (events.some((event) => event.type === 'minute')) {
      await this.publishStates();
    }
  }

  async startShaking(event) {
    if (this.shaking === 1) {
      return;
    }
    this.shaking = 1;
    logger.debug(`Shaking detected (STA/LTA ${event.ratio})`);
    await this.publishStates();
    await this.sceneEvent(TRIGGERS.SHAKING, { station: this.config.station, ratio: event.ratio });
    this.requestRefresh();
  }

  /** Back to calm, or the data stopped during a shaking. */
  async endShaking(at, event = null) {
    // The analyzer counts in sample time: it ends where the data stopped.
    const ended =
      event ??
      this.analyzer.stop(this.analyzer.expected ?? at).find((e) => e.type === 'off') ??
      null;
    if (this.shaking === 0) {
      return;
    }
    this.shaking = 0;
    const peak = ended?.peak ?? 0;
    const duration = Math.round((ended?.durationMs ?? 0) / 1000);
    logger.debug(`Back to calm: peak ${peak}, ${duration} s`);
    await this.publishStates();
    await this.sceneEvent(TRIGGERS.CALM, { station: this.config.station, peak, duration });
    this.requestRefresh();
  }

  udpCount(now = this.now()) {
    const since = now - 60_000;
    return this.udp.receipts.filter((time) => time > since).length;
  }

  // --- Public archive --------------------------------------------------------------

  /** Reads the archive when due (or `force`d); one read at a time. */
  async checkArchive(force = false) {
    const station = this.config.station;
    if (!station) {
      return;
    }
    if (this.archive.checking) {
      return this.archive.checking;
    }
    const now = this.now();
    if (!force && now - this.archive.checkedAt < this.timings.fdsnMs) {
      return;
    }
    this.archive.checkedAt = now;
    this.archive.checking = (async () => {
      try {
        if (this.archive.known === undefined || force) {
          const info = await this.fdsn.station(station);
          this.archive.known = info !== null;
          if (!info) {
            this.problems.fail(
              'unknown',
              `Station AM.${station} is not known on the Raspberry Shake network`,
            );
          } else {
            this.problems.recover('unknown');
          }
        }
        if (this.archive.known) {
          this.archive.lastData = await this.fdsn.lastData(station, now, this.archive.lastData);
        }
        this.problems.recover('fdsn', 'The Raspberry Shake data service answers again');
        this.archive.failing = false;
      } catch (err) {
        this.archive.failing = true;
        this.problems.fail('fdsn', `Raspberry Shake data service unreachable: ${err.message}`);
      } finally {
        this.archive.checking = null;
      }
    })();
    return this.archive.checking;
  }

  // --- Evaluation ------------------------------------------------------------------

  /** When the last data came, by UDP or in the archive (ms), or null. */
  lastData() {
    const times = [this.udp.lastAt, this.archive.lastData].filter((time) => time !== null);
    return times.length ? Math.max(...times) : null;
  }

  isOnline(now = this.now()) {
    const udpFresh = this.udp.lastAt !== null && now - this.udp.lastAt <= this.timings.udpOnlineMs;
    const archiveFresh =
      this.archive.lastData !== null && now - this.archive.lastData <= this.config.offlineAfterMs;
    return udpFresh || archiveFresh;
  }

  /** The timer: archive when due, online state, UDP silence, states. */
  async tick() {
    if (this.stopped || !this.config) {
      return;
    }
    await this.checkArchive();
    await this.evaluate();
  }

  async evaluate() {
    if (this.stopped || !this.config?.station) {
      await this.updateStatus();
      return;
    }
    const now = this.now();
    if (this.config.udp) {
      const silentFor = now - (this.udp.lastAt ?? this.udpSince);
      if (this.shaking && silentFor > this.timings.shakingStaleMs) {
        await this.endShaking(now);
      }
      if (this.udp.lastAt !== null && silentFor > this.timings.udpOnlineMs) {
        this.problems.fail('udp', 'No UDP data from the Shake for 2 minutes');
      }
    }
    const online = this.isOnline(now);
    // Before any answer of the archive, an offline verdict waits.
    const decided = online || this.archive.known !== undefined;
    if (decided && online !== this.online) {
      const previous = this.online;
      this.online = online;
      if (previous !== null || !online) {
        if (online) {
          logger.info(`Station AM.${this.config.station} online again`);
        } else {
          logger.info(`Station AM.${this.config.station} offline`);
        }
      }
      if (previous === true && !online) {
        const last = this.lastData();
        await this.sceneEvent(TRIGGERS.OFFLINE, {
          station: this.config.station,
          last_data: last === null ? null : formatDate(last, this.config.language),
        });
      }
      this.lastDataSentAt = -Infinity;
      this.requestRefresh();
    }
    await this.publishStates();
    await this.updateStatus();
  }

  // --- States --------------------------------------------------------------------

  statesOf() {
    const ids = this.ids();
    const states = [];
    if (this.online !== null) {
      states.push({ device_feature_external_id: ids.online, state: this.online ? 1 : 0 });
    }
    const last = this.lastData();
    const now = this.now();
    if (last !== null && now - this.lastDataSentAt >= this.timings.lastDataEveryMs) {
      states.push({
        device_feature_external_id: ids.last_data,
        text: formatDate(last, this.config.language),
      });
    }
    if (this.config.udp) {
      if (this.rsam !== null) {
        states.push({ device_feature_external_id: ids.rsam, state: this.rsam });
        states.push({ device_feature_external_id: ids.peak, state: this.peak });
      }
      if (this.udp.lastAt !== null) {
        states.push({ device_feature_external_id: ids.shaking, state: this.shaking });
      }
    }
    return states;
  }

  async publishStates() {
    if (!this.createdDevice()) {
      return;
    }
    const created = this.createdFeatures();
    const states = this.statesOf().filter((state) => created.has(state.device_feature_external_id));
    if (states.length === 0) {
      return;
    }
    try {
      await this.gladys.publishChangedStates(states, { heartbeat: this.timings.heartbeatMs });
      if (states.some((state) => state.text !== undefined)) {
        this.lastDataSentAt = this.now();
      }
      this.problems.recover('publish', 'Publishing the states works again');
    } catch (err) {
      // Sent again at the next change or tick (the SDK forgets what Gladys refused).
      this.problems.fail('publish', `Publishing the states failed: ${err.message}`);
    }
  }

  async sceneEvent(key, data) {
    try {
      await this.gladys.publishSceneEvent(key, data);
      this.problems.recover('scene', 'Scene events accepted again');
    } catch (err) {
      this.problems.fail('scene', `Scene event refused: ${err.message}`);
    }
  }

  // --- Connection status -------------------------------------------------------------

  async updateStatus() {
    if (this.stopped || !this.config) {
      return;
    }
    const config = this.config;
    const parts = [];
    let connected = true;
    if (!config.station) {
      connected = false;
      parts.push(render(STATUS, config.invalidStation ? 'invalidStation' : 'noStation'));
    } else {
      const now = this.now();
      if (config.udp && this.link.failures >= this.timings.restartAfterFailures) {
        connected = false;
        parts.push(render(STATUS, 'receiverDown'));
      } else if (
        config.udp &&
        now - (this.udp.lastAt ?? this.udpSince) > this.timings.noUdpStatusMs
      ) {
        connected = false;
        parts.push(render(STATUS, 'noUdp'));
      }
      if (this.archive.failing) {
        connected = connected && config.udp && this.udp.lastAt !== null;
        parts.push(render(STATUS, 'fdsnDown'));
      } else if (this.archive.known === false) {
        connected = connected && config.udp;
        parts.push(render(STATUS, 'unknownStation', { station: config.station }));
      }
      if (config.invalidIp) {
        parts.push(render(STATUS, 'invalidIp'));
      }
    }
    const message = parts.length ? join(...parts) : undefined;
    const key = JSON.stringify([connected, message]);
    if (key === this.statusKey) {
      return;
    }
    this.statusKey = key;
    await this.gladys.setConnectionStatus(connected, message).catch(() => {});
  }

  // --- The link to the receiver ----------------------------------------------------

  async onLinkUp() {
    this.problems.recover('link', 'UDP receiver reachable again');
    await this.updateStatus();
  }

  async onLinkDown({ wasConnected, failures, error }) {
    const reason = error?.code ?? error?.message ?? 'closed';
    if (wasConnected) {
      this.problems.fail('link', `Lost the link to the UDP receiver (${reason})`);
    } else {
      logger.debug(`UDP receiver not reachable (${reason}), attempt ${failures}`);
    }
    if (failures < this.timings.restartAfterFailures) {
      return;
    }
    this.problems.fail('link', 'The UDP receiver does not answer');
    await this.updateStatus();
    const now = this.now();
    if (now - this.restartAt < this.timings.restartIntervalMs) {
      return;
    }
    this.restartAt = now;
    try {
      await this.gladys.startContainer(RECEIVER_CONTAINER);
      logger.info('UDP receiver container started again');
    } catch (err) {
      logger.warn(`Cannot start the UDP receiver container: ${err.message}`);
    }
  }

  // --- Gladys events -----------------------------------------------------------------

  async onDeviceCreated(device) {
    if (!this.config?.station || device?.external_id !== this.ids().device) {
      return;
    }
    // The SDK forgot the states of the device: everything is published again.
    this.lastDataSentAt = -Infinity;
    await this.publishStates();
    this.requestRefresh();
  }

  /** onPoll fallback: should_poll is false, but a Gladys polling anyway gets an answer. */
  async poll() {
    await this.publishStates();
  }

  /** The "Check now" action: reads the archive at once and says what is known. */
  async checkNow() {
    logger.info('Check requested');
    const config = this.config;
    if (!config.station) {
      return render(STATUS, config.invalidStation ? 'invalidStation' : 'noStation');
    }
    await this.checkArchive(true);
    await this.evaluate();
    const station = `AM.${config.station}`;
    const last = this.lastData();
    const parts = [];
    if (this.archive.failing) {
      parts.push(render(STATUS, 'fdsnDown'));
    } else if (this.archive.known === false) {
      parts.push(render(STATUS, 'unknownStation', { station: config.station }));
    }
    const state = last === null ? 'never' : this.isOnline() ? 'online' : 'offline';
    parts.push(
      Object.fromEntries(
        Object.keys(CHECK).map((language) => [
          language,
          render(CHECK, state, {
            station,
            time: last === null ? '' : formatDate(last, language),
          })[language],
        ]),
      ),
    );
    if (config.udp) {
      const count = this.udpCount();
      parts.push(count > 0 ? render(CHECK, 'udp', { count }) : render(CHECK, 'noUdp'));
    }
    return join(...parts);
  }

  // --- Widget -------------------------------------------------------------------------

  requestRefresh() {
    if (this.stopped) {
      return;
    }
    const now = this.now();
    const wait = this.lastRefreshAt + this.timings.widgetRefreshMs - now;
    if (wait <= 0) {
      this.lastRefreshAt = now;
      this.gladys.requestWidgetRefresh(WIDGET_KEY);
    } else if (this.timers && !this.refreshTimer) {
      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = null;
        this.requestRefresh();
      }, wait);
      this.refreshTimer.unref?.();
    }
  }
}
