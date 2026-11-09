// «Juntos lo hacemos posible»: sponsor logos managed from the shared panel, the same on both sites.
// Moves on its own when the logos do not fit, pauses while the cursor (or keyboard focus) is on it,
// and stays still for visitors who prefer reduced motion. Identical file in pagina-web-1 and pagina-web-2.
(() => {
  const section = document.getElementById('patrocinadores');
  if (!section) return;
  const CFG = window.ENTRADAS_CONFIG || {};
  const api = CFG.CENTRAL_API_URL || '';
  const viewport = section.querySelector('.sponsors-viewport');
  const track = section.querySelector('.sponsors-track');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const SPEED = 45; // pixels per second
  let sponsors = [];

  function tile(sponsor, copy) {
    const li = document.createElement('li');
    li.className = 'sponsor';
    if (copy) li.setAttribute('aria-hidden', 'true');
    const img = document.createElement('img');
    img.src = api + sponsor.image_url;
    img.loading = 'lazy';
    img.decoding = 'async';
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
    track.replaceChildren(...sponsors.map(s => tile(s, false)));
    section.classList.remove('is-moving');
    // Width of one row of logos, measured without wrapping
    section.classList.add('is-measuring');
    const setWidth = Math.ceil(track.getBoundingClientRect().width);
    section.classList.remove('is-measuring');
    if (reduceMotion.matches || setWidth <= viewport.clientWidth) return;
    // A second copy of the logos makes the loop seamless; it moves by exactly one set
    track.append(...sponsors.map(s => tile(s, true)));
    track.style.setProperty('--sponsors-shift', `-${setWidth}px`);
    track.style.setProperty('--sponsors-duration', `${Math.max(12, setWidth / SPEED)}s`);
    section.classList.add('is-moving');
  }

  // Touch screens have no hover: a touch pauses the carousel for a moment
  let resumeTimer;
  viewport.addEventListener('touchstart', () => {
    section.classList.add('is-paused');
    clearTimeout(resumeTimer);
  }, { passive: true });
  viewport.addEventListener('touchend', () => {
    resumeTimer = setTimeout(() => section.classList.remove('is-paused'), 2500);
  }, { passive: true });

  let resizeTimer;
  let lastWidth = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (sponsors.length && viewport.clientWidth !== lastWidth) {
        lastWidth = viewport.clientWidth;
        layout();
      }
    }, 200);
  });
  reduceMotion.addEventListener?.('change', () => sponsors.length && layout());

  fetch(`${api}/api/public/sponsors`)
    .then(res => (res.ok ? res.json() : null))
    .then(data => {
      sponsors = (data && data.sponsors) || [];
      if (!sponsors.length) return;
      section.hidden = false;
      lastWidth = viewport.clientWidth;
      layout();
    })
    .catch(() => {});
})();
