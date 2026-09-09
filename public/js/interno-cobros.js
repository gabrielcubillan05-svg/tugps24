document.addEventListener('DOMContentLoaded', function () {
  const cobrosList = document.getElementById('cobrosList');
  if (!cobrosList) return; // no autenticado o sin permiso

  const cobrosData = document.getElementById('cobrosData');
  const currentRole = (cobrosData && cobrosData.dataset.role) || '';
  const currentUserName = (cobrosData && cobrosData.dataset.userName) || '';
  const canSeeAll = !!(cobrosData && cobrosData.dataset.canSeeAll);

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
  const agentStatsRow = document.getElementById('agentStatsRow');

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
    // Quien no puede subir listas ya solo recibe del servidor lo que le toca a
    // ella — no tiene sentido mostrarle un filtro para "cambiar de usuario".
    if (!canSeeAll) {
      assigneeFilter.style.display = 'none';
      return;
    }
    const current = assigneeFilter.value;
    const assignees = [...new Set(allCobros.map((c) => c.assignedTo).filter(Boolean))].sort();
    assigneeFilter.innerHTML = '<option value="">Todos los asignados</option>' +
      assignees.map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join('');
    assigneeFilter.value = current;

    // Por defecto se ve lo propio si el nombre coincide con algún asignado (ej. un
    // supervisor que también hace llamadas); puede cambiarlo, a diferencia de una
    // secretaria normal, porque sí tiene permiso para ver a todos.
    if (!defaultAssigneeApplied) {
      const myFirstName = normalizeForMatch(currentUserName).split(/\s+/)[0];
      const match = assignees.find((a) => normalizeForMatch(a) === myFirstName);
      if (match) {
        assigneeFilter.value = match;
        defaultAssigneeApplied = true;
      }
    }
  }

  function renderAgentStats(agentStats) {
    if (!agentStatsRow || !agentStats) return;
    agentStatsRow.innerHTML = `
      <div class="stat-box"><span class="n">${agentStats.total}</span><span class="l">Total</span></div>
      <div class="stat-box"><span class="n">${agentStats.templateSent}</span><span class="l">Recordatorios enviados</span></div>
      <div class="stat-box"><span class="n">${agentStats.enConversacion}</span><span class="l">En conversación</span></div>
      <div class="stat-box"><span class="n">${agentStats.acuerdo}</span><span class="l">Acuerdos de pago</span></div>
      <div class="stat-box overdue"><span class="n">${agentStats.escalado}</span><span class="l">Escalados</span></div>
      <div class="stat-box"><span class="n">${fmtMoney(agentStats.deudaEnAcuerdo)}</span><span class="l">Deuda en acuerdo</span></div>
    `;
  }

  function renderStats(list) {
    const total = list.length;
    const contactados = list.filter((c) => c.contacted).length;
    const deudaTotalBox = currentRole === 'admin'
      ? `<div class="stat-box"><span class="n">${fmtMoney(list.reduce((sum, c) => sum + (c.deuda || 0), 0))}</span><span class="l">Deuda total</span></div>`
      : '';
    statsRow.innerHTML = `
      <div class="stat-box"><span class="n">${total}</span><span class="l">Total</span></div>
      <div class="stat-box"><span class="n">${contactados}</span><span class="l">Contactados</span></div>
      <div class="stat-box overdue"><span class="n">${total - contactados}</span><span class="l">Pendientes</span></div>
      ${deudaTotalBox}
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
          ${canSeeAll && isPhoneLike(c.telefono)
            ? `<button class="btn-small" data-action="send-reminder" data-id="${c.id}" type="button" title="${c.templateSentAt ? 'Enviado el ' + new Date(c.templateSentAt).toLocaleString('es-CO') : ''}">${c.templateSentAt ? '↻ Reenviar recordatorio IA' : 'Recordatorio IA (WhatsApp)'}</button>`
            : ''}
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
        renderAgentStats(data.agentStats);
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
          .then((d) => { if (d && d.agentStats) renderAgentStats(d.agentStats); })
          .catch(() => {});
      })
      .catch(() => {});
  }

  searchInput.addEventListener('input', renderList);
  sucursalFilter.addEventListener('change', renderList);
  assigneeFilter.addEventListener('change', renderList);
  estadoFilter.addEventListener('change', renderList);

  function sendReminder(id, btn) {
    const cobro = allCobros.find((c) => c.id === id);
    const confirmMsg = cobro && cobro.templateSentAt
      ? '¿Reenviar el recordatorio de pago por WhatsApp? Ya se le había enviado antes.'
      : '¿Enviar el recordatorio de pago por WhatsApp? A partir de la respuesta del cliente, la agente IA de cobranza sigue la conversación.';
    if (!confirm(confirmMsg)) return;
    btn.disabled = true;
    btn.textContent = 'Enviando...';
    fetch('/api/cobros', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action: 'sendWhatsappReminder' }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.cobro) throw new Error(data.error || 'No se pudo enviar el recordatorio.');
        const idx = allCobros.findIndex((c) => c.id === id);
        if (idx >= 0) allCobros[idx] = data.cobro;
        renderList();
      })
      .catch((err) => {
        alert(err.message || 'No se pudo enviar el recordatorio.');
        renderList();
      });
  }

  cobrosList.addEventListener('click', function (e) {
    const waLinkEl = e.target.closest('a[data-action="wa-sent"]');
    if (waLinkEl) {
      // Al abrir WhatsApp se marca como contactado automáticamente; se puede
      // desmarcar con el botón si fue sin querer.
      setContacted(waLinkEl.getAttribute('data-id'), true);
      return;
    }
    const reminderBtn = e.target.closest('button[data-action="send-reminder"]');
    if (reminderBtn) {
      sendReminder(reminderBtn.getAttribute('data-id'), reminderBtn);
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
          uploadResult.innerHTML = `<p class="result-ok">${data.count} cobro(s) nuevo(s)${data.updated ? ` · ${data.updated} actualizado(s) (mismo número de cliente)` : ''}${data.skippedNoPhone ? ` · ${data.skippedNoPhone} omitido(s) por no tener teléfono` : ''}.</p>`;
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

  const sendAllReminderBtn = document.getElementById('cobrosSendAllReminderBtn');
  if (sendAllReminderBtn) {
    const sendAllReminderResult = document.getElementById('cobrosSendAllReminderResult');
    sendAllReminderBtn.addEventListener('click', function () {
      const pendientes = allCobros.filter((c) => !c.templateSentAt && isPhoneLike(c.telefono)).length;
      if (!pendientes) {
        sendAllReminderResult.textContent = 'No hay cobros pendientes de recordatorio.';
        return;
      }
      if (!confirm(`¿Enviar el recordatorio de pago por WhatsApp a los ${pendientes} cobros pendientes? A partir de ahí, la agente IA de cobranza sigue cada conversación.`)) return;
      sendAllReminderBtn.disabled = true;

      let totalSent = 0;
      let totalFailed = 0;

      function nextBatch() {
        sendAllReminderResult.textContent = `Enviando... ${totalSent} enviados hasta ahora.`;
        fetch('/api/cobros', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'sendWhatsappReminderAll' }),
        })
          .then(async (res) => {
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'No se pudo enviar el recordatorio.');
            totalSent += data.sent || 0;
            totalFailed += data.failed || 0;
            if (data.remaining > 0) {
              nextBatch();
            } else {
              sendAllReminderResult.textContent = `Listo: ${totalSent} recordatorio(s) enviado(s)${totalFailed ? `, ${totalFailed} fallido(s)` : ''}.`;
              sendAllReminderBtn.disabled = false;
              loadCobros();
            }
          })
          .catch((err) => {
            sendAllReminderResult.textContent = err.message || 'No se pudo enviar el recordatorio.';
            sendAllReminderBtn.disabled = false;
            loadCobros();
          });
      }
      nextBatch();
    });
  }

  const deleteAllBtn = document.getElementById('cobrosDeleteAllBtn');
  if (deleteAllBtn) {
    const deleteAllResult = document.getElementById('cobrosDeleteAllResult');
    deleteAllBtn.addEventListener('click', function () {
      if (!confirm(`¿Borrar TODOS los cobros (${allCobros.length})? Esto no se puede deshacer.`)) return;
      deleteAllBtn.disabled = true;
      deleteAllResult.textContent = 'Borrando...';
      fetch('/api/cobros', { method: 'DELETE' })
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'No se pudo borrar.');
          deleteAllResult.textContent = `${data.deleted} cobro(s) borrados.`;
          loadCobros();
        })
        .catch((err) => {
          deleteAllResult.textContent = err.message || 'No se pudo borrar.';
        })
        .finally(() => { deleteAllBtn.disabled = false; });
    });
  }

  const clearAssignmentsBtn = document.getElementById('cobrosClearAssignmentsBtn');
  if (clearAssignmentsBtn) {
    const clearAssignmentsResult = document.getElementById('cobrosClearAssignmentsResult');
    clearAssignmentsBtn.addEventListener('click', function () {
      if (!confirm('¿Quitar la asignación a trabajador de TODOS los cobros? Quedarán "Sin asignar" (la agente IA los gestiona igual).')) return;
      clearAssignmentsBtn.disabled = true;
      clearAssignmentsResult.textContent = 'Quitando asignaciones...';
      fetch('/api/cobros', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'clearAllAssignments' }),
      })
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'No se pudo quitar las asignaciones.');
          clearAssignmentsResult.textContent = `${data.cleared} cobro(s) quedaron sin asignar.`;
          loadCobros();
        })
        .catch((err) => {
          clearAssignmentsResult.textContent = err.message || 'No se pudo quitar las asignaciones.';
        })
        .finally(() => { clearAssignmentsBtn.disabled = false; });
    });
  }

  loadCobros();
});
