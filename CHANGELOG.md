# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.3] - 2026-11-13 - Initial public release

First public release of WebOCU Settings: an overlay settings panel for webOS TV, driven by the remote, with a privileged helper service. Also available from the Homebrew Channel catalog at `https://webocu.github.io/`.

### Added

- Panel with sections for Screen, Sound, Power and System; optional Eco, Bluetooth, Tweaks and Debug sections that are off the rail on a fresh install.
- Settings widget: theme, high-contrast theme and accent colour; background pictures and transparency; panel width, side and insets; entrance effect; clock and date formats; section order and visibility; notification position; 12 interface languages.
- Close when idle, so the panel never keeps the remote from the picture underneath.
- Autostart switch for the start the TV makes by itself after boot: open the panel, or quit and start cold on the next launch. On a rooted TV the helper service keeps the keep-alive init script that makes that start.
- Helper service with a fallback chain (helper service, Homebrew Channel, plain luna endpoint), and silent privilege elevation at start on a rooted TV.
- Switch app ID (Tweaks): install a copy of the app under another application ID.
- Debug parameters that reach every state from a URL, a headless smoke test and a screenshot target, so the panel can be developed without a TV.
- Docker-based build, lint and install workflow (`make`).
- About: project address, the Homebrew Channel catalog and the related project (WebOCU Dock).

[0.3.3]: https://github.com/webocu/webocu-settings/releases/tag/v0.3.3
