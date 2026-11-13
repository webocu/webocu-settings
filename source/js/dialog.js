/* =========================================================================
   Confirmation dialog for destructive actions (restart, power off).
   Cancel is focused by default on purpose: a stray OK press must not
   reboot the TV.
   ========================================================================= */
window.Dialog = (function () {
  var elRoot = document.getElementById('dialog');
  var elText = document.getElementById('dialogText');
  var elCancel = document.getElementById('dialogCancel');
  var elConfirm = document.getElementById('dialogConfirm');

  var isOpen = false;
  var focusIndex = 0;            // 0 = cancel, 1 = confirm
  var onConfirm = null;
  var onClose = null;

  function paint() {
    elCancel.textContent = window.I18N.t('dialog.cancel');
    elConfirm.textContent = window.I18N.t('dialog.confirm');
    elCancel.className = 'dialog__btn' + (focusIndex === 0 ? ' is-focused' : '');
    elConfirm.className = 'dialog__btn dialog__btn--danger' + (focusIndex === 1 ? ' is-focused' : '');
  }

  function show(message, confirmCallback, closeCallback) {
    isOpen = true;
    focusIndex = 0;
    onConfirm = confirmCallback || null;
    onClose = closeCallback || null;
    elText.textContent = message;
    elRoot.classList.add('is-open');
    elRoot.setAttribute('aria-hidden', 'false');
    paint();
  }

  function hide() {
    if (!isOpen) return;
    isOpen = false;
    elRoot.classList.remove('is-open');
    elRoot.setAttribute('aria-hidden', 'true');
    var callback = onClose;
    onConfirm = null;
    onClose = null;
    if (callback) callback();
  }

  function accept() {
    var callback = onConfirm;
    var confirmed = (focusIndex === 1);
    hide();
    if (confirmed && callback) callback();
  }

  /* Returns true when the key was consumed. */
  function handleKey(action) {
    if (!isOpen) return false;
    switch (action) {
      case 'left': focusIndex = 0; paint(); return true;
      case 'right': focusIndex = 1; paint(); return true;
      case 'enter': accept(); return true;
      case 'back': hide(); return true;
      default: return true;      // swallow everything else while modal
    }
  }

  elCancel.addEventListener('click', function () { focusIndex = 0; accept(); }, false);
  elConfirm.addEventListener('click', function () { focusIndex = 1; accept(); }, false);
  elCancel.addEventListener('mouseover', function () { focusIndex = 0; paint(); }, false);
  elConfirm.addEventListener('mouseover', function () { focusIndex = 1; paint(); }, false);

  return {
    show: show,
    hide: hide,
    isOpen: function () { return isOpen; },
    handleKey: handleKey,
    repaint: paint
  };
})();
