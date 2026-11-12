// An expired session answers 401 on any admin request: go back to the sign-in page and return here after.
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const res = await nativeFetch(input, init);
  if (res.status === 401 && String(input).startsWith('/api/admin')) {
    location.href = `/admin/login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
  }
  return res;
};

let state = {
  counts: {},
  publicConfig: {},
  settings: {},
  tickets: [],
  orders: [],
  emailLogs: [],
  campaigns: []
};

const salesSources = {
  'pagina-web-1': { name: 'Iluminando Caminos', domain: 'iluminandocaminos.com', theme: 'caminos', short: 'IC' },
  'pagina-web-2': { name: 'Hablemos de Marketing', domain: 'hablemosdemarketingmaturin.com', theme: 'marketing', short: 'HDM' }
};
function sourceBadge(source) {
  const site = Object.hasOwn(salesSources, source) ? salesSources[source] : null;
  return site ? `<span class="source-badge ${site.theme}"><i></i>${site.name}</span><small class="source-domain">${site.domain}</small>`
    : '<span class="source-badge unknown">Origen no identificado</span>';
}
function filterBySource(source) {
  document.getElementById('filter-order-source').value = source;
  document.getElementById('filter-order-status').value = 'ALL';
  document.getElementById('order-search').value = '';
  switchTab('orders');
  renderOrdersTable();
  document.getElementById('tab-panel-orders').scrollIntoView({behavior:'smooth', block:'start'});
}
function connectionStatus(message, offline = false) {
  const el = document.getElementById('connection-status');
  el.textContent = message;
  el.classList.toggle('offline', offline);
}

let cmsPopulated = false;
let qrScannerInstance = null;
let qrCameraRunning = false;

const socket = io({
  query: { source: 'admin-dashboard' }
});

// After a dropped connection (sleep, network change), reload so payments that arrived meanwhile still ring
let socketConnectedBefore = false;
socket.on('connect', () => {
  connectionStatus('En vivo');
  if (socketConnectedBefore) fetchAdminOverview();
  socketConnectedBefore = true;
});
// Safety net while the live connection is down, and when coming back to the tab
setInterval(() => { if (!socket.connected) fetchAdminOverview(); }, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) fetchAdminOverview(); });
socket.on('disconnect', () => connectionStatus('Sin conexión en vivo', true));
socket.on('connect_error', () => connectionStatus('Reconectando…', true));

socket.on('tickets:updated', () => {
  fetchAdminOverview();
});

socket.on('config:updated', () => {
  fetchAdminOverview();
});

socket.on('admin:order_created', () => {
  fetchAdminOverview();
});

socket.on('admin:order_updated', () => {
  fetchAdminOverview();
});

socket.on('admin:tickets_reset', () => {
  document.getElementById('qr-token-input').value = '';
  document.getElementById('qr-verification-result').textContent = 'Escanea una entrada o escribe su código para verificarla.';
});

async function fetchAdminOverview() {
  try {
    const res = await fetch('/api/admin/overview');
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error('No se pudo cargar el panel');

    state = data;
    renderHeaderAndKpis();
    renderOrdersTable();
    renderSeatsMap();
    renderEmailLogs();
    renderNotifications();
    renderMailAlert();

    if (!cmsPopulated) {
      populateCmsAndSmtpForms();
      cmsPopulated = true;
    }
  } catch (err) {
    connectionStatus('No se pudo actualizar', true);
    console.error('Error loading admin overview:', err);
  }
}

function renderHeaderAndKpis() {
  const c = state.counts || {};
  const cfg = state.publicConfig || {};

  document.getElementById('header-bcv-rate').textContent = `Bs. ${Number(cfg.bcv_rate || 0).toFixed(8)}`;
  const bcvStatus = cfg.bcv_mode === 'manual' ? 'Tasa manual configurada por administracion' : `${cfg.bcv_source_label || 'Sin fuente'} | Estado: ${cfg.bcv_fetch_status || 'sin confirmar'} | Fecha valor: ${cfg.bcv_value_date || '--'}`;
  document.getElementById('admin-bcv-source').textContent = `${bcvStatus} | Ultima consulta: ${cfg.bcv_last_updated || '--'}${cfg.bcv_last_error ? ' | Error: ' + cfg.bcv_last_error : ''}`;
  for (const number of [1, 2]) {
    const sales = state.salesBySource?.[`pagina-web-${number}`] || {};
    document.getElementById(`sales-web-${number}`).innerHTML = `<div><strong>${Number(sales.sold || 0)}</strong><span>entradas vendidas</span></div><div><strong>${Number(sales.pending || 0)}</strong><span>pagos pendientes</span></div><div class="source-revenue"><strong>$${Number(sales.revenue_usd || 0).toFixed(2)}</strong><span>Bs. ${Number(sales.revenue_ves || 0).toFixed(2)}</span></div>`;
  }
  const unknown = state.salesBySource?.unknown;
  const unknownEl = document.getElementById('sales-unknown');
  unknownEl.classList.toggle('hidden', !unknown || !(unknown.sold + unknown.pending + unknown.rejected));
  unknownEl.textContent = `Origen no identificado: ${unknown?.sold || 0} vendidas, ${unknown?.pending || 0} pendientes.`;
  document.getElementById('header-ticket-price').innerHTML = `$${Number(cfg.ticket_price_usd || 5).toFixed(2)} (<span id="header-price-ves">Bs. ${Number(cfg.ticket_price_ves || 0).toFixed(2)}</span>)`;

  document.getElementById('kpi-available').textContent = c.available ?? 250;
  document.getElementById('kpi-locked').textContent = c.locked ?? 0;
  document.getElementById('kpi-pending').textContent = c.pending ?? 0;
  document.getElementById('kpi-sold').textContent = c.sold ?? 0;
  document.getElementById('kpi-sold-breakdown').textContent = `IC: ${c.sold_web_1 || 0} · HDM: ${c.sold_web_2 || 0}`;
  document.getElementById('kpi-revenue-usd').textContent = `$${Number(c.revenue_usd || 0).toFixed(2)} USD`;
  document.getElementById('kpi-revenue-ves').textContent = `Bs. ${Number(c.revenue_ves || 0).toFixed(2)}`;
  document.getElementById('badge-pending-orders').textContent = c.pending ?? 0;
  const salesState = document.getElementById('sales-state');
  salesState.textContent = cfg.sales_enabled === false ? 'Ventas en preparación' : 'Venta de entradas abierta';
  salesState.classList.toggle('is-open', cfg.sales_enabled !== false);
}

function renderOrdersTable() {
  const filter = document.getElementById('filter-order-status')?.value || 'ALL';
  const tbody = document.getElementById('orders-tbody');
  if (!tbody) return;

  const sourceFilter = document.getElementById('filter-order-source')?.value || 'ALL';
  const query = (document.getElementById('order-search')?.value || '').trim().toLocaleLowerCase('es');
  const filtered = (state.orders || []).filter(o => (filter === 'ALL' || o.status === filter) && (sourceFilter === 'ALL' || (sourceFilter === 'unknown' ? !['pagina-web-1', 'pagina-web-2'].includes(o.source_web) : o.source_web === sourceFilter)) && (!query || [o.ticket_number, o.buyer_name, o.buyer_email, o.payment_reference].some(value => String(value || '').toLocaleLowerCase('es').includes(query))));
  document.getElementById('orders-result-count').textContent = `${filtered.length} ${filtered.length === 1 ? 'operación' : 'operaciones'} · ${sourceFilter === 'ALL' ? 'Todas las páginas' : salesSources[sourceFilter]?.name || 'Origen no identificado'}`;

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" class="py-8 text-center text-slate-400">
          <strong class="empty-title">No hay operaciones para mostrar</strong><span class="empty-description">Las solicitudes de las dos webs aparecerán aquí. Si aplicaste filtros, prueba con otro estado o página.</span>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered.map(o => {
    const statusBadge = o.status === 'PENDING'
      ? '<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-amber-100 text-amber-800">Por verificar</span>'
      : o.status === 'APPROVED'
      ? '<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800">Aprobado</span>'
      : `<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-red-100 text-red-800">${o.status === 'CANCELLED' ? 'Anulado' : 'Rechazado'}</span>`;

    const originBadge = sourceBadge(o.source_web);

    const actionsHtml = o.status === 'PENDING'
      ? `
        <div class="flex flex-col sm:flex-row gap-1.5 justify-end">
          <button onclick="openOrderDetail(${o.id})" class="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold shadow-sm">
            Revisar pago
          </button>
        </div>
      `
      : o.status === 'APPROVED'
      ? `
        <div class="flex flex-col gap-1 items-end">
          <a href="${o.pdf_path || '#'}" target="_blank" class="px-2.5 py-1 bg-slate-900 hover:bg-slate-800 text-white rounded text-xs font-semibold">
            Abrir entrada PDF
          </a>
          <button onclick="testTokenInScanner('${o.verification_token}')" class="text-[11px] text-indigo-600 hover:underline font-medium">
            Comprobar QR
          </button>
        </div>
      `
      : `<button onclick="openOrderDetail(${o.id})" class="text-xs text-slate-500 hover:underline">Ver detalle</button>`;

    return `
      <tr data-source="${escapeHtml(o.source_web)}" class="hover:bg-slate-50 transition">
        <td data-label="Entrada y página" class="py-3 px-3">
          <div class="text-base font-extrabold text-slate-900">${o.ticket_number ? `#${o.ticket_number}` : '<span class="report-tag">Reporte · por asignar</span>'}</div>
          <div class="mt-0.5">${originBadge}</div>
          <div class="text-[10px] text-slate-400 mt-0.5">${escapeHtml(formatDateTime(o.created_at))}</div>
        </td>
        <td data-label="Comprador" class="py-3 px-3">
          <div class="font-bold text-slate-900">${escapeHtml(o.buyer_name)}</div>
          <div class="text-xs text-slate-600 font-mono">C.I: ${escapeHtml(o.buyer_cedula)}</div>
        </td>
        <td data-label="Contacto" class="py-3 px-3">
          <div class="text-xs font-medium text-slate-800">${escapeHtml(o.buyer_email)}</div>
          <div class="text-xs text-slate-500">Tel: ${escapeHtml(o.buyer_phone)}</div>
        </td>
        <td data-label="Pago reportado" class="py-3 px-3">
          <div class="text-xs font-bold text-slate-900">Ref: <span class="font-mono bg-slate-100 px-1.5 py-0.5 rounded">${escapeHtml(o.payment_reference)}</span></div>
          <div class="text-xs text-slate-600 mt-0.5">Banco: <strong>${escapeHtml(o.payment_bank || 'No indicado')}</strong></div>
        </td>
        <td data-label="Importe" class="py-3 px-3">
          <div class="font-bold text-slate-900">$${Number(o.amount_usd).toFixed(2)} USD</div>
          <div class="text-xs font-semibold text-emerald-700">Bs. ${Number(o.amount_ves).toFixed(2)}</div>
          <div class="text-[10px] text-slate-400">BCV: ${Number(o.bcv_rate).toFixed(2)}</div>
        </td>
        <td data-label="Comprobante" class="py-3 px-3">
          ${o.screenshot_path ? `<button onclick="viewScreenshot(${o.id})" class="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg text-xs font-semibold border border-slate-300">
            Ver comprobante
          </button>` : '<span class="text-xs text-slate-400">Sin captura</span>'}
        </td>
        <td data-label="Estado" class="py-3 px-3">
          <div>${statusBadge}</div>
          ${o.verification_token ? `<div class="text-[10px] font-mono text-slate-600 mt-1 break-all">${o.verification_token}</div>` : ''}
        </td>
        <td data-label="Acciones" class="py-3 px-3 text-right">
          ${actionsHtml}
        </td>
      </tr>
    `;
  }).join('');
}

function renderSeatsMap() {
  const container = document.getElementById('admin-seats-grid');
  if (!container) return;

  container.innerHTML = (state.tickets || []).map(t => {
    let classes = 'bg-emerald-500 text-white hover:bg-emerald-600';
    let subtitle = 'Libre';

    if (t.status === 'LOCKED') {
      classes = 'bg-amber-500 text-slate-950 font-bold animate-pulse';
      subtitle = t.locked_until == null ? 'Manual' : `${t.remaining_seconds}s`;
    } else if (t.status === 'PENDING') {
      classes = 'bg-blue-600 text-white';
      subtitle = 'Verif.';
    } else if (t.status === 'SOLD') {
      classes = 'bg-slate-800 text-slate-200';
      subtitle = 'Vendida';
    }

    return `
      <button type="button"
        onclick="inspectSeat('${t.ticket_number}')"
        class="seat-pill cursor-pointer rounded-lg p-1.5 text-center select-none shadow-sm ${classes}"
        title="Entrada #${t.ticket_number} (${t.status})" aria-label="Entrada ${t.ticket_number}: ${subtitle}"
      >
        <div class="text-xs font-extrabold leading-none">${t.ticket_number}</div>
        <div class="text-[9px] leading-tight mt-0.5 opacity-90">${subtitle}</div>
      </button>
    `;
  }).join('');
}

function inspectSeat(ticketNumber) {
  if (adminSession?.canArbitrateTickets) return openTicketArbitration(ticketNumber);
  const ticket = (state.tickets || []).find(t => t.ticket_number === ticketNumber);
  const order = (state.orders || []).find(o => o.id === ticket?.current_order_id);
  if (!ticket) return;

  let html = `
    <div class="space-y-3">
      <div class="p-3 rounded-lg bg-slate-100 flex justify-between items-center">
        <div>
          <span class="text-xs text-slate-500 uppercase font-bold">Número de entrada</span>
          <div class="text-2xl font-extrabold text-slate-900">#${ticket.ticket_number}</div>
        </div>
        <span class="px-3 py-1 rounded-full text-xs font-bold bg-slate-900 text-white">${ticket.status}</span>
      </div>
  `;

  if (ticket.status === 'LOCKED') {
    html += `
      <div class="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs space-y-1">
        ${ticket.locked_until == null ? '<strong>Bloqueo manual</strong>' : `<div><strong>Bloqueo temporal activo:</strong> Restan <strong>${ticket.remaining_seconds} segundos</strong></div><div><strong>Página de origen:</strong> ${sourceBadge(ticket.locked_by_source)}</div>`}
      </div>
    `;
  }

  if (order) {
    html += `
      <div class="p-4 rounded-lg border border-slate-200 space-y-1.5 text-xs">
        <div class="font-bold text-sm text-slate-900 mb-1">Datos del comprador asociado</div>
        <div><strong>Nombre y apellido:</strong> ${escapeHtml(order.buyer_name)}</div>
        <div><strong>Cédula:</strong> ${escapeHtml(order.buyer_cedula)}</div>
        <div><strong>Correo:</strong> ${escapeHtml(order.buyer_email)}</div>
        <div><strong>Teléfono de contacto:</strong> ${escapeHtml(order.buyer_phone)}</div>
        <div><strong>Banco de origen:</strong> ${escapeHtml(order.payment_bank || 'No indicado')}</div>
        <div><strong>Referencia bancaria:</strong> ${escapeHtml(order.payment_reference)}</div>
        <div><strong>Origen:</strong> ${sourceBadge(order.source_web)}</div>
        ${order.verification_token ? `<div><strong>Token QR:</strong> <code>${order.verification_token}</code></div>` : ''}
      </div>
    `;
  }

  html += `</div>`;
  openModal(`Detalle de la entrada #${ticketNumber}`, html);
}

