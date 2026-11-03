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

socket.on('connect', () => connectionStatus('En vivo'));
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
      ? '<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-amber-100 text-amber-800">Pendiente</span>'
      : o.status === 'APPROVED'
      ? '<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800">Aprobado</span>'
      : '<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-red-100 text-red-800">Rechazado</span>';

    const originBadge = sourceBadge(o.source_web);

    const actionsHtml = o.status === 'PENDING'
      ? `
        <div class="flex flex-col sm:flex-row gap-1.5 justify-end">
          <button onclick="approveOrder(${o.id})" class="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold shadow-sm">
            ✓ Verificar y Enviar PDF
          </button>
          <button onclick="rejectOrder(${o.id})" class="px-3 py-1.5 bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 rounded-lg text-xs font-semibold">
            ✕ Rechazar
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
      : `<span class="text-xs text-slate-400">Liberada</span>`;

    return `
      <tr data-source="${escapeHtml(o.source_web)}" class="hover:bg-slate-50 transition">
        <td data-label="Entrada y página" class="py-3 px-3">
          <div class="text-base font-extrabold text-slate-900">#${o.ticket_number}</div>
          <div class="mt-0.5">${originBadge}</div>
          <div class="text-[10px] text-slate-400 mt-0.5">${escapeHtml(o.created_at)}</div>
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
          <div class="text-xs text-slate-600 mt-0.5">Tel. Pago: <strong>${escapeHtml(o.payment_phone)}</strong></div>
        </td>
        <td data-label="Importe" class="py-3 px-3">
          <div class="font-bold text-slate-900">$${Number(o.amount_usd).toFixed(2)} USD</div>
          <div class="text-xs font-semibold text-emerald-700">Bs. ${Number(o.amount_ves).toFixed(2)}</div>
          <div class="text-[10px] text-slate-400">BCV: ${Number(o.bcv_rate).toFixed(2)}</div>
        </td>
        <td data-label="Comprobante" class="py-3 px-3">
          <button onclick="viewScreenshot('${o.screenshot_path}', '${o.ticket_number}')" class="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg text-xs font-semibold border border-slate-300">
            Ver comprobante
          </button>
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
      subtitle = `${t.remaining_seconds}s`;
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
  const ticket = (state.tickets || []).find(t => t.ticket_number === ticketNumber);
  const order = (state.orders || []).find(o => o.ticket_number === ticketNumber && o.status !== 'REJECTED');
  if (!ticket) return;

  let html = `
    <div class="space-y-3">
      <div class="p-3 rounded-lg bg-slate-100 flex justify-between items-center">
        <div>
          <span class="text-xs text-slate-500 uppercase font-bold">Número de Entrada</span>
          <div class="text-2xl font-extrabold text-slate-900">#${ticket.ticket_number}</div>
        </div>
        <span class="px-3 py-1 rounded-full text-xs font-bold bg-slate-900 text-white">${ticket.status}</span>
      </div>
  `;

  if (ticket.status === 'LOCKED') {
    html += `
      <div class="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs space-y-1">
        <div><strong>Bloqueo temporal activo (3 minutos):</strong> Restan <strong>${ticket.remaining_seconds} segundos</strong></div>
        <div><strong>Página de origen:</strong> ${sourceBadge(ticket.locked_by_source)}</div>
      </div>
    `;
  }

  if (order) {
    html += `
      <div class="p-4 rounded-lg border border-slate-200 space-y-1.5 text-xs">
        <div class="font-bold text-sm text-slate-900 mb-1">Datos del Comprador Asociado</div>
        <div><strong>Nombre y Apellido:</strong> ${escapeHtml(order.buyer_name)}</div>
        <div><strong>Cédula:</strong> ${escapeHtml(order.buyer_cedula)}</div>
        <div><strong>Correo:</strong> ${escapeHtml(order.buyer_email)}</div>
        <div><strong>Teléfono Contacto:</strong> ${escapeHtml(order.buyer_phone)}</div>
        <div><strong>Teléfono Pago:</strong> ${escapeHtml(order.payment_phone)}</div>
        <div><strong>Referencia Bancaria:</strong> ${escapeHtml(order.payment_reference)}</div>
        <div><strong>Origen:</strong> ${sourceBadge(order.source_web)}</div>
        ${order.verification_token ? `<div><strong>Token QR:</strong> <code>${order.verification_token}</code></div>` : ''}
      </div>
    `;
  }

  html += `</div>`;
  openModal(`Detalle de Entrada #${ticketNumber}`, html);
}

