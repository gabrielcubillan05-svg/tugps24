document.addEventListener('DOMContentLoaded', function () {
  const agendaList = document.getElementById('agendaList');
  if (!agendaList) return;

  const data = document.getElementById('apagadosData');
  const canDelete = !!(data && data.dataset.canDelete);
  const apgStats = document.getElementById('apgStats');
  const itemsBody = document.getElementById('itemsBody');
  const itemsCount = document.getElementById('itemsCount');
  const logBody = document.getElementById('logBody');
  const searchInput = document.getElementById('searchInput');
  const form = document.getElementById('apgForm');
  const formTitle = document.getElementById('formTitle');
  const formMsg = document.getElementById('formMsg');
  const saveBtn = document.getElementById('saveBtn');
  const cancelEditBtn = document.getElementById('cancelEditBtn');
  const testAlarmBtn = document.getElementById('testAlarmBtn');
  const f = {
    placa: document.getElementById('fPlaca'),
    cliente: document.getElementById('fCliente'),
    accion: document.getElementById('fAccion'),
    hora: document.getElementById('fHora'),
    repeat: document.getElementById('fRepeat'),
    fecha: document.getElementById('fFecha'),
    fechaWrap: document.getElementById('fFechaWrap'),
    diasWrap: document.getElementById('fDiasWrap'),
    nota: document.getElementById('fNota'),
  };

  const ACTION_LABEL = { apagar: 'Apagar', encender: 'Encender' };
  const DAY_SHORT = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

  let items = [];
  let agenda = [];
  let log = [];
  let editingId = null;
  let serverOffsetMs = 0;

  function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmtDateTime(iso) {
    return iso ? new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' }) : '—';
  }

  function colombiaNowKey() {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(Date.now() + serverOffsetMs));
    const p = {};
    parts.forEach((x) => { p[x.type] = x.value; });
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  }

  function repeatLabel(i) {
    if (i.repeat === 'diario') return 'Todos los días';
    if (i.repeat === 'lun_vie') return 'Lunes a viernes';
    if (i.repeat === 'dias') return (i.dias || []).map((d) => DAY_SHORT[d]).join(', ');
    if (i.repeat === 'una_vez') return `Solo el ${i.fecha || '—'}`;
    return i.repeat;
  }

  function renderAgenda() {
    const nowKey = colombiaNowKey();
    const pend = agenda.filter((e) => e.status === 'pendiente').length;
    const done = agenda.filter((e) => e.status === 'hecho').length;
    const late = agenda.filter((e) => e.status === 'vencido').length;
    apgStats.innerHTML = `
      <div class="stat-box"><span class="n">${pend}</span><span class="l">Pendientes hoy</span></div>
      <div class="stat-box"><span class="n">${done}</span><span class="l">Hechos</span></div>
      <div class="stat-box"><span class="n" style="${late ? 'color:var(--danger)' : ''}">${late}</span><span class="l">Vencidos sin confirmar</span></div>`;
    if (!agenda.length) {
      agendaList.innerHTML = '<div class="empty">Hoy no hay apagados ni encendidos programados.</div>';
      return;
    }
    agendaList.innerHTML = agenda.map((e) => {
      const due = e.status === 'pendiente' && e.slot <= nowKey;
      const status = e.status === 'hecho'
        ? `<span class="status-tag hecho">Hecho por ${escapeHtml(e.doneByName)} · ${fmtDateTime(e.doneAt)}</span>`
        : e.status === 'vencido'
          ? '<span class="status-tag vencido">Vencido · sin confirmar</span>'
          : due ? '<span class="status-tag vencido">Es ahora</span>' : '<span class="status-tag">Pendiente</span>';
      const btn = e.status === 'hecho' ? '' : `<button class="btn-small btn-done" data-done="${e.id}" data-slot="${e.slot}" type="button">Hecho</button>`;
      return `
        <div class="agenda-row ${e.status} ${due ? 'due' : ''}">
          <div class="time">${e.hora}</div>
          <div class="what">
            <span class="action-tag ${e.accion}">${ACTION_LABEL[e.accion] || e.accion}</span>
            <span class="placa">${escapeHtml(e.placa)}</span>${e.cliente ? ' · ' + escapeHtml(e.cliente) : ''}
            ${e.nota ? `<div class="sub">${escapeHtml(e.nota)}</div>` : ''}
          </div>
          ${status}
          ${btn}
        </div>`;
    }).join('');
  }

  function renderItems() {
    const q = searchInput.value.trim().toLowerCase();
    const rows = items.filter((i) => !q || i.placa.toLowerCase().includes(q) || (i.cliente || '').toLowerCase().includes(q));
    itemsCount.textContent = `${rows.length} de ${items.length}`;
    if (!rows.length) {
      itemsBody.innerHTML = '<tr><td colspan="8" class="empty">No hay programaciones.</td></tr>';
      return;
    }
    itemsBody.innerHTML = rows.map((i) => `
      <tr class="${i.activo ? '' : 'inactivo'}" data-id="${i.id}">
        <td><strong>${i.hora}</strong></td>
        <td><span class="action-tag ${i.accion}">${ACTION_LABEL[i.accion] || i.accion}</span></td>
        <td><strong>${escapeHtml(i.placa)}</strong></td>
        <td>${escapeHtml(i.cliente) || '<span class="hint" style="margin:0;">—</span>'}</td>
        <td>${escapeHtml(repeatLabel(i))}</td>
        <td>${escapeHtml(i.nota) || ''}</td>
        <td>${i.activo ? 'Activa' : 'Pausada'}</td>
        <td class="actions">
          <button class="btn-small" data-action="toggle" data-id="${i.id}" type="button">${i.activo ? 'Pausar' : 'Activar'}</button>
          <button class="btn-small" data-action="edit" data-id="${i.id}" type="button">Editar</button>
          ${canDelete ? `<button class="btn-small btn-delete" data-action="delete" data-id="${i.id}" type="button">Eliminar</button>` : ''}
        </td>
      </tr>`).join('');
  }

  function renderLog() {
    if (!log.length) {
      logBody.innerHTML = '<tr><td colspan="7" class="empty">Todavía no hay confirmaciones.</td></tr>';
      return;
    }
    logBody.innerHTML = log.slice(0, 50).map((e) => `
      <tr>
        <td>${escapeHtml(String(e.slot || '').replace('T', ' '))}</td>
        <td><span class="action-tag ${e.accion}">${ACTION_LABEL[e.accion] || e.accion}</span></td>
        <td><strong>${escapeHtml(e.placa)}</strong></td>
        <td>${escapeHtml(e.cliente)}</td>
        <td>${fmtDateTime(e.doneAt)}</td>
        <td>${escapeHtml(e.doneByName)}</td>
        <td>${e.lateMinutes ? `<span class="status-tag vencido">${e.lateMinutes} min</span>` : 'A tiempo'}</td>
      </tr>`).join('');
  }

  function renderAll() {
    renderAgenda();
    renderItems();
    renderLog();
  }

  function load() {
    fetch('/api/apagados-programados')
      .then((res) => res.json())
      .then((d) => {
        if (!d || !Array.isArray(d.items)) {
          agendaList.innerHTML = `<div class="empty">No se pudo cargar${d && d.error ? ': ' + escapeHtml(d.error) : ''}.</div>`;
          return;
        }
        items = d.items;
        agenda = d.agenda || [];
        log = d.log || [];
        if (d.serverNow) serverOffsetMs = Date.parse(d.serverNow) - Date.now();
        renderAll();
      })
      .catch(() => {
        agendaList.innerHTML = '<div class="empty">No se pudo cargar (revisa la conexión).</div>';
      });
  }

  function request(method, body) {
    return fetch('/api/apagados-programados', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async (res) => {
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'No se pudo guardar.');
      return d;
    });
  }

  function notifyAlarmScript() {
    document.dispatchEvent(new CustomEvent('apagados:changed'));
  }

  function syncRepeatFields() {
    f.fechaWrap.style.display = f.repeat.value === 'una_vez' ? '' : 'none';
    f.diasWrap.style.display = f.repeat.value === 'dias' ? '' : 'none';
  }

  function selectedDias() {
    return Array.from(f.diasWrap.querySelectorAll('input[type="checkbox"]:checked')).map((c) => parseInt(c.value, 10));
  }

  function resetForm() {
    editingId = null;
    form.reset();
    syncRepeatFields();
    formTitle.textContent = 'Nueva programación';
    saveBtn.textContent = 'Guardar programación';
    cancelEditBtn.style.display = 'none';
    formMsg.textContent = '';
  }

  function fillForm(i) {
    editingId = i.id;
    f.placa.value = i.placa;
    f.cliente.value = i.cliente || '';
    f.accion.value = i.accion;
    f.hora.value = i.hora;
    f.repeat.value = i.repeat;
    f.fecha.value = i.fecha || '';
    f.nota.value = i.nota || '';
    f.diasWrap.querySelectorAll('input[type="checkbox"]').forEach((c) => { c.checked = (i.dias || []).includes(parseInt(c.value, 10)); });
    syncRepeatFields();
    formTitle.textContent = `Editando ${i.placa}`;
    saveBtn.textContent = 'Guardar cambios';
    cancelEditBtn.style.display = '';
    formMsg.textContent = '';
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    f.placa.focus();
  }

  f.repeat.addEventListener('change', syncRepeatFields);
  cancelEditBtn.addEventListener('click', resetForm);

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    const payload = {
      placa: f.placa.value,
      cliente: f.cliente.value,
      accion: f.accion.value,
      hora: f.hora.value,
      repeat: f.repeat.value,
      dias: selectedDias(),
      fecha: f.fecha.value,
      nota: f.nota.value,
    };
    saveBtn.disabled = true;
    formMsg.textContent = 'Guardando...';
    const req = editingId ? request('PATCH', { id: editingId, ...payload }) : request('POST', payload);
    req
      .then(() => {
        formMsg.textContent = editingId ? 'Cambios guardados.' : 'Programación guardada.';
        resetForm();
        load();
        notifyAlarmScript();
      })
      .catch((err) => { formMsg.textContent = err.message; })
      .finally(() => { saveBtn.disabled = false; });
  });

  agendaList.addEventListener('click', function (e) {
    const btn = e.target.closest('button[data-done]');
    if (!btn) return;
    btn.disabled = true;
    request('POST', { action: 'done', id: btn.getAttribute('data-done'), slot: btn.getAttribute('data-slot') })
      .then(() => { load(); notifyAlarmScript(); })
      .catch((err) => { alert(err.message); btn.disabled = false; });
  });

  itemsBody.addEventListener('click', function (e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    const item = items.find((i) => i.id === id);
    if (!item) return;
    const action = btn.getAttribute('data-action');
    if (action === 'edit') {
      fillForm(item);
    } else if (action === 'toggle') {
      btn.disabled = true;
      request('PATCH', { id, activo: !item.activo })
        .then(() => { load(); notifyAlarmScript(); })
        .catch((err) => { alert(err.message); btn.disabled = false; });
    } else if (action === 'delete') {
      if (!confirm(`¿Eliminar la programación de ${ACTION_LABEL[item.accion].toLowerCase()} ${item.placa} a las ${item.hora}?`)) return;
      request('DELETE', { id })
        .then(() => { if (editingId === id) resetForm(); load(); notifyAlarmScript(); })
        .catch((err) => alert(err.message));
    }
  });

  searchInput.addEventListener('input', renderItems);

  testAlarmBtn.addEventListener('click', function () {
    if (window.TuGpsAlarmas && typeof window.TuGpsAlarmas.test === 'function') {
      window.TuGpsAlarmas.test();
    } else {
      alert('La alarma solo suena en las cuentas de operador y supervisor, que son quienes están en la central.');
    }
  });

  syncRepeatFields();
  load();
  // La agenda cambia sola con la hora (pendiente → es ahora → vencido) y cuando otro operador
  // confirma desde su pantalla.
  setInterval(load, 30000);
  setInterval(renderAgenda, 10000);
});