const arbitrationActions = {
  hold: ['Bloquear entrada', 'La entrada quedará fuera de venta hasta que la liberes.'],
  release: ['Liberar entrada', 'La entrada volverá a estar disponible para la venta.'],
  assist: ['Registrar compra asistida', 'Registra un pago recibido. La entrada quedará pendiente de verificación.'],
  edit: ['Editar datos', 'Guarda las correcciones en esta orden. Para una entrada emitida, el panel ofrecerá un PDF actualizado con el mismo QR.'],
  approve: ['Aprobar y enviar entrada', 'Confirma que verificaste el pago. Se emitirá el PDF y se enviará al correo del comprador.'],
  cancel: ['Anular orden', 'Se conservará la orden en el historial. La entrada volverá a la venta y cualquier QR emitido quedará invalidado.']
};

async function openTicketArbitration(number) {
  openModal(`Entrada #${number}`, '<div id="ticket-arbitration" class="order-detail" aria-live="polite">Cargando el estado de la entrada…</div>');
  const panel = document.getElementById('ticket-arbitration');
  const endpoint = `/api/admin/tickets/${number}/arbitration`;
  try {
    const response = await fetch(endpoint);
    const details = await response.json();
    if (!panel.isConnected) return;
    if (!response.ok) { panel.textContent = details.message; return; }
    const { order, status, manualHold } = details;
    const labels = { AVAILABLE: 'Disponible', LOCKED: manualHold ? 'Bloqueo manual' : 'Reserva temporal', PENDING: 'En verificación', SOLD: 'Vendida' };
    const actions = {
      AVAILABLE: ['assist', 'hold'], LOCKED: manualHold ? ['assist', 'release'] : ['release'],
      PENDING: ['approve', 'edit', 'cancel'], SOLD: ['edit', 'cancel']
    }[status] || [];
    const attended = order && (order.checked_in_at || order.checked_in_conference || order.checked_in_concert);
    const field = (label, value) => `<div class="od-field"><span>${label}</span><strong>${escapeHtml(value || '—')}</strong></div>`;
    panel.innerHTML = `
      <div class="od-head"><div><h4>${labels[status]}</h4>${(order || details.source) ? sourceBadge(order?.source_web || details.source) : ''}</div></div>
      ${details.lockedUntil ? `<p class="od-muted">Reserva vigente hasta ${escapeHtml(new Intl.DateTimeFormat('es-VE', { timeStyle: 'medium', timeZone: 'America/Caracas' }).format(details.lockedUntil))}, hora de Venezuela. Liberarla cancela la reserva del comprador.</p>` : ''}
      ${order ? `<div class="od-grid">${field('Comprador', order.buyer_name)}${field('Cédula', order.buyer_cedula)}
        ${field('Correo', order.buyer_email)}${field('Teléfono', order.buyer_phone)}${field('Banco', order.payment_bank)}${field('Referencia', order.payment_reference)}
        ${field('Monto reportado', `Bs. ${Number(order.amount_ves).toFixed(2)}`)}</div>
        <div class="od-actions">
          ${order.screenshot_path ? `<a class="od-cancel" href="${escapeHtml(order.screenshot_path)}" target="_blank" rel="noopener">Ver comprobante</a>` : ''}
          ${order.pdf_path ? `<a class="od-cancel" href="${escapeHtml(order.pdf_path)}" target="_blank" rel="noopener">Abrir PDF</a>` : ''}
          ${details.canResendCorrectedPdf ? '<button type="button" class="od-approve" data-resend-pdf>Reenviar PDF corregido</button>' : ''}
        </div>` : ''}
      ${details.canResendCorrectedPdf ? `<p class="od-muted" data-resend-status role="status">Destinatario: ${escapeHtml(order.buyer_email)}</p>` : ''}
      ${attended ? '<p class="od-muted">La asistencia ya está registrada.</p>' : ''}
      <div class="od-actions">${actions.filter(action => action !== 'cancel' || !attended).map(action => `<button type="button" class="${action === 'cancel' ? 'od-reject' : action === 'approve' || action === 'assist' ? 'od-approve' : 'od-cancel'}" data-ticket-action="${action}">${arbitrationActions[action][0]}</button>`).join('')}</div>
      <div data-arbitration-form></div>`;
    panel.querySelectorAll('[data-ticket-action]').forEach(button => button.addEventListener('click', () => {
      renderArbitrationForm(panel.querySelector('[data-arbitration-form]'), endpoint, number, details, button.dataset.ticketAction);
    }));
    const resend = panel.querySelector('[data-resend-pdf]');
    resend?.addEventListener('click', async () => {
      const status = panel.querySelector('[data-resend-status]');
      resend.disabled = true;
      status.textContent = `Enviando el PDF a ${order.buyer_email}…`;
      try {
        const response = await fetch(`${endpoint}/resend-pdf`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: details.revision })
        });
        const result = await response.json();
        status.textContent = result.message;
        if (response.ok) await fetchAdminOverview();
      } catch (_) {
        status.textContent = 'No se pudo confirmar el reenvío. Revisa el registro de correos.';
      } finally {
        resend.disabled = false;
      }
    });
  } catch (_) {
    panel.textContent = 'No se pudo cargar la entrada. Vuelve a abrirla desde el mapa.';
  }
}

