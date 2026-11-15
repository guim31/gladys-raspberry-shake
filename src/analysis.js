// -----------------------------------------------------------------------------
// What the integration computes from the samples of one seismic channel:
//
//   - RSAM (Real-time Seismic Amplitude Measurement): the mean absolute
//     amplitude over each minute, in counts, the measure volcano observatories
//     and Raspberry Shake owners use to follow the vibration level;
//   - the peak: the largest absolute amplitude of the minute, in counts;
//   - a classic STA/LTA trigger: the mean amplitude over 1 s (short term)
//     against the one over 30 s (long term). The trigger goes on when the
//     ratio reaches `on`, and off ("back to calm") after 10 s below `off`.
//     The long term average is frozen while triggered, so a long tremor does
//     not raise its own baseline.
//
// The samples are raw counts with an offset (the digitizer's DC level): a slow
// running mean (10 s) is subtracted first. Minutes are aligned on the sample
// time (UTC minutes), so a replayed recording gives the same values.
//
// Pure computation: no timer, no clock; `push` returns what happened.
// -----------------------------------------------------------------------------

import { SEISMIC_CHANNELS } from './shake.js';

export const STA_SECONDS = 1;
export const LTA_SECONDS = 30;
export const MEAN_SECONDS = 10;
// Seconds below the off ratio before the trigger ends.
export const CALM_SECONDS = 10;
// The long term average needs this much data before any trigger.
export const WARMUP_SECONDS = LTA_SECONDS;
// A hole longer than this restarts the filters (the station rebooted, packets lost).
export const GAP_MS = 5000;
// A better channel replaces the current one; a silent current one is replaced
// by any after this long.
export const CHANNEL_SILENCE_MS = 10_000;

const RATES = [50, 100, 200];
const MINUTE = 60_000;

/** The nearest usual sample rate. */
function roundRate(rate) {
  return RATES.reduce((best, r) => (Math.abs(r - rate) < Math.abs(best - rate) ? r : best));
}

export class Analyzer {
  /** @param {{ on: number, off: number }} trigger STA/LTA ratios */
  constructor(trigger = { on: 4, off: 1.5 }) {
    this.trigger = trigger;
    this.channel = null;
    this.channelSeenAt = -Infinity;
    this.reset();
  }

  /** Forgets the filters (a gap, another channel): the next samples warm up again. */
  reset() {
    this.rate = 100;
    this.expected = null; // time of the next sample, ms
    this.mean = null;
    this.sta = 0;
    this.lta = 0;
    this.warm = 0; // samples since the reset
    this.ratio = 0;
    this.triggered = null; // { start, peak, calmSince }
    this.minute = null; // { start, sum, count, peak }
  }

  setTrigger(trigger) {
    this.trigger = trigger;
  }

  /**
   * One packet of the Shake.
   * @param {{ channel: string, time: number, samples: number[] }} packet
   * @returns {Array<object>} events: `{ type: 'minute', time, rsam, peak }`,
   *   `{ type: 'on', time, ratio }`, `{ type: 'off', time, peak, durationMs }`
   */
  push(packet) {
    const events = [];
    if (!this.accepts(packet)) {
      return events;
    }
    const { time, samples } = packet;
    if (this.expected !== null) {
      const drift = time - this.expected;
      if (drift < -this.period() * samples.length) {
        // A late or repeated packet (UDP does not keep the order): dropped.
        return events;
      }
      if (drift > GAP_MS) {
        this.end(events, this.expected);
        this.reset();
      } else if (this.lastPacket && time > this.lastPacket.time) {
        // The rate, from the spacing of consecutive packets.
        const measured = (this.lastPacket.count * 1000) / (time - this.lastPacket.time);
        this.rate = roundRate(measured);
      }
    }
    this.lastPacket = { time, count: samples.length };
    const period = this.period();
    if (this.mean === null) {
      this.mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    }
    const aMean = 1 / (MEAN_SECONDS * this.rate);
    const aSta = 1 / (STA_SECONDS * this.rate);
    const aLta = 1 / (LTA_SECONDS * this.rate);
    samples.forEach((value, index) => {
      const at = time + index * period;
      this.mean += (value - this.mean) * aMean;
      const amplitude = Math.abs(value - this.mean);
      if (this.warm === 0) {
        this.sta = amplitude;
        this.lta = amplitude;
      }
      this.warm += 1;
      this.sta += (amplitude - this.sta) * aSta;
      if (!this.triggered) {
        this.lta += (amplitude - this.lta) * aLta;
      }
      this.ratio = this.lta > 0 ? this.sta / this.lta : 0;
      this.addToMinute(events, at, amplitude);
      this.checkTrigger(events, at, amplitude);
    });
    this.expected = time + samples.length * period;
    return events;
  }

  period() {
    return 1000 / this.rate;
  }

  /** Keeps to the best seismic channel heard. */
  accepts({ channel, time }) {
    const rank = SEISMIC_CHANNELS.indexOf(channel);
    if (rank < 0) {
      return false;
    }
    const current = SEISMIC_CHANNELS.indexOf(this.channel);
    if (channel === this.channel) {
      this.channelSeenAt = time;
      return true;
    }
    const silent = time - this.channelSeenAt > CHANNEL_SILENCE_MS;
    if (this.channel === null || rank < current || silent) {
      this.channel = channel;
      this.channelSeenAt = time;
      this.lastPacket = null;
      this.reset();
      return true;
    }
    return false;
  }

  addToMinute(events, at, amplitude) {
    const start = Math.floor(at / MINUTE) * MINUTE;
    if (this.minute && this.minute.start !== start) {
      this.closeMinute(events);
    }
    if (!this.minute) {
      this.minute = { start, sum: 0, count: 0, peak: 0 };
    }
    this.minute.sum += amplitude;
    this.minute.count += 1;
    this.minute.peak = Math.max(this.minute.peak, amplitude);
  }

  closeMinute(events) {
    const { start, sum, count, peak } = this.minute;
    this.minute = null;
    // A minute mostly missing (start of the stream, a gap) says nothing.
    if (count < this.rate * 30) {
      return;
    }
    events.push({
      type: 'minute',
      time: start,
      rsam: Math.round((sum / count) * 10) / 10,
      peak: Math.round(peak),
    });
  }

  checkTrigger(events, at, amplitude) {
    const { on, off } = this.trigger;
    if (!this.triggered) {
      if (this.warm >= WARMUP_SECONDS * this.rate && this.ratio >= on) {
        this.triggered = { start: at, peak: amplitude, calmSince: null };
        events.push({ type: 'on', time: at, ratio: Math.round(this.ratio * 10) / 10 });
      }
      return;
    }
    this.triggered.peak = Math.max(this.triggered.peak, amplitude);
    if (this.ratio >= off) {
      this.triggered.calmSince = null;
      return;
    }
    this.triggered.calmSince ??= at;
    if (at - this.triggered.calmSince >= CALM_SECONDS * 1000) {
      this.end(events, at);
    }
  }

  /** Ends a running trigger (calm, or the data stopped). */
  end(events, at) {
    if (!this.triggered) {
      return;
    }
    const { start, peak } = this.triggered;
    this.triggered = null;
    events.push({
      type: 'off',
      time: at,
      peak: Math.round(peak),
      durationMs: Math.max(0, Math.round(at - start)),
    });
  }

  /** The data stopped: a running trigger ends now. */
  stop(at) {
    const events = [];
    this.end(events, at);
    return events;
  }
}
