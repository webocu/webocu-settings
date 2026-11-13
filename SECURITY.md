# Security Policy

## Supported versions

Only the latest release receives fixes.

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

Use GitHub's private vulnerability reporting instead: open the **Security** tab of this repository and choose **Report a vulnerability**. Describe the problem, the version, the TV model and firmware if relevant, and the steps to reproduce it. You will get an answer as soon as the maintainer can read the report.

## What matters here

- The app ships a helper service that can run with **root** rights on a rooted TV (after elevation through the Homebrew Channel). It can restart or power off the TV, change system settings, install or remove a copy of the app under another application ID, and keep an init script in place. A flaw that lets another app, another device on the network or untrusted input drive those calls is in scope.
- The Makefile and `tools/install.sh` reach a rooted TV over ssh with the default password of the webosbrew root image (`alpine`), which is a public default of that image and not a secret of this project. Change that password on your TV if it is reachable from a network you do not trust.
- Device profiles (TV addresses, keys, passwords) are kept in a Docker volume on your machine and are never part of the repository. Do not commit them or paste them into issues.
