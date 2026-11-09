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
  // Popup state: 'checkout' (ticket locked for this tab) or 'report' (standalone payment report)
  let payMode = null;
  let payDone = false;
  // While the form is being sent the ticket leaves LOCKED (live update) before the response arrives.
  let paySubmitting = false;

  const $ = (id) => document.getElementById(id);
  const dialog = $('pay-dialog');
  const form = $('payment-form');

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
  // 4455.53 -> "4.455,53", as bank apps in Venezuela show amounts
  const fmtBs = (value) => new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value || 0));

  function renderConfig() {
    const salesClosed = eventConfig.sales_enabled === false;
    if (salesClosed) showAlert("Venta de entradas proximamente. Puedes consultar el evento; aun no debes realizar pagos.", "info");
    $('open-report').disabled = salesClosed;

    const usd = Number(eventConfig.ticket_price_usd || 5).toFixed(2);
    const ves = Number(eventConfig.ticket_price_ves || 0);
    const bcv = Number(eventConfig.bcv_rate || 0).toFixed(8);

    $('price-usd').textContent = `$${usd} USD`;
    $('price-ves').textContent = `Bs. ${ves.toFixed(2)}`;
    $('bcv-rate').textContent = `Bs. ${bcv}`;
    $('bcv-source').textContent = eventConfig.bcv_mode === 'manual' ? 'Tasa manual configurada por administracion' : `${eventConfig.bcv_source_label || 'Sin fuente'} | Fecha valor: ${eventConfig.bcv_value_date || '--'} | Estado: ${eventConfig.bcv_fetch_status || 'sin confirmar'} | Consulta: ${eventConfig.bcv_last_updated || 'Sin confirmar'}`;

    $('event-date-time').textContent = `${fmtDate(eventConfig.event_date)} | Ingreso: ${fmtTime(eventConfig.event_entry_time || '15:30')}`;
    $('event-conf-hours').textContent = `${fmtTime(eventConfig.conference_start || '16:00')} a ${fmtTime(eventConfig.conference_end || '19:00')}`;
    $('event-concert-hours').textContent = /^\d{1,2}:\d{2}$/.test(eventConfig.concert_end || '') ? `${fmtTime(eventConfig.concert_start)} a ${fmtTime(eventConfig.concert_end)}` : `Desde las ${fmtTime(eventConfig.concert_start || '19:00')} | Cierre abierto`;

    // Amount of the popup: the quote frozen when the ticket was locked, or the current price
    const amountVes = payMode === 'checkout' && myQuote ? Number(myQuote.amount_ves) : ves;
    const amountUsd = payMode === 'checkout' && myQuote ? Number(myQuote.amount_usd).toFixed(2) : usd;
    const rate = payMode === 'checkout' && myQuote ? Number(myQuote.bcv_rate).toFixed(4) : Number(eventConfig.bcv_rate || 0).toFixed(4);
    $('checkout-amount-ves').textContent = `Bs. ${fmtBs(amountVes)}`;
    $('copy-amount').dataset.copy = fmtBs(amountVes).replace(/\./g, '');
    $('checkout-amount-usd').textContent = `Equivale a $${amountUsd} USD · tasa BCV Bs. ${rate}`;

    // Pago Móvil account (Bancamiga), each value with a copy button
    const pm = (eventConfig.payment_methods || {}).pago_movil;
    $('bank-details-box').innerHTML = pm ? [
      ['Banco', pm.banco, pm.banco],
      ['Teléfono', pm.telefono, String(pm.telefono || '').replace(/\D/g, '')],
      ['Cédula', pm.rif_cedula, String(pm.rif_cedula || '').replace(/[^\dA-Za-z]/g, '')]
    ].filter(([, shown]) => shown).map(([label, shown, copy]) => `
      <div class="pay-row">
        <dt>${label}</dt>
        <dd>${escapeHtml(shown)}</dd>
        <button type="button" class="pay-copy" data-copy="${escapeHtml(copy)}" aria-label="Copiar ${label.toLowerCase()}">Copiar</button>
      </div>`).join('') : '<p class="pay-fine">Los datos de pago estarán disponibles pronto.</p>';

    // Schedule
    const schedList = $('schedule-list');
    schedList.innerHTML = (eventConfig.event_schedule || []).map(item => `
      <div class="sched-item">
        <div class="t">${escapeHtml(item.time)} — ${escapeHtml(item.title)}</div>
        <div>${escapeHtml(item.description || '')}</div>
      </div>
    `).join('');

    $('conditions-box').textContent = eventConfig.event_conditions || '';
    $('terms-box').textContent = eventConfig.terms_and_conditions || '';
  }

  function syncMyLockFromServer() {
    const mine = tickets.find(t => t.status === 'LOCKED' && t.locked_by_session === sessionId);

    if (mine) {
      myLockedTicket = mine.ticket_number;
      myQuote = mine.pricing || myQuote;
      myLockRemainingSec = mine.remaining_seconds || 180;
      // Reopen the popup after a reload while the reservation is still running
      if (payMode !== 'checkout') openPayDialog('checkout');
      renderConfig();
      updateTimerDisplay();
    } else if (myLockedTicket) {
      // The reservation ended (expired or released from another tab)
      const lost = myLockedTicket;
      myLockedTicket = null;
      myLockRemainingSec = 0;
      if (payMode === 'checkout' && !payDone && !paySubmitting) switchToReportAfterExpiry(lost);
    }
  }

  function renderTicketsGrid() {
    const grid = $('tickets-grid');
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
          ${eventConfig.sales_enabled === false ? 'disabled aria-disabled="true" title="Venta disponible proximamente"' : ''}
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
      myLockRemainingSec = Math.max(0, Math.ceil((data.ticket.locked_until - data.serverTime) / 1000));
      openPayDialog('checkout');
      updateTimerDisplay();
    } catch (err) {
      showAlert('Error de conexión al intentar reservar la entrada.', 'error');
    }
  };

  async function releaseMyTicket() {
    if (!myLockedTicket) return;
    const num = myLockedTicket;
    myLockedTicket = null;
    myLockRemainingSec = 0;
    try {
      await fetch(`${CFG.CENTRAL_API_URL}/api/public/tickets/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket_number: num, session_id: sessionId })
      });
      showAlert(`Liberaste la entrada #${num}. Ya está disponible nuevamente.`, 'info');
    } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // Popup: Pago Móvil data + payment form
  // ---------------------------------------------------------------------------

  function openPayDialog(mode, notice = '') {
    payMode = mode;
    payDone = false;
    const isReport = mode === 'report';
    dialog.dataset.mode = mode;
    $('pay-kicker').textContent = isReport ? 'Reporte de pago' : 'Entrada reservada para ti';
    $('pay-title').textContent = isReport ? '¿Ya pagaste? Repórtalo aquí' : `Entrada #${myLockedTicket}`;
    $('pay-timer-box').hidden = isReport;
    $('pay-notice').hidden = !notice;
    $('pay-notice').textContent = notice;
    $('pay-step-pay').textContent = isReport ? 'Datos de la cuenta' : 'Paga por Pago Móvil';
    form.querySelectorAll('.report-only').forEach(el => { el.hidden = !isReport; });
    $('btn-submit-order').textContent = isReport ? 'Enviar reporte de pago' : 'Enviar pago para verificación';
    $('pay-content').hidden = false;
    $('pay-done').hidden = true;
    hideFormError();
    renderConfig();
    if (!dialog.open) dialog.showModal();
    $('pay-dialog').scrollTop = 0;
  }

  // The 3-minute reservation ended before the form was sent: keep what was typed and offer the report.
  function switchToReportAfterExpiry(ticketNumber) {
    const which = ticketNumber ? ` de la entrada #${ticketNumber}` : '';
    openPayDialog('report', `Tu reserva${which} expiró. Si ya hiciste el pago, envía este reporte y te asignaremos una entrada disponible.`);
    $('requested_ticket').value = ticketNumber || '';
  }

  async function closePayDialog() {
    if (payMode === 'checkout' && !payDone && myLockedTicket) {
      if (!window.confirm(`Si cierras, la entrada #${myLockedTicket} se liberará para otra persona. ¿Quieres cerrar?`)) return;
      await releaseMyTicket();
    }
    payMode = null;
    if (dialog.open) dialog.close();
  }

  $('pay-close').addEventListener('click', closePayDialog);
  $('pay-done-close').addEventListener('click', () => { payMode = null; dialog.close(); });
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); closePayDialog(); });
  $('open-report').addEventListener('click', () => {
    form.reset();
    openPayDialog('report');
  });

  // Copy buttons of the account data and the amount
  dialog.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-copy]');
    if (!button) return;
    const value = button.dataset.copy;
    try {
      await navigator.clipboard.writeText(value);
    } catch (_) {
      const temp = document.createElement('textarea');
      temp.value = value;
      document.body.appendChild(temp);
      temp.select();
      document.execCommand('copy');
      temp.remove();
    }
    const label = button.textContent;
    button.textContent = 'Copiado';
    button.classList.add('is-copied');
    setTimeout(() => { button.textContent = label; button.classList.remove('is-copied'); }, 1600);
  });

  function showFormError(message, field) {
    const box = $('pay-error');
    box.textContent = message;
    box.hidden = false;
    form.querySelectorAll('[aria-invalid="true"]').forEach(el => el.removeAttribute('aria-invalid'));
    const input = field && form.elements[field];
    if (input) {
      input.setAttribute('aria-invalid', 'true');
      input.focus();
    }
  }
  function hideFormError() {
    $('pay-error').hidden = true;
    form.querySelectorAll('[aria-invalid="true"]').forEach(el => el.removeAttribute('aria-invalid'));
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    hideFormError();
    if (!form.reportValidity()) return;
    const isReport = payMode === 'report';
    if (!isReport && !myLockedTicket) {
      switchToReportAfterExpiry('');
      return;
    }

    const btn = $('btn-submit-order');
    const idleText = btn.textContent;
    const ticketNumber = myLockedTicket;
    btn.disabled = true;
    btn.textContent = 'Enviando…';
    paySubmitting = true;

    try {
      const formData = new FormData(form);
      if (!isReport) formData.append('ticket_number', ticketNumber);
      formData.append('source_web', CFG.SOURCE_WEB);
      formData.append('session_id', sessionId);
      if (!formData.get('screenshot')?.size) formData.delete('screenshot');

      const res = await fetch(`${CFG.CENTRAL_API_URL}/api/public/${isReport ? 'payment-reports' : 'orders'}`, {
        method: 'POST',
        body: formData
      });
      const data = await res.json();

      if (!isReport && res.status === 409) {
        // The reservation was lost before sending: keep the data and offer the payment report.
        myLockedTicket = null;
        switchToReportAfterExpiry(ticketNumber);
        return;
      }
      if (!res.ok || !data.ok) {
        showFormError(data.message || 'No se pudo enviar el pago. Revisa los datos e inténtalo de nuevo.', data.field);
        return;
      }

      payDone = true;
      myLockedTicket = null;
      myLockRemainingSec = 0;
      form.reset();
      $('pay-kicker').textContent = 'Pago enviado';
      $('pay-content').hidden = true;
      $('pay-timer-box').hidden = true;
      $('pay-done-text').textContent = data.message;
      $('pay-done').hidden = false;
      $('pay-done-close').focus();
    } catch (err) {
      showFormError('No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.');
    } finally {
      paySubmitting = false;
      btn.disabled = false;
      btn.textContent = idleText;
    }
  });

  function updateTimerDisplay() {
    const mins = String(Math.floor(myLockRemainingSec / 60)).padStart(2, '0');
    const secs = String(myLockRemainingSec % 60).padStart(2, '0');
    const el = $('countdown-timer');
    if (el) el.textContent = `${mins}:${secs}`;
    $('pay-timer-box').classList.toggle('is-ending', myLockRemainingSec > 0 && myLockRemainingSec <= 30);
  }

  function showAlert(msg, type = 'info') {
    const box = $('alert-banner');
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
        const expired = myLockedTicket;
        myLockedTicket = null;
        if (payMode === 'checkout' && !payDone && !paySubmitting) switchToReportAfterExpiry(expired);
      }
    }
    if (changed) {
      renderTicketsGrid();
    }
  }, 1000);

  loadInitialState();
})();
