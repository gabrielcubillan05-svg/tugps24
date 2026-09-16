document.addEventListener('DOMContentLoaded', function () {
  const grid = document.getElementById('employeeGrid');
  if (!grid) return;

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function fmtDateOnly(iso) {
    if (!iso) return '';
    const [y, m, d] = String(iso).slice(0, 10).split('-');
    if (!y || !m || !d) return '';
    return `${d}/${m}/${y}`;
  }

  // ---------- Pestañas ----------
  const tabs = document.querySelectorAll('.rrhh-tab');
  const panels = document.querySelectorAll('.rrhh-panel');
  tabs.forEach((tab) => {
    tab.addEventListener('click', function () {
      tabs.forEach((t) => t.classList.remove('active'));
      panels.forEach((p) => { p.hidden = true; });
      tab.classList.add('active');
      const panel = document.querySelector(`.rrhh-panel[data-panel="${tab.getAttribute('data-tab')}"]`);
      if (panel) panel.hidden = false;
    });
  });

  const searchInput = document.getElementById('rrhhSearch');
  const fichaPanel = document.getElementById('fichaPanel');
  const fichaNombre = document.getElementById('fichaNombre');
  const fichaMsg = document.getElementById('fichaMsg');

  let employees = [];
  let currentEmployee = null;

  function render() {
    const q = (searchInput.value || '').trim().toLowerCase();
    const filtered = q ? employees.filter((e) => e.name.toLowerCase().includes(q)) : employees;
    if (!filtered.length) {
      grid.innerHTML = '<div class="empty">No hay empleados que coincidan.</div>';
      return;
    }
    grid.innerHTML = filtered.map((e) => `
      <div class="employee-card" data-id="${e.id}">
        <div class="title">${escapeHtml(e.name)}${e.active ? '' : ' (inactivo)'}</div>
        <div class="meta">${escapeHtml(e.branches.join(', ') || 'Sin sucursal')} · ${escapeHtml(e.profile.cargo || 'Sin cargo registrado')}</div>
      </div>
    `).join('');
  }

  function loadEmployees() {
    fetch('/api/employees')
      .then((res) => res.json())
      .then((data) => {
        if (!data || !Array.isArray(data.employees)) {
          grid.innerHTML = '<div class="empty">No se pudo cargar.</div>';
          return;
        }
        employees = data.employees;
        render();
      })
      .catch(() => {
        grid.innerHTML = '<div class="empty">No se pudo cargar.</div>';
      });
  }
  loadEmployees();

  let debounceTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(render, 150);
  });

  function renderVacaciones(balance) {
    const el = document.getElementById('f-vacaciones');
    if (!balance) {
      el.textContent = 'Sin datos todavía (registra la fecha de ingreso o un contrato).';
      return;
    }
    el.textContent = `${balance.remainingDays} día(s) disponibles · Acumulados: ${balance.accruedDays} · Tomados/asignados: ${balance.takenDays} · Antigüedad: ${balance.yearsOfService} año(s)`;
  }

  function renderContratos(entries) {
    const el = document.getElementById('f-contratos');
    if (!entries.length) {
      el.textContent = 'Sin contratos registrados.';
      return;
    }
    el.innerHTML = entries.map((e) => `${escapeHtml(e.type)}: ${fmtDateOnly(e.startDate)}${e.indefinite ? ' – indefinido' : e.endDate ? ' – ' + fmtDateOnly(e.endDate) : ''}`).join('<br />');
  }

  function renderIncapacidades(entries) {
    const el = document.getElementById('incapList');
    if (!entries.length) {
      el.innerHTML = '<div class="empty">Sin incapacidades registradas.</div>';
      return;
    }
    el.innerHTML = entries.map((e) => `
      <div class="list-item">
        <div class="item-top">
          <span class="title">${fmtDateOnly(e.startDate)} – ${fmtDateOnly(e.endDate)}</span>
        </div>
        ${e.note ? `<p class="note">${escapeHtml(e.note)}</p>` : ''}
        <div class="item-actions">
          <button class="btn-small btn-delete" data-action="delete-inc" data-id="${e.id}">Eliminar</button>
        </div>
      </div>
    `).join('');
  }

  function loadIncapacidades(employeeId) {
    fetch(`/api/incapacidades?employeeId=${encodeURIComponent(employeeId)}`)
      .then((res) => res.json())
      .then((data) => renderIncapacidades((data && data.entries) || []))
      .catch(() => renderIncapacidades([]));
  }

  function openFicha(employee) {
    currentEmployee = employee;
    const p = employee.profile;
    fichaNombre.textContent = `Ficha de ${employee.name}`;
    document.getElementById('f-cedula').value = p.cedula || '';
    document.getElementById('f-fechaNacimiento').value = p.fechaNacimiento ? p.fechaNacimiento.slice(0, 10) : '';
    document.getElementById('f-hijos').value = p.hijos || 0;
    document.getElementById('f-hijosEdades').value = p.hijosEdades || '';
    document.getElementById('f-telefono').value = p.telefono || '';
    document.getElementById('f-direccion').value = p.direccion || '';
    document.getElementById('f-correo').value = p.correo || '';
    document.getElementById('f-area').value = p.area || '';
    document.getElementById('f-cargo').value = p.cargo || '';
    document.getElementById('f-jefeDirecto').value = p.jefeDirecto || '';
    document.getElementById('f-sucursales').textContent = employee.branches.join(', ') || 'Sin sucursal';
    document.getElementById('f-hireDate').value = p.hireDate ? p.hireDate.slice(0, 10) : '';
    document.getElementById('f-eps').value = p.eps || '';
    document.getElementById('f-cajaCompensacion').checked = !!p.cajaCompensacion;
    document.getElementById('f-cuentaNomina').checked = !!p.cuentaNomina;
    document.getElementById('f-nesagaviria').checked = !!p.nesagaviria;
    document.getElementById('f-antiguedad').textContent = 'Calculando...';
    document.getElementById('f-contratos').textContent = 'Cargando...';
    fichaMsg.textContent = '';
    fichaMsg.classList.remove('error');

    fetch('/api/contracts')
      .then((res) => res.json())
      .then((data) => {
        const entries = ((data && data.entries) || []).filter((e) => e.employee === employee.name);
        renderContratos(entries.filter((e) => e.type === 'Contrato'));
        const balance = ((data && data.vacationBalances) || []).find((b) => b.employee === employee.name);
        renderVacaciones(balance);
        document.getElementById('f-antiguedad').textContent = balance ? `${balance.yearsOfService} año(s)` : 'Sin fecha de ingreso registrada';
      })
      .catch(() => {
        renderContratos([]);
        renderVacaciones(null);
      });

    loadIncapacidades(employee.id);
    fichaPanel.hidden = false;
    fichaPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  grid.addEventListener('click', function (e) {
    const card = e.target.closest('.employee-card');
    if (!card) return;
    const employee = employees.find((emp) => emp.id === card.getAttribute('data-id'));
    if (employee) openFicha(employee);
  });

  document.getElementById('fichaCerrar').addEventListener('click', () => {
    fichaPanel.hidden = true;
    currentEmployee = null;
  });

  document.getElementById('fichaGuardar').addEventListener('click', function () {
    if (!currentEmployee) return;
    fichaMsg.textContent = '';
    fichaMsg.classList.remove('error');
    const fields = {
      cedula: document.getElementById('f-cedula').value.trim(),
      fechaNacimiento: document.getElementById('f-fechaNacimiento').value || null,
      hijos: Number(document.getElementById('f-hijos').value) || 0,
      hijosEdades: document.getElementById('f-hijosEdades').value.trim(),
      telefono: document.getElementById('f-telefono').value.trim(),
      direccion: document.getElementById('f-direccion').value.trim(),
      correo: document.getElementById('f-correo').value.trim(),
      area: document.getElementById('f-area').value.trim(),
      cargo: document.getElementById('f-cargo').value.trim(),
      jefeDirecto: document.getElementById('f-jefeDirecto').value.trim(),
      hireDate: document.getElementById('f-hireDate').value || null,
      eps: document.getElementById('f-eps').value.trim(),
      cajaCompensacion: document.getElementById('f-cajaCompensacion').checked,
      cuentaNomina: document.getElementById('f-cuentaNomina').checked,
      nesagaviria: document.getElementById('f-nesagaviria').checked,
    };
    fetch('/api/employees', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: currentEmployee.id, fields }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo guardar.');
        currentEmployee.profile = data.profile;
        fichaMsg.textContent = 'Ficha guardada.';
        loadEmployees();
      })
      .catch((err) => {
        fichaMsg.textContent = err.message || 'No se pudo guardar.';
        fichaMsg.classList.add('error');
      });
  });

  document.getElementById('incapForm').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!currentEmployee) return;
    const startDate = document.getElementById('inc-start').value;
    const endDate = document.getElementById('inc-end').value;
    const note = document.getElementById('inc-note').value.trim();
    fetch('/api/incapacidades', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId: currentEmployee.id, employeeName: currentEmployee.name, startDate, endDate, note }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo guardar.');
        document.getElementById('incapForm').reset();
        loadIncapacidades(currentEmployee.id);
      })
      .catch((err) => alert(err.message || 'No se pudo guardar la incapacidad.'));
  });

  document.getElementById('incapList').addEventListener('click', function (e) {
    const btn = e.target.closest('button[data-action="delete-inc"]');
    if (!btn || !currentEmployee) return;
    if (!confirm('¿Eliminar esta incapacidad?')) return;
    fetch('/api/incapacidades', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: btn.getAttribute('data-id') }),
    }).then(() => loadIncapacidades(currentEmployee.id));
  });

  // ---------- Lista de empleados (para los selectores de Horarios/Compensatorios/Contratos) ----------
  const scOperatorSelect = document.getElementById('sc-operator');
  const cdOperatorSelect = document.getElementById('cd-operator');
  const ctEmployeeSelect = document.getElementById('ct-employee');

  let employeesById = [];
  function loadEmployeeSelects() {
    fetch('/api/users')
      .then((res) => res.json())
      .then((data) => {
        if (!data || !Array.isArray(data.users)) return;
        employeesById = data.users;
        const options = '<option value="">Selecciona un empleado</option>' +
          data.users.map((u) => `<option value="${escapeHtml(u.name)}" data-id="${escapeHtml(u.id)}">${escapeHtml(u.name)}</option>`).join('');
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
  loadEmployeeSelects();

  // ---------- Fecha de ingreso (perfil de RR.HH., se edita también desde Contratos) ----------
  const ctHireDateInput = document.getElementById('ct-hire-date');
  const ctHireDateSaveBtn = document.getElementById('ct-hire-date-save');
  if (ctEmployeeSelect && ctHireDateInput) {
    ctEmployeeSelect.addEventListener('change', function () {
      const user = employeesById.find((u) => u.name === ctEmployeeSelect.value);
      ctHireDateInput.value = '';
      if (!user) return;
      fetch('/api/employees')
        .then((res) => res.json())
        .then((data) => {
          const entry = data && Array.isArray(data.employees) ? data.employees.find((e) => e.id === user.id) : null;
          if (entry && entry.profile && entry.profile.hireDate) {
            ctHireDateInput.value = entry.profile.hireDate.slice(0, 10);
          }
        })
        .catch(() => {});
    });
  }
  if (ctHireDateSaveBtn) {
    ctHireDateSaveBtn.addEventListener('click', function () {
      const user = employeesById.find((u) => u.name === ctEmployeeSelect.value);
      if (!user) {
        alert('Selecciona primero un empleado.');
        return;
      }
      fetch('/api/employees', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: user.id, fields: { hireDate: ctHireDateInput.value || null } }),
      })
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'No se pudo guardar.');
          if (typeof loadContracts === 'function') loadContracts();
        })
        .catch((err) => alert(err.message || 'No se pudo guardar la fecha de ingreso.'));
    });
  }

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
        body: JSON.stringify({ operator, horario, days: selectedDays, start, end }),
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
  const compDaysTotals = document.getElementById('compDaysTotals');
  const cdEmployeeFilter = document.getElementById('cdEmployeeFilter');
  const cdStatusFilter = document.getElementById('cdStatusFilter');
  if (compDaysList) {
    let allCompDaysEntries = [];

    function renderCompDaysTotals(totals, grantedTotals) {
      if (!compDaysTotals) return;
      const employees = [...new Set([...Object.keys(totals), ...Object.keys(grantedTotals)])].sort();
      if (!employees.length) {
        compDaysTotals.innerHTML = '';
        return;
      }
      compDaysTotals.innerHTML = employees.map((op) => `
        <div class="stat-box">
          <span class="n">${totals[op] || 0}</span>
          <span class="l">${escapeHtml(op)}${grantedTotals[op] ? ' · ' + grantedTotals[op] + ' ya dado(s)' : ''}</span>
          ${totals[op] ? `
            <button class="btn-small btn-done" data-action="assign-next" data-operator="${escapeHtml(op)}" type="button" style="margin-top:6px;">Asignar día libre</button>
            <div class="assign-next-picker" data-operator="${escapeHtml(op)}" hidden>
              <input type="date" data-assign-next-input style="width:auto;" />
              <button class="btn-small btn-done" data-action="confirm-assign-next" data-operator="${escapeHtml(op)}" type="button">Confirmar</button>
            </div>
          ` : ''}
        </div>
      `).join('');
    }

    function populateCdEmployeeFilter() {
      if (!cdEmployeeFilter) return;
      const employees = [...new Set(allCompDaysEntries.map((e) => e.operator))].sort();
      const current = cdEmployeeFilter.value;
      cdEmployeeFilter.innerHTML = '<option value="">Todos los empleados</option>' +
        employees.map((op) => `<option value="${escapeHtml(op)}">${escapeHtml(op)}</option>`).join('');
      cdEmployeeFilter.value = current;
    }

    function getFilteredCompDays() {
      const employee = cdEmployeeFilter ? cdEmployeeFilter.value : '';
      const status = cdStatusFilter ? cdStatusFilter.value : '';
      return allCompDaysEntries.filter((e) => {
        if (employee && e.operator !== employee) return false;
        if (status === 'pendiente' && e.scheduledDate) return false;
        if (status === 'asignado' && !e.scheduledDate) return false;
        return true;
      });
    }

    function renderCompDaysList() {
      const entries = getFilteredCompDays();
      if (!entries.length) {
        compDaysList.innerHTML = '<div class="empty">No hay registros con esos filtros.</div>';
        return;
      }
      compDaysList.innerHTML = entries.map((e) => `
        <div class="list-item">
          <div class="item-top">
            <span class="title">${escapeHtml(e.operator)}</span>
            <span class="badge">Trabajó: ${fmtDateOnly(e.workedDate)}</span>
            ${e.scheduledDate ? `<span class="badge status-indefinido">Asignado: ${fmtDateOnly(e.scheduledDate)}</span>` : '<span class="badge status-proximo">Pendiente</span>'}
          </div>
          ${e.note ? `<p class="note">${escapeHtml(e.note)}</p>` : ''}
          <div class="item-actions" style="align-items:center;">
            <label style="color:var(--slate); font-size:12px;">Compensatorio:</label>
            <input type="date" data-schedule-input data-id="${e.id}" value="${e.scheduledDate ? e.scheduledDate.slice(0, 10) : ''}" style="width:auto;" />
            <button class="btn-small btn-done" data-action="save-schedule" data-id="${e.id}" type="button">Guardar fecha</button>
            <button class="btn-small btn-delete" data-action="delete-cd" data-id="${e.id}">Eliminar</button>
          </div>
        </div>
      `).join('');
    }

    function renderCompDays(entries, totals, grantedTotals) {
      allCompDaysEntries = entries;
      renderCompDaysTotals(totals, grantedTotals);
      populateCdEmployeeFilter();
      renderCompDaysList();
    }

    if (cdEmployeeFilter) cdEmployeeFilter.addEventListener('change', renderCompDaysList);
    if (cdStatusFilter) cdStatusFilter.addEventListener('change', renderCompDaysList);

    function loadCompDays() {
      fetch('/api/comp-days')
        .then((res) => res.json())
        .then((data) => {
          if (data && Array.isArray(data.entries)) renderCompDays(data.entries, data.totals || {}, data.grantedTotals || {});
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
        const workedDate = document.getElementById('cd-worked').value;
        const note = document.getElementById('cd-note').value.trim();
        const scheduledDate = document.getElementById('cd-scheduled').value || null;
        if (!operator || !workedDate) return;

        fetch('/api/comp-days', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operator, workedDate, note, scheduledDate }),
        })
          .then(async (res) => {
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'No se pudo guardar.');
            compDaysForm.reset();
            loadCompDays();
          })
          .catch((err) => alert(err.message || 'No se pudo guardar.'));
      });
    }

    compDaysTotals.addEventListener('click', function (e) {
      const openBtn = e.target.closest('button[data-action="assign-next"]');
      if (openBtn) {
        const operator = openBtn.getAttribute('data-operator');
        const picker = compDaysTotals.querySelector(`.assign-next-picker[data-operator="${operator}"]`);
        if (picker) picker.hidden = !picker.hidden;
        return;
      }
      const confirmBtn = e.target.closest('button[data-action="confirm-assign-next"]');
      if (confirmBtn) {
        const operator = confirmBtn.getAttribute('data-operator');
        const picker = compDaysTotals.querySelector(`.assign-next-picker[data-operator="${operator}"]`);
        const input = picker ? picker.querySelector('[data-assign-next-input]') : null;
        const scheduledDate = input ? input.value : '';
        if (!scheduledDate) return;
        fetch('/api/comp-days', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operator, scheduledDate, assignNext: true }),
        })
          .then(async (res) => {
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'No se pudo asignar.');
            loadCompDays();
          })
          .catch((err) => alert(err.message || 'No se pudo asignar.'));
      }
    });

    compDaysList.addEventListener('click', function (e) {
      const delBtn = e.target.closest('button[data-action="delete-cd"]');
      if (delBtn) {
        if (!confirm('¿Eliminar este registro?')) return;
        const id = delBtn.getAttribute('data-id');
        fetch('/api/comp-days', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        }).then(loadCompDays);
        return;
      }
      const schedBtn = e.target.closest('button[data-action="save-schedule"]');
      if (schedBtn) {
        const id = schedBtn.getAttribute('data-id');
        const input = compDaysList.querySelector(`input[data-schedule-input][data-id="${id}"]`);
        const scheduledDate = input ? input.value || null : null;
        fetch('/api/comp-days', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, scheduledDate }),
        })
          .then(() => loadCompDays())
          .catch(() => alert('No se pudo guardar la fecha.'));
      }
    });

    loadCompDays();
  }

  // ---------- Contratos y vacaciones ----------
  const contractForm = document.getElementById('contractForm');
  const contractsList = document.getElementById('contractsList');
  const vacationBalancesEl = document.getElementById('vacationBalances');
  const ctEndInput = document.getElementById('ct-end');
  const ctIndefiniteCheck = document.getElementById('ct-indefinite');

  if (ctIndefiniteCheck) {
    ctIndefiniteCheck.addEventListener('change', function () {
      ctEndInput.disabled = ctIndefiniteCheck.checked;
      if (ctIndefiniteCheck.checked) ctEndInput.value = '';
    });
  }

  const STATUS_LABELS = {
    vencido: 'Vencido',
    proximo: 'Próximo a vencer',
    proxima: 'Próxima',
    vigente: 'Vigente',
    indefinido: 'Indefinido',
    programada: 'Programada',
  };

  if (contractsList) {
    function renderVacationBalances(balances) {
      if (!vacationBalancesEl) return;
      if (!balances.length) {
        vacationBalancesEl.innerHTML = '<div class="empty">Sin datos todavía (registra al menos un contrato por empleado).</div>';
        return;
      }
      vacationBalancesEl.innerHTML = balances.map((b) => `
        <div class="list-item">
          <div class="item-top">
            <span class="title">${escapeHtml(b.employee)}</span>
            <span class="badge">${b.remainingDays} día(s) disponibles</span>
          </div>
          <div class="meta">
            ${b.hireDate ? 'Ingreso: ' + fmtDateOnly(b.hireDate) + ' · Antigüedad: ' + b.yearsOfService + ' año(s)' : 'Sin fecha de ingreso registrada'}
            · Acumulados: ${b.accruedDays} · Tomados/asignados: ${b.takenDays}
          </div>
        </div>
      `).join('');
    }

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
            <span class="badge status-${e.status}">${STATUS_LABELS[e.status] || e.status}</span>
          </div>
          <div class="meta">
            ${fmtDateOnly(e.startDate)}${e.indefinite ? ' – indefinido' : e.endDate ? ' – ' + fmtDateOnly(e.endDate) : ''}
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
          if (data && Array.isArray(data.entries)) {
            renderContracts(data.entries);
            renderVacationBalances(data.vacationBalances || []);
          } else {
            contractsList.innerHTML = '<div class="empty">No se pudo cargar.</div>';
          }
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
        const indefinite = ctIndefiniteCheck.checked;
        const endDate = indefinite ? null : (ctEndInput.value || null);
        const note = document.getElementById('ct-note').value.trim();
        if (!employee || !type || !startDate) return;
        if (type === 'Vacaciones' && !endDate) {
          alert('Las vacaciones necesitan fecha de fin.');
          return;
        }

        fetch('/api/contracts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ employee, type, startDate, endDate, indefinite, note }),
        })
          .then(async (res) => {
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'No se pudo guardar.');
            contractForm.reset();
            ctEndInput.disabled = false;
            loadContracts();
          })
          .catch((err) => alert(err.message || 'No se pudo guardar.'));
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
