# Raspberry Shake for Gladys Assistant

Your [Raspberry Shake](https://raspberryshake.org) personal seismograph in
[Gladys Assistant](https://gladysassistant.com): the vibration level of the ground at home, shaking
detection with its peak and duration, and the online status of the station.

**Developed without the hardware: feedback welcome.** The analysis was tested on a real recording of
a public station of the Raspberry Shake network (the M3.7 Pyrenees earthquake of 3 August 2026,
recorded 5 km away by AM.R6881), replayed in the UDP format of the Shake; no physical Shake was
connected. Not affiliated with Raspberry Shake, S.A.

## Features

- One device per station: **online** status and **last data**; with the UDP output (Datacast) of the
  Shake, **vibration level** (RSAM, mean absolute amplitude of each minute, counts), **peak
  amplitude** of each minute and **shaking detected** (STA/LTA trigger, back to calm after 10 s).
- Scene triggers: shaking detected (STA/LTA ratio), back to calm (peak, duration), station offline.
- A dashboard widget: status, live level and peak, 24-hour chart of the level.
- A "Check the station now" action.
- Without the UDP output, the online status comes from the public FDSN data of the network
  (`data.raspberryshake.org`), for stations that share their data.

It is not an early warning system: a home seismograph also feels footsteps, doors and trucks. For the
earthquakes reported by seismologists, see
[EMSC Earthquakes](https://github.com/guim31/gladys-emsc).

## Requirements

- Gladys Assistant 5.2.0 or later (the UDP port is published by a sub-container).
- A Raspberry Shake on the same local network as Gladys, for the UDP output.
- Internet access for the online status (optional with UDP).

## Installation

1. In Gladys: **Integrations → Install from GitHub**, address
   `https://github.com/guim31/gladys-raspberry-shake`.
2. In the configuration, type the code of your station (`R1A2B`).
3. On the web page of your Shake, **Settings → Datacast**: add the address and the UDP port shown at
   the top of the configuration screen (the port is chosen by Gladys).
4. Create the device in the **Discover** tab.

The full guide: [docs/en.md](docs/en.md) (also in [French](docs/fr.md), [German](docs/de.md) and
[Spanish](docs/es.md)).

## How it works

- The main container of an integration has no published port: a `receiver` sub-container, running the
  same image (`node src/receiver-main.js`), listens on UDP 8888 (published on a host port chosen by
  Gladys) and streams the raw datagrams to the main container over the private network of the
  integration.
- The main container parses the packets (`{'EHZ', 1785739788.538, 9866, ...}`), removes the offset,
  computes the minute RSAM and peak and a classic STA/LTA trigger (1 s / 30 s) on the vertical
  geophone, entirely in memory.
- Every 10 minutes it reads the headers of a few kilobytes of miniSEED from the FDSN dataselect
  service to know when the station last sent data (the public archive lags about 30 minutes).

## Limitations

- One station per Gladys; values in counts, no conversion to ground velocity, no magnitude.
- The detection is a simple STA/LTA trigger on one channel, without filter.
- The online status without UDP needs a station that shares its data, and is about 30 minutes late.

## Development

```bash
npm ci
npm run format:check && npm run lint && npm test
npx -y github:GladysAssistant/integration-store --skip-image-check .
```

The tests run against the SDK's fake Gladys, a fake FDSN service and a fake receiver link
(`test/receiver.test.js` uses real sockets on the loopback interface): never the network. The
fixture `test/fixtures/shake/r6881-ehz-2026-08-03.json` holds the 4 minutes of samples of the
recorded earthquake.

To feed a real Gladys (or the receiver) with that recording, as a Shake would:

```bash
node tools/replay.js <host> <port> [speed]
```

## Credits

- Data: the Raspberry Shake network, Raspberry Shake, S.A. (2016), Raspberry Shake [Data set],
  International Federation of Digital Seismograph Networks, https://doi.org/10.7914/SN/AM. The
  recording of station AM.R6881 comes from its public FDSN service.
- UDP format: the [Raspberry Shake manual](https://manual.raspberryshake.org/udp.html) and
  [rsudp](https://github.com/raspishake/rsudp), the open-source client of Raspberry Shake; no code is
  copied from it. Home Assistant has no Raspberry Shake integration.
- Cover: the Raspberry Shake logo, by Raspberry Shake S.A., CC BY 4.0, from
  [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Raspberry_Shake_Logo.svg) (source: the
  [media kit](https://raspberryshake.org/media-kit/)).
- Built on the [Gladys integration SDK](https://github.com/GladysAssistant/integration-sdk-js) and the
  official JavaScript template; the receiver sub-container follows
  [gladys-syslog](https://github.com/guim31/gladys-syslog).

## License

[Apache 2.0](LICENSE).
