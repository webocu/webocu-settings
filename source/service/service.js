/* =========================================================================
   Privileged helper service for WebOCU Settings.

   A web app installed in Developer Mode is not allowed to call the power
   endpoints, so the app delegates them to this service. The service itself
   only becomes privileged after it is elevated to root, which on a rooted TV
   is done by the Homebrew Channel, asked for from inside the app: silently at
   every start while the service has no root (Settings.autoElevate), and by hand
   from

     App properties -> Tweaks -> Request privileges
     (Luna.elevate() runs elevate-service <this service id> as root)

   Once root, it also keeps the keepalive init script in place (bottom of this
   file).

   Until then every method still answers, but with returnValue: false and the
   errorText of the underlying luna call, so the app can fall back and the
   reason shows up in the app log.

   Node on webOS TV is old, so this file stays ES5: var, no arrow functions,
   no template literals. `webos-service` ships with the firmware.
   ========================================================================= */
var Service = require('webos-service');
var childProcess = require('child_process');
var fs = require('fs');

var SERVICE_ID = 'webocu.settings.service';
var service = new Service(SERVICE_ID);

/* Track service start time for uptime reporting in Debug menu. */
var serviceStartTime = Date.now();

/* Cache app version from package.json for keepalive endpoint. */
var appVersion = 'unknown';
try {
  appVersion = require('./package.json').version;
} catch (e) {
  log('Failed to read package.json version: ' + e.message);
}

var SYSSERVICE = 'luna://com.webos.service.systemservice/';
var SYSPROP = 'luna://com.webos.service.tv.systemproperty/';
var TVPOWER = 'luna://com.webos.service.tvpower/power/';
var POWER = 'luna://com.webos.service.power/shutdown/';
/* tvpower/power/reboot turns the TV off instead of restarting it, so a restart
   goes through the sleep service, the same call a real restart uses. */
var SLEEP = 'luna://com.webos.service.sleep/shutdown/';
/* Both names of the settings service: which one the hub knows depends on the
   firmware, and the wrong one just answers "service does not exist". */
var SETTINGS = ['luna://com.webos.settingsservice/', 'luna://com.webos.service.settings/'];

/* Every (service name, category) pair, in the order they are tried. */
function settingsTargets(categories) {
  var out = [];
  SETTINGS.forEach(function (uri) {
    categories.forEach(function (category) { out.push({ uri: uri, category: category }); });
  });
  return out;
}
var BT = 'luna://com.webos.service.bluetooth/';
var BT2 = 'luna://com.webos.service.bluetooth2/';
var NETWORK = 'luna://com.webos.service.connectionmanager/';
/* master/setMute is the call the mute key sends; the service has had two names. */
var AUDIO = ['luna://com.webos.service.audio/', 'luna://com.webos.audio/'];

/* Some builds ignore a reason they do not know, so this is the remote's own. */
var REASON = 'remoteKey';
var SHELL_TIMEOUT = 5000;
var ADDRESS = /^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$/;

function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function log(text) {
  console.log('[' + SERVICE_ID + '] ' + text);
}

function shell(command, cb, timeout) {
  var execTimeout = timeout || SHELL_TIMEOUT;
  childProcess.exec(command, { timeout: execTimeout }, function (error, stdout, stderr) {
    if (error) { cb(false, String(error.message)); return; }
    cb(true, String(stdout || stderr || '').trim());
  });
}

/* Walk the candidates until one answers with returnValue: true.
   A candidate is either { uri, params } or { shell: 'command', rootOnly: true }. */
function runChain(candidates, message, extra) {
  var index = 0;

  function done(payload) {
    payload.root = isRoot();
    if (extra) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) payload[key] = extra[key];
      }
    }
    message.respond(payload);
  }

  function attempt() {
    if (index >= candidates.length) {
      done({ returnValue: false, errorText: 'all endpoints failed' });
      return;
    }
    var candidate = candidates[index++];

    if (candidate.shell) {
      if (candidate.rootOnly && !isRoot()) { attempt(); return; }
      shell(candidate.shell, function (ok, detail) {
        if (ok) { done({ returnValue: true, via: 'shell: ' + candidate.shell }); return; }
        log('shell failed (' + candidate.shell + '): ' + detail);
        attempt();
      });
      return;
    }

    service.call(candidate.uri, candidate.params || {}, function (reply) {
      var payload = (reply && reply.payload) || {};
      if (payload.returnValue === false) {
        log(candidate.uri + ' failed: ' + payload.errorText);
        attempt();
        return;
      }
      done({ returnValue: true, via: candidate.uri });
    });
  }

  attempt();
}

