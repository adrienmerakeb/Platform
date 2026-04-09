// /modules/In-Time/manage/calendar-sync.js
// Front-end calendar sync control for In-Time queue creation / management
//
// Concepts (IMPORTANT):
// 1) Host-level connection (OAuth tokens exist for provider)  -> "CONNECTED"
//    - Comes from GET /api/host/calendar/status
// 2) Queue-level enablement (user approved sync for THIS queue) -> "ENABLED"
//    - Stored in hidden inputs: calGoogleConnected / calMsConnected / calOtherConnected
//
// UI rules:
// - Not connected: badge "Connect"
// - Connected but not enabled: badge "Review"
// - Connected + enabled: badge "Enabled"
//
// Exports:
//   - setupCalendarSync(rootEl, initialState)
//   - getCalendarSyncState()

/* -------------------------------------------------------------------------- */
/* CONFIG                                                                     */
/* -------------------------------------------------------------------------- */

const HIDDEN_IDS = {
  google: 'calGoogleConnected',
  microsoft: 'calMsConnected',
  other: 'calOtherConnected',
};

// Grid range and sizing
const DAYS_RANGE = 91; // today..D+90
const START_HOUR = 0;
const END_HOUR = 24;

// “Focus” and grey ranges
const ACTIVE_START = 8;
const ACTIVE_END = 18;

// Sizing (tuned for "HH:MM - HH:MM" on one line)
const ROW_H = 38;
const COL_W = 104; // enough for "08:00 - 18:00"
const LEFT_W = 88;

// Day header circle size (≈2.5× typical small chips)
const CIRCLE_SIZE = 88;

// Scrollbar minimal visibility
const SCROLLBAR_WIDTH = 'thin'; // Firefox
const SCROLLBAR_OPACITY = 0.35;

// Lunch highlight range
const LUNCH_START_HOUR = 12; // 12:00
const LUNCH_END_HOUR = 13; // 13:00

// Colors (kept neutral + aligned with your requirements)
const OFF_HOURS_BG = '#f2f2f2';
const WEEKEND_BG = '#f2f2f2';
const LUNCH_BG = '#e9f7e9'; // light apple green
const HEADER_MONTH_BG = '#f7f7f7';
const HEADER_DAY_BG = '#fafafa';
const GRID_LINE_SOFT = 'rgba(0,0,0,0.06)';
const WEEK_SEP = 'rgba(0,0,0,0.18)';
const MONTH_SEP = '#666';
const YEAR_SEP = '#333';

/* -------------------------------------------------------------------------- */
/* BASIC HELPERS                                                              */
/* -------------------------------------------------------------------------- */

function readHiddenBool(id) {
  const el = document.getElementById(id);
  if (!el) return false;
  return String(el.value).trim() === '1';
}

function writeHiddenBool(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.value = value ? '1' : '0';
}

const pad2 = (n) => String(n).padStart(2, '0');