async function approveOrder(orderId) {
  try {
    const res = await fetch(`/api/admin/orders/${orderId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ admin_notes: 'Pago verificado en Dashboard Administrativo' })
    });
    const data = await res.json();
    if (!data.ok) {
      alert(data.message || 'Error al aprobar la orden');
      return;
    }
    await fetchAdminOverview();
    openModal(
      `✅ Entrada #${data.order.ticket_number} Verificada y Enviada por Correo`,
      `
        <div class="space-y-4 text-center">
          <div class="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl text-xs font-medium">
            ${escapeHtml(data.message)}
          </div>
          <div class="flex flex-col items-center justify-center">
            <img src="${data.qrDataUrl}" alt="QR Entrada" class="w-44 h-44 border p-2 rounded-xl shadow-sm" />
            <div class="font-mono text-xs font-bold mt-2 bg-slate-100 px-3 py-1 rounded">${data.order.verification_token}</div>
          </div>
          <div class="flex justify-center gap-3 pt-2">
            <a href="${data.pdfUrl}" target="_blank" class="px-4 py-2 bg-slate-900 text-white rounded-lg text-xs font-bold">
              📄 Descargar / Ver PDF Generado
            </a>
            <button onclick="closeModal(); testTokenInScanner('${data.order.verification_token}')" class="px-4 py-2 bg-emerald-600 text-white rounded-lg text-xs font-bold">
              🔍 Probar Escaneo de este QR
            </button>
          </div>
        </div>
      `
    );
  } catch (err) {
    alert('Error de red al aprobar el pago');
  }
}

async function rejectOrder(orderId) {
  const reason = prompt('Indica el motivo del rechazo (se notificará al usuario y la entrada quedará libre):', 'Referencia bancaria no encontrada o monto incompleto');
  if (reason === null) return;

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
    await fetchAdminOverview();
  } catch (err) {
    alert('Error al rechazar orden');
  }
}

function viewScreenshot(pathUrl, ticketNumber) {
  const reference = state.orders.find(order => order.ticket_number === ticketNumber && order.screenshot_path === pathUrl)?.payment_reference || '';
  openModal(
    `Captura de Pago - Entrada #${ticketNumber} (Ref: ${reference})`,
    `
      <div class="space-y-3 text-center">
        <img src="${pathUrl}" alt="Captura de pago" class="max-h-[65vh] mx-auto rounded-lg border border-slate-200 shadow" />
        <div>
          <a href="${pathUrl}" target="_blank" class="text-xs text-blue-600 hover:underline font-semibold">Abrir imagen en tamaño original ↗</a>
        </div>
      </div>
    `
  );
}

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

