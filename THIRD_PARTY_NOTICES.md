# Third-party notices

## What the package contains

The application package (`webocu.settings_<version>_all.ipk`) is built from the `source/` directory of this repository. It is plain HTML, CSS and JavaScript plus a Node.js helper service, written for this project and distributed under the [MIT License](LICENSE). No third-party library, font, binary or script is bundled in it. The only third-party material in it is the artwork of two icons, listed next.

## Icons

Two icons are adapted from [Lucide](https://lucide.dev/) (ISC License; portions © Cole Bemis, from Feather, MIT):

| Icon | Where | Adapted from |
| --- | --- | --- |
| Eco section | [`source/img/icon-eco.svg`](source/img/icon-eco.svg) | `leaf` (redrawn) |
| Fallback icon, shown while an icon is not loaded | `ICON_FALLBACK` in [`source/js/settings.js`](source/js/settings.js) | `circle-help` (redrawn) |

The text of the ISC License is in [`source/licenses/lucide-LICENSE.txt`](source/licenses/lucide-LICENSE.txt) and travels inside the package. The other section icons in [`source/img/`](source/img) are drawn for this project.

## Tools used to build and check it (not part of the package)

| Tool | Used for | License |
| --- | --- | --- |
| [webOS TV CLI](https://github.com/webos-tools/cli) (`@webos-tools/cli`, the `ares-*` commands) | packaging and installing the `.ipk` | Apache-2.0 |
| [Node.js](https://nodejs.org/) (`node:20-alpine`), [Python](https://www.python.org/) (`python:3.12-alpine`), Chromium (`zenika/alpine-chrome`) | linting, the dev server, the headless smoke test, run in Docker images | their own licenses |

These tools are downloaded by Docker when you run `make`; their files are not copied into this repository or into the package.

## Software the app talks to, but does not include

- [Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel) by the webosbrew project: on a rooted TV the app asks it to elevate the helper service. It is installed separately by the user.
- luna-service and the other services of webOS TV, which belong to the TV firmware.

## Trademarks

webOS and LG are trademarks of their respective owners. This project is not affiliated with or endorsed by LG Electronics.
