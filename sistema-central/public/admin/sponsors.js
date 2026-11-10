// Patrocinio: logos of the «Juntos lo hacemos posible» carousel, one tab per site.
// «Mezclar» shows both lists on both sites; off, each site shows only its own tab.
(() => {
  const SITE_NAMES = { 'pagina-web-1': 'Iluminando Caminos', 'pagina-web-2': 'Hablemos de Marketing' };
  let data = { max: 30, shared: true, sites: { 'pagina-web-1': [], 'pagina-web-2': [] } };
  let site = 'pagina-web-1';
  const $ = (id) => document.getElementById(id);
  const current = () => data.sites[site] || [];

  function say(message) {
    $('sponsors-message').textContent = message || '';
    if (message) showToast(message);
  }

  async function request(url, options = {}) {
    const res = await fetch(url, options);
    const body = await res.json().catch(() => ({ ok: false, message: 'Respuesta inesperada del servidor.' }));
    if (body.sites) data = { max: body.max, shared: body.shared, sites: body.sites };
    return body;
  }

  function renderMode() {
    $('sponsors-shared').checked = data.shared;
    $('sponsors-mode-hint').textContent = data.shared
      ? 'Las dos páginas muestran los logos de ambas pestañas mezclados.'
      : 'Cada página muestra solo los logos de su pestaña.';
    for (const tab of document.querySelectorAll('.sponsors-tabs [role="tab"]')) {
      const selected = tab.dataset.site === site;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      tab.querySelector('.sponsors-tab-count').textContent = (data.sites[tab.dataset.site] || []).length;
    }
    $('sponsors-site-panel').setAttribute('aria-labelledby', `sponsors-tab-${site}`);
    $('sponsors-upload-title').textContent = `Logos de ${SITE_NAMES[site]}`;
  }

  function render() {
    renderMode();
    const list = current();
    $('sponsors-count').textContent = `${list.length} de ${data.max}`;
    $('sponsors-empty').hidden = list.length > 0;
    const full = list.length >= data.max;
    $('sponsors-file').disabled = full;
    document.querySelector('.sponsors-pick').classList.toggle('is-disabled', full);
    $('sponsors-list').innerHTML = list.map((s, i) => `
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
            <button type="button" class="od-cancel" data-move="1" ${i === list.length - 1 ? 'disabled' : ''} aria-label="Mover después">→</button>
            <button type="button" class="od-reject" data-delete>Eliminar</button>
          </div>
        </form>
      </li>`).join('');
  }

  window.loadSponsors = async function loadSponsors() {
    try {
      const body = await request('/api/admin/sponsors');
      if (!body.ok) throw new Error(body.message);
      render();
    } catch (err) {
      say(`No se pudo cargar el patrocinio. ${err.message || ''}`);
    }
  };

  const tabs = [...document.querySelectorAll('.sponsors-tabs [role="tab"]')];
  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      site = tab.dataset.site;
      say('');
      render();
    });
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      const next = tabs[(tabs.indexOf(tab) + 1) % tabs.length];
      next.click();
      next.focus();
    });
  }

  $('sponsors-shared').addEventListener('change', async (event) => {
    const input = event.target;
    input.disabled = true;
    try {
      const body = await request('/api/admin/sponsors/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shared: input.checked })
      });
      say(body.message);
    } catch (_) {
      say('No se pudo guardar el cambio. Revisa tu conexión e inténtalo de nuevo.');
    } finally {
      input.disabled = false;
      render();
    }
  });

  $('sponsors-file').addEventListener('change', async (event) => {
    const input = event.target;
    const files = [...input.files];
    input.value = '';
    if (!files.length) return;
    const room = data.max - current().length;
    if (files.length > room) return say(room > 0 ? `Solo caben ${room} imagen(es) más en esta página: el límite es ${data.max}.` : `Esta página ya tiene ${data.max} imágenes. Elimina alguna para subir otra.`);
    const tooBig = files.filter(f => f.size > 5 * 1024 * 1024).map(f => f.name);
    if (tooBig.length) return say(`Cada imagen puede pesar hasta 5 MB: ${tooBig.join(', ')}.`);
    const body = new FormData();
    files.forEach(f => body.append('images', f));
    say(files.length === 1 ? 'Subiendo 1 imagen…' : `Subiendo ${files.length} imágenes…`);
    try {
      const result = await request(`/api/admin/sponsors?site=${encodeURIComponent(site)}`, { method: 'POST', body });
      say(result.message);
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
      const body = await request(`/api/admin/sponsors/${form.dataset.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.elements.name.value, link_url: form.elements.link_url.value })
      });
      if (!body.ok) {
        warning.textContent = body.message;
        warning.hidden = false;
        form.elements[body.field || 'link_url']?.focus();
        return;
      }
      // Show the link as it was saved (for example with https:// added)
      const saved = current().find(s => String(s.id) === form.dataset.id);
      if (saved) form.elements.link_url.value = saved.link_url;
      say(body.message);
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
        if (!confirm(`¿Eliminar este logo de ${SITE_NAMES[site]}?`)) return;
        const body = await request(`/api/admin/sponsors/${id}`, { method: 'DELETE' });
        say(body.message);
      } else {
        const ids = current().map(s => s.id);
        const from = ids.indexOf(id);
        const to = from + Number(button.dataset.move);
        if (to < 0 || to >= ids.length) return;
        [ids[from], ids[to]] = [ids[to], ids[from]];
        const body = await request('/api/admin/sponsors/order', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ site, ids })
        });
        if (!body.ok) say(body.message);
      }
      render();
    } catch (_) {
      say('No se pudo completar la acción. Revisa tu conexión e inténtalo de nuevo.');
    }
  });
})();
