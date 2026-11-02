/* Identidad gráfica de la web Iluminando Caminos. */
(function () {
  const badges = document.querySelectorAll('[data-logo]');
  if (!badges.length) return;
  const img = new Image();
  img.onload = () => badges.forEach((b) => {
    const el = document.createElement('img');
    el.src = '/media/caminos-mark.svg';
    el.alt = '';
    b.replaceWith(el);
  });
  img.src = '/media/caminos-mark.svg';
})();
