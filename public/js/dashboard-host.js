// public/js/dashboard-host.js

document.addEventListener('DOMContentLoaded', () => {
  initHostDashboard().catch(err => {
    console.error('[HOST DASH] init failed:', err);
  });
});

async function initHostDashboard() {
  const container = document.getElementById('host-services');
  const infoEl    = document.getElementById('host-services-info');
  const nameSlot  = document.querySelector('[data-user-name]');

  if (!container) {
    console.warn('[HOST DASH] #host-services not found');
    return;
  }

  container.innerHTML = '';
  if (infoEl) infoEl.textContent = 'Loading your services…';

  let payload;
  try {
    const res = await fetch('/api/services', {
      method: 'GET',
      credentials: 'include'
    });

    if (!res.ok) {
      // Most likely not logged in as host
      location.href = '/host.html';
      return;
    }

    payload = await res.json();
  } catch (err) {
    console.error('[HOST DASH] /api/services error:', err);
    if (infoEl) infoEl.textContent = 'Error loading services. Please refresh the page.';
    return;
  }

  const user    = payload.user    || {};
  const modules = payload.modules || [];

  if (!user || user.role !== 'host') {
    location.href = '/host.html';
    return;
  }

  if (nameSlot && user.displayName) {
    nameSlot.textContent = user.displayName;
  }

  // If only one service → go directly to its main manage page
  if (modules.length === 1) {
    const m        = modules[0];
    const sKey     = String(m.service_key || '').toLowerCase();
    const manage   = Array.isArray(m.managePages) ? m.managePages : [];
    const mainPage = findMainPage(manage);
    const target   = buildManageUrl(sKey, mainPage.slug);
    location.href  = target;
    return;
  }

  // Multiple services → render cards
  container.innerHTML = '';

  if (!modules.length) {
    if (infoEl) infoEl.textContent = 'No services are currently attached to your account.';
    return;
  }

  // Sort by position then key
  const sorted = modules.slice().sort((a, b) => {
    const pa = a.position ?? 0;
    const pb = b.position ?? 0;
    if (pa !== pb) return pa - pb;
    const ka = String(a.service_key || '');
    const kb = String(b.service_key || '');
    return ka.localeCompare(kb);
  });

  sorted.forEach(m => {
    const card = createServiceCard(m);
    container.appendChild(card);
  });

  if (infoEl) infoEl.textContent = '';
  initCardIconBehaviour();
}

/** Build /modules/<serviceKey>/manage/<slug> */
function buildManageUrl(serviceKey, slug) {
  const safeSlug = slug || 'main.html';
  return `/modules/${serviceKey}/manage/${safeSlug}`;
}

/** Find "main.html" from pages, or fallback to first */
function findMainPage(pages) {
  if (!Array.isArray(pages) || !pages.length) {
    return { slug: 'main.html', label: 'Main' };
  }
  const main = pages.find(p => p.slug === 'main.html');
  return main || pages[0];
}

/** Build one card from a module entry returned by /api/services */
function createServiceCard(module) {
  const key   = String(module.service_key || '').toLowerCase();
  const title = module.display_name || niceNameFromKey(key);

  const managePages = Array.isArray(module.managePages) ? module.managePages : [];
  const mainPage    = findMainPage(managePages);

  const card = document.createElement('div');
  card.className = 'card module-card';
  if (module.status) {
    card.dataset.status = module.status;
  }

  // icon_base: "/modules/<service>/icons/<basename>"
  const iconBase = module.icon_base || `/modules/${key}/icons/${key}`;
  const offSrc   = iconBase + '-off.png';
  const hoverSrc = iconBase + '-hover.png';
  const onSrc    = iconBase + '-on.png';

  // Main link (card header)
  const mainHref = buildManageUrl(key, mainPage.slug);

  card.innerHTML = `
    <a href="${mainHref}" class="card-main">
      <img src="${offSrc}" alt="${title} Logo" class="logo"
           data-off-src="${offSrc}"
           data-hover-src="${hoverSrc}"
           data-on-src="${onSrc}">
      <h3>${escapeHtml(title)}</h3>
      <p class="card-subtitle">Create & manage</p>
    </a>
    <div class="card-links"></div>
  `;

  // Status badge if trial/suspended/upcoming
  const status = module.status;
  if (status && status !== 'active') {
    const badge = document.createElement('span');
    badge.className = `status-badge status-${status}`;
    badge.textContent = statusLabel(status);
    card.appendChild(badge);
  }

  // Sub-links from managePages (excluding main)
  const linksWrap = card.querySelector('.card-links');
  if (linksWrap && managePages.length) {
    const others = managePages.filter(p => p.slug !== mainPage.slug);
    others.forEach(p => {
      const href  = buildManageUrl(key, p.slug);
      const label = p.label || p.slug.replace('.html', '');
      const a = document.createElement('a');
      a.href = href;
      a.className = 'card-link';
      a.textContent = label;
      linksWrap.appendChild(a);
    });
  }

  return card;
}

/** Initialize icon hover + selected states */
function initCardIconBehaviour() {
  const cards = document.querySelectorAll('.module-card');

  cards.forEach(card => {
    const img      = card.querySelector('.logo');
    const mainLink = card.querySelector('.card-main');
    if (!img || !mainLink) return;

    const offSrc   = img.dataset.offSrc   || img.dataset.offsrc   || img.getAttribute('data-off-src')   || img.src;
    const hoverSrc = img.dataset.hoverSrc || img.dataset.hoversrc || img.getAttribute('data-hover-src') || offSrc;
    const onSrc    = img.dataset.onSrc    || img.dataset.onsrc    || img.getAttribute('data-on-src')    || offSrc;

    // Preload hover & on images
    [hoverSrc, onSrc].forEach(src => { const i = new Image(); i.src = src; });

    // Hover behavior on card
    card.addEventListener('mouseenter', () => {
      if (card.classList.contains('selected')) {
        img.src = onSrc;
      } else {
        img.src = hoverSrc;
      }
    });

    card.addEventListener('mouseleave', () => {
      if (card.classList.contains('selected')) {
        img.src = onSrc;
      } else {
        img.src = offSrc;
      }
    });

    // Selection on main link click
    mainLink.addEventListener('click', () => {
      // Deselect all
      cards.forEach(c => {
        c.classList.remove('selected');
        const logo = c.querySelector('.logo');
        if (logo && logo.getAttribute('data-off-src')) {
          logo.src = logo.getAttribute('data-off-src');
        }
      });

      // Select current card
      card.classList.add('selected');
      img.src = onSrc;
      // We do NOT preventDefault: navigation still happens
    });
  });
}

function statusLabel(s) {
  switch (String(s)) {
    case 'trial':     return 'Trial';
    case 'upcoming':  return 'Coming soon';
    case 'suspended': return 'Suspended';
    default:          return '';
  }
}

/** Fallback title builder from service key */
function niceNameFromKey(k) {
  return String(k || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

/** Basic HTML escaping for titles */
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
