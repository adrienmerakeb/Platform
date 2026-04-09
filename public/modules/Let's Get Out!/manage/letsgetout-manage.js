// /js/letsgetout-manage.js
document.getElementById('btn-new').addEventListener('click', () => {
  location.href = '/pages/letsgetout/page1.html';
});

async function loadGuidings() {
  const res = await fetch('/api/letsgetout/guidings', { credentials: 'include' });
  if (!res.ok) return;
  const guidings = await res.json();
  const list = document.getElementById('guidings-list');
  list.innerHTML = '';

  guidings.forEach(g => {
    const card = document.createElement('article');
    card.className = 'card guiding-card';

    const status = `${g.status}${g.is_active ? ' / active' : ' / inactive'}`;

    card.innerHTML = `
      <h3>${g.title || 'Untitled guiding'}</h3>
      <p>Status: ${status}</p>
      <p>Published: ${g.published_at || '—'}</p>
      <p>Rating: ${g.rating_avg?.toFixed ? g.rating_avg.toFixed(1) : '—'}
         (${g.rating_count || 0} reviews)</p>
      <p>Monetized: ${g.free_use ? 'Free' : 'Paid'} ·
         Earned: ${(g.total_earned_cents || 0)/100} + tips ${(g.total_tips_cents || 0)/100}</p>
      <div class="actions">
        <button data-id="${g.id}" class="btn-edit">Modify</button>
        <button data-id="${g.id}" class="btn-delete danger">Delete</button>
      </div>
    `;
    list.appendChild(card);
  });

  list.addEventListener('click', async (e) => {
    if (e.target.classList.contains('btn-edit')) {
      const id = e.target.dataset.id;
      location.href = `/pages/letsgetout/page2.html?id=${id}`;
    }
    if (e.target.classList.contains('btn-delete')) {
      const id = e.target.dataset.id;
      if (!confirm('Delete this guiding?')) return;
      const res = await fetch(`/api/letsgetout/guidings/${id}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      if (res.ok) loadGuidings();
    }
  }, { once: true });
}

loadGuidings();
