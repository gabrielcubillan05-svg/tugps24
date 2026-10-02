document.addEventListener('DOMContentLoaded', function () {
  const redisTable = document.getElementById('redisTable');
  if (!redisTable) return;
  const blobTable = document.getElementById('blobTable');
  const totals = document.getElementById('totals');
  const generatedAt = document.getElementById('generatedAt');
  const refreshBtn = document.getElementById('refreshBtn');
  const simulateBtn = document.getElementById('simulateBtn');
  const runBtn = document.getElementById('runBtn');
  const cleanupResult = document.getElementById('cleanupResult');
  const archivesList = document.getElementById('archivesList');

  function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function fmtBytes(n) {
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (i === 0 ? v : v.toFixed(1)) + ' ' + units[i];
  }

  function fmtNum(n) {
    return Number(n || 0).toLocaleString('es-CO');
  }

  function fmtDate(iso) {
    return iso ? new Date(iso).toLocaleDateString('es-CO') : '—';
  }

  function stat(n, label) {
    return `<div class="agent-usage-stat"><span class="n">${n}</span><span class="l">${label}</span></div>`;
  }

  function renderReport(r) {
    generatedAt.textContent = 'Generado ' + new Date(r.generatedAt).toLocaleString('es-CO');
    totals.innerHTML =
      stat(fmtBytes(r.redis.totalBytes), 'Redis (aprox.)') +
      stat(fmtNum(r.redis.keysScanned), 'Llaves en Redis') +
      stat(r.blob.configured ? fmtBytes(r.blob.bytes) : '—', 'Archivos en Blob') +
      stat(r.blob.configured ? fmtNum(r.blob.files) : '—', 'Cantidad de archivos');

    const maxRedis = Math.max(1, ...r.redis.groups.map((g) => g.approxBytes));
    redisTable.innerHTML = `
      ${r.redis.truncated ? '<p class="hint" style="color:var(--amber);">Se alcanzó el tope de llaves revisadas; el total real es mayor.</p>' : ''}
      <table class="storage-table">
        <thead><tr><th>Llave</th><th>Tipo</th><th class="num">Llaves</th><th class="num">Registros</th><th class="num">Tamaño</th><th style="width:28%"></th></tr></thead>
        <tbody>
          ${r.redis.groups.map((g) => `
            <tr>
              <td><code>${escapeHtml(g.group)}</code></td>
              <td>${escapeHtml(g.type)}</td>
              <td class="num">${fmtNum(g.keys)}</td>
              <td class="num">${fmtNum(g.entries)}</td>
              <td class="num">${fmtBytes(g.approxBytes)}${g.sampled ? ' <span class="hint" title="Estimado por muestra">≈</span>' : ''}</td>
              <td><div class="bar" style="width:${Math.max(1, Math.round((g.approxBytes / maxRedis) * 100))}%"></div></td>
            </tr>`).join('')}
        </tbody>
      </table>`;

    if (!r.blob.configured) {
      blobTable.innerHTML = '<div class="empty">El almacenamiento de archivos no está configurado en este entorno.</div>';
    } else {
      const maxBlob = Math.max(1, ...r.blob.groups.map((g) => g.bytes));
      blobTable.innerHTML = `
        ${r.blob.truncated ? '<p class="hint" style="color:var(--amber);">Se alcanzó el tope de archivos listados; el total real es mayor.</p>' : ''}
        <table class="storage-table">
          <thead><tr><th>Carpeta</th><th class="num">Archivos</th><th class="num">Tamaño</th><th>Más antiguo</th><th>Más reciente</th><th style="width:28%"></th></tr></thead>
          <tbody>
            ${r.blob.groups.map((g) => `
              <tr>
                <td><code>${escapeHtml(g.folder)}/</code></td>
                <td class="num">${fmtNum(g.files)}</td>
                <td class="num">${fmtBytes(g.bytes)}</td>
                <td>${fmtDate(g.oldest)}</td>
                <td>${fmtDate(g.newest)}</td>
                <td><div class="bar" style="width:${Math.max(1, Math.round((g.bytes / maxBlob) * 100))}%"></div></td>
              </tr>`).join('')}
          </tbody>
        </table>`;
    }

    archivesList.innerHTML = r.archives.length
      ? `<table class="storage-table"><tbody>${r.archives.map((a) => `
          <tr>
            <td><a href="/api/blob-file?path=${encodeURIComponent(a.pathname)}" target="_blank" rel="noopener">${escapeHtml(a.pathname.replace(/^archive\//, ''))}</a></td>
            <td class="num">${fmtBytes(a.size)}</td>
            <td>${fmtDate(a.uploadedAt)}</td>
          </tr>`).join('')}</tbody></table>`
      : '<div class="empty">Todavía no hay archivos de respaldo. Se crean cuando la limpieza archiva novedades.</div>';
  }

  function loadReport() {
    redisTable.innerHTML = '<div class="empty">Calculando... puede tardar unos segundos.</div>';
    blobTable.innerHTML = '<div class="empty">Calculando...</div>';
    refreshBtn.disabled = true;
    fetch('/api/storage-report')
      .then((res) => res.json())
      .then((data) => {
        if (!data || !data.redis) {
          redisTable.innerHTML = `<div class="empty">No se pudo cargar${data && data.error ? ': ' + escapeHtml(data.error) : ''}.</div>`;
          blobTable.innerHTML = '';
          return;
        }
        renderReport(data);
      })
      .catch(() => {
        redisTable.innerHTML = '<div class="empty">No se pudo cargar (revisa la conexión).</div>';
        blobTable.innerHTML = '';
      })
      .finally(() => { refreshBtn.disabled = false; });
  }

  function renderSummary(s, text) {
    cleanupResult.innerHTML = `
      <div class="cleanup-summary">
        <b>${escapeHtml(text)}</b><br />
        Auditoría: ${fmtNum(s.audit.removed)} entradas ·
        Fotos de novedades: ${fmtNum(s.reports.photosPurged)} en ${fmtNum(s.reports.reportsWithoutPhotos)} novedades ·
        Novedades archivadas: ${fmtNum(s.reports.archived)}${s.reports.moreLeft ? ' (quedan más para la próxima corrida)' : ''} ·
        Leads: ${fmtNum(s.leads.archived)} ·
        Tareas: ${fmtNum(s.tasks.archived)} (${fmtNum(s.tasks.proofsDeleted)} evidencias) ·
        Notificaciones: ${fmtNum(s.notifications.removed)} en ${fmtNum(s.notifications.usersTrimmed)} usuarios ·
        Sesiones: ${fmtNum(s.sessions.removed)}
        ${s.reports.archiveFile ? `<br />Respaldo creado: <code>${escapeHtml(s.reports.archiveFile)}</code>` : ''}
        ${s.errors.length ? `<br /><span class="err">Errores: ${s.errors.map(escapeHtml).join(' · ')}</span>` : ''}
      </div>`;
  }

  function runCleanup(action) {
    cleanupResult.innerHTML = '<div class="empty">Procesando...</div>';
    simulateBtn.disabled = true;
    runBtn.disabled = true;
    fetch('/api/storage-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.summary) throw new Error(data.error || 'No se pudo ejecutar.');
        renderSummary(data.summary, data.text);
        if (action === 'run') loadReport();
      })
      .catch((err) => {
        cleanupResult.innerHTML = `<div class="empty">${escapeHtml(err.message || 'No se pudo ejecutar.')}</div>`;
      })
      .finally(() => {
        simulateBtn.disabled = false;
        runBtn.disabled = false;
      });
  }

  refreshBtn.addEventListener('click', loadReport);
  simulateBtn.addEventListener('click', () => runCleanup('simulate'));
  runBtn.addEventListener('click', () => {
    if (!confirm('¿Ejecutar la limpieza ahora con las reglas vigentes? Las fotos de novedades viejas y las evidencias de tareas viejas se borran definitivamente; el texto se conserva o queda en un archivo de respaldo.')) return;
    runCleanup('run');
  });

  loadReport();
});
