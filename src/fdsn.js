// -----------------------------------------------------------------------------
// The public data of the Raspberry Shake network (AM), through its FDSN web
// services (https://data.raspberryshake.org/fdsnws/): free, no account.
//
//   - station/1/query (text): is the code a station of the network, and is it
//     still open (empty end time)? 204 when unknown.
//   - dataselect/1/query (miniSEED): the recorded samples. Only the record
//     headers are read here (start time, sample count, rate): the time of the
//     last sample says when the station last sent data. 204 when none.
//
// The archive lags about 30 minutes behind real time. To stay light (a few
// kilobytes per check), the last data is looked for in a short window first,
// then in narrow probes further back, stopping at the last data already known.
// The availability service is not offered by this server (404).
// -----------------------------------------------------------------------------

export const FDSN_BASE = 'https://data.raspberryshake.org/fdsnws';
export const NETWORK = 'AM';
const TIMEOUT_MS = 20_000;
const MINUTE = 60_000;

// First window: the last 31 minutes (archive lag + one), or from the last data
// known when it is more recent.
export const RECENT_WINDOW_MS = 31 * MINUTE;
// Then 2-minute probes ending this many minutes ago.
export const PROBES_MIN = [45, 60, 120, 360, 1440];
const PROBE_MS = 2 * MINUTE;

const iso = (time) => new Date(time).toISOString().slice(0, 19);

export class FdsnError extends Error {}

/** The SEED sample rate from its factor and multiplier. */
function seedRate(factor, multiplier) {
  if (factor > 0 && multiplier > 0) return factor * multiplier;
  if (factor > 0 && multiplier < 0) return -factor / multiplier;
  if (factor < 0 && multiplier > 0) return -multiplier / factor;
  if (factor < 0 && multiplier < 0) return 1 / (factor * multiplier);
  return 0;
}

/**
 * The time (ms) of the last sample of a miniSEED (v2) answer, or null.
 * Reads the fixed header of each record; the record length comes from
 * blockette 1000 (512 bytes without it).
 * @param {Uint8Array} bytes
 */
export function lastSampleTime(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  let last = null;
  while (offset + 48 <= bytes.length) {
    const quality = String.fromCharCode(bytes[offset + 6]);
    if (!'DRQM'.includes(quality)) {
      break;
    }
    const year = view.getUint16(offset + 20);
    const day = view.getUint16(offset + 22);
    const start =
      Date.UTC(year, 0, day, bytes[offset + 24], bytes[offset + 25], bytes[offset + 26]) +
      view.getUint16(offset + 28) / 10;
    const count = view.getUint16(offset + 30);
    const rate = seedRate(view.getInt16(offset + 32), view.getInt16(offset + 34));
    if (count > 0 && rate > 0) {
      const end = start + ((count - 1) * 1000) / rate;
      last = last === null ? end : Math.max(last, end);
    }
    let length = 512;
    const blockette = view.getUint16(offset + 46);
    if (blockette >= 48 && offset + blockette + 7 <= bytes.length) {
      if (view.getUint16(offset + blockette) === 1000) {
        length = 2 ** bytes[offset + blockette + 6];
      }
    }
    if (length < 128) {
      break;
    }
    offset += length;
  }
  return last;
}

export class FdsnClient {
  constructor({ fetch = globalThis.fetch, base = FDSN_BASE } = {}) {
    this.fetch = fetch;
    this.base = base;
    this.requests = 0;
  }

  async get(path, params, { notFoundIsEmpty = true } = {}) {
    const url = `${this.base}/${path}?${new URLSearchParams(params)}`;
    this.requests += 1;
    let response;
    try {
      response = await this.fetch(url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'user-agent': 'gladys-raspberry-shake' },
      });
    } catch (err) {
      throw new FdsnError(`data.raspberryshake.org: ${err.cause?.code ?? err.message}`);
    }
    if (response.status === 204 || (notFoundIsEmpty && response.status === 404)) {
      return null;
    }
    if (response.status !== 200) {
      throw new FdsnError(`data.raspberryshake.org: HTTP ${response.status}`);
    }
    return response;
  }

  /**
   * The station in the network metadata: `{ code, open }`, null when unknown.
   * `open` is false when its last epoch has an end time (retired station).
   */
  async station(code) {
    const response = await this.get(
      'station/1/query',
      {
        network: NETWORK,
        station: code,
        level: 'station',
        format: 'text',
        // An unknown station is a 204: a 404 is a hiccup of the server, not a verdict.
      },
      { notFoundIsEmpty: false },
    );
    if (!response) {
      return null;
    }
    const lines = (await response.text())
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    if (lines.length === 0) {
      return null;
    }
    const fields = lines.at(-1).split('|');
    return { code, open: (fields[7] ?? '').trim() === '' };
  }

  async lastIn(code, start, end) {
    const response = await this.get('dataselect/1/query', {
      network: NETWORK,
      station: code,
      starttime: iso(start),
      endtime: iso(end),
    });
    if (!response) {
      return null;
    }
    return lastSampleTime(new Uint8Array(await response.arrayBuffer()));
  }

  /**
   * The time of the last data the station sent, as the archive has it.
   * @param {string} code
   * @param {number} now ms
   * @param {number|null} known the last data already known, ms
   * @returns {Promise<number|null>} null when nothing in the last day and nothing known
   */
  async lastData(code, now, known = null) {
    let start = now - RECENT_WINDOW_MS;
    if (known !== null && known > start) {
      start = known - MINUTE;
    }
    const recent = await this.lastIn(code, start, now);
    if (recent !== null) {
      return known === null ? recent : Math.max(recent, known);
    }
    for (const minutes of PROBES_MIN) {
      const end = now - minutes * MINUTE;
      if (known !== null && known >= end) {
        return known;
      }
      const found = await this.lastIn(code, end - PROBE_MS, end);
      if (found !== null) {
        return known === null ? found : Math.max(found, known);
      }
    }
    return known;
  }
}