function renderArbitrationForm(container, endpoint, number, { order, revision }, action) {
  const [label, description] = arbitrationActions[action];
  const [first, ...last] = (order?.buyer_name || '').trim().split(/\s+/);
  const defaults = { buyer_first_name: first, buyer_last_name: last.join(' ') };
  const input = (name, label, type = 'text') => `<label>${label}<input name="${name}" type="${type}" value="${escapeHtml(order?.[name] || defaults[name])}" required></label>`;
  container.innerHTML = `<form class="od-reject-form arbitration-form">
    <h5>${label}</h5><p class="od-muted">${description}</p>
    ${action === 'assist' || action === 'edit' ? `<div class="od-grid">
      ${input('buyer_first_name', 'Nombre')}${input('buyer_last_name', 'Apellido')}
      ${input('buyer_cedula', 'Cédula')}${input('buyer_phone', 'Teléfono', 'tel')}
      ${input('buyer_email', 'Correo electrónico', 'email')}${input('payment_bank', 'Banco de origen')}${input('payment_reference', 'Referencia bancaria')}
      ${action === 'edit' ? `<label>Teléfono utilizado para pagar<input name="payment_phone" type="tel" value="${escapeHtml(order?.payment_phone)}"></label>` : ''}
      ${action === 'assist' ? '<label>Página de origen<select name="source" required><option value="">Elige una página</option><option value="pagina-web-1">Iluminando Caminos</option><option value="pagina-web-2">Hablemos de Marketing</option></select></label>' : ''}
      <label>Comprobante ${action === 'edit' ? '(opcional)' : ''}<input name="screenshot" type="file" accept="image/png,image/jpeg,image/webp" ${action === 'assist' ? 'required' : ''}></label>
      ${order?.report_kind === 'REPORT' ? `<label>Comentario del reporte<textarea name="buyer_comment" rows="2" maxlength="500">${escapeHtml(order.buyer_comment)}</textarea></label>` : ''}
    </div>` : ''}
    <label>Motivo de la intervención<textarea name="reason" rows="2" minlength="3" maxlength="500" required></textarea></label>
    ${action === 'cancel' ? `<label>Escribe ANULAR ${number} para confirmar<input name="confirmation" required autocomplete="off"></label>` : ''}
    <p class="od-muted" role="status"></p>
    <div class="od-actions"><button type="submit" class="${action === 'cancel' ? 'od-reject' : 'od-approve'}">${label}</button><button type="button" class="od-cancel" data-dismiss>Volver</button></div>
  </form>`;
  const form = container.querySelector('form');
  form.querySelector('[data-dismiss]').addEventListener('click', () => container.replaceChildren());
  form.querySelector('input, textarea').focus();
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const body = new FormData(form);
    if (!body.get('screenshot')?.size) body.delete('screenshot');
    body.set('action', action);
    body.set('revision', revision);
    const buttons = [...form.querySelectorAll('button'), ...container.parentElement.querySelectorAll('[data-ticket-action]')];
    const status = form.querySelector('[role="status"]');
    buttons.forEach(button => { button.disabled = true; });
    status.textContent = 'Guardando…';
    try {
      const response = await fetch(endpoint, { method: 'POST', body });
      const data = await response.json();
      if (!response.ok) { status.textContent = data.message; return; }
      showToast(data.message);
      if (form.isConnected && !document.getElementById('admin-modal').classList.contains('hidden')) await openTicketArbitration(number);
      await fetchAdminOverview();
    } catch (_) {
      status.textContent = 'No se pudo confirmar la operación. Vuelve a abrir la entrada para revisar su estado.';
    } finally {
      buttons.forEach(button => { button.disabled = false; });
    }
  });
}

// ============================================================================
// ORDER REVIEW: buyer data, payment data and the approve / reject decision
// ============================================================================

