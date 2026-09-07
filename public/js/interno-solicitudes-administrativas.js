document.addEventListener('DOMContentLoaded', function () {
  const solicitudesList = document.getElementById('solicitudesList');
  if (!solicitudesList) return; // no autenticado o sin permiso

  const OPEN_STATUSES = ['Pendiente'];
  let currentUserId = '';
  let isKellyOrWilmar = false;
  let allSolicitudes = [];
  let currentTab = '';

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

  function statusClass(status) {
    return 'status-' + String(status || '').replace(/\s+/g, '-');
  }

  const MONTH_NAMES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  function monthLabel(ym) {
    const [y, m] = ym.split('-');
    const name = MONTH_NAMES[parseInt(m, 10) - 1] || ym;
    return name.charAt(0).toUpperCase() + name.slice(1) + ' ' + y;
  }

  function renderStats(stats) {
    const statsRow = document.getElementById('statsRow');
    statsRow.innerHTML = `
      <div class="stat-box"><span class="n">${stats.total}</span><span class="l">Total</span></div>
      <div class="stat-box overdue"><span class="n">${stats.byStatus['Pendiente'] || 0}</span><span class="l">Pendientes</span></div>
      <div class="stat-box"><span class="n">${stats.byStatus['Completada'] || 0}</span><span class="l">Completadas</span></div>
      <div class="stat-box overdue"><span class="n">${stats.byStatus['No completada'] || 0}</span><span class="l">No completadas</span></div>
      <div class="stat-box"><span class="n">${stats.reactivacionesTotal}</span><span class="l">Reactivaciones totales</span></div>
    `;

    const typeStats = document.getElementById('typeStats');
    const rows = Object.entries(stats.byType)
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => `
        <div class="type-stats-row"><span>${escapeHtml(type)}</span><span class="n">${count}</span></div>
      `).join('');
    typeStats.innerHTML = rows;
  }

  function actionsFor(s) {
    const parts = [];
    if (s.status === 'Pendiente' && isKellyOrWilmar) {
      parts.push(`<button class="btn-small btn-done" data-action="complete" data-id="${s.id}" type="button">Completada</button>`);
      parts.push(`<button class="btn-small btn-delete" data-action="notCompleted" data-id="${s.id}" type="button">No completada</button>`);
    }
    if (s.status !== 'Pendiente' && isKellyOrWilmar) {
      parts.push(`<button class="btn-small" data-action="reopen" data-id="${s.id}" type="button">Reabrir</button>`);
    }
    return parts.join('');
  }

  function renderList(items) {
    if (!items.length) {
      solicitudesList.innerHTML = '<div class="empty">No hay solicitudes con esos filtros.</div>';
      return;
    }
    solicitudesList.innerHTML = items.map((s) => `
      <div class="solicitud-item ${s.status !== 'Pendiente' ? 'closed' : ''}" data-id="${s.id}">
        <div class="solicitud-top">
          <span class="solicitud-client">${escapeHtml(s.clientName)}</span>
          <span class="badge ${statusClass(s.status)}">${escapeHtml(s.status)}</span>
        </div>
        <p class="solicitud-type">${escapeHtml(s.requestType)}</p>
        ${s.description ? `<p class="solicitud-description">${escapeHtml(s.description)}</p>` : ''}
        <div class="solicitud-meta">
          Creado por ${escapeHtml(s.createdByName)} el ${fmtDate(s.createdAt)}
          ${s.dueDate ? ` · Vence: ${escapeHtml(s.dueDate)}` : ''}
          ${s.resolvedAt ? ` · Resuelto por ${escapeHtml(s.resolvedByName)} el ${fmtDate(s.resolvedAt)}` : ''}
        </div>
        ${s.timeline && s.timeline.length ? `
          <div class="solicitud-timeline">
            ${s.timeline.map((t) => `<div class="timeline-item"><span class="timeline-date">${fmtDate(t.date)} · ${escapeHtml(t.authorName)}</span>${escapeHtml(t.message)}</div>`).join('')}
          </div>
        ` : ''}
        <div class="solicitud-actions">${actionsFor(s)}</div>
        <div class="solicitud-add-note-row">
          <input type="text" placeholder="Agregar nota de seguimiento..." data-note-input data-id="${s.id}" />
          <button class="btn-small" data-action="addNote" data-id="${s.id}" type="button">Agregar</button>
        </div>
      </div>
    `).join('');
  }

  function loadSolicitudes() {
    const params = new URLSearchParams();
    if (searchInput.value.trim()) params.set('q', searchInput.value.trim());
    if (typeFilter.value) params.set('requestType', typeFilter.value);
    if (currentTab) params.set('status', currentTab);
    if (monthFilter.value) params.set('month', monthFilter.value);

    fetch('/api/solicitudes-administrativas?' + params.toString())
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (data && Array.isArray(data.solicitudes)) {
          currentUserId = data.currentUserId || '';
          isKellyOrWilmar = Boolean(data.isKellyOrWilmar);
          allSolicitudes = data.solicitudes;
          renderStats(data.stats);
          renderList(allSolicitudes);
          populateMonths();
        } else {
          solicitudesList.innerHTML = `<div class="empty">No se pudo cargar${data && data.error ? ': ' + escapeHtml(data.error) : ' (revisa la conexión)'}.</div>`;
        }
      })
      .catch((err) => {
        solicitudesList.innerHTML = `<div class="empty">No se pudo cargar: ${escapeHtml(err.message || 'error de red')}.</div>`;
      });
  }

  function populateMonths() {
    const months = [...new Set(allSolicitudes.map((s) => (s.createdAt || '').slice(0, 7)).filter(Boolean))].sort().reverse();
    const current = monthFilter.value;
    monthFilter.innerHTML = '<option value="">Todos los meses</option>' +
      months.map((m) => `<option value="${m}">${escapeHtml(monthLabel(m))}</option>`).join('');
    monthFilter.value = current;
  }

  const searchInput = document.getElementById('searchInput');
  const typeFilter = document.getElementById('typeFilter');
  const monthFilter = document.getElementById('monthFilter');
  const tabButtons = document.querySelectorAll('.tab-btn[data-status]');

  let debounceTimer;
  searchInput.addEventListener('input', function () {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(loadSolicitudes, 250);
  });
  typeFilter.addEventListener('change', loadSolicitudes);
  monthFilter.addEventListener('change', loadSolicitudes);
  tabButtons.forEach((btn) => {
    btn.addEventListener('click', function () {
      tabButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentTab = btn.getAttribute('data-status') || '';
      loadSolicitudes();
    });
  });

  solicitudesList.addEventListener('click', function (e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    const id = btn.getAttribute('data-id');

    if (action === 'addNote') {
      const input = solicitudesList.querySelector(`input[data-note-input][data-id="${id}"]`);
      const note = input ? input.value.trim() : '';
      if (!note) return;
      fetch('/api/solicitudes-administrativas', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action, note }),
      }).then(loadSolicitudes);
      return;
    }

    const body = { id, action };
    if (action === 'notCompleted' && !confirm('¿Confirmas que esta solicitud no se pudo completar?')) return;
    if (action === 'complete' || action === 'notCompleted' || action === 'reopen') {
      body.note = prompt('Nota (opcional) sobre esta acción:') || '';
    }

    fetch('/api/solicitudes-administrativas', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo actualizar la solicitud.');
        loadSolicitudes();
      })
      .catch((err) => alert(err.message || 'No se pudo actualizar la solicitud.'));
  });

  const solicitudForm = document.getElementById('solicitudForm');
  solicitudForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    const clientName = document.getElementById('clientName').value.trim();
    const requestType = document.getElementById('requestType').value;
    const dueDate = document.getElementById('dueDate').value;
    const description = document.getElementById('description').value.trim();
    if (!clientName || !requestType) return;

    const submitBtn = solicitudForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    const originalLabel = submitBtn.textContent;

    try {
      submitBtn.textContent = 'Guardando...';
      const res = await fetch('/api/solicitudes-administrativas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientName, requestType, dueDate, description }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `error ${res.status}`);
      }
      solicitudForm.reset();
      loadSolicitudes();
    } catch (err) {
      alert('No se pudo guardar la solicitud: ' + (err.message || 'intenta de nuevo.'));
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  });

  loadSolicitudes();
});
