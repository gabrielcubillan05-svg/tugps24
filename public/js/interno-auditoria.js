document.addEventListener('DOMContentLoaded', function () {
  const auditList = document.getElementById('auditList');
  if (!auditList) return;
  const searchInput = document.getElementById('searchInput');

  let allEntries = [];

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function fmtDate(iso) {
    return new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'medium' });
  }

  function render() {
    const q = searchInput.value.trim().toLowerCase();
    const entries = q
      ? allEntries.filter((e) =>
          e.username.toLowerCase().includes(q) ||
          e.action.toLowerCase().includes(q) ||
          (e.target || '').toLowerCase().includes(q)
        )
      : allEntries;

    if (!entries.length) {
      auditList.innerHTML = '<div class="empty">No hay registros.</div>';
      return;
    }
    auditList.innerHTML = entries.map((e) => `
      <div class="audit-item">
        <div class="audit-top">
          <span class="audit-action">${escapeHtml(e.username)} · ${escapeHtml(e.action)}</span>
          <span class="audit-date">${fmtDate(e.at)}</span>
        </div>
        <div class="audit-detail">${escapeHtml(e.target)}${e.meta ? ' — ' + escapeHtml(e.meta) : ''}</div>
      </div>
    `).join('');
  }

  let debounceTimer;
  searchInput.addEventListener('input', function () {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(render, 200);
  });

  fetch('/api/audit')
    .then((res) => res.json())
    .then((data) => {
      if (!data || !Array.isArray(data.entries)) {
        auditList.innerHTML = '<div class="empty">No se pudo cargar.</div>';
        return;
      }
      allEntries = data.entries;
      render();
    })
    .catch(() => {
      auditList.innerHTML = '<div class="empty">No se pudo cargar.</div>';
    });
});