/* Same walk, but the reply matters: pick(payload) returns the fields to answer
   with, or null when this endpoint had nothing useful to say. */
function readChain(candidates, message, pick) {
  var index = 0;

  function attempt() {
    if (index >= candidates.length) {
      message.respond({ returnValue: false, errorText: 'all endpoints failed', root: isRoot() });
      return;
    }
    var candidate = candidates[index++];
    service.call(candidate.uri, candidate.params || {}, function (reply) {
      var payload = (reply && reply.payload) || {};
      var data = payload.returnValue === false ? null : pick(payload);
      if (data === null || typeof data === 'undefined') {
        log(candidate.uri + ' gave nothing: ' + (payload.errorText || 'no data'));
        attempt();
        return;
      }
      data.returnValue = true;
      data.via = candidate.uri;
      data.root = isRoot();
      message.respond(data);
    });
  }

  attempt();
}

/* ----------------------------------------------------------------- status -- */
/* Lets the app show whether the privileged path is actually available. */
service.register('status', function (message) {
  message.respond({
    returnValue: true,
    service: SERVICE_ID,
    root: isRoot(),
    uid: typeof process.getuid === 'function' ? process.getuid() : -1,
    node: process.version,
    startTime: serviceStartTime
  });
});

/* ---------------------------------------------------------------- keepalive -- */
/* Lightweight endpoint for external keepalive monitoring. Returns version,
   network IP addresses, and timestamp. Designed to be called periodically
   (e.g., via cron) to prevent the system from closing the application. */
service.register('keepalive', function (message) {
  var timestamp = Date.now();
  var responded = false;

  /* Try to get network status, but don't block on it. */
  service.call(NETWORK + 'getStatus', {}, function (reply) {
    if (responded) return;
    responded = true;

    var payload = (reply && reply.payload) || {};
    var wifi = null;
    var wired = null;

    if (payload.returnValue !== false) {
      /* Extract IP addresses from wifi and wired links. */
      if (payload.wifi && payload.wifi.ipAddress) {
        wifi = { ipAddress: payload.wifi.ipAddress };
      }
      if (payload.wired && payload.wired.ipAddress) {
        wired = { ipAddress: payload.wired.ipAddress };
      }
    }

    message.respond({
      returnValue: true,
      version: appVersion,
      wifi: wifi,
      wired: wired,
      timestamp: timestamp,
      serviceUptime: Math.floor((Date.now() - serviceStartTime) / 1000),
      root: isRoot()
    });
  });

  /* Timeout fallback: if network call takes too long, respond without IPs. */
  setTimeout(function () {
    if (responded) return;
    responded = true;

    message.respond({
      returnValue: true,
      version: appVersion,
      wifi: null,
      wired: null,
      timestamp: timestamp,
      serviceUptime: Math.floor((Date.now() - serviceStartTime) / 1000),
      root: isRoot()
    });
  }, 2000);
});

/* ------------------------------------------------------------- system info -- */
/* osInfo/query is refused to an unprivileged web app on some firmwares, so the
   service offers it as well. The keys are answered flat, the way luna does. */
var OS_KEYS = ['webos_name', 'webos_release', 'webos_build_id', 'core_os_kernel_version'];

service.register('osInfo', function (message) {
  readChain([
    { uri: SYSSERVICE + 'osInfo/query', params: { parameters: OS_KEYS } }
  ], message, function (payload) {
    var out = {};
    OS_KEYS.forEach(function (key) { if (payload[key]) out[key] = payload[key]; });
    return Object.keys(out).length ? out : null;
  });
});

/* The serial number of the set. getSystemInfo answers it to an unprivileged app
   on most builds; where it does not, nyx reads it from the hardware, and that
   needs the root the app itself can never have. Answered in luna's own shape so
   one parser on the app side reads both paths. */
var NYX_SERIAL = 'nyx-cmd DeviceInfo query serial_number';
var NO_SERIAL = ['unknown', 'none', 'null', '(null)', 'n/a', '0'];

function cleanSerial(text) {
  var out = String(text === null || typeof text === 'undefined' ? '' : text).trim();
  if (!out) return null;
  return NO_SERIAL.indexOf(out.toLowerCase()) < 0 ? out : null;
}

