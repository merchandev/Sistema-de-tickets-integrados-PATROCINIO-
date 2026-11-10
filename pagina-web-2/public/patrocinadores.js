// «Juntos lo hacemos posible»: sponsor logos managed from the shared panel (Patrocinio).
// Each site asks for its own list; the panel decides whether both lists are mixed. The section stays
// hidden until there is at least one logo. The carousel moves on its own when the logos do not fit,
// pauses on hover, keyboard focus or touch, rests while off screen, and stays still for visitors who
// prefer reduced motion. Identical file in pagina-web-1 and pagina-web-2.
(() => {
  const section = document.getElementById('patrocinadores');
  if (!section) return;
  const CFG = window.ENTRADAS_CONFIG || {};
  const api = CFG.CENTRAL_API_URL || '';
  const site = CFG.SOURCE_WEB || '';
  const viewport = section.querySelector('.sponsors-viewport');
  const track = section.querySelector('.sponsors-track');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let sponsors = [];
  let lastWidth = 0;

  function tile(sponsor, copy) {
    const li = document.createElement('li');
    li.className = 'sponsor';
    if (copy) li.setAttribute('aria-hidden', 'true');
    const img = document.createElement('img');
    img.src = api + sponsor.image_url;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.draggable = false;
    const name = sponsor.name || 'Patrocinador';
    if (sponsor.link_url) {
      const link = document.createElement('a');
      link.href = sponsor.link_url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.setAttribute('aria-label', `${name} (se abre en otra pestaña)`);
      if (copy) link.tabIndex = -1;
      img.alt = '';
      link.append(img);
      li.append(link);
    } else {
      img.alt = copy ? '' : name;
      const box = document.createElement('span');
      box.append(img);
      li.append(box);
    }
    return li;
  }

  function layout() {
    lastWidth = viewport.clientWidth;
    track.replaceChildren(...sponsors.map(s => tile(s, false)));
    section.classList.remove('is-moving');
    // Width of one row of logos, measured without wrapping
    section.classList.add('is-measuring');
    const setWidth = Math.ceil(track.getBoundingClientRect().width);
    section.classList.remove('is-measuring');
    if (reduceMotion.matches || setWidth <= lastWidth) return;
    // A second copy of the logos makes the loop seamless; it moves by exactly one set.
    // About 14 seconds to cross the visible width, between 36 and 80 pixels per second.
    track.append(...sponsors.map(s => tile(s, true)));
    const speed = Math.min(80, Math.max(36, lastWidth / 14));
    track.style.setProperty('--sponsors-shift', `-${setWidth}px`);
    track.style.setProperty('--sponsors-duration', `${Math.max(10, setWidth / speed).toFixed(1)}s`);
    section.classList.add('is-moving');
  }

  // Touch screens have no hover: a touch pauses the carousel for a moment
  let resumeTimer;
  viewport.addEventListener('touchstart', () => {
    section.classList.add('is-paused');
    clearTimeout(resumeTimer);
  }, { passive: true });
  viewport.addEventListener('touchend', () => {
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => section.classList.remove('is-paused'), 2500);
  }, { passive: true });

  // Re-measure when the available width changes (rotation, resize, zoom)
  let resizeTimer;
  const relayout = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (sponsors.length && Math.abs(viewport.clientWidth - lastWidth) > 1) layout();
    }, 150);
  };
  if ('ResizeObserver' in window) new ResizeObserver(relayout).observe(viewport);
  else window.addEventListener('resize', relayout);
  reduceMotion.addEventListener?.('change', () => sponsors.length && layout());

  // No movement while the section is off screen
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => section.classList.toggle('is-offscreen', !entry.isIntersecting)).observe(section);
  }

  fetch(`${api}/api/public/sponsors?site=${encodeURIComponent(site)}`)
    .then(res => (res.ok ? res.json() : null))
    .then(data => {
      sponsors = (data && Array.isArray(data.sponsors)) ? data.sponsors : [];
      if (!sponsors.length) return;
      section.hidden = false;
      layout();
    })
    .catch(() => {});
})();
