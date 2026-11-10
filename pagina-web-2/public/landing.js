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

  /* ---- Reels: se reproducen con sonido solo mientras se ven; al salir de pantalla se pausan ----
     Los navegadores no dejan iniciar audio hasta que la persona interactúa con la página: si lo
     bloquean, el video arranca en silencio y el sonido se activa con el primer clic, toque o tecla.
     Si la persona pausa o silencia un video a mano (o prefiere menos movimiento), se respeta. */
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const reels = [];
  $$('.reel').forEach((reel) => {
    const video = $('video', reel);
    const playback = $('.reel-playback', reel);
    const sound = $('.reel-sound', reel);
    let userPaused = reduceMotion;
    let userMuted = false;
    const play = () => {
      if (!userMuted) video.muted = false;
      video.play().catch(() => {
        if (video.muted) return;
        video.muted = true;
        video.play().catch(() => {});
      });
    };
    const sync = () => {
      reel.classList.toggle('is-paused', video.paused);
      reel.classList.toggle('is-unmuted', !video.muted);
      playback.setAttribute('aria-label', video.paused ? 'Reproducir video' : 'Pausar video');
      sound.setAttribute('aria-label', video.muted ? 'Activar sonido' : 'Silenciar');
      sound.setAttribute('aria-pressed', String(!video.muted));
    };
    const toggle = () => {
      userPaused = !video.paused;
      if (userPaused) video.pause(); else play();
    };
    const unmute = () => { if (!userMuted && !video.paused) video.muted = false; };
    ['play', 'pause', 'volumechange'].forEach((ev) => video.addEventListener(ev, sync));
    // El primer toque sobre un video que suena bloqueado en silencio activa el audio en vez de pausarlo.
    video.addEventListener('click', () => { if (video.muted && !userMuted && !video.paused) unmute(); else toggle(); });
    playback.addEventListener('click', toggle);
    sound.addEventListener('click', () => {
      video.muted = !video.muted;
      userMuted = video.muted;
      if (!video.muted && video.paused) { userPaused = false; play(); }
    });
    new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) video.pause();
      else if (!userPaused) play();
    }, { threshold: 0.5 }).observe(video);
    reels.push({ unmute });
    sync();
  });
  // Cualquier gesto fuera de los controles del video activa el sonido del que suena en silencio
  // (Safari puede volver a bloquearlo al reanudar, por eso no se escucha una sola vez).
  const unlockSound = (e) => { if (!(e.target.closest && e.target.closest('.reel'))) reels.forEach(({ unmute }) => unmute()); };
  ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, unlockSound, true));

  /* ---- Datos en vivo del sistema central ---- */
  function applyConfig(cfg) {
    if (!cfg) return;
    let notice = document.getElementById('sales-notice');
    if (cfg.sales_enabled === false && !notice) {
      notice = document.createElement('p'); notice.id = 'sales-notice';
      notice.textContent = 'Venta de entradas próximamente. Aún no debes realizar pagos.';
      notice.style.cssText = 'margin-top:18px;font-size:12px;line-height:1.7;color:inherit';
      document.querySelector('.hero-copy').appendChild(notice);
    }
    if (notice && cfg.sales_enabled !== false) notice.remove();
    const usd = Number(cfg.ticket_price_usd || 5);
    const usdTxt = `$${Number.isInteger(usd) ? usd : usd.toFixed(2)}`;
    $('#cta-price').textContent = usdTxt;
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

  const stickyPhase = $('#sticky-countdown-phase');
  const stickyClock = $('#sticky-countdown-clock');
  const stickyDigits = ['days', 'hours', 'minutes', 'seconds'].map((unit) => $('[data-sticky-' + unit + ']', stickyClock));
  const countdown = $('#event-countdown');
  const phaseLabel = $('.event-countdown-phase', countdown);
  const countdownDate = $('.event-countdown-date', countdown);
  const clock = $('.event-countdown-clock', countdown);
  const digits = ['days', 'hours', 'minutes', 'seconds'].map((unit) => $(`[data-countdown-${unit}]`, countdown));
  const stages = [
    { key: 'event_entry_time', time: '15:00', label: 'Nos vemos en' },
    { key: 'conference_start', time: '16:00', label: 'Las conferencias comienzan en' },
    { key: 'concert_start', time: '19:00', label: 'El concierto comienza en' }
  ];
  const venueDate = new Intl.DateTimeFormat('es-VE', { timeZone: 'America/Caracas', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true });
  let stageTimes, now = () => Date.now();
  let lastTarget;

  function setCountdown(config, serverTime) {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(config?.event_date || '') ? config.event_date : '2026-11-21';
    const toUtc = (time) => Date.parse(day + 'T' + time + ':00-04:00');
    const configured = stages.map(({key, time}) => toUtc(/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(config?.[key] || '') ? config[key] : time));
    stageTimes = configured[0] < configured[1] && configured[1] < configured[2]
      ? configured : stages.map(({time}) => toUtc(time));
    if (Number.isFinite(serverTime)) {
      const received = performance.now();
      now = () => serverTime + (performance.now() - received);
    }
    renderCountdown();
  }

  function renderCountdown() {
    const currentTime = now();
    const next = stageTimes.findIndex((time) => time > currentTime);
    const target = next < 0 ? stageTimes[2] : stageTimes[next];
    const state = next + '/' + target;
    if (lastTarget !== state) {
      phaseLabel.textContent = next < 0 ? 'El concierto ya comenzó' : stages[next].label;
      countdownDate.textContent = Number.isFinite(target) ? venueDate.format(target) + ' · Hora de Venezuela' : 'Hora de Venezuela';
      stickyPhase.textContent = phaseLabel.textContent;
      clock.hidden = stickyClock.hidden = next < 0;
      lastTarget = state;
    }
    if (next < 0) return;
    const remaining = Math.ceil((target - currentTime) / 1000);
    const units = [Math.floor(remaining / 86400), Math.floor(remaining / 3600) % 24, Math.floor(remaining / 60) % 60, remaining % 60]
      .map((value) => String(value).padStart(2, '0'));
    units.forEach((value, i) => {
      digits[i].textContent = value;
      stickyDigits[i].textContent = value;
    });
  }

  async function load() {
    try {
      const res = await fetch(`${CFG.CENTRAL_API_URL || ''}/api/public/state`, { cache: 'no-store' });
      const data = await res.json();
      if (data && data.ok) {
        setCountdown(data.config, data.serverTime);
        applyConfig(data.config);
      }
    } catch (_) { /* se mantienen los textos por defecto */ }
  }
  setCountdown();
  setInterval(renderCountdown, 250);
  load();
  setInterval(load, 20000);
})();
