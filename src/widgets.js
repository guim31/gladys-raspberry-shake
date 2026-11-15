// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `station`.
//
// The name of the station as given in Gladys, then (with the UDP output) the
// live vibration level and peak as device-bound tiles and the vibration level
// of the last day as a chart, and a status block: online, last data, shaking,
// UDP packets of the last minute. The chart can be hidden (setting
// `show_chart`). Budget: 1 or 2 texts, 2 tiles, 1 chart, 1 status.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { LANGUAGES } from './config.js';
import { NAMES } from './device.js';
import { WIDGET_KEY } from './monitor.js';
import { formatNumber, formatShortDate } from './texts.js';

export const TTL_SECONDS = 60;

export const TEXT = {
  noStation: {
    en: 'No station configured',
    fr: 'Aucune station configurée',
    de: 'Keine Station eingerichtet',
    es: 'Ninguna estación configurada',
  },
  notAdded: {
    en: 'Add the station in Gladys: Discovery tab of the integration.',
    fr: "Ajoutez la station dans Gladys : onglet Découverte de l'intégration.",
    de: 'Füge die Station in Gladys hinzu: Reiter Entdecken der Integration.',
    es: 'Añada la estación en Gladys: pestaña Descubrir de la integración.',
  },
  online: { en: 'Station', fr: 'Station', de: 'Station', es: 'Estación' },
  yes: { en: 'Online', fr: 'En ligne', de: 'Online', es: 'En línea' },
  no: { en: 'Offline', fr: 'Hors ligne', de: 'Offline', es: 'Fuera de línea' },
  unknown: { en: 'Checking…', fr: 'Vérification…', de: 'Wird geprüft…', es: 'Comprobando…' },
  lastData: { en: 'Last data', fr: 'Dernière donnée', de: 'Letzte Daten', es: 'Último dato' },
  none: { en: 'None', fr: 'Aucune', de: 'Keine', es: 'Ninguno' },
  ground: { en: 'Ground', fr: 'Sol', de: 'Boden', es: 'Suelo' },
  calm: { en: 'Calm', fr: 'Calme', de: 'Ruhig', es: 'En calma' },
  shaking: { en: 'Shaking', fr: 'Secousse', de: 'Erschütterung', es: 'Sacudida' },
  udp: { en: 'UDP (1 min)', fr: 'UDP (1 min)', de: 'UDP (1 Min.)', es: 'UDP (1 min)' },
  packets: { en: 'packets', fr: 'paquets', de: 'Pakete', es: 'paquetes' },
  rsam: { en: 'RSAM', fr: 'RSAM', de: 'RSAM', es: 'RSAM' },
  peak: { en: 'Peak', fr: 'Crête', de: 'Spitze', es: 'Pico' },
  chart: {
    en: 'Vibration level, 24 h',
    fr: 'Niveau de vibration, 24 h',
    de: 'Vibrationspegel, 24 h',
    es: 'Nivel de vibración, 24 h',
  },
};

const t = (text, language) => text[language] ?? text.en;

const isFalse = (value) => value === false || value === 'false';

export const WIDGETS = {
  [WIDGET_KEY]: {
    async get(monitor, { language = 'en', settings = {} } = {}) {
      const lang = LANGUAGES.includes(language) ? language : 'en';
      const config = monitor.config;
      if (!config?.station) {
        return {
          ttl_seconds: TTL_SECONDS,
          components: [{ type: 'text', variant: 'heading', text: t(TEXT.noStation, lang) }],
        };
      }
      const ids = monitor.ids();
      const device = monitor.createdDevice();
      const features = monitor.createdFeatures();
      const has = (key) => features.has(ids[key]);
      const now = monitor.now();
      const components = [
        {
          type: 'text',
          variant: 'heading',
          text: (device?.name || `${NAMES[lang].device} ${config.station}`).slice(0, 40),
        },
      ];
      if (!device) {
        components.push({ type: 'text', variant: 'caption', text: t(TEXT.notAdded, lang) });
      }
      if (config.udp && has('rsam')) {
        components.push(
          { type: 'value', label: t(TEXT.rsam, lang), device_feature: ids.rsam },
          { type: 'value', label: t(TEXT.peak, lang), device_feature: ids.peak, icon: 'activity' },
        );
        if (!isFalse(settings.show_chart)) {
          components.push({
            type: 'chart',
            chart_type: 'line',
            title: t(TEXT.chart, lang),
            device_features: [ids.rsam],
            interval: 'last-day',
          });
        }
      }
      const last = monitor.lastData();
      const items = [
        {
          label: t(TEXT.online, lang),
          value:
            monitor.online === null
              ? t(TEXT.unknown, lang)
              : t(monitor.online ? TEXT.yes : TEXT.no, lang),
          color:
            monitor.online === null
              ? WIDGET_COLORS.NEUTRAL
              : monitor.online
                ? WIDGET_COLORS.SUCCESS
                : WIDGET_COLORS.DANGER,
        },
        {
          label: t(TEXT.lastData, lang),
          value: last === null ? t(TEXT.none, lang) : formatShortDate(last, lang),
          color: WIDGET_COLORS.NEUTRAL,
        },
      ];
      if (config.udp) {
        const count = monitor.udpCount(now);
        items.push(
          {
            label: t(TEXT.ground, lang),
            value: t(monitor.shaking ? TEXT.shaking : TEXT.calm, lang),
            color: monitor.shaking ? WIDGET_COLORS.WARNING : WIDGET_COLORS.SUCCESS,
          },
          {
            label: t(TEXT.udp, lang),
            value: `${formatNumber(count, lang)} ${t(TEXT.packets, lang)}`,
            color: count > 0 ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.WARNING,
          },
        );
      }
      components.push({ type: 'status', items });
      return { ttl_seconds: TTL_SECONDS, components };
    },
  },
};
