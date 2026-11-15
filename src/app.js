// -----------------------------------------------------------------------------
// Registers every SDK handler on a GladysIntegration (or the SDK's fake Gladys)
// and returns the monitor, so index.js stays a few lines and the tests drive
// the very same wiring. (Adapted from guim31/gladys-emsc.)
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import { ReceiverLink } from './link.js';
import { Monitor } from './monitor.js';
import { STATUS, render } from './texts.js';
import { WIDGETS } from './widgets.js';

const logger = createLogger({ name: 'raspberry-shake-app' });

export const CONFIG_ACTION = 'check_now';

/**
 * @param {object} gladys GladysIntegration instance
 * @param {object} [options] test seams: link, fetch, timers, now, timings
 */
export function registerHandlers(gladys, options = {}) {
  const monitor = new Monitor({
    gladys,
    link: options.link ?? new ReceiverLink(),
    fetch: options.fetch,
    timers: options.timers ?? true,
    now: options.now,
    timings: options.timings,
  });

  // Resolved once the monitor has started; every handler waits for it.
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  let started = false;
  // One start or resync at a time: the SDK says `connected` at every authentication.
  let starting = Promise.resolve();
  const whenReady =
    (fn) =>
    async (...args) => {
      await ready;
      await starting;
      if (!started) {
        throw new Error('The integration did not start, see its logs');
      }
      return fn(...args);
    };

  const onConnected = async () => {
    try {
      const config = normalizeConfig(await gladys.getConfig());
      if (started) {
        // A reconnection (Gladys restarted): publish everything again.
        await monitor.resync(config);
        return;
      }
      await monitor.start(config);
      started = true;
    } catch (err) {
      logger.error('Initialization failed', err);
      await gladys.setConnectionStatus(false, render(STATUS, 'initFailed')).catch(() => {});
      monitor.statusKey = undefined;
    } finally {
      resolveReady();
    }
  };
  gladys.on('connected', () => {
    starting = starting.then(onConnected);
    return starting;
  });

  gladys.onScanRequest(whenReady(() => monitor.publishDiscovered()));

  // The device is published with should_poll: false (pushed by the container);
  // this only serves a Gladys that would poll anyway.
  gladys.onPoll(whenReady(() => monitor.poll()));

  gladys.onDeviceCreated(whenReady((device) => monitor.onDeviceCreated(device)));
  // "Update" in the Discovery tab (UDP features added): same as a creation.
  gladys.onDeviceUpdated(whenReady((device) => monitor.onDeviceCreated(device)));
  // A deleted station: the widget shows it.
  gladys.onDeviceDeleted(whenReady(() => monitor.requestRefresh()));

  gladys.onConfigUpdated(whenReady((newConfig) => monitor.reconfigure(normalizeConfig(newConfig))));

  gladys.onAction(
    CONFIG_ACTION,
    whenReady(() => monitor.checkNow()),
  );

  for (const [key, widget] of Object.entries(WIDGETS)) {
    gladys.onWidgetGet(
      key,
      whenReady((request) => widget.get(monitor, request)),
    );
  }

  return {
    monitor,
    ready,
    stop: () => monitor.stop(),
  };
}
