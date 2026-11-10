(function () {
  const CFG = window.ENTRADAS_CONFIG || {
    CENTRAL_API_URL: 'http://localhost:4000',
    SOURCE_WEB: 'pagina-web-1',
    SITE_LABEL: 'PÁGINA WEB 1'
  };

  // Unique session ID per browser tab
  let sessionId = sessionStorage.getItem('entradas_session_id');
  if (!sessionId) {
    sessionId = crypto.randomUUID?.() || ('sess_' + Math.random().toString(36).slice(2) + '_' + Date.now());
    sessionStorage.setItem('entradas_session_id', sessionId);
  }

  let eventConfig = {};
  let assigning = false;
  let latestReservationTime = 0;
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
  const assignmentButton = $('assign-ticket');
  const assignmentResult = $('assignment-result');
  // Copy and "copied" icons of the account data buttons (the CSS shows one or the other)
  const icon = (cls, paths) => `<svg class="pay-icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
  const COPY_ICONS = icon('i-copy', '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>') +
    icon('i-check', '<path d="M5 12.5l4.5 4.5L19 7.5"/>');
  const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;

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
      syncMyLockFromServer(data);
    });

    socket.on('reservation:updated', syncMyLockFromServer);

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
        renderConfig();
        syncMyLockFromServer(data);
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
    if (salesClosed) showAlert("Venta de entradas próximamente. Puedes consultar el evento; aún no debes realizar pagos.", "info");
    $('open-report').disabled = salesClosed;
    assignmentButton.disabled = salesClosed || assigning;

    const usd = Number(eventConfig.ticket_price_usd || 5).toFixed(2);
    const ves = Number(eventConfig.ticket_price_ves || 0);
    const bcv = Number(eventConfig.bcv_rate || 0).toFixed(8);

    $('price-usd').textContent = `$${usd} USD`;
    $('price-ves').textContent = `Bs. ${ves.toFixed(2)}`;
    $('bcv-rate').textContent = `Bs. ${bcv}`;
    $('bcv-source').textContent = eventConfig.bcv_mode === 'manual' ? 'Tasa manual configurada por administracion' : `${eventConfig.bcv_source_label || 'Sin fuente'} | Fecha valor: ${eventConfig.bcv_value_date || '--'} | Estado: ${eventConfig.bcv_fetch_status || 'sin confirmar'} | Consulta: ${eventConfig.bcv_last_updated || 'Sin confirmar'}`;

    $('event-date-time').textContent = `${fmtDate(eventConfig.event_date)} | Ingreso: ${fmtTime(eventConfig.event_entry_time || '15:00')}`;
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
        <button type="button" class="pay-copy" data-copy="${escapeHtml(copy)}" aria-label="Copiar ${label.toLowerCase()}">${COPY_ICONS}<span>Copiar</span></button>
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

  function showAssignment(ticketNumber) {
    $('assignment-number').textContent = '#' + ticketNumber;
    assignmentResult.hidden = false;
  }

  function syncMyLockFromServer({reservation, serverTime}) {
    if (assigning || serverTime < latestReservationTime) return;
    latestReservationTime = serverTime;
    if (reservation) {
      myLockedTicket = reservation.ticket_number;
      myQuote = reservation.pricing;
      myLockRemainingSec = Math.max(0, Math.ceil((reservation.locked_until - serverTime) / 1000));
      showAssignment(myLockedTicket);
      if (payMode !== 'checkout' && !paySubmitting) openPayDialog('checkout');
      updateTimerDisplay();
    } else if (myLockedTicket) {
      const lost = myLockedTicket;
      myLockedTicket = null;
      myLockRemainingSec = 0;
      assignmentResult.hidden = true;
      if (payMode === 'checkout' && !payDone && !paySubmitting) switchToReportAfterExpiry(lost);
    }
  }

  assignmentButton.addEventListener('click', async () => {
    if (assigning) return;
    assigning = true;
    assignmentButton.disabled = true;
    assignmentButton.textContent = 'Asignando…';
    $('alert-banner').className = 'alert hidden';
    try {
      const res = await fetch(CFG.CENTRAL_API_URL + '/api/public/tickets/lock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, source_web: CFG.SOURCE_WEB })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        showAlert(data.message || 'No pudimos asignarte una entrada. Intenta nuevamente.', 'warning');
        return;
      }
      latestReservationTime = data.serverTime;
      myLockedTicket = data.ticket.ticket_number;
      myQuote = data.pricing;
      myLockRemainingSec = Math.max(0, Math.ceil((data.ticket.locked_until - data.serverTime) / 1000));
      showAssignment(myLockedTicket);
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) await new Promise(resolve => setTimeout(resolve, 550));
      if (myLockedTicket) {
        openPayDialog('checkout');
        updateTimerDisplay();
      }
    } catch (_) {
      showAlert('No pudimos conectar con el servidor para asignarte una entrada.', 'error');
    } finally {
      assigning = false;
      assignmentButton.disabled = eventConfig.sales_enabled === false;
      assignmentButton.textContent = 'Asignar entrada';
    }
  });

  async function releaseMyTicket() {
    if (!myLockedTicket) return;
    const num = myLockedTicket;
    assignmentResult.hidden = true;
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
    // The report asks for the ticket number and what happened; both are required, but only in that mode
    form.querySelectorAll('.report-only').forEach(el => {
      el.hidden = !isReport;
      el.querySelectorAll('input, textarea').forEach(field => { field.required = isReport; });
    });
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
    const text = button.querySelector('span') || button;
    clearTimeout(button.copyTimer);
    text.textContent = 'Copiado';
    button.classList.add('is-copied');
    button.copyTimer = setTimeout(() => { text.textContent = 'Copiar'; button.classList.remove('is-copied'); }, 1600);
  });

  // Capture of the payment: show the chosen file and check it before sending
  const captureInput = form.elements.screenshot;
  const captureBox = captureInput.closest('.pay-file');
  function showCapture() {
    const file = captureInput.files && captureInput.files[0];
    captureBox.classList.toggle('has-file', Boolean(file));
    $('pay-file-name').textContent = file ? file.name : 'Elegir la captura del comprobante';
    $('pay-file-hint').textContent = file ? `${(file.size / 1024 / 1024).toFixed(1)} MB · toca para cambiarla` : 'Toca aquí para seleccionar la imagen';
  }
  captureInput.addEventListener('change', () => {
    showCapture();
    if (captureInput.files[0]) captureInput.removeAttribute('aria-invalid');
  });
  form.addEventListener('reset', () => setTimeout(showCapture));

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
    const capture = captureInput.files[0];
    if (!capture) return showFormError('Adjunta la captura del pago.', 'screenshot');
    if (!/^image\/(png|jpeg|webp)$/.test(capture.type)) return showFormError('La captura debe ser una imagen PNG, JPG o WebP.', 'screenshot');
    if (capture.size > MAX_CAPTURE_BYTES) return showFormError('La captura pesa más de 10 MB. Envía una imagen más liviana.', 'screenshot');
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
        assignmentResult.hidden = true;
        switchToReportAfterExpiry(ticketNumber);
        return;
      }
      if (!res.ok || !data.ok) {
        showFormError(data.message || 'No se pudo enviar el pago. Revisa los datos e inténtalo de nuevo.', data.field);
        return;
      }

      payDone = true;
      assignmentResult.hidden = true;
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
    if (myLockedTicket && myLockRemainingSec > 0) {
      myLockRemainingSec = Math.max(0, myLockRemainingSec - 1);
      updateTimerDisplay();
      if (myLockRemainingSec === 0) {
        const expired = myLockedTicket;
        assignmentResult.hidden = true;
        myLockedTicket = null;
        if (payMode === 'checkout' && !payDone && !paySubmitting) switchToReportAfterExpiry(expired);
      }
    }
  }, 1000);

  loadInitialState();
})();