async function verifyQrToken(rawToken) {
  const box = document.getElementById('qr-verification-result');
  box.innerHTML = `<div class="py-8 text-slate-500">Verificando autenticidad criptográfica del QR...</div>`;

  try {
    const encoded = encodeURIComponent(rawToken);
    const res = await fetch(`/api/admin/verify-qr/${encoded}`);
    const data = await res.json();

    if (!data.valid) {
      box.className = 'p-6 rounded-xl border-2 border-red-500 bg-red-50 text-red-900 space-y-2';
      box.innerHTML = `
        <div class="text-lg font-extrabold text-red-700">${escapeHtml(data.message)}</div>
        <div class="text-xs text-red-600 font-mono">Token consultado: ${escapeHtml(rawToken)}</div>
      `;
      return;
    }

    const o = data.order;
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
          <span class="text-slate-400 uppercase font-bold block text-[10px]">Titular Verificado</span>
          <strong class="text-sm text-slate-900">${escapeHtml(o.buyer_name)}</strong>
        </div>
        <div>
          <span class="text-slate-400 uppercase font-bold block text-[10px]">Cédula de Identidad</span>
          <strong class="text-sm font-mono text-slate-900">${escapeHtml(o.buyer_cedula)}</strong>
        </div>
        <div>
          <span class="text-slate-400 uppercase font-bold block text-[10px]">Teléfono / Correo</span>
          <span class="text-slate-800">${escapeHtml(o.buyer_phone)}<br/>${escapeHtml(o.buyer_email)}</span>
        </div>
        <div>
          <span class="text-slate-400 uppercase font-bold block text-[10px]">Pago Verificado</span>
          <span class="text-slate-800">Ref: <strong>${escapeHtml(o.payment_reference)}</strong><br/>Tel. Pago: ${escapeHtml(o.payment_phone)}</span>
        </div>
      </div>

      <div class="space-y-2 pt-1">
        <div class="text-xs font-bold uppercase text-slate-600">Control de Acceso a las 2 Partes del Evento:</div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div class="p-3 rounded-xl border ${o.checked_in_conference ? 'bg-emerald-100 border-emerald-400' : 'bg-white border-slate-200'}">
            <div class="font-bold text-xs text-slate-900">Parte 1: Conferencias (4:00 PM - 7:00 PM)</div>
            ${
              o.checked_in_conference
                ? `<div class="text-xs text-emerald-800 font-semibold mt-1">✅ Ingresó: ${o.checked_in_conference_at}</div>`
                : `<button onclick="checkInAttendee('${o.verification_token}', 'conference')" class="mt-2 w-full py-1.5 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-bold">Registrar Ingreso Conferencias</button>`
            }
          </div>
          <div class="p-3 rounded-xl border ${o.checked_in_concert ? 'bg-emerald-100 border-emerald-400' : 'bg-white border-slate-200'}">
            <div class="font-bold text-xs text-slate-900">Parte 2: Concierto (7:00 PM en adelante)</div>
            ${
              o.checked_in_concert
                ? `<div class="text-xs text-emerald-800 font-semibold mt-1">✅ Ingresó: ${o.checked_in_concert_at}</div>`
                : `<button onclick="checkInAttendee('${o.verification_token}', 'concert')" class="mt-2 w-full py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold">Registrar Ingreso Concierto</button>`
            }
          </div>
        </div>
      </div>
    `;
  } catch (err) {
    box.innerHTML = `<div class="text-red-600">Error verificando el código QR.</div>`;
  }
}

async function checkInAttendee(token, stage) {
  try {
    const res = await fetch(`/api/admin/verify-qr/${encodeURIComponent(token)}/checkin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage })
    });
    const data = await res.json();
    if (!data.ok) {
      alert(data.message);
    }
    await verifyQrToken(token);
    await fetchAdminOverview();
  } catch (err) {
    alert('Error al registrar check-in');
  }
}

