document.addEventListener('DOMContentLoaded', function () {
  const clientesList = document.getElementById('clientesList');
  if (!clientesList) return; // no autenticado o sin permiso

  let allClientes = [];

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function fmtDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });
  }

  function fmtMoney(n) {
    return '$' + Number(n || 0).toLocaleString('es-CO');
  }

  function renderStats(stats) {
    const statsRow = document.getElementById('statsRow');
    statsRow.innerHTML = `
      <div class="stat-box"><span class="n">${stats.total}</span><span class="l">Clientes masivos</span></div>
      <div class="stat-box"><span class="n">${stats.totalVehicles}</span><span class="l">Vehículos en total</span></div>
      <div class="stat-box"><span class="n">${fmtMoney(stats.totalMonthlyRevenue)}</span><span class="l">Recaudo mensual total</span></div>
    `;
  }

  function renderList(clientes) {
    if (!clientes.length) {
      clientesList.innerHTML = '<div class="empty">No hay clientes masivos con esos filtros.</div>';
      return;
    }
    clientesList.innerHTML = clientes.map((c) => `
      <div class="cliente-item" data-id="${c.id}">
        <div class="cliente-top">
          <span class="cliente-name">${escapeHtml(c.clientName)}</span>
          <span class="badge">${escapeHtml(c.phone)}</span>
        </div>
        <div class="cliente-meta">
          ${c.branch ? 'Sucursal: ' + escapeHtml(c.branch) + ' · ' : ''}
          Registrado por ${escapeHtml(c.createdByName)} el ${fmtDate(c.createdAt)}
        </div>
        <div class="cliente-edit-row">
          <div class="field">
            <label>Vehículos actuales</label>
            <input type="number" min="0" data-action="vehicleCount" data-id="${c.id}" value="${c.vehicleCount || 0}" />
          </div>
          <div class="field">
            <label>Recaudo mensual (COP)</label>
            <input type="number" min="0" data-action="monthlyRevenue" data-id="${c.id}" value="${c.monthlyRevenue || 0}" />
          </div>
        </div>
        ${c.timeline && c.timeline.length ? `
          <div class="cliente-timeline">
            ${c.timeline.slice().reverse().map((t) => `<div class="timeline-item"><span class="timeline-date">${fmtDate(t.date)} · ${escapeHtml(t.authorName)}</span>${escapeHtml(t.message)}</div>`).join('')}
          </div>
        ` : ''}
        <div class="cliente-add-note-row">
          <input type="text" placeholder="Resumen de lo hablado con el cliente..." data-note-input data-id="${c.id}" />
          <button class="btn-small" data-action="addNote" data-id="${c.id}" type="button">Agregar</button>
        </div>
      </div>
    `).join('');
  }

  function loadClientes() {
    const params = new URLSearchParams();
    if (searchInput.value.trim()) params.set('q', searchInput.value.trim());
    if (branchFilter.value) params.set('branch', branchFilter.value);

    fetch('/api/seguimiento-masivos?' + params.toString())
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (data && Array.isArray(data.clientes)) {
          allClientes = data.clientes;
          renderStats(data.stats);
          renderList(allClientes);
        } else {
          clientesList.innerHTML = `<div class="empty">No se pudo cargar${data && data.error ? ': ' + escapeHtml(data.error) : ' (revisa la conexión)'}.</div>`;
        }
      })
      .catch((err) => {
        clientesList.innerHTML = `<div class="empty">No se pudo cargar: ${escapeHtml(err.message || 'error de red')}.</div>`;
      });
  }

  const searchInput = document.getElementById('searchInput');
  const branchFilter = document.getElementById('branchFilter');

  let debounceTimer;
  searchInput.addEventListener('input', function () {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(loadClientes, 250);
  });
  branchFilter.addEventListener('change', loadClientes);

  clientesList.addEventListener('click', function (e) {
    const btn = e.target.closest('button[data-action="addNote"]');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    const input = clientesList.querySelector(`input[data-note-input][data-id="${id}"]`);
    const note = input ? input.value.trim() : '';
    if (!note) return;
    fetch('/api/seguimiento-masivos', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, addNote: note }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo agregar el seguimiento.');
        loadClientes();
      })
      .catch((err) => alert(err.message || 'No se pudo agregar el seguimiento.'));
  });

  clientesList.addEventListener('change', function (e) {
    const input = e.target.closest('input[data-action="vehicleCount"], input[data-action="monthlyRevenue"]');
    if (!input) return;
    const id = input.getAttribute('data-id');
    const action = input.getAttribute('data-action');
    const value = Math.max(0, parseInt(input.value, 10) || 0);
    fetch('/api/seguimiento-masivos', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, [action]: value }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo actualizar.');
        loadClientes();
      })
      .catch((err) => alert(err.message || 'No se pudo actualizar.'));
  });

  const clienteForm = document.getElementById('clienteForm');
  clienteForm.addEventListener('submit', function (e) {
    e.preventDefault();
    const clientName = document.getElementById('clientName').value.trim();
    const phone = document.getElementById('phone').value.trim();
    const branch = document.getElementById('branch').value;
    const vehicleCount = document.getElementById('vehicleCount').value;
    const monthlyRevenue = document.getElementById('monthlyRevenue').value;
    const initialNote = document.getElementById('initialNote').value.trim();
    if (!clientName || !phone) return;

    const submitBtn = clienteForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    fetch('/api/seguimiento-masivos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientName, phone, branch, vehicleCount, monthlyRevenue, initialNote }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo guardar el cliente.');
        clienteForm.reset();
        loadClientes();
      })
      .catch((err) => alert('No se pudo guardar el cliente: ' + (err.message || 'intenta de nuevo.')))
      .finally(() => { submitBtn.disabled = false; });
  });

  loadClientes();
});
