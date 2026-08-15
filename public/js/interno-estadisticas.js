document.addEventListener('DOMContentLoaded', function () {
  const crmStatsRow = document.getElementById('crmStatsRow');
  if (!crmStatsRow) return; // no autenticado o sin permiso

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function renderStatBoxes(container, boxes) {
    container.innerHTML = boxes.map((b) => `
      <div class="stat-box${b.warn ? ' overdue' : ''}">
        <span class="n">${b.n}</span>
        <span class="l">${escapeHtml(b.l)}</span>
      </div>
    `).join('');
  }

  function renderTable(el, counts) {
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (!entries.length) {
      el.innerHTML = '<tr><td>Sin datos</td></tr>';
      return;
    }
    el.innerHTML = entries.map(([name, count]) => `
      <tr><td>${escapeHtml(name)}</td><td>${count}</td></tr>
    `).join('');
  }

  fetch('/api/dashboard-stats')
    .then((res) => res.json())
    .then((data) => {
      if (!data || !data.crm || !data.novedades) throw new Error('sin datos');

      const crm = data.crm;
      const crmBoxes = [
        { n: crm.total, l: 'Total leads' },
        ...Object.entries(crm.byStatus).map(([status, n]) => ({ n, l: status })),
        { n: crm.installedCount, l: 'Instalados' },
        { n: crm.verifiedInstalledCount, l: 'Instalación verificada' },
        { n: crm.last7DaysCount, l: 'Nuevos (7 días)' },
        { n: crm.last30DaysCount, l: 'Nuevos (30 días)' },
      ];
      renderStatBoxes(crmStatsRow, crmBoxes);
      renderTable(document.getElementById('crmByCityTable'), crm.byCity);
      renderTable(document.getElementById('crmBySecretaryTable'), crm.bySecretary);

      const nov = data.novedades;
      const novBoxes = [
        { n: nov.total, l: 'Total novedades' },
        { n: nov.last7DaysCount, l: 'Últimos 7 días' },
        { n: nov.last30DaysCount, l: 'Últimos 30 días' },
      ];
      renderStatBoxes(document.getElementById('novedadesStatsRow'), novBoxes);
      renderTable(document.getElementById('novedadesByCategoryTable'), nov.byCategory);
      renderTable(document.getElementById('novedadesByBranchTable'), nov.byBranch);
      renderTable(document.getElementById('novedadesByOperatorTable'), nov.byOperator);
    })
    .catch(() => {
      crmStatsRow.innerHTML = '<div class="empty">No se pudo cargar (revisa la conexión).</div>';
    });
});
