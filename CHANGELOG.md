# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [1.0.0] - 2026-11-15

### Added

- A Raspberry Shake device per station: online status and last data received, from the UDP output
  of the Shake (Datacast) or the public data of the Raspberry Shake network (FDSN).
- With the UDP output: vibration level (RSAM) and peak amplitude of each minute, and shaking
  detection (STA/LTA trigger, three sensitivities), computed in Gladys from the live samples.
- Scene triggers: shaking detected, back to calm (peak and duration), station offline.
- A dashboard widget: station status, live vibration level and peak, 24-hour chart.
- A "Check the station now" action in the configuration screen.
- Texts and documentation in English, French, German and Spanish.

[Unreleased]: https://github.com/guim31/gladys-raspberry-shake/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/guim31/gladys-raspberry-shake/releases/tag/v1.0.0
