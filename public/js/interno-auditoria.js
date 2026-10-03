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

  const securitySummary = document.getElementById('securitySummary');
  if (securitySummary) {
    fetch('/api/security-stats')
      .then((res) => res.json())
      .then(renderSecurity)
      .catch(() => {
        securitySummary.innerHTML = '<div class="empty">No se pudo cargar.</div>';
      });
  }

  function fmtDay(date) {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', month: 'short' });
  }

  function renderSecurity(stats) {
    if (!stats || !Array.isArray(stats.days)) {
      securitySummary.innerHTML = '<div class="empty">No se pudo cargar.</div>';
      return;
    }
    const sum = (field) => stats.days.reduce((acc, d) => acc + (d[field] || 0), 0);
    const today = stats.days[0] || {};
    // Umbrales orientativos: pocos fallos de clave al día son olvidos normales; decenas desde la
    // misma IP o cientos de rutas inexistentes ya son alguien probando.
    const level = (n, warn, alert) => (n >= alert ? 'alert' : n >= warn ? 'warn' : '');
    const tiles = [
      { label: 'Claves fallidas hoy', value: today.login_failed || 0, cls: level(today.login_failed || 0, 10, 30) },
      { label: 'Bloqueos de login hoy', value: today.login_locked || 0, cls: level(today.login_locked || 0, 1, 5) },
      { label: 'Rechazos (origen/firma/permiso) hoy', value: today.forbidden || 0, cls: level(today.forbidden || 0, 20, 100) },
      { label: 'Límite de tasa hoy', value: today.rate_limited || 0, cls: level(today.rate_limited || 0, 5, 30) },
      { label: 'Rutas inexistentes hoy', value: today.not_found || 0, cls: level(today.not_found || 0, 50, 300) },
      { label: 'Total frenado en 7 días', value: sum('login_failed') + sum('login_locked') + sum('forbidden') + sum('rate_limited') + sum('not_found'), cls: '' },
    ];
    const tilesHtml = tiles.map((t) => `
      <div class="sec-tile ${t.cls}">
        <div class="sec-num">${t.value}</div>
        <div class="sec-label">${escapeHtml(t.label)}</div>
      </div>`).join('');

    const rows = stats.days.map((d) => `
      <tr>
        <td>${escapeHtml(fmtDay(d.date))}</td>
        <td>${d.login_failed}</td>
        <td>${d.login_locked}</td>
        <td>${d.forbidden}</td>
        <td>${d.rate_limited}</td>
        <td>${d.not_found}</td>
      </tr>`).join('');

    const ipRows = (stats.topIps || []).length
      ? stats.topIps.map((r) => `<tr><td class="path">${escapeHtml(r.ip)}</td><td>${r.count}</td></tr>`).join('')
      : '<tr><td colspan="2" style="text-align:left; color:var(--slate);">Ninguna</td></tr>';
    const pathRows = (stats.topPaths || []).length
      ? stats.topPaths.map((r) => `<tr><td class="path" title="${escapeHtml(r.path)}">${escapeHtml(r.path)}</td><td>${r.count}</td></tr>`).join('')
      : '<tr><td colspan="2" style="text-align:left; color:var(--slate);">Ninguna</td></tr>';

    securitySummary.className = '';
    securitySummary.innerHTML = `
      <div class="sec-grid">${tilesHtml}</div>
      <table class="sec-table">
        <thead><tr><th>Día</th><th>Claves fallidas</th><th>Bloqueos login</th><th>Rechazos</th><th>Límite de tasa</th><th>Rutas inexistentes</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="sec-cols">
        <div>
          <h3>IPs con más intentos frenados (7 días)</h3>
          <table class="sec-table"><tbody>${ipRows}</tbody></table>
        </div>
        <div>
          <h3>Rutas más golpeadas (7 días)</h3>
          <table class="sec-table"><tbody>${pathRows}</tbody></table>
        </div>
      </div>
      <div style="margin-top:18px;">
        <h3 style="font-size:13px; color:var(--slate); margin:0 0 6px; font-weight:600;">Peticiones lentas del servidor (más de 1 segundo, hoy y ayer)</h3>
        ${stats.slow && stats.slow.routes && stats.slow.routes.length
          ? `<table class="sec-table"><thead><tr><th>Ruta</th><th>Veces</th><th>Promedio</th></tr></thead><tbody>${stats.slow.routes.map((r) => `<tr><td class="path" title="${escapeHtml(r.path)}">${escapeHtml(r.path)}</td><td>${r.count}</td><td>${(r.avgMs / 1000).toFixed(1)} s</td></tr>`).join('')}</tbody></table>`
          : '<p class="sec-note" style="margin-top:0;">Ninguna. Si aun así el panel se siente lento, la demora está en la conexión de la sucursal o en el navegador, no en el servidor.</p>'}
      </div>
      <p class="sec-note">Los ataques de denegación de servicio y los bots los frena Vercel antes de llegar aquí: eso se ve en la pestaña Firewall de Vercel. Esta tarjeta empieza a contar desde el despliegue de hoy.</p>
    `;
  }

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
