// /js/fab.js — injects corner FABs on any page + optional top/bottom bands
(function () {
  if (window.FAB) return; // don't re-register

  function makeBtn(pos, title, label, opts = {}, extraClass = "") {
    const b = document.createElement("button");
    b.className = "fab " + pos + (extraClass ? " " + extraClass : "");
    b.type = "button";

    if (title) {
      b.title = title;
      b.setAttribute("aria-label", title);
    }

    // PRIORITY:
    // 1) opts.iconPath → <img>
    // 2) else label → text/emoji
    if (opts.iconPath) {
      b.innerHTML = `<img src="${opts.iconPath}" class="fab-icon" alt="">`;
    } else {
      b.textContent = label || "";
    }

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

    const home    = options.home   || {}; // {href?, onClick?, label?, title?, iconPath?}
    const config  = options.config || {}; // {href?, onClick?, label?, title?, iconPath?}
    const onBack  = options.onBack || (() => history.back());
    const br      = options.br     || {}; // {href?, onClick?, label?, title?, iconPath?}
    const logout  = options.logout || null; // {onClick?, href?, label?, title?, iconPath?}

    const useTopBand    = !!options.useTopBand;
    const useBottomBand = !!options.useBottomBand;
    const footerText    = options.footerText || `© ${new Date().getFullYear()} Tourism App MVP`;

    // 🔹 NEW: optional layout mode for the bottom band
    const bottomBandMode = options.bottomBandMode || "default";
    //  - "default"   → old behaviour
    //  - "brLeftOnly" → only BR on left, nothing on right

    // ----- Create FABs -----

    const homeBtn = makeBtn(
      "tl",
      home.title || "Home",
      home.label || "🏠",
      { onClick: home.onClick, href: home.href || "/pages/visitor/dashboard.html", iconPath: home.iconPath }
    );

    const cfgBtn = makeBtn(
      "tr",
      config.title || "Configuration",
      config.label || "⚙️",
      { onClick: config.onClick, href: config.href || "/pages/settings.html", iconPath: config.iconPath }
    );

    const backBtn = makeBtn(
      "bl",
      "Back",
      "‹",
      { onClick: onBack }
    );

    const brBtn = makeBtn(
      "br",
      br.title || "Action",
      br.label || "⋯",
      { onClick: br.onClick, href: br.href, iconPath: br.iconPath }
    );

    let logoutBtn = null;
    if (logout) {
      logoutBtn = makeBtn(
        "bl", // logically bottom-left replacement
        logout.title || "Logout",
        logout.label || "⎋",
        { onClick: logout.onClick, href: logout.href, iconPath: logout.iconPath },
        "fab-logout"
      );
    }

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
      // Floating top-left / top-right
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

      // 🔹 SPECIAL MODE: BR on left only, right empty
      if (bottomBandMode === "brLeftOnly") {
        brBtn.classList.add("band");
        bband.querySelector(".slot-left").appendChild(brBtn);
        // no button added to slot-right
      } else {
        // ⬇️ Bottom band: LEFT = logout if present, else back
        if (logoutBtn) {
          logoutBtn.classList.add("band");
          bband.querySelector(".slot-left").appendChild(logoutBtn);
        } else {
          backBtn.classList.add("band");
          bband.querySelector(".slot-left").appendChild(backBtn);
        }

        // ⬇️ Bottom band: RIGHT = br (map, action, etc.)
        brBtn.classList.add("band");
        bband.querySelector(".slot-right").appendChild(brBtn);
      }

    } else {
      // No bottom band: floating corners

      // LEFT: logout replaces back if present
      if (logoutBtn) {
        logoutBtn.classList.add("bl");
        document.body.appendChild(logoutBtn);
      } else {
        document.body.appendChild(backBtn);
      }

      // RIGHT: action/map as usual
      document.body.appendChild(brBtn);
    }
  }

  window.FAB = { mount };
})();
