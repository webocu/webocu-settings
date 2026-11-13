/* Local cache of setting values. On webOS the real source of truth is
   luna-service; this only keeps the last known value so the panel renders
   instantly and dev-mode stubs survive a restart. */
window.Store = (function () {
  var appId = (window.PalmSystem || window.webOSSystem || {}).identifier || 'webocu.settings';
  var KEY = appId + '.v1';
  var data = {};

  try {
    data = JSON.parse(window.localStorage.getItem(KEY) || '{}') || {};
  } catch (e) {
    data = {};
  }

  var flushTimer = null;

  function flush() {
    try { window.localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* quota */ }
  }

  return {
    get: function (id, fallback) {
      return Object.prototype.hasOwnProperty.call(data, id) ? data[id] : fallback;
    },
    set: function (id, value) {
      data[id] = value;
      // Debounced: sliders can fire dozens of writes per second.
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(flush, 400);
    },
    reset: function () {
      data = {};
      flush();
    }
  };
})();