service.register('serial', function (message) {
  service.call(SYSPROP + 'getSystemInfo', { keys: ['serialNumber'] }, function (reply) {
    var payload = (reply && reply.payload) || {};
    var fromLuna = payload.returnValue === false ? null : cleanSerial(payload.serialNumber);
    if (fromLuna) {
      message.respond({ returnValue: true, serialNumber: fromLuna, via: SYSPROP, root: isRoot() });
      return;
    }
    log('getSystemInfo gave no serial: ' + (payload.errorText || 'empty'));
    shell(NYX_SERIAL, function (ok, out) {
      var fromNyx = ok ? cleanSerial(out) : null;
      if (!fromNyx) {
        message.respond({
          returnValue: false,
          errorText: ok ? 'nyx reported no serial' : out,
          root: isRoot()
        });
        return;
      }
      message.respond({ returnValue: true, serialNumber: fromNyx, via: 'shell: nyx-cmd', root: isRoot() });
    });
  });
});

/* Seconds since boot. There is no luna endpoint for it — /proc/uptime is
   world-readable, so this one answers even before the service is elevated. */
service.register('uptime', function (message) {
  fs.readFile('/proc/uptime', 'utf8', function (error, text) {
    var seconds = error ? NaN : parseFloat(String(text).split(' ')[0]);
    if (!isFinite(seconds)) {
      message.respond({
        returnValue: false,
        errorText: error ? String(error.message) : 'unreadable /proc/uptime',
        root: isRoot()
      });
      return;
    }
    message.respond({ returnValue: true, uptime: seconds, root: isRoot() });
  });
});

/* How much room is left where the apps live. df(1) and not statvfs: busybox df
   is what a webOS set has and the panel shows exactly what it printed.

   Try multiple paths: /mnt/lg/appstore (retail firmware), /media/developer/apps
   (developer mode), /media/cryptofs/apps (rooted). */
service.register('storage', function (message) {
  var paths = ['/mnt/lg/appstore', '/media/developer/apps', '/media/cryptofs/apps'];
  var index = 0;

  function attempt() {
    if (index >= paths.length) {
      message.respond({
        returnValue: false,
        errorText: 'all storage paths failed',
        root: isRoot()
      });
      return;
    }
    var path = paths[index++];
    shell('df -h ' + path, function (ok, out) {
      if (ok && out) {
        message.respond({ returnValue: true, storage: out, root: isRoot() });
        return;
      }
      log('df -h ' + path + ' failed: ' + (out || 'empty'));
      attempt();
    });
  }

  attempt();
});

/* ------------------------------------------------------------------ power -- */
service.register('reboot', function (message) {
  log('reboot requested (root=' + isRoot() + ')');
  runChain([
    { uri: SLEEP + 'machineReboot', params: { reason: REASON } },
    { uri: POWER + 'machineReboot', params: { reason: REASON } },
    // Last resort: the kernel path. Only reachable once elevated.
    { shell: 'sync; /sbin/reboot', rootOnly: true }
  ], message);
});

service.register('powerOff', function (message) {
  log('powerOff requested (root=' + isRoot() + ')');
  runChain([
    { uri: TVPOWER + 'powerOff', params: { reason: REASON } },
    { uri: POWER + 'machineOff', params: { reason: REASON } },
    // Hard cut, not the usual standby: only if luna refuses both endpoints.
    { shell: 'sync; /sbin/poweroff', rootOnly: true }
  ], message);
});

/* ----------------------------------------------------------------- screen -- */
/* Called without parameters: standbyMode leaves the backlight on, so the panel
   only looks dark. The bare call is what really blanks it. */
service.register('screenOff', function (message) {
  runChain([
    { uri: TVPOWER + 'turnOffScreen', params: {} }
  ], message);
});

service.register('screenOn', function (message) {
  runChain([
    { uri: TVPOWER + 'turnOnScreen', params: {} }
  ], message);
});

/* ------------------------------------------------------------------ sound -- */
/* Both names of the audio service are tried: which one the hub knows depends on
   the firmware, exactly as with the settings service. The payload is passed
   through, so unmuting is the same call. */
service.register('mute', function (message) {
  var wanted = { mute: ((message.payload || {}).mute) !== false };
  runChain(AUDIO.map(function (uri) {
    return { uri: uri + 'master/setMute', params: wanted };
  }), message);
});


/* ---------------------------------------------------------------- network -- */
/* The state of the two links and the hardware addresses. Both are answered in
   the shape connectionmanager itself uses, so the app can read the plain reply
   and this one with the same code. */
function linkOf(payload, key) {
  var link = payload[key];
  if (!link || typeof link !== 'object') return null;
  return { state: link.state || null, ipAddress: link.ipAddress || null, ssid: link.ssid || null };
}

service.register('netStatus', function (message) {
  readChain([
    { uri: NETWORK + 'getStatus', params: {} }
  ], message, function (payload) {
    var wifi = linkOf(payload, 'wifi');
    var wired = linkOf(payload, 'wired');
    if (!wifi && !wired) return null;
    return { wifi: wifi || {}, wired: wired || {} };
  });
});

