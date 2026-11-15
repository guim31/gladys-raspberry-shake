// -----------------------------------------------------------------------------
// Texts sent from the container (connection status, action message, feature
// values, scene variables), in the four languages of the Gladys interface.
// Entries are strings or functions of one parameter object. German says "du",
// Spanish "usted".
// -----------------------------------------------------------------------------

import { LANGUAGES } from './config.js';

// Connection status of the Configuration screen.
export const STATUS = {
  en: {
    noStation: 'Type the code of your station (e.g. R1A2B), shown on the web page of your Shake.',
    invalidStation: 'This is not a station code: it looks like R1A2B (5 letters and digits).',
    invalidIp: 'The address of the Shake is not a valid IPv4 address: every sender is accepted.',
    initFailed: 'Initialization failed, check the integration logs.',
    receiverDown: 'The UDP receiver does not answer: it is being restarted.',
    noUdp:
      'No UDP data from the Shake: in its settings (Datacast), send the UDP output to the address shown above.',
    unknownStation: ({ station }) =>
      `Station ${station} is not on the Raspberry Shake network: check the code, or use the UDP output.`,
    fdsnDown: 'The Raspberry Shake data service does not answer: try again later.',
  },
  fr: {
    noStation:
      'Saisissez le code de votre station (ex. R1A2B), affiché sur la page web de votre Shake.',
    invalidStation:
      "Ce n'est pas un code de station : il ressemble à R1A2B (5 lettres et chiffres).",
    invalidIp: "L'adresse du Shake n'est pas une adresse IPv4 valide : tout émetteur est accepté.",
    initFailed: "L'initialisation a échoué, consultez les logs de l'intégration.",
    receiverDown: 'Le récepteur UDP ne répond pas : il est en cours de redémarrage.',
    noUdp:
      "Aucune donnée UDP du Shake : dans ses réglages (Datacast), envoyez la sortie UDP vers l'adresse indiquée ci-dessus.",
    unknownStation: ({ station }) =>
      `La station ${station} n'est pas sur le réseau Raspberry Shake : vérifiez le code, ou utilisez la sortie UDP.`,
    fdsnDown: 'Le service de données de Raspberry Shake ne répond pas : réessayez plus tard.',
  },
  de: {
    noStation:
      'Gib den Code deiner Station ein (z. B. R1A2B), er steht auf der Webseite deines Shake.',
    invalidStation: 'Das ist kein Stationscode: Er sieht aus wie R1A2B (5 Buchstaben und Ziffern).',
    invalidIp:
      'Die Adresse des Shake ist keine gültige IPv4-Adresse: Jeder Absender wird angenommen.',
    initFailed: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
    receiverDown: 'Der UDP-Empfänger antwortet nicht: Er wird neu gestartet.',
    noUdp:
      'Keine UDP-Daten vom Shake: Sende in seinen Einstellungen (Datacast) die UDP-Ausgabe an die oben angezeigte Adresse.',
    unknownStation: ({ station }) =>
      `Station ${station} ist nicht im Raspberry-Shake-Netz: Prüfe den Code oder nutze die UDP-Ausgabe.`,
    fdsnDown: 'Der Datendienst von Raspberry Shake antwortet nicht: Versuch es später erneut.',
  },
  es: {
    noStation:
      'Introduzca el código de su estación (p. ej. R1A2B), indicado en la página web de su Shake.',
    invalidStation: 'Esto no es un código de estación: se parece a R1A2B (5 letras y cifras).',
    invalidIp: 'La dirección del Shake no es una IPv4 válida: se acepta cualquier emisor.',
    initFailed: 'La inicialización ha fallado, consulte los registros de la integración.',
    receiverDown: 'El receptor UDP no responde: se está reiniciando.',
    noUdp:
      'Ningún dato UDP del Shake: en sus ajustes (Datacast), envíe la salida UDP a la dirección indicada arriba.',
    unknownStation: ({ station }) =>
      `La estación ${station} no está en la red Raspberry Shake: compruebe el código o use la salida UDP.`,
    fdsnDown: 'El servicio de datos de Raspberry Shake no responde: inténtelo más tarde.',
  },
};

// The message of the "Check now" action.
export const CHECK = {
  en: {
    online: ({ station, time }) => `Station ${station} online, last data ${time}.`,
    offline: ({ station, time }) => `Station ${station} offline, last data ${time}.`,
    never: ({ station }) => `Station ${station} offline: no data in the last 24 hours.`,
    udp: ({ count }) => `UDP: ${count} packet(s) in the last minute.`,
    noUdp: 'UDP: nothing received.',
  },
  fr: {
    online: ({ station, time }) => `Station ${station} en ligne, dernière donnée ${time}.`,
    offline: ({ station, time }) => `Station ${station} hors ligne, dernière donnée ${time}.`,
    never: ({ station }) => `Station ${station} hors ligne : aucune donnée sur 24 heures.`,
    udp: ({ count }) => `UDP : ${count} paquet(s) dans la dernière minute.`,
    noUdp: 'UDP : rien reçu.',
  },
  de: {
    online: ({ station, time }) => `Station ${station} online, letzte Daten ${time}.`,
    offline: ({ station, time }) => `Station ${station} offline, letzte Daten ${time}.`,
    never: ({ station }) => `Station ${station} offline: keine Daten in den letzten 24 Stunden.`,
    udp: ({ count }) => `UDP: ${count} Paket(e) in der letzten Minute.`,
    noUdp: 'UDP: nichts empfangen.',
  },
  es: {
    online: ({ station, time }) => `Estación ${station} en línea, último dato ${time}.`,
    offline: ({ station, time }) => `Estación ${station} fuera de línea, último dato ${time}.`,
    never: ({ station }) => `Estación ${station} fuera de línea: ningún dato en 24 horas.`,
    udp: ({ count }) => `UDP: ${count} paquete(s) en el último minuto.`,
    noUdp: 'UDP: nada recibido.',
  },
};

/** One entry of a message table, in every language: `{ en, fr, de, es }`. */
export function render(table, key, params = {}) {
  return Object.fromEntries(
    LANGUAGES.map((language) => {
      const entry = table[language][key];
      return [language, typeof entry === 'function' ? entry(params) : entry];
    }),
  );
}

/** Several multi-language texts joined, language by language. */
export function join(...messages) {
  return Object.fromEntries(
    LANGUAGES.map((language) => [
      language,
      messages
        .filter(Boolean)
        .map((message) => message[language])
        .join(' '),
    ]),
  );
}

const locale = (language) => (language === 'en' ? 'en-GB' : language);

/** A full date in the time zone of Gladys (TZ), e.g. "03/08/2026 08:49:52". */
export function formatDate(time, language) {
  return new Intl.DateTimeFormat(locale(language), {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(time));
}

/** A short date, e.g. "03/08 08:49". */
export function formatShortDate(time, language) {
  return new Intl.DateTimeFormat(locale(language), {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(time));
}

/** A number in the user's language, e.g. "1 163 603". */
export function formatNumber(value, language, digits = 0) {
  return new Intl.NumberFormat(locale(language), {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
}
