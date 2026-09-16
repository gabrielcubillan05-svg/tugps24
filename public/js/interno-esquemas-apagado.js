document.addEventListener('DOMContentLoaded', function () {
  const grid = document.getElementById('esquemasGrid');
  if (!grid) return;

  const dataEl = document.getElementById('esquemasData');
  const records = JSON.parse((dataEl && dataEl.dataset.records) || '[]');
  const searchInput = document.getElementById('searchInput');
  const marcaFilter = document.getElementById('marcaFilter');
  const tipoFilter = document.getElementById('tipoFilter');
  const countEl = document.getElementById('esquemasCount');

  // La planilla original trae variaciones de mayúsculas y algunos typos de digitación en la
  // marca (ej. "Biuik"/"Hundai") — se agrupan aquí para que el filtro no las trate como marcas
  // distintas, sin tocar el archivo de datos original.
  const BRAND_ALIASES = {
    biuik: 'Buick',
    cadilac: 'Cadillac',
    donge: 'Dodge',
    chryler: 'Chrysler',
    freigtliner: 'Freightliner',
    hundai: 'Hyundai',
    lincon: 'Lincoln',
    mercedez: 'Mercedes',
    peuegot: 'Peugeot',
    renaul: 'Renault',
    suzuky: 'Suzuki',
    internacional: 'International',
  };

  function canonicalBrand(raw) {
    const key = String(raw || '').trim().toLowerCase();
    if (!key) return '';
    if (BRAND_ALIASES[key]) return BRAND_ALIASES[key];
    return key.charAt(0).toUpperCase() + key.slice(1);
  }

  function normalize(str) {
    return String(str || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase();
  }

  const COLOR_MAP = {
    amarillo: '#f0c419', amarilla: '#f0c419',
    azul: '#2f6fed', azulceleste: '#7ec8e3', celeste: '#7ec8e3', cielo: '#7ec8e3',
    blanco: '#f2f2ee', blanca: '#f2f2ee', blancos: '#f2f2ee',
    cafe: '#6b4423',
    crema: '#f0e6d2',
    durazno: '#f4b183',
    gris: '#9a9a9a', grises: '#9a9a9a', cris: '#9a9a9a', grices: '#9a9a9a',
    menta: '#98d8c8',
    morado: '#7b2d8b', morada: '#7b2d8b',
    naranja: '#ff7a1a',
    negro: '#1a1a1a', negra: '#1a1a1a', begro: '#1a1a1a', pnegro: '#1a1a1a',
    plata: '#c0c0c0', plateado: '#c0c0c0',
    rojo: '#e0392f', roja: '#e0392f',
    rosa: '#ff9ec4', rosado: '#ff9ec4', pin: '#ff9ec4',
    verde: '#2f8a4f',
    violeta: '#8a4fd6',
  };

  function colorSwatch(colores) {
    const words = normalize(colores).split(/[^a-z]+/).filter(Boolean);
    const hexes = [];
    for (const w of words) {
      if (COLOR_MAP[w] && !hexes.includes(COLOR_MAP[w])) hexes.push(COLOR_MAP[w]);
      if (hexes.length >= 2) break;
    }
    if (!hexes.length) return '';
    if (hexes.length === 1) hexes.push(hexes[0]);
    return `<span class="esquema-swatch">${hexes.map((h) => `<span style="background:${h}"></span>`).join('')}</span>`;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Precalcular una sola vez: marca canónica y texto de búsqueda combinado por registro.
  records.forEach((r) => {
    r._marca = canonicalBrand(r.marca);
    r._search = normalize([r.marca, r.modelo, r.anio, r.colores, r.ubicacion].join(' '));
  });

  const marcas = [...new Set(records.map((r) => r._marca).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  marcaFilter.innerHTML = '<option value="">Todas las marcas</option>' +
    marcas.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');

  function getFiltered() {
    const q = normalize(searchInput.value.trim());
    const marca = marcaFilter.value;
    const tipo = tipoFilter.value;
    return records.filter((r) => {
      if (q && !r._search.includes(q)) return false;
      if (marca && r._marca !== marca) return false;
      if (tipo === 'bomba' && !r.corteBomba) return false;
      if (tipo === 'ignicion' && !r.corteIgnicion) return false;
      return true;
    });
  }

  let editingId = null;

  function editFormHtml(r) {
    return `
      <div class="esquema-card esquema-card-editing" data-id="${r.id}">
        <div class="esquema-form" style="flex-direction:column;">
          <input name="marca" type="text" placeholder="Marca *" value="${escapeHtml(r.marca)}" required />
          <input name="modelo" type="text" placeholder="Modelo *" value="${escapeHtml(r.modelo)}" required />
          <input name="anio" type="text" placeholder="Año" value="${escapeHtml(r.anio)}" />
          <input name="colores" type="text" placeholder="Colores de cable" value="${escapeHtml(r.colores)}" />
          <label class="esquema-check"><input name="corteBomba" type="checkbox" ${r.corteBomba ? 'checked' : ''} /> Corte de bomba</label>
          <label class="esquema-check"><input name="corteIgnicion" type="checkbox" ${r.corteIgnicion ? 'checked' : ''} /> Corte de ignición</label>
          <textarea name="ubicacion" placeholder="Ubicación / detalle" rows="2">${escapeHtml(r.ubicacion)}</textarea>
          <div style="display:flex; gap:8px;">
            <button class="btn-small btn-done" data-action="save-edit" data-id="${r.id}" type="button">Guardar</button>
            <button class="btn-small" data-action="cancel-edit" type="button">Cancelar</button>
          </div>
          <span class="esquema-add-msg" data-edit-msg></span>
        </div>
      </div>
    `;
  }

  function render() {
    const filtered = getFiltered().sort((a, b) => a._marca.localeCompare(b._marca) || a.modelo.localeCompare(b.modelo));
    countEl.textContent = `${filtered.length} de ${records.length} vehículo(s)`;

    if (!filtered.length) {
      grid.innerHTML = '<div class="empty">No hay ningún esquema que coincida con esa búsqueda.</div>';
      return;
    }

    grid.innerHTML = filtered.map((r) => {
      if (r.id === editingId) return editFormHtml(r);
      return `
      <div class="esquema-card" data-id="${r.id}">
        <div class="esquema-top">
          <div>
            <div class="esquema-marca">${escapeHtml(r._marca)}</div>
            <div class="esquema-modelo">${escapeHtml(r.modelo)}</div>
          </div>
          ${r.anio ? `<span class="esquema-anio">${escapeHtml(r.anio)}</span>` : ''}
        </div>
        <div class="esquema-badges">
          ${r.corteBomba ? '<span class="esquema-badge bomba">Corte de bomba</span>' : ''}
          ${r.corteIgnicion ? '<span class="esquema-badge ignicion">Corte de ignición</span>' : ''}
        </div>
        ${r.colores ? `
          <div class="esquema-colores">
            ${colorSwatch(r.colores)}
            <span class="esquema-colores-text">${escapeHtml(r.colores)}</span>
          </div>
        ` : ''}
        ${r.ubicacion ? `<div class="esquema-ubicacion"><strong>Ubicación:</strong> ${escapeHtml(r.ubicacion)}</div>` : ''}
        <div class="item-actions">
          <button class="btn-small" data-action="edit" data-id="${r.id}" type="button">Editar</button>
        </div>
      </div>
    `;
    }).join('');
  }

  let debounceTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(render, 150);
  });
  marcaFilter.addEventListener('change', render);
  tipoFilter.addEventListener('change', render);

  grid.addEventListener('click', async (e) => {
    const editBtn = e.target.closest('button[data-action="edit"]');
    if (editBtn) {
      editingId = editBtn.getAttribute('data-id');
      render();
      return;
    }
    const cancelBtn = e.target.closest('button[data-action="cancel-edit"]');
    if (cancelBtn) {
      editingId = null;
      render();
      return;
    }
    const saveBtn = e.target.closest('button[data-action="save-edit"]');
    if (saveBtn) {
      const id = saveBtn.getAttribute('data-id');
      const card = saveBtn.closest('.esquema-card-editing');
      const msgEl = card.querySelector('[data-edit-msg]');
      const fields = {
        marca: card.querySelector('[name="marca"]').value.trim(),
        modelo: card.querySelector('[name="modelo"]').value.trim(),
        anio: card.querySelector('[name="anio"]').value.trim(),
        colores: card.querySelector('[name="colores"]').value.trim(),
        ubicacion: card.querySelector('[name="ubicacion"]').value.trim(),
        corteBomba: card.querySelector('[name="corteBomba"]').checked,
        corteIgnicion: card.querySelector('[name="corteIgnicion"]').checked,
      };
      if (!fields.marca || !fields.modelo) {
        msgEl.textContent = 'Marca y modelo son obligatorios.';
        msgEl.classList.add('error');
        return;
      }
      try {
        const res = await fetch('/api/vehicle-cutoff', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, fields }),
        });
        const data = await res.json();
        if (!res.ok) {
          msgEl.textContent = data.error || 'No se pudo guardar.';
          msgEl.classList.add('error');
          return;
        }
        const record = records.find((r) => r.id === id);
        Object.assign(record, fields);
        record._marca = canonicalBrand(record.marca);
        record._search = normalize([record.marca, record.modelo, record.anio, record.colores, record.ubicacion].join(' '));
        if (!marcas.includes(record._marca)) {
          marcas.push(record._marca);
          marcas.sort((a, b) => a.localeCompare(b));
          marcaFilter.innerHTML = '<option value="">Todas las marcas</option>' +
            marcas.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
        }
        editingId = null;
        render();
      } catch {
        msgEl.textContent = 'Error de conexión al guardar.';
        msgEl.classList.add('error');
      }
    }
  });

  render();

  const addForm = document.getElementById('addEsquemaForm');
  if (addForm) {
    const msgEl = document.getElementById('addEsquemaMsg');
    addForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      msgEl.textContent = '';
      msgEl.classList.remove('error');
      const fd = new FormData(addForm);
      const body = {
        marca: fd.get('marca'),
        modelo: fd.get('modelo'),
        anio: fd.get('anio'),
        colores: fd.get('colores'),
        ubicacion: fd.get('ubicacion'),
        corteBomba: fd.get('corteBomba') === 'on',
        corteIgnicion: fd.get('corteIgnicion') === 'on',
      };
      try {
        const res = await fetch('/api/vehicle-cutoff', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
          msgEl.textContent = data.error || 'No se pudo guardar el esquema.';
          msgEl.classList.add('error');
          return;
        }
        const entry = data.entry;
        entry._marca = canonicalBrand(entry.marca);
        entry._search = normalize([entry.marca, entry.modelo, entry.anio, entry.colores, entry.ubicacion].join(' '));
        records.push(entry);
        if (!marcas.includes(entry._marca)) {
          marcas.push(entry._marca);
          marcas.sort((a, b) => a.localeCompare(b));
          marcaFilter.innerHTML = '<option value="">Todas las marcas</option>' +
            marcas.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
        }
        addForm.reset();
        msgEl.textContent = 'Esquema guardado.';
        render();
      } catch {
        msgEl.textContent = 'Error de conexión al guardar.';
        msgEl.classList.add('error');
      }
    });
  }
});