service.register('netMacs', function (message) {
  readChain([
    { uri: NETWORK + 'getinfo', params: {} }
  ], message, function (payload) {
    var wifi = (payload.wifiInfo && payload.wifiInfo.macAddress) || null;
    var wired = (payload.wiredInfo && payload.wiredInfo.macAddress) || null;
    if (!wifi && !wired) return null;
    return { wifiInfo: { macAddress: wifi }, wiredInfo: { macAddress: wired } };
  });
});

/* -------------------------------------------------------------- bluetooth -- */
/* Reading the trusted devices and connecting one of them is privileged on some
   firmwares. Pairing is not offered here: that stays in the TV settings. */

function deviceList(payload) {
  var list = payload.devices || payload.trustedDevices || payload.pairedDevices || payload.results;
  if (!list || typeof list.length !== 'number') return null;   // empty list = nothing paired
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var device = list[i] || {};
    if (!ADDRESS.test(String(device.address || ''))) continue;
    var profiles = device.connectedProfiles || device.connectedRoles;
    out.push({
      address: device.address,
      name: String(device.name || device.friendlyName || ''),
      connected: device.state === true || device.connected === true ||
                 device.state === 'connected' || !!(profiles && profiles.length)
    });
  }
  return { devices: out };
}

service.register('btDevices', function (message) {
  readChain([
    // The legacy interface answers on webOS 7; bluetooth2/device/
    // getPairedDevices only exists from API level 12 on.
    { uri: BT + 'gap/getTrustedDevices', params: { service: 'audio' } },
    { uri: BT2 + 'device/getPairedDevices', params: {} }
  ], message, deviceList);
});

service.register('btAdapter', function (message) {
  readChain([
    { uri: BT2 + 'adapter/getStatus', params: {} }
  ], message, function (payload) {
    var a = (payload.adapters && payload.adapters.length) ? payload.adapters[0] : payload;
    if (typeof a.powered === 'undefined' && typeof a.discovering === 'undefined') return null;
    return {
      powered: !!a.powered,
      discovering: !!a.discovering,
      address: a.adapterAddress || a.address || null
    };
  });
});

/* connect / disconnect of the audio profile of one already paired device. */
function btProfile(message, method) {
  var address = (message.payload || {}).address;
  if (!ADDRESS.test(String(address || ''))) {
    message.respond({ returnValue: false, errorText: 'a bluetooth address is required', root: isRoot() });
    return;
  }
  log('bluetooth ' + method + ' ' + address + ' (root=' + isRoot() + ')');
  runChain([
    { uri: BT + 'service/' + method, params: { service: 'audio', address: address } },
    { uri: BT2 + 'a2dp/' + method, params: { address: address } }
  ], message, { address: address });
}

service.register('btConnect', function (message) { btProfile(message, 'connect'); });
service.register('btDisconnect', function (message) { btProfile(message, 'disconnect'); });

/* --------------------------------------------------------------- settings -- */
/* Proxy for com.webos.settingsservice: some categories are writable only for
   privileged callers. Params: { categories: [...], key: '...', value: ... } */
service.register('setSetting', function (message) {
  var params = message.payload || {};
  var categories = params.categories || (params.category ? [params.category] : []);
  if (!params.key || !categories.length) {
    message.respond({ returnValue: false, errorText: 'categories and key are required' });
    return;
  }
  var settings = {};
  settings[params.key] = params.value;
  // Companion keys the caller wants written in the same call.
  var extra = params.extra || {};
  Object.keys(extra).forEach(function (name) { settings[name] = extra[name]; });

  runChain(settingsTargets(categories).map(function (target) {
    return {
      uri: target.uri + 'setSystemSettings',
      params: { category: target.category, settings: settings }
    };
  }), message, { key: params.key });
});

service.register('getSetting', function (message) {
  var params = message.payload || {};
  var categories = params.categories || (params.category ? [params.category] : []);
  if (!params.key || !categories.length) {
    message.respond({ returnValue: false, errorText: 'categories and key are required' });
    return;
  }

  var targets = settingsTargets(categories);
  var index = 0;
  function attempt() {
    if (index >= targets.length) {
      message.respond({ returnValue: false, errorText: 'not found', root: isRoot() });
      return;
    }
    var target = targets[index++];
    service.call(target.uri + 'getSystemSettings', { category: target.category, keys: [params.key] }, function (reply) {
      var payload = (reply && reply.payload) || {};
      var settings = payload.settings || {};
      if (payload.returnValue !== false && typeof settings[params.key] !== 'undefined') {
        message.respond({
          returnValue: true, key: params.key, value: settings[params.key],
          category: target.category, via: target.uri, root: isRoot()
        });
        return;
      }
      attempt();
    });
  }
  attempt();
});

