// Drawer open/close for Visitor Map
(function(){
  const openBtn = document.getElementById('homeBtn');
  const drawer = document.getElementById('homeDrawer');
  const closeBtn = document.getElementById('closeDrawer');
  const backdrop = document.getElementById('drawerBackdrop');

  if (!openBtn || !drawer || !backdrop) return;

  const open = () => {
    drawer.classList.add('open');
    backdrop.classList.add('show');
    drawer.setAttribute('aria-hidden','false');
  };
  const close = () => {
    drawer.classList.remove('open');
    backdrop.classList.remove('show');
    drawer.setAttribute('aria-hidden','true');
  };

  openBtn.addEventListener('click', open);
  closeBtn && closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  window.addEventListener('keydown', (e)=>{ if(e.key==='Escape') close(); });
})();