function fmtHM(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function weekday3(d) {
  return d.toLocaleDateString(undefined, { weekday: 'short' });
}

function monthLabel(d) {
  const m = d.toLocaleDateString(undefined, { month: 'short' });
  return `${m}. ${d.getFullYear()}`;
}

function isoLocalDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function isWeekend(d) {
  const day = d.getDay();
  return day === 0 || day === 6;
}

function isMonday(d) {
  return d.getDay() === 1;
}

function isFirstOfMonth(d) {
  return d.getDate() === 1;
}

function isFirstOfYear(d) {
  return d.getMonth() === 0 && d.getDate() === 1;
}

/* -------------------------------------------------------------------------- */
/* returnTo helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Always return to the same page, but force tab=2 so the calendar segment is visible.
 */
function buildReturnToForceTab2() {
  const url = new URL(window.location.href);

  const isModules = url.pathname.startsWith('/modules/');
  const safePath = isModules ? url.pathname : '/modules/In-Time/manage/page%201.html';

  const qs = new URLSearchParams(url.search);
  qs.set('tab', '2');
  qs.delete('calendar');
  qs.delete('status');

  const hash = url.hash || '';
  return `${safePath}?${qs.toString()}${hash}`;
}

function normalizeProviderFromReturnParam(cal) {
  const v = String(cal || '').toLowerCase().trim();
  if (v === 'google') return 'google';
  if (v === 'microsoft' || v === 'ms' || v === 'outlook') return 'microsoft';
  if (v === 'other') return 'other';
  return null;
}

/* -------------------------------------------------------------------------- */
/* Backend status                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Expected:
 * { ok:true, providers:{ google:boolean, microsoft:boolean, other:boolean } }
 */
async function fetchBackendStatus() {
  try {
    const res = await fetch('/api/host/calendar/status', {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) return null;

    const json = await res.json().catch(() => null);
    if (!json || json.ok !== true) return null;

    return json;
  } catch (e) {
    console.error('[CalendarSync] status fetch error:', e);
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* OAuth start                                                                */
/* -------------------------------------------------------------------------- */

async function startProviderOAuth(provider) {
  const returnTo = buildReturnToForceTab2();
  const startUrl =
    provider === 'google'
      ? `/api/host/calendar/google/start?returnTo=${encodeURIComponent(returnTo)}`
      : provider === 'microsoft'
      ? `/api/host/calendar/microsoft/start?returnTo=${encodeURIComponent(returnTo)}`
      : null;

  if (!startUrl) {
    alert('This calendar provider is not supported yet.');
    return;
  }

  try {
    const res = await fetch(startUrl, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) {
      alert(`Unable to start ${provider} connection (server error).`);
      return;
    }

    const json = await res.json().catch(() => null);
    if (!json || !json.ok || !json.authUrl) {
      alert(`${provider} calendar is not properly configured on the server.`);
      return;
    }

    window.location.href = json.authUrl;
  } catch (e) {
    console.error('[CalendarSync] OAuth start error:', e);
    alert(`An error occurred while starting ${provider} connection.`);
  }
}

/* -------------------------------------------------------------------------- */
/* Availability                                                               */
/* -------------------------------------------------------------------------- */

async function fetchAvailability(provider) {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const chunks = [];
    for (let i = 0; i < Math.ceil(DAYS_RANGE / 7); i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i * 7);

      const params = new URLSearchParams({
        provider,
        view: 'week',
        date: isoLocalDate(d),
      });

      chunks.push(`/api/host/calendar/availability?${params.toString()}`);
    }

    const allBusy = [];
    let timezone = null;

    for (const url of chunks) {
      const res = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });

      if (!res.ok) continue;

      const json = await res.json().catch(() => null);
      if (!json || json.ok !== true) continue;

      timezone = timezone || json.timezone || null;

      const busySlots = Array.isArray(json.busySlots) ? json.busySlots : [];
      busySlots.forEach((b) => {
        if (b && b.start && b.end) allBusy.push({ start: b.start, end: b.end });
      });
    }

    return { ok: true, timezone, busySlots: allBusy };
  } catch (e) {
    console.error('[CalendarSync] availability fetch error:', e);
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Busy blocks processing                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Convert slots into per-day segments, and merge continuous segments.
 * Returns: Map<YYYY-MM-DD, Array<{start:Date,end:Date}>>
 */
function buildMergedBusyByDay(busySlots) {
  const byDay = new Map();

  const pushSeg = (dateKey, seg) => {
    if (!byDay.has(dateKey)) byDay.set(dateKey, []);
    byDay.get(dateKey).push(seg);
  };

  (busySlots || []).forEach((slot) => {
    const s = new Date(slot.start);
    const e = new Date(slot.end);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return;
    if (e <= s) return;

    let curStart = new Date(s);
    while (curStart < e) {
      const dayEnd = new Date(curStart);
      dayEnd.setHours(24, 0, 0, 0);

      const curEnd = e < dayEnd ? new Date(e) : dayEnd;
      const key = isoLocalDate(curStart);

      pushSeg(key, { start: new Date(curStart), end: new Date(curEnd) });

      curStart = new Date(curEnd);
    }
  });

  for (const [day, segs] of byDay.entries()) {
    segs.sort((a, b) => a.start - b.start);

    const merged = [];
    for (const seg of segs) {
      const last = merged[merged.length - 1];
      if (!last) {
        merged.push(seg);
        continue;
      }
      // merge continuous/overlapping
      if (seg.start <= last.end) {
        if (seg.end > last.end) last.end = seg.end;
      } else {
        merged.push(seg);
      }
    }
    byDay.set(day, merged);
  }

  return byDay;
}

/* -------------------------------------------------------------------------- */
/* Grid renderer: Today..D+90                                                 */
/* -------------------------------------------------------------------------- */

let _scrollbarStyleInjected = false;

function ensureScrollbarStyleOnce() {
  if (_scrollbarStyleInjected) return;
  _scrollbarStyleInjected = true;

  const styleTag = document.createElement('style');
  styleTag.textContent = `
    #calendarGridScroller::-webkit-scrollbar { height: 8px; width: 8px; }
    #calendarGridScroller::-webkit-scrollbar-track { background: rgba(0,0,0,0.06); border-radius: 999px; }
    #calendarGridScroller::-webkit-scrollbar-thumb { background: rgba(0,0,0,${SCROLLBAR_OPACITY}); border-radius: 999px; }

    /* Prevent overlay blocks from blurring text when scrolling */
    #calendarGridOverlay > div { will-change: transform; }
  `;
  document.head.appendChild(styleTag);
}

function borderLeftForDate(d) {
  if (isFirstOfYear(d)) return `4px double ${YEAR_SEP}`; // Year separator: double hard
  if (isFirstOfMonth(d)) return `2px solid ${MONTH_SEP}`; // Month separator: hard
  if (isMonday(d)) return `1px solid ${WEEK_SEP}`; // Week separator: soft
  return `1px solid ${GRID_LINE_SOFT}`; // default soft
}

function renderD90Grid(container, availability) {
  container.innerHTML = '';

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const days = Array.from({ length: DAYS_RANGE }, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    return d;
  });

  const busyByDay = availability?.busySlots
    ? buildMergedBusyByDay(availability.busySlots)
    : new Map();

  ensureScrollbarStyleOnce();

  // Outer scroller for both horizontal + vertical
  const scroller = document.createElement('div');
  scroller.id = 'calendarGridScroller';
  scroller.style.position = 'relative';
  scroller.style.overflow = 'auto';
  scroller.style.maxHeight = '62vh';
  scroller.style.border = '1px solid #e0e0e0';
  scroller.style.borderRadius = '14px';
  scroller.style.background = '#fff';

  scroller.style.scrollbarWidth = SCROLLBAR_WIDTH;
  scroller.style.scrollbarColor = `rgba(0,0,0,${SCROLLBAR_OPACITY}) rgba(0,0,0,0.06)`;

  // Sticky current-month label (must sit above first CALENDAR column, not time column)
  const stickyMonth = document.createElement('div');
  stickyMonth.id = 'stickyCurrentMonthLabel';
  stickyMonth.style.position = 'sticky';
  stickyMonth.style.top = '0';
  stickyMonth.style.left = `${LEFT_W}px`;       // ✅ align to first calendar column
  stickyMonth.style.zIndex = '40';
  stickyMonth.style.background = HEADER_MONTH_BG;
  stickyMonth.style.borderBottom = '1px solid #ddd';
  stickyMonth.style.padding = '6px 10px';
  stickyMonth.style.fontWeight = '900';
  stickyMonth.style.color = '#000';
  stickyMonth.style.pointerEvents = 'none';
  stickyMonth.style.boxShadow = '0 1px 0 rgba(0,0,0,0.04)';
  scroller.appendChild(stickyMonth);

  // Table
  const table = document.createElement('table');
  table.style.borderCollapse = 'separate';
  table.style.borderSpacing = '0';
  table.style.tableLayout = 'fixed';
  table.style.width = `${LEFT_W + days.length * COL_W}px`;

  const colgroup = document.createElement('colgroup');
  const colLeft = document.createElement('col');
  colLeft.style.width = `${LEFT_W}px`;
  colgroup.appendChild(colLeft);
  days.forEach(() => {
    const col = document.createElement('col');
    col.style.width = `${COL_W}px`;
    colgroup.appendChild(col);
  });
  table.appendChild(colgroup);

  const thead = document.createElement('thead');

  // Month row (sticky)
  const trMonth = document.createElement('tr');
  const thMonthCorner = document.createElement('th');
  thMonthCorner.style.position = 'sticky';
  thMonthCorner.style.left = '0';
  thMonthCorner.style.top = '0';
  thMonthCorner.style.zIndex = '35';
  thMonthCorner.style.background = HEADER_MONTH_BG;
  thMonthCorner.style.borderBottom = '1px solid #ddd';
  thMonthCorner.style.width = `${LEFT_W}px`;
  thMonthCorner.textContent = ''; // empty above time column
  trMonth.appendChild(thMonthCorner);

  days.forEach((d) => {
    const th = document.createElement('th');
    th.style.position = 'sticky';
    th.style.top = '0';
    th.style.zIndex = '30';
    th.style.background = HEADER_MONTH_BG;
    th.style.borderBottom = '1px solid #ddd';
    th.style.padding = '6px 6px';
    th.style.color = '#000';
    th.style.fontWeight = '900';
    th.style.fontSize = '0.85rem';
    th.style.textAlign = 'left';
    th.style.borderLeft = borderLeftForDate(d);

    // ✅ Month/year info above the first day-of-month column
    th.textContent = isFirstOfMonth(d) ? monthLabel(d) : '';
    trMonth.appendChild(th);
  });

  thead.appendChild(trMonth);

  // Day row (sticky below month row) — header circle
  const trDay = document.createElement('tr');

  const thDayCorner = document.createElement('th');
  thDayCorner.style.position = 'sticky';
  thDayCorner.style.left = '0';
  thDayCorner.style.top = '0'; // corrected after mount
  thDayCorner.style.zIndex = '35';
  thDayCorner.style.background = HEADER_DAY_BG;
  thDayCorner.style.borderBottom = '1px solid #ddd';
  thDayCorner.textContent = '';
  trDay.appendChild(thDayCorner);

  days.forEach((d) => {
    const th = document.createElement('th');
    th.style.position = 'sticky';
    th.style.top = '0'; // corrected after mount
    th.style.zIndex = '30';
    th.style.background = HEADER_DAY_BG;
    th.style.borderBottom = '1px solid #ddd';
    th.style.padding = '10px 0';
    th.style.textAlign = 'center';
    th.style.color = '#000';
    th.style.fontWeight = '900';
    th.style.borderLeft = borderLeftForDate(d);

    // ✅ Day header circle: bigger, grey bg, contains weekday + date number
    const circle = document.createElement('div');
    circle.style.width = `${CIRCLE_SIZE}px`;
    circle.style.height = `${CIRCLE_SIZE}px`;
    circle.style.borderRadius = '999px';
    circle.style.background = '#e0e0e0';
    circle.style.margin = '0 auto';
    circle.style.display = 'flex';
    circle.style.flexDirection = 'column';
    circle.style.alignItems = 'center';
    circle.style.justifyContent = 'center';
    circle.style.gap = '6px';
    circle.style.boxShadow = 'inset 0 0 0 1px rgba(0,0,0,0.12)';

    const wd = document.createElement('div');
    wd.textContent = weekday3(d);
    wd.style.fontSize = '1.0rem';
    wd.style.fontWeight = '900';
    wd.style.color = '#000';

    const dn = document.createElement('div');
    dn.textContent = String(d.getDate());
    dn.style.fontSize = '1.4rem';
    dn.style.fontWeight = '900';
    dn.style.color = '#000';

    circle.appendChild(wd);
    circle.appendChild(dn);
    th.appendChild(circle);

    trDay.appendChild(th);
  });

  thead.appendChild(trDay);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  // Body rows 00:00 -> 24:00
  for (let h = START_HOUR; h < END_HOUR; h++) {
    const tr = document.createElement('tr');
    tr.style.height = `${ROW_H}px`;

    // Sticky time column
    const tdTime = document.createElement('td');
    tdTime.style.position = 'sticky';
    tdTime.style.left = '0';
    tdTime.style.zIndex = '20';
    tdTime.style.background = HEADER_DAY_BG;
    tdTime.style.borderRight = '1px solid rgba(0,0,0,0.08)';
    tdTime.style.color = '#000';
    tdTime.style.width = `${LEFT_W}px`;

    const tLabel = document.createElement('div');
    tLabel.textContent = `${pad2(h)}:00`;
    tLabel.style.position = 'relative';
    tLabel.style.top = '-9px';
    tLabel.style.paddingLeft = '10px';
    tLabel.style.fontWeight = '900';
    tLabel.style.fontSize = '0.85rem';
    tdTime.appendChild(tLabel);

    tr.appendChild(tdTime);

    const isOffHoursRow = h < ACTIVE_START || h >= ACTIVE_END;
    const isLunchRow = h >= LUNCH_START_HOUR && h < LUNCH_END_HOUR;

    days.forEach((d) => {
      const td = document.createElement('td');
      const weekend = isWeekend(d);

      // ✅ Off-hours grey; ✅ Weekends grey (same style); ✅ Lunch apple green
      if (isLunchRow) td.style.background = LUNCH_BG;
      else if (weekend || isOffHoursRow) td.style.background = weekend ? WEEKEND_BG : OFF_HOURS_BG;
      else td.style.background = '#fff';

      td.style.borderBottom = `1px solid ${GRID_LINE_SOFT}`;
      td.style.padding = '0';
      td.style.position = 'relative';
      td.style.borderLeft = borderLeftForDate(d);

      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  }

  table.appendChild(tbody);

  // Wrapper to overlay busy blocks in absolute positioning
  const rel = document.createElement('div');
  rel.style.position = 'relative';
  rel.style.width = table.style.width;

  const overlay = document.createElement('div');
  overlay.id = 'calendarGridOverlay';
  overlay.style.position = 'absolute';
  overlay.style.left = '0';
  overlay.style.top = '0';
  overlay.style.pointerEvents = 'none';

  rel.appendChild(table);
  rel.appendChild(overlay);
  scroller.appendChild(rel);
  container.appendChild(scroller);

  // Fix second header row top offset + sticky month label height alignment
  requestAnimationFrame(() => {
    const monthRowH = trMonth.getBoundingClientRect().height || 38;
    Array.from(trDay.children).forEach((th) => {
      th.style.top = `${monthRowH}px`;
    });
    thDayCorner.style.top = `${monthRowH}px`;
    thMonthCorner.style.top = '0';

    // Make sticky month label visually "belong" to month row height
    stickyMonth.style.height = `${monthRowH}px`;
    stickyMonth.style.display = 'flex';
    stickyMonth.style.alignItems = 'center';
  });

  function updateStickyMonthLabel() {
    // Determine first visible day column based on horizontal scroll
    const firstVisibleIndex = Math.max(0, Math.floor(scroller.scrollLeft / COL_W));
    const d = days[Math.min(firstVisibleIndex, days.length - 1)];
    stickyMonth.textContent = monthLabel(d);
  }
  scroller.addEventListener('scroll', updateStickyMonthLabel);
  updateStickyMonthLabel();

  // Map a day key to column index (relative to today)
  function dayIndexFromDateKey(key) {
    const [yy, mm, dd] = key.split('-').map(Number);
    const d = new Date(yy, mm - 1, dd);
    d.setHours(0, 0, 0, 0);
    const diffDays = Math.round((d - today) / (24 * 3600 * 1000));
    return diffDays;
  }

  // Compute header heights for overlay placement
  const monthHNow = trMonth.getBoundingClientRect().height || 38;
  const dayHNow = trDay.getBoundingClientRect().height || 92;
  const headerHNow = monthHNow + dayHNow;

  overlay.style.width = `${LEFT_W + days.length * COL_W}px`;
  overlay.style.height = `${headerHNow + (END_HOUR - START_HOUR) * ROW_H}px`;

  // ✅ Busy blocks rendered as merged continuous blocks per day, label at top "hh:mm - hh:mm"
  for (const [dayKey, segs] of busyByDay.entries()) {
    const idx = dayIndexFromDateKey(dayKey);
    if (idx < 0 || idx >= days.length) continue;

    segs.forEach((seg) => {
      const start = seg.start;
      const end = seg.end;

      const sHour = start.getHours() + start.getMinutes() / 60;
      const eHour = end.getHours() + end.getMinutes() / 60;

      const x = LEFT_W + idx * COL_W;
      const y = headerHNow + sHour * ROW_H;
      const h = Math.max(10, (eHour - sHour) * ROW_H);
      const w = COL_W;

      const block = document.createElement('div');
      block.style.position = 'absolute';
      block.style.left = `${x}px`;
      block.style.top = `${y}px`;
      block.style.width = `${w}px`;
      block.style.height = `${h}px`;
      block.style.boxSizing = 'border-box';
      block.style.background = 'rgba(255, 152, 0, 0.18)';
      block.style.border = '1px solid rgba(255, 152, 0, 0.55)';
      block.style.borderRadius = '10px';
      block.style.overflow = 'hidden';

      const label = document.createElement('div');
      label.textContent = `${fmtHM(start)} - ${fmtHM(end)}`;
      label.style.fontSize = '0.8rem';
      label.style.fontWeight = '900';
      label.style.color = '#000';
      label.style.padding = '6px 6px';
      label.style.whiteSpace = 'nowrap';
      label.style.textOverflow = 'ellipsis';
      label.style.overflow = 'hidden';
      label.style.background = 'rgba(255,255,255,0.55)';
      label.style.borderBottom = '1px solid rgba(255, 152, 0, 0.25)';

      block.appendChild(label);
      overlay.appendChild(block);
    });
  }

  // ✅ Vertical scroll kept, auto-centered on 08:00–18:00
  requestAnimationFrame(() => {
    const focusTop = headerHNow + ACTIVE_START * ROW_H;
    const focusBottom = headerHNow + ACTIVE_END * ROW_H;
    const focusMid = (focusTop + focusBottom) / 2;
    scroller.scrollTop = Math.max(0, focusMid - scroller.clientHeight / 2);
  });
}

/* -------------------------------------------------------------------------- */
/* Chip visuals                                                               */
/* -------------------------------------------------------------------------- */

function updateChipVisual(chip, { hostConnected, queueEnabled }) {
  if (!chip) return;

  chip.classList.toggle('connected', !!hostConnected);
  chip.classList.toggle('enabled', !!queueEnabled);

  const badge = chip.querySelector('.inline-badge');
  if (!badge) return;

  if (!hostConnected) badge.textContent = 'Connect';
  else if (hostConnected && !queueEnabled) badge.textContent = 'Review';
  else badge.textContent = 'Enabled';
}

/* -------------------------------------------------------------------------- */
/* Verification modal                                                         */
/* -------------------------------------------------------------------------- */

function openCalendarVerificationModal(provider, onDecision) {
  const existing = document.getElementById('calendarVerificationOverlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'calendarVerificationOverlay';
  overlay.style.position = 'fixed';
  overlay.style.inset = '0';
  overlay.style.background = 'rgba(0,0,0,0.45)';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.zIndex = '9999';

  const dialog = document.createElement('div');
  dialog.style.background = '#fff';
  dialog.style.borderRadius = '18px';
  dialog.style.maxWidth = '1080px';
  dialog.style.width = '96%';
  dialog.style.maxHeight = '92vh';
  dialog.style.display = 'flex';
  dialog.style.flexDirection = 'column';
  dialog.style.padding = '16px 16px 12px';
  dialog.style.boxShadow = '0 10px 30px rgba(0,0,0,0.25)';
  dialog.style.fontFamily =
    'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  dialog.style.overflow = 'hidden'; // important for sticky footer visuals

  const header = document.createElement('div');
  header.style.marginBottom = '10px';

  const title = document.createElement('h2');
  title.textContent = 'Please review data extracted from your connected calendar';
  title.style.margin = '0 0 6px 0';
  title.style.fontSize = '1.05rem';
  title.style.fontWeight = '900';
  title.style.color = '#000';

  const msg = document.createElement('div');
  msg.textContent =
    'Busy blocks will be imported into this queue’s internal calendar. Please verify accuracy before approving.';
  msg.style.fontSize = '0.9rem';
  msg.style.color = '#555';

  header.appendChild(title);
  header.appendChild(msg);

  const previewWrapper = document.createElement('div');
  previewWrapper.style.flex = '1';
  previewWrapper.style.minHeight = '260px';
  previewWrapper.style.maxHeight = '66vh';
  previewWrapper.style.borderRadius = '14px';
  previewWrapper.style.background = '#fff';
  previewWrapper.style.overflow = 'hidden'; // grid scroller handles its own scroll

  const previewInner = document.createElement('div');
  previewInner.style.fontSize = '0.9rem';
  previewWrapper.appendChild(previewInner);

  const footer = document.createElement('div');
  footer.style.display = 'flex';
  footer.style.justifyContent = 'space-between';
  footer.style.alignItems = 'center';
  footer.style.marginTop = '12px';
  footer.style.gap = '10px';

  // ✅ Modal footer always visible
  footer.style.position = 'sticky';
  footer.style.bottom = '0';
  footer.style.background = '#fff';
  footer.style.paddingTop = '10px';
  footer.style.zIndex = '50';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.padding = '10px 16px';
  cancelBtn.style.fontSize = '0.95rem';
  cancelBtn.style.borderRadius = '999px';
  cancelBtn.style.border = '1px solid #999';
  cancelBtn.style.background = '#fff';
  cancelBtn.style.color = '#000';
  cancelBtn.style.cursor = 'pointer';
  cancelBtn.style.fontWeight = '900';
  cancelBtn.style.minWidth = '120px';

  const approveBtn = document.createElement('button');
  approveBtn.type = 'button';
  approveBtn.textContent = 'Approve';
  approveBtn.style.padding = '10px 18px';
  approveBtn.style.fontSize = '0.95rem';
  approveBtn.style.borderRadius = '999px';
  approveBtn.style.border = 'none';
  approveBtn.style.background = '#2e7d32';
  approveBtn.style.color = '#fff';
  approveBtn.style.cursor = 'pointer';
  approveBtn.style.fontWeight = '900';
  approveBtn.style.minWidth = '140px';
  approveBtn.style.boxShadow = '0 6px 16px rgba(46,125,50,0.25)';

  footer.appendChild(cancelBtn);
  footer.appendChild(approveBtn);

  dialog.appendChild(header);
  dialog.appendChild(previewWrapper);
  dialog.appendChild(footer);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  function close() {
    overlay.remove();
  }

  cancelBtn.addEventListener('click', () => {
    onDecision?.({ provider, enableForQueue: false });
    close();
  });

  approveBtn.addEventListener('click', () => {
    onDecision?.({ provider, enableForQueue: true });
    close();
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  (async () => {
    previewInner.innerHTML =
      '<p style="margin:8px 0; font-size:0.9rem;">Loading calendar availability…</p>';

    if (provider === 'other') {
      previewInner.innerHTML =
        '<p style="margin:8px 0; font-size:0.9rem;">Other providers are not configured yet.</p>';
      return;
    }

    const data = await fetchAvailability(provider);
    if (!data || !data.ok) {
      previewInner.innerHTML =
        '<p style="margin:8px 0; font-size:0.9rem;">Unable to load availability from server. Please verify directly in your calendar app.</p>';
      return;
    }

    renderD90Grid(previewInner, data);
  })();
}

/* -------------------------------------------------------------------------- */
/* OAuth return handler                                                       */
/* -------------------------------------------------------------------------- */

function handleOAuthReturn(openReview) {
  const params = new URLSearchParams(window.location.search);
  const cal = params.get('calendar');
  const status = params.get('status');
  if (!cal || !status) return;

  const provider = normalizeProviderFromReturnParam(cal);
  if (!provider) return;

  if (status === 'connected') {
    openReview(provider);

    if (window.history && window.history.replaceState) {
      const url = new URL(window.location.href);
      url.searchParams.delete('calendar');
      url.searchParams.delete('status');
      window.history.replaceState({}, '', url.toString());
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export function getCalendarSyncState() {
  return {
    google: readHiddenBool(HIDDEN_IDS.google),
    microsoft: readHiddenBool(HIDDEN_IDS.microsoft),
    other: readHiddenBool(HIDDEN_IDS.other),
  };
}

export function setupCalendarSync(rootEl, initialState = {}) {
  try {
    if (!rootEl) return;

    const chips = Array.from(rootEl.querySelectorAll('.calendar-chip[data-provider]'));
    if (!chips.length) return;

    const queueEnabled = {
      google:
        typeof initialState.google === 'boolean'
          ? initialState.google
          : readHiddenBool(HIDDEN_IDS.google),
      microsoft:
        typeof initialState.microsoft === 'boolean'
          ? initialState.microsoft
          : readHiddenBool(HIDDEN_IDS.microsoft),
      other:
        typeof initialState.other === 'boolean'
          ? initialState.other
          : readHiddenBool(HIDDEN_IDS.other),
    };

    const hostConnected = { google: false, microsoft: false, other: false };

    function applyAllVisuals() {
      chips.forEach((chip) => {
        const provider = chip.dataset.provider;
        if (!provider || !HIDDEN_IDS[provider]) return;

        updateChipVisual(chip, {
          hostConnected: !!hostConnected[provider],
          queueEnabled: !!queueEnabled[provider],
        });
      });

      Object.keys(HIDDEN_IDS).forEach((p) => {
        writeHiddenBool(HIDDEN_IDS[p], !!queueEnabled[p]);
      });
    }

    function openReview(provider) {
      openCalendarVerificationModal(provider, ({ provider, enableForQueue }) => {
        if (provider === 'google' || provider === 'microsoft' || provider === 'other') {
          queueEnabled[provider] = !!enableForQueue;
        }
        applyAllVisuals();
      });
    }

    applyAllVisuals();

    (async () => {
      const status = await fetchBackendStatus();
      if (!status) return;

      const providers = status.providers || {};
      if (typeof providers.google === 'boolean') hostConnected.google = providers.google;
      if (typeof providers.microsoft === 'boolean') hostConnected.microsoft = providers.microsoft;
      if (typeof providers.other === 'boolean') hostConnected.other = providers.other;

      applyAllVisuals();
    })();

    handleOAuthReturn((provider) => {
      hostConnected[provider] = true;
      applyAllVisuals();
      openReview(provider);
    });

    chips.forEach((chip) => {
      const provider = chip.dataset.provider;
      if (!provider || !HIDDEN_IDS[provider]) return;

      chip.addEventListener('click', async (e) => {
        e.preventDefault();

        if (!hostConnected[provider]) {
          if (provider === 'google' || provider === 'microsoft') {
            return startProviderOAuth(provider);
          }
          alert('Other calendars (CalDAV / iCal) are not configured yet.');
          return;
        }

        openReview(provider);
      });
    });
  } catch (err) {
    // Critical: never break page scripts because of calendar UI
    console.error('[CalendarSync] setup error:', err);
  }
}
