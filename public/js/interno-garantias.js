document.addEventListener('DOMContentLoaded', function () {
  const garantiasList = document.getElementById('garantiasList');
  if (!garantiasList) return;

  const garantiasData = document.getElementById('garantiasData');
  const isManager = garantiasData && garantiasData.dataset.isManager === '1';

  const garantiasFile = document.getElementById('garantiasFile');
  const uploadBtn = document.getElementById('uploadBtn');
  const uploadResult = document.getElementById('uploadResult');
  const garantiasStats = document.getElementById('garantiasStats');
  const gSearchInput = document.getElementById('gSearchInput');
  const gBranchFilter = document.getElementById('gBranchFilter');
  const gCategoryFilter = document.getElementById('gCategoryFilter');
  const gOperatorFilter = document.getElementById('gOperatorFilter');
  const tabButtons = document.querySelectorAll('.tab-btn[data-tab]');
  const tabHint = document.getElementById('tabHint');

  let allGarantias = [];
  let activeTab = 'pendientes';

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

  function waLink(phone) {
    const digits = String(phone).replace(/\D/g, '');
    const withCountry = digits.startsWith('57') ? digits : '57' + digits;
    return 'https://wa.me/' + withCountry;
  }

  function renderStats(stats) {
    if (!garantiasStats) return;
    if (!stats || !stats.byOperator || !Object.keys(stats.byOperator).length) {
      garantiasStats.innerHTML = '<div class="empty">Sin datos todavía.</div>';
      return;
    }
    garantiasStats.innerHTML = Object.values(stats.byOperator).map((op) => `
      <div class="list-item">
        <div class="item-top">
          <span class="title">${escapeHtml(op.name)}</span>
          <span class="badge">${op.total} en total</span>
          <span class="badge status-Pendiente">${op.pendientes} pendiente(s)</span>
          <span class="badge status-Guardado">${op.llamadas} llamada(s)</span>
        </div>
        <div class="meta">${Object.entries(op.byCategory).map(([cat, n]) => `${escapeHtml(cat)}: ${n}`).join(' · ')}</div>
      </div>
    `).join('');
  }

  function renderGarantias() {
    if (!allGarantias.length) {
      garantiasList.innerHTML = '<div class="empty">No hay garantías con esos filtros.</div>';
      return;
    }
    garantiasList.innerHTML = allGarantias.map((g) => `
      <div class="garantia-item" data-id="${g.id}">
        <div class="garantia-top">
          <span class="title">${escapeHtml(g.cliente)}</span>
          <span class="badge ${g.called ? 'status-Guardado' : 'status-Pendiente'}">${g.called ? 'Llamada hecha' : 'Sin llamar'}</span>
          <span class="badge status-${g.category.replace(' ', '-')}">${escapeHtml(g.category)}</span>
          ${isManager ? `<span class="badge">${escapeHtml(g.assignedToName)}</span>` : ''}
          ${g.homeAssignedToName && g.homeAssignedToName !== g.assignedToName ? `<span class="badge" title="Titular original, reasignada por día libre">Titular: ${escapeHtml(g.homeAssignedToName)}</span>` : ''}
        </div>
        <div class="garantia-meta">
          <a href="${waLink(g.telefono)}" target="_blank" rel="noopener">WhatsApp (${escapeHtml(g.telefono)})</a>
          ${g.placa ? ` · Placa: ${escapeHtml(g.placa)}` : ''}
          ${g.branch ? ` · ${escapeHtml(g.branch)}` : ''}
          ${g.vehicleType ? ` · ${escapeHtml(g.vehicleType)}` : ''}
          ${g.ultTransmision ? ` · Última transmisión: ${fmtDate(g.ultTransmision)}` : ''}
        </div>
        ${g.modeloGps || g.imei || g.tarjetaSim ? `
          <div class="garantia-meta">
            ${g.modeloGps ? `GPS: ${escapeHtml(g.modeloGps)}` : ''}${g.imei ? ` · IMEI: ${escapeHtml(g.imei)}` : ''}${g.tarjetaSim ? ` · SIM: ${escapeHtml(g.tarjetaSim)}` : ''}
          </div>
        ` : ''}
        ${g.history && g.history.length ? `
          <div class="garantia-history">
            ${g.history.map((h) => `<div class="garantia-history-item"><span class="garantia-history-meta">${fmtDate(h.date)} · ${escapeHtml(h.by)} · ${escapeHtml(h.category)}</span>${escapeHtml(h.note)}</div>`).join('')}
          </div>
        ` : ''}
        ${g.images && g.images.length ? `
          <div class="garantia-photo">
            ${g.images.map((p) => `<a href="/api/blob-file?path=${encodeURIComponent(p)}" target="_blank" rel="noopener"><img src="/api/blob-file?path=${encodeURIComponent(p)}" alt="Evidencia" loading="lazy" /></a>`).join('')}
          </div>
        ` : ''}
        <div class="garantia-actions">
          <select data-role="category-input" data-id="${g.id}">
            ${window.__garantiaCategories.map((c) => `<option value="${c}" ${c === g.category ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
          <input type="text" placeholder="Nota (obligatoria)..." data-note-input data-id="${g.id}" style="flex:1; min-width:160px;" />
          <button class="btn-small" data-action="save-note" data-id="${g.id}" type="button">Guardar nota</button>
          <input type="file" accept="image/*" data-photo-input data-id="${g.id}" style="width:auto;" />
        </div>
      </div>
    `).join('');
  }

  function populateOperatorFilter(garantias) {
    if (!gOperatorFilter) return;
    const seen = new Map();
    garantias.forEach((g) => { if (g.assignedToId) seen.set(g.assignedToId, g.assignedToName); });
    const current = gOperatorFilter.value;
    gOperatorFilter.innerHTML = '<option value="">Todos los operadores</option>' +
      [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => `<option value="${id}">${escapeHtml(name)}</option>`).join('');
    gOperatorFilter.value = current;
  }

  function populateBranchFilter(branches) {
    if (!gBranchFilter) return;
    const current = gBranchFilter.value;
    gBranchFilter.innerHTML = '<option value="">Todas las sucursales</option>' +
      branches.map((b) => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');
    gBranchFilter.value = current;
  }

  function loadGarantias() {
    const params = new URLSearchParams();
    if (gSearchInput && gSearchInput.value.trim()) params.set('q', gSearchInput.value.trim());
    params.set('tab', activeTab);
    if (activeTab === 'llamadas' && gCategoryFilter && gCategoryFilter.value) {
      params.set('category', gCategoryFilter.value);
    }
    if (isManager) {
      if (gBranchFilter && gBranchFilter.value) params.set('branch', gBranchFilter.value);
      if (gOperatorFilter && gOperatorFilter.value) params.set('operator', gOperatorFilter.value);
    }
    fetch('/api/garantias?' + params.toString())
      .then((res) => res.json())
      .then((data) => {
        if (!data || !Array.isArray(data.garantias)) {
          garantiasList.innerHTML = '<div class="empty">No se pudo cargar.</div>';
          return;
        }
        allGarantias = data.garantias;
        window.__garantiaCategories = data.categories || [];
        if (isManager) {
          populateOperatorFilter(data.garantias);
          populateBranchFilter(data.branches || []);
          renderStats(data.stats);
        }
        renderGarantias();
      })
      .catch(() => {
        garantiasList.innerHTML = '<div class="empty">No se pudo cargar (revisa la conexión).</div>';
      });
  }

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', function () {
      tabButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      activeTab = btn.getAttribute('data-tab');
      if (gCategoryFilter) gCategoryFilter.hidden = activeTab !== 'llamadas';
      if (tabHint) {
        tabHint.textContent = activeTab === 'pendientes'
          ? 'Las más viejas primero — resuelve esas antes que las de una carga más reciente.'
          : 'Busca por placa o cliente para ver la información de una llamada ya hecha.';
      }
      loadGarantias();
    });
  });

  let searchDebounce;
  if (gSearchInput) gSearchInput.addEventListener('input', function () {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(loadGarantias, 300);
  });
  if (gBranchFilter) gBranchFilter.addEventListener('change', loadGarantias);
  if (gCategoryFilter) gCategoryFilter.addEventListener('change', loadGarantias);
  if (gOperatorFilter) gOperatorFilter.addEventListener('change', loadGarantias);

  if (uploadBtn) uploadBtn.addEventListener('click', function () {
    const file = garantiasFile.files[0];
    if (!file) {
      alert('Selecciona un archivo primero.');
      return;
    }
    uploadBtn.disabled = true;
    uploadResult.style.display = 'block';
    uploadResult.textContent = 'Subiendo y repartiendo...';
    const formData = new FormData();
    formData.append('file', file);
    fetch('/api/garantias', { method: 'POST', body: formData })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo subir el archivo.');
        const perOp = Object.entries(data.perOperator || {}).map(([n, c]) => `${n}: ${c}`).join(' · ');
        uploadResult.textContent = `Nuevas: ${data.created} · Reingresadas: ${data.reactivated} · Omitidas: ${data.skipped}. Repartidas — ${perOp}`;
        garantiasFile.value = '';
        loadGarantias();
      })
      .catch((err) => {
        uploadResult.textContent = err.message || 'No se pudo subir el archivo.';
      })
      .finally(() => { uploadBtn.disabled = false; });
  });

  garantiasList.addEventListener('click', function (e) {
    const saveBtn = e.target.closest('button[data-action="save-note"]');
    if (!saveBtn) return;
    const id = saveBtn.getAttribute('data-id');
    const categorySelect = garantiasList.querySelector(`select[data-role="category-input"][data-id="${id}"]`);
    const noteInput = garantiasList.querySelector(`input[data-note-input][data-id="${id}"]`);
    const photoInput = garantiasList.querySelector(`input[data-photo-input][data-id="${id}"]`);
    const file = photoInput && photoInput.files[0];
    const noteValue = noteInput ? noteInput.value.trim() : '';

    if (!noteValue) {
      alert('La nota es obligatoria para guardar — cuenta qué pasó en la llamada.');
      return;
    }

    const formData = new FormData();
    formData.append('id', id);
    formData.append('category', categorySelect ? categorySelect.value : '');
    formData.append('note', noteValue);
    if (file) formData.append('images', file);

    saveBtn.disabled = true;
    fetch('/api/garantias', { method: 'PATCH', body: formData })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo guardar.');
        loadGarantias();
      })
      .catch((err) => alert(err.message || 'No se pudo guardar.'))
      .finally(() => { saveBtn.disabled = false; });
  });

  loadGarantias();
});
