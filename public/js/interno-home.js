document.addEventListener('DOMContentLoaded', function () {
  const slot = document.getElementById('homeGabotSlot');
  const pendientesEl = document.getElementById('homePendientes');

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // El chat de GPSITO es el mismo widget flotante de siempre (misma lógica, mismos mensajes) —
  // aquí solo se reubica dentro de la página y se agranda por CSS (.home-embedded, ver
  // InternoLayout.astro), en vez de duplicar la lógica del chat.
  if (slot) {
    const widget = document.getElementById('gabotWidget');
    if (widget) {
      widget.classList.add('home-embedded');
      slot.appendChild(widget);
      const panel = document.getElementById('gabotPanel');
      if (panel) panel.style.display = 'flex';
    }
  }

  if (pendientesEl) {
    fetch('/api/my-pendientes')
      .then((res) => res.json())
      .then((data) => {
        if (!data || !Array.isArray(data.lines) || !data.lines.length) {
          pendientesEl.innerHTML = '<div class="empty">Sin pendientes — todo al día.</div>';
          return;
        }
        pendientesEl.innerHTML = `<pre style="white-space:pre-wrap; font-family:inherit; margin:0; font-size:13.5px;">${escapeHtml(data.lines.join('\n'))}</pre>`;
      })
      .catch(() => {
        pendientesEl.innerHTML = '<div class="empty">No se pudo cargar.</div>';
      });
  }
});
