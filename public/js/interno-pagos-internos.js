document.addEventListener('DOMContentLoaded', function () {
  const pagosList = document.getElementById('pagosList');
  if (!pagosList) return; // no autenticado o sin permiso

  const pagosData = document.getElementById('pagosData');
  const seesAll = pagosData && pagosData.dataset.seesAll === 'true';
  let currentUserId = '';
  let allPagos = [];
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

  function fmtDateOnly(iso) {
    if (!iso) return '';
    return new Date(iso + 'T00:00:00').toLocaleDateString('es-CO', { dateStyle: 'medium' });
  }

  function fmtMoney(n) {
    return '$' + Math.round(n || 0).toLocaleString('es-CO');
  }

  function statusClass(status) {
    return 'status-' + String(status || '').replace(/\s+/g, '-');
  }

  function isOverdue(p) {
    if (p.status === 'Pagado') return false;
    return new Date(p.dueDate).getTime() < new Date().setHours(0, 0, 0, 0);
  }

  function renderStats(stats) {
    const statsRow = document.getElementById('statsRow');
    statsRow.innerHTML = `
      <div class="stat-box"><span class="n">${stats.total}</span><span class="l">Total</span></div>
      <div class="stat-box overdue"><span class="n">${stats.pendientes}</span><span class="l">Pendientes</span></div>
      <div class="stat-box"><span class="n">${stats.pagados}</span><span class="l">Pagados</span></div>
      <div class="stat-box overdue"><span class="n">${fmtMoney(stats.montoPendiente)}</span><span class="l">Monto pendiente</span></div>
    `;
  }

  function actionsFor(p) {
    const parts = [];
    if (p.status === 'Pendiente') {
      parts.push(`<button class="btn-small btn-done" data-action="markPaid" data-id="${p.id}" type="button">Marcar pagado</button>`);
    } else {
      parts.push(`<button class="btn-small" data-action="reopen" data-id="${p.id}" type="button">Reabrir</button>`);
    }
    return parts.join('');
  }

  function renderList(items) {
    if (!items.length) {
      pagosList.innerHTML = '<div class="empty">No hay pagos con esos filtros.</div>';
      return;
    }
    pagosList.innerHTML = items.map((p) => {
      const overdue = isOverdue(p);
      return `
      <div class="pago-item ${p.status !== 'Pendiente' ? 'closed' : ''} ${overdue ? 'overdue' : ''}" data-id="${p.id}">
        <div class="pago-top">
          <span class="pago-concepto">${escapeHtml(p.concepto)}</span>
          <span class="badge ${statusClass(p.status)}">${escapeHtml(p.status)}</span>
          ${overdue ? '<span class="badge overdue-badge">Vencido</span>' : ''}
        </div>
        <div class="pago-monto">${fmtMoney(p.monto)} · ${escapeHtml(p.proveedor)}</div>
        <div class="pago-meta">
          Responsable: ${escapeHtml(p.assignedToName)} · Sucursal: ${escapeHtml(p.branch)} · Vence: ${fmtDateOnly(p.dueDate)}
          ${p.paidAt ? ` · Pagado por ${escapeHtml(p.paidByName)} el ${fmtDate(p.paidAt)}` : ''}
        </div>
        ${p.timeline && p.timeline.length ? `
          <div class="pago-timeline">
            ${p.timeline.map((t) => `<div class="timeline-item"><span class="timeline-date">${fmtDate(t.date)} · ${escapeHtml(t.authorName)}</span>${escapeHtml(t.message)}</div>`).join('')}
          </div>
        ` : ''}
        <div class="pago-actions">${actionsFor(p)}</div>
        <div class="pago-add-note-row">
          <input type="text" placeholder="Agregar nota de seguimiento..." data-note-input data-id="${p.id}" />
          <button class="btn-small" data-action="addNote" data-id="${p.id}" type="button">Agregar</button>
        </div>
      </div>
    `;
    }).join('');
  }

  function loadPagos() {
    const params = new URLSearchParams();
    if (searchInput.value.trim()) params.set('q', searchInput.value.trim());
    if (currentTab) params.set('status', currentTab);
    if (branchFilter && branchFilter.value) params.set('branch', branchFilter.value);

    fetch('/api/pagos-internos?' + params.toString())
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (data && Array.isArray(data.pagos)) {
          currentUserId = data.currentUserId || '';
          allPagos = data.pagos;
          renderStats(data.stats);
          renderList(allPagos);
        } else {
          pagosList.innerHTML = `<div class="empty">No se pudo cargar${data && data.error ? ': ' + escapeHtml(data.error) : ' (revisa la conexión)'}.</div>`;
        }
      })
      .catch((err) => {
        pagosList.innerHTML = `<div class="empty">No se pudo cargar: ${escapeHtml(err.message || 'error de red')}.</div>`;
      });
  }

  const searchInput = document.getElementById('searchInput');
  const branchFilter = document.getElementById('branchFilter');
  const tabButtons = document.querySelectorAll('.tabs .tab-btn[data-status]');

  let debounceTimer;
  searchInput.addEventListener('input', function () {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(loadPagos, 250);
  });
  if (branchFilter) branchFilter.addEventListener('change', loadPagos);
  tabButtons.forEach((btn) => {
    btn.addEventListener('click', function () {
      tabButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentTab = btn.getAttribute('data-status') || '';
      loadPagos();
    });
  });

  pagosList.addEventListener('click', function (e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    const id = btn.getAttribute('data-id');

    if (action === 'addNote') {
      const input = pagosList.querySelector(`input[data-note-input][data-id="${id}"]`);
      const note = input ? input.value.trim() : '';
      if (!note) return;
      fetch('/api/pagos-internos', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action, note }),
      })
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'No se pudo agregar la nota.');
          loadPagos();
        })
        .catch((err) => alert(err.message || 'No se pudo agregar la nota.'));
      return;
    }

    const body = { id, action };
    if (action === 'markPaid' || action === 'reopen') {
      body.note = prompt('Nota (opcional) sobre esta acción:') || '';
    }

    fetch('/api/pagos-internos', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo actualizar el pago.');
        loadPagos();
      })
      .catch((err) => alert(err.message || 'No se pudo actualizar el pago.'));
  });

  const pagoForm = document.getElementById('pagoForm');
  const assignedToSelect = document.getElementById('assignedTo');

  function loadUsers() {
    return fetch('/api/users')
      .then((res) => res.json())
      .then((data) => {
        if (!data || !Array.isArray(data.users)) return;
        const active = data.users.filter((u) => u.active);
        assignedToSelect.innerHTML = '<option value="">Selecciona un responsable</option>' +
          active.map((u) => `<option value="${u.id}">${escapeHtml(u.name)} (${escapeHtml(u.role)})</option>`).join('');
      });
  }

  pagoForm.addEventListener('submit', function (e) {
    e.preventDefault();
    const concepto = document.getElementById('concepto').value.trim();
    const proveedor = document.getElementById('proveedor').value.trim();
    const monto = Number(document.getElementById('monto').value);
    const dueDate = document.getElementById('dueDate').value;
    const branchInput = document.getElementById('branch');
    const branch = branchInput ? branchInput.value : undefined;
    const assignedToId = assignedToSelect.value;
    if (!concepto || !proveedor || !monto || !dueDate || !assignedToId) return;
    if (branchInput && !branch) return;

    const submitBtn = pagoForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    fetch('/api/pagos-internos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ concepto, proveedor, monto, dueDate, branch, assignedToId }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo registrar el pago.');
        pagoForm.reset();
        loadPagos();
      })
      .catch((err) => alert(err.message || 'No se pudo registrar el pago.'))
      .finally(() => { submitBtn.disabled = false; });
  });

  loadUsers().then(loadPagos);
});