/* -------------------------------------------------------------- app management -- */
/* List all applications. Proxy for applicationmanager/listApps. */
service.register('listApps', function (message) {
  service.call('luna://com.webos.service.applicationmanager/listApps', {}, function (reply) {
    var payload = (reply && reply.payload) || {};
    if (payload.returnValue === false) {
      log('listApps failed: ' + (payload.errorText || 'unknown error'));
      message.respond({
        returnValue: false,
        errorText: payload.errorText || 'listApps failed',
        root: isRoot()
      });
      return;
    }
    message.respond({
      returnValue: true,
      apps: payload.apps || [],
      root: isRoot()
    });
  });
});

/* Get currently running applications. Proxy for applicationmanager/running. */
service.register('running', function (message) {
  service.call('luna://com.webos.service.applicationmanager/running', {}, function (reply) {
    var payload = (reply && reply.payload) || {};
    if (payload.returnValue === false) {
      log('running failed: ' + (payload.errorText || 'unknown error'));
      message.respond({
        returnValue: false,
        errorText: payload.errorText || 'running failed',
        root: isRoot()
      });
      return;
    }
    message.respond({
      returnValue: true,
      running: payload.running || [],
      root: isRoot()
    });
  });
});

/* List all launch points. Proxy for applicationmanager/listLaunchPoints. */
service.register('listLaunchPoints', function (message) {
  service.call('luna://com.webos.service.applicationmanager/listLaunchPoints', {}, function (reply) {
    var payload = (reply && reply.payload) || {};
    if (payload.returnValue === false) {
      log('listLaunchPoints failed: ' + (payload.errorText || 'unknown error'));
      message.respond({
        returnValue: false,
        errorText: payload.errorText || 'listLaunchPoints failed',
        root: isRoot()
      });
      return;
    }
    message.respond({
      returnValue: true,
      launchPoints: payload.launchPoints || [],
      root: isRoot()
    });
  });
});

/* -------------------------------------------------------------- app cloning -- */
/* Clone app to a new ID by repackaging IPK and installing it.
   The zygote script creates AND installs the IPK, then returns exit code. */
service.register('cloneAppId', function (message) {
  var newId = (message.payload || {}).newId;
  if (!newId) {
    message.respond({ returnValue: false, errorText: 'newId is required', root: isRoot() });
    return;
  }

  log('cloneAppId requested: ' + newId + ' (root=' + isRoot() + ')');

  var currentId = SERVICE_ID.replace('.service', '');
  var zygoteScript = '/media/developer/apps/usr/palm/applications/' + currentId + '/tweaks/zygote.sh';
  var outputIpk = '/tmp/zygote_' + newId + '_clone.ipk';

  /* Run zygote script - it creates AND installs the IPK */
  var zygoteCmd = 'sh ' + zygoteScript + ' ' + currentId + ' ' + newId + ' ' + outputIpk;
  log('Running: ' + zygoteCmd);

  /* Increased timeout: 30 seconds (creation 5s + installation 25s) */
  shell(zygoteCmd, function (ok, output) {
    log('Zygote script completed: ok=' + ok);
    log('Output: ' + output);

    if (ok) {
      /* Success - zygote script installed the app */
      message.respond({
        returnValue: true,
        newId: newId,
        output: output,
        root: isRoot()
      });
    } else {
      /* Failure - zygote script returned exit code != 0 */
      message.respond({
        returnValue: false,
        errorText: 'Installation failed (see output)',
        output: output,
        root: isRoot()
      });
    }

    /* Cleanup IPK file */
    shell('rm -f ' + outputIpk, function () {});
  }, 30000); /* 30 second timeout */
});

/* --------------------------------------------------------- appinfo patching -- */
/* Modify lockable and defaultWindowType fields in the deployed appinfo.json.
   Allows testing window behaviors without redeployment.
   Requires the app to be restarted for changes to take effect. */
