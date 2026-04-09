// /modules/Let's Get Out!/manage/letsgetout-main.js

async function fetchMe() {
  try {
    const res = await fetch('/api/me', { credentials: 'include' });
    if (!res.ok) throw new Error('Not authenticated');
    const data = await res.json();
    return data.user || null;
  } catch (e) {
    console.error('[LGO manage] /api/me failed:', e);
    // Dashboards live in public root
    window.location.href = '/visitor.html';
    return null;
  }
}

async function setStatus(newStatus) {
  const r = await fetch('/api/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ status: newStatus })
  });
  if (!r.ok) {
    alert('Could not update status');
    throw new Error('Status update failed');
  }
}

async function performLogout() {
  try {
    await fetch('/api/logout', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    console.warn('[LGO manage] Logout failed (non-blocking):', e);
  } finally {
    // Back to visitor dashboard in public root
    window.location.href = '/visitor.html';
  }
}

function updateRoleUI(user) {
  const txt   = document.getElementById('lgo-role-text');
  const pill  = document.getElementById('lgo-role-pill');
  const label = document.getElementById('lgo-role-label');
  if (!txt || !pill || !label) return;

  let desc = '';
  let pillText = '';

  if (user.role === 'visitor') {
    const status = user.status || 'V';
    if (status === 'G') {
      desc     = 'You are signed in as Visitor (Guide only).';
      pillText = 'Visitor — Guide only (G)';
    } else if (status === 'VG') {
      desc     = 'You are signed in as Visitor (Visitor & Guide).';
      pillText = 'Visitor & Guide (VG)';
    } else {
      desc     = 'You are signed in as Visitor (Visitor only). Guiding tools are limited.';
      pillText = 'Visitor only (V)';
    }
  } else if (user.role === 'host') {
    desc     = 'You are signed in as Host. You can create and manage guidings for your organization.';
    pillText = 'Host';
  } else {
    desc     = `You are signed in as ${user.role || 'user'}.`;
    pillText = user.role || 'User';
  }

  txt.textContent   = desc || 'You are signed in.';
  label.textContent = pillText;
  pill.style.display = 'inline-flex';
}

/* ----------------------------------------------------------
 * Role switch dropdown (same dynamic as dashboard)
 * -------------------------------------------------------- */

function initRoleSwitchMenu(me) {
  const roleSwitchEl = document.getElementById('role-switch');
  if (!roleSwitchEl) return;

  const options = roleSwitchEl.querySelectorAll('.role-switch-option');

  function openMenu() {
    roleSwitchEl.classList.add('open');
    roleSwitchEl.setAttribute('aria-hidden', 'false');
  }

  function closeMenu() {
    roleSwitchEl.classList.remove('open');
    roleSwitchEl.setAttribute('aria-hidden', 'true');
  }

  function toggleMenu() {
    if (roleSwitchEl.classList.contains('open')) {
      closeMenu();
    } else {
      openMenu();
    }
  }

  // Mark active option based on current status
  const activeView =
    me.status === 'G'  ? 'guide' :
    me.status === 'VG' ? 'vg'    :
    'visitor';
  const activeBtn = roleSwitchEl.querySelector(`[data-view="${activeView}"]`);
  if (activeBtn) activeBtn.classList.add('active');

  options.forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const view = btn.dataset.view;

      // Visual active state
      options.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      closeMenu();

      let targetStatus = 'V';
      if (view === 'guide') {
        targetStatus = 'G';
      } else if (view === 'vg') {
        targetStatus = 'VG';
      }

      try {
        if (me.status !== targetStatus) {
          await setStatus(targetStatus);
          me.status = targetStatus;
        }
      } catch (err) {
        console.error('Status switch failed:', err);
        return;
      }

      if (view === 'visitor') {
        // Visitor dashboard in public root
        window.location.href = '/visitor.html';
      } else if (view === 'guide') {
        // Stay on / reload LGO manage main HTML under modules/Let's Get Out!/manage
        const target = "/modules/Let's Get Out!/manage/main.html";
        if (window.location.pathname !== target) {
          window.location.href = target;
        } else {
          window.location.reload();
        }
      } else if (view === 'vg') {
        // For now, reuse visitor dashboard as combined view
        window.location.href = '/visitor.html';
      }
    });
  });

  // Close when clicking outside
  document.addEventListener('click', (e) => {
    if (!roleSwitchEl.classList.contains('open')) return;
    if (!roleSwitchEl.contains(e.target)) {
      closeMenu();
    }
  });

  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && roleSwitchEl.classList.contains('open')) {
      closeMenu();
    }
  });

  // Expose toggler for FAB bottom-right button — same API as dashboard
  window.VisitorDashboard = window.VisitorDashboard || {};
  window.VisitorDashboard.toggleRoleSwitch = toggleMenu;
  window.VisitorDashboard.logout = performLogout;
}

