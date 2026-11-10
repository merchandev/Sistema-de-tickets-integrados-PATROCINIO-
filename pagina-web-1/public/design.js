(function () {
  // Year of the footer credits, on the home and on the purchase page
  const year = document.getElementById('year');
  if (year) year.textContent = new Date().getFullYear();
  document.querySelectorAll('.mobile-menu a').forEach((link) => {
    link.addEventListener('click', () => link.closest('details').removeAttribute('open'));
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') document.querySelectorAll('.mobile-menu[open]').forEach((menu) => menu.removeAttribute('open'));
  });
})();