service.register('patchAppInfo', function (message) {
  var payload = message.payload || {};
  var lockable = payload.lockable;
  var windowType = payload.windowType;

  /* Validate at least one parameter is provided */
  if (typeof lockable === 'undefined' && typeof windowType === 'undefined') {
    message.respond({
      returnValue: false,
      errorText: 'At least one parameter required: lockable or windowType',
      root: isRoot()
    });
    return;
  }

  /* Validate lockable if provided */
  if (typeof lockable !== 'undefined' && lockable !== true && lockable !== false) {
    message.respond({
      returnValue: false,
      errorText: 'lockable must be true or false',
      root: isRoot()
    });
    return;
  }

  /* Validate windowType if provided */
  var validTypes = ['popup', 'overlay', 'card', 'minimal', 'home', 'system_ui'];
  if (typeof windowType !== 'undefined' && validTypes.indexOf(windowType) < 0) {
    message.respond({
      returnValue: false,
      errorText: 'windowType must be one of: ' + validTypes.join(', '),
      root: isRoot()
    });
    return;
  }

  log('patchAppInfo requested: lockable=' + lockable + ', windowType=' + windowType);

  var currentId = SERVICE_ID.replace('.service', '');
  var patchScript = '/media/developer/apps/usr/palm/applications/' + currentId + '/tweaks/patch_appinfo.sh';

  /* Build command with arguments */
  var args = [currentId];
  if (typeof windowType !== 'undefined') {
    args.push('windowType=' + windowType);
  } else {
    args.push('');  /* Empty placeholder */
  }

  var patchCmd = 'sh ' + patchScript + ' ' + args.join(' ');
  log('Running: ' + patchCmd);

  /* Execute with 5 second timeout (this is a quick operation) */
  shell(patchCmd, function (ok, output) {
    log('patch_appinfo.sh completed: ok=' + ok);
    log('Output: ' + output);

    if (ok && output.indexOf('SUCCESS') >= 0) {
      message.respond({
        returnValue: true,
        output: output,
        root: isRoot(),
        note: 'Restart the app for changes to take effect'
      });
    } else {
      message.respond({
        returnValue: false,
        errorText: ok ? 'Script did not report success' : 'Script execution failed',
        output: output,
        root: isRoot()
      });
    }
  }, 5000);  /* 5 second timeout */
});

/* ------------------------------------------------------ keepalive self -- */
/* Self-keepalive: service calls its own /keepalive endpoint periodically
   from within the same process. This prevents the app from being closed
   by the system without needing external daemon or root privileges. */

var selfKeepaliveInterval = null;
var SELF_KEEPALIVE_PERIOD = 30000; /* 30 seconds */

service.register('enableSelfKeepalive', function (message) {
  if (selfKeepaliveInterval) {
    /* Already running */
    message.respond({
      returnValue: true,
      alreadyRunning: true,
      enabled: true
    });
    return;
  }

  log('enableSelfKeepalive: starting internal keepalive interval');

  /* Call /keepalive immediately, then every 30 seconds */
  function callSelfKeepalive() {
    service.call('luna://' + SERVICE_ID + '/keepalive', {}, function (reply) {
      var payload = (reply && reply.payload) || {};
      if (payload.returnValue) {
        log('self-keepalive: called successfully, uptime=' + (payload.serviceUptime || '?'));
      } else {
        log('self-keepalive: call failed - ' + (payload.errorText || 'unknown'));
      }
    });
  }

  /* First call immediately */
  callSelfKeepalive();

  /* Then set interval */
  selfKeepaliveInterval = setInterval(callSelfKeepalive, SELF_KEEPALIVE_PERIOD);

  message.respond({
    returnValue: true,
    enabled: true,
    period: SELF_KEEPALIVE_PERIOD
  });
});

service.register('disableSelfKeepalive', function (message) {
  if (!selfKeepaliveInterval) {
    /* Not running */
    message.respond({
      returnValue: true,
      alreadyStopped: true,
      enabled: false
    });
    return;
  }

  log('disableSelfKeepalive: stopping internal keepalive interval');

  clearInterval(selfKeepaliveInterval);
  selfKeepaliveInterval = null;

  message.respond({
    returnValue: true,
    enabled: false
  });
});

service.register('selfKeepaliveStatus', function (message) {
  message.respond({
    returnValue: true,
    enabled: selfKeepaliveInterval !== null
  });
});


