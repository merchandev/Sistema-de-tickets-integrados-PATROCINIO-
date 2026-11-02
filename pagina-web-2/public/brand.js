/* Carga el logo oficial si existe en /media/logo.png; si no, queda la insignia HDM */
(function () {
  const badges = document.querySelectorAll('[data-logo]');
  if (!badges.length) return;
  const img = new Image();
  img.onload = () => badges.forEach((b) => {
    const el = document.createElement('img');
    el.src = '/media/logo.png';
    el.alt = 'Hablemos de Marketing';
    b.replaceWith(el);
  });
  img.src = '/media/logo.png';
})();
