// /js/icon-fallback.js
// Replace <ion-icon name="..."> with <img src="/icons/ion-png/md-<name>.png">
// if the CDN didn’t load OR the custom element never registered.
(function () {
  function swapToLocalImgs(root = document) {
    root.querySelectorAll('ion-icon').forEach(el => {
      const name = (el.getAttribute('name') || '').trim();
      if (!name) return;

      const img = new Image();
      // keep classes for sizing, etc.
      if (el.className) img.className = el.className;
      img.alt = '';
      img.setAttribute('aria-hidden', 'true');
      img.src = `/icons/ion-png/md-${name}.png`;
      // optional per-icon size class you already use
      if (!img.className.includes('icon')) img.classList.add('icon');

      // graceful default if specific png is missing
      img.onerror = () => { img.src = '/icons/ion-png/md-alert-circle.png'; };

      el.replaceWith(img);
    });
  }

  function needFallback() {
    // if the script tag fired onerror OR the custom element isn't defined
    if (window.__ionicons_failed__) return true;
    if (!('customElements' in window)) return true;
    return !customElements.get('ion-icon');
  }

  // Run on DOM ready (for icons already in the page)
  function runAuto() {
    if (needFallback()) swapToLocalImgs();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runAuto);
  } else {
    runAuto();
  }

  // Safety timeout: if the CDN loads very slowly/no service worker yet
  setTimeout(runAuto, 1500);

  // 🔓 Expose a small public API for later-added icons (e.g. from fab.js)
  window.IconFallback = {
    swap(root = document) {
      // unconditionally try swapping in this subtree
      swapToLocalImgs(root);
    },
    runIfNeeded(root = document) {
      if (needFallback()) swapToLocalImgs(root);
    }
  };
})();
