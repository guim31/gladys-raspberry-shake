// -----------------------------------------------------------------------------
// The one Gladys device of the integration: the Raspberry Shake station of the
// configuration, identified by its code on the network (AM.R6881 → "R6881").
//
// Features (couples checked against the Gladys front, see
// test/gladys-rules.test.js):
//   - online     input/binary: data received in time (UDP or public archive);
//   - last_data  text/text: when the last data was received;
//   With the UDP output only (computed from the samples, in counts):
//   - rsam       sismic-sensor/decimal: mean absolute amplitude of the minute;
//   - peak       sismic-sensor/decimal: largest absolute amplitude of the minute;
//   - shaking    vibration-sensor/binary: 1 while the STA/LTA trigger is on.
//
// Published with should_poll: false: the container pushes the states (the UDP
// stream, its own timer for the public archive).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as CATEGORIES,
  DEVICE_FEATURE_TYPES as TYPES,
} from '@gladysassistant/integration-sdk';

export const DEVICE_TYPE = 'station';
export const FEATURE_KEYS = {
  ONLINE: 'online',
  LAST_DATA: 'last_data',
  RSAM: 'rsam',
  PEAK: 'peak',
  SHAKING: 'shaking',
};
// A Raspberry Shake digitizes on 24 bits: no amplitude goes beyond 2^23 counts.
export const MAX_COUNTS = 8388608;

// Feature names, frozen at creation in Gladys (language of the configuration).
export const NAMES = {
  en: {
    device: 'Raspberry Shake',
    online: 'Station online',
    last_data: 'Last data',
    rsam: 'Vibration level (RSAM)',
    peak: 'Peak amplitude',
    shaking: 'Shaking detected',
  },
  fr: {
    device: 'Raspberry Shake',
    online: 'Station en ligne',
    last_data: 'Dernière donnée',
    rsam: 'Niveau de vibration (RSAM)',
    peak: 'Amplitude crête',
    shaking: 'Secousse détectée',
  },
  de: {
    device: 'Raspberry Shake',
    online: 'Station online',
    last_data: 'Letzte Daten',
    rsam: 'Vibrationspegel (RSAM)',
    peak: 'Spitzenamplitude',
    shaking: 'Erschütterung erkannt',
  },
  es: {
    device: 'Raspberry Shake',
    online: 'Estación en línea',
    last_data: 'Último dato',
    rsam: 'Nivel de vibración (RSAM)',
    peak: 'Amplitud máxima',
    shaking: 'Sacudida detectada',
  },
};

/** External ids of the device and of its features. */
export function deviceIds(gladys, station) {
  const ids = gladys.externalIds(DEVICE_TYPE, station);
  return {
    device: ids.device,
    ...Object.fromEntries(Object.values(FEATURE_KEYS).map((key) => [key, ids.feature(key)])),
  };
}

const sensor = (name, externalId, category, type, extra) => ({
  name,
  external_id: externalId,
  category,
  type,
  read_only: true,
  has_feedback: false,
  ...extra,
});

/**
 * The discovery payload of the station.
 * @param {object} gladys
 * @param {{ station: string, udp: boolean, language: string }} config
 */
export function buildDevice(gladys, { station, udp, language }) {
  const ids = deviceIds(gladys, station);
  const names = NAMES[language] ?? NAMES.fr;
  const binary = { keep_history: true, min: 0, max: 1 };
  const counts = { keep_history: true, min: 0, max: MAX_COUNTS };
  const features = [
    sensor(names.online, ids.online, CATEGORIES.INPUT, TYPES.SENSOR.BINARY, binary),
    sensor(names.last_data, ids.last_data, CATEGORIES.TEXT, TYPES.TEXT.TEXT, {
      keep_history: false,
      min: 0,
      max: 0,
    }),
  ];
  if (udp) {
    features.push(
      sensor(names.rsam, ids.rsam, CATEGORIES.SISMIC_SENSOR, TYPES.SENSOR.DECIMAL, counts),
      sensor(names.peak, ids.peak, CATEGORIES.SISMIC_SENSOR, TYPES.SENSOR.DECIMAL, counts),
      sensor(names.shaking, ids.shaking, CATEGORIES.VIBRATION_SENSOR, TYPES.SENSOR.BINARY, binary),
    );
  }
  return {
    name: `${names.device} ${station}`,
    external_id: ids.device,
    model: `AM.${station}`,
    should_poll: false,
    params: [],
    features,
  };
}