// SQLite stores UTC as "YYYY-MM-DD HH:MM:SS"; show it in Venezuela time.
function parseDbDate(value) {
  return value ? new Date(String(value).replace(' ', 'T') + 'Z') : null;
}
function formatDateTime(value) {
  const date = parseDbDate(value);
  if (!date || Number.isNaN(date.getTime())) return value || '';
  return new Intl.DateTimeFormat('es-VE', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Caracas' }).format(date);
}
function timeAgo(value) {
  const date = parseDbDate(value);
  if (!date || Number.isNaN(date.getTime())) return '';
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
  if (minutes < 1) return 'ahora';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `hace ${hours} h` : formatDateTime(value);
}
const orderTitle = (o) => o.ticket_number ? `Entrada #${o.ticket_number}` : 'Reporte de pago';

function openOrderDetail(orderId) {
  const o = (state.orders || []).find(order => order.id === orderId);
  if (!o) return;
  closeNotifPanel();
  const isReport = !o.ticket_number;
  const duplicates = (state.orders || []).filter(other => other.id !== o.id && ['PENDING', 'APPROVED'].includes(other.status) && other.payment_reference === o.payment_reference);
  const field = (label, value, mono = false) => `<div class="od-field"><span>${label}</span><strong class="${mono ? 'mono' : ''}">${escapeHtml(value || '—')}</strong></div>`;
  const statusText = { PENDING: 'Por verificar', APPROVED: 'Aprobado', REJECTED: 'Rechazado', CANCELLED: 'Anulado' }[o.status] || o.status;

  let actions = '';
  if (o.status === 'PENDING') {
    actions = `
      <div class="od-actions">
        ${isReport ? '<p class="od-muted">Al aprobar el pago, se asignará automáticamente la primera entrada libre.</p>' : ''}
        <button type="button" class="od-approve" id="od-approve-btn" onclick="approveOrder(${o.id})">Aprobar pago y enviar entrada</button>
        <button type="button" class="od-reject" onclick="document.getElementById('od-reject-form').hidden = false; document.getElementById('od-reject-reason').focus()">Rechazar</button>
      </div>
      <form id="od-reject-form" class="od-reject-form" hidden onsubmit="rejectOrder(event, ${o.id})">
        <label for="od-reject-reason">Motivo del rechazo · se envía al comprador</label>
        <textarea id="od-reject-reason" rows="3" required>La referencia no aparece en los movimientos de la cuenta.</textarea>
        <div class="od-reject-actions">
          <button type="submit" class="od-reject">Confirmar rechazo</button>
          <button type="button" class="od-cancel" onclick="document.getElementById('od-reject-form').hidden = true">Cancelar</button>
        </div>
      </form>`;
  } else if (o.status === 'APPROVED') {
    actions = `
      <div class="od-actions">
        <a class="od-approve" href="${escapeHtml(o.pdf_path || '#')}" target="_blank" rel="noopener">Abrir entrada PDF</a>
        <button type="button" class="od-cancel" onclick="closeModal(); testTokenInScanner('${escapeHtml(o.verification_token)}')">Comprobar QR</button>
      </div>`;
  } else {
    actions = `<p class="od-muted">${o.status === 'CANCELLED' ? 'Motivo de la anulación' : 'Motivo del rechazo'}: ${escapeHtml(o.admin_notes || '—')}</p>`;
  }

  openModal(isReport ? 'Reporte de pago' : `Pedido de la entrada #${o.ticket_number}`, `
    <div class="order-detail">
      <div class="od-head">
        <div>
          <span class="od-kind">${isReport ? 'Reporte de pago' : 'Compra con reserva'} · ${escapeHtml(formatDateTime(o.created_at))}</span>
          <h4>${isReport ? 'Entrada por asignar' : `Entrada #${o.ticket_number}`}</h4>
          ${sourceBadge(o.source_web)}
        </div>
        <span class="od-status ${o.status.toLowerCase()}">${statusText}</span>
      </div>
      ${duplicates.length ? `<p class="od-warning">La referencia ${escapeHtml(o.payment_reference)} también aparece en: ${duplicates.map(d => escapeHtml(orderTitle(d))).join(', ')}. Revisa que no sea el mismo pago reportado dos veces.</p>` : ''}
      <h5>Comprador</h5>
      <div class="od-grid">
        ${field('Nombre', o.buyer_first_name || o.buyer_name)}
        ${field('Apellido', o.buyer_last_name)}
        ${field('Cédula', o.buyer_cedula, true)}
        ${field('Teléfono', o.buyer_phone)}
        <div class="od-field od-wide"><span>Correo</span><strong>${escapeHtml(o.buyer_email)}</strong></div>
      </div>
      <h5>Pago reportado</h5>
      <div class="od-grid">
        ${field('Banco de origen', o.payment_bank || 'No indicado')}
        ${field('Referencia', o.payment_reference, true)}
        ${field('Monto esperado', `Bs. ${Number(o.amount_ves).toFixed(2)} · $${Number(o.amount_usd).toFixed(2)}`)}
        ${field('Tasa BCV', Number(o.bcv_rate).toFixed(4))}
        ${isReport ? field('Entrada solicitada', o.requested_ticket ? `#${o.requested_ticket}` : 'Sin preferencia') : ''}
        ${o.buyer_comment ? `<div class="od-field od-wide"><span>Comentario</span><strong>${escapeHtml(o.buyer_comment)}</strong></div>` : ''}
      </div>
      ${o.screenshot_path ? `<a class="od-proof" href="${escapeHtml(o.screenshot_path)}" target="_blank" rel="noopener"><img src="${escapeHtml(o.screenshot_path)}" alt="Comprobante de pago adjunto" />Abrir comprobante en tamaño original ↗</a>` : '<p class="od-muted">El comprador no adjuntó captura. Verifica la referencia en los movimientos de la cuenta.</p>'}
      ${actions}
    </div>
  `);
}

async function approveOrder(orderId) {
  const body = { admin_notes: 'Pago verificado en el panel de administración' };
  const button = document.getElementById('od-approve-btn');
  if (button) { button.disabled = true; button.textContent = 'Aprobando y enviando correos…'; }
  try {
    const res = await fetch(`/api/admin/orders/${orderId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!data.ok) {
      alert(data.message || 'Error al aprobar la orden');
      if (button) { button.disabled = false; button.textContent = 'Aprobar pago y enviar entrada'; }
      return;
    }
    await fetchAdminOverview();
    openModal(
      `Entrada #${data.order.ticket_number} aprobada`,
      `
        <div class="space-y-4 text-center">
          <div class="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl text-xs font-medium">
            ${escapeHtml(data.message)}
          </div>
          <div class="flex flex-col items-center justify-center">
            <img src="${data.qrDataUrl}" alt="QR Entrada" class="w-44 h-44 border p-2 rounded-xl shadow-sm" />
            <div class="font-mono text-xs font-bold mt-2 bg-slate-100 px-3 py-1 rounded">${escapeHtml(data.order.verification_token)}</div>
          </div>
          <div class="flex justify-center gap-3 pt-2">
            <a href="${data.pdfUrl}" target="_blank" class="px-4 py-2 bg-slate-900 text-white rounded-lg text-xs font-bold">
              Ver PDF de la entrada
            </a>
            <button onclick="closeModal(); testTokenInScanner('${data.order.verification_token}')" class="px-4 py-2 bg-emerald-600 text-white rounded-lg text-xs font-bold">
              Probar escaneo del QR
            </button>
          </div>
        </div>
      `
    );
  } catch (err) {
    alert('Error de red al aprobar el pago');
    if (button) { button.disabled = false; button.textContent = 'Aprobar pago y enviar entrada'; }
  }
}

async function rejectOrder(event, orderId) {
  event.preventDefault();
  const reason = document.getElementById('od-reject-reason').value.trim();
  if (!reason) return;
  try {
    const res = await fetch(`/api/admin/orders/${orderId}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason })
    });
    const data = await res.json();
    if (!data.ok) {
      alert(data.message);
      return;
    }
    closeModal();
    showToast(data.message);
    await fetchAdminOverview();
  } catch (err) {
    alert('Error al rechazar orden');
  }
}

function viewScreenshot(orderId) {
  const order = (state.orders || []).find(o => o.id === orderId);
  if (!order?.screenshot_path) return;
  openModal(
    `Comprobante · ${orderTitle(order)} (Ref: ${order.payment_reference})`,
    `
      <div class="space-y-3 text-center">
        <img src="${escapeHtml(order.screenshot_path)}" alt="Captura de pago" class="max-h-[65vh] mx-auto rounded-lg border border-slate-200 shadow" />
        <div>
          <a href="${escapeHtml(order.screenshot_path)}" target="_blank" class="text-xs text-blue-600 hover:underline font-semibold">Abrir imagen en tamaño original ↗</a>
        </div>
      </div>
    `
  );
}

function showPendingOrders() {
  closeNotifPanel();
  document.getElementById('filter-order-status').value = 'PENDING';
  document.getElementById('filter-order-source').value = 'ALL';
  document.getElementById('order-search').value = '';
  switchTab('orders');
  renderOrdersTable();
  document.getElementById('tab-panel-orders').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ============================================================================
// NOTIFICATION BELL, TOAST AND SOUNDS
// ============================================================================

const readStore = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch (_) { return fallback; } };
const writeStore = (key, value) => { try { localStorage.setItem(key, value); } catch (_) {} };
let lastSeenOrderId = Number(readStore('admin_seen_order_id', '0')) || 0;
let knownMaxOrderId = null; // set after the first load, so only later arrivals ring
const baseTitle = document.title;
let notifSoundOn = readStore('admin_notif_sound', 'on') !== 'off';

// Short tones made with Web Audio: a chime for new orders, and distinct "valid" / "invalid" tones for the scanner.
let audioCtx = null;
function playTone(kind) {
  const patterns = {
    order: [[660, 0, 0.12, 'sine'], [880, 0.14, 0.18, 'sine']],
    valid: [[880, 0, 0.1, 'sine'], [1320, 0.12, 0.22, 'sine']],
    invalid: [[220, 0, 0.22, 'square'], [165, 0.26, 0.34, 'square']]
  };
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    for (const [freq, start, duration, type] of patterns[kind]) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      const t0 = audioCtx.currentTime + start;
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(type === 'square' ? 0.16 : 0.32, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0);
      osc.stop(t0 + duration + 0.02);
    }
  } catch (_) {}
  if (kind !== 'order' && navigator.vibrate) navigator.vibrate(kind === 'valid' ? 120 : [220, 90, 220]);
}

// Browsers keep audio muted until the page is touched once: unlock it on the first interaction, so the
// chime of a later payment plays even if nobody is clicking at that moment.
function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (_) {}
}
for (const type of ['pointerdown', 'keydown', 'touchstart']) document.addEventListener(type, unlockAudio, { capture: true, passive: true });

// System notifications (outside the browser), shown through the panel's service worker when possible
let noticeWorker = null;
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/admin/avisos-sw.js', { scope: '/admin/' }).then(reg => { noticeWorker = reg; }).catch(() => {});
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'open-order' && event.data.id) openOrderDetail(event.data.id);
  });
}
const notificationsSupported = () => 'Notification' in window;

async function systemNotify(title, body, orderId = null) {
  if (!notificationsSupported() || Notification.permission !== 'granted') return false;
  const options = { body, tag: orderId ? `order-${orderId}` : 'aviso-prueba', renotify: true, icon: '/admin/brands/espressivo-venezuela.png', badge: '/admin/brands/espressivo-venezuela.png', data: { orderId } };
  try {
    const reg = noticeWorker || await navigator.serviceWorker?.getRegistration('/admin/');
    if (reg) {
      await reg.showNotification(title, options);
      return true;
    }
  } catch (_) {}
  try {
    const notice = new Notification(title, options);
    notice.onclick = () => { window.focus(); if (orderId) openOrderDetail(orderId); notice.close(); };
    return true;
  } catch (_) {
    return false;
  }
}

function renderNotifPermission() {
  const box = document.getElementById('notif-permission');
  if (!notificationsSupported()) { box.hidden = true; return; }
  box.hidden = false;
  const text = document.getElementById('notif-permission-text');
  const button = document.getElementById('notif-permission-btn');
  const permission = Notification.permission;
  box.dataset.state = permission;
  button.hidden = permission !== 'default';
  text.textContent = {
    granted: 'Avisos del navegador activados: te avisamos aunque estés en otra pestaña o programa.',
    default: 'Activa los avisos del navegador para enterarte de cada pago aunque estés en otra pestaña o programa.',
    denied: 'Los avisos están bloqueados en este navegador. Permítelos desde el candado de la barra de direcciones y recarga el panel.'
  }[permission] || '';
}

document.getElementById('notif-permission-btn').addEventListener('click', async (event) => {
  event.stopPropagation();
  unlockAudio();
  try { await Notification.requestPermission(); } catch (_) {}
  renderNotifPermission();
  if (Notification.permission === 'granted') systemNotify('Avisos activados', 'Así te avisaremos cuando llegue un pago por verificar.');
});
document.getElementById('notif-test').addEventListener('click', async (event) => {
  event.stopPropagation();
  unlockAudio();
  if (notifSoundOn) playTone('order');
  const shown = await systemNotify('Prueba de aviso', 'Así se ve el aviso de un pago nuevo por verificar.');
  showToast(shown ? 'Aviso de prueba enviado. Revisa la esquina de tu pantalla.' : 'Sonó el aviso en el panel. Activa los avisos del navegador para verlos fuera del panel.');
});
renderNotifPermission();

let toastTimer = null;
function showToast(message, onClick = null) {
  const toast = document.getElementById('admin-toast');
  toast.textContent = message;
  toast.hidden = false;
  toast.classList.toggle('is-clickable', Boolean(onClick));
  toast.onclick = onClick ? () => { toast.hidden = true; onClick(); } : null;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 7000);
}

function renderNotifications() {
  const pending = (state.orders || []).filter(o => o.status === 'PENDING').sort((a, b) => b.id - a.id);
  const unseen = pending.filter(o => o.id > lastSeenOrderId).length;
  const count = document.getElementById('notif-count');
  count.hidden = unseen === 0;
  count.textContent = unseen > 99 ? '99+' : String(unseen);
  document.getElementById('notif-bell').setAttribute('aria-label', `Pagos por verificar: ${pending.length}, ${unseen} nuevo${unseen === 1 ? '' : 's'}`);
  document.getElementById('notif-list').innerHTML = pending.length
    ? pending.slice(0, 12).map(o => `
      <button type="button" class="notif-item ${o.id > lastSeenOrderId ? 'is-new' : ''}" onclick="openOrderDetail(${o.id})">
        <i class="notif-dot ${salesSources[o.source_web]?.theme || ''}"></i>
        <span><strong>${escapeHtml(orderTitle(o))} · ${escapeHtml(o.buyer_name)}</strong>
        <small>${escapeHtml(o.payment_bank || 'Banco no indicado')} · Ref. ${escapeHtml(o.payment_reference)} · ${escapeHtml(timeAgo(o.created_at))}</small></span>
      </button>`).join('')
    : '<p class="notif-empty">No hay pagos por verificar.</p>';

  // Pending count in the browser tab, visible from other tabs
  document.title = (pending.length ? `(${pending.length}) ` : '') + baseTitle;

  const maxId = Math.max(0, ...(state.orders || []).map(o => o.id));
  if (knownMaxOrderId !== null && maxId > knownMaxOrderId) {
    const fresh = pending.filter(o => o.id > knownMaxOrderId);
    if (fresh.length) announceOrders(fresh);
  }
  knownMaxOrderId = maxId;
}

function announceOrders(orders) {
  const first = orders[0];
  const text = orders.length > 1 ? `${orders.length} pedidos nuevos de entradas` : `${orderTitle(first)} · ${first.buyer_name}`;
  showToast(`Nuevo pedido: ${text}. Toca para revisarlo.`, () => openOrderDetail(first.id));
  if (notifSoundOn) playTone('order');
  // Outside the browser whenever the panel is not in front: another tab, another program or minimized
  if (document.hidden || !document.hasFocus()) systemNotify('Nuevo pago por verificar', text, first.id);
}

function closeNotifPanel() {
  document.getElementById('notif-panel').hidden = true;
  document.getElementById('notif-bell').setAttribute('aria-expanded', 'false');
}

document.getElementById('notif-bell').addEventListener('click', (event) => {
  event.stopPropagation();
  const panel = document.getElementById('notif-panel');
  const opening = panel.hidden;
  panel.hidden = !opening;
  event.currentTarget.setAttribute('aria-expanded', String(opening));
  if (!opening) return;
  const pendingIds = (state.orders || []).filter(o => o.status === 'PENDING').map(o => o.id);
  if (pendingIds.length) {
    lastSeenOrderId = Math.max(lastSeenOrderId, ...pendingIds);
    writeStore('admin_seen_order_id', String(lastSeenOrderId));
  }
  renderNotifPermission();
  renderNotifications();
});
document.getElementById('notif-sound').addEventListener('click', (event) => {
  notifSoundOn = !notifSoundOn;
  writeStore('admin_notif_sound', notifSoundOn ? 'on' : 'off');
  event.currentTarget.setAttribute('aria-pressed', String(notifSoundOn));
  event.currentTarget.textContent = `Sonido: ${notifSoundOn ? 'activado' : 'desactivado'}`;
  if (notifSoundOn) playTone('order');
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('.notif')) closeNotifPanel();
});

// ============================================================================
// QR VERIFIER & CAMERA SCANNER
// ============================================================================

function testTokenInScanner(token) {
  switchTab('qr');
  document.getElementById('qr-token-input').value = token;
  verifyQrToken(token);
}

function verifyQrTokenManual() {
  const raw = document.getElementById('qr-token-input').value.trim();
  if (!raw) return;
  verifyQrToken(raw);
}

async function verifyQrToken(rawToken, { silent = false } = {}) {
  const box = document.getElementById('qr-verification-result');
  box.innerHTML = `<div class="py-8 text-slate-500">Verificando autenticidad criptográfica del QR...</div>`;

  try {
    const encoded = encodeURIComponent(rawToken);
    const res = await fetch(`/api/admin/verify-qr/${encoded}`);
    const data = await res.json();

    if (!silent) playTone(data.valid ? 'valid' : 'invalid');
    if (!data.valid) {
      box.className = 'p-6 rounded-xl border-2 border-red-500 bg-red-50 text-red-900 space-y-2';
      box.innerHTML = `
        <div class="text-lg font-extrabold text-red-700">${escapeHtml(data.message)}</div>
        <div class="text-xs text-red-600 font-mono">Token consultado: ${escapeHtml(rawToken)}</div>
      `;
      return;
    }

    const o = data.order;
    const attendanceRecorded = o.checked_in_at || o.checked_in_conference || o.checked_in_concert;
    box.className = 'p-6 rounded-xl border-2 border-emerald-500 bg-emerald-50/60 text-slate-900 space-y-4 text-left';
    box.innerHTML = `
      <div class="flex items-center justify-between border-b border-emerald-200 pb-3">
        <div>
          <span class="px-2.5 py-1 rounded-full text-xs font-extrabold bg-emerald-600 text-white">✓ QR VÁLIDO Y AUTÉNTICO</span>
          <h4 class="text-xl font-black text-slate-900 mt-2">ENTRADA #${o.ticket_number}</h4>
        </div>
        <div class="text-right text-xs text-slate-500">
          <div>Origen: <strong>${sourceBadge(o.source_web)}</strong></div>
          <div class="font-mono text-[11px] text-emerald-800">${o.verification_token}</div>
        </div>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-white p-4 rounded-xl border border-emerald-200 text-xs">
        <div>
          <span class="text-slate-400 uppercase font-bold block text-[10px]">Titular verificado</span>
          <strong class="text-sm text-slate-900">${escapeHtml(o.buyer_name)}</strong>
        </div>
        <div>
          <span class="text-slate-400 uppercase font-bold block text-[10px]">Cédula de identidad</span>
          <strong class="text-sm font-mono text-slate-900">${escapeHtml(o.buyer_cedula)}</strong>
        </div>
        <div>
          <span class="text-slate-400 uppercase font-bold block text-[10px]">Teléfono / Correo</span>
          <span class="text-slate-800">${escapeHtml(o.buyer_phone)}<br/>${escapeHtml(o.buyer_email)}</span>
        </div>
        <div>
          <span class="text-slate-400 uppercase font-bold block text-[10px]">Pago verificado</span>
          <span class="text-slate-800">Ref: <strong>${escapeHtml(o.payment_reference)}</strong><br/>Banco: ${escapeHtml(o.payment_bank || 'No indicado')}</span>
        </div>
      </div>

      <div class="p-3 rounded-xl border border-emerald-200 bg-white space-y-2">
        <div class="text-sm font-bold text-slate-900">Acceso a todo el evento</div>
        <p class="text-xs text-slate-600">La misma entrada incluye las conferencias y el concierto.</p>
        ${
          attendanceRecorded
            ? `<div class="text-xs text-emerald-800 font-semibold mt-1">✓ Asistencia registrada ${escapeHtml(o.checked_in_at || '')}</div>`
            : `<button type="button" data-token="${escapeHtml(o.verification_token)}" onclick="checkInAttendee(this)" class="mt-2 w-full py-1.5 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-bold">Registrar asistencia</button>`
        }
      </div>
    `;
  } catch (err) {
    if (!silent) playTone('invalid');
    box.innerHTML = `<div class="text-red-600">Error verificando el código QR.</div>`;
  }
}

async function checkInAttendee(button) {
  const token = button.dataset.token;
  button.disabled = true;
  try {
    const res = await fetch(`/api/admin/verify-qr/${encodeURIComponent(token)}/checkin`, {
      method: 'POST'
    });
    const data = await res.json();
    if (!data.ok) {
      playTone('invalid');
      alert(data.message);
    } else {
      playTone('valid');
    }
    await verifyQrToken(token, { silent: true });
    await fetchAdminOverview();
  } catch (err) {
    alert('No se pudo registrar la asistencia.');
  } finally {
    button.disabled = false;
  }
}

function toggleQrCamera() {
  const btn = document.getElementById('btn-toggle-camera');
  if (qrCameraRunning && qrScannerInstance) {
    qrScannerInstance.stop().then(() => {
      qrCameraRunning = false;
      btn.textContent = '📷 Iniciar escáner QR con la cámara';
    });
    return;
  }

  // The camera reports the same code many times per second: verify (and beep) once per code every few seconds.
  let lastScan = { text: '', at: 0 };
  qrScannerInstance = new Html5Qrcode('qr-reader');
  qrScannerInstance.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: { width: 220, height: 220 } },
    (decodedText) => {
      const now = Date.now();
      if (decodedText === lastScan.text && now - lastScan.at < 3000) return;
      lastScan = { text: decodedText, at: now };
      document.getElementById('qr-token-input').value = decodedText;
      verifyQrToken(decodedText);
    },
    () => {}
  ).then(() => {
    qrCameraRunning = true;
    btn.textContent = '⏹ Detener cámara';
  }).catch((err) => {
    alert('No se pudo acceder a la cámara en este navegador. Puedes escribir el token en el verificador de arriba.');
  });
}

// ============================================================================
// CMS & SMTP SETTINGS
// ============================================================================

function populateCmsAndSmtpForms() {
  const s = state.settings || {};
  document.getElementById('cms-event-title').value = s.event_title || '';
  document.getElementById('cms-event-subtitle').value = s.event_subtitle || '';
  document.getElementById('cms-event-date').value = s.event_date || '';
  document.getElementById('cms-event-entry-time').value = s.event_entry_time || '';
  document.getElementById('cms-conf-start').value = s.conference_start || '16:00';
  document.getElementById('cms-conf-end').value = s.conference_end || '19:00';
  document.getElementById('cms-concert-start').value = s.concert_start || '19:00';
  document.getElementById('cms-concert-end').value = s.concert_end || 'Por definir';
  document.getElementById('cms-event-location').value = s.event_location || '';
  document.getElementById('cms-price-usd').value = s.ticket_price_usd || '5.00';
  document.getElementById('cms-lock-seconds').value = s.lock_duration_seconds || '360';
  document.getElementById('cms-bcv-mode').value = s.bcv_mode || 'auto';
  document.getElementById('cms-bcv-manual').value = s.bcv_manual_rate || '45.50';

  try {
    document.getElementById('cms-payment-methods').value = JSON.stringify(JSON.parse(s.payment_methods_json || '{}'), null, 2);
  } catch (_) {
    document.getElementById('cms-payment-methods').value = s.payment_methods_json || '';
  }

  try {
    document.getElementById('cms-schedule-json').value = JSON.stringify(JSON.parse(s.event_schedule_json || '[]'), null, 2);
  } catch (_) {
    document.getElementById('cms-schedule-json').value = s.event_schedule_json || '';
  }

  document.getElementById('cms-conditions').value = s.event_conditions || '';
  document.getElementById('cms-terms').value = s.terms_and_conditions || '';

  if (document.getElementById('mail-settings-form').dataset.editing !== 'true') {
    populateMailForm(s);
  }
}

// Stored passwords never reach the browser: an empty field keeps the saved one.
function populateMailForm(s) {
  const mode = document.getElementById('mail-delivery-mode');
  mode.textContent = s.smtp_delivery_mode === 'smtp'
    ? 'Servidor SMTP configurado. Usa «Probar conexión» y confirma la recepción en tu buzón.'
    : s.smtp_delivery_mode === 'mailpit'
      ? 'Mailpit está en modo de pruebas. Los compradores no reciben estos correos.'
      : 'Configura un servidor SMTP para entregar correos a los compradores.';
  document.getElementById('smtp-host').value = s.smtp_host || '';
  document.getElementById('smtp-port').value = s.smtp_port || '465';
  document.getElementById('smtp-user').value = s.smtp_user || '';
  document.getElementById('smtp-from').value = s.smtp_from || '';
  document.getElementById('imap-host').value = s.imap_host || '';
  document.getElementById('imap-port').value = s.imap_port || '993';
  document.getElementById('imap-user').value = s.imap_user || '';
  document.getElementById('imap-sent-folder').value = s.imap_sent_folder || '';
  for (const [id, isSet, fallback] of [['smtp-pass', s.smtp_pass_set, '••••••••'], ['imap-pass', s.imap_pass_set, 'La misma de SMTP']]) {
    const input = document.getElementById(id);
    input.value = '';
    input.required = false;
    input.placeholder = isSet ? 'Guardada · escribe otra para cambiarla' : fallback;
  }
}

// Visible on every section while buyer emails are not leaving the system.
function renderMailAlert() {
  const box = document.getElementById('mail-alert');
  const mode = state.settings?.smtp_delivery_mode;
  const pending = Number(state.undeliveredEmails || 0);
  const waiting = pending ? ` ${pending} aviso${pending === 1 ? ' espera' : 's esperan'} envío.` : '';
  if (mode !== 'smtp') {
    box.innerHTML = `<div><strong>Los correos no están llegando a los compradores.</strong><span>${mode === 'mailpit' ? 'El servidor de correo guardado es Mailpit, un buzón de pruebas.' : 'No hay un servidor de correo configurado.'}${waiting}</span></div><button type="button" onclick="switchTab('smtp')">Configurar correo</button>`;
  } else if (pending) {
    box.innerHTML = `<div><strong>${pending} aviso${pending === 1 ? '' : 's'} sin entregar.</strong><span>El servidor de correo ya está configurado: reenvíalos para que lleguen a los compradores.</span></div><button type="button" onclick="retryPendingEmails(this)">Reenviar ahora</button>`;
  }
  box.hidden = mode === 'smtp' && !pending;
}

async function retryPendingEmails(button) {
  button.disabled = true;
  button.textContent = 'Reenviando…';
  try {
    const res = await fetch('/api/admin/mail/retry-pending', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await res.json();
    showToast(data.message);
  } catch (_) {
    showToast('No se pudieron reenviar los avisos. Revisa Correos y avisos.');
  }
  await fetchAdminOverview();
}

function fillHostingerSettings() {
  for (const [id, value] of [['smtp-host', 'smtp.hostinger.com'], ['smtp-port', '465'], ['imap-host', 'imap.hostinger.com'], ['imap-port', '993']]) {
    document.getElementById(id).value = value;
  }
  // The mailbox address is the user's own; only suggest one when the field is empty
  for (const [id, value] of [['smtp-user', 'soporte@merchan.cloud'], ['smtp-from', 'Sistema de envío Espressivo Venezuela <soporte@merchan.cloud>']]) {
    const input = document.getElementById(id);
    if (!input.value.trim()) input.value = value;
  }
  const password = document.getElementById('smtp-pass');
  password.value = '';
  password.required = true;
  password.placeholder = 'Contraseña del buzón de Hostinger';
  document.getElementById('mail-settings-form').dataset.editing = 'true';
  document.getElementById('mail-save-status').textContent = 'Ingresa la contraseña del buzón y guarda la configuración.';
  password.focus();
}

async function saveCmsSettings(e) {
  e.preventDefault();
  const payload = {
    event_title: document.getElementById('cms-event-title').value,
    event_subtitle: document.getElementById('cms-event-subtitle').value,
    event_date: document.getElementById('cms-event-date').value,
    event_entry_time: document.getElementById('cms-event-entry-time').value,
    conference_start: document.getElementById('cms-conf-start').value,
    conference_end: document.getElementById('cms-conf-end').value,
    concert_start: document.getElementById('cms-concert-start').value,
    concert_end: document.getElementById('cms-concert-end').value,
    event_location: document.getElementById('cms-event-location').value,
    ticket_price_usd: document.getElementById('cms-price-usd').value,
    lock_duration_seconds: document.getElementById('cms-lock-seconds').value,
    bcv_mode: document.getElementById('cms-bcv-mode').value,
    bcv_manual_rate: document.getElementById('cms-bcv-manual').value,
    payment_methods_json: document.getElementById('cms-payment-methods').value,
    event_schedule_json: document.getElementById('cms-schedule-json').value,
    event_conditions: document.getElementById('cms-conditions').value,
    terms_and_conditions: document.getElementById('cms-terms').value
  };

  const res = await fetch('/api/admin/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  alert(data.message || 'Guardado');
  await fetchAdminOverview();
}

async function saveSmtpSettings(e) {
  e.preventDefault();
  const value = (id) => document.getElementById(id).value.trim();
  const payload = {
    smtp_host: value('smtp-host'),
    smtp_port: value('smtp-port') || '465',
    smtp_user: value('smtp-user'),
    smtp_pass: document.getElementById('smtp-pass').value,
    smtp_from: value('smtp-from'),
    imap_host: value('imap-host'),
    imap_port: value('imap-port') || '993',
    imap_user: value('imap-user'),
    imap_pass: document.getElementById('imap-pass').value,
    imap_sent_folder: value('imap-sent-folder')
  };
  const status = document.getElementById('mail-save-status');
  status.textContent = 'Guardando…';
  try {
    const res = await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.message || 'No se pudo guardar');
    delete e.target.dataset.editing;
    populateMailForm(data.settings || {});
    state.settings = data.settings || {};
    renderEmailLogs();
    status.textContent = 'Configuración guardada. Usa «Probar conexión» para comprobarla.';
  } catch (err) {
    status.textContent = `No se pudo guardar: ${err.message}`;
  }
}

async function testMailSettings() {
  const button = document.getElementById('mail-test-btn');
  const list = document.getElementById('mail-test-result');
  button.disabled = true;
  list.innerHTML = '<li>Conectando con el servidor de correo…</li>';
  try {
    const res = await fetch('/api/admin/mail/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: document.getElementById('mail-test-to').value.trim() })
    });
    const data = await res.json();
    if (!data.smtp) throw new Error(data.message || 'No se pudo probar la configuración');
    const item = (check) => check ? `<li class="${check.ok === true ? 'is-ok' : check.ok === false ? 'is-error' : ''}">${escapeHtml(check.message)}</li>` : '';
    list.innerHTML = item(data.smtp) + item(data.imap) + item(data.sent);
  } catch (err) {
    list.innerHTML = `<li class="is-error">${escapeHtml(err.message)}</li>`;
  } finally {
    button.disabled = false;
  }
}

async function triggerCampaign(campaignKey) {
  const res = await fetch('/api/admin/notifications/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ campaign_key: campaignKey })
  });
  const data = await res.json();
  alert(data.message || 'Notificación enviada');
  await fetchAdminOverview();
}

async function forceRefreshBcv() {
  const res = await fetch('/api/admin/bcv/refresh', { method: 'POST' });
  const data = await res.json();
  await fetchAdminOverview();
  if (data.message) alert(data.message);
}

function renderEmailLogs() {
  const tbody = document.getElementById('email-logs-tbody');
  if (!tbody) return;

  const logs = state.emailLogs || [];
  const retryableIds = new Set(state.retryableEmailIds);
  const statusLabels = { SENT_SMTP: 'Aceptado por SMTP', SIMULATED_OUTBOX: 'Prueba · sin entrega', ERROR: 'Error de envío' };
  if (logs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="py-6 text-center text-slate-400">Aún no se han enviado correos.</td></tr>`;
    return;
  }

  tbody.innerHTML = logs.map(l => `
    <tr class="hover:bg-slate-50">
      <td class="py-2.5 px-3 text-slate-500">${l.created_at}</td>
      <td class="py-2.5 px-3"><span class="px-2 py-0.5 rounded bg-slate-100 font-mono text-[10px] font-bold">${l.type}</span></td>
      <td class="py-2.5 px-3 font-medium">${escapeHtml(l.recipient_name)} &lt;${escapeHtml(l.recipient_email)}&gt;</td>
      <td class="py-2.5 px-3">${escapeHtml(l.subject)}</td>
      <td class="py-2.5 px-3">
        ${l.attachment_path ? `<a href="${l.attachment_path}" target="_blank" class="text-blue-600 font-semibold hover:underline">📄 PDF Adjunto</a>` : '-'}
      </td>
      <td class="py-2.5 px-3">
        <span class="px-2 py-0.5 rounded text-[10px] font-bold ${l.status === 'SENT_SMTP' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-700'}">${escapeHtml(statusLabels[l.status] || l.status)}</span>
        ${l.error_message ? `<div class="text-[10px] text-red-700 mt-1">${escapeHtml(l.error_message)}</div>` : ''}
      </td>
      <td class="py-2.5 px-3 text-right">
        <button onclick="previewEmailLog(${idx})" class="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 rounded text-xs font-semibold">
          Ver correo
        </button>
        ${state.settings?.smtp_delivery_mode === 'smtp' && retryableIds.has(l.id) ? `<button onclick="retryMailLog(${l.id}, this)" class="px-2.5 py-1 rounded text-xs font-semibold">Reenviar</button>` : ''}
      </td>
    </tr>
  `).join('');
}

async function retryMailLog(id, button) {
  button.disabled = true;
  try {
    const res = await fetch(`/api/admin/mail/${id}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    const data = await res.json();
    alert(data.message);
    await fetchAdminOverview();
  } catch (err) {
    alert('No se pudo confirmar el reenvío. Revisa el registro de correos.');
  } finally {
    button.disabled = false;
  }
}

function previewEmailLog(index) {
  const log = (state.emailLogs || [])[index];
  if (!log) return;
  openModal(`Vista previa del correo: ${log.subject}`, `
    <div class="space-y-3">
      <div class="text-xs bg-slate-50 p-3 rounded border">
        <div><strong>Para:</strong> ${escapeHtml(log.recipient_name)} &lt;${escapeHtml(log.recipient_email)}&gt;</div>
        <div><strong>Tipo:</strong> ${log.type} | <strong>Fecha:</strong> ${log.created_at}</div>
        ${log.attachment_path ? `<div><strong>Archivo PDF Adjunto:</strong> <a href="${log.attachment_path}" target="_blank" class="text-blue-600 underline">${log.attachment_path}</a></div>` : ''}
      </div>
      <iframe class="email-preview" title="Contenido del correo" sandbox srcdoc="${escapeHtml(log.body_html || '')}"></iframe>
    </div>
  `);
}

const sectionTitles = {
  orders: 'Pagos y ventas',
  seats: 'Mapa de entradas',
  pdf: 'Diseño de entrada',
  qr: 'Control de acceso',
  cms: 'Evento y contenido',
  smtp: 'Correos y avisos',
  blog: 'Blog · Marketing',
  sponsors: 'Patrocinio',
  users: 'Usuarios'
};

let ticketPreviewRequest = 0;
async function updateTicketDemo() {
  const source = document.getElementById('ticket-demo-source').value;
  const url = `/api/admin/tickets/demo.pdf?source=${encodeURIComponent(source)}`;
  const preview = document.getElementById('ticket-demo-preview');
  const status = document.getElementById('ticket-demo-status');
  document.getElementById('ticket-demo-open').href = url;
  document.getElementById('ticket-demo-download').href = url;
  const request = ++ticketPreviewRequest;
  preview.querySelector('canvas')?.remove();
  preview.setAttribute('aria-busy', 'true');
  status.textContent = 'Cargando la vista previa…';
  let loadingTask;
  try {
    const pdfjs = await import('/admin/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/admin/pdfjs/pdf.worker.min.mjs';
    loadingTask = pdfjs.getDocument({ url, standardFontDataUrl: '/admin/pdfjs/fonts/' });
    const pdf = await loadingTask.promise;
    const page = await pdf.getPage(1);
    const pageSize = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: 1920 / Math.max(pageSize.width, pageSize.height) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Vista previa de la entrada de demostración');
    await page.render({ canvas, viewport }).promise;
    if (request === ticketPreviewRequest) {
      status.textContent = '';
      preview.append(canvas);
    }
  } catch {
    if (request === ticketPreviewRequest) {
      status.textContent = 'No se pudo mostrar la vista previa. Usa «Abrir PDF» o «Descargar».';
    }
  } finally {
    if (request === ticketPreviewRequest) preview.setAttribute('aria-busy', 'false');
    await loadingTask?.destroy();
  }
}

function switchTab(tabName) {
  if (!Object.hasOwn(sectionTitles, tabName)) return;
  document.getElementById('workspace-title').textContent = sectionTitles[tabName];
  document.getElementById('admin-section').value = tabName;
  document.querySelector('.dashboard-main').classList.toggle('focused-tab', tabName !== 'orders');
  Object.keys(sectionTitles).forEach(t => {
    document.getElementById(`tab-panel-${t}`).classList.toggle('hidden', t !== tabName);
    const button = document.getElementById(`tab-btn-${t}`);
    button.classList.toggle('active', t === tabName);
    if (t === tabName) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  if (tabName === 'blog') window.loadMarketingBlog();
  if (tabName === 'pdf') updateTicketDemo();
  if (tabName === 'users') loadUsers();
  if (tabName === 'sponsors') window.loadSponsors?.();
  if (tabName !== 'orders') window.scrollTo({top: 0});
}

let modalPreviousFocus;
function openModal(title, bodyHtml) {
  modalPreviousFocus = document.activeElement;
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHtml;
  const m = document.getElementById('admin-modal');
  m.classList.remove('hidden');
  m.classList.add('flex');
  document.body.style.overflow = 'hidden';
  m.querySelector('button').focus();
}

function closeModal() {
  const m = document.getElementById('admin-modal');
  m.classList.add('hidden');
  m.classList.remove('flex');
  document.body.style.overflow = '';
  modalPreviousFocus?.focus();
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Local 1s countdown refresh for locked seats UI
setInterval(() => {
  let anyLocked = false;
  for (const t of state.tickets || []) {
    if (t.status === 'LOCKED' && t.remaining_seconds > 0) {
      t.remaining_seconds = Math.max(0, t.remaining_seconds - 1);
      anyLocked = true;
    }
  }
  if (anyLocked) {
    renderSeatsMap();
  }
}, 1000);

// Check URL params if redirected from QR scan (/admin/?verifyToken=...)
window.addEventListener('DOMContentLoaded', async () => {
  switchTab(window.location.hash.slice(1));
  await fetchAdminOverview();
  const params = new URLSearchParams(window.location.search);
  const verifyToken = params.get('verifyToken');
  if (verifyToken) {
    testTokenInScanner(verifyToken);
  }
});

document.getElementById('mail-settings-form').addEventListener('input', (event) => {
  if (event.target.id !== 'mail-test-to') event.currentTarget.dataset.editing = 'true';
});

document.getElementById('admin-modal').addEventListener('click', event => {
  if (event.target.id === 'admin-modal') closeModal();
});
document.addEventListener('keydown', event => {
  const modal = document.getElementById('admin-modal');
  if (modal.classList.contains('hidden')) return;
  if (event.key === 'Escape') closeModal();
  if (event.key === 'Tab') {
    const items = [...modal.querySelectorAll('button, a[href], input, select, textarea, [tabindex="0"]')].filter(el => !el.disabled && el.getClientRects().length);
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});

// ============================================================================
// ACCOUNT: signed-in user, change of own password, sign-out
// ============================================================================

const roleNames = { superadmin: 'Superadministrador', admin: 'Administrador', initial: 'Cuenta inicial', service: 'Cuenta de scripts' };
let adminSession = null;
let panelUsers = new Map();

async function loadSession() {
  try {
    const res = await fetch('/api/admin/session');
    const data = await res.json();
    if (!data.ok) return;
    adminSession = data;
    document.getElementById('ticket-reset-panel').hidden = !data.canResetTickets;
    document.getElementById('account-user').textContent = data.user;
    document.getElementById('account-role').textContent = roleNames[data.role] || '';
    document.getElementById('account-btn').textContent = (data.user || 'A').charAt(0).toUpperCase();
    // The initial account can still change its user name as well; named users change their password
    document.getElementById('account-change').textContent = data.named ? 'Cambiar contraseña' : 'Cambiar usuario y contraseña';
    applySettingsPermission(Boolean(data.canEditSettings));
  } catch (_) {}
}

// Event data, Pago Móvil, schedule, conditions, mail account and mass notices: admins can only read them
function applySettingsPermission(canEdit) {
  const readOnlyAreas = [
    document.getElementById('form-cms-settings'),
    document.getElementById('mail-settings-form'),
    ...document.querySelectorAll('#tab-panel-smtp button[onclick^="triggerCampaign"]')
  ].filter(Boolean);
  for (const area of readOnlyAreas) {
    const controls = area.matches('button') ? [area] : area.querySelectorAll('input, select, textarea, button');
    for (const control of controls) control.disabled = !canEdit;
    area.classList.toggle('is-read-only', !canEdit);
  }
}

function closeAccountMenu() {
  document.getElementById('account-menu').hidden = true;
  document.getElementById('account-btn').setAttribute('aria-expanded', 'false');
}

function openTicketReset() {
  if (!adminSession?.canResetTickets) return;
  openModal('Reiniciar las 250 entradas', `
    <form class="account-form" onsubmit="submitTicketReset(event)">
      <p class="od-muted">Se borrarán las compras, las reservas, las asistencias y el historial de correos de ambas webs. Los QR emitidos perderán su validez. El servidor guardará una copia de seguridad antes de aplicar el cambio.</p>
      <label for="ticket-reset-confirmation">Escribe REINICIAR ENTRADAS para confirmar
        <input id="ticket-reset-confirmation" name="confirmation" type="text" pattern="REINICIAR ENTRADAS" autocomplete="off" spellcheck="false" required />
      </label>
      <p id="ticket-reset-status" role="status" class="text-sm text-red-700"></p>
      <div class="flex justify-end gap-2">
        <button type="button" onclick="closeModal()" class="border border-slate-300 rounded-lg px-4 py-2 text-sm">Cancelar</button>
        <button type="submit" class="bg-red-600 hover:bg-red-700 text-white font-bold px-4 py-2 rounded-lg text-sm">Confirmar reinicio</button>
      </div>
    </form>
  `);
}

async function submitTicketReset(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  const status = form.querySelector('#ticket-reset-status');
  button.disabled = true;
  status.textContent = 'Guardando el respaldo y reiniciando las entradas…';
  try {
    const res = await fetch('/api/admin/tickets/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: form.elements.confirmation.value })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.message || 'No se pudo reiniciar las entradas.');
    closeModal();
    showToast(data.message);
    await fetchAdminOverview();
  } catch (err) {
    status.textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

function openAccountForm() {
  closeAccountMenu();
  const named = Boolean(adminSession?.named);
  openModal(named ? 'Cambiar contraseña' : 'Cambiar usuario y contraseña', `
    <form id="account-form" class="account-form" onsubmit="saveAccount(event)">
      <p class="od-muted">El panel es el mismo para Iluminando Caminos y Hablemos de Marketing. Al guardar se cierran tus demás sesiones abiertas.</p>
      <label for="account-current">Contraseña actual
        <input id="account-current" name="current_password" type="password" autocomplete="current-password" required />
      </label>
      ${named ? '' : `<label for="account-new-user">Nuevo usuario o correo
        <input id="account-new-user" name="new_user" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required value="${escapeHtml(document.getElementById('account-user').textContent)}" />
      </label>`}
      <label for="account-new-password">Nueva contraseña <small>mínimo 8 caracteres</small>
        <input id="account-new-password" name="new_password" type="password" autocomplete="new-password" minlength="8" required />
      </label>
      <label for="account-confirm">Repite la nueva contraseña
        <input id="account-confirm" type="password" autocomplete="new-password" minlength="8" required />
      </label>
      <p id="account-error" class="od-warning" role="alert" hidden></p>
      <div class="od-actions">
        <button type="submit" class="od-approve" id="account-save">Guardar</button>
        <button type="button" class="od-cancel" onclick="closeModal()">Cancelar</button>
      </div>
    </form>
  `);
  document.getElementById('account-current').focus();
}

async function saveAccount(event) {
  event.preventDefault();
  const form = event.target;
  const error = document.getElementById('account-error');
  const show = (message, field) => {
    error.textContent = message;
    error.hidden = false;
    if (field && form.elements[field]) form.elements[field].focus();
  };
  if (form.elements.new_password.value !== document.getElementById('account-confirm').value) return show('Las contraseñas nuevas no coinciden.', 'new_password');
  const button = document.getElementById('account-save');
  button.disabled = true;
  try {
    const res = await fetch('/api/admin/account', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        current_password: form.elements.current_password.value,
        new_user: form.elements.new_user?.value,
        new_password: form.elements.new_password.value
      })
    });
    const data = await res.json();
    if (!data.ok) return show(data.message, data.field);
    closeModal();
    showToast(data.message);
    await loadSession();
  } catch (_) {
    show('No se pudo guardar. Revisa tu conexión e inténtalo de nuevo.');
  } finally {
    button.disabled = false;
  }
}

// ============================================================================
// USERS: one superadmin (cannot be deleted) and admins, all with full access
// ============================================================================

function formatAccess(value) {
  if (!value) return 'Nunca ha iniciado sesión';
  const date = new Date(`${value.replace(' ', 'T')}Z`);
  return `Último acceso: ${date.toLocaleString('es-VE', { dateStyle: 'medium', timeStyle: 'short' })}`;
}

async function loadUsers() {
  const list = document.getElementById('users-list');
  try {
    const res = await fetch('/api/admin/users');
    const data = await res.json();
    if (!data.ok) throw new Error(data.message);
    // Only the superadmin creates, resets or deletes users; admins see the list
    const named = Boolean(data.me?.id) && data.me.role === 'superadmin';
    panelUsers = new Map(data.users.map(user => [user.id, user]));
    document.getElementById('user-create-form').hidden = !named;
    document.getElementById('users-initial-note').hidden = Boolean(data.me?.id) || data.users.length > 0;
    if (!data.users.length) {
      list.innerHTML = '<li class="users-empty">Todavía no hay usuarios.</li>';
      return;
    }
    list.innerHTML = data.users.map(user => {
      const isMe = user.id === data.me?.id;
      const canManage = named && user.role !== 'superadmin' && !isMe;
      return `
        <li class="users-row">
          <div class="users-who">
            <strong>${escapeHtml(user.email)}</strong>
            <span class="users-role ${user.role}">${roleNames[user.role]}</span>${isMe ? '<span class="users-you">Tú</span>' : ''}
            <small>${formatAccess(user.last_login_at)}${user.created_by ? ` · Creado por ${escapeHtml(user.created_by)}` : ''}</small>
          </div>
          <div class="users-actions">
            ${canManage ? `<button type="button" class="od-cancel" onclick="openUserPasswordForm(${Number(user.id)})">Nueva contraseña</button>
            <button type="button" class="od-reject" onclick="removeAdminUser(${Number(user.id)})">Eliminar</button>` : ''}
          </div>
        </li>`;
    }).join('');
  } catch (err) {
    list.innerHTML = `<li class="users-empty">No se pudieron cargar los usuarios. ${escapeHtml(err.message || '')}</li>`;
  }
}

function showUsersMessage(message) {
  const el = document.getElementById('users-message');
  el.textContent = message;
  showToast(message);
}

async function createAdminUser(event) {
  event.preventDefault();
  const form = event.target;
  const error = document.getElementById('user-create-error');
  const show = (message, field) => {
    error.textContent = message;
    error.hidden = false;
    if (field && form.elements[field]) form.elements[field].focus();
  };
  error.hidden = true;
  const email = form.elements.email.value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return show('Escribe un correo válido.', 'email');
  if (form.elements.password.value.length < 8) return show('La contraseña debe tener al menos 8 caracteres.', 'password');
  if (form.elements.password.value !== form.elements.confirm.value) return show('Las contraseñas no coinciden.', 'confirm');
  const button = document.getElementById('user-create-save');
  button.disabled = true;
  try {
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: form.elements.password.value })
    });
    const data = await res.json();
    if (!data.ok) return show(data.message, data.field);
    form.reset();
    showUsersMessage(data.message);
    await loadUsers();
  } catch (_) {
    show('No se pudo crear el usuario. Revisa tu conexión e inténtalo de nuevo.');
  } finally {
    button.disabled = false;
  }
}

function openUserPasswordForm(id) {
  const email = panelUsers.get(id)?.email || '';
  openModal('Nueva contraseña', `
    <form class="account-form" onsubmit="saveUserPassword(event, ${Number(id)})">
      <p class="od-muted">Para <strong>${escapeHtml(email)}</strong>. Sus sesiones abiertas se cerrarán.</p>
      <label for="user-password-new">Nueva contraseña <small>mínimo 8 caracteres</small>
        <input id="user-password-new" name="password" type="password" autocomplete="new-password" minlength="8" required />
      </label>
      <label for="user-password-confirm">Repite la contraseña
        <input id="user-password-confirm" name="confirm" type="password" autocomplete="new-password" minlength="8" required />
      </label>
      <p id="user-password-error" class="od-warning" role="alert" hidden></p>
      <div class="od-actions">
        <button type="submit" class="od-approve" id="user-password-save">Guardar</button>
        <button type="button" class="od-cancel" onclick="closeModal()">Cancelar</button>
      </div>
    </form>
  `);
  document.getElementById('user-password-new').focus();
}

async function saveUserPassword(event, id) {
  event.preventDefault();
  const form = event.target;
  const error = document.getElementById('user-password-error');
  const show = (message) => { error.textContent = message; error.hidden = false; };
  if (form.elements.password.value !== form.elements.confirm.value) return show('Las contraseñas no coinciden.');
  const button = document.getElementById('user-password-save');
  button.disabled = true;
  try {
    const res = await fetch(`/api/admin/users/${id}/password`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: form.elements.password.value })
    });
    const data = await res.json();
    if (!data.ok) return show(data.message);
    closeModal();
    showUsersMessage(data.message);
  } catch (_) {
    show('No se pudo guardar. Revisa tu conexión e inténtalo de nuevo.');
  } finally {
    button.disabled = false;
  }
}

async function removeAdminUser(id) {
  const email = panelUsers.get(id)?.email || '';
  if (!confirm(`¿Eliminar el usuario ${email}? Perderá el acceso al panel de inmediato.`)) return;
  try {
    const res = await fetch(`/api/admin/users/${id}`, { method: 'DELETE' });
    const data = await res.json();
    showUsersMessage(data.message);
    if (data.ok) await loadUsers();
  } catch (_) {
    showUsersMessage('No se pudo eliminar. Revisa tu conexión e inténtalo de nuevo.');
  }
}

async function logout() {
  try {
    await fetch('/admin/logout', { method: 'POST' });
  } finally {
    location.href = '/admin/login';
  }
}

document.getElementById('account-btn').addEventListener('click', (event) => {
  event.stopPropagation();
  const menu = document.getElementById('account-menu');
  menu.hidden = !menu.hidden;
  event.currentTarget.setAttribute('aria-expanded', String(!menu.hidden));
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('.account')) closeAccountMenu();
});
loadSession();