function toggleQrCamera() {
  const btn = document.getElementById('btn-toggle-camera');
  if (qrCameraRunning && qrScannerInstance) {
    qrScannerInstance.stop().then(() => {
      qrCameraRunning = false;
      btn.textContent = '📷 Iniciar Cámara Escáner QR';
    });
    return;
  }

  qrScannerInstance = new Html5Qrcode('qr-reader');
  qrScannerInstance.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: { width: 220, height: 220 } },
    (decodedText) => {
      document.getElementById('qr-token-input').value = decodedText;
      verifyQrToken(decodedText);
    },
    () => {}
  ).then(() => {
    qrCameraRunning = true;
    btn.textContent = '⏹ Detener Cámara';
  }).catch((err) => {
    alert('No se pudo acceder a la cámara en este navegador. Puedes usar el verificador de Token manual arriba.');
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
  document.getElementById('cms-lock-seconds').value = s.lock_duration_seconds || '180';
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

  // SMTP
  document.getElementById('smtp-host').value = s.smtp_host || '';
  document.getElementById('smtp-port').value = s.smtp_port || '587';
  document.getElementById('smtp-user').value = s.smtp_user || '';
  document.getElementById('smtp-pass').value = s.smtp_pass || '';
  document.getElementById('smtp-from').value = s.smtp_from || '';
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
  const payload = {
    smtp_host: document.getElementById('smtp-host').value.trim(),
    smtp_port: document.getElementById('smtp-port').value.trim(),
    smtp_user: document.getElementById('smtp-user').value.trim(),
    smtp_pass: document.getElementById('smtp-pass').value,
    smtp_from: document.getElementById('smtp-from').value.trim()
  };
  const res = await fetch('/api/admin/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  alert('Configuración SMTP guardada exitosamente.');
  await fetchAdminOverview();
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
  if (logs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="py-6 text-center text-slate-400">Aún no se han enviado correos.</td></tr>`;
    return;
  }

  tbody.innerHTML = logs.map((l, idx) => `
    <tr class="hover:bg-slate-50">
      <td class="py-2.5 px-3 text-slate-500">${l.created_at}</td>
      <td class="py-2.5 px-3"><span class="px-2 py-0.5 rounded bg-slate-100 font-mono text-[10px] font-bold">${l.type}</span></td>
      <td class="py-2.5 px-3 font-medium">${escapeHtml(l.recipient_name)} &lt;${escapeHtml(l.recipient_email)}&gt;</td>
      <td class="py-2.5 px-3">${escapeHtml(l.subject)}</td>
      <td class="py-2.5 px-3">
        ${l.attachment_path ? `<a href="${l.attachment_path}" target="_blank" class="text-blue-600 font-semibold hover:underline">📄 PDF Adjunto</a>` : '-'}
      </td>
      <td class="py-2.5 px-3">
        <span class="px-2 py-0.5 rounded text-[10px] font-bold ${l.status === 'ERROR' ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-800'}">${l.status}</span>
      </td>
      <td class="py-2.5 px-3 text-right">
        <button onclick="previewEmailLog(${idx})" class="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 rounded text-xs font-semibold">
          Ver Correo
        </button>
      </td>
    </tr>
  `).join('');
}

function previewEmailLog(index) {
  const log = (state.emailLogs || [])[index];
  if (!log) return;
  openModal(`Vista Previa de Correo: ${log.subject}`, `
    <div class="space-y-3">
      <div class="text-xs bg-slate-50 p-3 rounded border">
        <div><strong>Para:</strong> ${escapeHtml(log.recipient_name)} &lt;${escapeHtml(log.recipient_email)}&gt;</div>
        <div><strong>Tipo:</strong> ${log.type} | <strong>Fecha:</strong> ${log.created_at}</div>
        ${log.attachment_path ? `<div><strong>Archivo PDF Adjunto:</strong> <a href="${log.attachment_path}" target="_blank" class="text-blue-600 underline">${log.attachment_path}</a></div>` : ''}
      </div>
      <div class="border rounded-lg p-4 bg-white">${log.body_html || ''}</div>
    </div>
  `);
}

function switchTab(tabName) {
  const titles = {orders:'Pagos y ventas', seats:'Mapa de entradas', qr:'Control de acceso', cms:'Evento y contenido', smtp:'Correos y avisos'};
  document.getElementById('workspace-title').textContent = titles[tabName] || titles.orders;
  document.querySelector('.dashboard-main').classList.toggle('focused-tab', tabName !== 'orders');
  ['orders', 'seats', 'qr', 'cms', 'smtp'].forEach(t => {
    document.getElementById(`tab-panel-${t}`).classList.toggle('hidden', t !== tabName);
    const button = document.getElementById(`tab-btn-${t}`);
    button.classList.toggle('active', t === tabName);
    if (t === tabName) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
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
  await fetchAdminOverview();
  const params = new URLSearchParams(window.location.search);
  const verifyToken = params.get('verifyToken');
  if (verifyToken) {
    testTokenInScanner(verifyToken);
  }
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
