document.addEventListener('DOMContentLoaded', function () {
  const garantiasList = document.getElementById('garantiasList');
  if (!garantiasList) return;

  const garantiasData = document.getElementById('garantiasData');
  const isManager = garantiasData && garantiasData.dataset.isManager === '1';

  const garantiasFile = document.getElementById('garantiasFile');
  const uploadBtn = document.getElementById('uploadBtn');
  const uploadResult = document.getElementById('uploadResult');
  const garantiasStats = document.getElementById('garantiasStats');
  const gBranchFilter = document.getElementById('gBranchFilter');
  const gCategoryFilter = document.getElementById('gCategoryFilter');
  const gOperatorFilter = document.getElementById('gOperatorFilter');

  let allGarantias = [];
  let categories = [];

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
        <div class="item-top"><span class="title">${escapeHtml(op.name)}</span><span class="badge">${op.total} en total</span></div>
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
          <span class="badge status-${g.category.replace(' ', '-')}">${escapeHtml(g.category)}</span>
          ${isManager ? `<span class="badge">${escapeHtml(g.assignedToName)}</span>` : ''}
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
        ${g.note ? `<p class="garantia-note">${escapeHtml(g.note)}</p>` : ''}
        ${g.images && g.images.length ? `
          <div class="garantia-photo">
            ${g.images.map((p) => `<a href="/api/blob-file?path=${encodeURIComponent(p)}" target="_blank" rel="noopener"><img src="/api/blob-file?path=${encodeURIComponent(p)}" alt="Evidencia" loading="lazy" /></a>`).join('')}
          </div>
        ` : ''}
        <div class="garantia-actions">
          <select data-action="category" data-id="${g.id}">
            ${categories.map((c) => `<option value="${c}" ${c === g.category ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
          <input type="text" placeholder="Nota..." data-note-input data-id="${g.id}" value="${escapeHtml(g.note)}" style="flex:1; min-width:160px;" />
          <button class="btn-small" data-action="save-note" data-id="${g.id}" type="button">Guardar nota</button>
          <input type="file" accept="image/*" data-photo-input data-id="${g.id}" style="width:auto;" />
        </div>
      </div>
    `).join('');
  }

  function getFilteredGarantias(raw) {
    if (!isManager) return raw;
    const branch = gBranchFilter ? gBranchFilter.value : '';
    const category = gCategoryFilter ? gCategoryFilter.value : '';
    const operator = gOperatorFilter ? gOperatorFilter.value : '';
    const params = new URLSearchParams();
    if (branch) params.set('branch', branch);
    if (category) params.set('category', category);
    if (operator) params.set('operator', operator);
    return params;
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
    if (isManager) {
      if (gBranchFilter && gBranchFilter.value) params.set('branch', gBranchFilter.value);
      if (gCategoryFilter && gCategoryFilter.value) params.set('category', gCategoryFilter.value);
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
        categories = data.categories || [];
        if (isManager) {
          populateOperatorFilter(allGarantias);
          populateBranchFilter(data.branches || []);
          renderStats(data.stats);
        }
        renderGarantias();
      })
      .catch(() => {
        garantiasList.innerHTML = '<div class="empty">No se pudo cargar (revisa la conexión).</div>';
      });
  }

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
        uploadResult.textContent = `Creadas: ${data.created} · Omitidas: ${data.skipped}. Repartidas — ${perOp}`;
        garantiasFile.value = '';
        loadGarantias();
      })
      .catch((err) => {
        uploadResult.textContent = err.message || 'No se pudo subir el archivo.';
      })
      .finally(() => { uploadBtn.disabled = false; });
  });

  garantiasList.addEventListener('change', function (e) {
    const select = e.target.closest('select[data-action="category"]');
    if (!select) return;
    const id = select.getAttribute('data-id');
    fetch('/api/garantias', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, category: select.value }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'No se pudo actualizar.');
        }
        loadGarantias();
      })
      .catch((err) => alert(err.message || 'No se pudo actualizar.'));
  });

  garantiasList.addEventListener('click', function (e) {
    const saveBtn = e.target.closest('button[data-action="save-note"]');
    if (!saveBtn) return;
    const id = saveBtn.getAttribute('data-id');
    const noteInput = garantiasList.querySelector(`input[data-note-input][data-id="${id}"]`);
    const photoInput = garantiasList.querySelector(`input[data-photo-input][data-id="${id}"]`);
    const file = photoInput && photoInput.files[0];

    const formData = new FormData();
    formData.append('id', id);
    formData.append('note', noteInput ? noteInput.value : '');
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
