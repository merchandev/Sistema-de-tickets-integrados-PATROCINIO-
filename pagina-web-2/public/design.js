(function () {
  document.querySelectorAll('.mobile-menu a').forEach((link) => {
    link.addEventListener('click', () => link.closest('details').removeAttribute('open'));
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') document.querySelectorAll('.mobile-menu[open]').forEach((menu) => menu.removeAttribute('open'));
  });
  const toolbar = document.getElementById('ticket-toolbar');
  const ticketsGrid = document.getElementById('tickets-grid');
  if (toolbar && ticketsGrid) {
    let activeMode = 'all';
    let activeRange = [1, 250];
    let searchTerm = '';

    const applyFilter = () => {
      const buttons = ticketsGrid.querySelectorAll('.tk');
      buttons.forEach((btn) => {
        const numEl = btn.querySelector('.n');
        const numStr = numEl ? numEl.textContent.trim() : '';
        const num = parseInt(numStr, 10) || 0;
        let visible = true;

        if (activeMode === 'free' && !btn.classList.contains('free') && !btn.classList.contains('mine')) {
          visible = false;
        } else if (activeMode === 'range' && (num < activeRange[0] || num > activeRange[1])) {
          visible = false;
        }

        if (visible && searchTerm && !numStr.includes(searchTerm)) {
          visible = false;
        }

        btn.classList.toggle('tt-hidden', !visible);
      });
    };

    toolbar.querySelectorAll('.tt-btn').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.classList.contains('active')));
      btn.addEventListener('click', () => {
        toolbar.querySelectorAll('.tt-btn').forEach((b) => { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
        btn.classList.add('active');
        btn.setAttribute('aria-pressed', 'true');
        if (btn.dataset.filter) {
          activeMode = btn.dataset.filter;
        } else if (btn.dataset.range) {
          activeMode = 'range';
          const parts = btn.dataset.range.split('-').map(Number);
          activeRange = [parts[0], parts[1]];
        }
        applyFilter();
      });
    });

    const searchInput = document.getElementById('ticket-search');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        searchTerm = searchInput.value.trim();
        applyFilter();
      });
    }

    const randomBtn = document.getElementById('btn-random-ticket');
    if (randomBtn) {
      randomBtn.addEventListener('click', () => {
        const freeBtns = Array.from(ticketsGrid.querySelectorAll('.tk.free:not(:disabled)'));
        if (!freeBtns.length) return;
        const pick = freeBtns[Math.floor(Math.random() * freeBtns.length)];
        const numEl = pick.querySelector('.n');
        if (numEl && typeof window.selectTicket === 'function') {
          window.selectTicket(numEl.textContent.trim());
        } else {
          pick.click();
        }
      });
    }

    const observer = new MutationObserver(() => applyFilter());
    observer.observe(ticketsGrid, { childList: true });
  }
})();
