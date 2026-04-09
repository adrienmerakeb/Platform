// Dashboard Cards UX
// - Keeps -off / -hover / -on naming for icons
// - Shows links on hover, keeps visible when selected
// - Deselects when clicking outside or pressing Escape

(() => {
  if (window.__CardsUXMounted) return;
  window.__CardsUXMounted = true;

  const CARD_SEL = '.card';

  // Filename helpers
  const toHover = (src) => (src || '').replace(/-off(\.[a-z0-9]+)$/i, '-hover$1');
  const toOn    = (src) => (src || '').replace(/-off(\.[a-z0-9]+)$/i, '-on$1');
  const toOff   = (src) => (src || '')
    .replace(/-hover(\.[a-z0-9]+)$/i, '-off$1')
    .replace(/-on(\.[a-z0-9]+)$/i, '-off$1');

  const preload = (src) => { if (src) { const i = new Image(); i.src = src; } };

  function restoreToOff(logo){
    if (!logo) return;
    const base = logo.dataset.baseOff || toOff(logo.getAttribute('src') || '');
    // avoid full URL mismatch by normalizing
    if (base && !logo.src.endsWith(base)) logo.src = base;
  }

  function deselect(card){
    if (!card) return;
    card.classList.remove('selected');
    restoreToOff(card.querySelector('.logo'));
  }

  function deselectAll(){
    document.querySelectorAll(`${CARD_SEL}.selected`).forEach(deselect);
  }

  function initCard(card){
    const logo = card.querySelector('.logo');

    if (logo){
      // Cache exact base -off once
      const normalizedOff = toOff(logo.getAttribute('src') || '');
      logo.dataset.baseOff = normalizedOff || logo.getAttribute('src') || '';
      if (normalizedOff && normalizedOff !== logo.getAttribute('src')) logo.src = normalizedOff;

      // Preload variants
      preload(toHover(logo.dataset.baseOff));
      preload(toOn(logo.dataset.baseOff));
    }

    // Hover (skip if selected)
    card.addEventListener('mouseenter', () => {
      if (!logo) return;
      if (!card.classList.contains('selected')){
        logo.src = toHover(logo.dataset.baseOff || logo.getAttribute('src') || '');
      }
    });
    card.addEventListener('mouseleave', () => {
      if (!logo) return;
      if (!card.classList.contains('selected')) restoreToOff(logo);
    });

    // Click card background => select (clicking a link navigates normally)
    card.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      e.preventDefault();

      deselectAll();
      card.classList.add('selected');

      if (logo){
        const off = logo.dataset.baseOff || toOff(logo.getAttribute('src') || '');
        logo.src = toOn(off);
      }
    });
  }

  function mount(){
    // Initialize existing cards
    document.querySelectorAll(CARD_SEL).forEach(initCard);

    // Click-away (capture) to deselect & normalize icons
    window.addEventListener('pointerdown', (ev) => {
      if (ev.target.closest(CARD_SEL)) return;
      deselectAll();
      document.querySelectorAll(CARD_SEL).forEach(c => {
        if (!c.classList.contains('selected')) restoreToOff(c.querySelector('.logo'));
      });
    }, true);

    // Escape key clears selection
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') deselectAll();
    });

    // Minimal sanity log
    if (window.console) console.debug('[CardsUX] mounted');
  }

  (document.readyState === 'loading')
    ? document.addEventListener('DOMContentLoaded', mount, { once:true })
    : mount();
})();
