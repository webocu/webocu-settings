/* =========================================================================
   webOS platform glue: device info, Magic Remote cursor, UI scaling, exit.
   Everything degrades gracefully in a desktop browser.
   ========================================================================= */
window.Platform = (function () {
  var sys = window.webOSSystem || window.PalmSystem || null;
  var isWebOS = !!sys || typeof window.PalmServiceBridge !== 'undefined';

  function deviceInfo() {
    var info = {
      modelName: '—',
      firmwareVersion: '—',
      sdkVersion: '—',
      screenWidth: 1920,
      screenHeight: 1080,
      uhd: false
    };
    if (sys && sys.deviceInfo) {
      try {
        var d = typeof sys.deviceInfo === 'string' ? JSON.parse(sys.deviceInfo) : sys.deviceInfo;
        info.modelName = d.modelName || info.modelName;
        info.firmwareVersion = d.version || d.firmwareVersion || info.firmwareVersion;
        info.sdkVersion = d.sdkVersion || info.sdkVersion;
        info.screenWidth = d.screenWidth || info.screenWidth;
        info.screenHeight = d.screenHeight || info.screenHeight;
        info.uhd = !!d.uhd;
      } catch (e) { /* malformed JSON from the platform */ }
    }
    return info;
  }

  /* Reads a file that travels inside the package (about.html, appinfo.json).
     WAM lets a packaged app read its own files, and a file:// read answers with
     status 0 instead of 200 — both count. Failures end up as null in the
     callback, so a missing file never throws in the middle of a render. */
  function loadText(path, cb) {
    var done = cb || function () {};
    var request;
    try { request = new XMLHttpRequest(); } catch (e) { done(null); return; }

    request.onreadystatechange = function () {
      if (request.readyState !== 4) return;
      var ok = request.status === 0 || (request.status >= 200 && request.status < 300);
      done(ok && request.responseText ? request.responseText : null);
    };

    try {
      request.open('GET', path, true);
      request.send(null);
    } catch (e) {
      done(null);
    }
  }

  /* The manifest as the TV reads it; used for the version in About. */
  var manifest;
  function appInfo(cb) {
    if (typeof manifest !== 'undefined') { cb(manifest); return; }
    loadText('appinfo.json', function (text) {
      try { manifest = text ? JSON.parse(text) : null; } catch (e) { manifest = null; }
      cb(manifest);
    });
  }

  /* Current application ID from appinfo.json. */
  function getAppId(cb) {
    appInfo(function (info) {
      cb(info && info.id ? info.id : 'webocu.settings');
    });
  }

  /* Launch parameters, also delivered on relaunch. */
  function launchParams() {
    if (!sys || !sys.launchParams) return {};
    try {
      return typeof sys.launchParams === 'string' ? JSON.parse(sys.launchParams) : sys.launchParams;
    } catch (e) {
      return {};
    }
  }

  /* Race condition guard: prevent multiple simultaneous exit attempts. */
  var isExiting = false;

  /* Leaving the panel: either close fully or hide to keep in memory for fast
     recall. User configurable Keep Alive toggle in Tweaks section (default: ON). */
  function exitApp() {
    leave(['hide', 'deactivate']);
  }

  /* Leaving the app for good, so that the next launch is a cold start: used by a
     boot start (params.boot) with Autostart off. hide() and deactivate() are no
     way out here: a window that was never shown is either not raised again by a
     later launch (SAM logs it, LSM never reports a window) or is shown empty on
     top of everything and keeps the remote's input (TV log, clone under the
     firmware-owned ID `amazon`). window.close() ends the app instead. If the page
     is still alive after two seconds the close did not work on this firmware, and
     `survived` gets to show the panel instead of leaving a window nobody can
     bring back. In a browser it is the same as exitApp(). */
  function quitApp(survived) {
    if (!isWebOS) { exitApp(); return; }
    try { window.close(); } catch (e) { console.warn('[webocu-settings] close: ' + e.message); }
    setTimeout(function () {
      console.warn('[webocu-settings] window.close() did not end the app');
      if (survived) survived();
    }, 2000);
  }

  /* Calls the first window method in `order` that this firmware has. */
  function leave(order) {
    // Idempotent guard: ignore if already exiting (rapid BACK presses).
    if (isExiting) return;
    isExiting = true;

    // Browser fallback: always try to close the tab.
    if (!isWebOS) {
      try { window.close(); } catch (e) { /* not allowed in a plain browser tab */ }
      isExiting = false;
      return;
    }

    // Always leave the screen (keep in memory), never exit completely.
    // App lifecycle is managed by Keep Alive settings (internal service or external daemon).
    var done = false;
    for (var i = 0; i < order.length && !done; i++) {
      if (sys && typeof sys[order[i]] === 'function') {
        sys[order[i]]();
        done = true;
      }
    }
    if (!done) console.warn('[webocu-settings] hide/deactivate methods unavailable');

    // Reset guard after hide completes.
    setTimeout(function () {
      console.log('[webocu-settings] left the screen; staying in memory for fast recall');
      isExiting = false;
    }, 300);
  }

  /* webOS fires cursorStateChange when the Magic Remote pointer appears. */
  function watchCursor(onChange) {
    document.addEventListener('cursorStateChange', function (e) {
      var visible = !!(e.detail && e.detail.visibility);
      document.documentElement.setAttribute('data-cursor', visible ? 'on' : 'off');
      if (onChange) onChange(visible);
    }, false);
    document.documentElement.setAttribute('data-cursor', 'off');
  }

  /* The UI is laid out for 1920x1080; scale it down in smaller windows. */
  function bindUiScale() {
    function apply() {
      var scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
      document.documentElement.style.setProperty('--ui-scale', scale.toFixed(5));
    }
    window.addEventListener('resize', apply, false);
    apply();
  }

  function markPlatform() {
    document.documentElement.setAttribute('data-platform', isWebOS ? 'webos' : 'browser');
  }

  return {
    isWebOS: isWebOS,
    deviceInfo: deviceInfo,
    loadText: loadText,
    appInfo: appInfo,
    getAppId: getAppId,
    launchParams: launchParams,
    exitApp: exitApp,
    quitApp: quitApp,
    watchCursor: watchCursor,
    bindUiScale: bindUiScale,
    markPlatform: markPlatform
  };
})();
