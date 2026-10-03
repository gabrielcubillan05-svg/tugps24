document.addEventListener('DOMContentLoaded', function () {
  const sections = document.getElementById('invSections');
  if (!sections) return; // sin permiso

  const data = document.getElementById('inventarioData');
  const scope = JSON.parse((data && data.dataset.scope) || '[]');
  const isAdmin = !!(data && data.dataset.isAdmin);
  const branchSelect = document.getElementById('branchSelect');
  const exportBtn = document.getElementById('exportBtn');
  const invStatus = document.getElementById('invStatus');
  const invStats = document.getElementById('invStats');
  const invSearch = document.getElementById('invSearch');

  const EQUIPO_FIELDS = [
    { key: 'imei', label: 'IMEI', required: true },
    { key: 'sim', label: 'SIM' },
    { key: 'modelo', label: 'Modelo' },
    { key: 'observacion', label: 'Observación' },
  ];
  const SIM_FIELDS = [
    { key: 'serial', label: 'Serial' },
    { key: 'numeroSim', label: 'Número de SIM' },
  ];
  const STALE_HOURS = 24;

  let items = [];
  let meta = {};
  let categories = [];
  let labels = {};
  let editingId = null;
  let query = '';

  function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmtDateTime(iso) {
    return iso ? new Date(iso).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  }

  const SEARCH_FIELDS = ['imei', 'sim', 'modelo', 'observacion', 'serial', 'numeroSim'];

  // Los seriales se dictan con espacios o guiones ("8957 1234-5678"): se comparan sin ellos y
  // sin mayúsculas, así se encuentra escribiendo cualquier pedazo del número.
  function normalizeForSearch(value) {
    return String(value || '').toLowerCase().replace(/[\s\-_.]/g, '');
  }

  function matchesQuery(item) {
    if (!query) return true;
    return SEARCH_FIELDS.some((f) => normalizeForSearch(item[f]).includes(query));
  }

  function highlight(value) {
    const safe = escapeHtml(value);
    if (!query || !value) return safe;
    const raw = String(value);
    const idx = raw.toLowerCase().indexOf(invSearch.value.trim().toLowerCase());
    if (idx < 0 || !invSearch.value.trim()) return `<mark>${safe}</mark>`;
    const len = invSearch.value.trim().length;
    return escapeHtml(raw.slice(0, idx)) + '<mark>' + escapeHtml(raw.slice(idx, idx + len)) + '</mark>' + escapeHtml(raw.slice(idx + len));
  }

  function fieldsFor(category) {
    return category === 'sim' ? SIM_FIELDS : EQUIPO_FIELDS;
  }

  function currentBranch() {
    return branchSelect.value;
  }

  branchSelect.innerHTML = scope.map((b) => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');

  function renderStatus() {
    const m = meta[currentBranch()];
    if (!m) {
      invStatus.innerHTML = `<span class="stamp stale">Esta sucursal todavía no ha registrado su inventario.</span>
        <button class="btn-small" id="confirmBtn" type="button">Confirmar inventario revisado hoy</button>`;
    } else {
      const ageHours = (Date.now() - new Date(m.lastUpdatedAt).getTime()) / 3600000;
      const stale = ageHours > STALE_HOURS;
      invStatus.innerHTML = `<span class="stamp ${stale ? 'stale' : 'fresh'}">Última actualización: ${fmtDateTime(m.lastUpdatedAt)} por ${escapeHtml(m.lastUpdatedByName)}${stale ? ' · lleva más de un día sin actualizar' : ''}</span>
        <button class="btn-small" id="confirmBtn" type="button">Confirmar inventario revisado hoy</button>`;
    }
    const confirmBtn = document.getElementById('confirmBtn');
    confirmBtn.addEventListener('click', function () {
      confirmBtn.disabled = true;
      fetch('/api/inventario', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirm', branch: currentBranch() }),
      })
        .then(async (res) => {
          const d = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(d.error || 'No se pudo confirmar.');
          meta[currentBranch()] = d.meta;
          renderStatus();
        })
        .catch((err) => { alert(err.message || 'No se pudo confirmar.'); confirmBtn.disabled = false; });
    });
  }

  function branchItems(category) {
    return items.filter((i) => i.branch === currentBranch() && (!category || i.category === category));
  }

  function visibleItems(category) {
    return branchItems(category).filter(matchesQuery);
  }

  function renderStats() {
    invStats.innerHTML = categories.map((c) => `
      <div class="stat-box"><span class="n">${branchItems(c).length}</span><span class="l">${escapeHtml(labels[c])}</span></div>
    `).join('');
  }

  function rowInputs(category, item) {
    return fieldsFor(category).map((f) => `
      <td><input type="text" data-field="${f.key}" value="${escapeHtml(item ? item[f.key] : '')}" placeholder="${escapeHtml(f.label)}" ${f.required ? 'required' : ''} /></td>
    `).join('');
  }

  function renderSections() {
    sections.innerHTML = categories.map((c) => {
      const rows = visibleItems(c);
      const fields = fieldsFor(c);
      // Mientras se busca no se muestran tablas vacías ni la fila de agregar.
      if (query && !rows.length) return '';
      return `
        <div class="panel-card inv-section" data-category="${c}">
          <h3>${escapeHtml(labels[c])} <span class="count">${query ? `${rows.length} de ${branchItems(c).length} coincide(n)` : `${rows.length} registro(s)`}</span></h3>
          <div class="table-scroll">
            <table class="inv-table">
              <thead><tr>${fields.map((f) => `<th>${escapeHtml(f.label)}</th>`).join('')}<th class="who">Actualizado</th><th></th></tr></thead>
              <tbody>
                ${rows.map((i) => i.id === editingId ? `
                  <tr data-id="${i.id}">
                    ${rowInputs(c, i)}
                    <td class="who">${fmtDateTime(i.updatedAt)}<br />${escapeHtml(i.updatedByName)}</td>
                    <td class="actions">
                      <button class="btn-small btn-done" data-action="save" data-id="${i.id}" type="button">Guardar</button>
                      <button class="btn-small" data-action="cancel" type="button">Cancelar</button>
                    </td>
                  </tr>` : `
                  <tr data-id="${i.id}">
                    ${fields.map((f) => `<td>${highlight(i[f.key]) || '<span class="hint" style="margin:0;">—</span>'}</td>`).join('')}
                    <td class="who">${fmtDateTime(i.updatedAt)}<br />${escapeHtml(i.updatedByName)}</td>
                    <td class="actions">
                      <select data-action="move" data-id="${i.id}" title="Pasar a otra tabla">
                        ${categories.filter((k) => (k === 'sim') === (c === 'sim')).map((k) => `<option value="${k}" ${k === c ? 'selected' : ''}>${escapeHtml(labels[k])}</option>`).join('')}
                      </select>
                      <button class="btn-small" data-action="edit" data-id="${i.id}" type="button">Editar</button>
                      <button class="btn-small btn-delete" data-action="delete" data-id="${i.id}" type="button">Eliminar</button>
                    </td>
                  </tr>`).join('')}
                ${query ? '' : `<tr class="new-row" data-new="${c}">
                  ${rowInputs(c, null)}
                  <td class="who"></td>
                  <td class="actions"><button class="btn-small btn-done" data-action="add" data-category="${c}" type="button">Agregar</button></td>
                </tr>`}
              </tbody>
            </table>
          </div>
        </div>`;
    }).join('');

    if (query) {
      const total = categories.reduce((n, c) => n + visibleItems(c).length, 0);
      // Si está en otra de las sucursales que esta persona puede ver, se le dice cuál.
      const elsewhere = items.filter((i) => i.branch !== currentBranch() && scope.includes(i.branch) && matchesQuery(i));
      const byBranch = {};
      elsewhere.forEach((i) => { byBranch[i.branch] = (byBranch[i.branch] || 0) + 1; });
      const elsewhereText = Object.keys(byBranch).length
        ? ` También hay ${elsewhere.length} coincidencia(s) en: ${Object.keys(byBranch).map((b) => `<b>${escapeHtml(b)}</b> (${byBranch[b]})`).join(', ')}.`
        : '';
      const note = total
        ? `<p class="inv-search-note"><b>${total}</b> coincidencia(s) en ${escapeHtml(currentBranch())}.${elsewhereText}</p>`
        : `<div class="empty">Nada en ${escapeHtml(currentBranch())} coincide con "${escapeHtml(invSearch.value.trim())}".${elsewhereText}</div>`;
      sections.insertAdjacentHTML('afterbegin', note);
    }
  }

  function renderAll() {
    renderStatus();
    renderStats();
    renderSections();
  }

  function readRow(tr, category) {
    const out = {};
    fieldsFor(category).forEach((f) => {
      const input = tr.querySelector(`input[data-field="${f.key}"]`);
      out[f.key] = input ? input.value.trim() : '';
    });
    return out;
  }

  function load() {
    sections.innerHTML = '<div class="empty">Cargando...</div>';
    fetch('/api/inventario')
      .then((res) => res.json())
      .then((d) => {
        if (!d || !Array.isArray(d.items)) {
          sections.innerHTML = `<div class="empty">No se pudo cargar${d && d.error ? ': ' + escapeHtml(d.error) : ''}.</div>`;
          return;
        }
        items = d.items;
        meta = d.meta || {};
        categories = d.categories || [];
        labels = d.labels || {};
        renderAll();
      })
      .catch(() => {
        sections.innerHTML = '<div class="empty">No se pudo cargar (revisa la conexión).</div>';
      });
  }

  function request(method, body) {
    return fetch('/api/inventario', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async (res) => {
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'No se pudo guardar.');
      if (d.meta) meta[currentBranch()] = d.meta;
      return d;
    });
  }

  sections.addEventListener('click', function (e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    const id = btn.getAttribute('data-id');
    const tr = btn.closest('tr');

    if (action === 'add') {
      const category = btn.getAttribute('data-category');
      const values = readRow(tr, category);
      btn.disabled = true;
      request('POST', { branch: currentBranch(), category, ...values })
        .then((d) => { items.push(d.item); renderAll(); })
        .catch((err) => { alert(err.message); btn.disabled = false; });
    } else if (action === 'edit') {
      editingId = id;
      renderSections();
      const first = sections.querySelector(`tr[data-id="${id}"] input`);
      if (first) first.focus();
    } else if (action === 'cancel') {
      editingId = null;
      renderSections();
    } else if (action === 'save') {
      const item = items.find((i) => i.id === id);
      const values = readRow(tr, item.category);
      btn.disabled = true;
      request('PATCH', { id, ...values })
        .then((d) => {
          const idx = items.findIndex((i) => i.id === id);
          if (idx >= 0) items[idx] = d.item;
          editingId = null;
          renderAll();
        })
        .catch((err) => { alert(err.message); btn.disabled = false; });
    } else if (action === 'delete') {
      const item = items.find((i) => i.id === id);
      const what = item.category === 'sim' ? `la SIM ${item.serial || item.numeroSim}` : `el equipo IMEI ${item.imei}`;
      if (!confirm(`¿Eliminar ${what} del inventario de ${currentBranch()}?`)) return;
      request('DELETE', { id })
        .then(() => { items = items.filter((i) => i.id !== id); renderAll(); })
        .catch((err) => alert(err.message));
    }
  });

  sections.addEventListener('change', function (e) {
    const sel = e.target.closest('select[data-action="move"]');
    if (!sel) return;
    const id = sel.getAttribute('data-id');
    request('PATCH', { id, category: sel.value })
      .then((d) => {
        const idx = items.findIndex((i) => i.id === id);
        if (idx >= 0) items[idx] = d.item;
        renderAll();
      })
      .catch((err) => { alert(err.message); renderSections(); });
  });

  // Enter dentro de la fila nueva agrega; dentro de una fila en edición guarda.
  sections.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
    e.preventDefault();
    const tr = e.target.closest('tr');
    const btn = tr && tr.querySelector('button[data-action="add"], button[data-action="save"]');
    if (btn) btn.click();
  });

  let searchTimer;
  invSearch.addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      query = normalizeForSearch(invSearch.value);
      editingId = null;
      renderSections();
    }, 150);
  });
  invSearch.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      invSearch.value = '';
      query = '';
      renderSections();
    }
  });

  branchSelect.addEventListener('change', function () {
    editingId = null;
    renderAll();
  });

  exportBtn.addEventListener('click', function () {
    const branch = currentBranch();
    const lines = [['Tabla', 'IMEI', 'SIM', 'Modelo', 'Observación', 'Serial', 'Número de SIM', 'Actualizado', 'Por'].join(';')];
    categories.forEach((c) => {
      branchItems(c).forEach((i) => {
        lines.push([labels[c], i.imei, i.sim, i.modelo, i.observacion, i.serial, i.numeroSim, fmtDateTime(i.updatedAt), i.updatedByName]
          .map((v) => '"' + String(v || '').replace(/"/g, '""') + '"').join(';'));
      });
    });
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Inventario-${branch.replace(/\s+/g, '_')}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  });

  load();
});
