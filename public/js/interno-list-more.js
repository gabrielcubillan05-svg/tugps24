// Aviso "Mostrando las N más recientes de M · Mostrar más" debajo de una lista que el servidor
// recortó (ver src/lib/list-page.ts). Se comparte entre las pantallas de listas largas.
window.TuGpsListMore = {
  apply: function (listEl, data, onMore) {
    if (!listEl) return;
    var id = listEl.id + 'More';
    var el = document.getElementById(id);
    if (!data || !data.truncated) {
      if (el) el.remove();
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.className = 'empty';
      el.style.padding = '12px';
      listEl.insertAdjacentElement('afterend', el);
    }
    var shown = Array.isArray(data.items) ? data.items.length : data.shown || 0;
    el.innerHTML = 'Mostrando los ' + shown.toLocaleString('es-CO') + ' más relevantes de ' + Number(data.total || 0).toLocaleString('es-CO') + '. ';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-small';
    btn.textContent = 'Mostrar más';
    btn.addEventListener('click', function () {
      btn.disabled = true;
      btn.textContent = 'Cargando...';
      onMore((data.limit || 300) + 500);
    });
    el.appendChild(btn);
  },
};