/* ----------------------------------------------------------
 * FAB + Drawer
 * -------------------------------------------------------- */

function mountChrome(me) {
  if (window.Drawer && typeof window.Drawer.mount === 'function') {
    window.Drawer.mount({
      mode: me.role === 'visitor' ? 'visitor' : 'host',
      onLogout: performLogout
    });
  }

  if (!window.FAB || typeof window.FAB.mount !== 'function') return;

  const isVisitor = me.role === 'visitor';

  const options = {
    useTopBand: true,
    useBottomBand: true,

    // TOP-LEFT: Home → drawer
    home: {
      title: 'Home / Services',
      label: '🏠',
      onClick: () => {
        if (window.Drawer && typeof window.Drawer.open === 'function') {
          window.Drawer.open();
        } else if (isVisitor) {
          // Visitor dashboard in root
          window.location.href = '/visitor.html';
        } else {
          // Host dashboard in root (assuming /host.html)
          window.location.href = '/host.html';
        }
      }
    },

    // TOP-RIGHT: Let’s Get Out! settings (still under modules)
    config: {
      title: "Let's Get Out! — Settings",
      label: '⚙️',
      href: "/modules/Let's Get Out!/manage/settings.html"
    },

    // BOTTOM-LEFT: Logout
    logout: {
      title: 'Logout',
      iconPath: '/icons/ion-png-black/md-log-out.png',
      onClick: () => performLogout()
    }
  };

  if (isVisitor) {
    // Same behaviour as dashboard: BR opens role-switch menu
    options.br = {
      title: 'Change view',
      label: '👤',
      onClick: () =>
        window.VisitorDashboard &&
        window.VisitorDashboard.toggleRoleSwitch &&
        window.VisitorDashboard.toggleRoleSwitch()
    };
  } else {
    // For hosts/others: BR is a simple back button
    options.br = {
      title: 'Back',
      label: '‹',
      onClick: () => history.back()
    };
  }

  window.FAB.mount(options);
}

/* ----------------------------------------------------------
 * Cards wiring
 * -------------------------------------------------------- */

function wireCards() {
  const btnCreate = document.getElementById('btnCreateGuiding');
  const btnManage = document.getElementById('btnManageGuidings');

  if (btnCreate) {
    // Go to page 1.html in modules/Let's Get Out!/manage
    btnCreate.addEventListener('click', () => {
      window.location.href = "/modules/Let's Get Out!/manage/page 1.html";
    });
  }

  if (btnManage) {
    // Go to page 2.html in modules/Let's Get Out!/manage
    btnManage.addEventListener('click', () => {
      window.location.href = "/modules/Let's Get Out!/manage/page 2.html";
    });
  }
}

/* ----------------------------------------------------------
 * INIT
 * -------------------------------------------------------- */

(async function init() {
  const me = await fetchMe();
  if (!me) return;

  updateRoleUI(me);
  wireCards();

  // Only show the role-switch menu for visitors (V/G/VG)
  if (me.role === 'visitor') {
    initRoleSwitchMenu(me);
  }

  mountChrome(me);
})();
