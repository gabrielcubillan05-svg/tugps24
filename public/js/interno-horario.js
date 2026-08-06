document.addEventListener('DOMContentLoaded', function () {
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function fmtDate(iso) {
    const d = new Date(iso);
    return d.toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });
  }

  function fmtDateOnly(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('es-CO', { dateStyle: 'medium' });
  }

  // ---------- Lista de empleados (para los selectores de esta página) ----------
  const scOperatorSelect = document.getElementById('sc-operator');
  const cdOperatorSelect = document.getElementById('cd-operator');
  const ctEmployeeSelect = document.getElementById('ct-employee');

  function loadEmployees() {
    fetch('/api/users')
      .then((res) => res.json())
      .then((data) => {
        if (!data || !Array.isArray(data.users)) return;
        const options = '<option value="">Selecciona un empleado</option>' +
          data.users.map((u) => `<option value="${escapeHtml(u.name)}">${escapeHtml(u.name)}</option>`).join('');
        if (scOperatorSelect) scOperatorSelect.innerHTML = options;
        if (cdOperatorSelect) cdOperatorSelect.innerHTML = options;
        if (ctEmployeeSelect) ctEmployeeSelect.innerHTML = options;
      })
      .catch(() => {
        const fallback = '<option value="">No se pudo cargar la lista</option>';
        if (scOperatorSelect) scOperatorSelect.innerHTML = fallback;
        if (cdOperatorSelect) cdOperatorSelect.innerHTML = fallback;
        if (ctEmployeeSelect) ctEmployeeSelect.innerHTML = fallback;
      });
  }
  loadEmployees();

  // ---------- Horario ----------
  const DAY_ORDER = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
  const scheduleForm = document.getElementById('scheduleForm');
  const scheduleList = document.getElementById('scheduleList');
  const scheduleError = document.getElementById('scheduleError');

  function composeHorario(selectedDays, start, end) {
    const ordered = DAY_ORDER.filter((d) => selectedDays.includes(d));
    const indices = ordered.map((d) => DAY_ORDER.indexOf(d));
    let daysLabel;
    const isContiguous = indices.every((v, i) => i === 0 || v === indices[i - 1] + 1);
    if (ordered.length === 1) {
      daysLabel = ordered[0];
    } else if (isContiguous) {
      daysLabel = `${ordered[0]} a ${ordered[ordered.length - 1]}`;
    } else {
      daysLabel = ordered.join(', ');
    }
    return `${daysLabel}, turno ${start}-${end}`;
  }

  if (scheduleList) {
    function renderSchedule(schedule) {
      if (!schedule.length) {
        scheduleList.innerHTML = '<div class="empty">No hay horarios registrados todavía.</div>';
        return;
      }
      const byOperator = new Map();
      schedule.forEach((s) => {
        if (!byOperator.has(s.operator)) byOperator.set(s.operator, []);
        byOperator.get(s.operator).push(s);
      });

      scheduleList.innerHTML = [...byOperator.entries()].map(([operator, entries]) => `
        <div class="list-item">
          <div class="item-top"><span class="title">${escapeHtml(operator)}</span></div>
          ${entries.map((e) => `
            <div class="schedule-line" style="display:flex; justify-content:space-between; align-items:center; gap:8px; padding:4px 0;">
              <p class="note" style="margin:0;">${escapeHtml(e.horario)}</p>
              <button class="btn-small btn-delete" data-action="delete-sched" data-id="${e.id}" type="button">Eliminar</button>
            </div>
          `).join('')}
        </div>
      `).join('');
    }

    function loadSchedule() {
      fetch('/api/schedule')
        .then((res) => res.json())
        .then((data) => {
          if (data && Array.isArray(data.schedule)) renderSchedule(data.schedule);
          else scheduleList.innerHTML = '<div class="empty">No se pudo cargar.</div>';
        })
        .catch(() => {
          scheduleList.innerHTML = '<div class="empty">No se pudo cargar.</div>';
        });
    }

    scheduleForm.addEventListener('submit', function (e) {
      e.preventDefault();
      scheduleError.style.display = 'none';
      const operator = scOperatorSelect.value;
      const start = document.getElementById('sc-start').value;
      const end = document.getElementById('sc-end').value;
      const selectedDays = Array.from(scheduleForm.querySelectorAll('.sc-day:checked')).map((el) => el.value);

      if (!operator || !start || !end || !selectedDays.length) {
        scheduleError.textContent = 'Selecciona el empleado, al menos un día y ambas horas.';
        scheduleError.style.display = 'block';
        return;
      }

      const horario = composeHorario(selectedDays, start, end);

      fetch('/api/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operator, horario }),
      })
        .then((res) => res.json())
        .then(() => {
          scheduleForm.querySelectorAll('.sc-day:checked').forEach((el) => { el.checked = false; });
          document.getElementById('sc-start').value = '';
          document.getElementById('sc-end').value = '';
          loadSchedule();
        })
        .catch(() => {
          scheduleError.textContent = 'No se pudo guardar.';
          scheduleError.style.display = 'block';
        });
    });

    scheduleList.addEventListener('click', function (e) {
      const btn = e.target.closest('button[data-action="delete-sched"]');
      if (!btn) return;
      if (!confirm('¿Eliminar esta franja de horario?')) return;
      const id = btn.getAttribute('data-id');
      fetch('/api/schedule', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      }).then(loadSchedule);
    });

    loadSchedule();
  }

  // ---------- Días compensatorios ----------
  const compDaysForm = document.getElementById('compDaysForm');
  const compDaysList = document.getElementById('compDaysList');
  if (compDaysList) {
    function renderCompDays(entries, totals) {
      const totalsHtml = Object.keys(totals).length
        ? '<div class="meta" style="margin-bottom:14px;">' +
          Object.entries(totals).map(([op, d]) => `${escapeHtml(op)}: <b>${d}</b> día(s)`).join(' · ') +
          '</div>'
        : '';
      if (!entries.length) {
        compDaysList.innerHTML = totalsHtml + '<div class="empty">No hay registros todavía.</div>';
        return;
      }
      compDaysList.innerHTML = totalsHtml + entries.map((e) => `
        <div class="list-item">
          <div class="item-top">
            <span class="title">${escapeHtml(e.operator)}</span>
            <span class="badge">${e.days > 0 ? '+' : ''}${e.days} día(s)</span>
          </div>
          ${e.note ? `<p class="note">${escapeHtml(e.note)}</p>` : ''}
          <div class="meta">
            ${fmtDate(e.createdAt)}
            ${e.scheduledDate ? ' · Se dará el ' + fmtDateOnly(e.scheduledDate) : ''}
          </div>
          <div class="item-actions">
            <button class="btn-small btn-delete" data-action="delete-cd" data-id="${e.id}">Eliminar</button>
          </div>
        </div>
      `).join('');
    }

    function loadCompDays() {
      fetch('/api/comp-days')
        .then((res) => res.json())
        .then((data) => {
          if (data && Array.isArray(data.entries)) renderCompDays(data.entries, data.totals || {});
          else compDaysList.innerHTML = '<div class="empty">No se pudo cargar.</div>';
        })
        .catch(() => {
          compDaysList.innerHTML = '<div class="empty">No se pudo cargar.</div>';
        });
    }

    if (compDaysForm) {
      compDaysForm.addEventListener('submit', function (e) {
        e.preventDefault();
        const operator = cdOperatorSelect.value;
        const days = Number(document.getElementById('cd-days').value);
        const note = document.getElementById('cd-note').value.trim();
        const scheduledDate = document.getElementById('cd-scheduled').value || null;
        if (!operator || !days) return;

        fetch('/api/comp-days', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operator, days, note, scheduledDate }),
        })
          .then((res) => res.json())
          .then(() => {
            compDaysForm.reset();
            loadCompDays();
          })
          .catch(() => alert('No se pudo guardar.'));
      });
    }

    compDaysList.addEventListener('click', function (e) {
      const btn = e.target.closest('button[data-action="delete-cd"]');
      if (!btn) return;
      if (!confirm('¿Eliminar este registro?')) return;
      const id = btn.getAttribute('data-id');
      fetch('/api/comp-days', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      }).then(loadCompDays);
    });

    loadCompDays();
  }

  // ---------- Contratos y vacaciones ----------
  const contractForm = document.getElementById('contractForm');
  const contractsList = document.getElementById('contractsList');
  if (contractsList) {
    function renderContracts(entries) {
      if (!entries.length) {
        contractsList.innerHTML = '<div class="empty">No hay registros todavía.</div>';
        return;
      }
      contractsList.innerHTML = entries.map((e) => `
        <div class="list-item">
          <div class="item-top">
            <span class="title">${escapeHtml(e.employee)}</span>
            <span class="badge">${escapeHtml(e.type)}</span>
          </div>
          <div class="meta">
            ${fmtDateOnly(e.startDate)}${e.endDate ? ' – ' + fmtDateOnly(e.endDate) : ''}
          </div>
          ${e.note ? `<p class="note">${escapeHtml(e.note)}</p>` : ''}
          <div class="item-actions">
            <button class="btn-small btn-delete" data-action="delete-ct" data-id="${e.id}">Eliminar</button>
          </div>
        </div>
      `).join('');
    }

    function loadContracts() {
      fetch('/api/contracts')
        .then((res) => res.json())
        .then((data) => {
          if (data && Array.isArray(data.entries)) renderContracts(data.entries);
          else contractsList.innerHTML = '<div class="empty">No se pudo cargar.</div>';
        })
        .catch(() => {
          contractsList.innerHTML = '<div class="empty">No se pudo cargar.</div>';
        });
    }

    if (contractForm) {
      contractForm.addEventListener('submit', function (e) {
        e.preventDefault();
        const employee = ctEmployeeSelect.value;
        const type = document.getElementById('ct-type').value;
        const startDate = document.getElementById('ct-start').value;
        const endDate = document.getElementById('ct-end').value || null;
        const note = document.getElementById('ct-note').value.trim();
        if (!employee || !type || !startDate) return;

        fetch('/api/contracts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ employee, type, startDate, endDate, note }),
        })
          .then((res) => res.json())
          .then(() => {
            contractForm.reset();
            loadContracts();
          })
          .catch(() => alert('No se pudo guardar.'));
      });
    }

    contractsList.addEventListener('click', function (e) {
      const btn = e.target.closest('button[data-action="delete-ct"]');
      if (!btn) return;
      if (!confirm('¿Eliminar este registro?')) return;
      const id = btn.getAttribute('data-id');
      fetch('/api/contracts', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      }).then(loadContracts);
    });

    loadContracts();
  }
});
