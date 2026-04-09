// public/modules/Let's Get Out!/manage/letsgetout-create1.js
// Logic for "Create a new Guiding (1/2)"

(function () {
  const nextBtn = document.getElementById('btn-next');
  const titleInput = document.getElementById('guiding-title');
  const typeRadios = document.querySelectorAll('input[name="guiding-type"]');
  const freeUseCheckbox = document.getElementById('free-use');
  const priceInput = document.getElementById('price-amount');
  const allowTeasersCheckbox = document.getElementById('allow-teasers');
  const tippingCheckbox = document.getElementById('tipping-enabled');
  const offlineCheckbox = document.getElementById('offline-allowed');
  const languagesInput = document.getElementById('languages');
  const descriptionInput = document.getElementById('guiding-description');
  const tagsInput = document.getElementById('guiding-tags');
  const recoInput = document.getElementById('guiding-recommendations');
  const radiusSelect = document.getElementById('standard-radius');

  if (!nextBtn) {
    console.warn('[LGO create1] btn-next not found, aborting');
    return;
  }

  function getSelectedType() {
    for (const r of typeRadios) {
      if (r.checked) return r.value;
    }
    return null;
  }

  function parseLanguages(value) {
    if (!value) return [];
    return value
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  }

  async function createGuiding() {
    const title = (titleInput?.value || '').trim();
    const type = getSelectedType();

    if (!title) {
      alert('Please give your guiding a title.');
      titleInput?.focus();
      return;
    }
    if (!type) {
      alert('Please select a type (Online / Live / IRL).');
      return;
    }

    const freeUse = !!freeUseCheckbox?.checked;
    const monetizationModel = freeUse ? 'ads' : 'fee';

    let priceCents = 0;
    if (!freeUse && priceInput && priceInput.value) {
      const num = Number(priceInput.value.replace(',', '.'));
      if (!Number.isNaN(num) && num >= 0) {
        priceCents = Math.round(num * 100);
      }
    }

    const payload = {
      title,
      type,
      free_use: freeUse,
      monetization_model: monetizationModel,
      price_cents: priceCents,
      allow_teasers: !!allowTeasersCheckbox?.checked,
      tipping_enabled: !!tippingCheckbox?.checked,
      offline_allowed: !!offlineCheckbox?.checked,
      languages: parseLanguages(languagesInput?.value),
      description: descriptionInput?.value || '',
      tags: tagsInput?.value || '',
      recommendations: recoInput?.value || '',
      standard_radius_m: radiusSelect ? Number(radiusSelect.value) : 50
    };

    nextBtn.disabled = true;
    nextBtn.textContent = 'Saving…';

    try {
      const res = await fetch('/api/letsgetout/guidings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include', // send JWT cookie
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg = data.error || `Server error (${res.status})`;
        alert('Could not create guiding: ' + msg);
        return;
      }

      const guiding = await res.json();
      if (!guiding || !guiding.id) {
        alert('Unexpected response from server (no id).');
        return;
      }

      // remember current guiding id for page2
      try {
        sessionStorage.setItem('lgo_current_guiding_id', String(guiding.id));
      } catch (e) {
        console.warn('[LGO create1] sessionStorage failed:', e);
      }

      // redirect to page 2 (adjust path if your real path differs)
      const target = `/pages/letsgetout/page2.html?id=${encodeURIComponent(
        guiding.id
      )}`;
      window.location.href = target;
    } catch (err) {
      console.error('[LGO create1] error', err);
      alert('Network or server error while creating guiding.');
    } finally {
      nextBtn.disabled = false;
      nextBtn.textContent = 'Next (2/2)';
    }
  }

  nextBtn.addEventListener('click', (ev) => {
    ev.preventDefault();
    createGuiding();
  });
})();
