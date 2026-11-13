# =============================================================================
#  WebOCU Settings - webOS TV
#  Everything runs in containers: docker is the only host requirement.
#
#  make            list the targets
#  make check      lint + smoke test + ipk build (full project check)
#  make dev        static server on http://localhost:8080
#  make tv-add TV=192.168.1.50
#  make deploy     package + install + launch on the TV
#  make inspect    Chrome DevTools (copy the URL from the output into Chrome)
#  Root for the helper service: in the app, Tweaks -> Request privileges
#
#  Layout: source/ (app), tools/ (this toolchain), misc/ (readme assets),
#          dist/ (ipk), build/ + test/ (temporary, removed by make clean)
# =============================================================================

# =============================================================================
#  VERSION & BUILD WORKFLOW
#
#  Version Control:
#    make bump                        Bump patch version
#    make version-bump [PART=patch]   Explicitly bump version (patch/minor/major)
#
#  Build:
#    make build                       Build IPK package (idempotent, no version bump)
#    make build PART=patch            Build IPK and bump patch version
#
#  Deployment:
#    make bump                        Bump patch version first
#    make build                       Build IPK package
#    make deploy                      Install + launch existing IPK on TV
#
#  CI/Testing:
#    make check                       Validate without version changes (idempotent)
#
#  Cross-Platform Compatibility:
#    - All file operations use Docker containers for portability
#    - Auto-detects environment: cmd.exe on native Windows, bash everywhere else
#    - Works in: Windows cmd.exe, Git Bash, WSL, Linux, macOS
# =============================================================================

APP_ID     := webocu.settings
SERVICE_ID := webocu.settings.service

# Recursively expanded on purpose: `make package` bumps the patch number, and
# every later target must see the new value.
VERSION     = $(strip $(file < source/version.txt))
IPK         = dist/$(APP_ID)_$(VERSION)_all.ipk

# Docker Desktop puts both "docker" (a small wrapper with no shebang) and
# "docker.exe" on PATH. Make execs the binary itself for a plain recipe line and
# finds the .exe, but a line with quotes or an & in it goes through the shell,
# and a shell that does not append .exe picks the wrapper up instead - which
# cannot be exec'd ("exec format error: docker"). Naming the .exe on Windows
# makes both paths agree; elsewhere it stays plain docker.
DOCKER   := docker
ifeq ($(OS),Windows_NT)
DOCKER   := docker.exe
endif

# Explicit shell configuration for cross-platform compatibility
# Detect environment by checking for /bin/bash existence (works in Git Bash, WSL, native Unix)
ifneq ($(wildcard /bin/bash),)
  # Unix-like: Linux, macOS, Git Bash, WSL, Cygwin
  SHELL := /bin/bash
  BLANK_LINE = @echo
  Q := "
else
  # Native Windows cmd.exe
  SHELL := cmd.exe
  BLANK_LINE = @echo.
  Q :=
endif

# Help text is printed by make itself ($(info)), not by the shell, so it needs
# no quoting or ^-escaping and reads the same under bash and cmd.exe. I is the
# two-space indent: $(info) strips leading blanks, the empty E keeps them.
E :=
I := $(E)  $(E)

DC       := $(DOCKER) compose -f tools/docker-compose.yml
ARES     := $(DC) run --rm ares
DEVICE   ?=
NAME     ?=
TV       ?=
PORT     ?= 9922
USER     ?= prisoner
# Version bump part: major|minor|patch|keep (default: keep = no bump). The
# comment sits on its own line: written after the value, the blanks before it
# would become part of PART.
PART     ?= keep
# The window type in source/appinfo.json (make window): popup is the default,
# the rest exist to be compared against the system panels on a live TV.
TYPE     ?= popup

.DEFAULT_GOAL := help

# Suppress "Entering directory" / "Leaving directory" messages from recursive make calls
MAKEFLAGS += --no-print-directory

# Git Bash / msys rewrites container paths like /out/x.png into Windows ones on
# the way to docker.exe, and the screenshots go to a path inside the container.
# Exported rather than written in front of the command: an inline assignment in
# a recipe fails to exec under some msys shells (zsh: exec format error).
export MSYS_NO_PATHCONV = 1

