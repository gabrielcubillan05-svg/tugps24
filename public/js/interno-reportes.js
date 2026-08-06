document.addEventListener('DOMContentLoaded', function () {
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function fmtDateOnly(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString('es-CO', { dateStyle: 'medium' });
  }

  const scheduledForm = document.getElementById('scheduledForm');
  const scheduledList = document.getElementById('scheduledList');
  if (!scheduledList) return;

  const srOperatorSelect = document.getElementById('sr-operator');
  fetch('/api/users?role=operador')
    .then((res) => res.json())
    .then((data) => {
      if (!data || !Array.isArray(data.users)) return;
      srOperatorSelect.innerHTML = data.users.length
        ? data.users.map((u) => `<option value="${escapeHtml(u.name)}">${escapeHtml(u.name)}</option>`).join('')
        : '<option value="">No hay operadores disponibles</option>';
    })
    .catch(() => {
      srOperatorSelect.innerHTML = '<option value="">No se pudo cargar la lista</option>';
    });

  const tabButtons = document.querySelectorAll('.tab-btn[data-bucket]');
  let currentBucket = '';
  let allReports = [];

  const BUCKET_LABELS = { pendiente: 'Pendiente', 'por-realizar': 'Por realizar', 'al-dia': 'Al día' };
  const BUCKET_CLASS = { pendiente: 'danger', 'por-realizar': '', 'al-dia': 'ok' };

  function renderScheduled() {
    const reports = currentBucket ? allReports.filter((r) => r.bucket === currentBucket) : allReports;
    if (!reports.length) {
      scheduledList.innerHTML = '<div class="empty">No hay reportes en esta vista.</div>';
      return;
    }
    scheduledList.innerHTML = reports.map((r) => `
      <div class="list-item ${r.bucket === 'pendiente' ? 'pending' : ''}" data-id="${r.id}">
        <div class="item-top">
          <span class="title">${escapeHtml(r.client)} — ${escapeHtml(r.reportType)}</span>
          <span class="badge status ${BUCKET_CLASS[r.bucket]}">${BUCKET_LABELS[r.bucket]}</span>
        </div>
        <div class="meta">
          Operador: ${escapeHtml(r.operator)} · Frecuencia: ${escapeHtml(r.frequency)} ·
          ${r.pending ? 'Debía hacerse el ' : 'Próximo: '}${fmtDateOnly(r.nextDue)}
        </div>
        <div class="item-actions">
          <button class="btn-small btn-done" data-action="done" data-id="${r.id}">Marcar hecho</button>
          <button class="btn-small btn-delete" data-action="delete-sr" data-id="${r.id}">Eliminar</button>
        </div>
      </div>
    `).join('');
  }

  function loadScheduled() {
    fetch('/api/scheduled-reports')
      .then((res) => res.json())
      .then((data) => {
        if (data && Array.isArray(data.reports)) {
          allReports = data.reports;
          renderScheduled();
        } else {
          scheduledList.innerHTML = '<div class="empty">No se pudo cargar.</div>';
        }
      })
      .catch(() => {
        scheduledList.innerHTML = '<div class="empty">No se pudo cargar.</div>';
      });
  }

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', function () {
      tabButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentBucket = btn.getAttribute('data-bucket') || '';
      renderScheduled();
    });
  });

  scheduledForm.addEventListener('submit', function (e) {
    e.preventDefault();
    const client = document.getElementById('sr-client').value.trim();
    const reportType = document.getElementById('sr-type').value.trim();
    const frequency = document.getElementById('sr-frequency').value;
    const operator = document.getElementById('sr-operator').value.trim();
    if (!client || !reportType || !frequency || !operator) return;

    fetch('/api/scheduled-reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client, reportType, frequency, operator }),
    })
      .then((res) => res.json())
      .then(() => {
        scheduledForm.reset();
        loadScheduled();
      })
      .catch(() => alert('No se pudo guardar.'));
  });

  scheduledList.addEventListener('click', function (e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    const action = btn.getAttribute('data-action');

    if (action === 'done') {
      fetch('/api/scheduled-reports', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      }).then(loadScheduled);
    } else if (action === 'delete-sr') {
      if (!confirm('¿Eliminar este reporte programado?')) return;
      fetch('/api/scheduled-reports', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      }).then(loadScheduled);
    }
  });

  loadScheduled();
});
