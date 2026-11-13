/* =========================================================================
   luna-service access layer.

   Calls go through the built-in PalmServiceBridge, so the project needs no
   external SDK library (webOSTV.js). Every public method takes a callback
   with (result, info) where info = { mocked: Boolean, error: String|null }.

   Privileged actions (power, screen, some settings categories) are not
   available to a Developer Mode web app, so each of them is a chain:

     1. webocu.settings.service  — our own helper service; does the real
        work once it has been elevated to root (Tweaks -> Request privileges);
     2. Homebrew Channel exec      — runs luna-send as root on a rooted TV;
     3. the plain luna endpoints    — work on firmwares that allow them.

   The next candidate is tried whenever the previous one fails, and every
   failure is logged, so the app log shows which path the TV accepted.
   ========================================================================= */
window.Luna = (function () {
  var available = typeof window.PalmServiceBridge !== 'undefined';
  var keepAlive = [];   // subscriptions must be referenced or GC kills the channel

  /* Get the current app ID from PalmSystem.identifier, or use the default.
     When the app is switched to another ID (amazon, netflix, etc.), the service
     ID follows: amazon → amazon.service, netflix → netflix.service. */
  var DEFAULT_SERVICE_ID = 'webocu.settings.service';

  function getAppId() {
    var sys = window.webOSSystem || window.PalmSystem || null;
    if (sys && sys.identifier) {
      return String(sys.identifier);
    }
    return 'webocu.settings';
  }

  var APP_ID = getAppId();
  var SERVICE_ID = APP_ID + '.service';
  var SERVICE = 'luna://' + SERVICE_ID;
  var HBCHANNEL = 'luna://org.webosbrew.hbchannel.service';
  var HB_DIR = '/media/developer/apps/usr/palm/services/org.webosbrew.hbchannel.service';
  /* The settings service answers under two names and which one exists depends
     on the firmware, so both are tried: a wrong name fails as "service does not
     exist" and every setting silently does nothing. */
  var SETTINGS = ['luna://com.webos.settingsservice', 'luna://com.webos.service.settings'];
  /* Model and firmware come from the tv systemproperty service, the operating
     system itself from the generic one (osInfo/query). */
  var SYSSERVICE = 'luna://com.webos.service.systemservice';
  var SYSPROP = 'luna://com.webos.service.tv.systemproperty';
  var TVPOWER = 'luna://com.webos.service.tvpower';
  var POWER = 'luna://com.webos.service.power';
  /* Restarting is not tvpower's job: com.webos.service.tvpower/power/reboot
     shuts the TV down instead of bringing it back up, so the reboot goes to the
     sleep service (the same call the system uses for a real restart). */
  var SLEEP = 'luna://com.webos.service.sleep';
  /* Bluetooth lives in two services: the legacy one answers gap/getTrustedDevices
     and service/connect, bluetooth2 owns the adapter status. */
  var BT = 'luna://com.webos.service.bluetooth';
  var BT2 = 'luna://com.webos.service.bluetooth2';
  /* Wi-Fi and Ethernet both belong to the connection manager: getStatus is the
     live state of each link, getinfo the hardware addresses. */
  var NETWORK = 'luna://com.webos.service.connectionmanager';
  /* Muting: master/setMute is the call the mute key sends. The service was
     renamed along the way, so both names are tried the way the settings service
     is -- the one the hub does not know answers "service does not exist". */
  var AUDIO = ['luna://com.webos.service.audio', 'luna://com.webos.audio'];
  /* Application manager handles app listing, removal, and launching. */
  var APPMGR = 'luna://com.webos.service.applicationmanager';

  /* The firmware matches the reason against its own list; an unknown string is
     what makes some builds ignore the request, so this is the one the remote
     itself sends. */
  var REASON = 'remoteKey';
  var ADDRESS = /^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$/;

  function noop() {}

  /* Single request. Returns the bridge (or null when unavailable). */
  function call(uri, params, onOk, onErr) {
    if (!available) {
      if (onErr) onErr({ returnValue: false, errorText: 'no bridge', mocked: true });
      return null;
    }
    var bridge = new window.PalmServiceBridge();
    bridge.onservicecallback = function (payload) {
      var res;
      try { res = JSON.parse(payload); } catch (e) { res = { returnValue: false, errorText: 'bad json' }; }
      if (res.returnValue === false) { if (onErr) onErr(res); } else if (onOk) onOk(res);
    };
    bridge.call(uri, JSON.stringify(params || {}));
    return bridge;
  }

  /* Subscription; the bridge is kept in module scope on purpose. */
  function subscribe(uri, params, onOk, onErr) {
    var p = params || {};
    p.subscribe = true;
    var bridge = call(uri, p, onOk, onErr);
    if (bridge) keepAlive.push(bridge);
    return bridge;
  }

  /* Try candidates one by one until one succeeds.
     A candidate may carry ok(res) when returnValue alone does not prove that
     the action happened (Homebrew Channel exec reports the shell, not luna). */
  function chain(candidates, cb) {
    var i = 0;
    function attempt() {
      if (i >= candidates.length) {
        cb(false, { mocked: !available, error: available ? 'all endpoints failed' : 'no bridge' });
        return;
      }
      var c = candidates[i++];
      call(c.uri, c.params,
        function (res) {
          if (c.ok && !c.ok(res)) {
            console.warn('[luna] ' + c.uri + ' ran but reported no success');
            attempt();
            return;
          }
          console.log('[luna] ' + c.uri + ' accepted the call');
          cb(true, { mocked: false, error: null, uri: c.uri, root: res && res.root });
        },
        function (err) {
          console.warn('[luna] ' + c.uri + ' failed: ' + (err && err.errorText));
          attempt();
        });
    }
    attempt();
  }

  /* Like chain(), but the point is the payload, not the fact of success: each
     candidate carries pick(res) and the first one that picks something wins.
     cb(data, info) with data === null when every candidate came up empty. */
  function chainData(candidates, cb) {
    var i = 0;
    function attempt() {
      if (i >= candidates.length) {
        cb(null, { mocked: !available, error: available ? 'all endpoints failed' : 'no bridge' });
        return;
      }
      var c = candidates[i++];
      call(c.uri, c.params,
        function (res) {
          var data = null;
          try { data = c.pick(res); } catch (e) { data = null; }
          if (data === null || typeof data === 'undefined') {
            console.warn('[luna] ' + c.uri + ' answered without the data we need');
            attempt();
            return;
          }
          console.log('[luna] ' + c.uri + ' answered');
          cb(data, { mocked: false, error: null, uri: c.uri });
        },
        function (err) {
          console.warn('[luna] ' + c.uri + ' failed: ' + (err && err.errorText));
          attempt();
        });
    }
    attempt();
  }

  /* ------------------------------------------------- privileged fallbacks -- */
  function lunaSend(uri, params) {
    return 'luna-send -n 1 -f ' + uri + " '" + JSON.stringify(params || {}) + "'";
  }

  /* Homebrew Channel runs the command as root. exec() answers returnValue:true
     as soon as the shell ran, so the luna reply inside stdout is inspected. */
  function hbExec(command) {
    return {
      uri: HBCHANNEL + '/exec',
      params: { command: command },
      ok: function (res) {
        var out = String((res && (res.stdoutString || res.stdout)) || '');
        return out.replace(/\s+/g, '').indexOf('"returnValue":true') >= 0;
      }
    };
  }

  /* Homebrew Channel exec of a plain shell command: here returnValue alone is
     the verdict, because the output is not a luna reply to look into. */
  function hbShell(command) {
    return { uri: HBCHANNEL + '/exec', params: { command: command } };
  }

  /* Homebrew Channel exec used as a read: the luna reply is the stdout of
     luna-send, so it is parsed out of the text before pick() sees it. */
  function hbRead(command, pick) {
    return {
      uri: HBCHANNEL + '/exec',
      params: { command: command },
      pick: function (res) {
        var out = String((res && (res.stdoutString || res.stdout)) || '');
        var start = out.indexOf('{');
        if (start < 0) return null;
        var parsed;
        try { parsed = JSON.parse(out.slice(start)); } catch (e) { return null; }
        return pick(parsed);
      }
    };
  }

  /* ---------------------------------------------------------- settings ---- */
  /* One category, several keys, whichever service name answers.
     cb(settings, info) with settings === null when nobody did. */
  function getSettings(category, keys, cb) {
    chainData(SETTINGS.map(function (uri) {
      return {
        uri: uri + '/getSystemSettings',
        params: { category: category, keys: keys },
        pick: function (res) { return (res && res.settings) || null; }
      };
    }), cb);
  }

  /* Build the payload of one setSystemSettings call. `extra` carries companion
     keys that have to travel with the value (energySavingModified, for one). */
  function settingsPayload(category, key, value, extra) {
    var settings = {};
    settings[key] = value;
    for (var name in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, name)) settings[name] = extra[name];
    }
    return { category: category, settings: settings };
  }

  /* Every (service name, category) pair, in the order they are tried. */
  function settingsTargets(categories) {
    var out = [];
    for (var s = 0; s < SETTINGS.length; s++) {
      for (var c = 0; c < categories.length; c++) out.push({ uri: SETTINGS[s], category: categories[c] });
    }
    return out;
  }

  /* Writing a system setting is privileged on webOS 7: a Developer Mode app is
     refused, so the root paths come first and the plain endpoints last. The
     order mirrors the power calls: helper service -> hbchannel exec -> plain. */
  function setSetting(categories, key, value, cb, extra) {
    var candidates = [{
      uri: SERVICE + '/setSetting',
      params: { categories: categories, key: key, value: value, extra: extra || {} }
    }];

    var targets = settingsTargets(categories);
    targets.forEach(function (target) {
      candidates.push(hbExec(lunaSend(target.uri + '/setSystemSettings',
        settingsPayload(target.category, key, value, extra))));
    });
    targets.forEach(function (target) {
      candidates.push({
        uri: target.uri + '/setSystemSettings',
        params: settingsPayload(target.category, key, value, extra)
      });
    });

    chain(candidates, cb);
  }

  /* Reading is usually allowed, so the plain endpoints go first here; the
     answer has to actually contain the key, hence chainData and pick(). */
  function readSetting(categories, key, cb) {
    function pick(res) {
      var settings = res && res.settings;
      if (!settings || typeof settings[key] === 'undefined') return null;
      return settings[key];
    }

    var candidates = settingsTargets(categories).map(function (target) {
      return {
        uri: target.uri + '/getSystemSettings',
        params: { category: target.category, keys: [key] },
        pick: pick
      };
    });

    candidates.push({
      uri: SERVICE + '/getSetting',
      params: { categories: categories, key: key },
      pick: function (res) {
        return (res && typeof res.value !== 'undefined') ? res.value : null;
      }
    });

    settingsTargets(categories).forEach(function (target) {
      candidates.push(hbRead(lunaSend(target.uri + '/getSystemSettings',
        { category: target.category, keys: [key] }), pick));
    });

    chainData(candidates, cb);
  }

  /* ------------------------------------------------------------- power ---- */
  /* No parameters on purpose: with standbyMode the panel goes dark but the
     backlight stays on, so the picture is black on a lit screen. The plain call
     blanks the panel for real. */
  function turnOffScreen(cb) {
    chain([
      { uri: SERVICE + '/screenOff' },
      hbExec(lunaSend(TVPOWER + '/power/turnOffScreen', {})),
      { uri: TVPOWER + '/power/turnOffScreen', params: {} }
    ], cb || noop);
  }

  function turnOnScreen(cb) {
    chain([
      { uri: SERVICE + '/screenOn' },
      hbExec(lunaSend(TVPOWER + '/power/turnOnScreen', {})),
      { uri: TVPOWER + '/power/turnOnScreen', params: {} }
    ], cb || noop);
  }

  /* ------------------------------------------------------------- sound ---- */
  /* Muting uses the usual chain -- helper service, the Homebrew Channel as root,
     then the plain endpoint under each of the two names the audio service has
     had. */
  function mute(on, cb) {
    var wanted = { mute: !!on };
    var candidates = [{ uri: SERVICE + '/mute', params: wanted }];
    AUDIO.forEach(function (uri) {
      candidates.push(hbExec(lunaSend(uri + '/master/setMute', wanted)));
    });
    AUDIO.forEach(function (uri) {
      candidates.push({ uri: uri + '/master/setMute', params: wanted });
    });
    chain(candidates, cb || noop);
  }

  function reboot(cb) {
    chain([
      { uri: SERVICE + '/reboot' },
      hbExec(lunaSend(SLEEP + '/shutdown/machineReboot', { reason: REASON })),
      { uri: SLEEP + '/shutdown/machineReboot', params: { reason: REASON } },
      { uri: POWER + '/shutdown/machineReboot', params: { reason: REASON } }
    ], cb || noop);
  }

  function powerOff(cb) {
    chain([
      { uri: SERVICE + '/powerOff' },
      hbExec(lunaSend(TVPOWER + '/power/powerOff', { reason: REASON })),
      { uri: TVPOWER + '/power/powerOff', params: { reason: REASON } },
      { uri: POWER + '/shutdown/machineOff', params: { reason: REASON } }
    ], cb || noop);
  }

  /* --------------------------------------------------------- bluetooth ---- */
  /* Pairing stays in the TV settings; this is only the list of devices the TV
     already trusts, plus connecting the audio profile of one of them. */

  /* Desktop debugging has no adapter to ask, so the panel gets two obviously
     fake devices instead of an empty list. */
  var MOCK_DEVICES = [
    { address: '00:11:22:33:44:55', name: 'Soundbar (dev)', connected: true },
    { address: '66:77:88:99:aa:bb', name: 'Headphones (dev)', connected: false }
  ];

  /* The device array is called differently in each reply, so the known names
     are tried first and anything else is searched for an address. */
  function deviceArray(res) {
    if (!res || typeof res !== 'object') return null;
    var named = res.devices || res.trustedDevices || res.pairedDevices || res.results;
    if (isDeviceList(named)) return named;
    for (var key in res) {
      if (!Object.prototype.hasOwnProperty.call(res, key)) continue;
      if (isDeviceList(res[key])) return res[key];
    }
    return null;
  }

  function isDeviceList(value) {
    if (!value || Object.prototype.toString.call(value) !== '[object Array]') return false;
    for (var i = 0; i < value.length; i++) {
      if (value[i] && ADDRESS.test(String(value[i].address || ''))) return true;
    }
    return value.length === 0;   // an empty list is an answer: nothing is paired
  }

  /* getTrustedDevices reports state: true, bluetooth2 lists connected profiles. */
  function isConnected(device) {
    if (device.state === true || device.connected === true) return true;
    if (device.state === 'connected') return true;
    var profiles = device.connectedProfiles || device.connectedRoles;
    return !!(profiles && profiles.length);
  }

  function pickDevices(res) {
    var list = deviceArray(res);
    if (!list) return null;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var device = list[i] || {};
      var address = String(device.address || '');
      if (!ADDRESS.test(address)) continue;
      out.push({
        address: address,
        name: String(device.name || device.friendlyName || ''),
        connected: isConnected(device)
      });
    }
    return out;
  }

  function pickAdapter(res) {
    if (!res || typeof res !== 'object') return null;
    var a = res;
    if (res.adapters && res.adapters.length) a = res.adapters[0] || {};
    if (typeof a.powered === 'undefined' && typeof a.discovering === 'undefined') return null;
    return {
      powered: !!a.powered,
      discovering: !!a.discovering,
      address: a.adapterAddress || a.address || null
    };
  }

  /* cb(devices, info) — devices is an array (possibly empty) or null on failure. */
  function btDevices(cb) {
    var done = cb || noop;
    if (!available) { done(MOCK_DEVICES, { mocked: true, error: null }); return; }
    chainData([
      { uri: SERVICE + '/btDevices', params: {}, pick: pickDevices },
      // The legacy interface is the one that answers: bluetooth2/device/
      // getPairedDevices does not exist below API level 12.
      { uri: BT + '/gap/getTrustedDevices', params: { service: 'audio' }, pick: pickDevices },
      { uri: BT2 + '/device/getPairedDevices', params: {}, pick: pickDevices },
      hbRead(lunaSend(BT + '/gap/getTrustedDevices', { service: 'audio' }), pickDevices)
    ], done);
  }

  /* cb(adapter, info) — { powered, discovering, address } or null. */
  function btAdapter(cb) {
    var done = cb || noop;
    /* The fake address is what the System section shows as the Bluetooth MAC
       while debugging in a browser. */
    if (!available) {
      done({ powered: true, discovering: false, address: 'a0:11:22:33:44:77' }, { mocked: true });
      return;
    }
    chainData([
      { uri: BT2 + '/adapter/getStatus', params: {}, pick: pickAdapter },
      { uri: SERVICE + '/btAdapter', params: {}, pick: pickAdapter },
      hbRead(lunaSend(BT2 + '/adapter/getStatus', {}), pickAdapter)
    ], done);
  }

  function btProfile(method, address, cb) {
    var done = cb || noop;
    if (!ADDRESS.test(String(address || ''))) {
      done(false, { mocked: !available, error: 'bad bluetooth address' });
      return;
    }
    var params = { service: 'audio', address: address };
    chain([
      { uri: SERVICE + '/bt' + method, params: { address: address } },
      hbExec(lunaSend(BT + '/service/' + method.toLowerCase(), params)),
      { uri: BT + '/service/' + method.toLowerCase(), params: params },
      { uri: BT2 + '/a2dp/' + method.toLowerCase(), params: { address: address } }
    ], done);
  }

  function btConnect(address, cb) { btProfile('Connect', address, cb); }
  function btDisconnect(address, cb) { btProfile('Disconnect', address, cb); }

  /* ----------------------------------------------------------- network ---- */
  /* Desktop debugging has no connection manager, so the block gets an obviously
     fake Wi-Fi link and no cable, rather than a column of dashes. */
  var MOCK_NET = {
    wifi: { connected: true, address: '192.168.1.42', ssid: 'Wi-Fi (dev)' },
    wired: { connected: false, address: null, ssid: null }
  };
  var MOCK_MACS = { wifi: 'a0:11:22:33:44:55', wired: 'a0:11:22:33:44:66' };
  var MOCK_KEEPALIVE = {
    version: '0.0.0',
    wifi: { ipAddress: 'xxx.xxx.xxx.xxx' },
    wired: null,
    timestamp: 0
  };

  function pickLink(link) {
    var l = link || {};
    return {
      connected: l.state === 'connected',
      address: l.ipAddress || null,
      ssid: l.ssid || null
    };
  }

  /* getStatus answers about every link the TV has; only the two with a socket
     behind them are of interest here (wifiDirect and p2p are not). */
  function pickNet(res) {
    if (!res || typeof res !== 'object') return null;
    if (!res.wifi && !res.wired) return null;
    return { wifi: pickLink(res.wifi), wired: pickLink(res.wired) };
  }

  function pickMacs(res) {
    if (!res || typeof res !== 'object') return null;
    var wifi = (res.wifiInfo && res.wifiInfo.macAddress) || null;
    var wired = (res.wiredInfo && res.wiredInfo.macAddress) || null;
    if (!wifi && !wired) return null;
    return { wifi: wifi, wired: wired };
  }

  /* cb(net, info) — { wifi, wired } each { connected, address, ssid }, or null. */
  function netStatus(cb) {
    var done = cb || noop;
    if (!available) { done(MOCK_NET, { mocked: true, error: null }); return; }
    chainData([
      { uri: NETWORK + '/getStatus', params: {}, pick: pickNet },
      { uri: SERVICE + '/netStatus', params: {}, pick: pickNet },
      hbRead(lunaSend(NETWORK + '/getStatus', {}), pickNet)
    ], done);
  }

  /* cb(macs, info) — { wifi, wired } hardware addresses, or null.
     The Bluetooth address is not here: it comes from btAdapter(). */
  function netMacs(cb) {
    var done = cb || noop;
    if (!available) { done(MOCK_MACS, { mocked: true, error: null }); return; }
    chainData([
      { uri: NETWORK + '/getinfo', params: {}, pick: pickMacs },
      { uri: SERVICE + '/netMacs', params: {}, pick: pickMacs },
      hbRead(lunaSend(NETWORK + '/getinfo', {}), pickMacs)
    ], done);
  }

  /* -------------------------------------------------------- device info --- */
  function systemInfo(cb) {
    call(SYSPROP + '/getSystemInfo',
      { keys: ['modelName', 'firmwareVersion', 'sdkVersion', 'UHD'] },
      function (res) { cb(res, { mocked: false, error: null }); },
      function (err) { cb(null, { mocked: !available, error: (err && err.errorText) || 'failed' }); });
  }

  /* The serial number of the set. It is asked for separately from the rest of
     getSystemInfo: on the firmwares that refuse this one key, asking for it
     together with the model would lose the model as well. */
  var MOCK_SERIAL = '000DEVBROWSER';
  /* nyx reads it straight from the hardware, which is the only source left when
     the system property service will not part with it. Needs root. */
  var NYX_SERIAL = 'nyx-cmd DeviceInfo query serial_number';

  /* A firmware with nothing to report answers the key as an empty string or as
     one of these placeholders; all of them mean "unknown", not a serial. */
  var NO_SERIAL = ['unknown', 'none', 'null', '(null)', 'n/a', '0'];

  function cleanSerial(text) {
    var out = String(text === null || typeof text === 'undefined' ? '' : text).trim();
    if (!out) return null;
    return NO_SERIAL.indexOf(out.toLowerCase()) < 0 ? out : null;
  }

  function pickSerial(res) {
    if (!res || typeof res !== 'object') return null;
    return cleanSerial(res.serialNumber);
  }

  /* cb(serial, info) — the string, or null when nobody would tell. */
  function serial(cb) {
    var done = cb || noop;
    if (!available) { done(MOCK_SERIAL, { mocked: true, error: null }); return; }
    chainData([
      { uri: SYSPROP + '/getSystemInfo', params: { keys: ['serialNumber'] }, pick: pickSerial },
      { uri: SERVICE + '/serial', params: {}, pick: pickSerial },
      hbRead(lunaSend(SYSPROP + '/getSystemInfo', { keys: ['serialNumber'] }), pickSerial),
      {
        uri: HBCHANNEL + '/exec',
        params: { command: NYX_SERIAL },
        // Plain stdout, not a luna reply: the whole line is the serial.
        pick: function (res) { return cleanSerial((res && (res.stdoutString || res.stdout)) || ''); }
      }
    ], done);
  }

  /* The keys osInfo/query knows; a firmware that lacks one simply omits it. */
  var OS_KEYS = ['webos_name', 'webos_release', 'webos_build_id', 'core_os_kernel_version'];

  function pickOs(res) {
    var o = (res && res.osInfo) || res;
    if (!o || typeof o !== 'object') return null;
    var out = {
      name: o.webos_name || null,
      release: o.webos_release || null,
      build: o.webos_build_id || null,
      kernel: o.core_os_kernel_version || null
    };
    // Nothing of what was asked for: let the next candidate try.
    if (!out.name && !out.release && !out.build && !out.kernel) return null;
    return out;
  }

  /* cb(os, info) — { name, release, build, kernel } or null.
     Reading is usually allowed, so the plain endpoint goes first. */
  function osInfo(cb) {
    var done = cb || noop;
    if (!available) { done(null, { mocked: true, error: 'no bridge' }); return; }
    chainData([
      { uri: SYSSERVICE + '/osInfo/query', params: { parameters: OS_KEYS }, pick: pickOs },
      { uri: SERVICE + '/osInfo', params: {}, pick: pickOs },
      hbRead(lunaSend(SYSSERVICE + '/osInfo/query', { parameters: OS_KEYS }), pickOs)
    ], done);
  }

  /* Seconds since boot. No luna service reports it, so /proc/uptime is read —
     by our helper service, or by the Homebrew Channel when it is not there.
     cb(seconds, info) with seconds === null when nobody could read it. */
  function uptime(cb) {
    var done = cb || noop;
    if (!available) { done(null, { mocked: true, error: 'no bridge' }); return; }
    chainData([
      {
        uri: SERVICE + '/uptime',
        params: {},
        pick: function (res) {
          var seconds = res && Number(res.uptime);
          return (typeof seconds === 'number' && isFinite(seconds)) ? seconds : null;
        }
      },
      {
        uri: HBCHANNEL + '/exec',
        params: { command: 'cat /proc/uptime' },
        pick: function (res) {
          // "123456.78 987654.32" — the first number is the one wanted.
          var seconds = parseFloat(String((res && (res.stdoutString || res.stdout)) || ''));
          return isFinite(seconds) ? seconds : null;
        }
      }
    ], done);
  }

  function locale(cb) {
    getSettings('option', ['localeInfo'], function (settings, info) {
      var locales = settings && settings.localeInfo && settings.localeInfo.locales;
      cb(locales ? (locales.UI || locales.TV || null) : null, info);
    });
  }

  /* Is the helper service there, and is it privileged?
     cb({ running: Boolean, root: Boolean, startTime: Number|null }) */
  function serviceStatus(cb) {
    call(SERVICE + '/status', {},
      function (res) {
        cb({
          running: true,
          root: !!(res && res.root),
          startTime: res && res.startTime ? res.startTime : null
        });
      },
      function () { cb({ running: false, root: false, mocked: !available }); });
  }

  /* Keepalive endpoint: returns version, IP addresses, and timestamp.
     Designed for external monitoring to keep the app alive.
     cb(data, info) where data = { version, wifi, wired, timestamp } */
  function keepalive(cb) {
    var done = cb || noop;
    if (!available) {
      var mock = {
        version: MOCK_KEEPALIVE.version,
        wifi: MOCK_KEEPALIVE.wifi,
        wired: MOCK_KEEPALIVE.wired,
        timestamp: Date.now(),
        serviceUptime: 0,
        clientUptime: Math.floor((Date.now() - (window.appStartTime || Date.now())) / 1000)
      };
      done(mock, { mocked: true, error: null });
      return;
    }
    call(SERVICE + '/keepalive', {},
      function (res) {
        done({
          version: res.version || null,
          wifi: res.wifi || null,
          wired: res.wired || null,
          timestamp: res.timestamp || null,
          serviceUptime: res.serviceUptime || 0,
          clientUptime: Math.floor((Date.now() - (window.appStartTime || Date.now())) / 1000)
        }, { mocked: false, error: null });
      },
      function (err) {
        done(null, { mocked: false, error: (err && err.errorText) || 'failed' });
      });
  }

  /* Enable self-keepalive (service calls itself every 30s).
     cb(success, info) */
  function enableSelfKeepalive(cb) {
    var done = cb || noop;
    if (!available) {
      done(false, { mocked: true, error: 'no bridge' });
      return;
    }
    call(SERVICE + '/enableSelfKeepalive', {},
      function (res) {
        done(res.enabled === true, {
          mocked: false,
          error: res.errorText || null
        });
      },
      function (err) {
        done(false, {
          mocked: false,
          error: (err && err.errorText) || 'enable failed'
        });
      });
  }

  /* Disable self-keepalive (stop internal interval).
     cb(success, info) */
  function disableSelfKeepalive(cb) {
    var done = cb || noop;
    if (!available) {
      done(false, { mocked: true, error: 'no bridge' });
      return;
    }
    call(SERVICE + '/disableSelfKeepalive', {},
      function (res) {
        done(res.enabled === false, {
          mocked: false,
          error: res.errorText || null
        });
      },
      function (err) {
        done(false, {
          mocked: false,
          error: (err && err.errorText) || 'disable failed'
        });
      });
  }

  /* Check self-keepalive status.
     cb(status, info) where status = { enabled: bool } */
  function selfKeepaliveStatus(cb) {
    var done = cb || noop;
    if (!available) {
      done({ enabled: false }, { mocked: true, error: null });
      return;
    }
    call(SERVICE + '/selfKeepaliveStatus', {},
      function (res) {
        done({
          enabled: res.enabled === true
        }, { mocked: false, error: null });
      },
      function (err) {
        done({ enabled: false }, {
          mocked: false,
          error: (err && err.errorText) || 'status check failed'
        });
      });
  }

  /* Install keepalive daemon as init.d symlink.
     No row calls this or the two below any more: a root service puts the init
     script in place by itself at every start. They stay for debugging from the
     console (install by hand, take it out, ask how it is).
     cb(success, info) */
  function installKeepalive(cb) {
    var done = cb || noop;
    if (!available) {
      done(false, { mocked: true, error: 'no bridge' });
      return;
    }
    call(SERVICE + '/installKeepalive', {},
      function (res) {
        done(res.installed === true, {
          mocked: false,
          error: res.errorText || null,
          root: res.root
        });
      },
      function (err) {
        done(false, {
          mocked: false,
          error: (err && err.errorText) || 'install failed'
        });
      });
  }

  /* Uninstall keepalive daemon (remove symlink and stop process).
     cb(success, info) */
  function uninstallKeepalive(cb) {
    var done = cb || noop;
    if (!available) {
      done(false, { mocked: true, error: 'no bridge' });
      return;
    }
    call(SERVICE + '/uninstallKeepalive', {},
      function (res) {
        done(res.uninstalled === true, {
          mocked: false,
          error: res.errorText || null,
          root: res.root
        });
      },
      function (err) {
        done(false, {
          mocked: false,
          error: (err && err.errorText) || 'uninstall failed'
        });
      });
  }

  /* Check keepalive daemon status.
     cb(status, info) where status = { installed: bool, running: bool } */
  function keepaliveStatus(cb) {
    var done = cb || noop;
    if (!available) {
      done({ installed: false, running: false }, { mocked: true, error: null });
      return;
    }
    call(SERVICE + '/keepaliveStatus', {},
      function (res) {
        done({
          installed: res.installed === true,
          running: res.running === true
        }, { mocked: false, error: null, root: res.root });
      },
      function (err) {
        done({ installed: false, running: false }, {
          mocked: false,
          error: (err && err.errorText) || 'status check failed'
        });
      });
  }

  /* Ask the Homebrew Channel to elevate our helper service -- the only way it is
     done, and the row behind it is Tweaks -> Request privileges. The web app
     itself never gains rights: only the separate service process is respawned as
     root.
     cb(root, status) with status as reported by serviceStatus() afterwards. */
  function elevate(cb) {
    var done = cb || noop;
    if (!available) { done(false, { running: false, root: false, mocked: true }); return; }

    chain([
      hbShell(HB_DIR + '/elevate-service ' + SERVICE_ID),
      hbShell('/bin/sh ' + HB_DIR + '/elevate-service ' + SERVICE_ID)
    ], function (ok, info) {
      if (!ok) { done(false, { running: false, root: false, error: info && info.error }); return; }

      // The unprivileged instance has to die so the hub respawns it elevated.
      // The [w] pattern keeps pkill from matching its own command line.
      var pkillPattern = '[' + SERVICE_ID.charAt(0) + ']' + SERVICE_ID.slice(1);
      call(HBCHANNEL + '/exec',
        { command: 'pkill -f "' + pkillPattern + '" || true; ls-control scan-services || true' },
        recheck, recheck);
    });

    /* The hub needs a moment to pick the new role files up. */
    function recheck() {
      setTimeout(function () {
        serviceStatus(function (status) { done(!!status.root, status); });
      }, 1500);
    }
  }

  /* What df(1) says about /mnt/lg/appstore, verbatim: the partition an app is
     really installed into, and the only free-space figure that matters to whoever
     is putting homebrew on the set. The panel does the parsing, so both paths
     hand back the raw text.
     cb(text, info) with text === null when nobody could run it. */
  function pickDf(res) {
    var text = String((res && (res.storage || res.stdoutString || res.stdout)) || '').trim();
    return text ? text : null;
  }

  /* What df prints on a set, so a browser has a block with figures in it rather
     than four dashes. The layout is what matters here: the numbers are plainly
     not this machine's. */
  var MOCK_DF = [
    'Filesystem                Size      Used Available Use% Mounted on',
    '/dev/mapper/appstore       3.5G      1.2G      2.2G  35% /mnt/lg/appstore'
  ].join('\n');

  function storage(cb) {
    var done = cb || noop;
    if (!available) { done(MOCK_DF, { mocked: true, error: null }); return; }
    chainData([
      { uri: SERVICE + '/storage', params: {}, pick: pickDf },
      { uri: HBCHANNEL + '/exec', params: { command: 'df -h /mnt/lg/appstore' }, pick: pickDf }
    ], done);
  }

  /* List all installed applications. cb(apps) where apps is an array or null. */
  function listApps(cb) {
    var done = cb || noop;
    if (!available) { done(null); return; }

    /* Try helper service first (has root privileges). */
    call(SERVICE + '/listApps', {},
      function (res) {
        done((res && res.apps) || []);
      },
      function () {
        /* Fallback to direct call if helper unavailable. */
        call(APPMGR + '/listApps', {},
          function (res) {
            done((res && res.apps) || []);
          },
          function () {
            done(null);
          });
      });
  }

  /* Get list of currently running applications. cb(running) where running is an
     array of running app objects or null on failure. */
  function runningApps(cb) {
    var done = cb || noop;
    if (!available) { done(null); return; }

    /* Try helper service first (has root privileges). */
    call(SERVICE + '/running', {},
      function (res) {
        done((res && res.running) || []);
      },
      function () {
        /* Fallback to direct call if helper unavailable. */
        call(APPMGR + '/running', {},
          function (res) {
            done((res && res.running) || []);
          },
          function () {
            done(null);
          });
      });
  }

  /* List all launch points. cb(launchPoints) where launchPoints is an array or null. */
  function listLaunchPoints(cb) {
    var done = cb || noop;
    if (!available) { done(null); return; }

    /* Try helper service first (has root privileges). */
    call(SERVICE + '/listLaunchPoints', {},
      function (res) {
        done((res && res.launchPoints) || []);
      },
      function () {
        /* Fallback to direct call if helper unavailable. */
        call(APPMGR + '/listLaunchPoints', {},
          function (res) {
            done((res && res.launchPoints) || []);
          },
          function () {
            done(null);
          });
      });
  }

  /* Check if an application with the given ID exists in the system.
     cb(exists, appInfo, info) where exists is true if found, appInfo is the app
     object from listApps (or null), info = { mocked, error }.
     Uses the helper service if available, falls back to direct call. */
  function checkAppExists(appId, cb) {
    var done = cb || noop;
    if (!available) { done(false, null, { mocked: true, error: 'no bridge' }); return; }
    console.log('[luna] checkAppExists: looking for appId="' + appId + '"');

    /* Try helper service first (has root), then direct call. */
    function tryDirect() {
      console.log('[luna] checkAppExists: trying direct applicationmanager call');
      call(APPMGR + '/listApps', {},
        function (res) {
          var apps = (res && res.apps) || [];
          console.log('[luna] checkAppExists: direct call returned ' + apps.length + ' apps');
          processAppList(apps);
        },
        function (res) {
          console.warn('[luna] checkAppExists: direct call failed: ' + ((res && res.errorText) || 'unknown error'));
          done(false, null, { mocked: false, error: (res && res.errorText) || 'listApps failed' });
        });
    }

    function processAppList(apps) {
      var found = null;
      for (var i = 0; i < apps.length; i++) {
        if (apps[i].id === appId) {
          found = apps[i];
          break;
        }
      }
      if (found) {
        console.log('[luna] checkAppExists: found app "' + appId + '": systemApp=' +
                    found.systemApp + ', folderPath=' + (found.folderPath || 'null'));
      } else {
        console.log('[luna] checkAppExists: app "' + appId + '" not found');
      }
      done(!!found, found, { mocked: false, error: null });
    }

    /* Try service first. */
    call(SERVICE + '/listApps', {},
      function (res) {
        var apps = (res && res.apps) || [];
        console.log('[luna] checkAppExists: service returned ' + apps.length + ' apps');
        processAppList(apps);
      },
      function () {
        console.log('[luna] checkAppExists: service not available, trying direct');
        tryDirect();
      });
  }

  /* Switch the app ID by running the switch-app-id.sh script.
     The script copies the application to a new path and updates JSON files.
     Requires root privileges (Homebrew Channel).
     cb(ok, info) where ok is true if the switch succeeded. */
  /* Clone app to a new ID by repackaging IPK and installing via Luna Service.
     This is the recommended method as it uses standard webOS installation.
     zygote script creates IPK from installed app and installs it. */
  function switchAppId(newId, cb) {
    var done = cb || noop;
    if (!available) { done(false, { mocked: true, error: 'no bridge' }); return; }

    console.log('[luna] switchAppId: calling cloneAppId for "' + newId + '"');

    /* Call our service to handle the cloning + installation */
    call(SERVICE + '/cloneAppId', { newId: newId },
      function (res) {
        console.log('[luna] cloneAppId response:', JSON.stringify(res));
        var success = res && res.returnValue === true;
        done(success, {
          mocked: false,
          error: success ? null : (res.errorText || 'cloning failed'),
          output: res.output || ''
        });
      },
      function (res) {
        console.log('[luna] cloneAppId error:', JSON.stringify(res));
        done(false, {
          mocked: false,
          error: (res && res.errorText) || 'cloneAppId call failed'
        });
      });
  }

  /* Patch appinfo.json fields: lockable and defaultWindowType.
     cb(ok, info) where info = { output, note, errorText } */
  function patchAppInfo(lockable, windowType, cb) {
    var done = cb || noop;
    if (!available) {
      done(false, { mocked: true, error: 'no bridge' });
      return;
    }

    var params = {};
    if (typeof lockable !== 'undefined') params.lockable = lockable;
    if (typeof windowType !== 'undefined') params.windowType = windowType;

    call(SERVICE + '/patchAppInfo', params,
      function (res) {
        console.log('[luna] patchAppInfo succeeded');
        done(true, res);
      },
      function (err) {
        console.warn('[luna] patchAppInfo failed: ' + (err && err.errorText));
        done(false, err);
      });
  }

  return {
    isAvailable: function () { return available; },
    call: call,
    subscribe: subscribe,
    getSettings: getSettings,
    readSetting: readSetting,
    setSetting: setSetting,
    turnOffScreen: turnOffScreen,
    turnOnScreen: turnOnScreen,
    mute: mute,
    reboot: reboot,
    powerOff: powerOff,
    btDevices: btDevices,
    btAdapter: btAdapter,
    btConnect: btConnect,
    btDisconnect: btDisconnect,
    netStatus: netStatus,
    netMacs: netMacs,
    systemInfo: systemInfo,
    serial: serial,
    osInfo: osInfo,
    uptime: uptime,
    locale: locale,
    serviceStatus: serviceStatus,
    keepalive: keepalive,
    enableSelfKeepalive: enableSelfKeepalive,
    disableSelfKeepalive: disableSelfKeepalive,
    selfKeepaliveStatus: selfKeepaliveStatus,
    installKeepalive: installKeepalive,
    uninstallKeepalive: uninstallKeepalive,
    keepaliveStatus: keepaliveStatus,
    elevate: elevate,
    storage: storage,
    listApps: listApps,
    runningApps: runningApps,
    listLaunchPoints: listLaunchPoints,
    checkAppExists: checkAppExists,
    switchAppId: switchAppId,
    patchAppInfo: patchAppInfo
  };
})();
