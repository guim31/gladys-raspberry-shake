// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
// -----------------------------------------------------------------------------

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

// STA/LTA trigger ratios. "high" catches smaller tremors and more footsteps.
export const SENSITIVITIES = {
  low: { on: 6, off: 2 },
  normal: { on: 4, off: 1.5 },
  high: { on: 3, off: 1.5 },
};

// Minutes without data before the station is said offline. The public
// archive of Raspberry Shake lags about 30 minutes behind real time, hence
// one hour at least.
export const OFFLINE_AFTER = ['60', '120', '360'];

export const DEFAULT_CONFIG = {
  station: '',
  udp: true,
  shake_ip: '',
  sensitivity: 'normal',
  offline_after: '60',
  language: 'fr',
};

/**
 * A station code as Raspberry Shake gives it ("R155B", "S10A9"), with or
 * without the network ("AM.R155B"), any case. Null when it is not one.
 */
export function parseStation(value) {
  const text = String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/^AM\./, '');
  return /^[A-Z0-9]{4,5}$/.test(text) ? text : null;
}

/** An IPv4 address, or null. */
export function parseIp(value) {
  const text = String(value ?? '').trim();
  const parts = text.split('.');
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) < 256)) {
    return null;
  }
  return parts.map(Number).join('.');
}

const bool = (value, fallback) => {
  if (value === true || value === 'true') {
    return true;
  }
  if (value === false || value === 'false') {
    return false;
  }
  return fallback;
};

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const typedStation = String(source.station ?? '').trim();
  const typedIp = String(source.shake_ip ?? '').trim();
  const shakeIp = parseIp(typedIp);
  const sensitivity = Object.hasOwn(SENSITIVITIES, source.sensitivity)
    ? source.sensitivity
    : DEFAULT_CONFIG.sensitivity;
  const offlineAfter = OFFLINE_AFTER.includes(String(source.offline_after))
    ? String(source.offline_after)
    : DEFAULT_CONFIG.offline_after;
  return {
    station: parseStation(typedStation),
    // Something was typed but is not a station code: said in the status.
    invalidStation: typedStation !== '' && parseStation(typedStation) === null,
    udp: bool(source.udp, DEFAULT_CONFIG.udp),
    shakeIp,
    // An address that does not parse lets every sender in, and says so.
    invalidIp: typedIp !== '' && shakeIp === null,
    sensitivity,
    trigger: SENSITIVITIES[sensitivity],
    offlineAfterMs: Number(offlineAfter) * 60 * 1000,
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULT_CONFIG.language,
  };
}
