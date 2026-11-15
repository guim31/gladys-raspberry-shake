// -----------------------------------------------------------------------------
// The UDP output of a Raspberry Shake ("Datacast", settings of the Shake's web
// page): one datagram per channel every quarter of a second or so, plain text,
//
//   {'EHZ', 1785739788.538, 9866, 11560, 10885, ...}
//
// the channel, the time of the first sample (Unix seconds, three decimals),
// then the samples in raw counts. The station code is not in the packet.
// -----------------------------------------------------------------------------

// Seismic channels, best first: the vertical geophone (Shake 1D, 3D, 4D,
// RS&BOOM), then the vertical accelerometer and the horizontal geophones.
// HDF (the infrasound of a Boom) is not a ground motion: never used.
export const SEISMIC_CHANNELS = ['EHZ', 'SHZ', 'ENZ', 'EHN', 'EHE', 'ENN', 'ENE'];

// Real packets hold 25 to 50 samples; more is not a Shake.
export const MAX_SAMPLES = 1000;
// The digitizer of a Shake has 24 bits: no count goes beyond 2^24.
export const MAX_ABS_COUNT = 2 ** 24;

/**
 * @param {string|Buffer} data one datagram
 * @returns {{ channel: string, time: number, samples: number[] } | null}
 *   `time` in milliseconds; null when it is not a Shake packet.
 */
export function parsePacket(data) {
  const text = String(data).trim();
  if (!text.startsWith('{') || !text.endsWith('}') || text.length > 16384) {
    return null;
  }
  const parts = text.slice(1, -1).split(',');
  if (parts.length < 3 || parts.length - 2 > MAX_SAMPLES) {
    return null;
  }
  const channel = parts[0].trim().replace(/^'|'$/g, '');
  if (!/^[A-Z0-9]{3}$/.test(channel)) {
    return null;
  }
  const seconds = Number(parts[1].trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  const samples = [];
  for (const part of parts.slice(2)) {
    const value = part.trim();
    const number = Number(value);
    if (!/^-?\d{1,9}$/.test(value) || Math.abs(number) > MAX_ABS_COUNT) {
      return null;
    }
    samples.push(number);
  }
  return { channel, time: Math.round(seconds * 1000), samples };
}

/** The text of a packet, as a Shake sends it (used by the replay tool and the tests). */
export function formatPacket({ channel, time, samples }) {
  return `{'${channel}', ${(time / 1000).toFixed(3)}, ${samples.join(', ')}}`;
}
