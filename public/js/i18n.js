// Lightweight i18n helper for WanderPal
(() => {
  const SUPPORTED = ['en','fr','es','zh','hi','ar','pt','ru','bn','id','ja','ko','pl','de','vi','th','km','nl','it','tr','el'];

  function mapBrowserLang(code){
    const short = (code || '').toLowerCase().split('-')[0];
    return SUPPORTED.includes(short) ? short : 'en';
  }

  async function fetchJson(lang){
    try {
      const res = await fetch(`/i18n/${lang}.json`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      console.error(`[i18n] Failed to load /i18n/${lang}.json →`, e.message || e);
      return null;
    }
  }

  async function loadWithFallback(lang){
    const primary = await fetchJson(lang);
    if (primary) return { dict: primary, lang };
    if (lang !== 'en') {
      const en = await fetchJson('en');
      if (en) return { dict: en, lang: 'en' };
    }
    return { dict: {}, lang: 'en' };
  }

  function apply(dict, opts = {}){
    // Text content
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      if (key in dict) el.textContent = dict[key];
    });
    // Placeholders
    document.querySelectorAll('[data-ph]').forEach(el => {
      const key = el.getAttribute('data-ph');
      if (key in dict) el.placeholder = dict[key];
    });
    // Direction + <html lang>
    document.documentElement.lang = opts.lang || 'en';
    document.documentElement.dir  = (opts.lang === 'ar') ? 'rtl' : 'ltr';

    // Optional: title keys combined "A — B"
    if (opts.titleKeys && opts.titleKeys.length) {
      const parts = opts.titleKeys.map(k => dict[k] || k);
      document.title = parts.join(' — ');
    }
  }

  const I18N = {
    state: { dict: {}, lang: 'en' },

    async set(lang, applyOpts = {}){
      const { dict, lang: finalLang } = await loadWithFallback(lang);
      this.state.dict = dict;
      this.state.lang = finalLang;
      localStorage.setItem('lang', finalLang);
      apply(dict, { lang: finalLang, ...applyOpts });
    },

    async initSelect(selectEl, applyOpts = {}){
      if (!selectEl) {
        console.error('[i18n] Missing language <select id="lang">');
        return;
      }
      // initial language
      const saved = localStorage.getItem('lang');
      const initial = saved || mapBrowserLang(navigator.language);
      // set the dropdown (if option exists)
      if ([...selectEl.options].some(o => o.value === initial)) {
        selectEl.value = initial;
      }
      await this.set(initial, applyOpts);

      // change handler
      selectEl.addEventListener('change', async e => {
        await this.set(e.target.value, applyOpts);
      });
    }
  };

  // expose globally
  window.I18N = I18N;

  // Helpful runtime diagnostics
  window.addEventListener('DOMContentLoaded', () => {
    // Warn if running from file:// (fetch will fail)
    if (location.protocol === 'file:') {
      console.warn('[i18n] You are opening the page via file:// — fetch(/i18n/*.json) will be blocked. Serve via http://localhost instead.');
    }
  });
})();
