document.addEventListener('DOMContentLoaded', function () {
  const cobrosList = document.getElementById('cobrosList');
  if (!cobrosList) return; // no autenticado o sin permiso

  const cobrosData = document.getElementById('cobrosData');
  const currentRole = (cobrosData && cobrosData.dataset.role) || '';
  const currentUserName = (cobrosData && cobrosData.dataset.userName) || '';

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function fmtMoney(n) {
    return '$' + Number(n || 0).toLocaleString('es-CO');
  }

  function isPhoneLike(value) {
    const v = String(value || '').trim();
    return /^[\d\s+().-]+$/.test(v) && v.replace(/\D/g, '').length >= 10;
  }

  function firstName(fullName) {
    const cleaned = String(fullName || '').trim();
    if (!cleaned) return '';
    return cleaned.split(/\s+/)[0];
  }

  function messageFor(nombre, deuda) {
    const greetName = firstName(nombre) || 'que tal';
    return `Hola ${greetName}, te escribimos de *tugps24.com* para recordarte que tienes un saldo pendiente de *${fmtMoney(deuda)}* por el servicio de monitoreo GPS. Te agradecemos ponerte al día para seguir contando con la cobertura sin interrupciones. Cualquier duda, con gusto te ayudamos.`;
  }

  function waLink(phone, text) {
    const digits = String(phone).replace(/\D/g, '');
    return 'https://wa.me/' + digits + '?text=' + encodeURIComponent(text);
  }

  const searchInput = document.getElementById('searchInput');
  const sucursalFilter = document.getElementById('sucursalFilter');
  const assigneeFilter = document.getElementById('assigneeFilter');
  const estadoFilter = document.getElementById('estadoFilter');
  const statsRow = document.getElementById('cobrosStatsRow');
  const assigneeStatsTable = document.getElementById('assigneeStatsTable');

  let allCobros = [];

  function populateSucursalFilter() {
    const current = sucursalFilter.value;
    const sucursales = [...new Set(allCobros.map((c) => c.sucursal).filter(Boolean))].sort();
    sucursalFilter.innerHTML = '<option value="">Todas las sucursales</option>' +
      sucursales.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    sucursalFilter.value = current;
  }

  let defaultAssigneeApplied = false;

  function normalizeForMatch(str) {
    return String(str || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
  }

  function populateAssigneeFilter() {
    const current = assigneeFilter.value;
    const assignees = [...new Set(allCobros.map((c) => c.assignedTo).filter(Boolean))].sort();
    assigneeFilter.innerHTML = '<option value="">Todos los asignados</option>' +
      assignees.map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join('');
    assigneeFilter.value = current;

    // Las secretarias solo ven por defecto lo que les toca a ellas; pueden cambiarlo
    // manualmente si necesitan ver otra persona.
    if (currentRole === 'secretaria' && !defaultAssigneeApplied) {
      const myFirstName = normalizeForMatch(currentUserName).split(/\s+/)[0];
      const match = assignees.find((a) => normalizeForMatch(a) === myFirstName);
      if (match) {
        assigneeFilter.value = match;
        defaultAssigneeApplied = true;
      }
    }
  }

  function fmtHours(hours) {
    if (hours < 1) return Math.round(hours * 60) + ' min';
    if (hours < 48) return Math.round(hours) + ' h';
    return Math.round(hours / 24) + ' días';
  }

  function renderAssigneeStats(assigneeStats) {
    if (!assigneeStatsTable) return;
    if (!assigneeStats.length) {
      assigneeStatsTable.innerHTML = '<tr><td>Sin datos</td></tr>';
      return;
    }
    assigneeStatsTable.innerHTML = `
      <thead><tr><th>Persona</th><th>Asignados</th><th>Contactados</th><th>% avance</th><th>Tiempo prom. de contacto</th></tr></thead>
      <tbody>
        ${assigneeStats.map((a) => `
          <tr>
            <td>${escapeHtml(a.name)}</td>
            <td>${a.total}</td>
            <td>${a.contacted}</td>
            <td>${a.total ? Math.round((a.contacted / a.total) * 100) : 0}%</td>
            <td>${a.avgContactHours !== null ? fmtHours(a.avgContactHours) : '—'}</td>
          </tr>
        `).join('')}
      </tbody>
    `;
  }

  function renderStats(list) {
    const total = list.length;
    const contactados = list.filter((c) => c.contacted).length;
    const deudaTotal = list.reduce((sum, c) => sum + (c.deuda || 0), 0);
    statsRow.innerHTML = `
      <div class="stat-box"><span class="n">${total}</span><span class="l">Total</span></div>
      <div class="stat-box"><span class="n">${contactados}</span><span class="l">Contactados</span></div>
      <div class="stat-box overdue"><span class="n">${total - contactados}</span><span class="l">Pendientes</span></div>
      <div class="stat-box"><span class="n">${fmtMoney(deudaTotal)}</span><span class="l">Deuda total</span></div>
    `;
  }

  function getFiltered() {
    const q = searchInput.value.trim().toLowerCase();
    const sucursal = sucursalFilter.value;
    const assignee = assigneeFilter.value;
    const estado = estadoFilter.value;
    return allCobros.filter((c) => {
      if (q && !c.nombre.toLowerCase().includes(q)) return false;
      if (sucursal && c.sucursal !== sucursal) return false;
      if (assignee && c.assignedTo !== assignee) return false;
      if (estado === 'pendiente' && c.contacted) return false;
      if (estado === 'contactado' && !c.contacted) return false;
      return true;
    });
  }

  function renderList() {
    const filtered = getFiltered();
    renderStats(allCobros);
    if (!filtered.length) {
      cobrosList.innerHTML = '<div class="empty">No hay cobros con esos filtros.</div>';
      return;
    }
    cobrosList.innerHTML = filtered.map((c) => `
      <div class="cobro-item ${c.contacted ? 'contacted' : ''}" data-id="${c.id}">
        <div class="cobro-main">
          <span class="cobro-name">${escapeHtml(c.nombre)}</span>
          <span class="cobro-meta">${escapeHtml(c.sucursal)}${c.facturasImpagas ? ' · ' + c.facturasImpagas + ' factura(s) impaga(s)' : ''}${c.assignedTo ? ' · Asignado a ' + escapeHtml(c.assignedTo) : ''}</span>
        </div>
        <span class="cobro-deuda">${fmtMoney(c.deuda)}</span>
        <div class="cobro-actions">
          ${isPhoneLike(c.telefono)
            ? `<a class="btn-small btn-wa" href="${waLink(c.telefono, messageFor(c.nombre, c.deuda))}" target="_blank" rel="noopener" data-action="wa-sent" data-id="${c.id}">WhatsApp</a>`
            : `<span class="btn-small" title="Teléfono inválido: ${escapeHtml(c.telefono)}">Teléfono inválido</span>`}
          <button class="btn-small ${c.contacted ? 'btn-done' : ''}" data-action="toggle-contacted" data-id="${c.id}" type="button">
            ${c.contacted ? '✓ Contactado' : 'Marcar contactado'}
          </button>
        </div>
      </div>
    `).join('');
  }

  function loadCobros() {
    fetch('/api/cobros')
      .then((res) => res.json())
      .then((data) => {
        if (!data || !Array.isArray(data.cobros)) {
          cobrosList.innerHTML = '<div class="empty">No se pudo cargar (revisa la conexión).</div>';
          return;
        }
        allCobros = data.cobros;
        populateSucursalFilter();
        populateAssigneeFilter();
        renderAssigneeStats(data.assigneeStats || []);
        renderList();
      })
      .catch(() => {
        cobrosList.innerHTML = '<div class="empty">No se pudo cargar (revisa la conexión).</div>';
      });
  }

  function setContacted(id, contacted) {
    fetch('/api/cobros', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, contacted }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.cobro) return;
        const idx = allCobros.findIndex((c) => c.id === id);
        if (idx >= 0) allCobros[idx] = data.cobro;
        renderList();
        fetch('/api/cobros')
          .then((r) => r.json())
          .then((d) => { if (d && Array.isArray(d.assigneeStats)) renderAssigneeStats(d.assigneeStats); })
          .catch(() => {});
      })
      .catch(() => {});
  }

  searchInput.addEventListener('input', renderList);
  sucursalFilter.addEventListener('change', renderList);
  assigneeFilter.addEventListener('change', renderList);
  estadoFilter.addEventListener('change', renderList);

  cobrosList.addEventListener('click', function (e) {
    const waLinkEl = e.target.closest('a[data-action="wa-sent"]');
    if (waLinkEl) {
      // Al abrir WhatsApp se marca como contactado automáticamente; se puede
      // desmarcar con el botón si fue sin querer.
      setContacted(waLinkEl.getAttribute('data-id'), true);
      return;
    }
    const btn = e.target.closest('button[data-action="toggle-contacted"]');
    if (btn) {
      const id = btn.getAttribute('data-id');
      const cobro = allCobros.find((c) => c.id === id);
      setContacted(id, !(cobro && cobro.contacted));
    }
  });

  const uploadForm = document.getElementById('cobrosUploadForm');
  if (uploadForm) {
    const uploadFile = document.getElementById('cobrosUploadFile');
    const uploadResult = document.getElementById('cobrosUploadResult');
    uploadForm.addEventListener('submit', function (e) {
      e.preventDefault();
      const file = uploadFile.files && uploadFile.files[0];
      if (!file) return;
      uploadResult.innerHTML = 'Subiendo...';
      const submitBtn = uploadForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;

      const formData = new FormData();
      formData.append('file', file);
      const assigneesInput = document.getElementById('assigneesInput');
      if (assigneesInput) formData.append('assignees', assigneesInput.value);

      fetch('/api/cobros', { method: 'POST', body: formData })
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'No se pudo subir el archivo.');
          uploadResult.innerHTML = `<p class="result-ok">${data.count} cobros cargados.</p>`;
          uploadForm.reset();
          loadCobros();
        })
        .catch((err) => {
          uploadResult.innerHTML = `<p class="result-error">${escapeHtml(err.message || 'No se pudo subir el archivo.')}</p>`;
        })
        .finally(() => {
          submitBtn.disabled = false;
        });
    });
  }

  loadCobros();
});
