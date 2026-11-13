/* =========================================================================
   Entry point: remote key routing, screen-off state, app lifecycle.
   ========================================================================= */

/* Track app start time for uptime reporting */
window.appStartTime = Date.now();

(function () {
  var elCover = document.getElementById('screenCover');

  var screenIsOff = false;

  /* ----------------------------------------------------------- bootstrap -- */
  window.Platform.markPlatform();
  window.Platform.bindUiScale();
  window.Platform.watchCursor();

  /* The app's own preferences (language, theme) come from localStorage and are
     applied before anything is drawn. The TV locale is not followed: English is
     the language of a fresh install until the user picks another one. */
  if (window.Settings.applyAppPrefs()) window.Menu.relabel();

  /* Headless detection: navigator.userAgent contains 'HeadlessChrome' when running
     in smoke tests. This is NOT a security check - it's purely for test timing.
     Headless mode uses synchronous XHR to ensure icons load before DOM snapshot.
     Production mode loads asynchronously for better UX. */
  var isHeadless = navigator.userAgent.indexOf('HeadlessChrome') >= 0;

  /* Started by the TV rather than by the user: the keepalive init script starts
     the app once after boot with params.boot (tweaks/keepalive_daemon.sh).
     Settings -> General -> Autostart decides what that start does: on, the panel
     opens like on any other start and leaves by Auto-close (the window is shown
     before it is hidden, the path Back takes); off, the app quits at once and the
     next launch is a cold one (see Platform.quitApp). A start the user makes is
     never affected. ?boot=1 stands in for it in a desktop browser, ?openAtStart=
     for the switch (both read here, because the other params run after the
     panel is opened). */
  var query = {};
  window.location.search.replace(/^\?/, '').split('&').forEach(function (pair) {
    if (!pair) return;
    var parts = pair.split('=');
    query[decodeURIComponent(parts[0])] = decodeURIComponent(parts[1] || '1');
  });
  if ('openAtStart' in query) window.Settings.previewOpenAtStart(query.openAtStart);
  /* Read here too: the entrance of the panel is played by the opening itself. */
  if ('panelEffect' in query) window.Settings.previewPanelEffect(query.panelEffect);

  var launched = window.Platform.launchParams() || {};
  var bootStart = !!launched.boot || ('boot' in query && query.boot !== '0');
  var startHidden = bootStart && !window.Settings.openAtStart();

  /* Whether a surface of ours is up. While none is, the app owns nothing: the
     backdrop that catches the pointer is gone (data-shown, app.css), so the
     remote belongs to what is in front. Menu.open()/close() keep the same
     attribute; this one adds the screen-off state, where the backdrop has to
     stay: a click of the Magic Remote on it wakes the screen. */
  function syncShown() {
    var on = screenIsOff || window.Menu.isOpen();
    document.documentElement.setAttribute('data-shown', on ? 'on' : 'off');
  }

  /* The first showing: the panel, or nothing when the TV started the app and
     Autostart is off. That is decided before the panel is ever opened, so it does
     not flash. If quitting does not work the panel is shown, as with Autostart
     on. */
  function showFirst() {
    if (startHidden) {
      console.log('[webocu-settings] boot launch: autostart is off, quitting (cold start on next launch)');
      window.Platform.quitApp(function () { window.Menu.open(); });
    } else {
      window.Menu.open();
    }
    syncShown();
  }

  if (isHeadless) {
    /* Headless mode: synchronous load blocks but ensures icons ready for tests.
       The panel opens after icons are loaded to avoid missing icons in DOM snapshot. */
    window.Settings.loadIconsSync();
    window.Menu.relabel();  /* Rebuild rail with loaded icons. */
    showFirst();
  } else {
    /* Production mode: panel opens immediately with fallback icons (help/question mark),
       SVG files load in background and replace fallbacks when ready. */
    showFirst();
    window.Settings.loadIcons(function(success) {
      /* Relabel rebuilds rail with loaded icons. If loading failed, fallbacks remain. */
      if (success) window.Menu.relabel();
    });
  }

  /* Model, firmware and the state of the helper service arrive asynchronously. */
  window.Settings.loadDeviceInfo(function () {
    window.Menu.relabel();
    /* No root yet: ask for it, silently. With it the service keeps the
       keepalive init script in place and the root-only rows come alive. A
       failure here changes nothing. */
    try {
      window.Settings.autoElevate(function (root) {
        if (root) window.Menu.relabel();
      });
    } catch (e) {
      console.warn('[webocu-settings] auto elevate: ' + e.message);
    }
  });

  /* ---------------------------------------------------------- leaving -- */
  /* The panel is the whole app, so closing it unloads the app: that is what
     hands the input focus back to whatever is playing underneath. */
  document.addEventListener('app:exit', function () {
    stopIdle();
    window.Platform.exitApp();
  }, false);

  /* ---------------------------------------------------------- screen off -- */
  /* Turning the panel off does not suspend the app: it keeps running and
     any key press brings the picture back. */
  document.addEventListener('app:screenoff', function (ev) {
    setScreenOff(!!(ev.detail && ev.detail.off));
  }, false);

  /* On the TV the panel really goes dark, so the job here is the opposite of
     painting: everything of ours leaves the screen (panel, balloon), because a
     visible overlay surface is what makes the firmware keep the backlight on —
     the result then looks like a black picture on a lit screen. The black cover
     is only a stand-in for a desktop browser, where no panel can be blanked. */
  function setScreenOff(flag) {
    screenIsOff = flag;
    var cover = flag && !window.Platform.isWebOS;
    elCover.classList.toggle('is-on', cover);
    elCover.setAttribute('aria-hidden', cover ? 'false' : 'true');

    if (flag) {
      window.Menu.hideToast();
      window.Menu.close();
      stopIdle();
    } else {
      window.Menu.open();
      armIdle();
    }
    syncShown();
  }

  function wakeScreen() {
    window.Luna.turnOnScreen(function () {});
    setScreenOff(false);
  }

  /* ---------------------------------------------------------- key routing - */
  document.addEventListener('keydown', function (ev) {
    var action = window.keyAction(ev.keyCode);
    if (!action) return;

    // Modal dialog wins over everything else.
    if (window.Dialog.handleKey(action)) { ev.preventDefault(); return; }

    // While the screen is off any key just wakes it up.
    if (screenIsOff) { wakeScreen(); ev.preventDefault(); return; }

    if (window.Menu.handleKey(action)) { ev.preventDefault(); return; }

    switch (action) {
      case 'enter':
      case 'up':
      case 'down':
      case 'menu':
        window.Menu.open();
        break;
      case 'back':
        window.Platform.exitApp();
        break;
      default:
        return;
    }
    ev.preventDefault();
  }, false);

  /* Clicking the empty area toggles the panel for the Magic Remote. Closing
     also leaves the app so the overlay does not keep swallowing remote input. */
  document.getElementById('backdrop').addEventListener('click', function () {
    if (screenIsOff) { wakeScreen(); return; }
    if (!window.Menu.isOpen()) { window.Menu.open(); armIdle(); return; }
    window.Menu.close();
    document.dispatchEvent(new CustomEvent('app:exit'));
  }, false);

  /* ---------------------------------------------------------- idle close -- */
  /* Settings -> App properties -> General -> Auto-close: this many seconds
     without a key or pointer movement and the panel closes and leaves the app
     (the same exit as Back), so it never keeps the remote from the picture
     underneath. Only on a TV, or when ?autoclose= asks for it: in a desktop
     browser (shots, smoke) nothing may close by itself. */
  var idleTimer = null;
  var idleOn = window.Platform.isWebOS || /[?&]autoclose(=|&|$)/.test(window.location.search);

  function stopIdle() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }

  /* A confirmation window and a balloon with a spinner (a reboot, a power off,
     elevation) are work in progress: the panel stays up under them. */
  function workPending() {
    return window.Dialog.isOpen() ||
      document.getElementById('toast').classList.contains('toast--busy');
  }

  function armIdle() {
    stopIdle();
    if (!idleOn || document.hidden || screenIsOff || !window.Menu.isOpen()) return;
    var seconds = window.Settings.autoCloseSeconds();
    idleTimer = setTimeout(function () {
      idleTimer = null;
      /* Armed before the window or the balloon appeared: count again, from now. */
      if (workPending()) { armIdle(); return; }
      console.log('[webocu-settings] idle ' + seconds + 's: closing');
      window.Menu.close();
      document.dispatchEvent(new CustomEvent('app:exit'));
    }, seconds * 1000);
  }

  /* Every key counts as activity, mapped or not, and after the route above: a
     value picked by this very press is the one the new timer uses. */
  document.addEventListener('keydown', function () { armIdle(); }, false);

  /* Pointer activity of the Magic Remote; listeners that never block a scroll. */
  ['mousemove', 'mousedown', 'wheel'].forEach(function (name) {
    document.addEventListener(name, armIdle, { passive: true });
  });

  /* ----------------------------------------------------------- lifecycle -- */
  document.addEventListener('visibilitychange', function () {
    /* Hidden with the panel up: it goes back to where its entrance starts, unseen, and
       comes out again when the app is shown (App properties -> Panel -> Entrance effect). */
    if (document.hidden) { stopIdle(); window.Menu.rest(); return; }
    window.Menu.playIn();
    // Values may have changed elsewhere while we were in the background.
    if (window.Menu.isOpen()) window.Menu.refresh();
    armIdle();
  }, false);

  document.addEventListener('webOSRelaunch', function () {
    setScreenOff(false);
    window.Menu.open();
    window.Menu.refresh();
    armIdle();
  }, false);

  /* --------------------------------------------------------- debug params -- */
  /* ?section=screen|sound|power|system|tweaks|app
                                        open a section — Tweaks only together
                                        with ?widgetsOff=, it ships off the rail
                                        and a section off the rail cannot open
     ?section=bt|clock|widgets|toasts|about
     ?section=theme|bg|general|panel|insets
                                        open a submenu (devices, the clock, the
                                        rail order, the balloon, the theme, the
                                        background, general, the panel, the
                                        insets, About) — insets is two levels
                                        down, so Panel is opened on the way
     ?expand=soundOutput                open a select list
     ?confirm=restart                   show the confirmation of an action
     ?theme=dark|light                  preview a mode without storing it
     ?contrast=1|0                      preview the contrast theme (?theme=contrast
                                        still works: this mode, high contrast)
     ?accent=red|azure|...              preview an accent colour (see ACCENTS)
     ?bg=0..100                         preview how solid the pictures from
                                        img/*.png are (step 10, 0 = no picture)
     ?transparency=0..70                preview the transparency (step 5, ceiling 70;
                                        0 is the default)
     ?panelEffect=edge|opposite|top|bottom|fade|pop|none
                                        how the panel comes onto the screen: from
                                        behind its own edge (the default), the opposite
                                        one, the top or the bottom, faded, grown, or at
                                        once (read before the first showing)
     ?width=15|20|...|80|85             preview the panel width (share of the
                                        screen, fifteen stops in steps of five)
     ?padTop=0..540 ?padBottom=0..540   preview the insets, in pixels of the
                                        1920x1080 layout (step 2; either alone,
                                        the other one keeps what is stored)
     ?side=left|right                   preview the docking edge
     ?autoclose=5|10|20|30|60           preview the idle seconds before the panel
                                        closes (a browser never closes it by
                                        itself without this param)
     ?widgets=power,screen,...          preview the order of the rail (the
                                        sections left out keep their own place)
     ?widgetsOff=sound,power            preview the rail without those sections;
                                        ?widgetsOff= alone puts them all back
     ?toastAt=top-left|bottom-right|... preview where the balloon appears
                                        (edge[-alignment], centre when omitted)
     ?lang=en|ru                        preview a language without storing it
     ?time=24h|24hn|12h|off             preview a clock format
     ?date=wday|dmy|mdy|ymd|dmon|dmonwd|dm|wdaydm|wdaynum|dlong|off
                                        preview a date format
     ?clockSize=xs|s|m|l|xl             preview the size of the clock (m is the default)
     ?dateSize=xs|s|m|l|xl              preview the size of the date
     ?toast=busy                        show the pending balloon (spinner)
     ?panel=0                           start with the panel hidden
     ?boot=1                            start as the TV does after boot (the
                                        keepalive init script's params.boot):
                                        with Autostart off the app quits
                                        instead of opening the panel
     ?openAtStart=0|1                   preview Autostart (applied before the
                                        first showing, so it works with ?boot=1)
     ?keys=enter,down,down              press remote keys, in that order: the
                                        only way a headless run can reach what
                                        needs several presses (moving a widget) */
  /* What ?keys= accepts. 'menu' is left out on purpose: it would leave the app,
     and a debug param that unloads the page has nothing left to dump. */
  var ACTIONS = ['up', 'down', 'left', 'right', 'enter', 'back'];

  (function applyQuery() {
    if (query.theme) window.Settings.previewTheme(query.theme);
    if (query.contrast) window.Settings.previewContrast(query.contrast);
    if (query.accent) window.Settings.previewAccent(query.accent);
    if ('bg' in query) window.Settings.previewBg(query.bg);
    if ('bgRail' in query) window.Settings.previewBgRail(query.bgRail);
    if (query.transparency) window.Settings.previewTransparency(query.transparency);
    if (query.width) window.Settings.previewWidth(query.width);
    /* One call for the pair: the floor of the panel is a question about both, and
       "?padTop=0" has to reach it too — hence the check for the name, not for a
       value the parser would have turned into '1'. */
    if ('padTop' in query || 'padBottom' in query) {
      window.Settings.previewInsets(query.padTop, query.padBottom);
    }
    if (query.side) window.Settings.previewSide(query.side);
    if (query.autoclose) window.Settings.previewAutoClose(query.autoclose);
    /* The rail is drawn when menu.js loads, so a new order means rebuilding it:
       relabel() is what does that (and re-renders the level). */
    if (query.widgets) {
      window.Settings.previewWidgets(query.widgets);
      window.Menu.relabel();
    }
    /* Same reason for the rebuild, and an empty list is a preview of its own: the
       parser turns "?widgetsOff=" into '1', which is nobody's section id, so every
       section is on the rail whatever the store remembers. */
    if (query.widgetsOff) {
      window.Settings.previewWidgetsOff(query.widgetsOff);
      window.Menu.relabel();
    }
    if (query.toastAt) window.Settings.previewToast(query.toastAt);
    if (query.time || query.date) {
      window.Settings.previewClock(query.time, query.date);
      window.Menu.paintClock();
    }
    if (query.clockSize) window.Settings.previewClockSize('appClockSize', query.clockSize);
    if (query.dateSize) window.Settings.previewClockSize('appDateSize', query.dateSize);
    if (query.lang && window.I18N.setLang(query.lang)) window.Menu.relabel();
    if (query.panel === '0') window.Menu.close();
    if (query.section) window.Menu.showSection(query.section);
    if (query.expand) window.Menu.expand(query.expand);
    if (query.confirm) window.Menu.confirmAction(query.confirm);
    // Nothing is sent: only the balloon a long luna call would leave on screen.
    if (query.toast === 'busy') window.Menu.busy(window.I18N.t('toast.rebooting'));
    /* Last, so every other param has already put the panel where the presses are
       meant to land. Only the named actions go through — the same ones the remote
       produces (see keys.js), no key codes and nothing the panel cannot do. */
    if (query.keys) {
      query.keys.split(',').forEach(function (action) {
        if (ACTIONS.indexOf(action) >= 0) window.Menu.handleKey(action);
      });
    }
  })();

  /* After every param has put the panel where it is meant to be: the idle count
     starts (not for a hidden start, where the panel is not open). */
  armIdle();

  var info = window.Platform.deviceInfo();
  console.log('[webocu-settings] start; webOS=' + window.Platform.isWebOS +
    '; luna=' + window.Luna.isAvailable() +
    '; model=' + info.modelName + '; fw=' + info.firmwareVersion +
    '; lang=' + window.I18N.lang());
})();
