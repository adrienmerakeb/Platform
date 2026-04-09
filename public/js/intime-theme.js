/**
 * intime-theme.js  — Shared host UI theme panel  (v3 — expanded)
 * Covers: page_1, page_1-2, page_2, page_3
 *
 * Exposes on window:
 *   openStylePanel()  closeStylePanel()  resetStylePanel()
 *   InTimeTheme.appendSection(html)
 *   InTimeTheme.onApply(fn)
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'intime_host_theme_v2';
  const PREFS_NS    = 'host_pages';
  const PREFS_API   = '/api/intime/host/prefs';

  /* ── Google Fonts map ──────────────────────────────────────
     key  = option value shown in <select>
     gf   = Google Fonts family name (null = system font, no load needed)
     css  = actual CSS font-family stack                               */
  const FONTS = {
    'DM Sans':          { gf:'DM+Sans:opsz,wght@9..40,300..700', css:"'DM Sans',sans-serif" },
    'Inter':            { gf:'Inter:wght@300..700',               css:"'Inter',sans-serif" },
    'Poppins':          { gf:'Poppins:wght@300;400;500;600;700',  css:"'Poppins',sans-serif" },
    'Montserrat':       { gf:'Montserrat:wght@300..700',          css:"'Montserrat',sans-serif" },
    'Raleway':          { gf:'Raleway:wght@300..700',             css:"'Raleway',sans-serif" },
    'Lato':             { gf:'Lato:wght@300;400;700',             css:"'Lato',sans-serif" },
    'Nunito':           { gf:'Nunito:wght@300..700',              css:"'Nunito',sans-serif" },
    'Roboto':           { gf:'Roboto:wght@300;400;500;700',       css:"'Roboto',sans-serif" },
    'Open Sans':        { gf:'Open+Sans:wght@300..700',           css:"'Open Sans',sans-serif" },
    'Playfair Display': { gf:'Playfair+Display:wght@400;600;700', css:"'Playfair Display',Georgia,serif" },
    'Merriweather':     { gf:'Merriweather:wght@300;400;700',     css:"'Merriweather',Georgia,serif" },
    'Georgia':          { gf: null,                               css:"Georgia,'Times New Roman',serif" },
    'System UI':        { gf: null,                               css:"system-ui,-apple-system,sans-serif" },
    'Monospace':        { gf: null,                               css:"'Courier New',Courier,monospace" },
  };

  const _loadedFonts = new Set();
  function ensureFont(name) {
    const entry = FONTS[name];
    if (!entry || !entry.gf || _loadedFonts.has(name)) return;
    _loadedFonts.add(name);
    const link = document.createElement('link');
    link.rel  = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${entry.gf}&display=swap`;
    document.head.appendChild(link);
  }

  /* ── Defaults ──────────────────────────────────────────── */
  const DEFAULTS = {
    /* Colours */
    pageBg:        '#f4f3f8',
    pageBgOpacity: 1.0,
    accent:        '#7c3aed',
    accentTxt:     '#ffffff',
    cardBg:        '#ffffff',
    cardBgOpacity: 1.0,
    cardBlur:      0,
    txtColor:      '#1a1825',
    mutedColor:    '#6b6880',
    borderColor:   '#e2e0ea',
    borderWidth:   1,
    borderStyle:   'solid',
    btnBg:         '',       /* '' = derive from accent */
    btnTxt:        '#ffffff',
    /* Wallpaper */
    wallpaper:     '',
    wallOpacity:   0.18,
    /* Typography */
    font:          'DM Sans',
    fontSize:      15,
    fontWeight:    400,
    lineHeight:    1.55,
    letterSpacing: 0,
    /* Corners */
    cardRadius:    14,
    inputRadius:   9,
    /* Shadow */
    shadowIntensity: 1.0,
    shadowColor:   '#000000',
  };

  let state = { ...DEFAULTS };
  let _applyHooks = [];
  let _saveTimer  = null;

  /* ── Colour helpers ────────────────────────────────────── */
  function hexDarken(hex, amt = 0.12) {
    const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    const h = v => Math.max(0,Math.min(255,Math.round(v*(1-amt)))).toString(16).padStart(2,'0');
    return '#'+h(r)+h(g)+h(b);
  }
  function hexLighten(hex, amt = 0.88) {
    const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    const m = v => Math.round(v*(1-amt) + 255*amt);
    const h = v => v.toString(16).padStart(2,'0');
    return '#'+h(m(r))+h(m(g))+h(m(b));
  }
  function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  /* ── Apply state → injected <style> ───────────────────── */
  function applyState(s) {
    const fontEntry = FONTS[s.font] || FONTS['DM Sans'];
    ensureFont(s.font);
    const fontStack = fontEntry.css;

    const accent  = s.accent  || DEFAULTS.accent;
    const accentD = hexDarken(accent, 0.14);
    const accentS = hexLighten(accent, 0.88);
    const btnBg   = s.btnBg   || accent;
    const btnBgD  = hexDarken(btnBg, 0.14);

    const pageBgRgba  = hexToRgba(s.pageBg,  s.pageBgOpacity  ?? 1);
    const cardBgRgba  = hexToRgba(s.cardBg,  s.cardBgOpacity  ?? 1);
    const shadowRgba  = hexToRgba(s.shadowColor || '#000000', 0.07 * (s.shadowIntensity ?? 1));
    const shadow2Rgba = hexToRgba(s.shadowColor || '#000000', 0.05 * (s.shadowIntensity ?? 1));
    const shadowLg    = hexToRgba(s.shadowColor || '#000000', 0.20 * (s.shadowIntensity ?? 1));
    const blurVal     = s.cardBlur ? `blur(${s.cardBlur}px)` : 'none';
    const bw          = (s.borderWidth ?? 1) + 'px';
    const bs          = s.borderStyle || 'solid';
    const borderShort = `${bw} ${bs} ${s.borderColor || DEFAULTS.borderColor}`;

    const wallOverlay = s.wallpaper
      ? `linear-gradient(${hexToRgba('#ffffff', 1-(s.wallOpacity??0.18))},${hexToRgba('#ffffff', 1-(s.wallOpacity??0.18))}), url("${s.wallpaper}")`
      : 'none';

    const lh = (s.lineHeight ?? 1.55).toFixed(2);
    const ls = s.letterSpacing ? `${s.letterSpacing}px` : 'normal';
    const fw = s.fontWeight || 400;
    const ri = (s.inputRadius ?? 9);

    let tag = document.getElementById('it-theme');
    if (!tag) { tag = document.createElement('style'); tag.id = 'it-theme'; document.head.appendChild(tag); }

    tag.textContent = `
      @import url('');

      :root {
        --v:      ${accent}   !important;
        --v-d:    ${accentD}  !important;
        --v-s:    ${accentS}  !important;
        --bord-f: ${accent}   !important;
        --ring:   0 0 0 3px ${hexToRgba(accent, 0.18)} !important;
        --bg:     ${pageBgRgba}  !important;
        --surf:   ${cardBgRgba}  !important;
        --txt:    ${s.txtColor}  !important;
        --muted:  ${s.mutedColor || DEFAULTS.mutedColor} !important;
        --hint:   ${hexLighten(s.mutedColor || DEFAULTS.mutedColor, 0.25)} !important;
        --bord:   ${s.borderColor || DEFAULTS.borderColor} !important;
        --gray:   ${hexLighten(s.pageBg, 0.5)} !important;
        --gray-m: ${hexLighten(s.borderColor || DEFAULTS.borderColor, 0.3)} !important;
        --r:      ${s.cardRadius}px  !important;
        --ri:     ${ri}px  !important;
        --font:   ${fontStack} !important;
        --sh:     0 2px 16px ${shadowRgba}, 0 1px 3px ${shadow2Rgba} !important;
      }
      html, body {
        font-size:      ${s.fontSize}px !important;
        font-family:    ${fontStack} !important;
        font-weight:    ${fw} !important;
        line-height:    ${lh} !important;
        letter-spacing: ${ls} !important;
        background-color: ${pageBgRgba} !important;
        color: ${s.txtColor} !important;
        ${s.wallpaper ? `
        background-image: ${wallOverlay} !important;
        background-size: cover !important;
        background-attachment: fixed !important;
        background-repeat: no-repeat !important;
        ` : ''}
      }
      /* Cards & surfaces */
      .card, .frame-card, .host-card, .toolbar, .mbox,
      .capsule-wrap .cap-core, .slotcard, .chsec {
        background: ${cardBgRgba} !important;
        backdrop-filter: ${blurVal} !important;
        -webkit-backdrop-filter: ${blurVal} !important;
        border: ${borderShort} !important;
        border-radius: ${s.cardRadius}px !important;
        box-shadow: 0 2px 16px ${shadowRgba}, 0 1px 3px ${shadow2Rgba} !important;
        color: ${s.txtColor} !important;
      }
      /* Inputs, selects, textareas */
      input[type=text], input[type=email], input[type=url], input[type=number],
      input[type=time], input[type=date], textarea, select,
      .tb-input, .tb-sel {
        background: ${cardBgRgba} !important;
        color: ${s.txtColor} !important;
        border: 1.5px ${bs} ${s.borderColor || DEFAULTS.borderColor} !important;
        border-radius: ${ri}px !important;
        font-family: ${fontStack} !important;
        font-size: ${s.fontSize}px !important;
      }
      /* Primary buttons */
      .btn-p, .tb-btn.primary, .mbtn.primary, .drb.primary,
      .scan-btn-primary, .resume-btn {
        background: ${btnBg} !important;
        border-color: ${btnBgD} !important;
        color: ${s.btnTxt || '#fff'} !important;
        font-family: ${fontStack} !important;
      }
      .btn-p:hover, .tb-btn.primary:hover, .mbtn.primary:hover,
      .scan-btn-primary:hover {
        background: ${btnBgD} !important;
      }
      /* Secondary / outline buttons */
      .btn-s, .tb-btn:not(.primary), .mbtn.sec, .ab-btn.sec,
      .act-btn, .mod-link {
        border: ${borderShort} !important;
        border-radius: ${ri}px !important;
        font-family: ${fontStack} !important;
        font-size: ${s.fontSize - 1}px !important;
      }
      /* All buttons radius */
      .btn, .btn-p, .btn-s, .btn-skip, .btn-add, .tb-btn,
      .mbtn, .ab-btn, .act-btn, .scan-btn, .ldb, .drb {
        border-radius: ${ri}px !important;
        font-family: ${fontStack} !important;
      }
      /* Text colours */
      .muted, .lead, .hint, p.hint, .sb-sub, .tog-desc,
      .brow-lbl, .cdesc, .cex, .revk {
        color: ${s.mutedColor || DEFAULTS.mutedColor} !important;
      }
      /* Borders */
      .sep, .cap-sep, .togrow, .srow, .erow, .brow, .revrow {
        border-color: ${s.borderColor || DEFAULTS.borderColor} !important;
      }
      /* Progress bar */
      .prog {
        border-bottom: 1px ${bs} ${s.borderColor || DEFAULTS.borderColor} !important;
      }
      /* Modal overlay */
      .overlay, .leave-dialog-overlay, .draft-resume-overlay {
        backdrop-filter: blur(4px) !important;
      }
      .mbox, .leave-dialog, .draft-resume-box {
        background: ${cardBgRgba} !important;
        border: ${borderShort} !important;
        box-shadow: 0 20px 60px ${shadowLg} !important;
      }
      /* Typography */
      *, *::before, *::after {
        font-family: ${fontStack} !important;
        letter-spacing: ${ls} !important;
      }
      h1, h2, h3, .card-hd h1, .pg-hd h1 {
        font-family: ${fontStack} !important;
        color: ${s.txtColor} !important;
      }
    `;

    _applyHooks.forEach(fn => { try { fn(s); } catch(e) {} });
  }

  /* ── Debounce ──────────────────────────────────────────── */
  function debounced(fn, ms) {
    return function(...args) {
      clearTimeout(_saveTimer);
      _saveTimer = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  /* ── Persistence ───────────────────────────────────────── */
  const pushToServer = debounced(async function() {
    try {
      await fetch(PREFS_API, {
        method: 'PATCH', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ namespace: PREFS_NS, prefs: state }),
      });
    } catch(e) { console.warn('[InTimeTheme] server save failed:', e); }
  }, 900);

  function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(e) {}
    pushToServer();
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) state = { ...DEFAULTS, ...JSON.parse(raw) };
    } catch(e) {}
    applyState(state);

    fetch(PREFS_API, { credentials:'same-origin', headers:{ Accept:'application/json' } })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        const sv = data?.prefs?.[PREFS_NS];
        if (sv && typeof sv === 'object') {
          state = { ...DEFAULTS, ...sv };
          try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(e) {}
          applyState(state);
          const panel = document.getElementById('it-style-panel');
          if (panel && panel.classList.contains('open')) syncControls(state);
        }
      })
      .catch(e => console.warn('[InTimeTheme] server load failed (offline?):', e));
  }

  /* ── Sync panel controls to state ─────────────────────── */
  function syncControls(s) {
    const set   = (id, v)    => { const e = document.getElementById(id); if (e) e.value = v; };
    const setSw = (id, col)  => { const e = document.getElementById(id); if (e) e.style.background = col; };
    const setLbl= (id, v, u) => { const e = document.getElementById(id); if (e) e.textContent = v+(u||''); };

    set('it-cp-pageBg',       s.pageBg);         setSw('it-sw-pageBg',    s.pageBg);
    set('it-cp-accent',       s.accent);          setSw('it-sw-accent',    s.accent);
    set('it-cp-accentTxt',    s.accentTxt||'#ffffff'); setSw('it-sw-accentTxt', s.accentTxt||'#ffffff');
    set('it-cp-btnBg',        s.btnBg||s.accent); setSw('it-sw-btnBg',     s.btnBg||s.accent);
    set('it-cp-btnTxt',       s.btnTxt||'#ffffff'); setSw('it-sw-btnTxt',  s.btnTxt||'#ffffff');
    set('it-cp-cardBg',       s.cardBg);          setSw('it-sw-cardBg',    s.cardBg);
    set('it-cp-txtColor',     s.txtColor);        setSw('it-sw-txtColor',  s.txtColor);
    set('it-cp-mutedColor',   s.mutedColor||DEFAULTS.mutedColor); setSw('it-sw-mutedColor', s.mutedColor||DEFAULTS.mutedColor);
    set('it-cp-borderColor',  s.borderColor||DEFAULTS.borderColor); setSw('it-sw-borderColor', s.borderColor||DEFAULTS.borderColor);
    set('it-cp-shadowColor',  s.shadowColor||'#000000'); setSw('it-sw-shadowColor', s.shadowColor||'#000000');

    set('it-sl-pageBgOpacity',  Math.round((s.pageBgOpacity??1)*100));
    setLbl('it-sv-pageBgOpacity', Math.round((s.pageBgOpacity??1)*100), '%');
    set('it-sl-cardBgOpacity',  Math.round((s.cardBgOpacity??1)*100));
    setLbl('it-sv-cardBgOpacity', Math.round((s.cardBgOpacity??1)*100), '%');
    set('it-sl-cardBlur',    s.cardBlur??0);   setLbl('it-sv-cardBlur',    s.cardBlur??0,   'px');
    set('it-sl-cardRadius',  s.cardRadius);    setLbl('it-sv-cardRadius',  s.cardRadius,    'px');
    set('it-sl-inputRadius', s.inputRadius);   setLbl('it-sv-inputRadius', s.inputRadius,   'px');
    set('it-sl-borderWidth', s.borderWidth??1); setLbl('it-sv-borderWidth', s.borderWidth??1, 'px');
    set('it-sel-borderStyle', s.borderStyle||'solid');
    set('it-sl-shadowInt',   Math.round((s.shadowIntensity??1)*100));
    setLbl('it-sv-shadowInt', Math.round((s.shadowIntensity??1)*100), '%');

    set('it-sel-font',       s.font);
    set('it-sl-fontSize',    s.fontSize);      setLbl('it-sv-fontSize',    s.fontSize,      'px');
    set('it-sl-fontWeight',  s.fontWeight||400); setLbl('it-sv-fontWeight',  s.fontWeight||400, '');
    set('it-sl-lineHeight',  Math.round((s.lineHeight??1.55)*100));
    setLbl('it-sv-lineHeight', ((s.lineHeight??1.55)).toFixed(2), '');
    set('it-sl-letterSpacing', s.letterSpacing??0);
    setLbl('it-sv-letterSpacing', s.letterSpacing??0, 'px');

    set('it-sl-wallOp', Math.round((s.wallOpacity??0.18)*100));
    setLbl('it-sv-wallOp', Math.round((s.wallOpacity??0.18)*100), '%');

    const wp = document.getElementById('it-wall-preview');
    const wr = document.getElementById('it-wall-remove');
    const wo = document.getElementById('it-wall-op-row');
    if (wp) { wp.src = s.wallpaper||''; wp.style.display = s.wallpaper ? 'block' : 'none'; }
    if (wr) wr.style.display  = s.wallpaper ? '' : 'none';
    if (wo) wo.style.display  = s.wallpaper ? '' : 'none';
  }

  /* ── Wire controls ─────────────────────────────────────── */
  function wireControls() {
    function onColor(cpId, swId, key) {
      const cp = document.getElementById(cpId);
      const sw = document.getElementById(swId);
      if (!cp) return;
      cp.addEventListener('input', e => {
        state[key] = e.target.value;
        if (sw) sw.style.background = e.target.value;
        applyState(state); saveState();
      });
    }
    function onSlider(slId, svId, key, unit, transform, labelFn) {
      const sl = document.getElementById(slId);
      const sv = document.getElementById(svId);
      if (!sl) return;
      sl.addEventListener('input', e => {
        const raw = parseFloat(e.target.value);
        state[key] = transform ? transform(raw) : raw;
        const display = labelFn ? labelFn(raw) : (transform ? transform(raw) : raw);
        if (sv) sv.textContent = display + (unit||'');
        applyState(state); saveState();
      });
    }
    function onSelect(selId, key) {
      const sel = document.getElementById(selId);
      if (!sel) return;
      sel.addEventListener('change', e => { state[key] = e.target.value; applyState(state); saveState(); });
    }

    // Colours
    onColor('it-cp-pageBg',      'it-sw-pageBg',      'pageBg');
    onColor('it-cp-accent',      'it-sw-accent',      'accent');
    onColor('it-cp-accentTxt',   'it-sw-accentTxt',   'accentTxt');
    onColor('it-cp-btnBg',       'it-sw-btnBg',       'btnBg');
    onColor('it-cp-btnTxt',      'it-sw-btnTxt',      'btnTxt');
    onColor('it-cp-cardBg',      'it-sw-cardBg',      'cardBg');
    onColor('it-cp-txtColor',    'it-sw-txtColor',     'txtColor');
    onColor('it-cp-mutedColor',  'it-sw-mutedColor',  'mutedColor');
    onColor('it-cp-borderColor', 'it-sw-borderColor', 'borderColor');
    onColor('it-cp-shadowColor', 'it-sw-shadowColor', 'shadowColor');

    // Opacity / transparency sliders (raw 0–100 → 0.0–1.0)
    onSlider('it-sl-pageBgOpacity',  'it-sv-pageBgOpacity',  'pageBgOpacity',  '%', v => parseFloat((v/100).toFixed(2)));
    onSlider('it-sl-cardBgOpacity',  'it-sv-cardBgOpacity',  'cardBgOpacity',  '%', v => parseFloat((v/100).toFixed(2)));
    onSlider('it-sl-cardBlur',       'it-sv-cardBlur',       'cardBlur',       'px');
    onSlider('it-sl-shadowInt',      'it-sv-shadowInt',      'shadowIntensity','%', v => parseFloat((v/100).toFixed(2)));
    onSlider('it-sl-borderWidth',    'it-sv-borderWidth',    'borderWidth',    'px');
    onSelect('it-sel-borderStyle',   'borderStyle');

    // Corners
    onSlider('it-sl-cardRadius',  'it-sv-cardRadius',  'cardRadius',  'px');
    onSlider('it-sl-inputRadius', 'it-sv-inputRadius', 'inputRadius', 'px');

    // Typography
    onSelect('it-sel-font', 'font');
    onSlider('it-sl-fontSize',     'it-sv-fontSize',     'fontSize',     'px');
    onSlider('it-sl-fontWeight',   'it-sv-fontWeight',   'fontWeight',   '',
      v => [300,400,500,600,700].reduce((a,b) => Math.abs(b-v)<Math.abs(a-v)?b:a),
      v => [300,400,500,600,700].reduce((a,b) => Math.abs(b-v)<Math.abs(a-v)?b:a));
    onSlider('it-sl-lineHeight',   'it-sv-lineHeight',   'lineHeight',   '',
      v => parseFloat((v/100).toFixed(2)),
      v => (v/100).toFixed(2));
    onSlider('it-sl-letterSpacing','it-sv-letterSpacing','letterSpacing','px');

    // Wallpaper
    onSlider('it-sl-wallOp', 'it-sv-wallOp', 'wallOpacity', '%', v => parseFloat((v/100).toFixed(2)));
    const wallInput = document.getElementById('it-wall-input');
    if (wallInput) {
      wallInput.addEventListener('change', e => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
          const dataUrl = ev.target.result;
          if (dataUrl.length > 7000000) {
            alert('Image too large (> ~5 MB). Please compress or choose a smaller file.');
            return;
          }
          state.wallpaper = dataUrl;
          const wp = document.getElementById('it-wall-preview');
          if (wp) { wp.src = dataUrl; wp.style.display = 'block'; }
          const wr = document.getElementById('it-wall-remove');
          if (wr) wr.style.display = '';
          const wo = document.getElementById('it-wall-op-row');
          if (wo) wo.style.display = '';
          applyState(state); saveState();
        };
        reader.readAsDataURL(file);
      });
    }
  }

  /* ── Panel HTML helpers ────────────────────────────────── */
  const SEL_STYLE = `flex-shrink:0;padding:6px 28px 6px 10px;border:1.5px solid #e2e0ea;border-radius:8px;font-size:13px;color:#1a1825;background:#fff;cursor:pointer;appearance:none;background-image:url('data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2714%27 height=%2714%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%236b6880%27 stroke-width=%272%27%3E%3Cpath d=%27M6 9l6 6 6-6%27/%3E%3C/svg%3E');background-repeat:no-repeat;background-position:right 8px center;outline:none`;

  function colorRow(cpId, swId, label, hint) {
    return `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:11px">
      <div style="min-width:0">
        <div style="font-size:13px;font-weight:600;color:#1a1825;white-space:nowrap">${label}</div>
        ${hint ? `<div style="font-size:11px;color:#9b98aa;margin-top:1px">${hint}</div>` : ''}
      </div>
      <div style="width:34px;height:34px;border-radius:8px;border:2px solid #e2e0ea;cursor:pointer;overflow:hidden;flex-shrink:0;position:relative">
        <div id="${swId}" style="width:100%;height:100%;border-radius:5px;pointer-events:none"></div>
        <input type="color" id="${cpId}" style="position:absolute;inset:-4px;width:calc(100% + 8px);height:calc(100% + 8px);opacity:0;cursor:pointer;border:none;padding:0">
      </div>
    </div>`;
  }

  function sliderRow(slId, svId, label, unit, min, max, step, hint) {
    return `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:11px">
      <div style="min-width:0">
        <span style="font-size:13px;font-weight:600;color:#1a1825">${label}</span>
        ${hint ? `<div style="font-size:11px;color:#9b98aa;margin-top:1px">${hint}</div>` : ''}
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
        <input type="range" id="${slId}" min="${min}" max="${max}" step="${step}" style="width:90px;accent-color:#7c3aed;cursor:pointer">
        <span id="${svId}" style="font-size:12px;font-weight:600;color:#6b6880;min-width:36px;text-align:right"></span>
      </div>
    </div>`;
  }

  function sectionTitle(label) {
    return `<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#9b98aa;margin-bottom:10px;margin-top:2px">${label}</div>`;
  }

  function divider() {
    return `<div style="height:1px;background:#f0eff5;margin:4px 0"></div>`;
  }

  /* ── Build panel HTML ──────────────────────────────────── */
  function buildPanelHTML() {
    const fontOptions = Object.keys(FONTS).map(name =>
      `<option value="${name}">${name}</option>`
    ).join('');

    return `
<div id="it-style-overlay" onclick="closeStylePanel()" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.42);backdrop-filter:blur(3px);z-index:10000;opacity:0;transition:opacity .25s"></div>
<div id="it-style-panel" role="dialog" aria-label="Page style settings" style="position:fixed;top:0;right:0;bottom:0;width:min(360px,94vw);background:#fff;z-index:10001;display:flex;flex-direction:column;transform:translateX(105%);transition:transform .3s cubic-bezier(.4,0,.2,1);box-shadow:-4px 0 32px rgba(0,0,0,.18)">

  <!-- Header -->
  <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px 13px;border-bottom:1px solid #e5e5e5;flex-shrink:0">
    <span style="font-size:15px;font-weight:700;color:#1a1825;display:flex;align-items:center;gap:8px">
      🎨 Page style
      <span style="font-size:10px;font-weight:700;background:#f0fdf4;color:#16a34a;border:1px solid #86efac;padding:2px 7px;border-radius:20px">● Live · synced</span>
    </span>
    <button onclick="closeStylePanel()" title="Close" style="width:28px;height:28px;border-radius:50%;border:none;background:#f0eff5;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center" onmouseover="this.style.background='#e2e0ea'" onmouseout="this.style.background='#f0eff5'">✕</button>
  </div>

  <!-- Scrollable body -->
  <div id="it-sp-body" style="flex:1;overflow-y:auto;padding:14px 18px;display:flex;flex-direction:column;gap:2px">

    ${sectionTitle('Colours')}
    ${colorRow('it-cp-pageBg',     'it-sw-pageBg',     'Page background', '')}
    ${colorRow('it-cp-accent',     'it-sw-accent',     'Accent',          'Focus rings, active states')}
    ${colorRow('it-cp-btnBg',      'it-sw-btnBg',      'Button background','Primary action buttons')}
    ${colorRow('it-cp-btnTxt',     'it-sw-btnTxt',     'Button text',     '')}
    ${colorRow('it-cp-cardBg',     'it-sw-cardBg',     'Card / surface',  'Cards, panels, toolbar')}
    ${colorRow('it-cp-txtColor',   'it-sw-txtColor',   'Body text',       '')}
    ${colorRow('it-cp-mutedColor', 'it-sw-mutedColor', 'Muted text',      'Descriptions, hints, labels')}
    ${colorRow('it-cp-borderColor','it-sw-borderColor','Border',          '')}
    ${colorRow('it-cp-shadowColor','it-sw-shadowColor','Shadow tint',     '')}

    ${divider()}
    ${sectionTitle('Transparency & Blur')}
    ${sliderRow('it-sl-pageBgOpacity', 'it-sv-pageBgOpacity', 'Page background opacity', '%', 10, 100, 5, 'Lower = more see-through with wallpaper')}
    ${sliderRow('it-sl-cardBgOpacity', 'it-sv-cardBgOpacity', 'Card opacity',            '%', 10, 100, 5, 'Frosted glass effect on cards')}
    ${sliderRow('it-sl-cardBlur',      'it-sv-cardBlur',      'Card backdrop blur',      'px', 0, 20, 1, 'Requires card opacity < 100%')}
    ${sliderRow('it-sl-shadowInt',     'it-sv-shadowInt',     'Shadow intensity',        '%',  0, 200, 10, '')}

    ${divider()}
    ${sectionTitle('Wallpaper')}
    <img id="it-wall-preview" src="" alt="Wallpaper preview" style="display:none;width:100%;max-height:80px;object-fit:cover;border-radius:8px;border:1.5px solid #e2e0ea;margin-bottom:8px">
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:4px">
      <label style="flex:1;display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:8px 12px;border-radius:9px;border:1.5px dashed #e2e0ea;font-size:12.5px;font-weight:600;color:#6b6880;cursor:pointer;transition:all .15s;min-width:0" onmouseover="this.style.borderColor='#7c3aed';this.style.color='#7c3aed'" onmouseout="this.style.borderColor='#e2e0ea';this.style.color='#6b6880'">
        📷 Upload (max 5 MB)
        <input type="file" id="it-wall-input" accept="image/*" style="display:none">
      </label>
      <button id="it-wall-remove" onclick="window.InTimeTheme._removeWallpaper()" style="display:none;padding:8px 12px;border-radius:9px;border:1.5px solid #fca5a5;background:#fef2f2;color:#dc2626;font-size:12px;font-weight:600;cursor:pointer;flex-shrink:0">✕ Remove</button>
    </div>
    <div id="it-wall-op-row" style="display:none">
      ${sliderRow('it-sl-wallOp', 'it-sv-wallOp', 'White overlay opacity', '-', 0, 100, 5, 'Lower = wallpaper shows more strongly')}
    </div>

    ${divider()}
    ${sectionTitle('Typography')}
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:11px">
      <span style="font-size:13px;font-weight:600;color:#1a1825">Font family</span>
      <select id="it-sel-font" style="${SEL_STYLE};max-width:155px">${fontOptions}</select>
    </div>
    ${sliderRow('it-sl-fontSize',     'it-sv-fontSize',     'Size',           'px', 12, 20, 1, '')}
    ${sliderRow('it-sl-fontWeight',   'it-sv-fontWeight',   'Weight',         '',  300, 700, 100, '300 thin · 400 regular · 600 semi-bold · 700 bold')}
    ${sliderRow('it-sl-lineHeight',   'it-sv-lineHeight',   'Line height',    '',  120, 200, 5,   '')}
    ${sliderRow('it-sl-letterSpacing','it-sv-letterSpacing','Letter spacing', 'px', -1, 4, 0.25, '')}

    ${divider()}
    ${sectionTitle('Corners & Borders')}
    ${sliderRow('it-sl-cardRadius',  'it-sv-cardRadius',  'Card radius',    'px', 0, 46, 2, '')}
    ${sliderRow('it-sl-inputRadius', 'it-sv-inputRadius', 'Input / button radius', 'px', 0, 46, 1, '')}
    ${sliderRow('it-sl-borderWidth', 'it-sv-borderWidth', 'Border width',   'px', 0, 4, 1, '')}
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:11px">
      <span style="font-size:13px;font-weight:600;color:#1a1825">Border style</span>
      <select id="it-sel-borderStyle" style="${SEL_STYLE};max-width:120px">
        <option value="solid">Solid</option>
        <option value="dashed">Dashed</option>
        <option value="dotted">Dotted</option>
        <option value="none">None</option>
      </select>
    </div>

    <!-- Extension point -->
    <div id="it-sp-extensions"></div>

  </div><!-- /body -->

  <!-- Footer -->
  <div style="padding:12px 18px;border-top:1px solid #e5e5e5;display:flex;gap:8px;flex-shrink:0">
    <button onclick="resetStylePanel()" style="flex:1;padding:9px;border-radius:9px;border:1.5px solid #e2e0ea;font-size:13px;font-weight:600;cursor:pointer;background:#f0eff5;color:#6b6880;transition:all .15s" onmouseover="this.style.background='#e2e0ea'" onmouseout="this.style.background='#f0eff5'">↺ Reset</button>
    <button onclick="closeStylePanel()" style="flex:1;padding:9px;border-radius:9px;border:1.5px solid #6d28d9;font-size:13px;font-weight:600;cursor:pointer;background:#7c3aed;color:#fff;transition:all .15s" onmouseover="this.style.background='#6d28d9'" onmouseout="this.style.background='#7c3aed'">Done</button>
  </div>

</div>`;
  }

  /* ── Inject panel into DOM ─────────────────────────────── */
  function injectPanel() {
    if (document.getElementById('it-style-panel')) return;
    const div = document.createElement('div');
    div.innerHTML = buildPanelHTML();
    while (div.firstChild) document.body.appendChild(div.firstChild);
    wireControls();
    syncControls(state);
  }

  /* ── Public API ────────────────────────────────────────── */
  window.openStylePanel = function() {
    injectPanel();
    syncControls(state);
    const overlay = document.getElementById('it-style-overlay');
    const panel   = document.getElementById('it-style-panel');
    overlay.style.display = 'block';
    requestAnimationFrame(() => {
      overlay.style.opacity = '1';
      panel.style.transform = 'translateX(0)';
    });
  };

  window.closeStylePanel = function() {
    const overlay = document.getElementById('it-style-overlay');
    const panel   = document.getElementById('it-style-panel');
    if (!overlay || !panel) return;
    overlay.style.opacity = '0';
    panel.style.transform = 'translateX(105%)';
    setTimeout(() => { overlay.style.display = 'none'; }, 300);
  };

  window.resetStylePanel = function() {
    state = { ...DEFAULTS };
    saveState(); applyState(state); syncControls(state);
  };

  window.InTimeTheme = {
    appendSection(html) {
      const ext = document.getElementById('it-sp-extensions');
      if (ext) ext.insertAdjacentHTML('beforeend', html);
    },
    onApply(fn) { _applyHooks.push(fn); },
    _removeWallpaper() {
      state.wallpaper = '';
      const wp = document.getElementById('it-wall-preview');
      const wi = document.getElementById('it-wall-input');
      const wr = document.getElementById('it-wall-remove');
      const wo = document.getElementById('it-wall-op-row');
      if (wp) { wp.src=''; wp.style.display='none'; }
      if (wi) wi.value = '';
      if (wr) wr.style.display = 'none';
      if (wo) wo.style.display = 'none';
      applyState(state); saveState();
    },
    getState() { return { ...state }; },
  };

  /* ── Boot ──────────────────────────────────────────────── */
  loadState();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectPanel);
  } else {
    injectPanel();
  }

})();
