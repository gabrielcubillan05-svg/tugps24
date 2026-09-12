document.addEventListener('DOMContentLoaded', function () {
  const leadsList = document.getElementById('leadsList');
  if (!leadsList) return; // no autenticado

  const crmData = document.getElementById('crmData');
  const STATUSES = JSON.parse((crmData && crmData.dataset.statuses) || '[]');
  const BRANCHES = JSON.parse((crmData && crmData.dataset.branches) || '[]');
  const CAMPAIGNS = JSON.parse((crmData && crmData.dataset.campaigns) || '[]');
  const canManageMedia = !!(crmData && crmData.dataset.canManageMedia);
  const canSetStatus = !!(crmData && crmData.dataset.canSetStatus);
  const isAdmin = !!(crmData && crmData.dataset.isAdmin);
  const currentRole = (crmData && crmData.dataset.role) || '';
  const currentUserName = (crmData && crmData.dataset.userName) || '';

  const statsRow = document.getElementById('statsRow');
  const leadForm = document.getElementById('leadForm');
  const searchInput = document.getElementById('searchInput');
  const cityFilter = document.getElementById('cityFilter');
  const secretaryFilter = document.getElementById('secretaryFilter');
  const statusFilter = document.getElementById('statusFilter');
  const vehicleTypeFilter = document.getElementById('vehicleTypeFilter');
  const monthFilter = document.getElementById('monthFilter');
  const overdueFilter = document.getElementById('overdueFilter');
  const dateFromFilter = document.getElementById('dateFromFilter');
  const dateToFilter = document.getElementById('dateToFilter');
  const filteredCount = document.getElementById('filteredCount');
  const exportBtn = document.getElementById('exportBtn');
  const leadsBoard = document.getElementById('leadsBoard');
  const resultsPanel = document.getElementById('resultsPanel');

  const WA_TEMPLATES = {
    first: (name) => `Hola ${name}, *bienvenido a TuGPS24* ✓

*10 años* protegiendo lo que más te importa. Más de *1.650 vehículos recuperados* nos respaldan.

Esto es lo que obtienes con nosotros:
✓ Ubicación en tiempo real desde tu celular
✓ Apagado remoto del motor, con o sin llave
✓ Enlace directo con la Policía si hay un robo
✓ Reportes de recorrido y kilometraje
✓ Central de monitoreo 24/7 con operadores reales
✓ Cobertura en todo el país
✓ Mantenimiento preventivo cada 6 meses, sin costo

Te comparto unas fotos de nuestro trabajo. *¡Instala hoy y protege tu inversión!*`,
    quote: (name) => `Hola ${name}, te escribo de TuGPS24 para saber si pudiste revisar la cotización que te enviamos. Cualquier duda con gusto te ayudo.`,
    install: (name) => `Hola ${name}, ¿cómo estás? Te escribimos de TuGPS24 para confirmar los detalles de la instalación de tu GPS. ¿Qué día y hora te queda mejor?`,
    followup: (name) => `Hola ${name}, ¿cómo vas? Quería hacer seguimiento a tu interés en el servicio de GPS de TuGPS24. Cuéntame si tienes alguna pregunta o si quieres que avancemos.`,
  };

  function downloadMediaAssetsForWhatsApp() {
    // WhatsApp no permite adjuntar archivos automáticamente desde un enlace: esto deja
    // las fotos ya descargadas y los videos abiertos, listos para arrastrar al chat que se abrió.
    fetch('/api/media-assets')
      .then((res) => res.json())
      .then((data) => {
        const assets = (data && data.assets) || [];
        assets.forEach((a) => {
          if (a.kind === 'image') {
            const link = document.createElement('a');
            link.href = a.url;
            link.download = (a.label || 'foto').replace(/[^a-zA-Z0-9]/g, '_');
            document.body.appendChild(link);
            link.click();
            link.remove();
          } else if (a.kind === 'link') {
            window.open(a.url, '_blank', 'noopener');
          }
        });
      })
      .catch(() => {});
  }

  let allLeads = [];
  let secretaryOptions = [];

  function loadSecretaries() {
    return fetch('/api/users?role=secretaria,gerente')
      .then((res) => res.json())
      .then((data) => {
        if (!data || !Array.isArray(data.users)) return;
        secretaryOptions = data.users;
      })
      .catch(() => {});
  }

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

  function waLink(phone, text) {
    const digits = String(phone).replace(/\D/g, '');
    const withCountry = digits.startsWith('57') ? digits : '57' + digits;
    return 'https://wa.me/' + withCountry + (text ? '?text=' + encodeURIComponent(text) : '');
  }

  // WhatsApp todavía no soporta abrir un chat por enlace usando el usuario (solo por
  // número), así que distinguimos: si trae letras es un usuario, no un teléfono real.
  function isPhoneLike(value) {
    return /^[\d\s+().-]+$/.test(String(value || '').trim()) && String(value).replace(/\D/g, '').length >= 7;
  }

  function isCold(l) {
    if (l.notes && l.notes.length) return false;
    if (l.status === 'Instalado' || l.status === 'Perdido') return false;
    const ageHours = (Date.now() - new Date(l.createdAt).getTime()) / 3600000;
    return ageHours > 24;
  }

  function computeStats(leads) {
    const byStatus = {};
    STATUSES.forEach((s) => { byStatus[s] = 0; });
    leads.forEach((l) => { byStatus[l.status] = (byStatus[l.status] || 0) + 1; });
    return {
      total: leads.length,
      byStatus,
      overdueCount: leads.filter((l) => l.overdue).length,
    };
  }

  function renderStats(stats) {
    const boxes = STATUSES.map((s) => `
      <div class="stat-box">
        <span class="n">${stats.byStatus[s] || 0}</span>
        <span class="l">${escapeHtml(s)}</span>
      </div>
    `).join('');
    statsRow.innerHTML = `
      <div class="stat-box"><span class="n">${stats.total}</span><span class="l">Total</span></div>
      ${boxes}
      <div class="stat-box overdue"><span class="n">${stats.overdueCount}</span><span class="l">Atrasados</span></div>
    `;
  }

  const MONTH_NAMES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  function monthLabel(ym) {
    const [y, m] = ym.split('-');
    const name = MONTH_NAMES[parseInt(m, 10) - 1] || ym;
    return name.charAt(0).toUpperCase() + name.slice(1) + ' ' + y;
  }

  function normalizeForMatch(str) {
    return String(str || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
  }

  let defaultSecretaryApplied = false;

  function populateDynamicFilters(leads) {
    const cities = [...new Set(leads.map((l) => l.city).filter(Boolean))].sort();
    const secretaries = [...new Set(leads.map((l) => l.secretary).filter(Boolean))].sort();
    const months = [...new Set(leads.map((l) => (l.createdAt || '').slice(0, 7)).filter(Boolean))].sort().reverse();

    const currentCity = cityFilter.value;
    cityFilter.innerHTML = '<option value="">Todas las ciudades</option>' +
      cities.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    cityFilter.value = currentCity;

    const currentSec = secretaryFilter.value;
    secretaryFilter.innerHTML = '<option value="">Todas las secretarias</option>' +
      secretaries.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    secretaryFilter.value = currentSec;

    // A una secretaria se le precarga su propia cola al entrar, para que no tenga que
    // buscarse cada vez — puede cambiarlo, no es una restricción de acceso.
    if (!defaultSecretaryApplied && currentRole === 'secretaria' && !currentSec) {
      const myFirstName = normalizeForMatch(currentUserName).split(/\s+/)[0];
      const match = secretaries.find((s) => normalizeForMatch(s).split(/\s+/)[0] === myFirstName);
      if (match) {
        secretaryFilter.value = match;
        defaultSecretaryApplied = true;
      }
    }

    const currentMonth = monthFilter.value;
    monthFilter.innerHTML = '<option value="">Todos los meses</option>' +
      months.map((m) => `<option value="${m}">${escapeHtml(monthLabel(m))}</option>`).join('');
    monthFilter.value = currentMonth;
  }

  // includeQuery=false se usa para el tablero, que a propósito NO reacciona al texto de
  // búsqueda (solo a los filtros de selección) — así escribir en el buscador no obliga a
  // reconstruir las tarjetas de todas las columnas en cada tecla.
  function getFilteredLeads(includeQuery) {
    if (includeQuery === undefined) includeQuery = true;
    const q = includeQuery ? searchInput.value.trim().toLowerCase() : '';
    const city = cityFilter.value;
    const secretary = secretaryFilter.value;
    const status = statusFilter.value;
    const vehicleType = vehicleTypeFilter.value;
    const month = monthFilter.value;
    const onlyOverdue = overdueFilter.checked;
    const dateFrom = dateFromFilter.value;
    const dateTo = dateToFilter.value;

    return allLeads.filter((l) => {
      if (q) {
        const notesText = (l.notes || []).map((n) => n.text).join(' ').toLowerCase();
        const matches = l.name.toLowerCase().includes(q) || l.phone.toLowerCase().includes(q)
          || (l.campaign || '').toLowerCase().includes(q) || notesText.includes(q);
        if (!matches) return false;
      }
      if (city && l.city !== city) return false;
      if (secretary && l.secretary !== secretary) return false;
      if (status && l.status !== status) return false;
      if (vehicleType && l.vehicleType !== vehicleType) return false;
      if (month && (l.createdAt || '').slice(0, 7) !== month) return false;
      if (onlyOverdue && !l.overdue) return false;
      if (dateFrom || dateTo) {
        const created = l.createdAt ? l.createdAt.slice(0, 10) : '';
        if (!created) return false;
        if (dateFrom && created < dateFrom) return false;
        if (dateTo && created > dateTo) return false;
      }
      return true;
    });
  }

  let editingId = null;
  let editError = '';

  function renderEditForm(l) {
    return `
      <div class="lead-item" data-id="${l.id}">
        <div class="form-grid">
          <div class="field">
            <label>Nombre</label>
            <input type="text" data-edit="name" value="${escapeHtml(l.name)}" />
          </div>
          <div class="field">
            <label>Teléfono o usuario de WhatsApp</label>
            <input type="text" data-edit="phone" value="${escapeHtml(l.phone)}" />
          </div>
          <div class="field">
            <label>Ciudad</label>
            <select data-edit="city">
              <option value="">Selecciona una ciudad</option>
              ${BRANCHES.map((b) => `<option value="${b}" ${b === l.city ? 'selected' : ''}>${b}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>¿De dónde viene?</label>
            <select data-edit="campaign">
              <option value="" ${!l.campaign ? 'selected' : ''}>Sin definir</option>
              ${CAMPAIGNS.map((c) => `<option value="${c}" ${c === l.campaign ? 'selected' : ''}>${c}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>Cantidad de motos</label>
            <input type="number" min="0" data-edit="motosCount" value="${l.motosCount || 0}" />
          </div>
          <div class="field">
            <label>Cantidad de carros</label>
            <input type="number" min="0" data-edit="carrosCount" value="${l.carrosCount || 0}" />
          </div>
          <div class="field">
            <label>Responsable</label>
            <select data-edit="secretary">
              <option value="">Sin asignar</option>
              ${secretaryOptions.map((u) => `<option value="${escapeHtml(u.name)}" ${u.name === l.secretary ? 'selected' : ''}>${escapeHtml(u.name)}${u.role === 'gerente' ? ' (Gerente)' : ''}</option>`).join('')}
              ${l.secretary && !secretaryOptions.some((u) => u.name === l.secretary) ? `<option value="${escapeHtml(l.secretary)}" selected>${escapeHtml(l.secretary)}</option>` : ''}
            </select>
          </div>
        </div>
        ${editError ? `<p class="error-msg">${escapeHtml(editError)}</p>` : ''}
        <div class="lead-controls">
          <button class="btn-small btn-done" data-action="save-edit" data-id="${l.id}" type="button">Guardar cambios</button>
          <button class="btn-small" data-action="cancel-edit" data-id="${l.id}" type="button">Cancelar</button>
        </div>
      </div>
    `;
  }

  // Buscar por números (ej. "300") coincide con el teléfono de muchísimos leads a la vez —
  // sin este tope, terminaría construyendo miles de tarjetas de golpe en cada tecla. Se
  // avisa cuando se recorta, para que la persona afine la búsqueda si de verdad necesita ver
  // más de estos.
  const MAX_RENDERED_LEADS = 150;

  function renderLeads(leads) {
    if (!leads.length) {
      leadsList.innerHTML = '<div class="empty">No hay leads con esos filtros.</div>';
      return;
    }

    const truncated = leads.length > MAX_RENDERED_LEADS;
    const toRender = truncated ? leads.slice(0, MAX_RENDERED_LEADS) : leads;
    const notice = truncated
      ? `<div class="empty">Mostrando los primeros ${MAX_RENDERED_LEADS} de ${leads.length} resultados — escribe más para afinar la búsqueda.</div>`
      : '';

    leadsList.innerHTML = notice + toRender.map((l) => {
      if (l.id === editingId) return renderEditForm(l);
      return `
      <div class="lead-item ${l.overdue ? 'overdue' : ''}" data-id="${l.id}">
        <div class="lead-top">
          <span class="lead-name">${escapeHtml(l.name)}</span>
          <span class="badge ${l.status}">${escapeHtml(l.status)}</span>
          ${l.overdue ? '<span class="badge overdue-badge">Atrasado</span>' : ''}
          ${l.installed ? '<span class="badge badge-installed">✓ Instalado</span>' : ''}
          ${l.installed && l.verifiedInstalled ? '<span class="badge badge-verified">✓ Verificado por orden</span>' : ''}
          ${l.installed && !l.verifiedInstalled ? '<span class="badge badge-unverified">⚠ Sin verificar</span>' : ''}
          ${!l.installed && l.verifiedInstalled ? '<span class="badge badge-verified">Orden verificada (falta marcar)</span>' : ''}
          ${isCold(l) ? '<span class="badge badge-cold">Sin contactar</span>' : ''}
          ${l.source === 'meta-leadgen' ? '<span class="badge badge-meta">Meta</span>' : ''}
        </div>
        <div class="lead-meta">
          ${escapeHtml(l.phone)} ${l.city ? '· ' + escapeHtml(l.city) : ''} ${l.campaign ? '· ' + escapeHtml(l.campaign) : ''}
          ${l.secretary ? '· Secretaria: ' + escapeHtml(l.secretary) : ''}
          ${l.vehicleType ? '· ' + escapeHtml(l.vehicleType) + (l.motosCount || l.carrosCount ? ' (' + [l.motosCount ? l.motosCount + ' moto(s)' : '', l.carrosCount ? l.carrosCount + ' carro(s)' : ''].filter(Boolean).join(', ') + ')' : '') : ''}
        </div>
        ${l.createdByName ? `<div class="lead-added-by">Agregado por: ${escapeHtml(l.createdByName)}${l.createdAt ? ' · ' + new Date(l.createdAt).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }) : ''}</div>` : ''}
        <div class="lead-controls">
          ${isPhoneLike(l.phone)
            ? `<a class="btn-small btn-wa" href="${waLink(l.phone)}" target="_blank" rel="noopener">WhatsApp</a>`
            : `<span class="btn-small" title="Es un usuario de WhatsApp, no un teléfono. WhatsApp aún no permite abrir el chat por enlace usando el usuario, búscalo manualmente.">WhatsApp: ${escapeHtml(l.phone)}</span>`}
          <select class="wa-select" data-action="wa-template" data-id="${l.id}">
            <option value="">Mensaje rápido...</option>
            <option value="first">Primer contacto</option>
            <option value="quote">Recordatorio cotización</option>
            <option value="install">Confirmar instalación</option>
            <option value="followup">Seguimiento</option>
          </select>
          <label class="date-field" title="Próxima llamada de seguimiento">
            <span>Próxima llamada</span>
            <input type="date" data-action="followup" data-id="${l.id}" value="${l.nextFollowUp ? l.nextFollowUp.slice(0, 10) : ''}" />
          </label>
          <label class="date-field" title="Fecha de instalación agendada">
            <span>Instalación agendada</span>
            <input type="date" data-action="scheduledInstall" data-id="${l.id}" value="${l.scheduledInstallDate ? l.scheduledInstallDate.slice(0, 10) : ''}" />
          </label>
          <select data-action="vehicleType" data-id="${l.id}" title="Tipo de cliente">
            <option value="" ${!l.vehicleType ? 'selected' : ''}>Sin definir</option>
            <option value="Moto" ${l.vehicleType === 'Moto' ? 'selected' : ''}>Moto</option>
            <option value="Carro" ${l.vehicleType === 'Carro' ? 'selected' : ''}>Carro</option>
            <option value="Flota" ${l.vehicleType === 'Flota' ? 'selected' : ''}>Flota</option>
            <option value="Máquina Amarilla" ${l.vehicleType === 'Máquina Amarilla' ? 'selected' : ''}>Máquina Amarilla</option>
          </select>
          <button class="btn-small" data-action="edit" data-id="${l.id}" type="button">Editar</button>
          <button class="btn-small ${l.installed ? 'btn-done' : ''}" data-action="toggle-installed" data-id="${l.id}" type="button">
            ${l.installed ? '✓ Instalado' : 'Marcar instalado'}
          </button>
          ${!l.installed ? `
          <button class="btn-small ${l.status === 'Perdido' ? 'btn-delete' : ''}" data-action="toggle-lost" data-id="${l.id}" type="button">
            ${l.status === 'Perdido' ? '✕ Sin interés' : 'Marcar sin interés'}
          </button>
          ` : ''}
          <button class="btn-small" data-action="quote" data-id="${l.id}" type="button">Generar cotización PDF</button>
          ${isAdmin && (l.aiStage === 'entregado' || l.aiStage === 'escalado') ? `<button class="btn-small" data-action="reset-ai" data-id="${l.id}" type="button" title="Hace que el agente IA vuelva a responderle a este lead">Reiniciar conversación IA</button>` : ''}
          <button class="btn-small btn-delete" data-action="delete" data-id="${l.id}">Eliminar</button>
        </div>
        <div class="add-note-row">
          <input type="text" placeholder="Agregar nota de seguimiento..." data-note-input data-id="${l.id}" />
          <button class="btn-small" data-action="addnote" data-id="${l.id}" type="button">Agregar</button>
        </div>
        ${l.notes && l.notes.length ? `
          <div class="notes-list">
            ${l.notes.map((n) => `<div class="note-item"><span class="note-date">${fmtDate(n.date)}</span>${escapeHtml(n.text)}</div>`).join('')}
          </div>
        ` : ''}
      </div>
    `;
    }).join('');
  }

  function fmtAgo(iso) {
    const hours = (Date.now() - new Date(iso).getTime()) / 3600000;
    if (hours < 1) return 'hace un momento';
    if (hours < 24) return `hace ${Math.round(hours)} h`;
    return `hace ${Math.round(hours / 24)} día(s)`;
  }

  // Etapa del agente IA (Andrés): distinta del "status" del pipeline (columna del tablero),
  // esta cuenta si la IA sigue hablando con el lead, ya lo entregó o lo escaló.
  function aiStageBadge(l) {
    if (l.source !== 'whatsapp-ads' && !l.aiStage) return '';
    switch (l.aiStage) {
      case 'en_conversacion':
        return '<span class="badge badge-ai">🤖 IA conversando</span>';
      case 'entregado':
        return `<span class="badge badge-ai-done">🤖 Entregado${l.aiHandoffAt ? ' ' + fmtAgo(l.aiHandoffAt) : ''}</span>`;
      case 'escalado':
        return `<span class="badge badge-ai-escalated">🤖 Escalado${l.aiHandoffAt ? ' ' + fmtAgo(l.aiHandoffAt) : ''}</span>`;
      default:
        return '';
    }
  }

  // Solo se muestra la insignia más relevante (no todas apiladas), para que la tarjeta
  // quepa en menos espacio y entren más leads en pantalla a la vez.
  function primaryBadge(l) {
    if (l.overdue) return '<span class="badge overdue-badge">Atrasado</span>';
    const ai = aiStageBadge(l);
    if (ai) return ai;
    if (l.installed && l.verifiedInstalled) return '<span class="badge badge-verified">✓ Verificado</span>';
    if (l.installed && !l.verifiedInstalled) return '<span class="badge badge-unverified">⚠ Sin verificar</span>';
    if (isCold(l)) return '<span class="badge badge-cold">Sin contactar</span>';
    if (l.source === 'meta-leadgen') return '<span class="badge badge-meta">Meta</span>';
    return '';
  }

  function renderBoardCard(l) {
    const metaParts = [l.city, l.secretary].filter(Boolean);
    return `
      <div class="board-card ${l.overdue ? 'overdue' : ''}" draggable="${canSetStatus}" data-id="${l.id}">
        <div class="board-card-top">
          <span class="board-card-name">${escapeHtml(l.name)}</span>
          ${isPhoneLike(l.phone)
            ? `<a class="board-card-wa" href="${waLink(l.phone)}" target="_blank" rel="noopener" title="WhatsApp">💬</a>`
            : ''}
        </div>
        ${metaParts.length ? `<div class="board-card-meta">${escapeHtml(metaParts.join(' · '))}</div>` : ''}
        ${primaryBadge(l)}
      </div>
    `;
  }

  function renderBoard(leads) {
    if (!leadsBoard) return;
    leadsBoard.innerHTML = `<div class="board-columns">${STATUSES.map((s) => {
      const items = leads.filter((l) => l.status === s);
      return `
        <div class="board-col">
          <div class="board-col-head"><span>${escapeHtml(s)}</span><span class="board-count">${items.length}</span></div>
          <div class="board-col-body" data-dropzone="${escapeHtml(s)}">
            ${items.map(renderBoardCard).join('') || '<div class="board-empty">Sin leads</div>'}
          </div>
        </div>
      `;
    }).join('')}</div>`;
  }

  function renderResults(leads) {
    if (!resultsPanel) return;

    const bySecretary = {};
    leads.forEach((l) => {
      const key = l.secretary || 'Sin asignar';
      const s = bySecretary[key] || (bySecretary[key] = { total: 0, installed: 0 });
      s.total++;
      if (l.status === 'Instalado') s.installed++;
    });
    const secretaryRows = Object.entries(bySecretary)
      .map(([name, s]) => ({ name, ...s, rate: s.total ? Math.round((s.installed / s.total) * 1000) / 10 : 0 }))
      .sort((a, b) => b.rate - a.rate || b.total - a.total)
      .map((s) => `
        <tr>
          <td>${escapeHtml(s.name)}</td>
          <td>${s.total}</td>
          <td>${s.installed}</td>
          <td>${s.rate}%</td>
        </tr>
      `).join('');

    resultsPanel.innerHTML = `
      <div class="results-grid">
        <div>
          <h3>Por secretaria — ranking de conversión</h3>
          <table class="results-table">
            <thead><tr><th>Secretaria</th><th>Leads</th><th>Instalados</th><th>% conversión</th></tr></thead>
            <tbody>${secretaryRows || '<tr><td colspan="4">Sin datos</td></tr>'}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  function renderFilteredCount(count) {
    const hasDateRange = dateFromFilter.value || dateToFilter.value;
    filteredCount.textContent = hasDateRange
      ? `${count} lead(s) en el rango de fechas seleccionado.`
      : `${count} lead(s) con estos filtros.`;
  }

  function hasActiveQuery() {
    return !!(
      searchInput.value.trim() ||
      cityFilter.value ||
      secretaryFilter.value ||
      statusFilter.value ||
      vehicleTypeFilter.value ||
      monthFilter.value ||
      overdueFilter.checked ||
      dateFromFilter.value ||
      dateToFilter.value
    );
  }

  function renderListAndCount(filtered) {
    if (!hasActiveQuery()) {
      leadsList.innerHTML = `<div class="empty">Hay ${allLeads.length} lead(s) en total. Busca por nombre/teléfono o usa un filtro (ciudad, estado, mes, etc.) para verlos en la lista.</div>`;
      filteredCount.textContent = '';
      return;
    }
    renderLeads(filtered);
    renderFilteredCount(filtered.length);
  }

  function renderCurrentView() {
    const filtered = getFilteredLeads();
    renderStats(computeStats(filtered));
    renderResults(filtered);

    // El tablero se ve agrupado por etapa (se navega solo) y a propósito NO reacciona al
    // texto de búsqueda (getBoardLeads ignora el buscador) — solo a los demás filtros, que
    // cambian con mucha menos frecuencia que cada tecla escrita.
    renderBoard(getBoardLeads());
    renderListAndCount(filtered);
  }

  // Se usa mientras se escribe en el buscador: NO toca el tablero (ver arriba), que es la
  // reconstrucción más pesada — así cada tecla solo recalcula lo que de verdad depende del
  // texto buscado.
  function renderSearchOnly() {
    const filtered = getFilteredLeads();
    renderStats(computeStats(filtered));
    renderResults(filtered);
    renderListAndCount(filtered);
  }

  function getBoardLeads() {
    return getFilteredLeads(false);
  }

  function loadLeads() {
    fetch('/api/leads')
      .then((res) => res.json())
      .then((data) => {
        if (!data || !Array.isArray(data.leads)) {
          leadsList.innerHTML = '<div class="empty">No se pudo cargar (revisa la conexión).</div>';
          return;
        }
        allLeads = data.leads;
        populateDynamicFilters(allLeads);
        renderCurrentView();
      })
      .catch(() => {
        leadsList.innerHTML = '<div class="empty">No se pudo cargar (revisa la conexión).</div>';
      });
  }

  let debounceTimer;
  function debouncedRender() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(renderSearchOnly, 200);
  }

  searchInput.addEventListener('input', debouncedRender);
  cityFilter.addEventListener('change', renderCurrentView);
  secretaryFilter.addEventListener('change', renderCurrentView);
  statusFilter.addEventListener('change', renderCurrentView);
  vehicleTypeFilter.addEventListener('change', renderCurrentView);
  monthFilter.addEventListener('change', renderCurrentView);
  overdueFilter.addEventListener('change', renderCurrentView);
  dateFromFilter.addEventListener('change', renderCurrentView);
  dateToFilter.addEventListener('change', renderCurrentView);

  const viewButtons = document.querySelectorAll('.view-btn');
  viewButtons.forEach((btn) => {
    btn.addEventListener('click', function () {
      const view = btn.getAttribute('data-view');
      viewButtons.forEach((b) => b.classList.toggle('active', b === btn));
      leadsList.style.display = view === 'board' ? 'none' : '';
      if (leadsBoard) leadsBoard.style.display = view === 'board' ? '' : 'none';
    });
  });

  if (leadsBoard) {
    leadsBoard.addEventListener('dragstart', function (e) {
      const card = e.target.closest('.board-card');
      if (!card) return;
      e.dataTransfer.setData('text/plain', card.getAttribute('data-id'));
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    leadsBoard.addEventListener('dragend', function (e) {
      const card = e.target.closest('.board-card');
      if (card) card.classList.remove('dragging');
    });
    leadsBoard.addEventListener('dragover', function (e) {
      const zone = e.target.closest('[data-dropzone]');
      if (!zone) return;
      e.preventDefault();
      zone.classList.add('drag-over');
    });
    leadsBoard.addEventListener('dragleave', function (e) {
      const zone = e.target.closest('[data-dropzone]');
      if (zone) zone.classList.remove('drag-over');
    });
    leadsBoard.addEventListener('drop', function (e) {
      const zone = e.target.closest('[data-dropzone]');
      if (!zone) return;
      e.preventDefault();
      zone.classList.remove('drag-over');
      const id = e.dataTransfer.getData('text/plain');
      const newStatus = zone.getAttribute('data-dropzone');
      const lead = allLeads.find((l) => l.id === id);
      if (!lead || lead.status === newStatus) return;
      if (newStatus === 'Perdido' && lead.installed) {
        alert('No puedes marcar como "sin interés" un lead que ya está instalado.');
        return;
      }
      fetch('/api/leads', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status: newStatus }),
      })
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'No se pudo actualizar el lead.');
          loadLeads();
        })
        .catch((err) => alert(err.message || 'No se pudo actualizar el lead.'));
    });
  }

  leadForm.addEventListener('submit', function (e) {
    e.preventDefault();
    const name = document.getElementById('name').value.trim();
    const phone = document.getElementById('phone').value.trim();
    const city = document.getElementById('city').value.trim();
    const campaign = document.getElementById('campaign').value.trim();
    const nextFollowUp = document.getElementById('nextFollowUp').value || null;
    const vehicleType = document.getElementById('vehicleType').value;
    const motosCount = parseInt(document.getElementById('motosCount').value, 10) || 0;
    const carrosCount = parseInt(document.getElementById('carrosCount').value, 10) || 0;
    const initialNote = document.getElementById('initialNote').value.trim();
    if (!phone) return;

    const submitBtn = leadForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    fetch('/api/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phone, city, campaign, nextFollowUp, vehicleType, motosCount, carrosCount, initialNote }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo guardar el lead.');
        leadForm.reset();
        loadLeads();
      })
      .catch((err) => alert(err.message || 'No se pudo guardar el lead.'))
      .finally(() => { submitBtn.disabled = false; });
  });

  leadsList.addEventListener('change', function (e) {
    const el = e.target;
    const action = el.getAttribute('data-action');
    if (!action) return;
    const id = el.getAttribute('data-id');

    if (action === 'wa-template') {
      const templateKey = el.value;
      const template = WA_TEMPLATES[templateKey];
      if (template) {
        const lead = allLeads.find((l) => l.id === id);
        if (lead && !isPhoneLike(lead.phone)) {
          alert('Este lead tiene un usuario de WhatsApp, no un teléfono. WhatsApp aún no permite abrir el chat por enlace usando el usuario — búscalo manualmente dentro de WhatsApp.');
        } else if (lead) {
          window.open(waLink(lead.phone, template(lead.name)), '_blank', 'noopener');
          if (templateKey === 'first') downloadMediaAssetsForWhatsApp();
        }
      }
      el.value = '';
      return;
    }

    const body = { id };
    if (action === 'status') body.status = el.value;
    else if (action === 'followup') body.nextFollowUp = el.value || null;
    else if (action === 'scheduledInstall') body.scheduledInstallDate = el.value || null;
    else if (action === 'vehicleType') body.vehicleType = el.value || '';
    else return;

    fetch('/api/leads', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(loadLeads);
  });

  leadsList.addEventListener('click', function (e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    const action = btn.getAttribute('data-action');

    if (action === 'delete') {
      if (!confirm('¿Eliminar este lead?')) return;
      fetch('/api/leads', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      }).then(loadLeads);
    } else if (action === 'addnote') {
      const input = leadsList.querySelector(`input[data-note-input][data-id="${id}"]`);
      const text = input ? input.value.trim() : '';
      if (!text) return;
      fetch('/api/leads', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, addNote: text }),
      }).then(loadLeads);
    } else if (action === 'quote') {
      generateQuoteForLead(id, btn);
    } else if (action === 'reset-ai') {
      if (!confirm('¿Reiniciar la conversación con el agente IA para este lead? Volverá a responderle automáticamente.')) return;
      fetch('/api/leads', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, resetAiStage: true }),
      })
        .then(async (res) => {
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'No se pudo reiniciar la conversación.');
          }
          loadLeads();
        })
        .catch((err) => alert(err.message || 'No se pudo reiniciar la conversación.'));
    } else if (action === 'toggle-installed') {
      const lead = allLeads.find((l) => l.id === id);
      const installed = !(lead && lead.installed);
      fetch('/api/leads', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, installed }),
      }).then(loadLeads);
    } else if (action === 'toggle-lost') {
      const lead = allLeads.find((l) => l.id === id);
      const status = lead && lead.status === 'Perdido' ? 'Contactado' : 'Perdido';
      fetch('/api/leads', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status }),
      })
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'No se pudo actualizar el lead.');
          loadLeads();
        })
        .catch((err) => alert(err.message || 'No se pudo actualizar el lead.'));
    } else if (action === 'edit') {
      editingId = id;
      editError = '';
      renderLeads(getFilteredLeads());
    } else if (action === 'cancel-edit') {
      editingId = null;
      editError = '';
      renderLeads(getFilteredLeads());
    } else if (action === 'save-edit') {
      const card = leadsList.querySelector(`.lead-item[data-id="${id}"]`);
      const name = card.querySelector('[data-edit="name"]').value.trim();
      const phone = card.querySelector('[data-edit="phone"]').value.trim();
      const city = card.querySelector('[data-edit="city"]').value;
      const campaign = card.querySelector('[data-edit="campaign"]').value.trim();
      const motosCount = parseInt(card.querySelector('[data-edit="motosCount"]').value, 10) || 0;
      const carrosCount = parseInt(card.querySelector('[data-edit="carrosCount"]').value, 10) || 0;
      const secretary = card.querySelector('[data-edit="secretary"]').value;
      if (!name || !phone) {
        editError = 'Nombre y teléfono son obligatorios.';
        renderLeads(getFilteredLeads());
        return;
      }
      btn.disabled = true;
      fetch('/api/leads', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name, phone, city, campaign, motosCount, carrosCount, secretary }),
      })
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'No se pudo guardar.');
          editingId = null;
          editError = '';
          loadLeads();
        })
        .catch((err) => {
          editError = err.message || 'No se pudo guardar.';
          renderLeads(getFilteredLeads());
        });
    }
  });

  function generateQuoteForLead(id, btn) {
    const lead = allLeads.find((l) => l.id === id);
    if (!lead) return;
    const branch = BRANCHES.find((b) => lead.city && b.toLowerCase().includes(lead.city.toLowerCase()))
      || lead.convertedBranch
      || BRANCHES[0];

    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Generando...';

    fetch('/api/generate-quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client: lead.name,
        branch,
        motos: lead.motosCount || 0,
        carros: lead.carrosCount || 0,
        leadId: lead.id,
      }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'No se pudo generar la cotización.');
        }
        return res.blob();
      })
      .then((blob) => {
        const safeName = (lead.name || 'cliente').replace(/[^a-zA-Z0-9]/g, '_');
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Cotizacion-TuGPS24-${safeName}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        loadLeads();
      })
      .catch((err) => alert(err.message || 'No se pudo generar la cotización.'))
      .finally(() => {
        btn.disabled = false;
        btn.textContent = originalText;
      });
  }

  exportBtn.addEventListener('click', function () {
    const leads = getFilteredLeads();
    const headers = ['Nombre', 'Teléfono', 'Ciudad', 'Campaña', 'Secretaria', 'Estado', 'Próximo seguimiento', 'Sucursal conversión', 'Tipo de cliente', 'Motos', 'Carros', 'Creado', 'Notas'];
    const rows = leads.map((l) => [
      l.name, l.phone, l.city, l.campaign, l.secretary, l.status,
      l.nextFollowUp || '', l.convertedBranch || '', l.vehicleType || '', l.motosCount || 0, l.carrosCount || 0, l.createdAt,
      (l.notes || []).map((n) => `[${n.date}] ${n.text}`).join(' | '),
    ]);
    const csv = [headers, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `leads-tugps24-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  const mediaGallery = document.getElementById('mediaGallery');
  if (mediaGallery) {
    function renderMediaGallery(assets) {
      if (!assets.length) {
        mediaGallery.innerHTML = '<div class="empty">Todavía no hay fotos ni videos agregados.</div>';
        return;
      }
      mediaGallery.innerHTML = assets.map((a) => `
        <div class="media-item" data-id="${a.id}">
          <div class="media-thumb">${a.kind === 'image' ? `<img src="${a.url}" alt="${escapeHtml(a.label)}" loading="lazy" />` : '🎬'}</div>
          <div class="media-label">${escapeHtml(a.label)}</div>
          <div class="media-actions">
            <a class="btn-tiny" href="${a.url}" target="_blank" rel="noopener">Abrir</a>
            <button class="btn-tiny" type="button" data-action="copy-media-link" data-url="${a.url}">Copiar enlace</button>
            ${canManageMedia ? `<button class="btn-tiny btn-delete" type="button" data-action="delete-media" data-id="${a.id}">Eliminar</button>` : ''}
          </div>
        </div>
      `).join('');
    }

    function loadMediaAssets() {
      fetch('/api/media-assets')
        .then((res) => res.json())
        .then((data) => {
          if (data && Array.isArray(data.assets)) renderMediaGallery(data.assets);
        })
        .catch(() => {
          mediaGallery.innerHTML = '<div class="empty">No se pudo cargar (revisa la conexión).</div>';
        });
    }

    mediaGallery.addEventListener('click', function (e) {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.getAttribute('data-action');
      if (action === 'copy-media-link') {
        const url = btn.getAttribute('data-url');
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(() => {
            const original = btn.textContent;
            btn.textContent = '¡Copiado!';
            setTimeout(() => { btn.textContent = original; }, 1500);
          }).catch(() => {});
        }
      } else if (action === 'delete-media') {
        if (!confirm('¿Eliminar este recurso?')) return;
        const id = btn.getAttribute('data-id');
        fetch('/api/media-assets', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        }).then(loadMediaAssets);
      }
    });

    const mediaImageForm = document.getElementById('mediaImageForm');
    if (mediaImageForm) {
      mediaImageForm.addEventListener('submit', function (e) {
        e.preventDefault();
        const label = document.getElementById('mediaImageLabel').value.trim();
        const file = document.getElementById('mediaImageFile').files[0];
        if (!label || !file) return;
        const submitBtn = mediaImageForm.querySelector('button[type="submit"]');
        submitBtn.disabled = true;

        const formData = new FormData();
        formData.append('label', label);
        formData.append('file', file);

        fetch('/api/media-assets', { method: 'POST', body: formData })
          .then(async (res) => {
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error([data.error, data.detail].filter(Boolean).join(' — ') || 'No se pudo subir la imagen.');
            mediaImageForm.reset();
            loadMediaAssets();
          })
          .catch((err) => alert(err.message || 'No se pudo subir la imagen.'))
          .finally(() => { submitBtn.disabled = false; });
      });
    }

    const mediaLinkForm = document.getElementById('mediaLinkForm');
    if (mediaLinkForm) {
      mediaLinkForm.addEventListener('submit', function (e) {
        e.preventDefault();
        const label = document.getElementById('mediaLinkLabel').value.trim();
        const url = document.getElementById('mediaLinkUrl').value.trim();
        if (!label || !url) return;
        const submitBtn = mediaLinkForm.querySelector('button[type="submit"]');
        submitBtn.disabled = true;

        fetch('/api/media-assets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label, url }),
        })
          .then(async (res) => {
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'No se pudo agregar el enlace.');
            mediaLinkForm.reset();
            loadMediaAssets();
          })
          .catch((err) => alert(err.message || 'No se pudo agregar el enlace.'))
          .finally(() => { submitBtn.disabled = false; });
      });
    }

    loadMediaAssets();
  }

  const backfillSecretaryBtn = document.getElementById('backfillSecretaryBtn');
  if (backfillSecretaryBtn) {
    const backfillSecretaryResult = document.getElementById('backfillSecretaryResult');
    backfillSecretaryBtn.addEventListener('click', function () {
      backfillSecretaryBtn.disabled = true;
      backfillSecretaryResult.textContent = 'Asignando...';
      fetch('/api/leads-backfill-secretary', { method: 'POST' })
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'No se pudo asignar.');
          backfillSecretaryResult.textContent = `${data.updated} lead(s) asignados a su creador.`;
          loadLeads();
        })
        .catch((err) => {
          backfillSecretaryResult.textContent = err.message || 'No se pudo asignar.';
        })
        .finally(() => { backfillSecretaryBtn.disabled = false; });
    });
  }

  const backfillContactedBtn = document.getElementById('backfillContactedBtn');
  if (backfillContactedBtn) {
    const backfillContactedResult = document.getElementById('backfillContactedResult');
    backfillContactedBtn.addEventListener('click', function () {
      backfillContactedBtn.disabled = true;
      backfillContactedResult.textContent = 'Moviendo...';
      fetch('/api/leads-backfill-contacted', { method: 'POST' })
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'No se pudo mover.');
          backfillContactedResult.textContent = `${data.updated} lead(s) movidos a Contactado.`;
          loadLeads();
        })
        .catch((err) => {
          backfillContactedResult.textContent = err.message || 'No se pudo mover.';
        })
        .finally(() => { backfillContactedBtn.disabled = false; });
    });
  }

  loadSecretaries().then(loadLeads);
});
