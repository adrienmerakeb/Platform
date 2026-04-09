// /js/fab.js — injects 4 corner FABs on any page + optional top/bottom bands
(function () {
  if (window.FAB) return; // don't re-register

  // Small helper: decide whether Ionicons is ready
  function ioniconsAvailable() {
    try {
      return !!(window.customElements && customElements.get('ion-icon'));
    } catch (e) {
      return false;
    }
  }

  // Build icon HTML for FABs:
  // - If Ionicons is available: use <ion-icon>
  // - Else: use PNG directly (/icons/ion-png/md-<name>.png)
  function makeIconHTML(name) {
    const safeName = (name || '').trim() || 'help';
    const pngPath = `/icons/ion-png/md-${safeName}.png`;

    if (ioniconsAvailable()) {
      // Ionicons v4 style
      return `<ion-icon name="${safeName}" class="fab-icon"></ion-icon>`;
    } else {
      // Direct PNG fallback (no dependency on icon-fallback.js)
      return `<img src="${pngPath}" class="fab-icon" alt="" aria-hidden="true">`;
    }
  }

  function makeBtn(pos, title, iconName, opts = {}, extraClass = "") {
    const b = document.createElement("button");
    b.className = "fab " + pos + (extraClass ? " " + extraClass : "");
    b.type = "button";

    if (title) {
      b.title = title;
      b.setAttribute("aria-label", title);
    }

    b.innerHTML = makeIconHTML(iconName);

    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof opts.onClick === "function") return opts.onClick(e);
      if (opts.href) location.href = opts.href;
    });

    return b;
  }

  function mount(options = {}) {
    // avoid duplicates on a page
    if (document.querySelector(".fab.tl")) return;

    const home        = options.home   || {}; // {href?, onClick?, title?, iconName?}
    const config      = options.config || {}; // {href?, onClick?, title?, iconName?}
    const onBack      = options.onBack || (() => history.back());
    const br          = options.br     || {}; // {href?, onClick?, title?, iconName?}
    const useTopBand    = !!options.useTopBand;
    const useBottomBand = !!options.useBottomBand;
    const footerText    = options.footerText || `© ${new Date().getFullYear()} Tourism App MVP`;

    // ----- Create the four FAB buttons -----

    const homeBtn = makeBtn(
      "tl",
      home.title || "Home",
      home.iconName || "home",
      { onClick: home.onClick, href: home.href || "/pages/visitor/dashboard.html" }
    );

    const cfgBtn = makeBtn(
      "tr",
      config.title || "Configuration",
      config.iconName || "settings",
      { onClick: config.onClick, href: config.href || "/pages/settings.html" }
    );

    const backBtn = makeBtn(
      "bl",
      "Back",
      "arrow-back",
      { onClick: onBack }
    );

    const brBtn = makeBtn(
      "br",
      br.title || "Action",
      br.iconName || "add",
      { onClick: br.onClick, href: br.href }
    );

    // ----- Top band (optional) -----
    if (useTopBand) {
      document.body.classList.add("has-top-band");

      const existingHeader = document.querySelector("header.site");

      const tband = document.createElement("div");
      tband.className = "top-band";
      tband.innerHTML = `
        <div class="inner">
          <div class="slot-left"></div>
          <header class="site"><div class="title">&nbsp;</div></header>
          <div class="slot-right"></div>
        </div>`;
      document.body.appendChild(tband);

      const bandHeader = tband.querySelector("header.site");
      if (existingHeader) {
        bandHeader.innerHTML = existingHeader.innerHTML || bandHeader.innerHTML;
        existingHeader.remove();
      }

      homeBtn.classList.add("band-top");
      cfgBtn.classList.add("band-top");
      tband.querySelector(".slot-left").appendChild(homeBtn);
      tband.querySelector(".slot-right").appendChild(cfgBtn);
    } else {
      document.body.appendChild(homeBtn);
      document.body.appendChild(cfgBtn);
    }

    // ----- Bottom band (optional) -----
    if (useBottomBand) {
      document.body.classList.add("has-bottom-band");

      const existingFooter = document.querySelector("footer.site");

      const bband = document.createElement("div");
      bband.className = "bottom-band";
      bband.innerHTML = `
        <div class="inner">
          <div class="slot-left"></div>
          <footer class="site"></footer>
          <div class="slot-right"></div>
        </div>`;
      document.body.appendChild(bband);

      const bandFooter = bband.querySelector("footer.site");
      if (existingFooter) {
        bandFooter.innerHTML = existingFooter.innerHTML || existingFooter.textContent || "";
        existingFooter.remove();
      } else {
        bandFooter.textContent = footerText;
      }

      backBtn.classList.add("band");
      brBtn.classList.add("band");
      bband.querySelector(".slot-left").appendChild(backBtn);
      bband.querySelector(".slot-right").appendChild(brBtn);
    } else {
      document.body.appendChild(backBtn);
      document.body.appendChild(brBtn);
    }

    // OPTIONAL: if you still want to use icon-fallback.js for other icons,
    // it will continue to run globally and doesn't conflict with this.
  }

  window.FAB = { mount };
})();
