// «Hoja de control en Google Sheets» card (Evento y contenido). Only the superadmin changes it; admins
// see it read-only and can still open the sheet.
(() => {
  const $ = (id) => document.getElementById(id);
  const form = $('sheet-form');
  if (!form) return;
  let filled = false;

  function say(message, isError = false) {
    const status = $('sheet-status');
    status.textContent = message || '';
    status.classList.toggle('is-error', isError);
  }

  function lastSync(settings) {
    const line = settings.sheets_last_status || '';
    const [when, ...rest] = line.split(' · ');
    const date = new Date(when);
    if (!line || Number.isNaN(date.getTime())) return '';
    const stamp = date.toLocaleString('es-VE', { dateStyle: 'medium', timeStyle: 'short' });
    return `Último envío (${stamp}): ${rest.join(' · ')}`;
  }

  function fill(settings) {
    $('sheet-url').value = settings.sheets_sheet_url || '';
    $('sheet-webapp').value = settings.sheets_webapp_url || '';
    $('sheet-key').value = '';
    $('sheet-key').placeholder = settings.sheets_secret_set ? 'Clave guardada · escribe otra para cambiarla' : 'Pega la clave que muestra la hoja';
    const open = $('sheet-open');
    open.href = settings.sheets_sheet_url || '#';
    open.hidden = !settings.sheets_sheet_url;
    const connected = settings.sheets_webapp_url && settings.sheets_secret_set;
    say(connected ? (lastSync(settings) || 'Conexión configurada. Usa «Probar conexión» para comprobarla.') : 'Aún no está conectada: pega la URL de la aplicación web y la clave.');
    // Read-only for admins, like the rest of this section
    const canEdit = Boolean(adminSession?.canEditSettings);
    form.querySelectorAll('input, button').forEach(el => { el.disabled = !canEdit; });
    form.classList.toggle('is-read-only', !canEdit);
  }

  // The panel loads its data asynchronously: fill the card once settings and permissions are known
  const waitForSettings = setInterval(() => {
    if (typeof state === 'undefined' || !state?.settings || typeof adminSession === 'undefined' || !adminSession) return;
    clearInterval(waitForSettings);
    filled = true;
    fill(state.settings);
  }, 300);

  async function call(url, options, busyText) {
    const buttons = form.querySelectorAll('button');
    buttons.forEach(b => { b.disabled = true; });
    say(busyText);
    try {
      const res = await fetch(url, options);
      const data = await res.json().catch(() => ({ ok: false, message: 'Respuesta inesperada del servidor.' }));
      if (data.settings) {
        state.settings = data.settings;
        fill(data.settings);
      }
      say(data.message || (data.ok ? 'Listo.' : 'No se pudo completar.'), !data.ok);
      if (data.field && form.elements[data.field]) form.elements[data.field].focus();
      return data;
    } catch (_) {
      say('No se pudo conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.', true);
      return { ok: false };
    } finally {
      buttons.forEach(b => { b.disabled = false; });
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = {
      sheets_sheet_url: form.elements.sheets_sheet_url.value.trim(),
      sheets_webapp_url: form.elements.sheets_webapp_url.value.trim(),
      sheets_secret: form.elements.sheets_secret.value.trim()
    };
    const data = await call('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, 'Guardando…');
    if (data.ok) say('Configuración de la hoja guardada. Usa «Probar conexión» para comprobarla.');
  });
  $('sheet-test').addEventListener('click', () => call('/api/admin/sheets/test', { method: 'POST' }, 'Probando la conexión con la hoja…'));
  $('sheet-sync').addEventListener('click', () => {
    if (!confirm('¿Enviar todos los pagos registrados a la hoja? Las filas que ya existen se actualizan; las notas y la validación del equipo no se tocan.')) return;
    call('/api/admin/sheets/sync-all', { method: 'POST' }, 'Enviando los pagos a la hoja…');
  });
  window.__sheetCardFilled = () => filled;
})();
