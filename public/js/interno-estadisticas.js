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

  function renderRankingTable(el, ranking) {
    if (!ranking.length) {
      el.innerHTML = '<tr><td>Sin datos</td></tr>';
      return;
    }
    el.innerHTML = ranking.map((r) => `
      <tr>
        <td>${escapeHtml(r.name)} <span class="detail">(${r.total} / ${r.installed})</span></td>
        <td>${r.rate}%</td>
      </tr>
    `).join('');
  }

  const cityFilter = document.getElementById('crmCityFilter');
  const secretaryFilter = document.getElementById('crmSecretaryFilter');
  let filterOptionsLoaded = false;

  function loadCrmStats() {
    const params = new URLSearchParams();
    if (cityFilter.value) params.set('city', cityFilter.value);
    if (secretaryFilter.value) params.set('secretary', secretaryFilter.value);

    fetch('/api/dashboard-stats?' + params.toString())
      .then((res) => res.json())
      .then((data) => {
        if (!data || !data.crm) throw new Error('sin datos');
        const crm = data.crm;

        if (!filterOptionsLoaded) {
          cityFilter.innerHTML = '<option value="">Todas las ciudades</option>' +
            crm.cities.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
          secretaryFilter.innerHTML = '<option value="">Todas las secretarias</option>' +
            crm.secretaries.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
          filterOptionsLoaded = true;
        }

        const crmBoxes = [
          { n: crm.total, l: 'Total leads' },
          ...Object.entries(crm.byStatus).map(([status, n]) => ({ n, l: status })),
          { n: crm.installedCount, l: 'Instalados' },
          { n: crm.verifiedInstalledCount, l: 'Instalación verificada' },
          { n: crm.conversionRate + '%', l: 'Tasa de conversión' },
          { n: crm.verifiedConversionRate + '%', l: 'Conversión verificada' },
          { n: crm.last7DaysCount, l: 'Nuevos (7 días)' },
          { n: crm.last30DaysCount, l: 'Nuevos (30 días)' },
        ];
        renderStatBoxes(crmStatsRow, crmBoxes);
        renderTable(document.getElementById('crmByCityTable'), crm.byCity);
        renderTable(document.getElementById('crmBySecretaryTable'), crm.bySecretary);
        renderRankingTable(document.getElementById('crmCityRankingTable'), crm.cityRanking);
        renderRankingTable(document.getElementById('crmSecretaryRankingTable'), crm.secretaryRanking);
      })
      .catch(() => {
        crmStatsRow.innerHTML = '<div class="empty">No se pudo cargar (revisa la conexión).</div>';
      });
  }

  function loadNovedadesStats() {
    fetch('/api/dashboard-stats')
      .then((res) => res.json())
      .then((data) => {
        if (!data || !data.novedades) throw new Error('sin datos');
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
        document.getElementById('novedadesStatsRow').innerHTML = '<div class="empty">No se pudo cargar (revisa la conexión).</div>';
      });
  }

  cityFilter.addEventListener('change', loadCrmStats);
  secretaryFilter.addEventListener('change', loadCrmStats);

  loadCrmStats();
  loadNovedadesStats();
});
