document.addEventListener('DOMContentLoaded', function () {
  const cuadrantesList = document.getElementById('cuadrantesList');
  if (!cuadrantesList) return; // no autenticado o sin permiso

  const cuadrantesData = document.getElementById('cuadrantesData');
  const canDelete = !!(cuadrantesData && cuadrantesData.dataset.canDelete);

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function fmtDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('es-CO', { dateStyle: 'short' });
  }

  const cuadranteForm = document.getElementById('cuadranteForm');
  const searchInput = document.getElementById('searchInput');
  const ciudadFilter = document.getElementById('ciudadFilter');

  let allCuadrantes = [];

  function populateCiudadFilter() {
    const current = ciudadFilter.value;
    const ciudades = [...new Set(allCuadrantes.map((c) => c.ciudad).filter(Boolean))].sort();
    ciudadFilter.innerHTML = '<option value="">Todas las ciudades</option>' +
      ciudades.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    ciudadFilter.value = current;
  }

  function getFiltered() {
    const q = searchInput.value.trim().toLowerCase();
    const ciudad = ciudadFilter.value;
    return allCuadrantes.filter((c) => {
      if (ciudad && c.ciudad !== ciudad) return false;
      if (q && !(
        c.ciudad.toLowerCase().includes(q) ||
        c.numero.toLowerCase().includes(q) ||
        (c.nota || '').toLowerCase().includes(q)
      )) return false;
      return true;
    });
  }

  function renderList() {
    const filtered = getFiltered();
    if (!filtered.length) {
      cuadrantesList.innerHTML = '<div class="empty">No hay cuadrantes con esos filtros.</div>';
      return;
    }
    cuadrantesList.innerHTML = filtered.map((c) => `
      <div class="cuadrante-item" data-id="${c.id}">
        <div class="cuadrante-main">
          <span class="cuadrante-title">${escapeHtml(c.ciudad)} — ${escapeHtml(c.numero)}</span>
          <span class="cuadrante-meta">${c.telefono ? escapeHtml(c.telefono) : 'Sin teléfono'}${c.nota ? ' · ' + escapeHtml(c.nota) : ''} · Agregado por ${escapeHtml(c.createdByName)} el ${fmtDate(c.createdAt)}</span>
        </div>
        <div class="cuadrante-actions">
          ${c.telefono ? `<a class="btn-small" href="tel:${escapeHtml(c.telefono.replace(/\D/g, ''))}">Llamar</a>` : ''}
          ${canDelete ? `<button class="btn-small btn-delete" data-action="delete" data-id="${c.id}" type="button">Eliminar</button>` : ''}
        </div>
      </div>
    `).join('');
  }

  function loadCuadrantes() {
    fetch('/api/cuadrantes')
      .then((res) => res.json())
      .then((data) => {
        if (!data || !Array.isArray(data.cuadrantes)) {
          cuadrantesList.innerHTML = '<div class="empty">No se pudo cargar (revisa la conexión).</div>';
          return;
        }
        allCuadrantes = data.cuadrantes;
        populateCiudadFilter();
        renderList();
      })
      .catch(() => {
        cuadrantesList.innerHTML = '<div class="empty">No se pudo cargar (revisa la conexión).</div>';
      });
  }

  searchInput.addEventListener('input', renderList);
  ciudadFilter.addEventListener('change', renderList);

  cuadranteForm.addEventListener('submit', function (e) {
    e.preventDefault();
    const ciudad = document.getElementById('ciudad').value;
    const numero = document.getElementById('numero').value.trim();
    const telefono = document.getElementById('telefono').value.trim();
    const nota = document.getElementById('nota').value.trim();
    if (!ciudad || !numero) return;

    const submitBtn = cuadranteForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    fetch('/api/cuadrantes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ciudad, numero, telefono, nota }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo guardar.');
        cuadranteForm.reset();
        loadCuadrantes();
      })
      .catch((err) => alert(err.message || 'No se pudo guardar.'))
      .finally(() => { submitBtn.disabled = false; });
  });

  cuadrantesList.addEventListener('click', function (e) {
    const btn = e.target.closest('button[data-action="delete"]');
    if (!btn) return;
    if (!confirm('¿Eliminar este cuadrante?')) return;
    const id = btn.getAttribute('data-id');
    fetch('/api/cuadrantes', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }).then(loadCuadrantes);
  });

  loadCuadrantes();
});
