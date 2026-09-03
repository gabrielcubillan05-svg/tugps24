document.addEventListener('DOMContentLoaded', function () {
  const suspensionesList = document.getElementById('suspensionesList');
  if (!suspensionesList) return; // no autenticado o sin permiso

  const suspensionesData = document.getElementById('suspensionesData');
  const currentRole = (suspensionesData && suspensionesData.dataset.role) || '';
  const isOverrideRole = currentRole === 'admin' || currentRole === 'supervisor';
  let currentUserId = '';

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function fmtDate(iso) {
    return new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });
  }

  function fmtHours(hours) {
    if (hours < 1) return Math.round(hours * 60) + ' min';
    if (hours < 48) return Math.round(hours) + ' h';
    return Math.round(hours / 24) + ' días';
  }

  function statusClass(status) {
    return 'status-' + String(status || '').replace(/\s+/g, '-');
  }

  const OPEN_STATUSES = ['Nuevo', 'En revisión', 'Escalado a Josué', 'En tesorería'];

  function loadAssignees() {
    fetch('/api/users?role=gerente,secretaria')
      .then((res) => res.json())
      .then((data) => {
        const select = document.getElementById('assignTo');
        if (!data || !Array.isArray(data.users)) return;
        const users = data.users.slice().sort((a, b) => a.name.localeCompare(b.name));
        select.innerHTML = '<option value="">Selecciona una persona</option>' +
          users.map((u) => `<option value="${escapeHtml(u.id)}">${escapeHtml(u.name)}${u.role === 'gerente' ? ' (Gerente)' : ' (Secretaria)'}</option>`).join('');
      })
      .catch(() => {});
  }

  function renderStats(stats) {
    const statsRow = document.getElementById('statsRow');
    statsRow.innerHTML = `
      <div class="stat-box"><span class="n">${stats.total}</span><span class="l">Total</span></div>
      <div class="stat-box overdue"><span class="n">${stats.openCount}</span><span class="l">Abiertos</span></div>
      <div class="stat-box"><span class="n">${stats.resolvedCount}</span><span class="l">Resueltos</span></div>
      <div class="stat-box overdue"><span class="n">${stats.suspendedCount}</span><span class="l">Suspendidos</span></div>
      <div class="stat-box"><span class="n">${stats.resolutionRate !== null ? stats.resolutionRate + '%' : '—'}</span><span class="l">Tasa de retención</span></div>
      <div class="stat-box"><span class="n">${stats.avgResolutionHours !== null ? fmtHours(stats.avgResolutionHours) : '—'}</span><span class="l">Tiempo prom. de cierre</span></div>
    `;
  }

  function actionsFor(c) {
    const isAssignee = c.assignedToId === currentUserId;
    if (!isAssignee && !isOverrideRole) return '';
    if (!OPEN_STATUSES.includes(c.status)) return '';

    const buttons = [];
    if (c.status === 'Nuevo' || c.status === 'En revisión') {
      buttons.push(`<button class="btn-small" data-action="escalate" data-id="${c.id}" type="button">Escalar a Josué</button>`);
    }
    if (c.status === 'Escalado a Josué') {
      buttons.push(`<button class="btn-small" data-action="sendToTesoreria" data-id="${c.id}" type="button">Pasar a tesorería</button>`);
      buttons.push(`<button class="btn-small" data-action="returnToBranch" data-id="${c.id}" type="button">Devolver a sucursal</button>`);
    }
    if (c.status === 'En tesorería') {
      buttons.push(`<button class="btn-small" data-action="returnToBranch" data-id="${c.id}" type="button">Devolver a sucursal</button>`);
    }
    buttons.push(`<button class="btn-small btn-done" data-action="resolve" data-id="${c.id}" type="button">Resolver (cliente se queda)</button>`);
    buttons.push(`<button class="btn-small btn-delete" data-action="suspend" data-id="${c.id}" type="button">Suspender (sin solución)</button>`);
    return buttons.join('');
  }

  function renderList(casos) {
    if (!casos.length) {
      suspensionesList.innerHTML = '<div class="empty">No hay casos con esos filtros.</div>';
      return;
    }
    suspensionesList.innerHTML = casos.map((c) => `
      <div class="suspension-item ${!OPEN_STATUSES.includes(c.status) ? 'closed' : ''}" data-id="${c.id}">
        <div class="suspension-top">
          <span class="suspension-client">${escapeHtml(c.clientName)} · ${escapeHtml(c.branch)}</span>
          <span class="badge ${statusClass(c.status)}">${escapeHtml(c.status)}</span>
        </div>
        <p class="suspension-reason">${escapeHtml(c.reason)}</p>
        <div class="suspension-meta">
          Asignado a ${escapeHtml(c.assignedToName)} · Creado por ${escapeHtml(c.createdByName)} el ${fmtDate(c.createdAt)}
          ${c.clientPhone ? ` · Tel: ${escapeHtml(c.clientPhone)}` : ''}
        </div>
        ${c.timeline && c.timeline.length ? `
          <div class="suspension-timeline">
            ${c.timeline.map((t) => `<div class="timeline-item"><span class="timeline-date">${fmtDate(t.date)} · ${escapeHtml(t.authorName)}</span>${escapeHtml(t.message)}</div>`).join('')}
          </div>
        ` : ''}
        <div class="suspension-actions">${actionsFor(c)}</div>
        ${OPEN_STATUSES.includes(c.status) && (c.assignedToId === currentUserId || isOverrideRole || c.createdById === currentUserId) ? `
          <div class="suspension-add-note-row">
            <input type="text" placeholder="Agregar nota de seguimiento..." data-note-input data-id="${c.id}" />
            <button class="btn-small" data-action="addNote" data-id="${c.id}" type="button">Agregar</button>
          </div>
        ` : ''}
      </div>
    `).join('');
  }

  let allCasos = [];
  let currentTab = '';

  function loadSuspensiones() {
    const params = new URLSearchParams();
    if (searchInput.value.trim()) params.set('q', searchInput.value.trim());
    if (branchFilter.value) params.set('branch', branchFilter.value);
    if (currentTab) params.set('status', currentTab);

    fetch('/api/suspensiones?' + params.toString())
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (data && Array.isArray(data.casos)) {
          currentUserId = data.currentUserId || '';
          allCasos = data.casos;
          renderStats(data.stats);
          renderList(allCasos);
        } else {
          suspensionesList.innerHTML = `<div class="empty">No se pudo cargar${data && data.error ? ': ' + escapeHtml(data.error) : ' (revisa la conexión)'}.</div>`;
        }
      })
      .catch((err) => {
        suspensionesList.innerHTML = `<div class="empty">No se pudo cargar: ${escapeHtml(err.message || 'error de red')}.</div>`;
      });
  }

  const searchInput = document.getElementById('searchInput');
  const branchFilter = document.getElementById('branchFilter');
  const tabButtons = document.querySelectorAll('.tab-btn[data-status]');

  let debounceTimer;
  searchInput.addEventListener('input', function () {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(loadSuspensiones, 250);
  });
  branchFilter.addEventListener('change', loadSuspensiones);
  tabButtons.forEach((btn) => {
    btn.addEventListener('click', function () {
      tabButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentTab = btn.getAttribute('data-status') || '';
      loadSuspensiones();
    });
  });

  suspensionesList.addEventListener('click', function (e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    const id = btn.getAttribute('data-id');

    if (action === 'addNote') {
      const input = suspensionesList.querySelector(`input[data-note-input][data-id="${id}"]`);
      const note = input ? input.value.trim() : '';
      if (!note) return;
      fetch('/api/suspensiones', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action, note }),
      }).then(loadSuspensiones);
      return;
    }

    if (action === 'suspend' && !confirm('¿Confirmas que no se encontró solución y el cliente se suspende?')) return;

    let note = '';
    if (action === 'escalate' || action === 'sendToTesoreria' || action === 'returnToBranch' || action === 'resolve' || action === 'suspend') {
      note = prompt('Nota (opcional) sobre esta acción:') || '';
    }

    fetch('/api/suspensiones', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action, note }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo actualizar el caso.');
        loadSuspensiones();
      })
      .catch((err) => alert(err.message || 'No se pudo actualizar el caso.'));
  });

  const suspensionForm = document.getElementById('suspensionForm');
  suspensionForm.addEventListener('submit', function (e) {
    e.preventDefault();
    const clientName = document.getElementById('clientName').value.trim();
    const clientPhone = document.getElementById('clientPhone').value.trim();
    const branch = document.getElementById('branch').value;
    const assignToId = document.getElementById('assignTo').value;
    const reason = document.getElementById('reason').value.trim();
    if (!clientName || !branch || !assignToId || !reason) return;

    const submitBtn = suspensionForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    fetch('/api/suspensiones', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientName, clientPhone, branch, assignToId, reason }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo guardar el caso.');
        suspensionForm.reset();
        loadSuspensiones();
      })
      .catch((err) => alert(err.message || 'No se pudo guardar el caso.'))
      .finally(() => { submitBtn.disabled = false; });
  });

  loadAssignees();
  loadSuspensiones();
});
