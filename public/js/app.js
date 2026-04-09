// js/app.js

// 1) Module registry (lazy-loaded)
const Registry = {
  'in-time':     () => import('./modules/in-time.js'),
  'lets-get-out':() => import('./modules/lets-get-out.js'),
  'my-events':   () => import('./modules/my-events.js'),
  'promos':      () => import('./modules/promos.js'),
};

// 2) Map DB/service strings to canonical keys above
const CanonicalMap = {
  // host selected_services strings you’re storing:
  'In-Time - Virtual queuing services': 'in-time',
  'Let’s Get Out - Tour guiding services': 'lets-get-out',
  'My events - Events organizing services': 'my-events',
  'Cool Stuff - Promos & discounts management services': 'promos',

  // partner is promos (and later ads)
  'promos': 'promos',

  // visitor defaults (if you later store flags, map them here)
  'in-time': 'in-time',
  'lets-get-out': 'lets-get-out',
  'my-events': 'my-events',
  'promos': 'promos',
};

// 3) Fetch who’s logged and resolve active modules
async function fetchIdentity() {
  const me = await fetch('/api/me').then(r => r.ok ? r.json() : Promise.reject());
  const user = me.user; // { role, name, ... }
  if (!user) throw new Error('No user');
  let active = [];

  if (user.role === 'host') {
    const h = await fetch('/api/host/me').then(r => r.json());
    const raw = (() => {
      try {
        return JSON.parse(h.host?.selected_services || '[]');
      } catch { return []; }
    })();
    active = raw.map(s => CanonicalMap[s]).filter(Boolean);
    return { user: { name: h.host.company_name, role: 'host' }, active };
  }

  if (user.role === 'partner') {
    // For now partners = promos; extend later with "ads"
    return { user: { name: user.name || 'Partner', role: 'partner' }, active: ['promos'] };
  }

  // Visitors: show 4 modules by default (you can refine later based on preferences)
  return { user: { name: user.name || 'Visitor', role: 'visitor' }, active: ['in-time','lets-get-out','my-events','promos'] };
}

// 4) Render helpers
const $ = sel => document.querySelector(sel);
const modulesEl = $('#modules');
const emptyEl = $('#empty');
const toolbarEl = $('#toolbar');
const appEl = $('#app');

function setHeader({ name, role }) {
  $('#user-name').textContent = name || '—';
  $('#user-role').textContent = role;
}

function setSingleMode(enabled) {
  if (enabled) appEl.classList.add('single');
  else appEl.classList.remove('single');
}

function buildToolbar(activeKeys, onPick, currentKey) {
  toolbarEl.innerHTML = '';
  if (activeKeys.length <= 1) { toolbarEl.hidden = true; return; }
  activeKeys.forEach(k => {
    const chip = document.createElement('button');
    chip.className = 'chip' + (currentKey === k ? ' active' : '');
    chip.textContent = titleFor(k);
    chip.onclick = () => onPick(k);
    toolbarEl.appendChild(chip);
  });
  toolbarEl.hidden = false;
}

function titleFor(key) {
  return ({
    'in-time': 'In-Time — Queues',
    'lets-get-out': 'Let’s Get Out — Guides',
    'my-events': 'My Events',
    'promos': 'Promos & Discounts',
  })[key] || key;
}

async function mountModule(key, where) {
  const mod = await Registry[key]().then(m => m.default);
  // module card
  const card = document.createElement('article');
  card.className = 'module-card';
  card.innerHTML = `
    <div class="module-head">
      <div class="module-title">${titleFor(key)}</div>
      <div></div>
    </div>
    <div class="module-body"></div>
  `;
  where.appendChild(card);
  await mod.render(card.querySelector('.module-body'));
}

// 5) Main bootstrap
(async function init() {
  try {
    const { user, active } = await fetchIdentity();
    setHeader(user);

    if (!active.length) {
      emptyEl.hidden = false;
      return;
    }

    // Single-module focus if exactly 1
    setSingleMode(active.length === 1);
    modulesEl.innerHTML = '';

    if (active.length === 1) {
      await mountModule(active[0], modulesEl);
      buildToolbar(active, () => {}, active[0]); // shows chips disabled (only 1)
    } else {
      // Multi-column grid: mount all
      for (const k of active) {
        await mountModule(k, modulesEl);
      }
      // Optional: allow “focus view” by clicking a chip
      buildToolbar(active, async (pick) => {
        // focus that one module
        setSingleMode(true);
        modulesEl.innerHTML = '';
        await mountModule(pick, modulesEl);
        buildToolbar(active, arguments.callee, pick);
      }, null);
    }

  } catch (e) {
    console.error('Dashboard init failed:', e);
    emptyEl.hidden = false;
    emptyEl.innerHTML = `Could not load dashboard. <br><small>${String(e?.message || e)}</small>`;
  }

  // logout
  $('#logout').onclick = async () => {
    await fetch('/api/logout', { method:'POST' });
    location.href = '/';
  };
})();