/* --------------------------------------------------------- keepalive init.d -- */
/* The keepalive daemon, linked into the Homebrew Channel's init.d. It runs in
   the background and calls the /keepalive endpoint every 30 seconds to prevent
   the system from closing the app due to inactivity, and starts the app once
   (params.boot) when the TV starts; the app's Autostart switch decides whether
   that opens the panel or ends the app. It is always on: a service that is root puts it in place
   by itself at every start (bottom of this file), there is no switch for it.

   The link does not point into the app's folder. The script is copied to the
   app's own data folder, <DATA_DIR>/<app-id>/keepalive_daemon.sh (one folder per
   app ID for every file it keeps on the TV, the layout WebOCU Dock uses too), so
   that it survives an uninstall of the app and removes the link and its own file
   when it finds the app gone (see tweaks/keepalive_daemon.sh); a link straight to
   the app's folder would be left dangling for good.

   Homebrew Channel runs the directory at boot with a plain
   `run-parts /var/lib/webosbrew/init.d`, which matters twice:
   - BusyBox run-parts before 1.34 skips any name with a character outside
     [A-Za-z0-9_-] -- a dot included, and every app ID has dots -- so the link
     is named after the ID with every character but [A-Za-z0-9_] replaced by
     '_' (the hyphen too: one rule for every app, whatever run-parts allows);
   - run-parts waits for each script, so the daemon detaches itself (see
     tweaks/keepalive_daemon.sh) instead of holding up the scripts after it. */

var INIT_D_DIR = '/var/lib/webosbrew/init.d';
var APPS_DIR = '/media/developer/apps/usr/palm/applications';

/* Everything the app keeps on the TV outside its package lives in one folder per
   app ID, flat: <DATA_DIR>/<app-id>/<file> -- the same layout as WebOCU Dock, so
   the two and every clone never share a file. Each part removes only its own
   files and then the folders if they are empty, never the folder as a whole. */
var DATA_DIR = '/media/developer/apps/var/lib/webocu';

/* Named after the app ID: this app, every clone of it under another ID and
   WebOCU Dock may all sit on one TV, and a shared name would let one of them
   overwrite or remove the daemon of another. tweaks/keepalive_daemon.sh builds
   the very same name (LINK_NAME); the two must not drift apart. */
function initDLink(appId) {
  return INIT_D_DIR + '/00_' + appId.replace(/[^A-Za-z0-9_]/g, '_') + '_keepalive';
}

/* Names of the same ID under earlier rules -- dots kept, or the hyphen kept --
   removed wherever the current one is written or removed, so an upgrade leaves
   one link. Only those that differ from the current name. */
function initDLegacyLinks(appId) {
  var now = initDLink(appId);
  var out = [];
  [INIT_D_DIR + '/00_' + appId + '_keepalive',
   INIT_D_DIR + '/00_' + appId.replace(/[^A-Za-z0-9_-]/g, '_') + '_keepalive'].forEach(function (path) {
    if (path !== now && out.indexOf(path) < 0) out.push(path);
  });
  return out;
}

/* Versions up to 0.1.8 used one name for every app, pointing straight into the
   app's folder; the dock and the clones wrote the same name. It is removed only
   when it points at this very app: someone else's link is not ours to take. */
var SHARED_LEGACY_LINK = INIT_D_DIR + '/00_webocu_keepalive';

function removeSharedLegacyLink(appId, cb) {
  var target;
  try { target = String(fs.readlinkSync(SHARED_LEGACY_LINK)); } catch (e) { cb(); return; }
  if (target.indexOf(APPS_DIR + '/' + appId + '/') !== 0) { cb(); return; }
  log('removing ' + SHARED_LEGACY_LINK + ' (it points at ' + appId + ')');
  /* The old daemon runs as `sh <that link>`. rm goes first so that the command
     line of this very `sh -c` does not end with the pattern pkill looks for. */
  shell('rm -f ' + SHARED_LEGACY_LINK + '; pkill -f "00_webocu_keepalive$" || true', function () { cb(); });
}

/* The script as shipped with the app, and the copy the link points to. */
function daemonSource(appId) {
  return APPS_DIR + '/' + appId + '/tweaks/keepalive_daemon.sh';
}

function daemonDir(appId) {
  return DATA_DIR + '/' + appId;
}

function daemonPath(appId) {
  return daemonDir(appId) + '/keepalive_daemon.sh';
}

/* The detached daemon runs as `sh <daemonPath> <app-id>`; the anchored pattern
   matches only the daemon of this ID (not of a clone whose ID extends it, nor
   the dock's), and not the `sh -c` running pkill itself, whose command line goes
   on past it. */
function daemonPattern(appId) {
  return '"keepalive_daemon.sh ' + appId + '$"';
}

var CURRENT_APP_ID = SERVICE_ID.replace('.service', '');
var INIT_D_LINK = initDLink(CURRENT_APP_ID);

/* Put the daemon in place and start it unless it already runs. Safe to repeat:
   the copy is replaced atomically (a shell that is running the old file never
   reads half of a new one), and a daemon that is already up refuses a second
   copy of itself, so nothing is restarted. KEEPALIVE_NO_LAUNCH keeps the daemon
   from starting the app: here the app is running, only a TV start should.
   cb(ok, errorText, output) */
