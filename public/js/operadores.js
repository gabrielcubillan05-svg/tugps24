document.addEventListener('DOMContentLoaded', function () {
  const reportForm = document.getElementById('reportForm');
  const reportsList = document.getElementById('reportsList');
  const searchInput = document.getElementById('searchInput');
  const branchFilter = document.getElementById('branchFilter');
  const categoryFilter = document.getElementById('categoryFilter');

  if (!reportsList) return; // no autenticado, no hay panel en esta página

  function fmtDate(iso) {
    const d = new Date(iso);
    return d.toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function render(reports) {
    if (!reports.length) {
      reportsList.innerHTML = '<div class="empty">No hay reportes con esos filtros.</div>';
      return;
    }
    reportsList.innerHTML = reports.map((r) => `
      <div class="report-item">
        <div class="report-top">
          <span class="plate">${escapeHtml(r.plate)} · ${escapeHtml(r.branch)}</span>
          <span class="badge">${escapeHtml(r.category)}</span>
        </div>
        <p class="note">${escapeHtml(r.note)}</p>
        <div class="meta">${fmtDate(r.createdAt)}</div>
      </div>
    `).join('');
  }

  let debounceTimer;
  function loadReports() {
    const params = new URLSearchParams();
    if (searchInput.value.trim()) params.set('q', searchInput.value.trim());
    if (branchFilter.value) params.set('branch', branchFilter.value);
    if (categoryFilter.value) params.set('category', categoryFilter.value);

    fetch('/api/reports?' + params.toString())
      .then((res) => res.json())
      .then((data) => {
        if (data && Array.isArray(data.reports)) render(data.reports);
        else reportsList.innerHTML = '<div class="empty">No se pudo cargar (revisa la conexión).</div>';
      })
      .catch(() => {
        reportsList.innerHTML = '<div class="empty">No se pudo cargar (revisa la conexión).</div>';
      });
  }

  function debouncedLoad() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(loadReports, 250);
  }

  searchInput.addEventListener('input', debouncedLoad);
  branchFilter.addEventListener('change', loadReports);
  categoryFilter.addEventListener('change', loadReports);

  reportForm.addEventListener('submit', function (e) {
    e.preventDefault();
    const plate = document.getElementById('plate').value.trim();
    const branch = document.getElementById('branch').value;
    const category = document.getElementById('category').value;
    const note = document.getElementById('note').value.trim();
    if (!plate || !branch || !category || !note) return;

    const submitBtn = reportForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    fetch('/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plate, branch, category, note }),
    })
      .then((res) => res.json())
      .then(() => {
        reportForm.reset();
        loadReports();
      })
      .catch(() => {
        alert('No se pudo guardar el reporte, intenta de nuevo.');
      })
      .finally(() => {
        submitBtn.disabled = false;
      });
  });

  loadReports();
});
