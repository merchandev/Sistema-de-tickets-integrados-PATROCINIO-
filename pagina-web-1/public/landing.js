(function () {
  const CFG = window.ENTRADAS_CONFIG || { CENTRAL_API_URL: '' };
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  $('#year').textContent = new Date().getFullYear();

  /* ---- Navegación y barra de compra móvil ---- */
  const nav = $('#nav');
  const sticky = $('#sticky-buy');
  const onScroll = () => {
    nav.classList.toggle('scrolled', window.scrollY > 30);
    sticky.classList.toggle('show', window.scrollY > 500);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---- Aparición suave al hacer scroll ---- */
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { threshold: 0.1 });
  const observeReveals = (root = document) => $$('.reveal:not(.in)', root).forEach((el) => io.observe(el));
  observeReveals();

  /* ---- Video: si existe /media/promo.mp4 se muestra; si no, queda el marcador ---- */
  fetch('/media/promo.mp4', { method: 'HEAD' }).then((r) => {
    if (!r.ok || !(r.headers.get('content-type') || '').startsWith('video')) return;
    $('#video-frame').innerHTML = '<video controls playsinline preload="metadata" poster="/media/poster.jpg"><source src="/media/promo.mp4" type="video/mp4"></video>';
  }).catch(() => {});

  /* ---- Formato ---- */
  const fmtDate = (d) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''));
    if (!m) return d || '';
    return new Intl.DateTimeFormat('es-VE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
      .format(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])));
  };

  /* ---- Datos en vivo del sistema central ---- */
  function applyConfig(cfg) {
    if (!cfg) return;
    let notice = document.getElementById('sales-notice');
    if (cfg.sales_enabled === false && !notice) {
      notice = document.createElement('p'); notice.id = 'sales-notice';
      notice.textContent = 'Venta de entradas proximamente. Aun no debes realizar pagos.';
      notice.style.cssText = 'margin-top:18px;font-size:12px;line-height:1.7;color:inherit';
      document.querySelector('.hero-copy').appendChild(notice);
    }
    if (notice && cfg.sales_enabled !== false) notice.remove();
    const usd = Number(cfg.ticket_price_usd || 5);
    const usdTxt = `$${Number.isInteger(usd) ? usd : usd.toFixed(2)}`;
    $('#cta-price').textContent = usdTxt;
    $('#sticky-price').textContent = usdTxt;
    $$('.faq-price').forEach((e) => { e.textContent = `$${usd.toFixed(2)} USD`; });

    const ves = Number(cfg.ticket_price_ves || 0);
    if (ves > 0) {
      $('#cta-ves').textContent = `≈ Bs. ${ves.toFixed(2)}`;
      const rate = Number(cfg.bcv_rate || 0);
      if (rate > 0) $('#cta-rate').textContent = `Tasa oficial BCV: Bs. ${rate.toFixed(4)}`;
    }

    if (Array.isArray(cfg.event_schedule) && cfg.event_schedule.length) {
      $('#timeline').innerHTML = cfg.event_schedule.map((it) => `
        <div class="tl-item reveal">
          <div class="tl-time">${esc(it.time)}</div>
          <div>
            ${it.phase ? `<span class="tl-phase">${esc(it.phase)}</span>` : ''}
            <h3>${esc(it.title)}</h3>
          </div>
          <p>${esc(it.description || '')}</p>
        </div>`).join('');
      observeReveals($('#timeline'));
    }
  }

  function applyTickets(tickets) {
    if (!Array.isArray(tickets) || !tickets.length) return;
    const total = tickets.length;
    const free = tickets.filter((t) => t.status === 'AVAILABLE').length;
    const takenPct = Math.round(((total - free) / total) * 100);
    $$('.avail-count').forEach((e) => { e.textContent = `${free} / ${total}`; });
    $$('.avail-bar').forEach((e) => { e.style.width = Math.max(3, takenPct) + '%'; });
    $$('.avail-label').forEach((e) => { e.textContent = free <= 25 ? 'Últimas entradas' : 'Entradas disponibles'; });
  }

  async function load() {
    try {
      const res = await fetch(`${CFG.CENTRAL_API_URL || ''}/api/public/state`);
      const data = await res.json();
      if (data && data.ok) { applyConfig(data.config); applyTickets(data.tickets); }
    } catch (_) { /* se mantienen los textos por defecto */ }
  }
  load();
  setInterval(load, 20000);
})();