function installInitD(appId, cb) {
  var link = initDLink(appId);
  var copy = daemonPath(appId);

  removeSharedLegacyLink(appId, function () {
    /* Step 1: the folders, and drop the names of earlier rules */
    shell('mkdir -p ' + INIT_D_DIR + ' ' + daemonDir(appId) + ' && rm -f ' + initDLegacyLinks(appId).join(' '), function (ok1) {
      if (!ok1) { cb(false, 'Failed to create the folders'); return; }

      /* Step 2: the copy; run-parts skips a target without the x bit, and the
         packager is not known to keep it on the original */
      shell('cp ' + daemonSource(appId) + ' ' + copy + '.new && chmod 755 ' + copy + '.new && mv -f ' + copy + '.new ' + copy, function (ok2) {
        if (!ok2) { cb(false, 'Failed to copy the daemon'); return; }

        /* Step 3: Create symlink (overwrite if exists) */
        shell('ln -sf ' + copy + ' ' + link, function (ok3) {
          if (!ok3) { cb(false, 'Failed to create symlink'); return; }

          /* Step 4: Start the daemon the way run-parts does; it detaches itself */
          shell('KEEPALIVE_NO_LAUNCH=1 nohup sh ' + link + ' > /dev/null 2>&1 &', function (ok4, output) {
            cb(ok4, ok4 ? null : 'Failed to start daemon', output);
          });
        });
      });
    });
  });
}

/* cb(ok, errorText, output) */
function removeInitD(appId, cb) {
  removeSharedLegacyLink(appId, function () {
    /* Step 1: Kill daemon process */
    shell('pkill -f ' + daemonPattern(appId) + ' || true', function () {
      /* Step 2: Remove symlink, under the earlier names too, and the copy; the
         app's folder and DATA_DIR only if nothing else is left in them */
      var dir = daemonDir(appId);
      shell('rm -f ' + initDLink(appId) + ' ' + initDLegacyLinks(appId).join(' ') + ' && (rm -f ' +
            dir + '/keepalive_daemon.sh ' + dir + '/keepalive_daemon.sh.new; rmdir ' + dir + ' 2>/dev/null; rmdir ' +
            DATA_DIR + ' 2>/dev/null; true)', function (ok, output) {
        cb(ok, ok ? null : 'Failed to remove symlink', output);
      });
    });
  });
}

service.register('installKeepalive', function (message) {
  if (!isRoot()) {
    message.respond({
      returnValue: false,
      errorText: 'Root privileges required',
      root: false
    });
    return;
  }

  log('installKeepalive: creating ' + INIT_D_LINK + ' and starting daemon');

  installInitD(CURRENT_APP_ID, function (ok, errorText, output) {
    message.respond({
      returnValue: ok,
      errorText: errorText,
      installed: ok,
      root: true,
      output: output
    });
  });
});

service.register('uninstallKeepalive', function (message) {
  if (!isRoot()) {
    message.respond({
      returnValue: false,
      errorText: 'Root privileges required',
      root: false
    });
    return;
  }

  log('uninstallKeepalive: stopping daemon and removing ' + INIT_D_LINK);

  removeInitD(CURRENT_APP_ID, function (ok, errorText, output) {
    message.respond({
      returnValue: ok,
      errorText: errorText,
      uninstalled: ok,
      root: true,
      output: output
    });
  });
});

service.register('keepaliveStatus', function (message) {
  /* Check if keepalive daemon is installed (symlink exists) and running.
     Links under earlier names do not count. */
  var checkCmd = 'test -L ' + INIT_D_LINK + ' && echo "installed" || echo "not_installed"';

  shell(checkCmd, function (ok, output) {
    var installed = output === 'installed';

    /* Check if process is running */
    var psCmd = 'pgrep -f ' + daemonPattern(CURRENT_APP_ID) + ' > /dev/null && echo "running" || echo "stopped"';

    shell(psCmd, function (ok2, output2) {
      var running = output2 === 'running';

      message.respond({
        returnValue: true,
        installed: installed,
        running: running,
        root: isRoot()
      });
    });
  });
});

log('started, root=' + isRoot() + ', node=' + process.version);

/* The keepalive daemon is always on for a service that has root: put it in place
   (and the current copy of its script) at every start. Every clone does the same
   for its own ID, from its own service. Without root nothing is done, and there
   is nothing to fail. */
if (isRoot()) {
  installInitD(CURRENT_APP_ID, function (ok, errorText) {
    log('keepalive init script: ' + (ok ? 'in place' : 'not installed (' + errorText + ')'));
  });
}
