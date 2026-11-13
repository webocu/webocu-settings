# Contributing to WebOCU Settings

Thanks for your interest. Bug reports, fixes, translations and new options are welcome. This page explains how the project is built and checked, and what a change has to respect.

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE) of this project.

## Ground rules

- Open an issue before a large change, so the direction can be agreed first.
- Keep a pull request to one topic. Describe *why* in the pull request, not only what.
- `make lint` and `make build` have to pass; CI runs both. `make smoke` (headless Chromium, no TV needed) currently has known failures from checks written for older defaults: run it before and after your change and do not add new failures. Fixing those checks is a welcome contribution.
- Do not edit generated directories: `build/` and `test/` are created by `make` (`make clean` removes them), and `dist/` holds built packages. None of them is tracked.
- Never commit a TV address, a password or a key.

## Development environment

Docker is the only host requirement (Docker Desktop, or engine with Compose v2). There is no local Node.js or webOS CLI. Everything runs through [`tools/docker-compose.yml`](tools/docker-compose.yml).

```sh
make                     # list all targets
make check               # lint + smoke + package (the smoke step has known failures, see above)
make lint                # JS syntax, manifests, version, i18n, guard checks
make smoke               # headless Chromium DOM/focus/console test
make shots               # 1920x1080 screenshots into test/shots/
make dev                 # static server on http://localhost:8080 (make dev-stop)
make build               # build the IPK, version untouched (PART defaults to keep)
make build PART=patch    # bump the patch version, then build the IPK
make bump                # bump the patch version only
make version-bump PART=minor
make icons               # regenerate source/icons/*.png
make clean               # remove build/ and test/
```

There is no per-test runner: `lint` and `smoke` are single shell scripts ([`tools/lint.sh`](tools/lint.sh), [`tools/smoke.sh`](tools/smoke.sh)). To narrow a check, run the container directly (`docker compose -f tools/docker-compose.yml run --rm lint`) or open one URL by hand with the debug parameters below.

### Checking a change without a TV

Every behaviour is reachable from a URL query string, so `make shots` and `make smoke` can photograph or assert any state. The authoritative list of parameters is the comment block at the end of [`source/js/app.js`](source/js/app.js): `?section=`, `?expand=`, `?confirm=`, `?theme=`, `?contrast=`, `?accent=`, `?bg=`, `?bgRail=`, `?transparency=`, `?width=`, `?padTop=` / `?padBottom=`, `?side=`, `?autoclose=`, `?widgets=`, `?widgetsOff=`, `?toastAt=`, `?lang=`, `?time=`, `?date=`, `?toast=busy`, `?panel=0`, `?boot=1`, `?openAtStart=`, `?keys=up,down,left,right,enter,back`.

Two rules that trip people up:

- `preview*` parameters do **not** write the store, so a shot of the row itself would read the stored value. Shoot away from the row, or drive it with `?keys=` instead.
- `?keys=` is applied last, after every other parameter.

When a UI change alters the meaning of an existing shot, update the commented `$(SHOT)` line in the [`Makefile`](Makefile): those comments explain why each shot exists.

## Architecture in one page

Scripts load in a fixed order from [`source/index.html`](source/index.html), and each publishes one global. There are no modules and no bundler.

| File | Role |
| --- | --- |
| `js/keys.js` | remote key code → action name (`up`, `enter`, `back`, `menu`) |
| `locales/*.js` | one translation file per language |
| `js/i18n.js` | i18n API (`I18N.t()`, `setLang()`, `getAvailableLanguages()`) |
| `js/luna.js` | the only place that talks to luna-service |
| `js/platform.js` | webOS detection, UI scale, cursor, leaving or quitting the app |
| `js/store.js` | debounced localStorage cache of values (`webocu-settings.v1`) |
| `js/settings.js` | the settings model: sections, subsections, items |
| `js/dialog.js` | confirmation modal |
| `js/menu.js` | rendering, focus, remote navigation of the panel |
| `js/app.js` | entry point: key routing, screen-off state, debug parameters |
| `service/` | privileged helper service (Node, ES5), renamed to `<app-id>.service/` at build time |

**`settings.js` is where features go.** It is the declarative model: sections hold items of type `group`, `toggle`, `slider`, `select`, `action`, `submenu`, `info` and `reorder`. An item may carry `read(cb)` / `write(v, cb)` (without them the value lives only in localStorage), `confirmKey` and `status`. Adding an option should touch `settings.js` and the locale files and nothing else: not `menu.js`, not the CSS. Submenus nest through `parentId` in `subsections`.

**`luna.js` fallback chain.** Privileged calls are not available to a Developer Mode web app, so each one tries, in order: the helper service, the Homebrew Channel `exec` (root on a rooted TV), and the plain luna endpoint. The helpers `chain()` (success matters) and `chainData()` (the payload matters) implement this, and every failure is logged so the app log on the TV shows which path was accepted. Service names and setting categories moved between firmwares, so several are arrays tried in turn. Reboot goes to `com.webos.service.sleep`, **not** tvpower: tvpower's reboot powers the TV off.

