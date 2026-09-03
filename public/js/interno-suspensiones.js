document.addEventListener('DOMContentLoaded', function () {
  const suspensionesList = document.getElementById('suspensionesList');
  if (!suspensionesList) return; // no autenticado o sin permiso

  const suspensionesData = document.getElementById('suspensionesData');
  const currentRole = (suspensionesData && suspensionesData.dataset.role) || '';
  const isOverrideRole = currentRole === 'admin' || currentRole === 'supervisor';
  let currentUserId = '';
  let isJosue = false;
  let isTesoreria = false;

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

  function compressImage(file, maxDim, quality) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const reader = new FileReader();
      reader.onload = () => { img.src = reader.result; };
      reader.onerror = reject;
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error('No se pudo comprimir la imagen'));
        }, 'image/jpeg', quality);
      };
      img.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  const OPEN_STATUSES = ['Nuevo', 'En revisión', 'Escalado a Josué'];

  let branchAssignees = [];
  let anyUsers = [];

  function loadAssignees() {
    fetch('/api/users?role=gerente,secretaria')
      .then((res) => res.json())
      .then((data) => {
        const select = document.getElementById('assignTo');
        if (!data || !Array.isArray(data.users)) return;
        branchAssignees = data.users.slice().sort((a, b) => a.name.localeCompare(b.name));
        select.innerHTML = '<option value="">Selecciona una persona</option>' +
          branchAssignees.map((u) => `<option value="${escapeHtml(u.id)}">${escapeHtml(u.name)}${u.role === 'gerente' ? ' (Gerente)' : ' (Secretaria)'}</option>`).join('');
      })
      .catch(() => {});
  }

  function loadAnyUsers() {
    fetch('/api/users?any=1')
      .then((res) => res.json())
      .then((data) => {
        if (!data || !Array.isArray(data.users)) return;
        anyUsers = data.users.slice().sort((a, b) => a.name.localeCompare(b.name));
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
      <div class="stat-box overdue"><span class="n">${stats.pendingFinalizacion}</span><span class="l">Por finalizar (tesorería)</span></div>
      <div class="stat-box"><span class="n">${stats.finalizedCount}</span><span class="l">Finalizados</span></div>
    `;
  }

  function userOptions(list) {
    return list.map((u) => `<option value="${escapeHtml(u.id)}">${escapeHtml(u.name)}</option>`).join('');
  }

  function actionsFor(c) {
    const isAssignee = c.assignedToId === currentUserId;
    const canJosueReassign = (isJosue || isOverrideRole) && OPEN_STATUSES.includes(c.status);
    const canFinalize = (isTesoreria || isOverrideRole) && !c.finalized && (c.status === 'Resuelto' || c.status === 'Suspendido');

    const parts = [];

    if ((isAssignee || isOverrideRole || isJosue) && (c.status === 'Nuevo' || c.status === 'En revisión')) {
      parts.push(`<button class="btn-small" data-action="escalate" data-id="${c.id}" type="button">Escalar a Josué</button>`);
    }

    if ((isAssignee || isOverrideRole) && OPEN_STATUSES.includes(c.status)) {
      parts.push(`<button class="btn-small btn-done" data-action="resolve" data-id="${c.id}" type="button">Resolver (cliente se queda)</button>`);
      parts.push(`<button class="btn-small btn-delete" data-action="suspend" data-id="${c.id}" type="button">Suspender (sin solución)</button>`);
    }

    if (canJosueReassign) {
      parts.push(`
        <span class="suspension-reassign">
          <select data-reassign="any" data-id="${c.id}"><option value="">Asignación especial a...</option>${userOptions(anyUsers)}</select>
          <button class="btn-small" data-action="reassign" data-id="${c.id}" type="button">Asignar</button>
        </span>
      `);
    }

    if (canFinalize) {
      parts.push(`<button class="btn-small btn-done" data-action="finalize" data-id="${c.id}" type="button">Caso finalizado</button>`);
    }

    return parts.join('');
  }

  function renderList(casos) {
    if (!casos.length) {
      suspensionesList.innerHTML = '<div class="empty">No hay casos con esos filtros.</div>';
      return;
    }
    suspensionesList.innerHTML = casos.map((c) => `
      <div class="suspension-item ${!OPEN_STATUSES.includes(c.status) ? 'closed' : ''}" data-id="${c.id}">
        <div class="suspension-top">
          <span class="suspension-client">${c.clientName ? escapeHtml(c.clientName) : 'Cliente sin nombre'}${c.plate ? ' · ' + escapeHtml(c.plate) : ''} · ${escapeHtml(c.branch)}</span>
          <span class="badge ${statusClass(c.status)}">${escapeHtml(c.status)}</span>
        </div>
        <p class="suspension-reason">${escapeHtml(c.reason)}</p>
        ${c.requestPhotoUrl ? `
          <div class="suspension-photo">
            <a href="${c.requestPhotoUrl}" target="_blank" rel="noopener"><img src="${c.requestPhotoUrl}" alt="Solicitud del cliente" loading="lazy" /></a>
          </div>
        ` : ''}
        ${!c.finalized && (c.assignedToId === currentUserId || isOverrideRole) ? `
          <div class="suspension-complete-info">
            <span class="hint-label">Completar información del cliente</span>
            <input type="text" data-complete-name data-id="${c.id}" value="${escapeHtml(c.clientName)}" placeholder="Nombre del cliente" />
            <input type="file" accept="image/*" data-complete-photo data-id="${c.id}" />
            <span class="complete-photo-preview" data-complete-preview data-id="${c.id}"></span>
            <button class="btn-small" data-action="updateInfo" data-id="${c.id}" type="button">Guardar información</button>
          </div>
        ` : ''}
        <div class="suspension-meta">
          Asignado a ${escapeHtml(c.assignedToName)} · Creado por ${escapeHtml(c.createdByName)} el ${fmtDate(c.createdAt)}
          ${c.clientPhone ? ` · Tel: ${escapeHtml(c.clientPhone)}` : ''}
          ${c.finalized ? ` · Finalizado por ${escapeHtml(c.finalizedByName)} el ${fmtDate(c.finalizedAt)}` : ''}
        </div>
        ${c.timeline && c.timeline.length ? `
          <div class="suspension-timeline">
            ${c.timeline.map((t) => `<div class="timeline-item"><span class="timeline-date">${fmtDate(t.date)} · ${escapeHtml(t.authorName)}</span>${escapeHtml(t.message)}</div>`).join('')}
          </div>
        ` : ''}
        <div class="suspension-actions">${actionsFor(c)}</div>
        ${!c.finalized && (c.assignedToId === currentUserId || isOverrideRole || c.createdById === currentUserId) ? `
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
  const pendingInfoPhotos = {};

  suspensionesList.addEventListener('change', function (e) {
    const input = e.target.closest('input[data-complete-photo]');
    if (!input) return;
    const id = input.getAttribute('data-id');
    const file = input.files && input.files[0];
    if (!file) return;
    if (pendingInfoPhotos[id]) URL.revokeObjectURL(pendingInfoPhotos[id].url);
    pendingInfoPhotos[id] = { file, url: URL.createObjectURL(file) };
    const preview = suspensionesList.querySelector(`[data-complete-preview][data-id="${id}"]`);
    if (preview) preview.innerHTML = `<img src="${pendingInfoPhotos[id].url}" alt="Previsualización" />`;
    input.value = '';
  });

  function loadSuspensiones() {
    const params = new URLSearchParams();
    if (searchInput.value.trim()) params.set('q', searchInput.value.trim());
    if (branchFilter.value) params.set('branch', branchFilter.value);
    if (currentTab) params.set('status', currentTab);
    if (dateFromFilter.value) params.set('dateFrom', dateFromFilter.value);
    if (dateToFilter.value) params.set('dateTo', dateToFilter.value);

    fetch('/api/suspensiones?' + params.toString())
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (data && Array.isArray(data.casos)) {
          currentUserId = data.currentUserId || '';
          isJosue = Boolean(data.isJosue);
          isTesoreria = Boolean(data.isTesoreria);
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
  const dateFromFilter = document.getElementById('dateFromFilter');
  const dateToFilter = document.getElementById('dateToFilter');
  const tabButtons = document.querySelectorAll('.tab-btn[data-status]');

  let debounceTimer;
  searchInput.addEventListener('input', function () {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(loadSuspensiones, 250);
  });
  branchFilter.addEventListener('change', loadSuspensiones);
  dateFromFilter.addEventListener('change', loadSuspensiones);
  dateToFilter.addEventListener('change', loadSuspensiones);
  tabButtons.forEach((btn) => {
    btn.addEventListener('click', function () {
      tabButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentTab = btn.getAttribute('data-status') || '';
      loadSuspensiones();
    });
  });

  suspensionesList.addEventListener('click', async function (e) {
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

    if (action === 'updateInfo') {
      const nameInput = suspensionesList.querySelector(`input[data-complete-name][data-id="${id}"]`);
      const clientName = nameInput ? nameInput.value.trim() : '';
      const pending = pendingInfoPhotos[id];
      btn.disabled = true;
      try {
        const formData = new FormData();
        formData.set('id', id);
        formData.set('action', action);
        formData.set('clientName', clientName);
        if (pending) {
          const compressed = await compressImage(pending.file, 1600, 0.75);
          formData.append('photo', compressed, 'foto.jpg');
        }
        const res = await fetch('/api/suspensiones', { method: 'PATCH', body: formData });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo guardar la información.');
        if (pending) {
          URL.revokeObjectURL(pending.url);
          delete pendingInfoPhotos[id];
        }
        loadSuspensiones();
      } catch (err) {
        alert(err.message || 'No se pudo guardar la información.');
      } finally {
        btn.disabled = false;
      }
      return;
    }

    const body = { id, action };

    if (action === 'reassign') {
      const select = suspensionesList.querySelector(`select[data-reassign="any"][data-id="${id}"]`);
      const targetUserId = select ? select.value : '';
      if (!targetUserId) {
        alert('Selecciona a quién se le asigna antes de continuar.');
        return;
      }
      body.targetUserId = targetUserId;
    }

    if (action === 'suspend' && !confirm('¿Confirmas que no se encontró solución y el cliente se suspende?')) return;
    if (action === 'finalize' && !confirm('¿Confirmas que este caso queda finalizado por tesorería?')) return;

    if (action === 'escalate' || action === 'reassign' || action === 'resolve' || action === 'suspend' || action === 'finalize') {
      body.note = prompt('Nota (opcional) sobre esta acción:') || '';
    }

    fetch('/api/suspensiones', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error([data.error, data.detail].filter(Boolean).join(' — ') || 'No se pudo actualizar el caso.');
        loadSuspensiones();
      })
      .catch((err) => alert(err.message || 'No se pudo actualizar el caso.'));
  });

  // --- Formulario de creación (el operador solo registra sucursal, placa, motivo y teléfono) ---
  const suspensionForm = document.getElementById('suspensionForm');

  suspensionForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    const clientPhone = document.getElementById('clientPhone').value.trim();
    const plate = document.getElementById('plate').value.trim();
    const branch = document.getElementById('branch').value;
    const assignToId = document.getElementById('assignTo').value;
    const reason = document.getElementById('reason').value.trim();
    if (!plate || !branch || !assignToId || !reason) return;

    const submitBtn = suspensionForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    const originalLabel = submitBtn.textContent;

    try {
      const formData = new FormData();
      formData.set('clientPhone', clientPhone);
      formData.set('plate', plate);
      formData.set('branch', branch);
      formData.set('assignToId', assignToId);
      formData.set('reason', reason);

      submitBtn.textContent = 'Guardando...';
      const res = await fetch('/api/suspensiones', { method: 'POST', body: formData });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error([data.error, data.detail].filter(Boolean).join(' — ') || `error ${res.status}`);
      }
      suspensionForm.reset();
      loadSuspensiones();
    } catch (err) {
      alert('No se pudo guardar el caso: ' + (err.message || 'intenta de nuevo.'));
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  });

  loadAssignees();
  loadAnyUsers();
  loadSuspensiones();
});
