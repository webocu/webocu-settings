# Application Startup and Service Communication Flow

## Overview

This document provides comprehensive technical architecture overview of the interaction between the web application (source/js/*.js) and the privileged Node.js helper service (source/service/service.js).

The helper service enables operations unavailable to Developer Mode web apps: power management, system settings modification, Bluetooth connections, etc. The service becomes privileged after elevation via Homebrew Channel (Tweaks → Request privileges).

**Document Contents:**
1. Application startup sequence analysis
2. Complete service endpoint reference (30 endpoints)
3. Architectural patterns and verification procedures

---

## Table of Contents

1. [Application Startup Flow](#application-startup-flow)
2. [Service Architecture](#service-architecture)
3. [Service Endpoints Reference](#service-endpoints-reference)
4. [Architectural Patterns](#architectural-patterns)
5. [Verification and Testing](#verification-and-testing)
6. [Invariants](#invariants)
7. [UI Feature Mapping](#ui-feature-mapping)
8. [File Dependencies](#file-dependencies)
9. [Code References](#code-references)

---

## Application Startup Flow

### Web Application Launch

**Entry Point:** [index.html](source/index.html) loads scripts in fixed order → [app.js](source/js/app.js) executes last as entry point

**Service Launch:** [services.json](source/service/services.json) declares `webocu.settings.service` → webOS automatically starts [service.js](source/service/service.js) on app installation

### Execution Sequence

#### Phase 1: Synchronous Initialization (BEFORE service access)

Lines [app.js](source/js/app.js) execute synchronously:

**1. Platform Detection** [app.js](source/js/app.js)
```javascript
window.Platform.markPlatform();
window.Platform.bindUiScale();
window.Platform.watchCursor();
```
- Detects webOS environment
- Configures UI scale for 1920x1080 viewport
- Manages cursor visibility

**2. Apply App Preferences** [app.js](source/js/app.js)
```javascript
if (window.Settings.applyAppPrefs()) window.Menu.relabel();
```

Implementation [settings.js](source/js/settings.js) — `applyAppPrefs()` executes:
- `migrateTheme()`, `migrateOpacity()`, `applyTheme()`, `applyAccent()`, `applyBg()`
- `applyTransparency()`, `applyWidth()`, `applyInsets()`, `applySide()`
- `applyLanguage()`, `applyWidgetOrder()`

**Key Finding:** Application is fully functional WITHOUT the service (works in browser dev mode with localStorage).

**3. Icon Loading & Panel Opening** [app.js](source/js/app.js)
- **Headless mode** (tests): `loadIconsSync()` → synchronous SVG loading
- **Production mode**: `Menu.open()` first → `loadIcons(callback)` asynchronously
- The opening plays the entrance effect of the panel (App properties → Panel → Entrance effect,
  `data-panel-effect`): `Menu.open()` takes the start position in (a forced reflow) before it adds
  `is-open`. A panel left up while the app is hidden goes back to its start unseen (`Menu.rest()`)
  and comes out again when the app is shown (`Menu.playIn()`, `visibilitychange`).

**4. Navigation Build** [menu.js](source/js/menu.js)
- `buildRail()` constructs section navigation from `Settings.sections`; the Widgets level does not call it for
  a step of ▲ ▼ — `syncRailOrder()` moves the existing icons and the held row swaps places with its
  neighbour in the DOM (no list is written again, the scroll stays); only a section switched on or off
  builds the rail again

#### Phase 2: Asynchronous Service Queries (AFTER app start)

**Device Info Loading** [app.js](source/js/app.js)
```javascript
window.Settings.loadDeviceInfo(function () {
  window.Menu.relabel();
});
```

Implementation [settings.js](source/js/settings.js):
1. `Luna.systemInfo(callback)` → retrieves TV model and firmware
2. `Luna.serviceStatus(callback)` → checks service status (running, root)

**First Service Call** [luna.js](source/js/luna.js)
```javascript
call(SERVICE + '/status', {}, ...)
```

**Proof:** First service interaction is a status check, not privileged operation.

---

## Service Architecture

### Overview

**Service ID Pattern:**
```javascript
var APP_ID = getAppId();  // webocu.settings OR amazon, netflix, etc.
var SERVICE_ID = APP_ID + '.service';
```

**Files:**
- Client: [luna.js](source/js/luna.js)
- Server: [service.js](source/service/service.js)

This pattern enables app cloning to different IDs via `/cloneAppId`.

### Service Lifecycle

1. **Installation:** webOS automatically starts service based on [services.json](source/service/services.json) manifest
2. **Initial State:** Service runs without root privileges (`uid: 1000`)
3. **Elevation:** Via Homebrew Channel → Tweaks → Request privileges → service respawns as root (`uid: 0`)
4. **Verification:** `/status` endpoint returns current privilege level

### Communication Layer

**Single Point of Access:** [luna.js](source/js/luna.js) is the ONLY module that communicates with luna-service

**Calling Pattern:**
```
Application Code → Settings.js / App.js
                → Luna.js (abstraction layer)
                → PalmServiceBridge
                → Luna Bus
                → Helper Service OR Direct Luna Endpoints
```

---

## Service Endpoints Reference

### Summary: 30 Endpoints in 8 Categories

| Category | Endpoints | Root Required |
|----------|-----------|---------------|
| System Information | 5 | Partial |
| Power Management | 4 | Yes |
| Audio Control | 1 | Partial |
| Network Information | 2 | No |
| Bluetooth | 4 | Yes |
| System Settings | 2 | Partial |
| Application Management | 5 | Partial |
| Keep-alive | 7 | Partial |

---

### 1. System Information (5 endpoints)

#### `/status`
- **UI Feature:** Tweaks → "Request privileges" button state
- **Client Call:** `Luna.serviceStatus()` → [luna.js](source/js/luna.js)
- **Parameters:** None
- **Returns:** `{ returnValue, service, root, uid, node, startTime }`
- **Root Required:** No
- **Purpose:** Check if service is running and privileged

#### `/osInfo`
- **UI Feature:** System → OS Information (webOS release, build ID, kernel version)
- **Client Call:** `Luna.osInfo()` → [luna.js](source/js/luna.js)
- **Parameters:** None
- **Returns:** `{ webos_name, webos_release, webos_build_id, core_os_kernel_version }`
- **Root Required:** No (may be restricted on some firmware)
- **Luna Calls:** `luna://com.webos.service.systemservice/osInfo/query`

#### `/serial`
- **UI Feature:** System → Device Information → Serial Number
- **Client Call:** `Luna.serial()` → [luna.js](source/js/luna.js)
- **Parameters:** None
- **Returns:** `{ serialNumber }`
- **Root Required:** May be required (if Luna call denied)
- **Luna Calls:** `luna://com.webos.service.tv.systemproperty/getSystemInfo`
- **Fallback:** Shell `nyx-cmd DeviceInfo query serial_number` (requires root)

#### `/uptime`
- **UI Feature:** System → System Information → Uptime
- **Client Call:** `Luna.uptime()` → [luna.js](source/js/luna.js)
- **Parameters:** None
- **Returns:** `{ uptime }` (seconds since boot)
- **Root Required:** No
- **System Calls:** `fs.readFile('/proc/uptime')` — world-readable

#### `/storage`
- **UI Feature:** System → Storage Information
- **Client Call:** `Luna.storage()` → [luna.js](source/js/luna.js)
- **Parameters:** None
- **Returns:** `{ storage }` (df output, human-readable)
- **Root Required:** No
- **System Calls:** `df -h /mnt/lg/appstore` (tries 3 paths: retail, developer, rooted)

---

### 2. Power Management (4 endpoints)

#### `/reboot`
- **UI Feature:** Power → Restart TV
- **Client Call:** `Luna.reboot()` → [luna.js](source/js/luna.js)
- **Parameters:** None
- **Returns:** `{ returnValue, via, root }`
- **Root Required:** Yes (for reliability)
- **Luna Calls (chain):**
  1. `luna://com.webos.service.sleep/shutdown/machineReboot`
  2. `luna://com.webos.service.power/shutdown/machineReboot`
  3. Shell: `sync; /sbin/reboot` (root only)
- **Note:** Does NOT use tvpower/reboot (it powers off instead of rebooting)

#### `/powerOff`
- **UI Feature:** Power → Power Off TV
- **Client Call:** `Luna.powerOff()` → [luna.js](source/js/luna.js)
- **Parameters:** None
- **Returns:** `{ returnValue, via, root }`
- **Root Required:** Yes
- **Luna Calls (chain):**
  1. `luna://com.webos.service.tvpower/power/powerOff`
  2. `luna://com.webos.service.power/shutdown/machineOff`
  3. Shell: `sync; /sbin/poweroff` (root only)

#### `/screenOff`
- **UI Feature:** Screen → Turn screen off
- **Client Call:** `Luna.turnOffScreen()` → [luna.js](source/js/luna.js)
- **Parameters:** None
- **Returns:** `{ returnValue, via, root }`
- **Root Required:** Yes (on most firmware)
- **Luna Calls:** `luna://com.webos.service.tvpower/power/turnOffScreen` (empty params)
- **Note:** Empty params = true blank, not standby mode

#### `/screenOn`
- **UI Feature:** Screen → Turn screen on / wake from screen-off state
- **Client Call:** `Luna.turnOnScreen()` → [luna.js](source/js/luna.js)
- **Parameters:** None
- **Returns:** `{ returnValue, via, root }`
- **Root Required:** Yes (on most firmware)
- **Luna Calls:** `luna://com.webos.service.tvpower/power/turnOnScreen`

---

### 3. Audio Control (1 endpoint)

#### `/mute`
- **UI Feature:** Sound → Mute / Unmute
- **Client Call:** `Luna.mute(on, cb)` → [luna.js](source/js/luna.js)
- **Parameters:** `{ mute: Boolean }` (default: true)
- **Returns:** `{ returnValue, via, root }`
- **Root Required:** May be required on some firmware
- **Luna Calls (tries both names):**
  - `luna://com.webos.service.audio/master/setMute`
  - `luna://com.webos.audio/master/setMute`
- **Note:** Service was renamed between webOS versions

---

### 4. Network Information (2 endpoints)

#### `/netStatus`
- **UI Feature:** System → Network → Connection status (WiFi + Ethernet)
- **Client Call:** `Luna.netStatus()` → [luna.js](source/js/luna.js)
- **Parameters:** None
- **Returns:** `{ wifi: { state, ipAddress, ssid }, wired: { state, ipAddress, ssid } }`
- **Root Required:** No
- **Luna Calls:** `luna://com.webos.service.connectionmanager/getStatus`

#### `/netMacs`
- **UI Feature:** System → Network → Hardware addresses (MAC addresses)
- **Client Call:** `Luna.netMacs()` → [luna.js](source/js/luna.js)
- **Parameters:** None
- **Returns:** `{ wifiInfo: { macAddress }, wiredInfo: { macAddress } }`
- **Root Required:** No
- **Luna Calls:** `luna://com.webos.service.connectionmanager/getinfo`

---

### 5. Bluetooth (4 endpoints)

#### `/btDevices`
- **UI Feature:** Bluetooth → Device List (all paired devices)
- **Client Call:** `Luna.btDevices()` → [luna.js](source/js/luna.js)
- **Parameters:** None
- **Returns:** `{ devices: [{ address, name, connected }] }`
- **Root Required:** May be required
- **Luna Calls (chain):**
  1. `luna://com.webos.service.bluetooth/gap/getTrustedDevices` (legacy API)
  2. `luna://com.webos.service.bluetooth2/device/getPairedDevices` (API level 12+)

#### `/btAdapter`
- **UI Feature:** Bluetooth → Adapter status (powered, discovering)
- **Client Call:** `Luna.btAdapter()` → [luna.js](source/js/luna.js)
- **Parameters:** None
- **Returns:** `{ powered, discovering, address }`
- **Root Required:** No
- **Luna Calls:** `luna://com.webos.service.bluetooth2/adapter/getStatus`

#### `/btConnect`
- **UI Feature:** Bluetooth → Connect to audio device
- **Client Call:** `Luna.btConnect(address)` → [luna.js](source/js/luna.js)
- **Parameters:** `{ address }` (format: XX:XX:XX:XX:XX:XX)
- **Returns:** `{ returnValue, address, via, root }`
- **Root Required:** Yes (on most firmware)
- **Luna Calls (chain):**
  1. `luna://com.webos.service.bluetooth/service/connect` (audio profile)
  2. `luna://com.webos.service.bluetooth2/a2dp/connect`

#### `/btDisconnect`
- **UI Feature:** Bluetooth → Disconnect from audio device
- **Client Call:** `Luna.btDisconnect(address)` → [luna.js](source/js/luna.js)
- **Parameters:** `{ address }` (format: XX:XX:XX:XX:XX:XX)
- **Returns:** `{ returnValue, address, via, root }`
- **Root Required:** Yes (on most firmware)
- **Luna Calls (chain):**
  1. `luna://com.webos.service.bluetooth/service/disconnect` (audio profile)
  2. `luna://com.webos.service.bluetooth2/a2dp/disconnect`

---

### 6. System Settings (2 endpoints)

#### `/setSetting`
- **UI Feature:** Write any system settings (picture, sound, etc.)
- **Client Call:** `Luna.setSetting(categories, key, value, cb, extra)` → [luna.js](source/js/luna.js)
- **Parameters:** `{ categories: Array, key: String, value: Any, extra: Object }`
- **Returns:** `{ returnValue, key, via, root }`
- **Root Required:** Yes (for privileged categories)
- **Luna Calls:** Tries all combinations (service_name × category):
  - `luna://com.webos.settingsservice/setSystemSettings`
  - `luna://com.webos.service.settings/setSystemSettings`
- **Note:** `extra` allows writing companion keys (e.g., energySavingModified)

#### `/getSetting`
- **UI Feature:** Read system settings
- **Client Call:** `Luna.readSetting(categories, key, cb)` → [luna.js](source/js/luna.js)
- **Parameters:** `{ categories: Array, key: String }`
- **Returns:** `{ returnValue, key, value, category, via, root }`
- **Root Required:** No (but some categories may require)
- **Luna Calls:** Same services, method `getSystemSettings`

---

### 7. Application Management (5 endpoints)

#### `/listApps`
- **UI Feature:** Debug → Apps → List all applications
- **Client Calls:**
  - `Luna.listApps()` → [luna.js](source/js/luna.js)
  - `Luna.checkAppExists(appId)` → [luna.js](source/js/luna.js) (for existence check)
- **Parameters:** None
- **Returns:** `{ apps: Array }` (each element: `{ id, systemApp, folderPath, ... }`)
- **Root Required:** No
- **Luna Calls:** `luna://com.webos.service.applicationmanager/listApps`

#### `/running`
- **UI Feature:** Debug → Apps → Running applications
- **Client Call:** `Luna.runningApps()` → [luna.js](source/js/luna.js)
- **Parameters:** None
- **Returns:** `{ running: Array }`
- **Root Required:** No
- **Luna Calls:** `luna://com.webos.service.applicationmanager/running`

#### `/listLaunchPoints`
- **UI Feature:** Debug → Apps → Launch points
- **Client Call:** `Luna.listLaunchPoints()` → [luna.js](source/js/luna.js)
- **Parameters:** None
- **Returns:** `{ launchPoints: Array }`
- **Root Required:** No
- **Luna Calls:** `luna://com.webos.service.applicationmanager/listLaunchPoints`

#### `/cloneAppId`
- **UI Feature:** Tweaks → Switch app ID (clone app to new ID)
- **Client Call:** `Luna.switchAppId(newId)` → [luna.js](source/js/luna.js)
- **Parameters:** `{ newId: String }`
- **Returns:** `{ returnValue, newId, output, root }`
- **Root Required:** Yes (needs filesystem access and package installation)
- **System Calls:**
  - Shell: `sh <zygote.sh> <currentId> <newId> <outputIpk>` (timeout 30s)
  - Script creates IPK and immediately installs it
  - Cleanup: `rm -f <outputIpk>`

#### `/patchAppInfo`
- **UI Feature:** Tweaks → Patch App Info (modify lockable and windowType without reinstall)
- **Client Call:** `Luna.patchAppInfo(lockable, windowType)` → [luna.js](source/js/luna.js)
- **Parameters:** `{ lockable: Boolean, windowType: String }` (at least one)
- **Returns:** `{ returnValue, output, note, errorText, root }`
- **Root Required:** Yes (modifies deployed app files)
- **System Calls:** Shell: `sh <patch_appinfo.sh> <currentId> [windowType=value]` (timeout 5s)
- **Note:** Requires app restart for changes to take effect

### 8. Keep-alive (7 endpoints)

The system closes an app that has been idle for a while; these endpoints keep it from doing that (Tweaks → Keep Alive).

#### `/keepalive`
- **Used by:** the service itself (self keep-alive) and the init.d daemon
- **Parameters:** None
- **Returns:** `{ returnValue, version, timestamp, wifi?, wired? }` (the IP addresses, when the TV has them)
- **Root Required:** No
- **Luna Calls:** `luna://com.webos.service.connectionmanager/getStatus`

#### `/enableSelfKeepalive`, `/disableSelfKeepalive`, `/selfKeepaliveStatus`
- **UI Feature:** Tweaks → Keep Alive → Webocu Service
- **Behaviour:** the service calls its own `/keepalive` every 30 seconds; no root needed. `enable` and `disable` are idempotent (`alreadyRunning` / `enabled` in the reply); `status` returns `{ enabled: Boolean }`
- **Root Required:** No

#### `/installKeepalive`, `/uninstallKeepalive`, `/keepaliveStatus`
- **UI Feature:** Tweaks → Keep Alive (installed automatically with root)
- **Behaviour:** `install` links `tweaks/keepalive_daemon.sh` into the Homebrew Channel's init.d and starts it; the daemon calls `/keepalive` every 30 seconds and starts the app after the TV boots. `uninstall` stops it and removes the link; `status` returns `{ installed, running }`
- **Root Required:** Yes for `install` and `uninstall`; `status` works without it

---

## Architectural Patterns

### 1. Fallback Chain (Fault Tolerance)

All privileged operations use a fallback chain:

```
Helper Service (root) → Homebrew Channel exec → Plain Luna endpoints
```

**Implementation:**
- Server: [service.js](source/service/service.js) — `runChain()` function
- Client: [luna.js](source/js/luna.js) — `chain()` function

**Logic:** Each candidate is tried in sequence until one returns `returnValue: true`. All failures are logged to console.

**Example Console Output (reboot without root):**
```
[luna] luna://webocu.settings.service/reboot failed: service not available
[luna] luna://org.webosbrew.hbchannel.service/exec failed: not installed
[luna] luna://com.webos.service.sleep/shutdown/machineReboot accepted the call
```

### 2. Reverse Chain for Reads

Non-privileged read operations use reverse order:

```
Plain Luna endpoints → Helper Service → Homebrew Channel exec
```

**Rationale:** Reads are usually permitted, so direct Luna call is faster. Service is only fallback for firmware with restricted reads.

### 3. Dynamic Service Naming

Service dynamically follows app ID:

```javascript
var APP_ID = getAppId();  // webocu.settings OR amazon, netflix, etc.
var SERVICE_ID = APP_ID + '.service';
```

**Files:**
- Client: [luna.js](source/js/luna.js)
- Server: [service.js](source/service/service.js)

This enables app cloning to different IDs via `/cloneAppId`.

### 4. Service Name Variations

Code handles multiple service names for cross-firmware compatibility:

- **Settings:** `com.webos.settingsservice` OR `com.webos.service.settings`
- **Audio:** `com.webos.service.audio` OR `com.webos.audio`
- **Bluetooth:** `com.webos.service.bluetooth` (legacy) OR `com.webos.service.bluetooth2` (API 12+)

**Files:**
- [luna.js](source/js/luna.js) — constants with name arrays
- [service.js](source/service/service.js) — server constants

### 5. Root Detection

All service responses include `root: Boolean` field:

```javascript
function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}
```

**File:** [service.js](source/service/service.js)

Client uses this to display status in UI (Tweaks → Request privileges).

---

## Verification and Testing

### 1. Check Service Availability

```bash
# On TV with installed application
luna-send -n 1 -f luna://webocu.settings.service/status '{}'
```

**Expected Output:**
```json
{
  "returnValue": true,
  "service": "webocu.settings.service",
  "root": false,  // or true after elevation
  "uid": 1000,    // or 0 for root
  "node": "v8.12.0",
  "startTime": 1635000000000
}
```

### 2. Test Fallback Chain

**In browser console (when app running):**

```javascript
// Should return mock data (service unavailable in browser)
window.Luna.serviceStatus(function(status) {
  console.log('Service:', status);
});
// Expected: {running: false, root: false, mocked: true}
```

**On TV without root:**

```javascript
window.Luna.reboot(function(ok, info) {
  console.log('Reboot result:', ok, info);
});
// Console should show chain of attempts:
// [luna] luna://webocu.settings.service/reboot failed: ...
// [luna] luna://...hbchannel.../exec failed: ...
// [luna] luna://.../shutdown/machineReboot accepted the call
```

### 3. Test Elevation

```bash
# 1. Check status BEFORE elevation
luna-send -n 1 -f luna://webocu.settings.service/status '{}'
# root: false

# 2. In app: Tweaks → Request privileges

# 3. Check status AFTER elevation
luna-send -n 1 -f luna://webocu.settings.service/status '{}'
# root: true
```

### 4. Monitor Service Logs

```bash
# Service journal on TV
journalctl -u webocu.settings.service -f

# On start:
# [webocu.settings.service] started, root=false, node=v8.12.0

# When /reboot called:
# [webocu.settings.service] reboot requested (root=true)
```

### 5. Test Startup Sequence

```bash
# 1. Start dev server
make dev

# 2. Open http://localhost:8080 in Chrome DevTools
# 3. Console should show EXACTLY in this order:
#    [webocu-settings] Icons loaded ...
#    [webocu-settings] start; webOS=false; luna=false ...
#    [webocu-settings] helper service: running=false, root=false
```

**Expected:** Icons load → app.js starts → loadDeviceInfo() checks service

### 6. Test Without Service

```bash
# In browser — service unavailable (mocked: true)
grep -n "mocked.*true" source/js/luna.js  # Should have fallback values
```

**Expected:** All `Luna.*` functions return mock data [luna.js:353-356,467-471,532,690-693](source/js/luna.js).

---

## Invariants

### Critical Requirements

1. **Script Load Order** [index.html](source/index.html)
   - MUST NOT change — each module depends on previous (IIFE pattern, global variables)

2. **applyAppPrefs() ALWAYS Before Menu.open()** [app.js](source/js/app.js)
   - Otherwise UI renders without applied theme/language settings

3. **Service is Optional** [luna.js](source/js/luna.js)
   - Fallback chain: service → Homebrew Channel → direct luna calls
   - Application works without root privileges

4. **Service Responds Even Without Root** [service.js](source/service/service.js)
   - Returns `returnValue: false` + `errorText` so app knows to fallback

5. **ES5 Code Only** ([CONTRIBUTING.md](CONTRIBUTING.md#code-conventions))
   - Both browser and service code CANNOT use arrow functions, template literals
   - Old Node.js on webOS

### Additional Guarantees

6. **Luna.js is Single Point of Access**
   - No other module makes direct luna-service calls

7. **All Responses Include `root` Field**
   - Client always knows privilege level

8. **Fallback Chain is Logged**
   - Every failure written to console for diagnostics

9. **Mock Data in Browser**
   - Application fully functional for development without TV

10. **Dynamic Service ID**
    - Service follows app ID for cloning support

---

## UI Feature Mapping

| UI Feature | Service Endpoints |
|-----------|-------------------|
| **System → Device Info** | `/serial`, `/osInfo`, `/uptime`, `/storage` |
| **System → Network** | `/netStatus`, `/netMacs` |
| **Power** | `/reboot`, `/powerOff` |
| **Screen** | `/screenOff`, `/screenOn` |
| **Sound** | `/mute` |
| **Bluetooth** | `/btDevices`, `/btAdapter`, `/btConnect`, `/btDisconnect` |
| **Settings (any category)** | `/setSetting`, `/getSetting` |
| **Tweaks → Request privileges** | `/status` |
| **Tweaks → Switch app ID** | `/cloneAppId` |
| **Tweaks → Patch App Info** | `/patchAppInfo` |
| **Debug → Apps** | `/listApps`, `/running`, `/listLaunchPoints` |

---

## File Dependencies

```
source/index.html
  └─> source/js/luna.js (single point of luna-service access)
       ├─> source/js/settings.js (calls Luna.readSetting/setSetting)
       ├─> source/js/app.js (calls Luna.systemInfo/serviceStatus at startup)
       └─> source/js/menu.js (indirectly via Settings.*())

source/service/services.json (manifest)
  └─> source/service/service.js (registers 30 endpoints)
       └─> webos-service (webOS SDK, built into firmware)
```

---

## Code References

### Client (luna.js)

- **Function `chain()`:** [luna.js](source/js/luna.js)
  - Implements fallback chain for privileged operations

- **Function `chainData()`:** [luna.js](source/js/luna.js)
  - Implements fallback chain for data retrieval

- **Public API Exports:** [luna.js](source/js/luna.js)
  - All public Luna.* functions available to application

### Service (service.js)

- **Function `runChain()`:** [service.js](source/service/service.js)
  - Server-side fallback chain implementation

- **Function `readChain()`:** [service.js](source/service/service.js)
  - Server-side data retrieval chain

- **All `service.register()` Calls:** [service.js](source/service/service.js)
  - 30 endpoint registrations

### Initialization

- **Device Info Loading:** [app.js](source/js/app.js) → [settings.js](source/js/settings.js)
- **Service Status Check:** [settings.js](source/js/settings.js)

---

## Summary

**30 service endpoints** covering **8 functional categories**:

1. **System Information** (5) — status, osInfo, serial, uptime, storage
2. **Power Management** (4) — reboot, powerOff, screenOff, screenOn
3. **Audio Control** (1) — mute
4. **Network Information** (2) — netStatus, netMacs
5. **Bluetooth** (4) — btDevices, btAdapter, btConnect, btDisconnect
6. **System Settings** (2) — setSetting, getSetting
7. **Application Management** (5) — listApps, running, listLaunchPoints, cloneAppId, patchAppInfo
8. **Keep-alive** (7) — keepalive, enableSelfKeepalive, disableSelfKeepalive, selfKeepaliveStatus, installKeepalive, uninstallKeepalive, keepaliveStatus

**All privileged operations** have fallback chains for compatibility with different access levels (Developer Mode / Root / Homebrew Channel).

**Application is service-independent:** Works fully in browser with mock data, gracefully degrades on TV without root privileges.

---

**Document Status:** Complete reference for startup flow and service communication architecture.
