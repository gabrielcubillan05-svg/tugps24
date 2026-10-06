document.addEventListener('DOMContentLoaded', function () {
  const summary = document.getElementById('archSummary');
  if (!summary) return;
  const searchInput = document.getElementById('archSearch');
  const branchSelect = document.getElementById('archBranch');
  const notice = document.getElementById('archNotice');
  const results = document.getElementById('archResults');
  const listCard = document.getElementById('archListCard');
  const list = document.getElementById('archList');
  const prevBtn = document.getElementById('archPrev');
  const nextBtn = document.getElementById('archNext');
  const pageLabel = document.getElementById('archPageLabel');
  const filesEl = document.getElementById('archFiles');
  const fileItems = document.getElementById('archFileItems');

  const RENDER_STEP = 100;
  let page = 0;
  let pageSize = 200;
  let beyond = 0;
  let archives = [];

  function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtDate(iso) {
    return iso ? new Date(iso).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  }
  function fmtNum(n) {
    return Number(n || 0).toLocaleString('es-CO');
  }
  function fmtSize(bytes) {
    return bytes > 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB';
  }
  function sourceLabel(src) {
    if (!src) return '';
    if (src.kind === 'archivo') return 'Archivo ' + escapeHtml(String(src.file || '').replace(/^archive\/novedades\//, '').replace(/_\d+\.json$/, '').replace('_a_', ' a '));
    return 'Lista principal · posición ' + fmtNum(src.offset + 1);
  }

  function reportHtml(r, withSource) {
    return `
      <div class="report-item">
        <div class="report-top">
          <span class="plate">${escapeHtml(r.plate)} · ${escapeHtml(r.branch)}</span>
          <span class="badge">${escapeHtml(r.category)}</span>
          ${withSource ? `<span class="source-tag">${sourceLabel(r.source)}</span>` : ''}
        </div>
        <p class="note">${escapeHtml(r.note)}</p>
        ${Array.isArray(r.images) && r.images.length ? `
          <div class="report-images">
            ${r.images.map((path) => {
              const src = '/api/blob-file?path=' + encodeURIComponent(path);
              return `<a href="${src}" target="_blank" rel="noopener"><img src="${src}" alt="Foto del reporte" loading="lazy" /></a>`;
            }).join('')}
          </div>` : ''}
        <div class="meta">
          <span>${fmtDate(r.createdAt)}</span>
          ${r.createdByName ? `<span class="author">${escapeHtml(r.createdByName)}</span>` : ''}
        </div>
      </div>`;
  }

  // Pinta de a 100 con un botón "Mostrar más": una página de 200 o un archivo de miles no
  // deben congelar el navegador de la central.
  function renderInto(container, items, withSource) {
    let shown = 0;
    container.innerHTML = '';
    if (!items.length) {
      container.innerHTML = '<div class="empty">No hay novedades aquí.</div>';
      return;
    }
    function more() {
      const slice = items.slice(shown, shown + RENDER_STEP);
      shown += slice.length;
      const old = container.querySelector('.arch-more');
      if (old) old.remove();
      container.insertAdjacentHTML('beforeend', slice.map((r) => reportHtml(r, withSource)).join(''));
      if (shown < items.length) {
        container.insertAdjacentHTML('beforeend', `<div class="arch-more"><button class="btn-small" type="button">Mostrar más (${fmtNum(items.length - shown)} restantes)</button></div>`);
        container.querySelector('.arch-more button').addEventListener('click', more);
      }
    }
    more();
  }

  function fetchJson(params) {
    return fetch('/api/novedades-archivadas?' + params.toString()).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `error ${res.status}`);
      return data;
    });
  }

  // --- Resumen y archivos ---
  function loadSummary() {
    fetchJson(new URLSearchParams())
      .then((d) => {
        beyond = d.beyond || 0;
        pageSize = d.pageSize || 200;
        archives = d.archives || [];
        summary.textContent = `La lista principal tiene ${fmtNum(d.total)} novedades. La pantalla de Novedades busca en las ${fmtNum(d.searchable)} más recientes; las ${fmtNum(beyond)} más antiguas se consultan aquí, junto con ${fmtNum(archives.length)} archivo(s) anual(es).`;
        renderFiles();
        loadPage(0);
      })
      .catch((err) => {
        summary.textContent = 'No se pudo cargar: ' + (err.message || 'intenta de nuevo');
      });
  }

  function renderFiles() {
    if (!archives.length) {
      filesEl.innerHTML = '<div class="empty">Todavía no hay archivos anuales. Se crean cuando la limpieza archiva novedades con más de un año.</div>';
      return;
    }
    filesEl.innerHTML = `<table class="arch-files"><tbody>${archives.map((a, i) => `
      <tr data-i="${i}">
        <td>${escapeHtml(a.label)}</td>
        <td>${fmtSize(a.size)}</td>
        <td>
          <button class="btn-small" type="button" data-view="${i}">Ver</button>
          <a class="btn-small" href="/api/blob-file?path=${encodeURIComponent(a.pathname)}" target="_blank" rel="noopener">Descargar</a>
        </td>
      </tr>`).join('')}</tbody></table>`;
    filesEl.querySelectorAll('button[data-view]').forEach((b) => {
      b.addEventListener('click', () => {
        const a = archives[Number(b.getAttribute('data-view'))];
        filesEl.querySelectorAll('tr').forEach((tr) => tr.classList.toggle('active', tr.getAttribute('data-i') === b.getAttribute('data-view')));
        fileItems.style.display = '';
        fileItems.innerHTML = '<div class="empty">Cargando archivo...</div>';
        const params = new URLSearchParams({ source: 'archivo', file: a.pathname });
        if (branchSelect.value) params.set('branch', branchSelect.value);
        fetchJson(params)
          .then((d) => renderInto(fileItems, d.items || [], false))
          .catch((err) => { fileItems.innerHTML = `<div class="empty">No se pudo cargar: ${escapeHtml(err.message)}</div>`; });
      });
    });
  }

  // --- Cola de la lista principal, por páginas ---
  function loadPage(p) {
    page = p;
    list.innerHTML = '<div class="empty">Cargando...</div>';
    const params = new URLSearchParams({ source: 'lista', page: String(page) });
    if (branchSelect.value) params.set('branch', branchSelect.value);
    fetchJson(params)
      .then((d) => {
        const from = page * pageSize + 1;
        pageLabel.textContent = beyond ? `${fmtNum(from)} a ${fmtNum(Math.min(from + pageSize - 1, beyond))} de ${fmtNum(beyond)}` : 'Nada por detrás del tope todavía';
        prevBtn.disabled = page === 0;
        nextBtn.disabled = !d.hasMore;
        renderInto(list, d.items || [], false);
      })
      .catch((err) => { list.innerHTML = `<div class="empty">No se pudo cargar: ${escapeHtml(err.message)}</div>`; });
  }
  prevBtn.addEventListener('click', () => loadPage(Math.max(0, page - 1)));
  nextBtn.addEventListener('click', () => loadPage(page + 1));

  // --- Búsqueda en todo ---
  let searchTimer;
  function runSearch() {
    const q = searchInput.value.trim();
    if (q.length < 3) {
      results.style.display = 'none';
      notice.style.display = 'none';
      listCard.style.display = '';
      return;
    }
    notice.style.display = '';
    notice.textContent = 'Buscando en todo el historial...';
    results.style.display = '';
    results.innerHTML = '';
    listCard.style.display = 'none';
    const params = new URLSearchParams({ q });
    if (branchSelect.value) params.set('branch', branchSelect.value);
    fetchJson(params)
      .then((d) => {
        if (searchInput.value.trim() !== q) return;
        const items = d.items || [];
        notice.textContent = `${fmtNum(items.length)} resultado(s)${d.truncated ? ' (se muestran los 500 más recientes; afina la búsqueda)' : ''} · se revisaron ${fmtNum(d.scannedList)} novedades de la lista y ${fmtNum(d.archivesSearched)} archivo(s).`;
        renderInto(results, items, true);
      })
      .catch((err) => { notice.textContent = 'No se pudo buscar: ' + (err.message || 'intenta de nuevo'); });
  }
  searchInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 400); });
  branchSelect.addEventListener('change', () => { if (searchInput.value.trim().length >= 3) runSearch(); else loadPage(0); });

  loadSummary();
});
