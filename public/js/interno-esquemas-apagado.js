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

  function render() {
    const filtered = getFiltered().sort((a, b) => a._marca.localeCompare(b._marca) || a.modelo.localeCompare(b.modelo));
    countEl.textContent = `${filtered.length} de ${records.length} vehículo(s)`;

    if (!filtered.length) {
      grid.innerHTML = '<div class="empty">No hay ningún esquema que coincida con esa búsqueda.</div>';
      return;
    }

    grid.innerHTML = filtered.map((r) => `
      <div class="esquema-card">
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
      </div>
    `).join('');
  }

  let debounceTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(render, 150);
  });
  marcaFilter.addEventListener('change', render);
  tipoFilter.addEventListener('change', render);

  render();
});
