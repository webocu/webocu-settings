# WebOCU Settings Storage Architecture

**Date**: 2026-11-13  
**Analysis**: Complete system overview of settings storage mechanisms

---

## Executive Summary

WebOCU Settings implements a **hybrid two-tier architecture** for managing application and system settings:

1. **localStorage** - Client-side cache and UI preferences storage
2. **Luna Service** - webOS system settings (TV firmware integration)

Key insight from the codebase:
> "On webOS the real source of truth is luna-service; this only keeps the last known value so the panel renders instantly and dev-mode stubs survive a restart"  
> — `source/js/store.js`

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Storage Tier 1: localStorage](#storage-tier-1-localstorage)
- [Storage Tier 2: Luna Service](#storage-tier-2-luna-service)
- [Settings Classification](#settings-classification)
- [Workflow Mechanisms](#workflow-mechanisms)
- [Synchronization](#synchronization)
- [Caching Strategy](#caching-strategy)
- [File Reference](#file-reference)
- [Settings Inventory](#settings-inventory)
- [Architecture Diagram](#architecture-diagram)

---

## Architecture Overview

### Two-Tier Storage System

```
┌─────────────────────────────────────────────────────────────┐
│                    FRONTEND (app.js)                         │
│                                                              │
│  ┌──────────────┐  read/write  ┌──────────────┐           │
│  │ settings.js  │──────────────▶│   store.js   │           │
│  │   (model)    │               │   (wrapper)  │           │
│  │              │               │              │           │
│  │ - items[]    │               │ debounce     │           │
│  │ - read()     │               │ 400ms        │           │
│  │ - write()    │               └──────┬───────┘           │
│  │ - apply*()   │                      │                    │
│  └──────┬───────┘                      │                    │
│         │                              ▼                    │
│         │                    ┌──────────────┐              │
│         │                    │ localStorage │              │
│         │                    │ (cache/src)  │              │
│         │                    └──────────────┘              │
│         │ Luna calls                                        │
│         ▼                                                    │
│  ┌──────────────┐                                          │
│  │   luna.js    │  PalmServiceBridge                       │
│  │  (wrapper)   │                                          │
│  └──────┬───────┘                                          │
└─────────┼────────────────────────────────────────────────────┘
          │ chain fallback:
          │ 1. service → 2. hbchannel → 3. direct
          ▼
┌─────────────────────────────────────────────────────────────┐
│                   BACKEND / webOS TV                         │
│                                                              │
│  ┌──────────────┐ runChain  ┌──────────────────┐          │
│  │  service.js  │───────────▶│ luna-service     │          │
│  │ (Node helper)│            │ (com.webos.*)    │          │
│  │              │            │                  │          │
│  │ root: 0/1    │            │ settingsservice  │          │
│  └──────────────┘            └──────────────────┘          │
│                                                              │
│  ┌──────────────┐            ┌──────────────────┐          │
│  │ hbchannel    │───────────▶│ bash scripts     │          │
│  │ (exec)       │            │ (elevate/patch)  │          │
│  └──────────────┘            └──────────────────┘          │
└─────────────────────────────────────────────────────────────┘
```

---

## Storage Tier 1: localStorage

### Implementation

**File**: `source/js/store.js` (36 lines)

```javascript
var KEY = 'webocu-settings.v1';
var data = {};

// Load on init
try {
  data = JSON.parse(window.localStorage.getItem(KEY) || '{}') || {};
} catch (e) {
  data = {};
}
```

### API

```javascript
Store.get(id, fallback)   // Read setting
Store.set(id, value)      // Write setting (debounced)
Store.reset()             // Clear all data
```

### Key Features

#### 1. Debounced Flush (400ms)

```javascript
function set(id, value) {
  data[id] = value;
  
  // Batch writes - critical for sliders!
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 400);
}

function flush() {
  try { 
    window.localStorage.setItem(KEY, JSON.stringify(data)); 
  } catch (e) { 
    /* quota exceeded */ 
  }
}
```

**Rationale**: Sliders generate dozens of writes per second during dragging.

#### 2. Dual Role

- **Cache** for system settings (energySaving, soundOutput, etc.)
- **Source of truth** for UI preferences (language, theme, panel size, etc.)

---

## Storage Tier 2: Luna Service

### Implementation

**Files**: 
- `source/js/luna.js` (916 lines) - Client wrapper
- `source/service/service.js` (655 lines) - Node.js backend

### Chain Fallback Pattern

Three-tier fallback for maximum compatibility:

```javascript
// 1. Helper service with root privileges
luna://webocu.settings.service/setSetting

// 2. Homebrew Channel exec (root via elevated helper)
hbchannel.service/exec → luna-send ...

// 3. Direct luna-service calls (no privileges)
luna://com.webos.settingsservice/setSystemSettings
```

### API Endpoints

#### getSetting

```javascript
service.register('getSetting', function (message) {
  var categories = params.categories || [];
  var key = params.key;
  
  settingsTargets(categories).forEach(function (target) {
    service.call(target.uri + 'getSystemSettings', 
      { category: target.category, keys: [key] }, ...);
  });
});
```

#### setSetting

```javascript
service.register('setSetting', function (message) {
  var settings = {};
  settings[params.key] = params.value;
  
  // Additional keys (e.g., energySavingModified)
  Object.keys(params.extra).forEach(function (name) { 
    settings[name] = params.extra[name]; 
  });
  
  runChain(settingsTargets(categories).map(...), message);
});
```

### Root Privileges

```javascript
function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

// Elevation process
Luna.elevate() 
  → hbchannel.service/exec 
    → elevate-service webocu.settings.service 
      → pkill old process 
        → ls-control scan-services 
          → TV restarts service with root
```

---

## Settings Classification

### 1. System Settings (webOS via Luna)

These settings are written to webOS system configuration and take effect immediately in the TV firmware.

#### Example: energySaving

```javascript
{
  id: 'energySaving',
  type: 'select',
  options: ['auto', 'off', 'min', 'med', 'max'],
  read: function (cb) { 
    Luna.readSetting(PICTURE_CATEGORIES, 'energySaving', cb); 
  },
  write: function (value, cb) {
    Luna.setSetting(PICTURE_CATEGORIES, 'energySaving', value, cb,
      { energySavingModified: 'true' });
  }
}
```

- **Storage**: webOS system settings, categories: `['picture', 'aiPicture', 'other']`
- **localStorage**: Cache only
- **Effect**: Luna → TV firmware → immediate backlight adjustment

#### Example: soundOutput

```javascript
{
  id: 'soundOutput',
  type: 'select',
  options: ['external_arc', 'bt_soundbar', 'external_optical', 'tv_speaker'],
  read: function (cb) { 
    Luna.readSetting(SOUND_CATEGORIES, 'soundOutput', cb); 
  },
  write: function (value, cb) { 
    Luna.setSetting(SOUND_CATEGORIES, 'soundOutput', value, cb); 
  }
}
```

- **Storage**: webOS system settings, categories: `['sound', 'aiSound', 'other']`
- **Effect**: Luna → TV firmware → audio routing change

---

### 2. Local Settings (localStorage only)

All UI preferences stored **exclusively** in localStorage.

#### Example: appLanguage

```javascript
{
  id: 'appLanguage',
  type: 'select',
  def: 'en',
  write: function (value, cb) {
    if (applyLanguage()) window.Menu.relabel();
    cb(true, { local: true });  // ← Flag "local only"
  }
}

function applyLanguage() {
  var lang = window.Store.get('appLanguage', 'en');
  var changed = window.I18N.setLang(lang);
  if (changed) buildBtItems();  // Rebuild dynamic strings
  return changed;
}
```

- **Storage**: localStorage, key: `'appLanguage'`
- **Effect**: I18N.setLang() → DOM text nodes updated

#### Example: appDarkMode

```javascript
{
  id: 'appDarkMode',
  type: 'toggle',
  def: true,
  write: function (value, cb) {
    applyTheme();
    cb(true, { local: true });
  }
}

function applyTheme() {
  var mode = window.Store.get('appDarkMode', true) ? 'dark' : 'light';
  var contrast = !!window.Store.get('appContrast', false);
  document.documentElement.setAttribute('data-theme', mode);
  document.documentElement.setAttribute('data-contrast', contrast ? 'on' : 'off');
}
```

- **Storage**: localStorage, key: `'appDarkMode'`
- **Effect**: DOM attribute `data-theme="dark|light"`

#### Example: appAccent

```javascript
{
  id: 'appAccent',
  type: 'select',
  def: 'magenta',
  options: ACCENTS,  // 28 colors
  write: function (value, cb) {
    applyAccent();
    cb(true, { local: true });
  }
}

function applyAccent() {
  var name = window.Store.get('appAccent', 'magenta');
  var hex = accentHex(name) || '#f21b9c';
  document.documentElement.style.setProperty('--accent', hex);
}
```

- **Storage**: localStorage, key: `'appAccent'`
- **Effect**: CSS variable `--accent: #hex`

#### Example: appPadTop / appPadBottom

```javascript
{
  id: 'appPadBottom',
  type: 'slider',
  min: 0, max: 540, step: 2,  // pixels
  def: 254,
  write: function (value, cb) {
    applyInsets();  // Applies BOTH insets together
    cb(true, { local: true });
  }
}

function applyInsets() {
  var top = nearestInset(Store.get('appPadTop', 0));
  var bottom = nearestInset(Store.get('appPadBottom', 254));
  
  // Floor logic: panel minimum 400px height
  var room = 1080 - 400;
  if (top + bottom > room) {
    bottom = Math.max(0, room - top);
  }
  
  document.documentElement.style.setProperty('--pad-top', top + 'px');
  document.documentElement.style.setProperty('--pad-bottom', bottom + 'px');
  document.documentElement.setAttribute('data-rail',
    1080 - top - bottom < 660 ? 'tight' : 'full');
}
```

- **Storage**: localStorage, keys: `'appPadTop'`, `'appPadBottom'`
- **Effect**: CSS variables + DOM attribute `data-rail`
- **Note**: Both applied together with floor logic

---

### 3. Hybrid Settings (localStorage + filesystem)

#### Example: tweaksAppType

```javascript
{
  id: 'tweaksAppType',
  type: 'select',
  def: 'popup',
  options: ['popup', 'overlay', 'card', 'minimal', 'home', 'system_ui'],
  write: function (v, cb) {
    window.Store.set('tweaksAppType', v);
    Luna.patchAppInfo(undefined, v, function (ok, info) {
      if (!ok) { cb(false, info); return; }
      window.Menu.toast(t('toast.appRestart'));
      cb(true, info);
    });
  }
}
```

- **Storage**: localStorage + `appinfo.json`
- **Effect**: `Luna.patchAppInfo()` → bash script → patches `appinfo.json`
- **Requires**: Root privileges, app restart
- **Result**: Window type changes (popup → overlay, etc.)

---

## Workflow Mechanisms

### Application Startup

**File**: `source/js/app.js`

```javascript
// 1. Apply all local settings FROM localStorage
window.Settings.applyAppPrefs();

// Inside applyAppPrefs() (settings.js:2857)
function applyAppPrefs() {
  migrateTheme();        // Migrate old format
  applyTheme();          // localStorage → DOM
  applyAccent();         // localStorage → CSS
  applyBg();             // localStorage → CSS + DOM
  applyBgRail();         // localStorage → CSS + DOM
  applyTransparency();   // localStorage → CSS (100 − value is the opacity)
  applyWidth();          // localStorage → CSS + DOM
  applyInsets();         // localStorage → CSS + DOM
  applySide();           // localStorage → DOM
  applyToast();          // localStorage → DOM
  applyRailLabels();     // localStorage → DOM
  applyClockLook();      // localStorage → DOM
  applyWidgetOrder();    // localStorage → sections.sort()
  return applyLanguage(); // localStorage → I18N
}
```

**Load order** (`index.html`):
1. `keys.js`, `locales/*.js`
2. `i18n.js`, `luna.js`, `platform.js`, `store.js`
3. **`settings.js`** (model)
4. `dialog.js`, `menu.js`
5. **`app.js`** (entry point → applyAppPrefs)

---

### Opening a Section

```javascript
// refresh() in settings.js:1356
function refresh(sectionId, done) {
  section.items.forEach(function (item) {
    if (!item.read) return;
    
    item.read(function (remote) {
      var cached = value(item.id);  // from Store
      var differs = remote !== cached;
      
      if (differs) {
        window.Store.set(item.id, remote);  // Update cache
      }
      
      step(differs);
    });
  });
}
```

**Example: Screen section opened**
1. `refresh('screen', done)` called
2. For `energySaving`: `Luna.readSetting(['picture', ...], 'energySaving', cb)`
3. Luna tries chain: service → hbchannel → direct
4. Receives value `'max'` from webOS
5. Compares with localStorage (was `'auto'`)
6. Updates localStorage: `Store.set('energySaving', 'max')`
7. UI re-renders with new value

---

### User Changes Setting

```javascript
// commit() in settings.js:1340
function commit(id, newValue, cb) {
  var item = index[id];
  
  // 1. ALWAYS save to localStorage
  window.Store.set(id, newValue);
  
  // 2. If write() exists, write to TV
  if (!item.write) {
    cb(true, { local: true });  // Local only
    return;
  }
  
  item.write(newValue, function (ok, info) {
    cb(ok, info);
  });
}
```

**Scenario 1: appDarkMode (local)**
1. User: toggle enabled
2. `commit('appDarkMode', true, cb)`
3. `Store.set('appDarkMode', true)` → localStorage (debounced 400ms)
4. `item.write()` → `applyTheme()` → DOM attribute
5. `cb(true, { local: true })`
6. **No webOS interaction**

**Scenario 2: energySaving (system)**
1. User: select → `'max'`
2. `commit('energySaving', 'max', cb)`
3. `Store.set('energySaving', 'max')` → localStorage (cache)
4. `item.write()` → `Luna.setSetting(...)`
5. Luna chain:
   - `luna://webocu.settings.service/setSetting` (if service available)
   - `hbchannel.service/exec → luna-send ...` (if root)
   - `luna://com.webos.settingsservice/setSystemSettings` (direct)
6. First success → `cb(true, { mocked: false, via: '...' })`
7. **webOS immediately applies change**

---

## Synchronization

### localStorage ↔ webOS Settings

**NO automatic synchronization!**

- localStorage = **cache** for fast rendering
- webOS = **source of truth** for system settings

**Synchronization occurs:**
1. Section opened: `refresh()` → reads webOS → updates localStorage
2. App returns to foreground: `visibilitychange` event → `refresh()`

**Consistency issue:**
If setting changed outside app (via TV system menu):
- localStorage retains old value
- UI shows cached value
- Next `refresh()` updates it

**Solution:**
```javascript
// app.js:123
document.addEventListener('visibilitychange', function () {
  if (!document.hidden && window.Menu.isOpen()) {
    window.Menu.refresh();  // Update all visible values
  }
});
```

---

## Caching Strategy

### Debounced Flush

**File**: `source/js/store.js`

```javascript
function set(id, value) {
  data[id] = value;
  
  // Batch writes - critical for sliders!
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 400);  // 400ms delay
}
```

**Rationale**: Sliders generate dozens of writes per second during dragging.

### Apply Functions

All local settings applied via `apply*()` functions:
- Read from Store
- Validate/normalize (nearestStep)
- Apply to DOM
- **Don't write back** (except normalization)

**Example:**
```javascript
function applyWidth() {
  var percent = nearestWidth(window.Store.get('appWidth', 30));
  var pixels = Math.round(1920 * percent / 100);
  document.documentElement.style.setProperty('--panel-w', pixels + 'px');
  document.documentElement.setAttribute('data-width',
    percent < 30 ? 'narrow' : 'full');
  // Note: no Store.set() - only reads
}
```

---

## File Reference

| File | Purpose | Lines |
|------|---------|-------|
| `source/js/store.js` | localStorage wrapper | 36 |
| `source/js/settings.js` | Settings model (items, read/write, apply) | ~3250 |
| `source/js/luna.js` | Luna-service wrapper (chain fallback) | ~1100 |
| `source/service/service.js` | Node.js helper service (root proxy) | ~1000 |
| `source/js/app.js` | Entry point (applyAppPrefs) | ~370 |

---

## Settings Inventory

Comprehensive table of all settings by storage type:

| Setting | localStorage | webOS | appinfo.json | Application |
|---------|-------------|-------|--------------|-------------|
| **SYSTEM** |
| energySaving | cache | ✓ source | | Luna → TV firmware |
| soundOutput | cache | ✓ source | | Luna → TV firmware |
| **LOCAL UI** |
| appLanguage | ✓ source | | | I18N → DOM text |
| appDarkMode | ✓ source | | | DOM attribute |
| appContrast | ✓ source | | | DOM attribute |
| appAccent | ✓ source | | | CSS variable |
| appTransparency | ✓ source | | | CSS variable (`--ui-opacity` = 100 − value; an old `appOpacity` is carried over by `migrateOpacity()`) |
| appWidth | ✓ source | | | CSS variable + attribute |
| appBg | ✓ source | | | CSS variable + attribute |
| appBgRail | ✓ source | | | CSS variable + attribute |
| appPadTop | ✓ source | | | CSS variable |
| appPadBottom | ✓ source | | | CSS variable |
| appSide | ✓ source | | | DOM attribute |
| appEffect | ✓ source | | | DOM attribute `data-panel-effect` (`edge` / `opposite` / `top` / `bottom` / `fade` / `pop` / `none`, `edge` by default; the CSS moves the panel from its start to its place; `Menu.rest()` / `playIn()` replay it when the app is shown again) |
| appAutoClose | ✓ source | | | `Settings.autoCloseSeconds()` (timer in app.js) |
| appOpenAtStart | ✓ source | | | `Settings.openAtStart()` (read once at start, app.js) |
| appToastTop | ✓ source | | | DOM attribute |
| appToastAlign | ✓ source | | | DOM attribute |
| appRailLabels | ✓ source | | | DOM attribute |
| appTimeFormat | ✓ source | | | DOM attribute; `off` (the empty choice, worded Empty) comes first in the list, then `24h` (default), `24hn`, `12h` |
| appDateFormat | ✓ source | | | DOM attribute; `off` first, then `wday` (default), `dmy`, `mdy`, `ymd`, `dmon`, `dmonwd`, `dm`, `wdaydm`, `wdaynum`, `dlong` |
| appClockSize, appDateSize | ✓ source | | | DOM attribute (`data-clock-size`, `data-date-size`: `xs`/`s`/`m`/`l`/`xl`, `m` by default; the CSS scales the type 0.8 / 0.9 / 1 / 1.1 / 1.25) |
| appClockColour | ✓ source | | | DOM attribute |
| appDateColour | ✓ source | | | DOM attribute |
| appClockBold | ✓ source | | | DOM attribute |
| appWidgets | ✓ source | | | sections.sort() |
| widget:{id} | ✓ source | | | section.hidden |
| **HYBRID** |
| tweaksKeepAlive | ✓ source | | | service startup |
| tweaksAppType | ✓ source | | ✓ patched | bash script → restart |

---

## Architecture Diagram

### Data Flow: System Setting Change

```
User Input
    ↓
commit(id, value)
    ↓
Store.set(id, value) ──────────┐
    ↓                          │
item.write(value)              │ (debounced 400ms)
    ↓                          ↓
Luna.setSetting()         localStorage
    ↓                     'webocu-settings.v1'
Chain fallback:
1. webocu.settings.service
2. hbchannel exec
3. direct luna-service
    ↓
com.webos.settingsservice
    ↓
TV Firmware
(immediate effect)
```

### Data Flow: Local Setting Change

```
User Input
    ↓
commit(id, value)
    ↓
Store.set(id, value) ──────────┐
    ↓                          │
item.write(value)              │ (debounced 400ms)
    ↓                          ↓
applyTheme() / applyAccent() / applyInsets()
    ↓                     localStorage
DOM / CSS                 'webocu-settings.v1'
(immediate visual effect)
```

---

## Key Findings

### 1. localStorage is NOT source of truth for system settings

Comment in code explicitly states:
> "luna-service is the real source of truth"

localStorage used only for cache and UI preferences.

### 2. Debounced write is critical

400ms delay for batch operations.  
Without it, sliders would generate dozens of writes per second.

### 3. Chain fallback pattern

Ensures compatibility across different webOS versions.  
Works with/without root privileges.

### 4. No automatic synchronization

`refresh()` only when section opened.  
`visibilitychange` event for update on return.

### 5. Apply functions don't write to Store

Only read and apply to DOM.  
`Store.set()` happens in `commit()`, not in `apply*()`.

---

## Conclusion

WebOCU Settings uses localStorage as **cache + UI preferences storage**, and webOS settings via luna-service as **source of truth for system settings**. This hybrid approach enables:

- Fast UI rendering from cached values
- Reliable system integration via Luna Service
- Graceful fallback when service unavailable
- Efficient batch writes for slider controls

The panel's own preferences (theme, insets, widths, clock, idle close and so on) work **exclusively with localStorage** and require no Luna Service interaction, as they are local UI preferences.

---

**End of Document**