# =============================================================================
# INFORMATION & HELP
# =============================================================================
.PHONY: help
help: ## List all available targets
	$(info =============================================================================)
	$(info $(I)WebOCU Settings ($(APP_ID) v$(VERSION)))
	$(info =============================================================================)
	$(info )
	$(info DEVELOPMENT)
	$(info $(I)dev              Start dev server on http://localhost:8080)
	$(info $(I)dev-stop         Stop the dev server)
	$(info $(I)shots            Screenshots of the UI into test/shots/)
	$(info )
	$(info QUALITY CHECKS)
	$(info $(I)check            Run all checks (CI-safe, no version bump))
	$(info $(I)lint             Validate JS, manifests, i18n, and version consistency)
	$(info $(I)smoke            UI smoke tests in headless Chromium)
	$(info )
	$(info BUILD)
	$(info $(I)build            Build IPK package)
	$(info $(I)bump             Bump patch version)
	$(info $(I)docker-build     Build Docker image with ares-* tools)
	$(info $(I)package          (Deprecated: use 'build'))
	$(info $(I)icons            Regenerate source/icons/*.png)
	$(info $(I)version          Print current version)
	$(info $(I)version-bump     Bump version manually (PART=major|minor|patch))
	$(info $(I)window           Switch window type for testing)
	$(info )
	$(info TV SETUP)
	$(info $(I)tv-add           Register Developer Mode TV (requires TV=<ip> NAME=<name>))
	$(info $(I)tv-add-root      Register rooted TV (requires TV=<ip> NAME=<name>))
	$(info $(I)tv-key           Fetch developer key (NAME=<name> optional))
	$(info $(I)tv-list          List registered devices)
	$(info $(I)tv-remove        Remove a registered device (requires NAME=<name>))
	$(info $(I)tv-reset         Reset all registered devices)
	$(info $(I)tv-use-tv        Switch to TV device)
	$(info $(I)tv-use-emulator  Switch to emulator device)
	$(info $(I)tv-use-<name>    Switch to any device (e.g. tv-use-tv2))
	$(info )
	$(info TV OPERATIONS)
	$(info $(I)install          Install IPK on registered TV (requires built IPK))
	$(info $(I)launch           Launch app on TV)
	$(info $(I)close            Close running app on TV)
	$(info $(I)inspect          Open Chrome DevTools for remote debugging)
	$(info $(I)deploy           Deploy existing IPK: install + launch (run 'make bump build' first))
	$(info $(I)uninstall        Remove app from TV)
	$(info )
	$(info UTILITIES)
	$(info $(I)shell            Bash inside ares-* container)
	$(info $(I)clean            Remove build/ and test/ directories)
	$(info $(I)distclean        Deep clean: remove dist/, containers, and images)
	$(info )
	$(info -----------------------------------------------------------------------------)
	$(info Variables:)
	$(info $(I)TV=<ip>          TV IP address (for tv-add, tv-add-root))
	$(info $(I)NAME=<name>      Device name (for tv-add, tv-add-root, tv-key, tv-remove))
	$(info $(I)DEVICE=$(DEVICE)   Target device for operations (default: from profile))
	$(info $(I)PORT=$(PORT)        SSH port for Developer Mode)
	$(info $(I)USER=$(USER)    SSH user (default: prisoner))
	$(info $(I)PART=$(PART)        Version part: major|minor|patch|keep (version-bump, build))
	$(info $(I)TYPE=$(TYPE)     Window type (overlay|minimal|popup|system_ui))
	$(info )
	$(info Rooted TV:)
	$(info $(I)ROOT_PORT=$(ROOT_PORT)     SSH port for root (default: 22))
	$(info $(I)ROOT_USER=$(ROOT_USER)   SSH user (default: root))
	$(info $(I)ROOT_PASS=$(ROOT_PASS) SSH password (default: alpine))
	@echo =============================================================================

# =============================================================================
# QUALITY CHECKS
# =============================================================================
.PHONY: check
check: lint smoke build-ipk ## Run all checks (full CI validation)

.PHONY: lint
lint: ## Validate JS, manifests, i18n, and version consistency
	$(DC) run --rm lint

.PHONY: smoke
smoke: ## UI smoke tests in headless Chromium
	$(DC) up -d serve
	$(DC) run --rm smoke

# =============================================================================
# BUILD
# =============================================================================
.PHONY: icons
icons: ## Regenerate source/icons/*.png
	$(DC) run --rm icons

.PHONY: docker-build
docker-build: ## Build Docker image with ares-* tools
	$(DC) build ares

.PHONY: build-ipk
build-ipk: docker-build ## Build IPK package (internal target)
	$(DC) run --rm -e PART=$(PART) ares sh tools/package.sh

.PHONY: build
build: build-ipk ## Build IPK package

.PHONY: package
package: build-ipk ## (Deprecated: use 'make build' instead)

.PHONY: version
version: ## Print current version
	@echo $(VERSION)

.PHONY: version-bump
version-bump: ## Bump version manually (PART=major|minor|patch)
	$(DC) run --rm icons sh tools/version.sh $(PART)

.PHONY: bump
bump: ## Bump patch version
	$(MAKE) version-bump PART=patch

.PHONY: window
window: ## Switch window type for testing (TYPE=overlay|popup|minimal|system_ui)
	$(DC) run --rm icons sh tools/window.sh $(TYPE)

# =============================================================================
# DEVELOPMENT
# =============================================================================
.PHONY: dev
dev: ## Start dev server on http://localhost:8080
	$(DC) up serve

.PHONY: dev-stop
dev-stop: ## Stop the dev server
	$(DC) down

SHOT_BASE := $(DC) run --rm shot --no-sandbox --headless --disable-gpu \
             --hide-scrollbars --window-size=1920,1080
SHOT      := $(SHOT_BASE) --virtual-time-budget=4000
# Virtual time runs as fast as it can, so a shot of something a timer takes away
# has to be taken before it fires: the scrollbar goes three seconds after the last
# movement, and four seconds of budget would photograph the list without it.
SHOT_QUICK := $(SHOT_BASE) --virtual-time-budget=2000

.PHONY: shots
shots: ## Screenshots of the UI into test/shots/ (headless Chromium, no TV)
	$(DC) up -d serve
	$(SHOT) --screenshot=/out/01-screen.png "http://serve:8080/index.html?section=screen"
	$(SHOT) --screenshot=/out/02-sound.png  "http://serve:8080/index.html?section=sound&expand=soundOutput"
	$(SHOT) --screenshot=/out/03-power.png  "http://serve:8080/index.html?section=power"
	$(SHOT) --screenshot=/out/04-system.png "http://serve:8080/index.html?section=system"
	$(SHOT) --screenshot=/out/05-confirm.png "http://serve:8080/index.html?confirm=restart"
	$(SHOT) --screenshot=/out/06-rail.png   "http://serve:8080/index.html"
	$(SHOT) --screenshot=/out/07-hidden.png "http://serve:8080/index.html?panel=0"
	$(SHOT) --screenshot=/out/08-app.png    "http://serve:8080/index.html?section=app"
#	The levels of the properties of the app: the theme, the background (the two pictures and the
#	transparency), what is general (autostart, idle close) and the panel itself.
	$(SHOT) --screenshot=/out/08-app-theme.png "http://serve:8080/index.html?section=theme"
	$(SHOT) --screenshot=/out/08-app-bg.png "http://serve:8080/index.html?section=bg"
	$(SHOT) --screenshot=/out/08-app-general.png "http://serve:8080/index.html?section=general"
	$(SHOT) --screenshot=/out/08-app-panel.png "http://serve:8080/index.html?section=panel"
#	The list of entrances of the panel (App properties -> Panel -> Entrance effect). The entrance
#	itself is a movement of a quarter of a second, over before a headless shot is taken: the list
#	is what a still picture can show.
	$(SHOT) --screenshot=/out/08-app-effect.png "http://serve:8080/index.html?section=panel&expand=appEffect"
	$(SHOT) --screenshot=/out/09-app-lang.png "http://serve:8080/index.html?section=app&expand=appLanguage"
	$(SHOT) --screenshot=/out/10-light.png  "http://serve:8080/index.html?section=app&theme=light"
	$(SHOT) --screenshot=/out/11-contrast.png "http://serve:8080/index.html?section=screen&theme=contrast&accent=cyan"
	$(SHOT) --screenshot=/out/12-bt.png     "http://serve:8080/index.html?section=bt"
	$(SHOT) --screenshot=/out/13-busy.png   "http://serve:8080/index.html?section=power&toast=busy"
	$(SHOT) --screenshot=/out/14-about.png  "http://serve:8080/index.html?section=about"
	$(SHOT) --screenshot=/out/15-accent.png "http://serve:8080/index.html?section=app&expand=appAccent"
	$(SHOT) --screenshot=/out/16-left.png   "http://serve:8080/index.html?section=screen&side=left&accent=azure"
	$(SHOT) --screenshot=/out/17-formats.png "http://serve:8080/index.html?time=12h&date=dmon"
	$(SHOT) --screenshot=/out/18-transparency.png "http://serve:8080/index.html?section=screen&transparency=50"
	$(SHOT) --screenshot=/out/19-contrast-light.png "http://serve:8080/index.html?section=system&theme=light&contrast=1&accent=azure"
	$(SHOT) --screenshot=/out/20-toast-light.png "http://serve:8080/index.html?section=screen&theme=light&toast=busy"
	$(SHOT) --screenshot=/out/21-toast-corner.png "http://serve:8080/index.html?section=screen&toast=busy&toastAt=bottom-left"
#	A dropdown opened in a level (auto-close, the second row of General): the row and its
#	options are on screen at once, with no scrolling to find them (menu.js setOptions /
#	revealOptions). The accents are a list taller than the window: their row stands at the
#	top and the first colours are under it.
	$(SHOT) --screenshot=/out/22-select-deep.png "http://serve:8080/index.html?section=general&keys=down,enter"
	$(SHOT) --screenshot=/out/23-select-long.png "http://serve:8080/index.html?section=theme&keys=down,down,enter"
	$(SHOT) --screenshot=/out/22-toasts.png "http://serve:8080/index.html?section=toasts"
	$(SHOT) --screenshot=/out/23-narrow.png "http://serve:8080/index.html?section=app&width=15"
	$(SHOT) --screenshot=/out/24-wide.png   "http://serve:8080/index.html?section=panel&width=85"
	$(SHOT) --screenshot=/out/25-weekday.png "http://serve:8080/index.html?section=app&date=wday&width=15"
	$(SHOT) --screenshot=/out/26-clock.png "http://serve:8080/index.html?section=clock"
#	The largest clock and date (XL) in the widest of the formats, and the same on the narrow stop:
#	the band of the clock keeps its height, the date is cut at the edge of the rail.
	$(SHOT) --screenshot=/out/26-clock-xl.png "http://serve:8080/index.html?section=clock&clockSize=xl&dateSize=xl&date=wdaydm"
	$(SHOT) --screenshot=/out/26-clock-xl-narrow.png "http://serve:8080/index.html?section=clock&clockSize=xl&dateSize=xl&date=wdaydm&width=15"
	$(SHOT) --screenshot=/out/27-widgets.png "http://serve:8080/index.html?section=widgets"
	$(SHOT) --screenshot=/out/28-widgets-held.png "http://serve:8080/index.html?section=widgets&keys=down,enter,down"
	$(SHOT) --screenshot=/out/29-slider-held.png "http://serve:8080/index.html?section=bg&keys=down,down,enter"
	$(SHOT) --screenshot=/out/32-widgets-off.png "http://serve:8080/index.html?section=widgets&keys=down,enter,left"
	$(SHOT_QUICK) --screenshot=/out/33-scroll.png "http://serve:8080/index.html?section=app&keys=down,down,down,down,down,down,down,down"
	$(SHOT) --screenshot=/out/34-insets.png "http://serve:8080/index.html?section=insets&keys=enter,right,right,right,right,right,right,right,right,right,right,right,right,right,right,right,right,right,right,right,right,right,right,right,right,right,right,right,right,right,right"
	$(SHOT) --screenshot=/out/35-insets-floor.png "http://serve:8080/index.html?section=app&padTop=540&padBottom=540"
	$(SHOT) --screenshot=/out/36-bg.png "http://serve:8080/index.html?section=app&bg=100&bgRail=100"
	$(SHOT) --screenshot=/out/37-bg-light.png "http://serve:8080/index.html?section=screen&bg=100&bgRail=100&theme=light"
	$(SHOT) --screenshot=/out/38-bg-soft.png "http://serve:8080/index.html?section=bg&keys=enter,right,right,right,right"
	$(SHOT) --screenshot=/out/39-tweaks.png "http://serve:8080/index.html?widgetsOff=1&section=tweaks"
	$(SHOT) --screenshot=/out/40-system-storage.png "http://serve:8080/index.html?section=system&keys=down,down,down,down,down,down"
	$(SHOT) --screenshot=/out/41-bg-corners.png "http://serve:8080/index.html?section=app&bg=100&bgRail=100&side=left&padTop=160&padBottom=160"
	$(SHOT) --screenshot=/out/42-rail-bare.png "http://serve:8080/index.html?section=widgets&time=off&date=off&keys=enter"
#	The accent and the bold type of the clock and the date are on by default now, so
#	the shot needs no keys: it shows the fresh-install look in a colour that is not
#	the stylesheet's own (amber), where the bands read as their own marks.
	$(SHOT) --screenshot=/out/43-clock-accent.png "http://serve:8080/index.html?section=clock&accent=amber"
	$(SHOT) --screenshot=/out/44-bg-rail-only.png "http://serve:8080/index.html?section=bg&bg=0&bgRail=100"
	@echo Done: test/shots/

.PHONY: shell
shell: docker-build ## Bash inside ares-* container
	$(ARES) bash

# =============================================================================
# TV SETUP & OPERATIONS
# =============================================================================
# The whole of what a TV is for here: register the device, put the package there,
# start and stop it. Nothing reads the TV or runs commands on it — the panel is
# developed and checked in the emulator (make dev / shots / smoke), and root for
# the helper service is asked for in the app itself (Tweaks -> Request
# privileges), not from the host.
.PHONY: tv-add
tv-add: docker-build ## Register Developer Mode TV (requires TV=<ip> NAME=<name>)
	@test -n "$(TV)" || (echo "Usage: make tv-add TV=<ip> NAME=<device-name>"; echo "Example: make tv-add TV=192.168.1.50 NAME=tv"; exit 1)
	@test -n "$(NAME)" || (echo "Usage: make tv-add TV=<ip> NAME=<device-name>"; echo "Example: make tv-add TV=192.168.1.50 NAME=tv"; exit 1)
	$(ARES) ares-setup-device --add $(NAME) \
		-i "host=$(TV)" -i "port=$(PORT)" -i "username=$(USER)" -i "default=true"
	$(BLANK_LINE)
	@echo ✓ Device '$(NAME)' registered
	@echo $(Q)Next: enable Developer Mode on the TV and run 'make tv-key NAME=$(NAME)' (needs the passphrase from the Developer Mode app).$(Q)

# A TV rooted with webosbrew runs a real sshd on port 22, where the account is
# root with the password alpine, and the Developer Mode key dance does not apply:
# the device profile carries that password instead of a private key. Everything
# else — install, launch, uninstall — then goes through the profile as usual.
ROOT_PORT ?= 22
ROOT_USER ?= root
ROOT_PASS ?= alpine

.PHONY: tv-add-root
tv-add-root: docker-build ## Register rooted TV with webosbrew (requires TV=<ip> NAME=<name>)
	@test -n "$(TV)" || (echo "Usage: make tv-add-root TV=<ip> NAME=<device-name>"; echo "Example: make tv-add-root TV=192.168.1.97 NAME=tv2"; exit 1)
	@test -n "$(NAME)" || (echo "Usage: make tv-add-root TV=<ip> NAME=<device-name>"; echo "Example: make tv-add-root TV=192.168.1.97 NAME=tv2"; exit 1)
	$(ARES) ares-setup-device --add $(NAME) \
		-i "host=$(TV)" -i "port=$(ROOT_PORT)" -i "username=$(ROOT_USER)" \
		-i "password=$(ROOT_PASS)" -i "default=true"
	$(BLANK_LINE)
	@echo ✓ Device '$(NAME)' registered
	@echo No 'make tv-key' needed on a rooted TV. Check with 'make tv-list', then 'make deploy DEVICE=$(NAME)'.

.PHONY: tv-key
tv-key: docker-build ## Fetch developer key from TV (NAME=<name> optional)
	@DEVICE_NAME="$(if $(NAME),$(NAME),$(DEVICE))"; \
	echo "Fetching key from device: $$DEVICE_NAME"; \
	$(ARES) ares-novacom --device "$$DEVICE_NAME" --getkey

.PHONY: tv-list
tv-list: docker-build ## List registered devices
	$(ARES) ares-setup-device --list

.PHONY: tv-remove
tv-remove: docker-build ## Remove a registered device (requires NAME=<name>)
	@test -n "$(NAME)" || (echo "Usage: make tv-remove NAME=<device-name>"; echo "Example: make tv-remove NAME=fox50"; exit 1)
	$(ARES) ares-setup-device --remove $(NAME)
	$(BLANK_LINE)
	@echo ✓ Device '$(NAME)' removed
	@echo Check with 'make tv-list'.

.PHONY: tv-reset
tv-reset: docker-build ## Reset all registered devices (requires Git Bash on Windows)
	@echo $(Q)NOTE: On Windows, this target requires Git Bash (sh.exe must be in PATH).$(Q)
	@echo $(Q)WARNING: This will remove ALL registered devices (emulator will remain).$(Q)
	@echo -n "Are you sure? [y/N] " && read ans && [ $${ans:-N} = y ]
	$(ARES) ares-setup-device --reset
	$(BLANK_LINE)
	@echo ✓ All devices removed
	@echo Built-in emulator remains. Re-register TVs with 'make tv-add' or 'make tv-add-root'.

.PHONY: tv-use-tv
tv-use-tv: docker-build ## Switch to TV device
	$(ARES) ares-setup-device -f tv
	$(BLANK_LINE)
	@echo ✓ Default device switched to: tv

.PHONY: tv-use-emulator
tv-use-emulator: docker-build ## Switch to emulator device
	$(ARES) ares-setup-device -f emulator
	$(BLANK_LINE)
	@echo ✓ Default device switched to: emulator

# Pattern rule for switching to any device: make tv-use-<device-name>
tv-use-%: docker-build
	$(ARES) ares-setup-device -f "$*"
	$(BLANK_LINE)
	@echo ✓ Default device switched to: $*

.PHONY: install
install: ## Install IPK on registered TV
	$(DC) run --rm -e DEVICE=$(DEVICE) -e APP_ID=$(APP_ID) ares sh tools/install.sh $(IPK)

.PHONY: launch
launch: docker-build ## Launch app on TV
	$(ARES) ares-launch $(if $(DEVICE),--device $(DEVICE)) $(APP_ID)

.PHONY: close
close: docker-build ## Close running app on TV
	$(ARES) ares-launch $(if $(DEVICE),--device $(DEVICE)) --close $(APP_ID)

.PHONY: inspect
inspect: docker-build ## Open Chrome DevTools for remote debugging
	@echo Starting ares-inspect...
	@echo $(Q)Note: ares-inspect will show the DevTools URL with a random port (35000-36000)$(Q)
	@echo Copy the full URL from output and open in Chrome
	@echo Example: http://localhost:35611/devtools/inspector.html?ws=...
	$(ARES) ares-inspect $(if $(DEVICE),--device $(DEVICE)) --app $(APP_ID)

.PHONY: deploy
deploy: ## Deploy existing IPK to TV and launch
	@echo === Deployment workflow ===
	@echo 1. Installing on TV...
	$(MAKE) install
	@echo 2. Launching app...
	$(MAKE) launch
	@echo === Deployment complete ===

.PHONY: uninstall
uninstall: docker-build ## Remove app from TV
	$(ARES) ares-install $(if $(DEVICE),--device $(DEVICE)) --remove $(APP_ID)

# =============================================================================
# CLEANUP
# =============================================================================
.PHONY: clean
clean: ## Remove build/ and test/ directories
	$(DC) run --rm icons sh -c "rm -rf /app/build /app/test"

.PHONY: distclean
distclean: clean ## Deep clean: remove dist/, containers, and images
	$(DC) run --rm icons sh -c "rm -rf /app/dist"
	$(DC) down -v --rmi local
