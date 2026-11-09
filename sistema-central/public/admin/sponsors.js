// Patrocinadores: logos of the «Juntos lo hacemos posible» carousel shown on both sites.
(() => {
  let sponsors = [];
  let max = 30;
  const $ = (id) => document.getElementById(id);

  function say(message) {
    $('sponsors-message').textContent = message || '';
    if (message) showToast(message);
  }

  async function request(url, options = {}) {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({ ok: false, message: 'Respuesta inesperada del servidor.' }));
    if (data.sponsors) sponsors = data.sponsors;
    return data;
  }

  function render() {
    $('sponsors-count').textContent = `${sponsors.length} de ${max}`;
    $('sponsors-empty').hidden = sponsors.length > 0;
    const full = sponsors.length >= max;
    $('sponsors-file').disabled = full;
    document.querySelector('.sponsors-pick').classList.toggle('is-disabled', full);
    $('sponsors-list').innerHTML = sponsors.map((s, i) => `
      <li class="sponsor-card" data-id="${s.id}">
        <div class="sponsor-thumb"><img src="${escapeHtml(s.image_url)}" alt="" loading="lazy" /></div>
        <form class="sponsor-fields account-form" data-id="${s.id}">
          <label>Nombre <small>opcional, se lee en lectores de pantalla</small>
            <input name="name" maxlength="120" value="${escapeHtml(s.name)}" placeholder="Nombre del patrocinador" />
          </label>
          <label>Enlace <small>opcional: web, Instagram, TikTok, WhatsApp o contacto</small>
            <input name="link_url" maxlength="500" inputmode="url" autocapitalize="none" spellcheck="false" value="${escapeHtml(s.link_url)}" placeholder="https://instagram.com/marca o wa.me/584121234567" />
          </label>
          <p class="od-warning" role="alert" hidden></p>
          <div class="sponsor-actions">
            <button type="submit" class="od-approve">Guardar</button>
            <button type="button" class="od-cancel" data-move="-1" ${i === 0 ? 'disabled' : ''} aria-label="Mover antes">←</button>
            <button type="button" class="od-cancel" data-move="1" ${i === sponsors.length - 1 ? 'disabled' : ''} aria-label="Mover después">→</button>
            <button type="button" class="od-reject" data-delete>Eliminar</button>
          </div>
        </form>
      </li>`).join('');
  }

  window.loadSponsors = async function loadSponsors() {
    try {
      const data = await request('/api/admin/sponsors');
      if (!data.ok) throw new Error(data.message);
      max = data.max || max;
      render();
    } catch (err) {
      say(`No se pudieron cargar los patrocinadores. ${err.message || ''}`);
    }
  };

  $('sponsors-file').addEventListener('change', async (event) => {
    const input = event.target;
    const files = [...input.files];
    input.value = '';
    if (!files.length) return;
    const room = max - sponsors.length;
    if (files.length > room) return say(room > 0 ? `Solo caben ${room} imagen(es) más: el límite es ${max}.` : `Ya hay ${max} imágenes. Elimina alguna para subir otra.`);
    const tooBig = files.filter(f => f.size > 5 * 1024 * 1024).map(f => f.name);
    if (tooBig.length) return say(`Cada imagen puede pesar hasta 5 MB: ${tooBig.join(', ')}.`);
    const body = new FormData();
    files.forEach(f => body.append('images', f));
    say(files.length === 1 ? 'Subiendo 1 imagen…' : `Subiendo ${files.length} imágenes…`);
    try {
      const data = await request('/api/admin/sponsors', { method: 'POST', body });
      say(data.message);
      render();
    } catch (_) {
      say('No se pudieron subir las imágenes. Revisa tu conexión e inténtalo de nuevo.');
    }
  });

  $('sponsors-list').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const warning = form.querySelector('.od-warning');
    warning.hidden = true;
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const data = await request(`/api/admin/sponsors/${form.dataset.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.elements.name.value, link_url: form.elements.link_url.value })
      });
      if (!data.ok) {
        warning.textContent = data.message;
        warning.hidden = false;
        form.elements[data.field || 'link_url']?.focus();
        return;
      }
      // Show the link as it was saved (for example with https:// added)
      const saved = sponsors.find(s => String(s.id) === form.dataset.id);
      if (saved) form.elements.link_url.value = saved.link_url;
      say(data.message);
    } catch (_) {
      warning.textContent = 'No se pudo guardar. Revisa tu conexión e inténtalo de nuevo.';
      warning.hidden = false;
    } finally {
      button.disabled = false;
    }
  });

  $('sponsors-list').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-move], button[data-delete]');
    if (!button) return;
    const id = Number(button.closest('.sponsor-card').dataset.id);
    try {
      if (button.hasAttribute('data-delete')) {
        if (!confirm('¿Eliminar este logo del carrusel de las dos webs?')) return;
        const data = await request(`/api/admin/sponsors/${id}`, { method: 'DELETE' });
        say(data.message);
      } else {
        const ids = sponsors.map(s => s.id);
        const from = ids.indexOf(id);
        const to = from + Number(button.dataset.move);
        if (to < 0 || to >= ids.length) return;
        [ids[from], ids[to]] = [ids[to], ids[from]];
        const data = await request('/api/admin/sponsors/order', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids })
        });
        if (!data.ok) say(data.message);
      }
      render();
    } catch (_) {
      say('No se pudo completar la acción. Revisa tu conexión e inténtalo de nuevo.');
    }
  });
})();
