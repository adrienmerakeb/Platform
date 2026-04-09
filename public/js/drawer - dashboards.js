// /js/drawer.js — Role-aware Drawer (Visitor / Host / Guide / Partner)
// Keeps your original structure, classes, and working behavior.
(() => {
  if (window.Drawer) return;

  // -------------------------------------------------------------------
  // Helpers (kept compatible with your current version)
  function getUserInfo(optsUser){
    let username = 'Guest';
    let avatarUrl = '/assets/images/avatar-demo.jpg';
    try {
      const s = JSON.parse(localStorage.getItem('app_settings_v1') || '{}');
      if (s.profile) {
        username  = s.profile.username || s.profile.name || username;
        avatarUrl = s.profile.avatarUrl || avatarUrl;
      }
    } catch {}
    if (optsUser && typeof optsUser === 'object') {
      if (optsUser.username)  username  = optsUser.username;
      if (optsUser.avatarUrl) avatarUrl = optsUser.avatarUrl;
    }
    return { username, avatarUrl };
  }

  function rowLink({ icon='›', label='Link', href='#' }){
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

  function serviceCard({ logo='🧭', name='Service', mapHref='#', mainHref='#', line1='Top link', line2='Bottom link'}){
    const div = document.createElement('div');
    div.className = 'svc-card';
    div.innerHTML = `
      <div class="svc-left">${logo}</div>
      <div class="svc-right">
        <a class="svc-link top" href="${mapHref}">${line1}</a>
        <a class="svc-link sub" href="${mainHref}">${line2}</a>
      </div>
    `;
    div.setAttribute('aria-label', name);
    return div;
  }

  function socialsStrip(items = []){
    const wrap = document.createElement('div');
    wrap.className = 'drawer-socials';
    wrap.innerHTML = items.map(it =>
      `<a href="${it.href}" target="_blank" rel="noopener" aria-label="${it.label}">${it.icon}</a>`
    ).join('');
    return wrap;
  }

  // -------------------------------------------------------------------
  // VISITOR content (your original)
  function makeVisitorContent(){
    const wrap = document.createElement('div');
    wrap.className = 'drawer-sections';

    const svc = document.createElement('section');
    svc.className = 'drawer-services';
    svc.innerHTML = `<h4 class="drawer-section-title">Services</h4>`;

    svc.appendChild(serviceCard({
      logo: `<img src="/icons/letsgetout-logo2.png" 
            alt="Let’s Get Out" 
            style="width:100%;height:100%;object-fit:contain;">`,

      name:'Let’s Get Out',
      mapHref:'/pages/visitor/map.html',
      mainHref:'/pages/visitor/my-guidings.html',
      line1:'Guided visits around me — Map',
      line2:'My Guided Visits'
    }));

    svc.appendChild(serviceCard({
      logo: `<img src="/icons/qless-logo2.png" 
            alt="Let’s Get Out" 
            style="width:100%;height:100%;object-fit:contain;">`,

      name:'Q-less',
      mapHref:'/pages/visitor/booking.html',
      mainHref:'/pages/visitor/qless-scan.html',
      line1:'Virtual Queues — Booking Hub',
      line2:'Scan'
    }));

    svc.appendChild(serviceCard({
      logo: `<img src="/icons/events-logo.png" 
            alt="Let’s Get Out" 
            style="width:100%;height:100%;object-fit:contain;">`,

      name:'Events',
      mapHref:'/pages/visitor/events-map.html',
      mainHref:'/pages/visitor/events.html',
      line1:'Events around me — Map',
      line2:'My Events'
    }));

    svc.appendChild(serviceCard({
      logo: `<img src="/icons/coolstuff-logo.png" 
            alt="Let’s Get Out" 
            style="width:100%;height:100%;object-fit:contain;">`,

      name:'Cool Stuff',
      mapHref:'/pages/visitor/deals-map.html',
      mainHref:'/pages/visitor/deals.html',
      line1:'Promos near me — Map',
      line2:'My Promos & Coupons'
    }));

    wrap.appendChild(svc);

    const utils = document.createElement('section');
    utils.className = 'drawer-utils';
    utils.appendChild(rowLink({ icon:'🚨', label:'Emergencies', href:'/pages/host/emergency.html' }));
    utils.appendChild(rowLink({ icon:'✉️', label:'Contact',     href:'/pages/host/contact-us.html' }));
    wrap.appendChild(utils);

    const logout = document.createElement('button');
    logout.type = 'button';
    logout.className = 'drawer-logout';
    logout.innerHTML = `<span class="lo-ico">⇦</span><span>Log out</span>`;
    logout.addEventListener('click', () => {
      try {
        localStorage.removeItem('auth_token');
        localStorage.removeItem('user_profile');
      } catch {}
      logout.textContent = 'Logged out ✓';
      setTimeout(() => location.href = '/index.html', 400);
    });
    wrap.appendChild(logout);

    const social = socialsStrip([
      { icon:'🐦', label:'X/Twitter',  href:'https://twitter.com/' },
      { icon:'📸', label:'Instagram',  href:'https://instagram.com/' },
      { icon:'📘', label:'Facebook',   href:'https://facebook.com/' },
      { icon:'▶️', label:'YouTube',    href:'https://youtube.com/' },
    ]);
    wrap.appendChild(social);

    return wrap;
  }

  // -------------------------------------------------------------------
  // HOST content (new)
  function makeHostContent(){
    const wrap = document.createElement('div');
    wrap.className = 'drawer-sections';

    const svc = document.createElement('section');
    svc.className = 'drawer-services';
    svc.innerHTML = `<h4 class="drawer-section-title">Host Services</h4>`;

    svc.appendChild(serviceCard({
      logo: `<img src="/icons/qless-logo2.png" 
            alt="Let’s Get Out" 
            style="width:100%;height:100%;object-fit:contain;">`,

      name:'Q-less',
      mapHref:'/pages/host/qless-scan.html',
      mainHref:'/pages/host/qless-manage.html',
      line1:'Virtual Queues — Manage My Queues',
      line2:'Virtual Queues — Scan Entries'
    }));

    svc.appendChild(serviceCard({
      logo: `<img src="/icons/letsgetout-logo2.png" 
            alt="Let’s Get Out" 
            style="width:100%;height:100%;object-fit:contain;">`,

      name:'Let’s Get Out',
      mapHref:'/pages/host/tours-manage.html',
      mainHref:'/pages/host/tours-manage.html',
      line1:'Guided visits — Manage My Guidings',
      line2:'Guided visits — Manage My Guidings'
    }));

    svc.appendChild(serviceCard({
      logo: `<img src="/icons/events-logo.png" 
            alt="Let’s Get Out" 
            style="width:100%;height:100%;object-fit:contain;">`,

      name:'Events',
      mapHref:'/pages/host/events-managem.html',
      mainHref:'/pages/host/events.html',
      line1:'My Events',
      line2:'My Events'
    }));

    svc.appendChild(serviceCard({
      logo: `<img src="/icons/coolstuff-logo.png" 
            alt="Let’s Get Out" 
            style="width:100%;height:100%;object-fit:contain;">`,

      name:'Cool Stuff',
      mapHref:'/pages/host/deals-manage.html',
      mainHref:'/pages/host/deals.html',
      line1:'Promos & Coupons - Manage',
      line2:'My Promos & Coupons'
    }));

    wrap.appendChild(svc);

    const utils = document.createElement('section');
    utils.className = 'drawer-utils';
    utils.appendChild(rowLink({ icon:'⚙️', label:'Settings', href:'/pages/visitor/settings.html#profile' }));
    utils.appendChild(rowLink({ icon:'✉️', label:'Contact',  href:'/pages/visitor/contact-us.html' }));
    wrap.appendChild(utils);

    const logout = document.createElement('button');
    logout.type = 'button';
    logout.className = 'drawer-logout';
    logout.innerHTML = `<span class="lo-ico">⇦</span><span>Log out</span>`;
    logout.addEventListener('click', () => {
      try {
        localStorage.removeItem('auth_token');
        localStorage.removeItem('user_profile');
      } catch {}
      location.href = '/index.html';
    });
    wrap.appendChild(logout);

    return wrap;
  }

  // -------------------------------------------------------------------
  // GUIDE content (new)
  function makeGuideContent(){
    const wrap = document.createElement('div');
    wrap.className = 'drawer-sections';

    const svc = document.createElement('section');
    svc.className = 'drawer-services';
    svc.innerHTML = `<h4 class="drawer-section-title">Guide Tools</h4>`;

    svc.appendChild(serviceCard({
      logo:'🗺️', name:'Let’s Get Out',
      mapHref:'/pages/guide/manage-guidings.html',
      mainHref:'/pages/guide/create-guiding.html',
      line1:'My Tours',
      line2:'Create Guiding'
    }));
    svc.appendChild(serviceCard({
      logo:'📣', name:'Live Tours',
      mapHref:'/pages/guide/manage-guidings.html',
      mainHref:'/pages/guide/manage-guidings.html',
      line1:'Schedule Live',
      line2:'Earnings'
    }));

    wrap.appendChild(svc);

    const utils = document.createElement('section');
    utils.className = 'drawer-utils';
    utils.appendChild(rowLink({ icon:'⚙️', label:'Settings', href:'/pages/visitor/settings.html#profile' }));
    wrap.appendChild(utils);

    const logout = document.createElement('button');
    logout.type = 'button';
    logout.className = 'drawer-logout';
    logout.innerHTML = `<span class="lo-ico">⇦</span><span>Log out</span>`;
    logout.addEventListener('click', () => {
      try { localStorage.removeItem('auth_token'); localStorage.removeItem('user_profile'); } catch {}
      location.href = '/index.html';
    });
    wrap.appendChild(logout);

    return wrap;
  }

  // -------------------------------------------------------------------
  // PARTNER content (new)
  function makePartnerContent(){
    const wrap = document.createElement('div');
    wrap.className = 'drawer-sections';

    const svc = document.createElement('section');
    svc.className = 'drawer-services';
    svc.innerHTML = `<h4 class="drawer-section-title">Partner Services</h4>`;

    svc.appendChild(serviceCard({
      logo:'🎁', name:'Cool Stuff',
      mapHref:'/pages/partner/manage-promos.html',
      mainHref:'/pages/partner/create-promo.html',
      line1:'My Promos',
      line2:'Create Promo'
    }));

    wrap.appendChild(svc);

    const utils = document.createElement('section');
    utils.className = 'drawer-utils';
    utils.appendChild(rowLink({ icon:'⚙️', label:'Settings', href:'/pages/visitor/settings.html#profile' }));
    wrap.appendChild(utils);

    const logout = document.createElement('button');
    logout.type = 'button';
    logout.className = 'drawer-logout';
    logout.innerHTML = `<span class="lo-ico">⇦</span><span>Log out</span>`;
    logout.addEventListener('click', () => {
      try { localStorage.removeItem('auth_token'); localStorage.removeItem('user_profile'); } catch {}
      location.href = '/index.html';
    });
    wrap.appendChild(logout);

    return wrap;
  }

  // -------------------------------------------------------------------
  // Mount
  function mount(opts = {}) {
    if (document.getElementById('homeDrawer')) return;

    const mode = (opts.mode || 'visitor').toLowerCase();
    const { username, avatarUrl } = getUserInfo(opts.user);

    // Drawer shell
    const drawer = document.createElement('aside');
    drawer.className = 'drawer';
    drawer.id = 'homeDrawer';
    drawer.setAttribute('aria-hidden', 'true');

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


    // Dashboard row
    const dashboardRow = rowLink({ icon:'🏠', label:'Dashboard', href:'/pages/host/dashboard.html#profile' });

    // Account row
    const accountRow = rowLink({ icon:'👤', label:'My account', href:'/pages/host/settings.html#profile' });

    // Content
    const content = document.createElement('div');
    content.className = 'drawer-content';

    content.appendChild(dashboardRow);    
    content.appendChild(accountRow);

    // Role-specific services
    if (mode === 'host')      content.appendChild(makeHostContent());
    else if (mode === 'guide')   content.appendChild(makeGuideContent());
    else if (mode === 'partner') content.appendChild(makePartnerContent());
    else                         content.appendChild(makeVisitorContent()); // default

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

  // Expose stub immediately
  window.Drawer = { mount: mount, open: () => {}, close: () => {} };
})();
