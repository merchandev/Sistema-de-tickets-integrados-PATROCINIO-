(function () {
  const CFG = window.ENTRADAS_CONFIG || {
    CENTRAL_API_URL: 'http://localhost:4000',
    SOURCE_WEB: 'pagina-web-1',
    SITE_LABEL: 'PÁGINA WEB 1'
  };

  // Unique session ID per browser tab
  let sessionId = sessionStorage.getItem('entradas_session_id');
  if (!sessionId) {
    sessionId = 'sess_' + Math.random().toString(36).slice(2) + '_' + Date.now();
    sessionStorage.setItem('entradas_session_id', sessionId);
  }

  let eventConfig = {};
  let tickets = [];
  let myLockedTicket = null;
  let myLockRemainingSec = 0;
  let myQuote = null;

  // Dynamically load Socket.IO client from Central Server
  const script = document.createElement('script');
  script.src = `${CFG.CENTRAL_API_URL}/socket.io/socket.io.js`;
  script.onload = () => {
    const socket = window.io(CFG.CENTRAL_API_URL || window.location.origin, {
      query: { source: CFG.SOURCE_WEB, sessionId }
    });

    socket.on('init:state', (data) => {
      if (data.config) {
        eventConfig = data.config;
        renderConfig();
      }
      if (data.tickets) {
        tickets = data.tickets;
        syncMyLockFromServer();
        renderTicketsGrid();
      }
    });

    socket.on('tickets:updated', (data) => {
      if (data.tickets) {
        tickets = data.tickets;
        syncMyLockFromServer();
        renderTicketsGrid();
      }
    });

    socket.on('config:updated', (newCfg) => {
      eventConfig = newCfg;
      renderConfig();
    });
  };
  document.head.appendChild(script);

  // Also fetch initial state via HTTP REST
  async function loadInitialState() {
    try {
      const res = await fetch(`${CFG.CENTRAL_API_URL}/api/public/state`, {headers: {'X-Session-Id': sessionId}});
      const data = await res.json();
      if (data.ok) {
        eventConfig = data.config;
        tickets = data.tickets;
        renderConfig();
        syncMyLockFromServer();
        renderTicketsGrid();
      }
    } catch (err) {
      showAlert('Error conectando con el servidor central de entradas.', 'error');
    }
  }

  function fmtTime(t) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
    if (!m) return t || '';
    const h = parseInt(m[1], 10);
    return `${h % 12 || 12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
  }
  function fmtDate(d) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''));
    if (!m) return d || '';
    return new Intl.DateTimeFormat('es-VE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])));
  }

  function renderConfig() {
    if (eventConfig.sales_enabled === false) showAlert("Venta de entradas proximamente. Puedes consultar el evento; aun no debes realizar pagos.", "info");


    const usd = Number(eventConfig.ticket_price_usd || 5).toFixed(2);
    const ves = Number(eventConfig.ticket_price_ves || 0).toFixed(2);
    const bcv = Number(eventConfig.bcv_rate || 0).toFixed(8);

    document.getElementById('price-usd').textContent = `$${usd} USD`;
    document.getElementById('price-ves').textContent = `Bs. ${ves}`;
    document.getElementById('bcv-rate').textContent = `Bs. ${bcv}`;
    document.getElementById('bcv-source').textContent = eventConfig.bcv_mode === 'manual' ? 'Tasa manual configurada por administracion' : `${eventConfig.bcv_source_label || 'Sin fuente'} | Fecha valor: ${eventConfig.bcv_value_date || '--'} | Estado: ${eventConfig.bcv_fetch_status || 'sin confirmar'} | Consulta: ${eventConfig.bcv_last_updated || 'Sin confirmar'}`;

    document.getElementById('event-date-time').textContent = `${fmtDate(eventConfig.event_date)} | Ingreso: ${fmtTime(eventConfig.event_entry_time || '15:30')}`;
    document.getElementById('event-conf-hours').textContent = `${fmtTime(eventConfig.conference_start || '16:00')} a ${fmtTime(eventConfig.conference_end || '19:00')}`;
    document.getElementById('event-concert-hours').textContent = /^\d{1,2}:\d{2}$/.test(eventConfig.concert_end || '') ? `${fmtTime(eventConfig.concert_start)} a ${fmtTime(eventConfig.concert_end)}` : `Desde las ${fmtTime(eventConfig.concert_start || '19:00')} | Cierre abierto`;

    document.getElementById('checkout-amount-ves').textContent = `Bs. ${myQuote ? Number(myQuote.amount_ves).toFixed(2) : ves}`;
    document.getElementById('checkout-amount-usd').textContent = myQuote ? `Equivalente a ${myQuote.amount_usd} USD (Tasa BCV: Bs. ${myQuote.bcv_rate})` : `Equivalente a ${usd} USD (Tasa BCV: Bs. ${bcv})`;

    // Payment methods
    const pm = eventConfig.payment_methods || {};
    let pmHtml = '';
    if (pm.pago_movil) {
      pmHtml += `
        <div class="bank">
          <div class="t">Pago Móvil</div>
          <div><strong>Banco:</strong> ${escapeHtml(pm.pago_movil.banco)}</div>
          <div><strong>Teléfono:</strong> ${escapeHtml(pm.pago_movil.telefono)}</div>
          <div><strong>RIF/C.I:</strong> ${escapeHtml(pm.pago_movil.rif_cedula)}</div>
        </div>
      `;
    }
    if (pm.transferencia) {
      pmHtml += `
        <div class="bank">
          <div class="t">Transferencia Bancaria</div>
          <div><strong>Banco:</strong> ${escapeHtml(pm.transferencia.banco)}</div>
          <div><strong>Cuenta:</strong> ${escapeHtml(pm.transferencia.cuenta)}</div>
          <div><strong>RIF/C.I:</strong> ${escapeHtml(pm.transferencia.rif_cedula)}</div>
        </div>
      `;
    }
    document.getElementById('bank-details-box').innerHTML = pmHtml;

    // Schedule
    const schedList = document.getElementById('schedule-list');
    schedList.innerHTML = (eventConfig.event_schedule || []).map(item => `
      <div class="sched-item">
        <div class="t">${escapeHtml(item.time)} — ${escapeHtml(item.title)}</div>
        <div>${escapeHtml(item.description || '')}</div>
      </div>
    `).join('');

    document.getElementById('conditions-box').textContent = eventConfig.event_conditions || '';
    document.getElementById('terms-box').textContent = eventConfig.terms_and_conditions || '';
  }

  function syncMyLockFromServer() {
    const mine = tickets.find(t => t.status === 'LOCKED' && t.locked_by_session === sessionId);
    const checkoutSec = document.getElementById('checkout-section');

    if (mine) {
      myLockedTicket = mine.ticket_number;
      myQuote = mine.pricing || myQuote;
      renderConfig();
      myLockRemainingSec = mine.remaining_seconds || 180;
      document.getElementById('selected-ticket-label').textContent = mine.ticket_number;
      checkoutSec.classList.remove('hidden');
      updateTimerDisplay();
    } else {
      if (myLockedTicket) {
        // Had a lock that expired or completed
        myLockedTicket = null;
        myLockRemainingSec = 0;
        checkoutSec.classList.add('hidden');
      }
    }
  }

  function renderTicketsGrid() {
    const grid = document.getElementById('tickets-grid');
    if (!grid) return;

    grid.innerHTML = tickets.map(t => {
      const isMine = t.status === 'LOCKED' && t.locked_by_session === sessionId;
      let cls = 'free';
      let sub = 'Libre';

      if (isMine) {
        cls = 'mine';
        sub = 'Tu Reserva';
      } else if (t.status === 'LOCKED') {
        cls = 'locked';
        sub = `${t.remaining_seconds}s`;
      } else if (t.status === 'PENDING') {
        cls = 'pending';
        sub = 'Verif.';
      } else if (t.status === 'SOLD') {
        cls = 'sold';
        sub = 'Vendida';
      }

      return `
        <button
          type="button"
          onclick="window.selectTicket('${t.ticket_number}')"
          class="tk ${cls}"
        >
          <div class="n">${t.ticket_number}</div>
          <div class="s">${sub}</div>
        </button>
      `;
    }).join('');
  }

  window.selectTicket = async function (ticketNumber) {
    try {
      const res = await fetch(`${CFG.CENTRAL_API_URL}/api/public/tickets/lock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticket_number: ticketNumber,
          session_id: sessionId,
          source_web: CFG.SOURCE_WEB
        })
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        showAlert(data.message || `La entrada #${ticketNumber} no está disponible.`, 'warning');
        return;
      }

      myLockedTicket = ticketNumber;
      myQuote = data.pricing;
      renderConfig();
      myLockRemainingSec = Math.max(0, Math.ceil((data.ticket.locked_until - data.serverTime) / 1000));
      document.getElementById('selected-ticket-label').textContent = ticketNumber;
      document.getElementById('checkout-section').classList.remove('hidden');
      updateTimerDisplay();
      showAlert(`Entrada #${ticketNumber} bloqueada para ti por 3 minutos. Completa los datos de tu pago abajo.`, 'success');
      document.getElementById('checkout-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      showAlert('Error de conexión al intentar reservar la entrada.', 'error');
    }
  };

  window.cancelCurrentSelection = async function () {
    if (!myLockedTicket) return;
    const num = myLockedTicket;
    try {
      await fetch(`${CFG.CENTRAL_API_URL}/api/public/tickets/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket_number: num, session_id: sessionId })
      });
      myLockedTicket = null;
      myLockRemainingSec = 0;
      document.getElementById('checkout-section').classList.add('hidden');
      showAlert(`Liberaste la entrada #${num}. Ya está disponible nuevamente.`, 'info');
    } catch (_) {}
  };

  window.submitPaymentForm = async function (e) {
    e.preventDefault();
    if (!myLockedTicket) {
      showAlert('Primero debes seleccionar una entrada disponible.', 'warning');
      return;
    }

    const btn = document.getElementById('btn-submit-order');
    btn.disabled = true;
    btn.textContent = 'Enviando reporte de pago...';

    try {
      const form = document.getElementById('payment-form');
      const formData = new FormData(form);
      formData.append('ticket_number', myLockedTicket);
      formData.append('source_web', CFG.SOURCE_WEB);
      formData.append('session_id', sessionId);

      const res = await fetch(`${CFG.CENTRAL_API_URL}/api/public/orders`, {
        method: 'POST',
        body: formData
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        showAlert(data.message || 'No se pudo procesar el reporte de pago.', 'error');
        btn.disabled = false;
        btn.textContent = 'Enviar Soporte de Pago para Verificación';
        return;
      }

      form.reset();
      myLockedTicket = null;
      myLockRemainingSec = 0;
      document.getElementById('checkout-section').classList.add('hidden');
      showAlert(data.message, 'success');
    } catch (err) {
      showAlert('Error enviando el soporte de pago.', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Enviar Soporte de Pago para Verificación';
    }
  };

  function updateTimerDisplay() {
    const mins = String(Math.floor(myLockRemainingSec / 60)).padStart(2, '0');
    const secs = String(myLockRemainingSec % 60).padStart(2, '0');
    const el = document.getElementById('countdown-timer');
    if (el) el.textContent = `${mins}:${secs}`;
  }

  function showAlert(msg, type = 'info') {
    const box = document.getElementById('alert-banner');
    box.className = 'alert ' + (['success', 'warning', 'error'].includes(type) ? type : 'info');
    box.textContent = msg;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // 1-second local countdown
  setInterval(() => {
    let changed = false;
    for (const t of tickets) {
      if (t.status === 'LOCKED' && t.remaining_seconds > 0) {
        t.remaining_seconds = Math.max(0, t.remaining_seconds - 1);
        changed = true;
      }
    }
    if (myLockedTicket && myLockRemainingSec > 0) {
      myLockRemainingSec = Math.max(0, myLockRemainingSec - 1);
      updateTimerDisplay();
      if (myLockRemainingSec === 0) {
        myLockedTicket = null;
        document.getElementById('checkout-section').classList.add('hidden');
        showAlert('El tiempo de reserva de 3 minutos ha expirado. La entrada volvió a estar disponible.', 'warning');
      }
    }
    if (changed) {
      renderTicketsGrid();
    }
  }, 1000);

  loadInitialState();
})();
