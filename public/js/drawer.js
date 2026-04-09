// /js/drawer.js — Role-aware Drawer (Visitor / Host / Guide / Partner)
// Resolves links based on role and appends ?role=<role>&userId=<id>
(() => {
  if (window.Drawer) return;

  // ---------------------- ROUTE MAP (edit if paths change) ----------------------
  const ROUTES = {
    visitor: {
      dashboard: '/pages/visitor/dashboard.html',
      account:   '/pages/visitor/profile.html',          // if you don't have it, point to settings
      settings:  '/pages/visitor/settings.html',
      // services
      lgo_map:   '/pages/visitor/map.html',
      lgo_main:  '/pages/visitor/my-guidings.html',
      qless_hub: '/pages/visitor/booking.html',
      qless_scan:'/pages/visitor/qless-scan.html',
      events_map:'/pages/visitor/events-map.html',
      events_my: '/pages/visitor/events-detail.html',
      events_cr: '/pages/visitor/events-create.html',
      deals_map: '/pages/visitor/deals-map.html',
      deals_my:  '/pages/visitor/deals.html',
      emergency: '/pages/visitor/emergency.html',
      contact:   '/pages/visitor/contact-us.html'
    },
    host: {
      dashboard: '/pages/host/dashboard.html',
      account:   '/pages/host/profile.html',
      settings:  '/pages/visitor/settings.html',         // unified settings page
      // services (host management)
      qless_manage: '/pages/host/qless-manage.html',
      qless_scan:   '/pages/host/qless-scan.html',
      tours_manage: '/pages/host/tours-manage.html',
      events_manage:'/pages/host/events-manage.html',
      deals_manage: '/pages/host/deals-manage.html',
      emergency:    '/pages/host/emergency.html',
      contact:      '/pages/host/contact-us.html'
    },
    guide: {
      dashboard: '/pages/guide/dashboard.html',
      account:   '/pages/guide/profile.html',
      settings:  '/pages/visitor/settings.html',
      // services (guide tools)
      tours_my:   '/pages/guide/manage-guidings.html',
      tours_new:  '/pages/guide/create-guiding.html'
    },
    partner: {
      dashboard: '/pages/partner/dashboard.html',
      account:   '/pages/partner/profile.html',
      settings:  '/pages/visitor/settings.html',
      // services (partner promos)
      promos_my:  '/pages/partner/manage-promos.html',
      promos_new: '/pages/partner/create-promo.html'
    }
  };

  // ---------------------- helpers ----------------------
  function getUserInfo(optsUser) {
    let username = 'Guest';
    let avatarUrl = '/assets/images/avatar-demo.jpg';
    let userId = null;
    try {
      const s = JSON.parse(localStorage.getItem('app_settings_v1') || '{}');
      if (s.profile) {
        username  = s.profile.username || s.profile.name || username;
        avatarUrl = s.profile.avatarUrl || avatarUrl;
        if (s.profile.id) userId = s.profile.id;
      }
    } catch {}
    if (optsUser && typeof optsUser === 'object') {
      if (optsUser.username)  username  = optsUser.username;
      if (optsUser.avatarUrl) avatarUrl = optsUser.avatarUrl;
      if (optsUser.id)        userId    = optsUser.id;
    }
    return { username, avatarUrl, userId };
  }

  // Default logout: call backend + cleanup localStorage
  async function defaultLogout() {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (e) {
      console.warn('Default logout: backend call failed (non-blocking)', e);
    }
    try {
      localStorage.removeItem('auth_token');
      localStorage.removeItem('user_profile');
    } catch {}
    location.href = '/index.html';
  }

  // Append role & userId to internal links
  function withIdentity(href, role, userId, hash = '') {
    if (!href) return '#';
    const isExternal = /^https?:\/\//i.test(href);
    if (isExternal) return href;

    const url = new URL(href, location.origin);
    if (role)   url.searchParams.set('role', role);
    if (userId) url.searchParams.set('userId', userId);
    if (hash)   url.hash = hash.startsWith('#') ? hash : ('#' + hash);
    return url.pathname + url.search + url.hash;
  }

  function rowLink({ icon = '›', label = 'Link', href = '#' }) {
    const a = document.createElement('a');
    a.className = 'drawer-row';
    a.href = href;
    a.innerHTML = `
      <span class="row-left">${icon}</span>
      <span class="row-label">${label}</span>
      <span class="row-chevron">›</span>
    `;
    return a;
  }

  function serviceCard({
    logo = '🧭',
    name = 'Service',
    mapHref = '#',
    mainHref = '#',
    secHref = '#',
    line1 = 'Top link',
    line2 = 'Middle link',
    line3 = ''
  }) {
    const div = document.createElement('div');
    div.className = 'svc-card';
    div.innerHTML = `
      <div class="svc-left">${logo}</div>
      <div class="svc-right">
        <a class="svc-link top" href="${mapHref}">${line1}</a>
        <a class="svc-link sub" href="${mainHref}">${line2}</a>
        <a class="svc-link sub" href="${secHref}">${line3}</a>
      </div>
    `;
    div.setAttribute('aria-label', name);
    return div;
  }

  function socialsStrip(items = []) {
    const wrap = document.createElement('div');
    wrap.className = 'drawer-socials';
    wrap.innerHTML = items.map(it =>
      `<a href="${it.href}" target="_blank" rel="noopener" aria-label="${it.label}">${it.icon}</a>`
    ).join('');
    return wrap;
  }

  // ---------------------- role sections ----------------------
  function makeVisitorContent(role, userId, opts = {}) {
    const R = ROUTES.visitor;
    const wrap = document.createElement('div');
    wrap.className = 'drawer-sections';

    const svc = document.createElement('section');
    svc.className = 'drawer-services';
    svc.innerHTML = `<h4 class="drawer-section-title">Services</h4>`;

    svc.appendChild(serviceCard({
      logo: `<img src="/icons/letsgetout-logo2.png" alt="Let’s Get Out" style="width:100%;height:100%;object-fit:contain;">`,
      name:'Let’s Get Out',
      mapHref:  withIdentity(R.lgo_map,  role, userId),
      mainHref: withIdentity(R.lgo_main, role, userId),
      line1:'Guided visits around me - Map',
      line2:'My virtual guidings & tours'
    }));

    svc.appendChild(serviceCard({
      logo: `<img src="/icons/qless-logo2.png" alt="Q-less" style="width:100%;height:100%;object-fit:contain;">`,
      name:'Q-less',
      mapHref:  withIdentity(R.qless_hub,  role, userId),
      mainHref: withIdentity(R.qless_scan, role, userId),
      line1:'My virtual queues bookings',
      line2:'Scan'
    }));

    svc.appendChild(serviceCard({
      logo: `<img src="/icons/events-logo.png" alt="Events" style="width:100%;height:100%;object-fit:contain;">`,
      name:'Events',
      mapHref:  withIdentity(R.events_map, role, userId),
      mainHref: withIdentity(R.events_my,  role, userId),
      secHref: withIdentity(R.events_cr,  role, userId),
      line1:'Events around me — Map',
      line2:'My Events - follow',
      line3:'My Events - create'
    }));

    svc.appendChild(serviceCard({
      logo: `<img src="/icons/coolstuff-logo.png" alt="Cool Stuff" style="width:100%;height:100%;object-fit:contain;">`,
      name:'Cool Stuff',
      mapHref:  withIdentity(R.deals_map, role, userId),
      mainHref: withIdentity(R.deals_my,  role, userId),
      line1:'Promos & Discounts near me - Map',
      line2:'My Promos & Coupons - Wallet'
    }));

    wrap.appendChild(svc);

    const utils = document.createElement('section');
    utils.className = 'drawer-utils';
    utils.appendChild(rowLink({ icon:'🚨', label:'Emergencies', href: withIdentity(R.emergency, role, userId) }));
    utils.appendChild(rowLink({ icon:'✉️', label:'Contact',     href: withIdentity(R.contact,   role, userId) }));
    wrap.appendChild(utils);

    const logoutHandler = typeof opts.onLogout === 'function' ? opts.onLogout : defaultLogout;

    const logout = document.createElement('button');
    logout.type = 'button';
    logout.className = 'drawer-logout';
    logout.innerHTML = `<span class="lo-ico">⇦</span><span>Log out</span>`;
    logout.addEventListener('click', logoutHandler);
    wrap.appendChild(logout);

    const social = socialsStrip([
      { icon:'🐦', label:'X/Twitter',  href:'https://twitter.com/' },
      { icon:'📸', label:'Instagram',  href:'https://instagram.com/' },
      { icon:'📘', label:'Facebook',   href:'https://facebook.com/' },
      { icon:'▶️', label:'YouTube',    href:'https://youtube.com/' }
    ]);
    wrap.appendChild(social);

    return wrap;
  }

  function makeHostContent(role, userId, opts = {}) {
    const R = ROUTES.host;
    const wrap = document.createElement('div');
    wrap.className = 'drawer-sections';

    const svc = document.createElement('section');
    svc.className = 'drawer-services';
    svc.innerHTML = `<h4 class="drawer-section-title">Host Services</h4>`;

    svc.appendChild(serviceCard({
      logo: `<img src="/icons/qless-logo2.png" alt="Q-less" style="width:100%;height:100%;object-fit:contain;">`,
      name:'Q-less',
      mapHref:  withIdentity(R.qless_manage, role, userId),
      mainHref: withIdentity(R.qless_scan,   role, userId),
      line1:'Virtual Queues — Manage My Queues',
      line2:'Virtual Queues — Scan Entries'
    }));

    svc.appendChild(serviceCard({
      logo: `<img src="/icons/letsgetout-logo2.png" alt="Let’s Get Out" style="width:100%;height:100%;object-fit:contain;">`,
      name:'Let’s Get Out',
      mapHref:  withIdentity(R.tours_manage, role, userId),
      mainHref: withIdentity(R.tours_manage, role, userId),
      line1:'Guided visits — Manage My Guidings',
      line2:'Guided visits — Manage My Guidings'
    }));

    svc.appendChild(serviceCard({
      logo: `<img src="/icons/events-logo.png" alt="Events" style="width:100%;height:100%;object-fit:contain;">`,
      name:'Events',
      mapHref:  withIdentity(R.events_manage, role, userId),
      mainHref: withIdentity(R.events_manage, role, userId),
      line1:'My Events',
      line2:'My Events'
    }));

    svc.appendChild(serviceCard({
      logo: `<img src="/icons/coolstuff-logo.png" alt="Cool Stuff" style="width:100%;height:100%;object-fit:contain;">`,
      name:'Cool Stuff',
      mapHref:  withIdentity(R.deals_manage, role, userId),
      mainHref: withIdentity(R.deals_manage, role, userId),
      line1:'Promos & Coupons — Manage',
      line2:'My Promos & Coupons'
    }));

    wrap.appendChild(svc);

    const utils = document.createElement('section');
    utils.className = 'drawer-utils';
    utils.appendChild(rowLink({ icon:'⚙️', label:'Settings', href: withIdentity(R.settings, role, userId, 'profile') }));
    utils.appendChild(rowLink({ icon:'✉️', label:'Contact',  href: withIdentity(R.contact,  role, userId) }));
    wrap.appendChild(utils);

    const logoutHandler = typeof opts.onLogout === 'function' ? opts.onLogout : defaultLogout;

    const logout = document.createElement('button');
    logout.type = 'button';
    logout.className = 'drawer-logout';
    logout.innerHTML = `<span class="lo-ico">⇦</span><span>Log out</span>`;
    logout.addEventListener('click', logoutHandler);
    wrap.appendChild(logout);

    return wrap;
  }

  function makeGuideContent(role, userId, opts = {}) {
    const R = ROUTES.guide;
    const wrap = document.createElement('div');
    wrap.className = 'drawer-sections';

    const svc = document.createElement('section');
    svc.className = 'drawer-services';
    svc.innerHTML = `<h4 class="drawer-section-title">Guide Tools</h4>`;

    svc.appendChild(serviceCard({
      logo:'🗺️',
      name:'Let’s Get Out',
      mapHref:  withIdentity(R.tours_my,  role, userId),
      mainHref: withIdentity(R.tours_new, role, userId),
      line1:'My Tours',
      line2:'Create Guiding'
    }));

    wrap.appendChild(svc);

    const utils = document.createElement('section');
    utils.className = 'drawer-utils';
    utils.appendChild(rowLink({ icon:'⚙️', label:'Settings', href: withIdentity(R.settings, role, userId, 'profile') }));
    wrap.appendChild(utils);

    const logoutHandler = typeof opts.onLogout === 'function' ? opts.onLogout : defaultLogout;

    const logout = document.createElement('button');
    logout.type = 'button';
    logout.className = 'drawer-logout';
    logout.innerHTML = `<span class="lo-ico">⇦</span><span>Log out</span>`;
    logout.addEventListener('click', logoutHandler);
    wrap.appendChild(logout);

    return wrap;
  }

  function makePartnerContent(role, userId, opts = {}) {
    const R = ROUTES.partner;
    const wrap = document.createElement('div');
    wrap.className = 'drawer-sections';

    const svc = document.createElement('section');
    svc.className = 'drawer-services';
    svc.innerHTML = `<h4 class="drawer-section-title">Partner Services</h4>`;

    svc.appendChild(serviceCard({
      logo:'🎁',
      name:'Cool Stuff',
      mapHref:  withIdentity(R.promos_my,  role, userId),
      mainHref: withIdentity(R.promos_new, role, userId),
      line1:'My Promos',
      line2:'Create Promo'
    }));

    wrap.appendChild(svc);

    const utils = document.createElement('section');
    utils.className = 'drawer-utils';
    utils.appendChild(rowLink({ icon:'⚙️', label:'Settings', href: withIdentity(R.settings, role, userId, 'profile') }));
    wrap.appendChild(utils);

    const logoutHandler = typeof opts.onLogout === 'function' ? opts.onLogout : defaultLogout;

    const logout = document.createElement('button');
    logout.type = 'button';
    logout.className = 'drawer-logout';
    logout.innerHTML = `<span class="lo-ico">⇦</span><span>Log out</span>`;
    logout.addEventListener('click', logoutHandler);
    wrap.appendChild(logout);

    return wrap;
  }

  // ---------------------- mount ----------------------
  function mount(opts = {}) {
    if (document.getElementById('homeDrawer')) return;

    const modeRaw = (opts.mode || 'visitor').toLowerCase();
    const role = ['visitor', 'host', 'guide', 'partner'].includes(modeRaw) ? modeRaw : 'visitor';
    const { username, avatarUrl, userId } = getUserInfo(opts.user);

    // Drawer shell
    const drawer = document.createElement('aside');
    drawer.className = 'drawer';
    drawer.id = 'homeDrawer';
    drawer.setAttribute('aria-hidden', 'true');

    // Header (avatar + name + close)
    const header = document.createElement('div');
    header.className = 'drawer-header';

    const headerMid = document.createElement('div');
    headerMid.className = 'drawer-header-mid';

    const avatar = document.createElement('img');
    avatar.className = 'drawer-avatar';
    avatar.src = avatarUrl;
    avatar.alt = 'User avatar';

    const name = document.createElement('div');
    name.className = 'drawer-username';
    name.textContent = username || 'Guest';

    headerMid.appendChild(avatar);
    headerMid.appendChild(name);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'icon close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '✕';

    header.appendChild(headerMid);
    header.appendChild(closeBtn);

    // Content
    const content = document.createElement('div');
    content.className = 'drawer-content';

    // Dashboard / Account rows (role-aware)
    const R = ROUTES[role];
    const dashboardRow = rowLink({
      icon: '🏠',
      label: 'Dashboard',
      href: withIdentity(R.dashboard, role, userId, 'profile')
    });
    const accountRow = rowLink({
      icon: '👤',
      label: 'My account',
      href: withIdentity(R.account || R.settings, role, userId, 'profile')
    });

    content.appendChild(dashboardRow);
    content.appendChild(accountRow);

    // Role-specific blocks
    if (role === 'host')         content.appendChild(makeHostContent(role, userId, opts));
    else if (role === 'guide')   content.appendChild(makeGuideContent(role, userId, opts));
    else if (role === 'partner') content.appendChild(makePartnerContent(role, userId, opts));
    else                         content.appendChild(makeVisitorContent(role, userId, opts));

    // Footer (reserved)
    const footer = document.createElement('footer');
    footer.className = 'drawer-footer';
    footer.innerHTML = `<div class="drawer-footer-inner" aria-hidden="true"></div>`;

    drawer.appendChild(header);
    drawer.appendChild(content);
    drawer.appendChild(footer);

    // Backdrop
    const backdrop = document.createElement('div');
    backdrop.id = 'drawerBackdrop';
    backdrop.className = 'backdrop';

    document.body.appendChild(drawer);
    document.body.appendChild(backdrop);

    const open = () => {
      drawer.classList.add('open');
      backdrop.classList.add('show');
      drawer.setAttribute('aria-hidden', 'false');
    };
    const close = () => {
      drawer.classList.remove('open');
      backdrop.classList.remove('show');
      drawer.setAttribute('aria-hidden', 'true');
    };

    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', close);
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

    window.Drawer = { mount, open, close };
  }

  // Initial stub (before first mount)
  window.Drawer = { mount, open: () => {}, close: () => {} };
})();
