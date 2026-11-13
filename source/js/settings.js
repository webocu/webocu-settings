/* =========================================================================
   Settings model: sections, items and how each item talks to the TV.
   This is the only file to edit when adding options — menu.js and the CSS
   stay untouched.

   Item types:
     group   — subheading, not focusable
     toggle  — boolean, OK flips it
     slider  — number, OK enters edit mode, ◀ ▶ change the value (min/max/step)
     select  — list of options, OK expands it
     action  — button, OK runs it (add confirm: true for destructive ones)
     submenu — OK opens a nested level out of `subsections`
     info    — read-only text block
     reorder — a row that moves itself: OK picks it up, ▲ ▼ move it, OK drops it
               (the rail order; the row carries no value of its own)

   Optional per item:
     read(cb)        — pull the current value from the TV, cb(value)
     write(v, cb)    — push a new value, cb(ok, info)
     confirmKey      — i18n key of the confirmation question (actions only)
     status          — text (or a function) shown on the right of an
                       action/submenu row; statusOn accents it
   ========================================================================= */
window.Settings = (function () {
  var t = window.I18N.t;
  var Luna = window.Luna;

  /* Universal fallback icon shown when SVG files fail to load. Using help/question
     mark provides clear visual feedback without listing every icon inline. Saves
     ~1.5KB compared to full inline SVG fallbacks. TV fonts may lack emoji glyphs,
     so SVG is used for all icons. */
  var ICON_FALLBACK = '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="6"></rect><path d="M9.4 9.3a2.7 2.7 0 0 1 5.2 1c0 1.8-2.6 2.3-2.6 3.7M12 17.2h.01"></path></svg>';

  var ICON = {
    screen: ICON_FALLBACK,
    sound: ICON_FALLBACK,
    bluetooth: ICON_FALLBACK,
    power: ICON_FALLBACK,
    system: ICON_FALLBACK,
    app: ICON_FALLBACK,
    tweaks: ICON_FALLBACK,
    debug: ICON_FALLBACK,
    eco: ICON_FALLBACK
  };

  /* Icon loading state: icons are read from external SVG files at startup
     to keep them editable without touching JS. The ICON object above holds
     inline fallbacks until the files load. */
  var iconsLoaded = false;
  var iconsLoading = false;

  /* Load icon SVG files from img/ directory. Each icon replaces its inline
     fallback in the ICON object. Callback receives true if all loaded, false
     if any failed. Icons that fail to load keep their inline fallback. */
  function loadIcons(callback) {
    if (iconsLoaded) {
      if (callback) callback(true);
      return;
    }
    if (iconsLoading) {
      /* Already loading, wait with polling. */
      var checkInterval = setInterval(function() {
        if (iconsLoaded || !iconsLoading) {
          clearInterval(checkInterval);
          if (callback) callback(iconsLoaded);
        }
      }, 50);
      return;
    }

    iconsLoading = true;
    var startTime = Date.now ? Date.now() : +new Date();
    var names = ['screen', 'sound', 'bluetooth', 'power', 'system', 'app', 'tweaks', 'debug', 'eco'];
    var pending = names.length;
    var failed = 0;

    function checkDone() {
      pending--;
      if (pending === 0) {
        iconsLoading = false;
        iconsLoaded = (failed === 0);
        var loadTime = (Date.now ? Date.now() : +new Date()) - startTime;
        console.log('[webocu-settings] Icons loaded asynchronously in ' + loadTime + 'ms, ' + failed + ' failed');

        /* Update section icons with loaded SVGs. Each section.icon was initialized
           with ICON_FALLBACK at definition time. Now that ICON object is updated,
           copy the new values back to section objects so Menu.relabel() sees them. */
        for (var i = 0; i < sections.length; i++) {
          var sec = sections[i];
          if (sec.id && ICON[sec.id]) {
            sec.icon = ICON[sec.id];
          }
        }

        if (callback) callback(iconsLoaded);
      }
    }

    /* Load all icons in parallel, same pattern as about.html loading. */
    for (var i = 0; i < names.length; i++) {
      (function(name) {
        window.Platform.loadText('img/icon-' + name + '.svg', function(svg) {
          if (svg) {
            ICON[name] = svg;
          } else {
            console.warn('[webocu-settings] Failed to load icon-' + name + '.svg');
            failed++;
          }
          checkDone();
        });
      })(names[i]);
    }
  }

  /* Synchronous icon loading for headless Chrome tests. Blocks the thread but
     ensures icons are ready before the DOM snapshot. Do NOT use in production.
     Only called when navigator.userAgent contains 'HeadlessChrome'. */
  function loadIconsSync() {
    if (iconsLoaded) return;

    var startTime = Date.now ? Date.now() : +new Date();
    var names = ['screen', 'sound', 'bluetooth', 'power', 'system', 'app', 'tweaks', 'debug', 'eco'];
    var failed = 0;

    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var request;
      try { request = new XMLHttpRequest(); } catch (e) { failed++; continue; }

      try {
        request.open('GET', 'img/icon-' + name + '.svg', false); // false = synchronous
        request.send(null);
        var ok = request.status === 0 || (request.status >= 200 && request.status < 300);
        if (ok && request.responseText) {
          ICON[name] = request.responseText;
        } else {
          console.warn('[webocu-settings] Failed to load icon-' + name + '.svg (sync)');
          failed++;
        }
      } catch (e) {
        console.warn('[webocu-settings] Error loading icon-' + name + '.svg: ' + e);
        failed++;
      }
    }

    iconsLoaded = (failed === 0);
    var loadTime = (Date.now ? Date.now() : +new Date()) - startTime;
    console.log('[webocu-settings] Icons loaded synchronously in ' + loadTime + 'ms, ' + failed + ' failed');

    /* Update section icons immediately after sync load. Same reason as async version. */
    for (var i = 0; i < sections.length; i++) {
      var sec = sections[i];
      if (sec.id && ICON[sec.id]) {
        sec.icon = ICON[sec.id];
      }
    }
  }

  /* webOS moved these setting categories around between releases, so each
     read/write walks the list until one answers. Check the app log on the TV. */
  var PICTURE_CATEGORIES = ['picture', 'aiPicture', 'other'];
  var SOUND_CATEGORIES = ['sound', 'aiSound', 'other'];

  /* Long enough to read a short toast, short enough not to feel like a lag:
     used where the UI has to be gone before the call goes out. */
  var TOAST_READ_MS = 700;

  /* The one colour the panel highlights with (--accent in the CSS): the active
     section, a switch that is on, a slider fill, a link. Twenty-eight hues in total:
     sixteen bright colours, five neutrals (gray, silver, slate, white, black), and
     seven additional shades. The names stay tellable apart and the colour stays
     visible on the dark, the light and the contrast palette.
     `swatch` is what menu.js paints next to the name — a colour name alone
     tells nobody what "Orchid" looks like. */
  var ACCENTS = [
    { value: 'red',     labelKey: 'accent.red',     swatch: '#ff3b30' },
    { value: 'orange',  labelKey: 'accent.orange',  swatch: '#ff7a1a' },
    { value: 'amber',   labelKey: 'accent.amber',   swatch: '#ffab00' },
    { value: 'yellow',  labelKey: 'accent.yellow',  swatch: '#ffd400' },
    { value: 'lime',    labelKey: 'accent.lime',    swatch: '#c6e300' },
    { value: 'green',   labelKey: 'accent.green',   swatch: '#3ddc57' },
    { value: 'emerald', labelKey: 'accent.emerald', swatch: '#00c88a' },
    { value: 'teal',    labelKey: 'accent.teal',    swatch: '#00bfae' },
    { value: 'cyan',    labelKey: 'accent.cyan',    swatch: '#00d5ff' },
    { value: 'azure',   labelKey: 'accent.azure',   swatch: '#1f8dff' },
    { value: 'blue',    labelKey: 'accent.blue',    swatch: '#4560ff' },
    { value: 'violet',  labelKey: 'accent.violet',  swatch: '#7a5cff' },
    { value: 'purple',  labelKey: 'accent.purple',  swatch: '#a855f7' },
    { value: 'orchid',  labelKey: 'accent.orchid',  swatch: '#d946ef' },
    { value: 'magenta', labelKey: 'accent.magenta', swatch: '#f21b9c' },
    { value: 'pink',    labelKey: 'accent.pink',    swatch: '#ff5c8a' },
    /* Neutral colours: gray tones, white and black. Not pure #000000 or #ffffff
       to stay visible on both dark and light backgrounds. */
    { value: 'gray',    labelKey: 'accent.gray',    swatch: '#9ca3af' },
    { value: 'silver',  labelKey: 'accent.silver',  swatch: '#d1d5db' },
    { value: 'slate',   labelKey: 'accent.slate',   swatch: '#64748b' },
    { value: 'white',   labelKey: 'accent.white',   swatch: '#f5f5f5' },
    { value: 'black',   labelKey: 'accent.black',   swatch: '#1f1f1f' },
    /* Additional shades to fill out the palette. */
    { value: 'crimson', labelKey: 'accent.crimson', swatch: '#dc2626' },
    { value: 'gold',    labelKey: 'accent.gold',    swatch: '#f59e0b' },
    { value: 'mint',    labelKey: 'accent.mint',    swatch: '#10b981' },
    { value: 'sky',     labelKey: 'accent.sky',     swatch: '#0ea5e9' },
    { value: 'indigo',  labelKey: 'accent.indigo',  swatch: '#6366f1' },
    { value: 'rose',    labelKey: 'accent.rose',    swatch: '#f43f5e' },
    { value: 'coral',   labelKey: 'accent.coral',   swatch: '#fb7185' }
  ];

  /* Magenta is the colour the stylesheet ships with, so it is the default here
     as well: a fresh install looks exactly as it did before. */
  var DEF_ACCENT = 'magenta';

  /* How much of the picture shows through the whole overlay: 0 to 70 per cent in
     steps of five, nothing at the left end of the slider and in a fresh install.
     Seventy is the ceiling on purpose — any more and there is too little of the
     panel left on screen to aim the remote at (it used to be the floor of an
     opacity from 30 to 100). The row shows no number: the fill of the track is the
     readout, and per cent of transparency means nothing to the eye anyway. */
  var MIN_TRANSPARENCY = 0;
  var MAX_TRANSPARENCY = 70;
  var TRANSPARENCY_STEP = 5;
  var DEF_TRANSPARENCY = 0;

  /* How the panel comes onto the screen (App properties -> Panel -> Entrance effect): out
     from behind the edge it stands at, as it always did, or from behind the opposite edge
     of the screen, or from the top or the bottom, or faded in, or grown a little, or just
     there. The CSS reads it from <html> (data-panel-effect); the key names are spelled out,
     not built from the value: the i18n check looks for whole keys. */
  var PANEL_EFFECTS = [
    { value: 'edge', labelKey: 'app.effect.edge' },
    { value: 'opposite', labelKey: 'app.effect.opposite' },
    { value: 'top', labelKey: 'app.effect.top' },
    { value: 'bottom', labelKey: 'app.effect.bottom' },
    { value: 'fade', labelKey: 'app.effect.fade' },
    { value: 'pop', labelKey: 'app.effect.pop' },
    { value: 'none', labelKey: 'app.effect.none' }
  ];
  var DEF_PANEL_EFFECT = 'edge';

  /* How solid the pictures behind the two columns are: nothing at all in a fresh
     install, up to a hundred per cent in steps of ten. Zero is the off state of
     the setting and not a floor — "no picture" is the bottom of the same
     question, so one row answers it instead of a switch and a slider answering
     it twice. Ten steps and not twenty: the difference a single step makes has to
     be visible on a TV across the room. */
  var MIN_BG = 0;
  var MAX_BG = 100;
  var BG_STEP = 10;
  var DEF_BG = 10;

  /* How wide the panel is, as a share of the screen: fifteen stops in steps of
     five per cent, from 15% of it to 85% of it — 15, 20, 25 … 80, 85.
     The UI layer is a fixed 1920x1080 canvas (--ui-scale fits it to the window),
     which is why the share turns into pixels here and the stylesheet only ever
     sees --panel-w. 30% is 576px, the first stop of the full metrics (the stops
     below it are narrow), so that is the default.
     Five per cent and not a fourteenth of some other range: the top of the range
     is the 85% that was asked for and fifteen stops then leave fourteen steps, so
     the bottom is 85 - 14 * 5. A step that came out a fraction would put every
     stop between whole pixels and make ?width= unwriteable. */
  var MIN_WIDTH = 15;
  var MAX_WIDTH = 85;
  var WIDTH_STEP = 5;
  var DEF_WIDTH = 30;
  var LAYOUT_W = 1920;
  /* Under a third of the screen the pane is left with some 250px, where the
     metrics of a 1920 layout do not fit: the four lowest stops (15 to 30 per
     cent) get the tighter set of them through data-width="narrow" (see app.css). */
  var NARROW_WIDTH = 30;

  /* After how many idle seconds (no key, no pointer movement) the panel closes
     itself and leaves the app, so the picture underneath gets the remote back.
     The same short list as the dock's Auto-hide and no "never", for the same
     reason: an overlay must not be able to sit on the screen for good. app.js
     runs the timer. */
  var AUTOCLOSE_SEC = [5, 10, 20, 30, 60];
  var DEF_AUTOCLOSE_SEC = 30;
  /* What app.js reads back: the stored value, or a URL preview of it. Kept here
     and not on <html> because nothing in the CSS needs it. */
  var closeNow = { idleSec: DEF_AUTOCLOSE_SEC };
  /* Autostart as app.js reads it for a start the TV made (params.boot): null is
     the stored switch, a boolean is the ?openAtStart= preview of it. */
  var startNow = { openAtStart: null };

  /* How far the panel stands off the top and the bottom edge of the screen:
     nothing at all by default, up to half the screen each, in steps of two
     pixels. Pixels and not a share of the screen, because both insets answer an
     exact question — clearing the overscan of a TV, or a bar the app underneath
     draws — and a per cent of 1080 would land between whole pixels. Two of them
     per step for the same reason: the number that clears an overscan is whatever
     it is, and a coarser step would only ever get near it.
     The two together can ask for more than there is, so the panel keeps a floor:
     a panel of nothing would be nothing to put the setting back with. */
  var MIN_INSET = 0;
  var MAX_INSET = 540;
  var INSET_STEP = 2;
  var DEF_INSET = 0;
  var DEF_INSET_BOTTOM = 254;
  var LAYOUT_H = 1080;
  var MIN_PANEL_H = 400;
  /* The height at which the rail gives up its clock, its date and the labels of
     the icons: six sections at 116px plus those three bands ask for some 940px,
     and what is left of a panel this short belongs to the icons themselves. */
  var TIGHT_PANEL_H = 660;

  /* Clock of the rail. The option lists below show the current moment in each
     format instead of describing it, so "Time format — 14:05" is the setting and
     its own preview at once. */
  var TIME_FORMATS = ['24h', '24hn', '12h'];
  var DATE_FORMATS = ['wday', 'dmy', 'mdy', 'ymd', 'dmon', 'dmonwd', 'dm', 'wdaydm', 'wdaynum', 'dlong'];

  /* How large each band is drawn (the CSS scales its type by these): five steps, the
     middle one the size the rail always had. */
  var CLOCK_SIZES = ['xs', 's', 'm', 'l', 'xl'];
  var DEF_TIME_FORMAT = '24h';
  var DEF_DATE_FORMAT = 'wday';
  var DEF_CLOCK_SIZE = 'm';

  /* Both lists start with the option that shows nothing: the way to take the time or
     the date off the rail is to pick a format that is no format. It is worded Empty,
     as the empty choice of a list is everywhere else, since the other options are
     samples of themselves and it has none — an empty row left the row of the setting
     itself reading as nothing. It comes first, ahead of the formats, like the empty
     choice of any list of commands.

     A label function, so the word follows the language. */
  var CLOCK_OFF = 'off';

  function offOption() {
    return { value: CLOCK_OFF, label: function () { return t('value.empty'); } };
  }

  /* What may be stored, which is the formats plus that one. Kept apart from the
     lists themselves so formatOptions() never has to render a sample of it. */
  function clockChoices(formats) {
    return [CLOCK_OFF].concat(formats);
  }

  function two(n) { return (n < 10 ? '0' : '') + n; }

  function formatTime(date, format) {
    var hours = date.getHours();
    var text = two(date.getMinutes());
    /* 24hn: the 24-hour clock with no zero before a single digit, "9:05". */
    if (format === '24hn') return hours + ':' + text;
    if (format !== '12h') return two(hours) + ':' + text;
    /* AM/PM stays Latin: neither dictionary has a word for it that declines. */
    return ((hours % 12) || 12) + ':' + text + (hours < 12 ? ' AM' : ' PM');
  }

  function formatDate(date, format) {
    var day = date.getDate();
    var month = date.getMonth();
    var year = date.getFullYear();
    switch (format) {
      case 'mdy': return two(month + 1) + '/' + two(day) + '/' + year;
      case 'ymd': return year + '-' + two(month + 1) + '-' + two(day);
      /* One key holds all twelve names: a dozen keys apiece would be a dozen
         chances for the two dictionaries to drift apart. */
      case 'dmon': return day + ' ' + t('months.short').split(',')[month];
      /* The two with a weekday in them drop the year: the rail has one line for
         the date, and nobody reads the year off a clock. */
      case 'dmonwd': return day + ' ' + t('months.short').split(',')[month] +
                            ', ' + t('days.short').split(',')[date.getDay()];
      case 'wday': return t('days.long').split(',')[date.getDay()];
      case 'dm': return two(day) + '.' + two(month + 1);
      case 'wdaydm': return t('days.short').split(',')[date.getDay()] + ', ' + day + ' ' +
                            t('months.short').split(',')[month];
      case 'wdaynum': return t('days.short').split(',')[date.getDay()] + ' ' + two(day) + '.' + two(month + 1);
      /* The full name of the month, in the case a date asks for ("13 ноября"). */
      case 'dlong': return day + ' ' + t('months.long').split(',')[month];
      default: return two(day) + '.' + two(month + 1) + '.' + year;
    }
  }

  /* The label is a function, not a key: the sample has to follow the clock. */
  function formatOptions(formats, render) {
    var out = [];
    for (var i = 0; i < formats.length; i++) {
      out.push({ value: formats[i], label: sampleFn(formats[i], render) });
    }
    return out;
  }

  function sampleFn(format, render) {
    return function () { return render(new Date(), format); };
  }

  /* Formats forced by the URL debug params, so a screenshot or the smoke test can
     see the 12-hour clock without storing anything. */
  var clockPreview = { time: null, date: null };

  function previewClock(time, date) {
    if (clockChoices(TIME_FORMATS).indexOf(time) >= 0) clockPreview.time = time;
    if (clockChoices(DATE_FORMATS).indexOf(date) >= 0) clockPreview.date = date;
    /* ?time=off is a band that is not there rather than a band with nothing in
       it, and it is the CSS that takes it away: re-read the attributes now that
       the preview has changed what the two formats are. */
    applyClockLook();
  }

  /* The format the clock of the rail is written in, preview included. */
  function timeFormat() {
    return clockPreview.time || pick(clockChoices(TIME_FORMATS), 'appTimeFormat', DEF_TIME_FORMAT);
  }

  function dateFormat() {
    return clockPreview.date || pick(clockChoices(DATE_FORMATS), 'appDateFormat', DEF_DATE_FORMAT);
  }

  /* Empty when the format is the off end of the list: menu.js writes whatever
     comes back into the band, and the CSS takes the empty band away. */
  function timeText() {
    var format = timeFormat();
    return format === CLOCK_OFF ? '' : formatTime(new Date(), format);
  }

  function dateText() {
    var format = dateFormat();
    return format === CLOCK_OFF ? '' : formatDate(new Date(), format);
  }

  /* The size of one band of the clock: XS S M L XL, the same letters in every language.
     The band repaints at once, so the rail answers while the row is still under the
     finger. */
  function sizeItem(id, labelKey) {
    return {
      id: id,
      type: 'select',
      labelKey: labelKey,
      def: DEF_CLOCK_SIZE,
      options: CLOCK_SIZES.map(function (size) { return { value: size, label: size.toUpperCase() }; }),
      write: function (value, cb) {
        applyClockLook();
        window.Menu.paintClock();
        cb(true, { local: true });
      }
    };
  }

  /* What the row leading into the Theme level previews: the accent colour. */
  function themeSummary() {
    var name = window.Store.get('appAccent', DEF_ACCENT);
    var accent = ACCENTS.filter(function (item) { return item.value === name; })[0];
    return accent ? t(accent.labelKey) : '';
  }

  /* What the row leading into the clock level previews. Only the parts that are
     still on, so the separator does not show up on its own. */
  function clockSummary() {
    return [timeText(), dateText()].filter(function (part) { return !!part; }).join(' · ');
  }

  /* Stored choice, or the default format when it is something else. The default is
     named and not the first of the list: the first one is the empty choice. */
  function pick(formats, key, def) {
    var stored = window.Store.get(key, def);
    return formats.indexOf(stored) < 0 ? def : stored;
  }

  var sections = [
    {
      id: 'screen',
      icon: ICON.screen,
      titleKey: 'section.screen',
      shortKey: 'section.screen.short',
      subKey: 'section.screen.sub',
      items: [
        {
          id: 'energySaving',
          type: 'select',
          labelKey: 'screen.energySaving',
          hintKey: 'screen.energySaving.hint',
          def: 'auto',
          options: [
            { value: 'auto', labelKey: 'energy.auto' },
            { value: 'off', labelKey: 'energy.off' },
            { value: 'min', labelKey: 'energy.min' },
            { value: 'med', labelKey: 'energy.med' },
            { value: 'max', labelKey: 'energy.max' }
            /* The firmware also accepts 'screen_off' here, but blanking the
               panel is the separate action below, not a backlight level. */
          ],
          read: function (cb) { Luna.readSetting(PICTURE_CATEGORIES, 'energySaving', cb); },
          /* energySavingModified is what the system picture app reads to treat
             the level as user-set, so both menus show the same thing. */
          write: function (value, cb) {
            Luna.setSetting(PICTURE_CATEGORIES, 'energySaving', value, cb,
              { energySavingModified: 'true' });
          }
        },
        {
          id: 'screenOff',
          type: 'action',
          labelKey: 'screen.turnOff',
          hintKey: 'screen.turnOff.hint',
          run: function (api) {
            /* Screen off only blanks the panel: audio and the app keep running,
               so app.js turns it back on at the next key press.

               Order matters. The toast goes out first, because a notification
               raised after the panel is off wakes the backlight up again on
               some firmwares. Then setScreenOff() takes every surface of ours
               off screen and only after that does the call go out: while an
               overlay is still painted the firmware keeps the backlight on and
               the blanking shows up as a black picture on a lit panel. */
            api.toast(t('toast.screenOff'));
            setTimeout(function () {
              api.setScreenOff(true);
              Luna.turnOffScreen(function (ok, info) {
                if (ok) return;
                api.setScreenOff(false);
                api.report(ok, info);
              });
            }, TOAST_READ_MS);
          }
        }
      ]
    },

    {
      id: 'eco',
      offByDefault: true,
      icon: ICON.eco,
      titleKey: 'section.eco',
      shortKey: 'section.eco.short',
      subKey: 'section.eco.sub',
      items: [
        {
          id: 'ecoOff',
          type: 'action',
          labelKey: 'energy.off',
          run: function (api) {
            Luna.setSetting(PICTURE_CATEGORIES, 'energySaving', 'off', function (ok, info) {
              if (ok) {
                api.toast(t('toast.energySavingSet'));
              } else {
                api.report(ok, info);
              }
            }, { energySavingModified: 'true' });
          }
        },
        {
          id: 'ecoMin',
          type: 'action',
          labelKey: 'energy.min',
          run: function (api) {
            Luna.setSetting(PICTURE_CATEGORIES, 'energySaving', 'min', function (ok, info) {
              if (ok) {
                api.toast(t('toast.energySavingSet'));
              } else {
                api.report(ok, info);
              }
            }, { energySavingModified: 'true' });
          }
        },
        {
          id: 'ecoMed',
          type: 'action',
          labelKey: 'energy.med',
          run: function (api) {
            Luna.setSetting(PICTURE_CATEGORIES, 'energySaving', 'med', function (ok, info) {
              if (ok) {
                api.toast(t('toast.energySavingSet'));
              } else {
                api.report(ok, info);
              }
            }, { energySavingModified: 'true' });
          }
        },
        {
          id: 'ecoMax',
          type: 'action',
          labelKey: 'energy.max',
          run: function (api) {
            Luna.setSetting(PICTURE_CATEGORIES, 'energySaving', 'max', function (ok, info) {
              if (ok) {
                api.toast(t('toast.energySavingSet'));
              } else {
                api.report(ok, info);
              }
            }, { energySavingModified: 'true' });
          }
        },
        {
          id: 'ecoScreenOff',
          type: 'action',
          labelKey: 'screen.turnOff',
          hintKey: 'screen.turnOff.hint',
          run: function (api) {
            /* Screen off only blanks the panel: audio and the app keep running,
               so app.js turns it back on at the next key press.

               Order matters. The toast goes out first, because a notification
               raised after the panel is off wakes the backlight up again on
               some firmwares. Then setScreenOff() takes every surface of ours
               off screen and only after that does the call go out: while an
               overlay is still painted the firmware keeps the backlight on and
               the blanking shows up as a black picture on a lit panel. */
            api.toast(t('toast.screenOff'));
            setTimeout(function () {
              api.setScreenOff(true);
              Luna.turnOffScreen(function (ok, info) {
                if (ok) return;
                api.setScreenOff(false);
                api.report(ok, info);
              });
            }, TOAST_READ_MS);
          }
        }
      ]
    },

    {
      id: 'sound',
      icon: ICON.sound,
      titleKey: 'section.sound',
      shortKey: 'section.sound.short',
      subKey: 'section.sound.sub',
      items: [
        {
          id: 'soundOutput',
          type: 'select',
          labelKey: 'sound.output',
          hintKey: 'sound.output.hint',
          def: 'tv_speaker',
          options: [
            { value: 'external_arc', labelKey: 'output.arc' },
            { value: 'bt_soundbar', labelKey: 'output.bt' },
            { value: 'external_optical', labelKey: 'output.optical' },
            { value: 'tv_speaker', labelKey: 'output.tv' }
          ],
          read: function (cb) { Luna.readSetting(SOUND_CATEGORIES, 'soundOutput', cb); },
          write: function (value, cb) { Luna.setSetting(SOUND_CATEGORIES, 'soundOutput', value, cb); }
        },
        {
          id: 'btDevices',
          type: 'submenu',
          labelKey: 'sound.bt',
          hintKey: 'sound.bt.hint',
          sub: 'bt',
          status: function () { return btSummary(); }
        }
      ]
    },

    {
      id: 'bluetooth',
      offByDefault: true,
      icon: ICON.bluetooth,
      titleKey: 'section.bluetooth',
      shortKey: 'section.bluetooth.short',
      subKey: 'section.bluetooth.sub',
      items: [],
      load: function (api, announce) { loadBt(api, announce); }
    },

    {
      id: 'power',
      icon: ICON.power,
      titleKey: 'section.power',
      shortKey: 'section.power.short',
      subKey: 'section.power.sub',
      items: [
        {
          id: 'powerOff',
          type: 'action',
          labelKey: 'power.off',
          hintKey: 'power.off.hint',
          confirmKey: 'power.confirmOff',
          run: function (api) {
            api.busy(t('toast.poweringOff'));
            Luna.powerOff(function (ok, info) { if (!ok) api.report(ok, info); });
          }
        },
        {
          id: 'restart',
          type: 'action',
          labelKey: 'power.restart',
          hintKey: 'power.restart.hint',
          confirmKey: 'power.confirmRestart',
          /* The TV needs a few seconds before the picture goes away, so the
             balloon stays up until then; only a refusal replaces it. */
          run: function (api) {
            api.busy(t('toast.rebooting'));
            Luna.reboot(function (ok, info) { if (!ok) api.report(ok, info); });
          }
        }
      ]
    },

    /* Read-only: what the TV runs and what it runs on. Nothing here is a
       setting, so the section has no items to write — only info blocks that
       load() refreshes every time the section is entered. */
    {
      id: 'system',
      icon: ICON.system,
      titleKey: 'section.system',
      shortKey: 'section.system.short',
      subKey: 'section.system.sub',
      load: function (done) { loadSystem(done); },
      items: [
        { id: 'osGroup', type: 'group', labelKey: 'system.os' },
        { id: 'osInfo', type: 'info', render: function () { return osInfoHtml(); } },
        { id: 'deviceGroup', type: 'group', labelKey: 'system.device' },
        { id: 'deviceInfo', type: 'info', render: function () { return deviceInfoHtml(); } },
        { id: 'netGroup', type: 'group', labelKey: 'system.network' },
        { id: 'netInfo', type: 'info', render: function () { return netInfoHtml(); } },
        { id: 'storageGroup', type: 'group', labelKey: 'system.storage' },
        { id: 'storageInfo', type: 'info', render: function () { return storageInfoHtml(); } }
      ]
    },

    /* Off the rail on a fresh install (offByDefault): nothing here is a setting
       of the TV and nothing here is undone by a switch back — asking for root
       restarts the helper service as a privileged process, which is not an
       errand to stumble into. It has to be switched on in App properties ->
       Rail sections before it can be reached. */
    {
      id: 'tweaks',
      icon: ICON.tweaks,
      offByDefault: true,
      titleKey: 'section.tweaks',
      shortKey: 'section.tweaks.short',
      subKey: 'section.tweaks.sub',
      items: [
        { id: 'privGroup', type: 'group', labelKey: 'app.privileges' },
        {
          id: 'requestPriv',
          type: 'action',
          labelKey: 'app.requestPriv',
          hintKey: 'app.requestPriv.hint',
          /* The app already asks for root by itself at every start
             (autoElevate); this row is the manual retry. */
          run: function (api) {
            /* Elevation runs a script on the TV and restarts the service, which
               takes several seconds: the balloon stays until the answer. */
            api.busy(t('toast.privWait'));
            Luna.elevate(function (root, status) {
              if (status) device.service = status;
              /* Rebuild switch app ID items based on new root status. */
              buildSwitchAppIdItems();
              api.rerender();
              if (root) { api.toast(t('toast.privOk')); return; }
              if (status && status.mocked) { api.toast(t('toast.mock')); return; }
              api.toast(t('toast.privFail'));
            });
          }
        },
        { id: 'privInfo', type: 'info', render: function () { return privilegeInfoHtml(); } },

        { id: 'appIdGroup', type: 'group', labelKey: 'tweaks.appId' },
        {
          id: 'switchAppId',
          type: 'submenu',
          labelKey: 'tweaks.switchAppId',
          hintKey: 'tweaks.switchAppId.hint',
          sub: 'switchAppId',
          /* Show a warning if root is not available. */
          status: function () {
            return (device.service && device.service.root) ? '' : t('tweaks.needRoot');
          }
        },

        { id: 'lifecycleGroup', type: 'group', labelKey: 'tweaks.lifecycle' },
        {
          id: 'tweaksKeepAlive',
          type: 'submenu',
          labelKey: 'tweaks.keepAlive',
          hintKey: 'tweaks.keepAlive.hint',
          sub: 'keepalive',
          /* The init script is always on once the service is root, so "Init"
             follows the privileges and not a stored switch. */
          status: function () {
            var parts = [];
            if (window.Store && window.Store.get('keepaliveSelfService', true)) {
              parts.push('Service');
            }
            if (device.service && device.service.root) {
              parts.push('Init');
            }
            return parts.length ? parts.join(' + ') : '';
          }
        },
        {
          id: 'tweaksAppType',
          type: 'select',
          labelKey: 'tweaks.appType',
          hintKey: 'tweaks.appType.hint',
          def: 'popup',
          options: [
            { value: 'popup', labelKey: 'tweaks.appType.popup' },
            { value: 'overlay', labelKey: 'tweaks.appType.overlay' },
            { value: 'card', labelKey: 'tweaks.appType.card' },
            { value: 'minimal', labelKey: 'tweaks.appType.minimal.danger' },
            { value: 'home', labelKey: 'tweaks.appType.home.danger' },
            { value: 'system_ui', labelKey: 'tweaks.appType.system_ui.danger' }
          ],
          read: function (cb) {
            cb(window.Store.get('tweaksAppType', 'popup'));
          },
          write: function (v, cb) {
            window.Store.set('tweaksAppType', v);
            Luna.patchAppInfo(undefined, v, function (ok, info) {
              if (!ok) {
                cb(false, info);
                return;
              }
              window.Menu.toast(t('toast.appRestart'));
              cb(true, info);
            });
          },
          available: function () {
            var device = window.Platform.deviceInfo();
            return (device.service && device.service.root) ? '' : t('tweaks.needRoot');
          }
        }
      ]
    },

    {
      id: 'debug',
      icon: ICON.debug,
      offByDefault: true,
      titleKey: 'section.debug',
      shortKey: 'section.debug.short',
      subKey: 'section.debug.sub',
      items: [
        {
          id: 'appDebugDetails',
          type: 'submenu',
          labelKey: 'app.debugDetails',
          hintKey: 'app.debugDetails.hint',
          sub: 'debugDetails'
        },
        {
          id: 'runningApps',
          type: 'submenu',
          labelKey: 'apps.running',
          hintKey: 'apps.running.hint',
          sub: 'runningAppsView'
        },
        {
          id: 'userApps',
          type: 'submenu',
          labelKey: 'apps.user',
          hintKey: 'apps.user.hint',
          sub: 'userAppsView'
        },
        {
          id: 'systemApps',
          type: 'submenu',
          labelKey: 'apps.system',
          hintKey: 'apps.system.hint',
          sub: 'systemAppsView'
        },
        {
          id: 'launchPoints',
          type: 'submenu',
          labelKey: 'apps.launch',
          hintKey: 'apps.launch.hint',
          sub: 'launchPointsView'
        }
      ]
    },

    /* This section configures the utility itself, not the TV: the values live
       in localStorage and are applied by applyAppPrefs() at startup.
       pinBottom takes it to the foot of the rail, away from the sections that
       change the TV. */
    {
      id: 'app',
      icon: ICON.app,
      pinBottom: true,
      titleKey: 'section.app',
      shortKey: 'section.app.short',
      subKey: 'section.app.sub',
      items: [
        {
          id: 'appLanguage',
          type: 'select',
          labelKey: 'app.language',
          hintKey: 'app.language.hint',
          def: 'en',
          /* Language options are determined dynamically from loaded locale files.
             Enable/disable languages by commenting out <script> tags in index.html.
             Each option is labelled in its own language (lang.* keys), so the list
             can be read by someone who cannot yet read the panel. */
          options: (function () {
            var available = window.I18N.getAvailableLanguages();
            return available.map(function (lang) {
              return { value: lang, labelKey: 'lang.' + lang };
            });
          })(),
          write: function (value, cb) {
            if (applyLanguage()) window.Menu.relabel();
            cb(true, { local: true });
          }
        },
        /* The time and the date are two rows about one thing, the clock of the
           rail, so they went one level down together; the level comes right after
           the language, the first things a person looks for. The row shows what that
           clock reads right now, which is the shortest way to say what the two
           formats add up to. */
        {
          id: 'appClock',
          type: 'submenu',
          labelKey: 'app.clock',
          hintKey: 'app.clock.hint',
          sub: 'clock',
          /* Whichever of the two is still on, and the separator only when both
             are: with the clock and the date off the row has nothing to preview. */
          status: function () { return clockSummary(); }
        },
        /* The theme, the background, what is general to the app and the panel as an
           object are four levels of their own: this list used to be one long page of
           rows about different things. */
        {
          id: 'appThemeLevel',
          type: 'submenu',
          labelKey: 'app.theme',
          hintKey: 'app.theme.hint',
          sub: 'theme',
          status: function () { return themeSummary(); }
        },
        {
          id: 'appBackgroundLevel',
          type: 'submenu',
          labelKey: 'app.background',
          hintKey: 'app.background.hint',
          sub: 'bg'
        },
        {
          id: 'appGeneral',
          type: 'submenu',
          labelKey: 'app.general',
          hintKey: 'app.general.hint',
          sub: 'general'
        },
        {
          id: 'appPanel',
          type: 'submenu',
          labelKey: 'app.panel',
          hintKey: 'app.panel.hint',
          sub: 'panel'
        },
        /* Which sections the rail carries and in what order — one row per
           section, so the list belongs a level down. */
        {
          id: 'appWidgets',
          type: 'submenu',
          labelKey: 'app.widgets',
          hintKey: 'app.widgets.hint',
          sub: 'widgets'
        },
        /* Where the balloon lands takes two rows of its own, so they live one
           level down instead of stretching this list. */
        {
          id: 'appToasts',
          type: 'submenu',
          labelKey: 'app.toasts',
          hintKey: 'app.toasts.hint',
          sub: 'toasts'
        },

        /* Last of the rows that change something: everything above is one
           preference or a level of them, this is all of them at once. It stays out
           of the block below, which only reads things out. */
        {
          id: 'appReset',
          type: 'action',
          labelKey: 'app.reset',
          hintKey: 'app.reset.hint',
          confirmKey: 'app.confirmReset',
          run: function (api) { resetPrefs(api); }
        },

        { id: 'infoGroup', type: 'group', labelKey: 'app.info' },
        {
          id: 'aboutApp',
          type: 'submenu',
          labelKey: 'app.about',
          hintKey: 'app.about.hint',
          sub: 'about'
        }
      ]
    }
  ];

  /* Nested levels, reached from a `submenu` item instead of from the rail.
     `items` is rebuilt from live data, so it starts out empty. */
  var subsections = [
    {
      id: 'bt',
      parentId: 'sound',
      entryId: 'btDevices',
      titleKey: 'bt.title',
      subKey: 'bt.sub',
      items: [],
      load: function (api, announce) { loadBt(api, announce); }
    },
    /* The panel as an object on the screen: the picture behind it, how much of
       the video it lets through, how wide it is, which edge it stands on and how
       far it stands off the top and the bottom of that edge. They were rows of the
       section itself until the list of it grew past a screenful; the language, the
       theme and the accent stayed up there because they are about the whole app
       and not about this one panel. The insets are a level below this one again —
       two sliders of their own — which is as deep as the panel goes. */
    /* The levels of the properties of the app. Their rows keep the ids they had on the one
       long page, so a stored value is still read. */
    {
      id: 'theme',
      parentId: 'app',
      entryId: 'appThemeLevel',
      titleKey: 'theme.title',
      subKey: 'theme.sub',
      items: [
        /* Two switches instead of one list of palettes: the mode and the
           contrast are separate questions, and high contrast has a light and a
           dark side of its own. */
        {
          id: 'appDarkMode',
          type: 'toggle',
          labelKey: 'app.darkMode',
          hintKey: 'app.darkMode.hint',
          def: true,
          write: function (value, cb) {
            applyTheme();
            cb(true, { local: true });
          }
        },
        {
          id: 'appContrast',
          type: 'toggle',
          labelKey: 'app.contrast',
          hintKey: 'app.contrast.hint',
          def: false,
          write: function (value, cb) {
            applyTheme();
            cb(true, { local: true });
          }
        },
        {
          id: 'appAccent',
          type: 'select',
          labelKey: 'app.accent',
          hintKey: 'app.accent.hint',
          def: DEF_ACCENT,
          options: ACCENTS,
          write: function (value, cb) {
            applyAccent();
            cb(true, { local: true });
          }
        }
      ]
    },
    /* Pictures behind the two columns, and how much of the video the panel lets
       through. */
    {
      id: 'bg',
      parentId: 'app',
      entryId: 'appBackgroundLevel',
      titleKey: 'background.title',
      subKey: 'background.sub',
      items: [
        /* Pictures behind the two columns instead of the palette, one file per
           column per theme (see app.css). How solid they are is the whole setting,
           the bottom of a slider being no picture at all: a fresh install shows
           none, because the images that ship are the test pattern of
           tools/make_bg.py, which is there to be replaced rather than looked at.
           Above the transparency of the app for a reason: these are the opacity of
           the pictures inside the panel, that one is the panel over the video.

           One slider per column, because the two columns are not the same job:
           the rows are a page to read, the rail is a strip of icons with a lot of
           empty space in it, and a picture that is pleasant behind the icons is
           usually too much behind the text. Two sliders is also the only way to
           have a picture behind one column and the palette behind the other. */
        {
          id: 'appBg',
          type: 'slider',
          labelKey: 'app.bg',
          hintKey: 'app.bg.hint',
          def: DEF_BG,
          min: MIN_BG,
          max: MAX_BG,
          step: BG_STEP,
          write: function (value, cb) {
            applyBg();
            cb(true, { local: true });
          }
        },
        {
          id: 'appBgRail',
          type: 'slider',
          labelKey: 'app.bgRail',
          hintKey: 'app.bgRail.hint',
          def: DEF_BG,
          min: MIN_BG,
          max: MAX_BG,
          step: BG_STEP,
          write: function (value, cb) {
            applyBgRail();
            cb(true, { local: true });
          }
        },
        /* How much of the video shows through the whole panel: nothing at the left
           end of the slider and in a fresh install, up to seventy per cent. */
        {
          id: 'appTransparency',
          type: 'slider',
          labelKey: 'app.transparency',
          hintKey: 'app.transparency.hint',
          def: DEF_TRANSPARENCY,
          min: MIN_TRANSPARENCY,
          max: MAX_TRANSPARENCY,
          step: TRANSPARENCY_STEP,
          write: function (value, cb) {
            applyTransparency();
            cb(true, { local: true });
          }
        }
      ]
    },
    /* What is general to the app and not to the panel as an object: the start the TV
       makes by itself and the idle close. */
    {
      id: 'general',
      parentId: 'app',
      entryId: 'appGeneral',
      titleKey: 'general.title',
      subKey: 'general.sub',
      items: [
        /* Autostart: only the start the TV makes by itself (the keepalive init
           script launches the app at boot, see keepalive_daemon.sh). On, the
           panel opens then and leaves by Auto-close. Off, the app quits at once,
           so nothing stays in memory and the next launch (HOME, the launcher) is
           a cold one. A start the user makes is never affected. The init script
           stays in place either way. */
        {
          id: 'appOpenAtStart',
          type: 'toggle',
          labelKey: 'app.openAtStart',
          hintKey: 'app.openAtStart.hint',
          def: true,
          write: function (value, cb) { cb(true, { local: true }); }
        },
        /* Seconds without a key or pointer movement before the panel closes and
           the app is left, as Back does. */
        {
          id: 'appAutoClose',
          type: 'select',
          labelKey: 'app.autoClose',
          hintKey: 'app.autoClose.hint',
          def: String(DEF_AUTOCLOSE_SEC),
          options: AUTOCLOSE_SEC.map(function (n) { return { value: String(n), label: String(n) }; }),
          write: function (value, cb) {
            applyAutoClose();
            cb(true, { local: true });
          }
        }
      ]
    },
    /* The panel as an object on the screen: how wide it is, which edge it stands on and
       how far it stands off the top and the bottom of that edge. The insets are a level
       below this one again — two sliders of their own — which is as deep as the panel
       goes. */
    {
      id: 'panel',
      parentId: 'app',
      entryId: 'appPanel',
      titleKey: 'panel.title',
      subKey: 'panel.sub',
      items: [
        /* How much of the picture the panel covers, and then which edge it covers
           it from. */
        {
          id: 'appWidth',
          type: 'slider',
          labelKey: 'app.width',
          hintKey: 'app.width.hint',
          def: DEF_WIDTH,
          min: MIN_WIDTH,
          max: MAX_WIDTH,
          step: WIDTH_STEP,
          write: function (value, cb) {
            applyWidth();
            cb(true, { local: true });
          }
        },
        {
          id: 'appSide',
          type: 'toggle',
          labelKey: 'app.side',
          hintKey: 'app.side.hint',
          def: false,
          write: function (value, cb) {
            applySide();
            cb(true, { local: true });
          }
        },
        {
          id: 'appEffect',
          type: 'select',
          labelKey: 'app.effect',
          hintKey: 'app.effect.hint',
          def: DEF_PANEL_EFFECT,
          options: PANEL_EFFECTS,
          write: function (value, cb) {
            applyPanelEffect();
            cb(true, { local: true });
          }
        },
        /* Last of them, and the only one that is a level rather than a value:
           how much of the screen the panel leaves free above and below itself.
           Two sliders, so they sit a level down again, and the row itself carries
           the pair of pixel values — the one number a slider of its own never
           shows, and here the only way to tell 20 from 40 without measuring. */
        {
          id: 'appInsets',
          type: 'submenu',
          labelKey: 'app.insets',
          hintKey: 'app.insets.hint',
          sub: 'insets',
          status: function () {
            return t('app.insets.status')
              .replace('{top}', String(inset('appPadTop')))
              .replace('{bottom}', String(inset('appPadBottom')));
          }
        }
      ]
    },
    /* Where the notification balloon appears. Two questions — the edge and the
       side of it — which together are the six corners and centres of the screen.
       The panel itself owns one half, so pushing the balloon to the other half is
       the point of the level. Both rows are static, so `items` is the list. */
    {
      id: 'toasts',
      parentId: 'app',
      entryId: 'appToasts',
      titleKey: 'toasts.title',
      subKey: 'toasts.sub',
      items: [
        {
          id: 'appToastTop',
          type: 'toggle',
          labelKey: 'app.toastTop',
          hintKey: 'app.toastTop.hint',
          def: true,
          write: function (value, cb) {
            applyToast();
            /* Shown right away: the setting is about a thing that is normally
               only on screen for two seconds. */
            window.Menu.toast(t('toast.applied'));
            cb(true, { local: true });
          }
        },
        {
          id: 'appToastAlign',
          type: 'select',
          labelKey: 'app.toastAlign',
          hintKey: 'app.toastAlign.hint',
          def: 'center',
          options: [
            { value: 'left', labelKey: 'align.left' },
            { value: 'center', labelKey: 'align.center' },
            { value: 'right', labelKey: 'align.right' }
          ],
          write: function (value, cb) {
            applyToast();
            window.Menu.toast(t('toast.applied'));
            cb(true, { local: true });
          }
        }
      ]
    },
    /* The two ends of the panel. Sliders in pixels, and the fill of the track is
       the whole readout the way it is for the width: the panel itself moves as
       the value does, which says more than a number would. Both write the same
       pair through applyInsets(), because the floor of the panel is a question
       about the two of them together and not about either one. */
    {
      id: 'insets',
      parentId: 'panel',
      entryId: 'appInsets',
      titleKey: 'insets.title',
      subKey: 'insets.sub',
      items: [
        {
          id: 'appPadTop',
          type: 'slider',
          labelKey: 'app.padTop',
          hintKey: 'app.padTop.hint',
          def: DEF_INSET,
          min: MIN_INSET,
          max: MAX_INSET,
          step: INSET_STEP,
          write: function (value, cb) {
            applyInsets();
            cb(true, { local: true });
          }
        },
        {
          id: 'appPadBottom',
          type: 'slider',
          labelKey: 'app.padBottom',
          hintKey: 'app.padBottom.hint',
          def: 254,
          min: MIN_INSET,
          max: MAX_INSET,
          step: INSET_STEP,
          write: function (value, cb) {
            applyInsets();
            cb(true, { local: true });
          }
        }
      ]
    },
    /* The clock of the rail: the time above the icons and the date below them.
       Two selects, and every option in either list is the current moment written
       that way — the list is its own preview. */
    {
      id: 'clock',
      parentId: 'app',
      entryId: 'appClock',
      titleKey: 'clock.title',
      subKey: 'clock.sub',
      items: [
        {
          id: 'appTimeFormat',
          type: 'select',
          labelKey: 'app.timeFormat',
          hintKey: 'app.timeFormat.hint',
          def: DEF_TIME_FORMAT,
          options: [offOption()].concat(formatOptions(TIME_FORMATS, formatTime)),
          write: function (value, cb) {
            applyClockLook();
            window.Menu.paintClock();
            cb(true, { local: true });
          }
        },
        sizeItem('appClockSize', 'app.clockSize'),
        {
          id: 'appDateFormat',
          type: 'select',
          labelKey: 'app.dateFormat',
          hintKey: 'app.dateFormat.hint',
          def: DEF_DATE_FORMAT,
          options: [offOption()].concat(formatOptions(DATE_FORMATS, formatDate)),
          write: function (value, cb) {
            applyClockLook();
            window.Menu.paintClock();
            cb(true, { local: true });
          }
        },
        sizeItem('appDateSize', 'app.dateSize'),
        /* How the two bands are painted rather than what they say. All three
           switches are on in a fresh install: the clock and the date are written
           in the accent and in bold type, so they stand apart from the panel's
           own marks by weight and are easy to read from the sofa. Off gives the
           plain text colour back. */
        {
          id: 'appClockColour',
          type: 'toggle',
          labelKey: 'app.clockColour',
          hintKey: 'app.clockColour.hint',
          def: true,
          write: function (value, cb) {
            applyClockLook();
            cb(true, { local: true });
          }
        },
        {
          id: 'appDateColour',
          type: 'toggle',
          labelKey: 'app.dateColour',
          hintKey: 'app.dateColour.hint',
          def: true,
          write: function (value, cb) {
            applyClockLook();
            cb(true, { local: true });
          }
        },
        /* One switch for both bands, not two: the weight is what the pair of them
           looks like together, and a bold clock over a light date would only ever
           be a mistake somebody had to undo. */
        {
          id: 'appClockBold',
          type: 'toggle',
          labelKey: 'app.clockBold',
          hintKey: 'app.clockBold.hint',
          def: true,
          write: function (value, cb) {
            applyClockLook();
            cb(true, { local: true });
          }
        }
      ]
    },
    /* The order of the rail. One row per movable section, and the rows are
       rebuilt from the order itself, so `items` starts out empty. */
    {
      id: 'widgets',
      parentId: 'app',
      entryId: 'appWidgets',
      titleKey: 'widgets.title',
      subKey: 'widgets.sub',
      items: []
    },
    {
      id: 'switchAppId',
      parentId: 'tweaks',
      entryId: 'switchAppId',
      titleKey: 'tweaks.switchAppId.title',
      subKey: 'tweaks.switchAppId.sub',
      items: [],
      load: function (api, announce) {
        buildSwitchAppIdItems();
        if (announce) announce(false);
      }
    },
    {
      id: 'about',
      parentId: 'app',
      entryId: 'aboutApp',
      titleKey: 'about.title',
      subKey: 'about.sub',
      items: [],
      load: function (api) { loadAbout(api); }
    },
    {
      id: 'debugDetails',
      parentId: 'debug',
      entryId: 'appDebugDetails',
      titleKey: 'debug.title',
      subKey: 'debug.sub',
      items: [
        { id: 'debugInfo', type: 'info', render: function () { return debugInfoHtml(); } }
      ]
    },
    {
      id: 'runningAppsView',
      parentId: 'debug',
      entryId: 'runningApps',
      titleKey: 'apps.running.title',
      subKey: 'apps.running.sub',
      items: [],
      load: function (api) { loadRunningApps(api); }
    },
    {
      id: 'userAppsView',
      parentId: 'debug',
      entryId: 'userApps',
      titleKey: 'apps.user.title',
      subKey: 'apps.user.sub',
      items: [],
      load: function (api) { loadUserApps(api); }
    },
    {
      id: 'systemAppsView',
      parentId: 'debug',
      entryId: 'systemApps',
      titleKey: 'apps.system.title',
      subKey: 'apps.system.sub',
      items: [],
      load: function (api) { loadSystemApps(api); }
    },
    {
      id: 'launchPointsView',
      parentId: 'debug',
      entryId: 'launchPoints',
      titleKey: 'apps.launch.title',
      subKey: 'apps.launch.sub',
      items: [],
      load: function (api) { loadLaunchPoints(api); }
    },
    {
      id: 'keepalive',
      parentId: 'tweaks',
      entryId: 'tweaksKeepAlive',
      titleKey: 'tweaks.keepAlive',
      subKey: 'tweaks.keepAlive.sub',
      items: [
        {
          id: 'keepaliveSelfService',
          type: 'toggle',
          labelKey: 'tweaks.keepAlive.selfService',
          hintKey: 'tweaks.keepAlive.selfService.hint',
          def: true,
          read: function (cb) {
            Luna.selfKeepaliveStatus(function (status, info) {
              if (info.mocked) {
                cb(!!window.Store.get('keepaliveSelfService', true));
                return;
              }
              cb(status.enabled);
            });
          },
          write: function (value, cb) {
            if (value) {
              Luna.enableSelfKeepalive(function (success, info) {
                if (!success) {
                  var msg = info.error || 'Enable failed';
                  cb(false, { error: msg });
                  return;
                }
                window.Store.set('keepaliveSelfService', true);
                window.Menu.toast(t('toast.keepaliveSelfEnabled'));
                cb(true);
              });
            } else {
              Luna.disableSelfKeepalive(function (success, info) {
                if (!success) {
                  var msg = info.error || 'Disable failed';
                  cb(false, { error: msg });
                  return;
                }
                window.Store.set('keepaliveSelfService', false);
                window.Menu.toast(t('toast.keepaliveSelfDisabled'));
                cb(true);
              });
            }
          }
        }
      ]
    }
  ];

  /* ------------------------------------------------------------ indexing -- */
  var index = {};
  var sectionOf = {};

  /* Rebuilt whenever a level generates items (the Bluetooth device rows). */
  function reindex() {
    index = {};
    sectionOf = {};
    sections.concat(subsections).forEach(function (level) {
      level.items.forEach(function (item) {
        index[item.id] = item;
        sectionOf[item.id] = level.id;
      });
    });
  }

  function subsection(id) {
    for (var i = 0; i < subsections.length; i++) {
      if (subsections[i].id === id) return subsections[i];
    }
    return null;
  }

  reindex();

  /* ------------------------------------------------------------- values --- */
  function value(id) {
    var item = index[id];
    if (!item) return undefined;
    return window.Store.get(id, item.def);
  }

  /* Store locally, then push to the TV when the item knows how to. */
  function commit(id, newValue, cb) {
    var item = index[id];
    if (!item) return;
    window.Store.set(id, newValue);
    if (!item.write) {
      if (cb) cb(true, { mocked: !Luna.isAvailable(), error: null, local: true });
      return;
    }
    item.write(newValue, function (ok, info) {
      if (cb) cb(ok, info || {});
    });
  }

  /* Pull fresh values for one section; done() runs once, after the last read.
     A section may also carry load() of its own — that is how the read-only
     blocks (System) get their data, since they have no items to read. */
  function refresh(sectionId, done) {
    var section = null;
    for (var i = 0; i < sections.length; i++) {
      if (sections[i].id === sectionId) { section = sections[i]; break; }
    }
    if (!section) { if (done) done(false); return; }

    /* Collected before anything runs: a mocked luna call answers straight away,
       and a counter raised on the fly would reach zero after the first one. */
    var tasks = [];

    section.items.forEach(function (item) {
      if (!item.read) return;
      tasks.push(function (step) {
        item.read(function (remote) {
          var differs = remote !== null && typeof remote !== 'undefined' && remote !== value(item.id);
          if (differs) window.Store.set(item.id, remote);
          step(differs);
        });
      });
    });

    if (section.load) tasks.push(function (step) { section.load(step); });

    var pending = tasks.length;
    var changed = false;
    if (!pending) { if (done) done(false); return; }

    tasks.forEach(function (task) {
      task(function (didChange) {
        if (didChange) changed = true;
        pending--;
        if (pending === 0 && done) done(changed);
      });
    });
  }

  /* ------------------------------------------------------------- labels --- */
  function label(item) {
    return item.labelKey ? t(item.labelKey) : (item.label || '');
  }

  function hint(item) {
    return item.hintKey ? t(item.hintKey) : (item.hint || '');
  }

  /* A label may be a function when it has to be built fresh every render — the
     clock formats show the current time as their own sample. */
  function optionLabel(option) {
    if (typeof option.label === 'function') return option.label();
    return option.labelKey ? t(option.labelKey) : (option.label || String(option.value));
  }

  /* Sliders are absent on purpose: their row carries no text at all, the filled
     part of the track says where the value sits (see Menu.rowInner). */
  function formatValue(item) {
    var v = value(item.id);
    if (item.type === 'toggle') return v ? t('value.on') : t('value.off');
    if (item.type === 'select') {
      for (var i = 0; i < item.options.length; i++) {
        if (item.options[i].value === v) return optionLabel(item.options[i]);
      }
      return String(v);   // TV reported a value that is not in our list
    }
    return '';
  }

  /* ---------------------------------------------------------- bluetooth --- */
  /* Refresh on top, one row per trusted device below it. Pairing stays in the
     TV settings, so a row only connects or disconnects the audio profile. */
  var bt = { devices: null, adapter: null, loading: false, failed: false };

  /* Runtime data for app manager debug views. */
  var runningAppsData = { loading: false, failed: false, data: [] };
  var userAppsData = { loading: false, failed: false, data: [] };
  var systemAppsData = { loading: false, failed: false, data: [] };
  var launchPointsData = { loading: false, failed: false, data: [] };

  /* Device names come from the TV, so they are escaped before reaching innerHTML. */
  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* Format a value (primitive, array, or object) with proper indentation for nested
     structures. Returns an HTML string with YAML-like formatting. */
  function formatDebugValue(value, indent) {
    indent = indent || 0;
    var spacing = new Array(indent * 4 + 1).join('&nbsp;');

    if (value === null || value === undefined) {
      return '<span style="color: #999">null</span>';
    }

    if (typeof value === 'boolean') {
      return '<span style="color: #0a0">' + value + '</span>';
    }

    if (typeof value === 'number') {
      return '<span style="color: #09f">' + value + '</span>';
    }

    if (typeof value === 'string') {
      return escapeHtml(value);
    }

    if (Array.isArray(value)) {
      if (value.length === 0) return '<span style="color: #999">[]</span>';

      var items = value.map(function (item, idx) {
        return '<div>' + spacing + '&nbsp;&nbsp;[' + idx + ']: ' +
               formatDebugValue(item, indent + 1) + '</div>';
      });
      return items.join('');
    }

    if (typeof value === 'object') {
      var keys = Object.keys(value);
      if (keys.length === 0) return '<span style="color: #999">{}</span>';

      var props = keys.map(function (key) {
        return '<div>' + spacing + '&nbsp;&nbsp;<b>' + escapeHtml(key) +
               ':</b> ' + formatDebugValue(value[key], indent + 1) + '</div>';
      });
      return props.join('');
    }

    return escapeHtml(String(value));
  }

  /* Format an array of objects with blank line separation between items. Each object's
     properties are displayed in YAML-like indented format. */
  function formatObjectList(objects, headerKey) {
    if (!objects || objects.length === 0) {
      return '<div style="padding: 10px 0; color: #999">' +
             t(headerKey + '.empty') + '</div>';
    }

    return objects.map(function (obj, idx) {
      var header = '<div style="margin-top: ' + (idx > 0 ? '15' : '0') +
                   'px; margin-bottom: 5px; font-weight: bold; color: #09f">' +
                   (obj.id || obj.launchPointId || 'Item ' + (idx + 1)) +
                   '</div>';
      return header + '<div>' + formatDebugValue(obj, 1) + '</div>';
    }).join('');
  }

  function runningAppsHtml() {
    if (runningAppsData.loading) {
      return '<div style="padding: 10px 0">' + t('apps.running.loading') + '</div>';
    }
    if (runningAppsData.failed) {
      return '<div style="padding: 10px 0; color: #f33">' + t('apps.running.failed') + '</div>';
    }
    return formatObjectList(runningAppsData.data, 'apps.running');
  }

  function userAppsHtml() {
    if (userAppsData.loading) {
      return '<div style="padding: 10px 0">' + t('apps.user.loading') + '</div>';
    }
    if (userAppsData.failed) {
      return '<div style="padding: 10px 0; color: #f33">' + t('apps.user.failed') + '</div>';
    }
    return formatObjectList(userAppsData.data, 'apps.user');
  }

  function systemAppsHtml() {
    if (systemAppsData.loading) {
      return '<div style="padding: 10px 0">' + t('apps.system.loading') + '</div>';
    }
    if (systemAppsData.failed) {
      return '<div style="padding: 10px 0; color: #f33">' + t('apps.system.failed') + '</div>';
    }
    return formatObjectList(systemAppsData.data, 'apps.system');
  }

  function launchPointsHtml() {
    if (launchPointsData.loading) {
      return '<div style="padding: 10px 0">' + t('apps.launch.loading') + '</div>';
    }
    if (launchPointsData.failed) {
      return '<div style="padding: 10px 0; color: #f33">' + t('apps.launch.failed') + '</div>';
    }
    return formatObjectList(launchPointsData.data, 'apps.launch');
  }

  function connectedCount() {
    var list = bt.devices || [];
    var n = 0;
    for (var i = 0; i < list.length; i++) if (list[i].connected) n++;
    return n;
  }

  /* Value shown on the "Bluetooth devices" row of the Sound section. */
  function btSummary() {
    if (!bt.devices) return '';                    // not polled yet
    var list = bt.devices;
    for (var i = 0; i < list.length; i++) {
      if (list[i].connected) return deviceName(list[i], i);
    }
    return list.length ? t('value.btNone') : '';
  }

  function deviceName(device, position) {
    return device.name ? device.name : t('bt.unnamed') + ' ' + (position + 1);
  }

  function deviceItem(device, position) {
    var connected = device.connected;
    return {
      id: 'btDev:' + device.address,
      type: 'action',
      label: escapeHtml(deviceName(device, position)),
      status: t(connected ? 'bt.connected' : 'bt.paired'),
      statusOn: connected,
      hint: t(connected ? 'bt.hint.disconnect' : 'bt.hint.connect'),
      run: function (api) { toggleDevice(api, device); }
    };
  }

  function btAdapterHtml() {
    var state = t('value.btUnknown');
    if (bt.adapter) state = bt.adapter.powered ? t('value.btOn') : t('value.btOff');
    var total = (bt.devices || []).length;
    return infoHtml([
      [t('info.btAdapter'), state],
      [t('info.btDevices'), t('value.btCount')
        .replace('{n}', String(total)).replace('{c}', String(connectedCount()))]
    ]);
  }

  function buildBtItems() {
    var items = [{
      id: 'btRefresh',
      type: 'action',
      labelKey: 'bt.refresh',
      hintKey: 'bt.refresh.hint',
      run: function (api) { loadBt(api, true); }
    }];

    items.push({ id: 'btGroup', type: 'group', labelKey: 'bt.devices' });

    var devices = bt.devices || [];
    if (bt.loading && !bt.devices) {
      items.push({ id: 'btLoading', type: 'info', render: function () { return infoHtml([[t('bt.devices'), t('bt.loading')]]); } });
    } else if (bt.failed) {
      items.push({ id: 'btFailed', type: 'info', render: function () { return '<div>' + t('bt.failed') + '</div>'; } });
    } else if (!devices.length) {
      items.push({ id: 'btEmpty', type: 'info', render: function () { return '<div>' + t('bt.empty') + '</div>'; } });
    } else {
      devices.forEach(function (device, position) { items.push(deviceItem(device, position)); });
    }

    items.push({ id: 'btAdapterInfo', type: 'info', render: function () { return btAdapterHtml(); } });

    /* Update items for both bluetooth section and bt subsection (from sound) */
    var bluetoothSection = sections.find(function (s) { return s.id === 'bluetooth'; });
    if (bluetoothSection) {
      bluetoothSection.items = items;
    }

    subsection('bt').items = items;
    reindex();
  }

  /* Poll the adapter, then the trusted devices; announce=true adds the toast a
     manual refresh deserves. */
  function loadBt(api, announce) {
    bt.loading = true;
    bt.failed = false;
    buildBtItems();
    if (api) api.rerender();

    Luna.btAdapter(function (adapter) {
      bt.adapter = adapter;
      Luna.btDevices(function (devices, info) {
        bt.loading = false;
        bt.failed = !devices;
        bt.devices = devices || [];
        bt.mocked = !!(info && info.mocked);
        buildBtItems();
        if (api) api.rerender();
        if (announce && api) announceBt(api);
      });
    });
  }

  function announceBt(api) {
    if (bt.failed) { api.toast(t('toast.btFailed')); return; }
    if (!bt.devices.length) { api.toast(t('toast.btNone')); return; }
    api.toast(t('toast.btUpdated') + ': ' + t('value.btCount')
      .replace('{n}', String(bt.devices.length))
      .replace('{c}', String(connectedCount())));
  }

  /* A connected device disconnects, any other one connects. The reply is not
     the new state, so the list is polled again either way. */
  function toggleDevice(api, device) {
    var connect = !device.connected;
    api.toast(t(connect ? 'toast.btConnecting' : 'toast.btDisconnecting'));
    var request = connect ? Luna.btConnect : Luna.btDisconnect;
    request(device.address, function (ok, info) {
      if (!ok) api.report(ok, info);
      loadBt(api, false);
    });
  }

  buildBtItems();

  /* ------------------------------------------------- app manager debug views -- */

  function buildRunningAppsItems() {
    var items = [
      {
        id: 'runningAppsRefresh',
        type: 'action',
        labelKey: 'apps.refresh',
        hintKey: 'apps.refresh.hint',
        run: function (api) { loadRunningApps(api, true); }
      },
      {
        id: 'runningAppsInfo',
        type: 'info',
        render: function () { return runningAppsHtml(); }
      }
    ];

    subsection('runningAppsView').items = items;
    reindex();
  }

  function loadRunningApps(api, announce) {
    runningAppsData.loading = true;
    runningAppsData.failed = false;
    buildRunningAppsItems();
    if (api) api.rerender();

    Luna.runningApps(function (apps) {
      runningAppsData.loading = false;
      runningAppsData.failed = (apps === null);
      runningAppsData.data = apps || [];
      buildRunningAppsItems();
      if (api) api.rerender();
      if (announce && api) api.toast(t('apps.running.refreshed'));
    });
  }

  function buildUserAppsItems() {
    var items = [
      {
        id: 'userAppsRefresh',
        type: 'action',
        labelKey: 'apps.refresh',
        hintKey: 'apps.refresh.hint',
        run: function (api) { loadUserApps(api, true); }
      },
      {
        id: 'userAppsInfo',
        type: 'info',
        render: function () { return userAppsHtml(); }
      }
    ];

    subsection('userAppsView').items = items;
    reindex();
  }

  function loadUserApps(api, announce) {
    userAppsData.loading = true;
    userAppsData.failed = false;
    buildUserAppsItems();
    if (api) api.rerender();

    Luna.listApps(function (apps) {
      userAppsData.loading = false;
      userAppsData.failed = (apps === null);

      if (apps) {
        userAppsData.data = apps.filter(function (app) {
          return app.systemApp === false;
        });
      } else {
        userAppsData.data = [];
      }

      buildUserAppsItems();
      if (api) api.rerender();
      if (announce && api) api.toast(t('apps.user.refreshed'));
    });
  }

  function buildSystemAppsItems() {
    var items = [
      {
        id: 'systemAppsRefresh',
        type: 'action',
        labelKey: 'apps.refresh',
        hintKey: 'apps.refresh.hint',
        run: function (api) { loadSystemApps(api, true); }
      },
      {
        id: 'systemAppsInfo',
        type: 'info',
        render: function () { return systemAppsHtml(); }
      }
    ];

    subsection('systemAppsView').items = items;
    reindex();
  }

  function loadSystemApps(api, announce) {
    systemAppsData.loading = true;
    systemAppsData.failed = false;
    buildSystemAppsItems();
    if (api) api.rerender();

    Luna.listApps(function (apps) {
      systemAppsData.loading = false;
      systemAppsData.failed = (apps === null);

      if (apps) {
        systemAppsData.data = apps.filter(function (app) {
          return app.systemApp === true;
        });
      } else {
        systemAppsData.data = [];
      }

      buildSystemAppsItems();
      if (api) api.rerender();
      if (announce && api) api.toast(t('apps.system.refreshed'));
    });
  }

  function buildLaunchPointsItems() {
    var items = [
      {
        id: 'launchPointsRefresh',
        type: 'action',
        labelKey: 'apps.refresh',
        hintKey: 'apps.refresh.hint',
        run: function (api) { loadLaunchPoints(api, true); }
      },
      {
        id: 'launchPointsInfo',
        type: 'info',
        render: function () { return launchPointsHtml(); }
      }
    ];

    subsection('launchPointsView').items = items;
    reindex();
  }

  function loadLaunchPoints(api, announce) {
    launchPointsData.loading = true;
    launchPointsData.failed = false;
    buildLaunchPointsItems();
    if (api) api.rerender();

    Luna.listLaunchPoints(function (points) {
      launchPointsData.loading = false;
      launchPointsData.failed = (points === null);
      launchPointsData.data = points || [];
      buildLaunchPointsItems();
      if (api) api.rerender();
      if (announce && api) api.toast(t('apps.launch.refreshed'));
    });
  }

  /* --------------------------------------------------------- device info -- */
  var device = { model: null, firmware: null, service: null };

  /* Filled by loadSystem() when the System section is entered. `uptimeAt` is the
     moment the counter was read, so the value shown stays honest between two
     reads instead of freezing at the number the TV reported. */
  var system = {
    os: null, uptime: null, uptimeAt: 0,
    serial: null, net: null, macs: null, btMac: null, storage: null
  };

  var DASH = '—';

  function or(text) { return text || DASH; }

  /* Track app start time for debug info. */
  var appStartTime = Date.now();

  /* Format duration in human-readable units (ms/sec/min/hr/day). */
  function formatDuration(ms) {
    if (ms < 1000) return ms + ' ms';
    var sec = Math.floor(ms / 1000);
    if (sec < 60) return sec + ' sec';
    var min = Math.floor(sec / 60);
    if (min < 60) return min + ' min ' + (sec % 60) + ' sec';
    var hrs = Math.floor(min / 60);
    if (hrs < 24) return hrs + ' hr ' + (min % 60) + ' min';
    var days = Math.floor(hrs / 24);
    return days + ' day ' + (hrs % 24) + ' hr';
  }

  /* Debug information: app and service uptime. */
  function debugInfoHtml() {
    var now = Date.now();
    var appUptime = now - appStartTime;

    var rows = [
      [t('debug.appStart'), new Date(appStartTime).toLocaleString()],
      [t('debug.appUptime'), formatDuration(appUptime)]
    ];

    /* Service uptime if available. */
    if (device.service && device.service.startTime) {
      var svcUptime = now - device.service.startTime;
      rows.push([t('debug.serviceStart'), new Date(device.service.startTime).toLocaleString()]);
      rows.push([t('debug.serviceUptime'), formatDuration(svcUptime)]);
    } else if (device.service && device.service.running) {
      rows.push([t('debug.serviceStatus'), t('value.svcUp')]);
      rows.push([t('debug.serviceUptime'), t('value.unknown')]);
    } else {
      rows.push([t('debug.serviceStatus'), t('value.svcDown')]);
    }

    return infoHtml(rows);
  }

  /* How the privileged actions will be executed, as reported by the helper. */
  function privilegeLabel() {
    if (!window.Platform.isWebOS) return t('value.privNone');
    if (!device.service) return t('value.privUnknown');
    if (!device.service.running) return t('value.privNoService');
    return device.service.root ? t('value.privRoot') : t('value.privLimited');
  }

  function infoHtml(rows) {
    return rows.map(function (row) {
      return '<div><b>' + row[0] + ':</b> ' + row[1] + '</div>';
    }).join('');
  }

  /* Shown in the App properties section, next to "Request privileges". */
  function privilegeInfoHtml() {
    var running = !!(device.service && device.service.running);
    return infoHtml([
      [t('info.service'), running ? t('value.svcUp') : t('value.svcDown')],
      [t('info.privileges'), privilegeLabel()]
    ]);
  }

  /* Hardware only. The state of the helper service and what it may do belongs to
     the section that can act on it (App properties -> Request privileges), and
     repeating it here said the same thing twice. */
  function deviceInfoHtml() {
    var d = window.Platform.deviceInfo();
    return infoHtml([
      [t('info.model'), or(device.model || d.modelName)],
      [t('info.serial'), or(system.serial)],
      [t('info.firmware'), or(device.firmware || d.firmwareVersion)],
      [t('info.resolution'), d.screenWidth + '×' + d.screenHeight + (d.uhd ? ' (UHD)' : '')]
    ]);
  }

  /* Everything about the operating system itself. In a desktop browser there is
     nobody to ask, so the rows stay at "—" and only the platform row is real. */
  function osInfoHtml() {
    var os = system.os || {};
    return infoHtml([
      [t('info.platform'), window.Platform.isWebOS ? 'webOS TV' : t('info.browser')],
      [t('info.os'), or(os.name)],
      [t('info.osRelease'), or(os.release)],
      [t('info.osBuild'), or(os.build)],
      [t('info.kernel'), or(os.kernel)],
      [t('info.uptime'), formatUptime(currentUptime())]
    ]);
  }

  /* Both links, their addresses and every hardware address the TV admits to.
     The state line carries the network name too when there is one, so a
     connected Wi-Fi says which network it is on without a row of its own. */
  function netInfoHtml() {
    var net = system.net || {};
    var macs = system.macs || {};
    return infoHtml([
      [t('info.wifi'), linkState(net.wifi)],
      [t('info.wifiIp'), or(net.wifi && net.wifi.address)],
      [t('info.wifiMac'), or(macAddress(macs.wifi))],
      [t('info.ethernet'), linkState(net.wired)],
      [t('info.ethernetIp'), or(net.wired && net.wired.address)],
      [t('info.ethernetMac'), or(macAddress(macs.wired))],
      [t('info.btMac'), or(macAddress(system.btMac))]
    ]);
  }

  /* What is left where the apps live. The figures come from df(1) as text (see
     Luna.storage), and only the line about /mnt/lg/appstore is of interest: the header is
     skipped and everything else df printed with it too.

     Counted from the end and not from the start, because busybox breaks a long
     device name onto a line of its own and the columns then begin where the
     name would have been. The last five are always size, used, available, the
     percentage and the mount point. */
  function parseStorage(text) {
    var out = null;
    String(text).split(/[\r\n]+/).forEach(function (line) {
      var parts = line.replace(/^\s+|\s+$/g, '').split(/\s+/);
      if (parts.length < 5) return;
      var tail = parts.slice(-5);
      // The header ends in "Mounted on", which is where the mount point is.
      if (tail[4].charAt(0) !== '/') return;
      out = { size: tail[0], used: tail[1], free: tail[2], percent: tail[3], mount: tail[4] };
    });
    return out;
  }

  function storageInfoHtml() {
    var st = system.storage;
    return infoHtml([
      [t('info.storageMount'), escapeHtml(st ? st.mount : '/mnt/lg/appstore')],
      [t('info.storageSize'), or(st && escapeHtml(st.size))],
      [t('info.storageUsed'), st ? escapeHtml(st.used + ' (' + st.percent + ')') : DASH],
      [t('info.storageFree'), or(st && escapeHtml(st.free))]
    ]);
  }

  /* "connected · Home network", or just the state when the link has no name. */
  function linkState(link) {
    if (!link) return DASH;
    var state = t(link.connected ? 'value.netUp' : 'value.netDown');
    if (!link.connected || !link.ssid) return state;
    return state + ' · ' + escapeHtml(link.ssid);
  }

  /* Upper case reads better across the room, and the value comes from a service
     that may spell it either way. */
  function macAddress(text) {
    return text ? String(text).toUpperCase() : null;
  }

  /* Seconds since boot as of now: what was read, plus the time since. */
  function currentUptime() {
    if (system.uptime === null) return null;
    return system.uptime + (Date.now() - system.uptimeAt) / 1000;
  }

  /* "3 d 4 h 12 min" — the seconds are dropped, they would only flicker. */
  function formatUptime(seconds) {
    if (typeof seconds !== 'number' || !isFinite(seconds) || seconds < 0) return DASH;
    var total = Math.floor(seconds);
    var days = Math.floor(total / 86400);
    var hours = Math.floor((total % 86400) / 3600);
    var minutes = Math.floor((total % 3600) / 60);
    var parts = [];
    if (days) parts.push(days + ' ' + t('unit.day'));
    if (days || hours) parts.push(hours + ' ' + t('unit.hour'));
    parts.push(minutes + ' ' + t('unit.min'));
    return parts.join(' ');
  }

  /* Called by the System section itself: done(changed) repaints the blocks.
     Uptime always moves, so a successful read always counts as a change. */
  function loadSystem(done) {
    var pending = 7;
    var changed = false;

    function step() { pending--; if (!pending && done) done(changed); }

    Luna.osInfo(function (os) {
      if (os) { system.os = os; changed = true; }
      step();
    });

    /* Its own read, and not part of the model/firmware one: some firmwares
       refuse this single key, and asking for it together would cost the rest. */
    Luna.serial(function (text) {
      if (text) { system.serial = text; changed = true; }
      step();
    });

    Luna.uptime(function (seconds) {
      if (typeof seconds === 'number' && isFinite(seconds)) {
        system.uptime = seconds;
        system.uptimeAt = Date.now();
        changed = true;
      }
      step();
    });

    /* Three reads for the network block: the state of the links, the addresses
       of their hardware, and the Bluetooth adapter — a service of its own, and
       the only place its address can be had. */
    Luna.netStatus(function (net) {
      if (net) { system.net = net; changed = true; }
      step();
    });

    Luna.netMacs(function (macs) {
      if (macs) { system.macs = macs; changed = true; }
      step();
    });

    Luna.btAdapter(function (adapter) {
      if (adapter && adapter.address) { system.btMac = adapter.address; changed = true; }
      step();
    });

    /* A shell command and not a service call, so it only answers on a TV; a
       browser keeps the dashes. */
    Luna.storage(function (text) {
      var st = text ? parseStorage(text) : null;
      if (st) { system.storage = st; changed = true; }
      step();
    });
  }

  /* -------------------------------------------------------------- about ---- */
  /* The text of the About level is not in the code: about.html is a plain HTML
     fragment packaged with the app, so the author, the project links and the
     community can be edited without touching JavaScript. The version comes from
     appinfo.json, the same file the TV reads. */
  var about = { html: null, version: null, loading: false, failed: false };

  function aboutHeadHtml() {
    return infoHtml([
      [t('info.app'), t('app.title')],
      [t('info.version'), or(about.version)]
    ]);
  }

  function buildAboutItems() {
    var items = [{ id: 'aboutHead', type: 'info', render: function () { return aboutHeadHtml(); } }];

    if (about.html) {
      items.push({
        id: 'aboutText',
        type: 'info',
        /* Our own packaged file, so it goes in as markup on purpose. */
        render: function () { return '<div class="about">' + about.html + '</div>'; }
      });
    } else if (about.loading) {
      items.push({ id: 'aboutLoading', type: 'info', render: function () { return '<div>' + t('about.loading') + '</div>'; } });
    } else if (about.failed) {
      items.push({ id: 'aboutFailed', type: 'info', render: function () { return '<div>' + t('about.failed') + '</div>'; } });
    }

    subsection('about').items = items;
    reindex();
  }

  /* Read once and kept: the file cannot change while the app runs. */
  function loadAbout(api) {
    if (about.loading || about.html || about.failed) return;
    about.loading = true;
    buildAboutItems();
    if (api) api.rerender();

    var pending = 3;
    var htmlText = null;
    var appId = null;
    function step() {
      pending--;
      if (pending) return;
      /* {APP_ID} in the text stands for the ID the app runs under (it changes
         when the app is installed under another ID). The default is the ID the
         package ships with. */
      about.html = htmlText ? htmlText.split('{APP_ID}').join(appId || 'webocu.settings') : htmlText;
      about.loading = false;
      about.failed = !about.html;
      if (about.failed) console.warn('[webocu-settings] about.html could not be read');
      buildAboutItems();
      if (api) api.rerender();
    }

    window.Platform.loadText('about.html', function (text) {
      htmlText = text ? String(text) : null;
      step();
    });
    window.Platform.appInfo(function (info) {
      about.version = (info && info.version) || null;
      step();
    });
    window.Platform.getAppId(function (id) {
      appId = id;
      step();
    });
  }

  buildAboutItems();

  /* ---------------------------------------------------------- switch app ID -- */
  /* Get current app ID. */
  function getCurrentAppId() {
    /* Try to read from PalmSystem first, fallback to default. */
    var sys = window.webOSSystem || window.PalmSystem || null;
    if (sys && sys.identifier) {
      return String(sys.identifier);
    }
    return 'webocu.settings';
  }

  /* Proceed with app ID switch after removal check. */
  function proceedWithSwitch(api, appId) {
    api.busy(t('toast.switchingAppId'));
    Luna.switchAppId(appId, function (ok, info) {
      if (ok) {
        console.log('[switch-app-id] Switch succeeded');
        api.toast(t('toast.appIdSwitchedRebootNeeded'));
      } else {
        api.toast(t('toast.appIdFailed'));
        if (info && info.output) console.warn('[webocu-settings] switch-app-id output:', info.output);
      }
    });
  }

  function buildSwitchAppIdItems() {
    var items = [];

    /* Show warning info if root is not available. */
    if (!device.service || !device.service.root) {
      items.push({
        id: 'switchIdWarning',
        type: 'info',
        render: function () {
          return '<div>' + t('tweaks.switchAppId.needRoot') + '</div>';
        }
      });
    }

    /* App names are brands, not translatable UI strings. */
    var ids = [
      { id: 'webocu.settings', label: 'WebOCU Settings' },
      { id: 'amazon', label: 'Amazon Prime Video' },
      { id: 'netflix', label: 'Netflix' },
      { id: 'ivi', label: 'ivi' },
      { id: 'yota.play', label: 'Okko' },
      { id: 'com.685631.3411', label: 'Kinopoisk' },
      { id: 'com.huawei.app.webos.mts.tv.production', label: 'KION' },
      { id: 'vkvideo', label: 'VK Video' }
    ];

    var currentAppId = getCurrentAppId();

    if (device.service && device.service.root) {
      /* Select list of app IDs. */
      items.push({
        id: 'appIdSelect',
        type: 'select',
        labelKey: 'tweaks.appId',
        def: currentAppId,
        options: ids.map(function (entry) {
          return { value: entry.id, label: entry.label };
        }),
        write: function (selectedId, cb) {
          /* Store selection locally only. */
          cb(true, { local: true });
        }
      });

      /* Apply button. */
      items.push({
        id: 'appIdApply',
        type: 'action',
        labelKey: 'tweaks.applyAppId',
        run: function (api) {
          var selectedId = value('appIdSelect') || currentAppId;
          console.log('[switch-app-id] Apply clicked, selectedId=' + selectedId + ', currentAppId=' + currentAppId);

          /* Check if trying to switch to the current ID. */
          if (selectedId === currentAppId) {
            console.log('[switch-app-id] Same ID selected, showing toast');
            api.toast(t('toast.appIdAlreadyCurrent'));
            return;
          }

          /* Show brief notification (checkAppExists takes 3-10s, toast will auto-hide). */
          api.toast(t('toast.checkingApp'));

          console.log('[switch-app-id] Calling checkAppExists for "' + selectedId + '"');
          /* First, check if an app with this ID already exists. */
          Luna.checkAppExists(selectedId, function (exists, appInfo) {
            console.log('[switch-app-id] checkAppExists result: exists=' + exists +
                        ', appInfo=' + (appInfo ? JSON.stringify(appInfo) : 'null'));
            if (exists) {
              /* App exists — show warning, user must remove it manually. */
              console.log('[switch-app-id] App exists, showing warning');
              api.toast(t('toast.appExistsRemoveManually'));
            } else {
              /* App doesn't exist, ask for confirmation to switch. */
              console.log('[switch-app-id] App does not exist, asking for confirmation');
              Dialog.show(t('tweaks.confirmSwitchAppId', { id: selectedId }), function () {
                /* armed by the user — confirmation shown. */
                proceedWithSwitch(api, selectedId);
              }, function () {
                console.log('[switch-app-id] User cancelled switch');
              });
            }
          });
        }
      });
    } else {
      /* Show as read-only list when root is not available. */
      ids.forEach(function (entry) {
        var isCurrent = entry.id === currentAppId;
        var entryLabel = entry.label;
        var checkmark = isCurrent ? ' ✓' : '';
        items.push({
          id: 'switchTo_' + entry.id.replace(/\./g, '_') + '_disabled',
          type: 'info',
          render: function () {
            return '<div>' + entryLabel + checkmark + '</div>';
          }
        });
      });
    }

    subsection('switchAppId').items = items;
    reindex();
  }

  buildSwitchAppIdItems();


  /* ------------------------------------------------------------ widgets --- */
  /* The order of the rail is a setting of its own: "appWidgets" holds the ids of
     the movable sections, in the order the user put them, as one comma-separated
     string. Everything pinned to the foot of the rail is out of the game — the
     App properties section is the way back into this very list, so it stays
     where it is and is only reported in the level, not offered as a row.

     The built-in order is the fallback and the tie-breaker: a stored list that
     mentions an id twice, misses one, or names a section this build does not
     have is repaired rather than refused. */
  var BUILTIN_ORDER = sections.map(function (section) { return section.id; });

  function movableIds() {
    return sections.filter(function (section) { return !section.pinBottom; })
      .map(function (section) { return section.id; })
      .sort(function (a, b) { return BUILTIN_ORDER.indexOf(a) - BUILTIN_ORDER.indexOf(b); });
  }

  function sectionById(id) {
    for (var i = 0; i < sections.length; i++) {
      if (sections[i].id === id) return sections[i];
    }
    return null;
  }

  /* Order forced by a URL debug param, so a screenshot can show the rail the
     other way round without storing anything. */
  var widgetsPreview = null;

  function widgetOrder() {
    var known = movableIds();
    var raw = widgetsPreview !== null ? widgetsPreview
                                      : String(window.Store.get('appWidgets', ''));
    var out = [];
    raw.split(',').forEach(function (id) {
      id = id.replace(/^\s+|\s+$/g, '');
      if (known.indexOf(id) >= 0 && out.indexOf(id) < 0) out.push(id);
    });
    /* Anything the stored list does not mention — a section added by a newer
       build — keeps its built-in place at the end of the movable group. */
    known.forEach(function (id) { if (out.indexOf(id) < 0) out.push(id); });
    return out;
  }

  /* Whether the rail carries a section at all. Stored under the id of the row
     that switches it — one key per section, so a section that comes back finds
     its own place and its own values where it left them. A pinned section is
     never off: it is the way back into the level that switches the others.

     Sections are on unless they say otherwise: `offByDefault` is the exception,
     for a section nobody should meet without having gone looking for it (Tweaks
     changes what the TV thinks this app is). The default only decides what an
     untouched store means — once the row has been switched either way, the
     stored value is the answer. */
  var widgetsOffPreview = null;

  function widgetOff(id) {
    if (widgetsOffPreview !== null) return widgetsOffPreview.indexOf(id) >= 0;
    var section = sectionById(id);
    var def = !(section && section.offByDefault);
    return window.Store.get('widget:' + id, def) === false;
  }

  /* Switches one section off the rail or back onto it; rowId is the id of the row
     in the Widgets level, the same one moveWidget() takes. Returns false for a
     section that cannot be switched — the pinned one is the way back into this
     very level, so the rail can never end up empty. */
  function setWidgetOn(rowId, flag) {
    var id = String(rowId).replace(/^widget:/, '');
    var section = sectionById(id);
    if (!section || section.pinBottom) return false;
    /* A preview is edited rather than stored, the same rule the order follows:
       what a debug param set up stays out of the store. */
    if (widgetsOffPreview !== null) {
      var at = widgetsOffPreview.indexOf(id);
      if (flag && at >= 0) widgetsOffPreview.splice(at, 1);
      if (!flag && at < 0) widgetsOffPreview.push(id);
    } else {
      window.Store.set('widget:' + id, !!flag);
    }
    applyWidgetOrder();
    return true;
  }

  /* Sorts `sections` itself, because that array *is* the order of the rail
     (menu.js walks it to build the icons and indexes the active section by
     position in it). The pinned ones keep their own relative order at the foot,
     whatever the stored list says about them. `hidden` is set on the section
     rather than the section being dropped: its rows stay in the index, so a
     debug param and a stored value still find them while it is off the rail. */
  function applyWidgetOrder() {
    var order = widgetOrder();
    function rank(section) {
      if (section.pinBottom) return 1000 + BUILTIN_ORDER.indexOf(section.id);
      return order.indexOf(section.id);
    }
    sections.sort(function (a, b) { return rank(a) - rank(b); });
    sections.forEach(function (section) {
      section.hidden = !section.pinBottom && widgetOff(section.id);
    });
    buildWidgetItems();
  }

  /* One row per movable section, in the current order, plus a line saying where
     the pinned one sits: the question "and where did App properties go?" is
     asked by the list itself.

     A row switched off keeps its place in the list: the order and the switch are
     two answers about the same section, and a section put away comes back to
     where it was rather than to the end. */
  function buildWidgetItems() {
    /* First, before the list of the sections themselves: the words under the
       icons are the other thing about the rail this level can decide, and it is
       a switch rather than a row that moves, so it sits above the movable ones
       instead of somewhere in the middle of them. Rows are moved and switched by
       their id here, never by their place in the list, so the reordering below
       does not care that something now comes before it. */
    var items = [{
      id: 'appRailLabels',
      type: 'toggle',
      labelKey: 'widgets.labels',
      hintKey: 'widgets.labels.hint',
      def: true,
      write: function (value, cb) {
        applyRailLabels();
        cb(true, { local: true });
      }
    }];
    widgetOrder().forEach(function (id) {
      var section = sectionById(id);
      if (!section) return;
      items.push({
        id: 'widget:' + id,
        type: 'reorder',
        /* Read by menu.js for the switch on the row. The `id` of the loop is a
           parameter of this callback, so each row closes over its own. */
        on: function () { return !widgetOff(id); },
        /* The key, not the text: these rows are rebuilt when the order changes,
           not when the language does, and a label resolved here would stay in
           the language it was built in. The full title rather than the short
           rail label — this list has the room for it. */
        labelKey: section.titleKey,
        hintKey: 'widgets.hint.grab'
      });
    });

    var pinned = sections.filter(function (section) { return section.pinBottom; });
    if (pinned.length) {
      items.push({
        id: 'widgetPinned',
        type: 'info',
        render: function () {
          return infoHtml(pinned.map(function (section) {
            return [t(section.titleKey), t('widgets.pinned')];
          }));
        }
      });
    }

    subsection('widgets').items = items;
    reindex();
  }

  /* Moves one section by a place; delta is -1 for up and 1 for down. Returns
     false at either end of the list, which is what tells menu.js to leave the
     focus where it is instead of repainting. */
  function moveWidget(rowId, delta) {
    var id = String(rowId).replace(/^widget:/, '');
    var order = widgetOrder();
    var from = order.indexOf(id);
    var to = from + delta;
    if (from < 0 || to < 0 || to >= order.length) return false;
    order.splice(to, 0, order.splice(from, 1)[0]);
    /* A preview is not stored, so moving a row while one is up edits the preview
       and leaves the saved order alone. */
    if (widgetsPreview !== null) widgetsPreview = order.join(',');
    else window.Store.set('appWidgets', order.join(','));
    applyWidgetOrder();
    return true;
  }

  /* The order is read before the rail is built, not in applyAppPrefs(): menu.js
     draws the icons as soon as it loads, and by then the sections have to be in
     the right order already. */
  applyWidgetOrder();

  /* ------------------------------------------------- the app's own prefs --- */
  var MODES = ['dark', 'light'];
  var SIDES = ['right', 'left'];
  var ALIGNS = ['left', 'center', 'right'];

  /* What sits on <html> right now. Kept because a preview param changes one half
     of the theme and has to leave the other half where it was. */
  var themeNow = { mode: 'dark', contrast: false };

  /* The panel starts in English and only the stored choice changes it: the TV
     locale is never read, so it does not switch the UI. */
  function applyLanguage() {
    var changed = window.I18N.setLang(window.Store.get('appLanguage', 'en'));
    // Generated rows keep plain strings, so they are rebuilt in the new language.
    if (changed) buildBtItems();
    return changed;
  }

  /* The theme is two independent switches: the mode picks the surfaces, and the
     contrast switch replaces them with plain black or plain white. Both live on
     <html> — the CSS at the end of app.css is the only thing that knows what the
     four combinations look like. */
  function applyTheme() {
    setTheme(window.Store.get('appDarkMode', true) ? 'dark' : 'light',
             !!window.Store.get('appContrast', false));
  }

  function setTheme(mode, contrast) {
    themeNow.mode = MODES.indexOf(mode) < 0 ? 'dark' : mode;
    themeNow.contrast = contrast;
    document.documentElement.setAttribute('data-theme', themeNow.mode);
    /* Written as "off" rather than removed: one attribute to read, whichever
       state it is in. */
    document.documentElement.setAttribute('data-contrast', contrast ? 'on' : 'off');
  }

  /* The theme used to be one select of three palettes (dark | light | contrast).
     An installed copy still carries that key, so it is converted into the two
     switches once and then emptied. */
  function migrateTheme() {
    var old = window.Store.get('appTheme', '');
    if (!old) return;
    window.Store.set('appDarkMode', old !== 'light');
    window.Store.set('appContrast', old === 'contrast');
    window.Store.set('appTheme', '');
  }

  function accentHex(name) {
    for (var i = 0; i < ACCENTS.length; i++) {
      if (ACCENTS[i].value === name) return ACCENTS[i].swatch;
    }
    return null;
  }

  /* --accent is written straight onto <html>, so it wins over the palette that
     the stylesheet picked: the chosen colour holds on dark, light and contrast
     alike. Everything accented reads that one variable, nothing else changes. */
  function applyAccent() {
    setAccent(window.Store.get('appAccent', DEF_ACCENT));
  }

  function setAccent(name) {
    var hex = accentHex(name) || accentHex(DEF_ACCENT);
    document.documentElement.style.setProperty('--accent', hex);
  }

  /* How much of a column is painted from img/*.png rather than from the palette.
     One variable and one attribute per column, and the stylesheet holds every
     path: which of the four files a column takes follows the theme, so nothing
     here needs to know their names.

     The two columns are two settings, so this is the same pair of functions
     twice, told apart by the names they write. "appBg" is the column of rows --
     the main picture, and the name it has had since there was only one -- and
     "appBgRail" is the strip of widgets. */
  function applyBg() {
    var stored = window.Store.get('appBg', DEF_BG);
    var step = nearestBg(migrateBg(stored));
    if (step !== stored) window.Store.set('appBg', step);
    setBg(step);
  }

  function applyBgRail() {
    var stored = window.Store.get('appBgRail', DEF_BG);
    var step = nearestBg(migrateBg(stored));
    if (step !== stored) window.Store.set('appBgRail', step);
    setBgRail(step);
  }

  function setBg(percent) {
    var share = nearestBg(percent);
    document.documentElement.style.setProperty('--bg-opacity', String(share / 100));
    /* Off rather than a picture at nothing per cent: at the bottom of the range
       the column is painted from the palette again, and an invisible layer would
       still be a layer for the TV to composite behind everything else. */
    document.documentElement.setAttribute('data-bg', share > 0 ? 'on' : 'off');
  }

  function setBgRail(percent) {
    var share = nearestBg(percent);
    document.documentElement.style.setProperty('--bg-opacity-rail', String(share / 100));
    document.documentElement.setAttribute('data-bg-rail', share > 0 ? 'on' : 'off');
  }

  function nearestBg(percent) {
    return nearestStep(percent, MIN_BG, MAX_BG, BG_STEP, DEF_BG);
  }

  /* The setting was a switch before it was a slider, so a store written by that
     build still holds a boolean: on means the pictures as solid as they go, off
     means none. applyBg() writes the number back, so this is asked once. */
  function migrateBg(stored) {
    if (stored === true) return MAX_BG;
    if (stored === false) return MIN_BG;
    return stored;
  }

  /* The whole overlay fades, not the panel background alone: the point of the
     setting is to see the picture through everything the app draws, rings and
     text included. The CSS keeps one variable and no rules of its own. */
  function applyTransparency() {
    var stored = window.Store.get('appTransparency', DEF_TRANSPARENCY);
    var step = nearestTransparency(stored);
    /* Pulled into the range in the store as well, so the knob on the row and
       the picture on screen agree even after a hand-edited localStorage. */
    if (step !== stored) window.Store.set('appTransparency', step);
    setTransparency(step);
  }

  /* The CSS keeps one variable, the opacity: what is not transparent. */
  function setTransparency(percent) {
    document.documentElement.style.setProperty('--ui-opacity', String((100 - nearestTransparency(percent)) / 100));
  }

  /* The setting was an opacity (30 to 100) before it was a transparency: a store
     written by that build holds appOpacity, and what it means now is what was left
     of it, 100 - opacity. Asked once: after it appTransparency is in the store (the
     old key stays there, nothing reads it any more). */
  function migrateOpacity() {
    var old = window.Store.get('appOpacity', null);
    if (old === null || !isFinite(Number(old))) return;
    if (window.Store.get('appTransparency', null) !== null) return;
    window.Store.set('appTransparency', nearestTransparency(100 - Number(old)));
  }

  /* Snapped to the nearest stop and clamped to the range, so the floor of a
     slider is also the floor of what can ever be applied. Counted from the
     minimum, not from zero: the stops of a slider are min + n * step, and for
     the width the two differ (15% + 5% is a stop, 18% is not). */
  function nearestStep(value, min, max, step, def) {
    var number = Number(value);
    if (!isFinite(number)) return def;
    var snapped = min + Math.round((number - min) / step) * step;
    return Math.max(min, Math.min(max, snapped));
  }

  function nearestTransparency(percent) {
    return nearestStep(percent, MIN_TRANSPARENCY, MAX_TRANSPARENCY, TRANSPARENCY_STEP, DEF_TRANSPARENCY);
  }

  /* Width of the panel, the same way: a share of the screen snapped to one of
     the twenty stops. The pixels are the share of the 1920 canvas the UI layer is
     laid out on, rounded so the border of the panel lands on a whole pixel. */
  function applyWidth() {
    var stored = window.Store.get('appWidth', DEF_WIDTH);
    var step = nearestWidth(stored);
    if (step !== stored) window.Store.set('appWidth', step);
    setWidth(step);
  }

  function setWidth(percent) {
    var share = nearestWidth(percent);
    document.documentElement.style.setProperty('--panel-w',
      Math.round(LAYOUT_W * share / 100) + 'px');
    /* Written as "full" rather than removed, the way the contrast attribute is:
       one attribute to read, whichever state it is in. */
    document.documentElement.setAttribute('data-width',
      share < NARROW_WIDTH ? 'narrow' : 'full');
  }

  function nearestWidth(percent) {
    return nearestStep(percent, MIN_WIDTH, MAX_WIDTH, WIDTH_STEP, DEF_WIDTH);
  }

  /* The two insets, in pixels of the same 1920x1080 canvas. Both are applied at
     once because the floor of the panel belongs to the pair: two sliders that
     each reach half the screen can together ask for a panel of nothing, and the
     bottom one is the one that gives way — the top inset is what places the
     panel, the bottom only says where it ends. The trimmed value goes back into
     the store, so the row reads what the screen shows and the slider simply
     stops moving once the other end has taken the room. */
  function applyInsets() {
    var top = nearestInset(window.Store.get('appPadTop', DEF_INSET));
    var bottom = nearestInset(window.Store.get('appPadBottom', DEF_INSET_BOTTOM));
    var room = LAYOUT_H - MIN_PANEL_H;
    if (top + bottom > room) bottom = Math.max(MIN_INSET, room - top);
    if (top + bottom > room) top = Math.max(MIN_INSET, room - bottom);
    if (top !== window.Store.get('appPadTop', DEF_INSET)) window.Store.set('appPadTop', top);
    if (bottom !== window.Store.get('appPadBottom', DEF_INSET_BOTTOM)) window.Store.set('appPadBottom', bottom);
    setInsets(top, bottom);
  }

  function setInsets(top, bottom) {
    var high = nearestInset(top);
    var low = nearestInset(bottom);
    document.documentElement.style.setProperty('--pad-top', high + 'px');
    document.documentElement.style.setProperty('--pad-bottom', low + 'px');
    /* Below this the icons of the rail stop fitting next to its clock, its date
       and their labels, and what a rail may not lose is an icon: the section
       pinned to its foot is the way back into this very setting. So the rail
       drops the decoration instead (data-rail="tight", see app.css) — the panel
       covers that much less of the TV's own clock at this height anyway. */
    document.documentElement.setAttribute('data-rail',
      LAYOUT_H - high - low < TIGHT_PANEL_H ? 'tight' : 'full');
  }

  function nearestInset(pixels) {
    return nearestStep(pixels, MIN_INSET, MAX_INSET, INSET_STEP, DEF_INSET);
  }

  /* What the row above the level reports: the stored pair, snapped, so a
     hand-edited store cannot make the row disagree with the panel. */
  function inset(id) {
    var def = (id === 'appPadBottom') ? DEF_INSET_BOTTOM : DEF_INSET;
    return nearestInset(window.Store.get(id, def));
  }

  /* Which edge the panel is docked to. Only the CSS knows what that means: the
     column order inside the panel stays as it is, so the icon rail keeps sitting
     against the outer edge and the chevrons keep pointing the way they do. */
  function applySide() {
    var isLeft = window.Store.get('appSide', false);
    var side = isLeft ? 'left' : 'right';
    document.documentElement.setAttribute('data-side', side);
  }

  /* An unknown value (a store edited by hand) falls back to the default. */
  function pickPanelEffect(value) {
    for (var i = 0; i < PANEL_EFFECTS.length; i++) {
      if (PANEL_EFFECTS[i].value === value) return value;
    }
    return DEF_PANEL_EFFECT;
  }

  function applyPanelEffect() {
    document.documentElement.setAttribute('data-panel-effect',
      pickPanelEffect(window.Store.get('appEffect', DEF_PANEL_EFFECT)));
  }

  /* The idle seconds before the panel closes (app.js runs the timer). A stored
     value that is not one of the stops falls back to the default. */
  function applyAutoClose() {
    closeNow.idleSec = pickAutoClose(window.Store.get('appAutoClose', String(DEF_AUTOCLOSE_SEC)));
  }

  function pickAutoClose(value) {
    var n = Number(value);
    return AUTOCLOSE_SEC.indexOf(n) < 0 ? DEF_AUTOCLOSE_SEC : n;
  }

  /* Whether a start made by the TV (launch param boot) opens the panel: the
     stored switch, or the URL preview when there is one. */
  function openAtStart() {
    if (startNow.openAtStart !== null) return startNow.openAtStart;
    return !!window.Store.get('appOpenAtStart', true);
  }

  /* Where the balloon shows up. Two questions, so two rows: the edge is a
     switch (top by default, as it always was) and the alignment a short list —
     together they are the six places a corner or a centre can be. Only the CSS
     knows what each combination does. */
  function applyToast() {
    setToast(window.Store.get('appToastTop', true) ? 'top' : 'bottom',
             window.Store.get('appToastAlign', 'center'));
  }

  function setToast(edge, align) {
    document.documentElement.setAttribute('data-toast-v', edge === 'bottom' ? 'bottom' : 'top');
    document.documentElement.setAttribute('data-toast-h',
      ALIGNS.indexOf(align) < 0 ? 'center' : align);
  }

  /* Whether the icons of the rail are captioned. On by default: the icons are
     what the sections are recognised by, and the words under them are what makes
     the recognition learnable. Off is for someone who already knows the rail and
     wants the room back. Only the CSS knows what it means — the labels stay in
     the markup, so switching them back on needs no repaint of the rail.

     Tight rails hide the labels anyway; this switch is the same choice made on
     purpose instead of as a side effect of the icon size. */
  function applyRailLabels() {
    document.documentElement.setAttribute('data-labels',
      window.Store.get('appRailLabels', true) ? 'on' : 'off');
  }

  /* The two bands at the ends of the rail: whether each is there at all, whether
     each is painted in the accent, and how heavy both of them are. One attribute
     per question, so the CSS can answer them separately. */
  function applyClockLook() {
    var root = document.documentElement;
    root.setAttribute('data-clock', timeFormat() === CLOCK_OFF ? 'off' : 'on');
    root.setAttribute('data-date', dateFormat() === CLOCK_OFF ? 'off' : 'on');
    root.setAttribute('data-clock-accent', window.Store.get('appClockColour', true) ? 'on' : 'off');
    root.setAttribute('data-date-accent', window.Store.get('appDateColour', true) ? 'on' : 'off');
    root.setAttribute('data-clock-bold', window.Store.get('appClockBold', true) ? 'on' : 'off');
    root.setAttribute('data-clock-size', clockSize('appClockSize'));
    root.setAttribute('data-date-size', clockSize('appDateSize'));
  }

  /* The size of a band: the URL preview when there is one, else the stored choice, else
     the middle step. */
  var sizePreview = { appClockSize: null, appDateSize: null };

  function clockSize(key) {
    var size = sizePreview[key] || window.Store.get(key, DEF_CLOCK_SIZE);
    return CLOCK_SIZES.indexOf(size) < 0 ? DEF_CLOCK_SIZE : size;
  }

  /* ?clockSize=xl and ?dateSize=xs, nothing stored. */
  function previewClockSize(key, value) {
    if (CLOCK_SIZES.indexOf(String(value)) < 0) return false;
    sizePreview[key] = String(value);
    applyClockLook();
    return true;
  }

  /* Show a palette without storing the choice (URL debug param). `contrast` is
     still accepted as a palette of its own: it is what the older links and
     screenshots ask for, and it now means "this mode, high contrast". */
  function previewTheme(name) {
    if (name === 'contrast') { setTheme(themeNow.mode, true); return true; }
    if (MODES.indexOf(name) < 0) return false;
    setTheme(name, themeNow.contrast);
    return true;
  }

  /* Either half of the theme can be previewed on its own: ?theme=light&contrast=1. */
  function previewContrast(flag) {
    setTheme(themeNow.mode, flag !== '0' && flag !== 'off' && flag !== 'false');
    return true;
  }

  /* Same for the accent: paint it, remember nothing. */
  function previewAccent(name) {
    if (!accentHex(name)) return false;
    setAccent(name);
    return true;
  }

  /* And for the edge the panel is docked to. */
  function previewSide(name) {
    if (SIDES.indexOf(name) < 0) return false;
    document.documentElement.setAttribute('data-side', name);
    return true;
  }

  /* And how the panel comes onto the screen:
     ?panelEffect=edge|opposite|top|bottom|fade|pop|none. */
  function previewPanelEffect(value) {
    if (pickPanelEffect(String(value)) !== String(value)) return false;
    document.documentElement.setAttribute('data-panel-effect', String(value));
    return true;
  }

  /* And the idle seconds before the panel closes: ?autoclose=5. Only the stops of
     the list count, as for a stored value. */
  function previewAutoClose(value) {
    if (AUTOCLOSE_SEC.indexOf(Number(value)) < 0) return false;
    closeNow.idleSec = Number(value);
    return true;
  }

  /* And the start switch: ?openAtStart=0 (0, off and false mean off). */
  function previewOpenAtStart(value) {
    startNow.openAtStart = !/^(0|off|false|no)$/i.test(String(value));
    return true;
  }

  /* The picture behind the rows: ?bg=100 is as solid as it gets, ?bg=0 no picture
     at all. Snapped and clamped like a stored value, which is why ?bg=1 is the
     bottom of the range and not a picture nobody could see. */
  function previewBg(percent) {
    if (!isFinite(Number(percent))) return false;
    setBg(percent);
    return true;
  }

  /* And the one behind the widgets, a parameter of its own: ?bg=100&bgRail=0 is
     what a picture behind the rows and the palette behind the rail looks like. */
  function previewBgRail(percent) {
    if (!isFinite(Number(percent))) return false;
    setBgRail(percent);
    return true;
  }

  /* Transparency too, snapped and clamped like a stored value: ?transparency=100 lands
     on the ceiling of the slider instead of emptying the screen. */
  function previewTransparency(percent) {
    if (!isFinite(Number(percent))) return false;
    setTransparency(percent);
    return true;
  }

  /* And the width: ?width=50 is the widest the panel goes, half the screen. */
  function previewWidth(percent) {
    if (!isFinite(Number(percent))) return false;
    setWidth(percent);
    return true;
  }

  /* And the two insets: ?padTop=120&padBottom=60. Either may be given on its
     own, so the one left out keeps whatever is stored — and the pair is written
     through the same floor as a stored one, because a shot of an empty screen
     would be a shot of nothing. */
  function previewInsets(top, bottom) {
    var current = { top: inset('appPadTop'), bottom: inset('appPadBottom') };
    var next = {
      top: isFinite(Number(top)) ? nearestInset(top) : current.top,
      bottom: isFinite(Number(bottom)) ? nearestInset(bottom) : current.bottom
    };
    var room = LAYOUT_H - MIN_PANEL_H;
    if (next.top + next.bottom > room) next.bottom = Math.max(MIN_INSET, room - next.top);
    setInsets(next.top, next.bottom);
    return true;
  }

  /* And the order of the rail: ?widgets=power,screen,sound,system. Anything the
     list leaves out keeps its built-in place at the end, so a partial list is
     enough to push one section to the top. */
  function previewWidgets(spec) {
    widgetsPreview = String(spec);
    applyWidgetOrder();
    return true;
  }

  /* And the sections the rail leaves out: ?widgetsOff=sound,power. An empty list
     is a preview too — ?widgetsOff= puts every section back on the rail whatever
     the store says, which is how a shot escapes a stored choice. */
  function previewWidgetsOff(spec) {
    widgetsOffPreview = [];
    String(spec).split(',').forEach(function (id) {
      id = id.replace(/^\s+|\s+$/g, '');
      if (id) widgetsOffPreview.push(id);
    });
    applyWidgetOrder();
    return true;
  }

  /* And where the balloon appears: ?toastAt=bottom-left, ?toastAt=top (centre). */
  function previewToast(spec) {
    var parts = String(spec).toLowerCase().split('-');
    if (parts[0] !== 'top' && parts[0] !== 'bottom') return false;
    var align = parts.length > 1 ? parts[1] : 'center';
    if (ALIGNS.indexOf(align) < 0) return false;
    setToast(parts[0], align);
    return true;
  }

  /* Back to a fresh install: everything the utility remembers goes, and the
     defaults of the model take over again. The cached values of the TV settings
     go with it — they are only a cache, and the next render reads them from the
     TV anyway. Nothing on the TV itself is touched. */
  function resetPrefs(api) {
    window.Store.reset();
    applyAppPrefs();
    window.Menu.relabel();
    window.Menu.paintClock();
    api.rerender();
    api.toast(t('toast.reset'));
  }

  /* Called once at startup, before the panel is rendered.
     Returns true when the language differs from the one i18n started with. */
  function applyAppPrefs() {
    migrateTheme();
    migrateOpacity();
    applyTheme();
    applyAccent();
    applyBg();
    applyBgRail();
    applyTransparency();
    applyWidth();
    applyInsets();
    applySide();
    applyPanelEffect();
    applyAutoClose();
    applyToast();
    applyRailLabels();
    applyClockLook();
    /* Already applied once at load, before the rail was drawn; here for the
       reset, which empties the stored order and has to put the rail back. */
    applyWidgetOrder();
    return applyLanguage();
  }

  /* Fills the device block (model, firmware) and the helper service state.
     The OS block and the uptime are loaded by the System section itself. */
  function loadDeviceInfo(done) {
    Luna.systemInfo(function (res) {
      if (res) {
        device.model = res.modelName || null;
        device.firmware = res.firmwareVersion || null;
      }
      Luna.serviceStatus(function (status) {
        device.service = status;
        console.log('[webocu-settings] helper service: running=' + status.running + ', root=' + status.root);
        if (done) done(false);
      });
    });
  }

  /* The app asks for root by itself when the service has none: on a TV with the
     Homebrew Channel that is the whole of Request privileges, done at start. A
     root service keeps the keepalive init script in place (service.js), so this
     is also what puts that script on the TV. It is silent and cannot fail the
     start: no toast, no dialog, a TV without the Channel just answers "no".
     done(root) gets the outcome. The row in Tweaks stays as a manual retry. */
  function autoElevate(done) {
    var svc = device.service;
    if (!svc || svc.root || svc.mocked) { done(!!(svc && svc.root)); return; }
    try {
      Luna.elevate(function (root, status) {
        if (status) device.service = status;
        buildSwitchAppIdItems();
        console.log('[webocu-settings] auto elevate: root=' + !!root);
        done(!!root);
      });
    } catch (e) {
      console.warn('[webocu-settings] auto elevate: ' + e.message);
      done(false);
    }
  }

  return {
    sections: sections,
    subsection: subsection,
    item: function (id) { return index[id]; },
    sectionOf: function (id) { return sectionOf[id]; },
    value: value,
    commit: commit,
    refresh: refresh,
    label: label,
    hint: hint,
    optionLabel: optionLabel,
    formatValue: formatValue,
    applyAppPrefs: applyAppPrefs,
    previewTheme: previewTheme,
    previewContrast: previewContrast,
    previewAccent: previewAccent,
    previewBg: previewBg,
    previewBgRail: previewBgRail,
    previewTransparency: previewTransparency,
    previewWidth: previewWidth,
    previewInsets: previewInsets,
    previewSide: previewSide,
    previewPanelEffect: previewPanelEffect,
    previewAutoClose: previewAutoClose,
    autoCloseSeconds: function () { return closeNow.idleSec; },
    previewOpenAtStart: previewOpenAtStart,
    openAtStart: openAtStart,
    previewToast: previewToast,
    previewClock: previewClock,
    previewClockSize: previewClockSize,
    previewWidgets: previewWidgets,
    previewWidgetsOff: previewWidgetsOff,
    moveWidget: moveWidget,
    setWidgetOn: setWidgetOn,
    timeText: timeText,
    dateText: dateText,
    loadDeviceInfo: loadDeviceInfo,
    autoElevate: autoElevate,
    loadIcons: loadIcons,
    loadIconsSync: loadIconsSync,
    appStartTime: appStartTime
  };
})();