**The helper service** mirrors much of `luna.js` server-side. It answers even before elevation, with `returnValue: false` and the underlying `errorText`, so the app can fall back and the reason stays visible. Node on the TV is old: ES5 only.

For the full start-up sequence and every service endpoint see [START_FLOW.md](START_FLOW.md); for where each setting is stored see [STORAGE_ARCHITECTURE.md](STORAGE_ARCHITECTURE.md).

## Code conventions

- **ES5 throughout**, in the browser and in the service: `var`, no arrow functions, no template literals, no `const` / `let`. Modules use the `window.X = (function () { ... })()` pattern.
- **Comments explain why**: non-obvious firmware behaviour, layout decisions, why a shot or a check exists. Match the density and the register of the surrounding code, and do not strip the comments that are there.
- **Code and comments are in English.**
- **Localization** lives in `source/locales/*.js`, one file per language. A language can be switched off by commenting out its `<script>` tag in `index.html`. `en.js` is required. The language list in the settings is built from `I18N.getAvailableLanguages()`.
- Keep line endings as the repository sets them (`.gitattributes`, `.editorconfig`).

## Invariants `make lint` enforces

Read [`tools/lint.sh`](tools/lint.sh) before changing any of these; a violation fails the build.

- `source/version.txt` is the single source of truth; `appinfo.json` and every service `package.json` mirror it (`make version-bump`).
- `appinfo.json`: `type: web`, `transparent: true`, `disableBackHistoryAPI: true`, `spinnerOnLaunch: false`, `networkStableTimeout: 0`, no `bgColor`, and `defaultWindowType` one of overlay / minimal / popup / system_ui (anything but popup, which ships, only warns; `make window TYPE=...` sets it for comparisons against system panels). These keep the window from stopping video playback or drawing a splash or spinner over the picture.
- The service id is identical in the directory name, the `package.json` name and `services.json` (`id` and `services[].name`); `luna.js` references that id and its `/status` and `/reboot` methods.
- i18n: every key is present in every language, no language holds a key that `en` lacks, and every `'a.b'`-shaped literal used in code exists in `en`.
- `Luna.reboot()` and `Luna.powerOff()` sit in an item literal that carries `confirmKey`.
- `img/{rail,pane}-{dark,light}.png` all exist, are referenced from `app.css`, are painted with `background-size: 100% 100%`, and no `border-image` is used anywhere.
- `about.html` exists and is not empty (it is read at runtime and referenced from nowhere).

## Installing on a TV

Device profiles live in the Docker volume `webocu-settings_ares-config`, at `/root/.webos/tv/novacom-devices.json` inside the container. The volume survives container restarts.

```sh
make tv-add TV=192.168.1.50 NAME=tv && make tv-key NAME=tv   # Developer Mode
make tv-add-root TV=192.168.1.51 NAME=tv2                    # rooted with webosbrew (root / alpine on port 22)
make tv-list                                                 # all registered devices
make tv-use-tv                                               # switch the default device
make tv-remove NAME=tv                                       # remove one device
make tv-reset                                                # remove all devices (asks first)
make build deploy                                            # build, install and launch
make launch / close / uninstall / inspect
```

By default `make deploy` (and `launch`, `close`, `uninstall`, `inspect`) uses the device marked as default in the profile. Override it with `DEVICE=<name>`:

```sh
make deploy DEVICE=tv2
```

`make install` picks the route from the registered device: `ares-install` for a Developer Mode profile, plain ssh for a rooted one (`ares-install` cannot talk to the sshd a rooted TV runs; see the comment at the top of [`tools/install.sh`](tools/install.sh)).

To reset the device profiles completely, stop the containers and remove the volume:

```sh
docker compose -f tools/docker-compose.yml down
docker volume rm webocu-settings_ares-config
```

`make tv-reset` clears the devices and keeps the volume.

Other variables: `TV=<ip>` (required by `tv-add`), `PART=patch|minor|major|keep` (version part to bump, default `keep`), `TYPE=overlay|minimal|popup|system_ui` (window type for testing), `ROOT_PASS` (ssh password of a rooted TV, default `alpine`).

### Debugging on the TV

`make inspect` starts `ares-inspect` in a container that publishes ports 35000-36000. It picks a random free port in that range and prints the DevTools URL; copy that URL into Chrome.

## Releasing

1. `make bump` (or `make version-bump PART=minor|major`), then update [CHANGELOG.md](CHANGELOG.md).
2. `make lint` and `make build`; run `make smoke` and compare it with the known failures.
3. `make build` writes `dist/webocu.settings_<version>_all.ipk`.
4. Tag `v<version>` and attach the `.ipk` to a GitHub release.
