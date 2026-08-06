document.addEventListener('DOMContentLoaded', function () {
  const leadsList = document.getElementById('leadsList');
  if (!leadsList) return; // no autenticado

  const crmData = document.getElementById('crmData');
  const STATUSES = JSON.parse((crmData && crmData.dataset.statuses) || '[]');
  const BRANCHES = JSON.parse((crmData && crmData.dataset.branches) || '[]');

  const statsRow = document.getElementById('statsRow');
  const leadForm = document.getElementById('leadForm');
  const searchInput = document.getElementById('searchInput');
  const cityFilter = document.getElementById('cityFilter');
  const secretaryFilter = document.getElementById('secretaryFilter');
  const statusFilter = document.getElementById('statusFilter');
  const vehicleTypeFilter = document.getElementById('vehicleTypeFilter');
  const overdueFilter = document.getElementById('overdueFilter');
  const exportBtn = document.getElementById('exportBtn');

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

  function waLink(phone) {
    const digits = String(phone).replace(/\D/g, '');
    const withCountry = digits.startsWith('57') ? digits : '57' + digits;
    return 'https://wa.me/' + withCountry;
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
        </div>
        <div class="lead-meta">
          ${escapeHtml(l.phone)} ${l.city ? '· ' + escapeHtml(l.city) : ''} ${l.campaign ? '· ' + escapeHtml(l.campaign) : ''}
          ${l.secretary ? '· Secretaria: ' + escapeHtml(l.secretary) : ''}
          ${l.vehicleType ? '· ' + escapeHtml(l.vehicleType) + (l.motosCount || l.carrosCount ? ' (' + [l.motosCount ? l.motosCount + ' moto(s)' : '', l.carrosCount ? l.carrosCount + ' carro(s)' : ''].filter(Boolean).join(', ') + ')' : '') : ''}
        </div>
        <div class="lead-controls">
          <a class="btn-small btn-wa" href="${waLink(l.phone)}" target="_blank" rel="noopener">WhatsApp</a>
          <select data-action="status" data-id="${l.id}">
            ${STATUSES.map((s) => `<option value="${s}" ${s === l.status ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
          <input type="date" data-action="followup" data-id="${l.id}" value="${l.nextFollowUp ? l.nextFollowUp.slice(0, 10) : ''}" title="Próximo seguimiento" />
          <select data-action="branch" data-id="${l.id}" title="Sucursal de conversión">
            <option value="">Sucursal (si convertido)</option>
            ${BRANCHES.map((b) => `<option value="${b}" ${b === l.convertedBranch ? 'selected' : ''}>${b}</option>`).join('')}
          </select>
          <select data-action="vehicleType" data-id="${l.id}" title="Tipo de cliente">
            <option value="" ${!l.vehicleType ? 'selected' : ''}>Sin definir</option>
            <option value="Moto" ${l.vehicleType === 'Moto' ? 'selected' : ''}>Moto</option>
            <option value="Carro" ${l.vehicleType === 'Carro' ? 'selected' : ''}>Carro</option>
            <option value="Flota" ${l.vehicleType === 'Flota' ? 'selected' : ''}>Flota</option>
          </select>
          <button class="btn-small" data-action="edit" data-id="${l.id}" type="button">Editar</button>
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
        renderLeads();
      })
      .catch(() => {
        leadsList.innerHTML = '<div class="empty">No se pudo cargar (revisa la conexión).</div>';
      });
  }

  let debounceTimer;
  function debouncedRender() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(renderLeads, 200);
  }

  searchInput.addEventListener('input', debouncedRender);
  cityFilter.addEventListener('change', renderLeads);
  secretaryFilter.addEventListener('change', renderLeads);
  statusFilter.addEventListener('change', renderLeads);
  vehicleTypeFilter.addEventListener('change', renderLeads);
  overdueFilter.addEventListener('change', renderLeads);

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
    if (!name || !phone) return;

    const submitBtn = leadForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    fetch('/api/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phone, city, campaign, secretary, nextFollowUp, vehicleType, motosCount, carrosCount, initialNote }),
    })
      .then((res) => res.json())
      .then(() => {
        leadForm.reset();
        loadLeads();
      })
      .catch(() => alert('No se pudo guardar el lead.'))
      .finally(() => { submitBtn.disabled = false; });
  });

  leadsList.addEventListener('change', function (e) {
    const el = e.target;
    const action = el.getAttribute('data-action');
    if (!action) return;
    const id = el.getAttribute('data-id');
    const body = { id };
    if (action === 'status') body.status = el.value;
    else if (action === 'followup') body.nextFollowUp = el.value || null;
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

  loadSecretaries();
  loadLeads();
});
