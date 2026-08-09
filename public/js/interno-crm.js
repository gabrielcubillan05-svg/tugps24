document.addEventListener('DOMContentLoaded', function () {
  const leadsList = document.getElementById('leadsList');
  if (!leadsList) return; // no autenticado

  const crmData = document.getElementById('crmData');
  const STATUSES = JSON.parse((crmData && crmData.dataset.statuses) || '[]');
  const BRANCHES = JSON.parse((crmData && crmData.dataset.branches) || '[]');
  const canManageMedia = !!(crmData && crmData.dataset.canManageMedia);

  const statsRow = document.getElementById('statsRow');
  const leadForm = document.getElementById('leadForm');
  const searchInput = document.getElementById('searchInput');
  const cityFilter = document.getElementById('cityFilter');
  const secretaryFilter = document.getElementById('secretaryFilter');
  const statusFilter = document.getElementById('statusFilter');
  const vehicleTypeFilter = document.getElementById('vehicleTypeFilter');
  const overdueFilter = document.getElementById('overdueFilter');
  const exportBtn = document.getElementById('exportBtn');
  const leadsBoard = document.getElementById('leadsBoard');
  const resultsPanel = document.getElementById('resultsPanel');

  const WA_TEMPLATES = {
    first: (name) => `Hola ${name}, ¡bienvenido a TuGPS24! 👋

¿Buscas total tranquilidad y control para tu vehículo? En TuGPS24 te ofrecemos las soluciones líderes en monitoreo y rastreo satelital. Con más de 1600 vehículos recuperados y una red de 10 oficinas a nivel nacional, somos tu aliado confiable.

Estos son los beneficios que te ofrecemos 👇🏻

📍 Ubicación en tiempo real: control absoluto de tu vehículo (🚗🏍️) desde cualquier parte del mundo, en la palma de tu mano.

🔒 Apagado remoto: apaga totalmente tu vehículo sin importar la distancia. ¡Con o sin llave, no podrán encenderlo!

📌 Enlace directo con la Policía: en caso de robo, nuestra central de monitoreo 24 horas coordina automáticamente el operativo de rescate con las autoridades, guiándolos al punto exacto.

📈 Reportes de control: desde tu app móvil puedes ver los recorridos y el kilometraje de tu vehículo.

👨🏻‍💻 Central de monitoreo 24/7: más de 40 operadores expertos vigilan tu vehículo día y noche, listos para actuar.

🗺️ Cobertura nacional amplia: te acompañamos por todo el país, con oficinas estratégicamente ubicadas para tu comodidad.

🛣️ Geocerca de zona: si tu vehículo sale de la ciudad te llamamos para confirmar autorización; si no hay comunicación, apagamos el vehículo por seguridad.

🔧 Planes de mantenimiento: preventivo cada 6 meses sin costo adicional, para que siempre esté en las mejores condiciones. Es nuestro compromiso con tu tranquilidad.

¿Qué esperas para proteger tu inversión? ¡Instala ya nuestros servicios!`,
    quote: (name) => `Hola ${name}, te escribo de TuGPS24 para saber si pudiste revisar la cotización que te enviamos. Cualquier duda con gusto te ayudo.`,
    install: (name) => `Hola ${name}, ¿cómo estás? Te escribimos de TuGPS24 para confirmar los detalles de la instalación de tu GPS. ¿Qué día y hora te queda mejor?`,
    followup: (name) => `Hola ${name}, ¿cómo vas? Quería hacer seguimiento a tu interés en el servicio de GPS de TuGPS24. Cuéntame si tienes alguna pregunta o si quieres que avancemos.`,
  };

  let allLeads = [];
  const secretarySelect = document.getElementById('secretary');

  function loadSecretaries() {
    fetch('/api/users?role=secretaria,gerente')
      .then((res) => res.json())
      .then((data) => {
        if (!data || !Array.isArray(data.users)) return;
        secretarySelect.innerHTML = '<option value="">Sin asignar</option>' +
          data.users.map((u) => `<option value="${escapeHtml(u.name)}">${escapeHtml(u.name)}${u.role === 'gerente' ? ' (Gerente)' : ''}</option>`).join('');
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

  function isCold(l) {
    if (l.notes && l.notes.length) return false;
    if (l.status === 'Instalado' || l.status === 'Perdido') return false;
    const ageHours = (Date.now() - new Date(l.createdAt).getTime()) / 3600000;
    return ageHours > 24;
  }

  function fmtHours(hours) {
    if (hours < 1) return Math.round(hours * 60) + ' min';
    if (hours < 48) return Math.round(hours) + ' h';
    return Math.round(hours / 24) + ' días';
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

  function populateDynamicFilters(leads) {
    const cities = [...new Set(leads.map((l) => l.city).filter(Boolean))].sort();
    const secretaries = [...new Set(leads.map((l) => l.secretary).filter(Boolean))].sort();

    const currentCity = cityFilter.value;
    cityFilter.innerHTML = '<option value="">Todas las ciudades</option>' +
      cities.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    cityFilter.value = currentCity;

    const currentSec = secretaryFilter.value;
    secretaryFilter.innerHTML = '<option value="">Todas las secretarias</option>' +
      secretaries.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    secretaryFilter.value = currentSec;
  }

  function getFilteredLeads() {
    const q = searchInput.value.trim().toLowerCase();
    const city = cityFilter.value;
    const secretary = secretaryFilter.value;
    const status = statusFilter.value;
    const vehicleType = vehicleTypeFilter.value;
    const onlyOverdue = overdueFilter.checked;

    return allLeads.filter((l) => {
      if (q && !(l.name.toLowerCase().includes(q) || l.phone.toLowerCase().includes(q) || (l.campaign || '').toLowerCase().includes(q))) return false;
      if (city && l.city !== city) return false;
      if (secretary && l.secretary !== secretary) return false;
      if (status && l.status !== status) return false;
      if (vehicleType && l.vehicleType !== vehicleType) return false;
      if (onlyOverdue && !l.overdue) return false;
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
            <label>Teléfono</label>
            <input type="tel" data-edit="phone" value="${escapeHtml(l.phone)}" />
          </div>
          <div class="field">
            <label>Ciudad</label>
            <select data-edit="city">
              <option value="">Selecciona una ciudad</option>
              ${BRANCHES.map((b) => `<option value="${b}" ${b === l.city ? 'selected' : ''}>${b}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>Campaña / anuncio de origen</label>
            <input type="text" data-edit="campaign" value="${escapeHtml(l.campaign)}" />
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

  function renderLeads() {
    const leads = getFilteredLeads();
    if (!leads.length) {
      leadsList.innerHTML = '<div class="empty">No hay leads con esos filtros.</div>';
      return;
    }

    leadsList.innerHTML = leads.map((l) => {
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
        <div class="lead-controls">
          <a class="btn-small btn-wa" href="${waLink(l.phone)}" target="_blank" rel="noopener">WhatsApp</a>
          <select class="wa-select" data-action="wa-template" data-id="${l.id}">
            <option value="">Mensaje rápido...</option>
            <option value="first">Primer contacto</option>
            <option value="quote">Recordatorio cotización</option>
            <option value="install">Confirmar instalación</option>
            <option value="followup">Seguimiento</option>
          </select>
          <select data-action="status" data-id="${l.id}">
            ${STATUSES.map((s) => `<option value="${s}" ${s === l.status ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
          <input type="date" data-action="followup" data-id="${l.id}" value="${l.nextFollowUp ? l.nextFollowUp.slice(0, 10) : ''}" title="Próximo seguimiento" />
          <input type="date" data-action="scheduledInstall" data-id="${l.id}" value="${l.scheduledInstallDate ? l.scheduledInstallDate.slice(0, 10) : ''}" title="Fecha de instalación agendada" />
          <select data-action="branch" data-id="${l.id}" title="Sucursal de instalación">
            <option value="">Sucursal (si instalado)</option>
            ${BRANCHES.map((b) => `<option value="${b}" ${b === l.convertedBranch ? 'selected' : ''}>${b}</option>`).join('')}
          </select>
          <select data-action="vehicleType" data-id="${l.id}" title="Tipo de cliente">
            <option value="" ${!l.vehicleType ? 'selected' : ''}>Sin definir</option>
            <option value="Moto" ${l.vehicleType === 'Moto' ? 'selected' : ''}>Moto</option>
            <option value="Carro" ${l.vehicleType === 'Carro' ? 'selected' : ''}>Carro</option>
            <option value="Flota" ${l.vehicleType === 'Flota' ? 'selected' : ''}>Flota</option>
          </select>
          <button class="btn-small" data-action="edit" data-id="${l.id}" type="button">Editar</button>
          <button class="btn-small ${l.installed ? 'btn-done' : ''}" data-action="toggle-installed" data-id="${l.id}" type="button">
            ${l.installed ? '✓ Instalado' : 'Marcar instalado'}
          </button>
          <button class="btn-small" data-action="quote" data-id="${l.id}" type="button">Generar cotización PDF</button>
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

  function renderBoardCard(l) {
    return `
      <div class="board-card ${l.overdue ? 'overdue' : ''}" draggable="true" data-id="${l.id}">
        <div class="board-card-name">${escapeHtml(l.name)}</div>
        <div class="board-card-meta">${escapeHtml(l.phone)}${l.city ? ' · ' + escapeHtml(l.city) : ''}</div>
        <div class="board-card-badges">
          ${l.overdue ? '<span class="badge overdue-badge">Atrasado</span>' : ''}
          ${l.installed && l.verifiedInstalled ? '<span class="badge badge-verified">✓ Verificado</span>' : ''}
          ${l.installed && !l.verifiedInstalled ? '<span class="badge badge-unverified">⚠ Sin verificar</span>' : ''}
          ${isCold(l) ? '<span class="badge badge-cold">Sin contactar</span>' : ''}
          ${l.source === 'meta-leadgen' ? '<span class="badge badge-meta">Meta</span>' : ''}
        </div>
        <a class="btn-tiny btn-wa" href="${waLink(l.phone)}" target="_blank" rel="noopener">WhatsApp</a>
      </div>
    `;
  }

  function renderBoard() {
    if (!leadsBoard) return;
    const leads = getFilteredLeads();
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

    const byCampaign = {};
    leads.forEach((l) => {
      const key = l.campaign || 'Sin campaña';
      const s = byCampaign[key] || (byCampaign[key] = { total: 0, converted: 0, verified: 0 });
      s.total++;
      if (l.status === 'Instalado') s.converted++;
      if (l.verifiedInstalled) s.verified++;
    });
    const campaignRows = Object.entries(byCampaign)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([name, s]) => `
        <tr>
          <td>${escapeHtml(name)}</td>
          <td>${s.total}</td>
          <td>${s.converted}</td>
          <td>${s.verified}</td>
          <td>${s.total ? Math.round((s.verified / s.total) * 100) : 0}%</td>
        </tr>
      `).join('');

    const bySecretary = {};
    leads.forEach((l) => {
      const key = l.secretary || 'Sin asignar';
      const s = bySecretary[key] || (bySecretary[key] = { total: 0, contacted: 0, totalHours: 0, cold: 0 });
      s.total++;
      if (l.notes && l.notes.length) {
        const firstNote = l.notes[l.notes.length - 1];
        const hours = (new Date(firstNote.date).getTime() - new Date(l.createdAt).getTime()) / 3600000;
        if (hours >= 0) {
          s.contacted++;
          s.totalHours += hours;
        }
      } else if (isCold(l)) {
        s.cold++;
      }
    });
    const secretaryRows = Object.entries(bySecretary)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([name, s]) => `
        <tr>
          <td>${escapeHtml(name)}</td>
          <td>${s.total}</td>
          <td>${s.contacted ? fmtHours(s.totalHours / s.contacted) : '—'}</td>
          <td>${s.cold}</td>
        </tr>
      `).join('');

    resultsPanel.innerHTML = `
      <div class="results-grid">
        <div>
          <h3>Por campaña</h3>
          <table class="results-table">
            <thead><tr><th>Campaña</th><th>Leads</th><th>Instalados</th><th>Instalación verificada</th><th>Tasa real</th></tr></thead>
            <tbody>${campaignRows || '<tr><td colspan="5">Sin datos</td></tr>'}</tbody>
          </table>
        </div>
        <div>
          <h3>Por secretaria — tiempo de respuesta</h3>
          <table class="results-table">
            <thead><tr><th>Secretaria</th><th>Leads</th><th>Tiempo prom. 1er contacto</th><th>Sin contactar (+24h)</th></tr></thead>
            <tbody>${secretaryRows || '<tr><td colspan="4">Sin datos</td></tr>'}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  function renderCurrentView() {
    renderLeads();
    renderBoard();
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
        renderStats(data.stats);
        populateDynamicFilters(allLeads);
        renderCurrentView();
        renderResults(allLeads);
      })
      .catch(() => {
        leadsList.innerHTML = '<div class="empty">No se pudo cargar (revisa la conexión).</div>';
      });
  }

  let debounceTimer;
  function debouncedRender() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(renderCurrentView, 200);
  }

  searchInput.addEventListener('input', debouncedRender);
  cityFilter.addEventListener('change', renderCurrentView);
  secretaryFilter.addEventListener('change', renderCurrentView);
  statusFilter.addEventListener('change', renderCurrentView);
  vehicleTypeFilter.addEventListener('change', renderCurrentView);
  overdueFilter.addEventListener('change', renderCurrentView);

  const viewButtons = document.querySelectorAll('.view-btn');
  viewButtons.forEach((btn) => {
    btn.addEventListener('click', function () {
      const view = btn.getAttribute('data-view');
      viewButtons.forEach((b) => b.classList.toggle('active', b === btn));
      leadsList.style.display = view === 'board' ? 'none' : '';
      if (leadsBoard) leadsBoard.style.display = view === 'board' ? '' : 'none';
      try { localStorage.setItem('crmView', view); } catch {}
    });
  });
  try {
    const savedView = localStorage.getItem('crmView');
    if (savedView === 'board') {
      const boardBtn = document.querySelector('.view-btn[data-view="board"]');
      if (boardBtn) boardBtn.click();
    }
  } catch {}

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
      fetch('/api/leads', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status: newStatus }),
      }).then(loadLeads);
    });
  }

  leadForm.addEventListener('submit', function (e) {
    e.preventDefault();
    const name = document.getElementById('name').value.trim();
    const phone = document.getElementById('phone').value.trim();
    const city = document.getElementById('city').value.trim();
    const campaign = document.getElementById('campaign').value.trim();
    const secretary = document.getElementById('secretary').value.trim();
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
      body: JSON.stringify({ name, phone, city, campaign, secretary, nextFollowUp, vehicleType, motosCount, carrosCount, initialNote }),
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
      const template = WA_TEMPLATES[el.value];
      if (template) {
        const lead = allLeads.find((l) => l.id === id);
        if (lead) window.open(waLink(lead.phone, template(lead.name)), '_blank', 'noopener');
      }
      el.value = '';
      return;
    }

    const body = { id };
    if (action === 'status') body.status = el.value;
    else if (action === 'followup') body.nextFollowUp = el.value || null;
    else if (action === 'scheduledInstall') body.scheduledInstallDate = el.value || null;
    else if (action === 'branch') body.convertedBranch = el.value || null;
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
    } else if (action === 'toggle-installed') {
      const lead = allLeads.find((l) => l.id === id);
      const installed = !(lead && lead.installed);
      fetch('/api/leads', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, installed }),
      }).then(loadLeads);
    } else if (action === 'edit') {
      editingId = id;
      editError = '';
      renderLeads();
    } else if (action === 'cancel-edit') {
      editingId = null;
      editError = '';
      renderLeads();
    } else if (action === 'save-edit') {
      const card = leadsList.querySelector(`.lead-item[data-id="${id}"]`);
      const name = card.querySelector('[data-edit="name"]').value.trim();
      const phone = card.querySelector('[data-edit="phone"]').value.trim();
      const city = card.querySelector('[data-edit="city"]').value;
      const campaign = card.querySelector('[data-edit="campaign"]').value.trim();
      if (!name || !phone) {
        editError = 'Nombre y teléfono son obligatorios.';
        renderLeads();
        return;
      }
      btn.disabled = true;
      fetch('/api/leads', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name, phone, city, campaign }),
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
          renderLeads();
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

  const verifyInstallsForm = document.getElementById('verifyInstallsForm');
  if (verifyInstallsForm) {
    const verifyInstallsFile = document.getElementById('verifyInstallsFile');
    const verifyInstallsResult = document.getElementById('verifyInstallsResult');
    verifyInstallsForm.addEventListener('submit', function (e) {
      e.preventDefault();
      const file = verifyInstallsFile.files && verifyInstallsFile.files[0];
      if (!file) return;
      verifyInstallsResult.innerHTML = 'Comparando...';
      const submitBtn = verifyInstallsForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;

      const formData = new FormData();
      formData.append('file', file);

      fetch('/api/leads-verify-installs', { method: 'POST', body: formData })
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'No se pudo procesar el archivo.');
          const unmatchedHtml = data.unmatchedPhones && data.unmatchedPhones.length
            ? `<div class="unmatched-list">Teléfonos en el archivo sin lead en el CRM (${data.unmatchedCount}): ${data.unmatchedPhones.map(escapeHtml).join(', ')}${data.unmatchedCount > data.unmatchedPhones.length ? '…' : ''}</div>`
            : '';
          verifyInstallsResult.innerHTML = `<p class="result-ok">${data.ordersWithPhone} órdenes leídas · ${data.matched} coincidieron con un lead · ${data.newlyVerified} quedaron verificadas ahora.</p>${unmatchedHtml}`;
          verifyInstallsForm.reset();
          loadLeads();
        })
        .catch((err) => {
          verifyInstallsResult.innerHTML = `<p class="result-error">${escapeHtml(err.message || 'No se pudo procesar el archivo.')}</p>`;
        })
        .finally(() => {
          submitBtn.disabled = false;
        });
    });
  }

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

  loadSecretaries();
  loadLeads();
});
