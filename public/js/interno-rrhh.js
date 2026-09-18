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
  const branchFilter = document.getElementById('rrhhBranchFilter');
  const cargoFilter = document.getElementById('rrhhCargoFilter');
  const activeFilter = document.getElementById('rrhhActiveFilter');
  const fichaPanel = document.getElementById('fichaPanel');
  const fichaNombre = document.getElementById('fichaNombre');
  const fichaMsg = document.getElementById('fichaMsg');

  let employees = [];
  let currentEmployee = null;

  function populateCargoFilter() {
    const cargos = [...new Set(employees.map((e) => e.profile.cargo).filter(Boolean))].sort();
    const current = cargoFilter.value;
    cargoFilter.innerHTML = '<option value="">Todos los cargos</option>' +
      cargos.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    cargoFilter.value = current;
  }

  function render() {
    const q = (searchInput.value || '').trim().toLowerCase();
    const branch = branchFilter.value;
    const cargo = cargoFilter.value;
    const activeState = activeFilter ? activeFilter.value : '';
    const filtered = employees.filter((e) => {
      if (q && !e.name.toLowerCase().includes(q)) return false;
      if (branch && !e.branches.includes(branch)) return false;
      if (cargo && e.profile.cargo !== cargo) return false;
      if (activeState === 'activos' && !e.active) return false;
      if (activeState === 'inactivos' && e.active) return false;
      return true;
    });
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
        populateCargoFilter();
        render();
        // La lista de Compensatorios también filtra por cargo — si ya cargó antes que los
        // empleados, se refresca aquí para que el filtro y los nombres queden completos.
        if (typeof refreshCompDaysCargoUI === 'function') refreshCompDaysCargoUI();
        if (typeof refreshSchCargoUI === 'function') refreshSchCargoUI();
        if (typeof refreshVbCargoUI === 'function') refreshVbCargoUI();
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
  branchFilter.addEventListener('change', render);
  cargoFilter.addEventListener('change', render);
  if (activeFilter) activeFilter.addEventListener('change', render);

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
        ${e.diagnostico ? `<div class="meta"><strong>Diagnóstico:</strong> ${escapeHtml(e.diagnostico)}</div>` : ''}
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

  function calcAge(fechaNacimiento) {
    if (!fechaNacimiento) return null;
    const [y, m, d] = String(fechaNacimiento).slice(0, 10).split('-').map(Number);
    if (!y) return null;
    const today = new Date();
    let age = today.getFullYear() - y;
    const hasHadBirthdayThisYear = today.getMonth() + 1 > m || (today.getMonth() + 1 === m && today.getDate() >= d);
    if (!hasHadBirthdayThisYear) age -= 1;
    return age;
  }

  const hijosList = document.getElementById('hijosList');

  function renderHijosList(hijos) {
    if (!hijosList) return;
    if (!hijos.length) {
      hijosList.innerHTML = '<div class="empty" style="padding:8px 0;">Sin hijos registrados.</div>';
      return;
    }
    hijosList.innerHTML = hijos.map((h, i) => {
      const age = calcAge(h.fechaNacimiento);
      return `
      <div class="esquema-form" data-hijo-row data-index="${i}" style="align-items:center;">
        <input type="text" data-hijo-nombre placeholder="Nombre" value="${escapeHtml(h.nombre)}" style="flex:2;" />
        <input type="date" data-hijo-fecha value="${h.fechaNacimiento ? h.fechaNacimiento.slice(0, 10) : ''}" style="flex:1;" />
        <select data-hijo-genero style="flex:1;">
          <option value="">Género</option>
          <option value="Masculino" ${h.genero === 'Masculino' ? 'selected' : ''}>Masculino</option>
          <option value="Femenino" ${h.genero === 'Femenino' ? 'selected' : ''}>Femenino</option>
          <option value="Otro" ${h.genero === 'Otro' ? 'selected' : ''}>Otro</option>
        </select>
        <span class="ficha-readonly" style="padding:0 6px;">${age !== null ? age + ' año(s)' : ''}</span>
        <button class="btn-small btn-delete" data-action="remove-hijo" data-index="${i}" type="button">Quitar</button>
      </div>
    `;
    }).join('');
  }

  function collectHijosFromForm() {
    return Array.from(hijosList.querySelectorAll('[data-hijo-row]')).map((row) => ({
      nombre: row.querySelector('[data-hijo-nombre]').value.trim(),
      fechaNacimiento: row.querySelector('[data-hijo-fecha]').value || '',
      genero: row.querySelector('[data-hijo-genero]').value,
    }));
  }

  let currentHijos = [];
  if (hijosList) {
    document.getElementById('hijoAgregar').addEventListener('click', () => {
      currentHijos = collectHijosFromForm();
      currentHijos.push({ nombre: '', fechaNacimiento: '', genero: '' });
      renderHijosList(currentHijos);
    });
    hijosList.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action="remove-hijo"]');
      if (!btn) return;
      currentHijos = collectHijosFromForm();
      currentHijos.splice(Number(btn.getAttribute('data-index')), 1);
      renderHijosList(currentHijos);
    });
  }

  function openFicha(employee) {
    currentEmployee = employee;
    const p = employee.profile;
    fichaNombre.textContent = `Ficha de ${employee.name}`;
    document.getElementById('f-cedula').value = p.cedula || '';
    document.getElementById('f-fechaNacimiento').value = p.fechaNacimiento ? p.fechaNacimiento.slice(0, 10) : '';
    currentHijos = Array.isArray(p.hijos) ? p.hijos : [];
    renderHijosList(currentHijos);
    document.getElementById('f-telefono').value = p.telefono || '';
    document.getElementById('f-direccion').value = p.direccion || '';
    document.getElementById('f-correo').value = p.correo || '';
    document.getElementById('f-area').value = p.area || '';
    document.getElementById('f-cargo').value = p.cargo || '';
    document.getElementById('f-jefeDirecto').value = p.jefeDirecto || '';
    document.getElementById('f-sucursales').textContent = employee.branches.join(', ') || 'Sin sucursal';
    document.getElementById('f-hireDate').value = p.hireDate ? p.hireDate.slice(0, 10) : '';
    document.getElementById('f-fechaRetiro').value = p.fechaRetiro ? p.fechaRetiro.slice(0, 10) : '';
    document.getElementById('f-vacacionesAjuste').value = p.vacacionesAjuste || 0;
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
      hijos: collectHijosFromForm(),
      telefono: document.getElementById('f-telefono').value.trim(),
      direccion: document.getElementById('f-direccion').value.trim(),
      correo: document.getElementById('f-correo').value.trim(),
      area: document.getElementById('f-area').value.trim(),
      cargo: document.getElementById('f-cargo').value.trim(),
      jefeDirecto: document.getElementById('f-jefeDirecto').value.trim(),
      hireDate: document.getElementById('f-hireDate').value || null,
      fechaRetiro: document.getElementById('f-fechaRetiro').value || null,
      vacacionesAjuste: Number(document.getElementById('f-vacacionesAjuste').value) || 0,
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
    const diagnostico = document.getElementById('inc-diagnostico').value.trim();
    const note = document.getElementById('inc-note').value.trim();
    fetch('/api/incapacidades', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId: currentEmployee.id, employeeName: currentEmployee.name, startDate, endDate, diagnostico, note }),
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
    const schSearch = document.getElementById('schSearch');
    const schBranchFilter = document.getElementById('schBranchFilter');
    const schCargoFilter = document.getElementById('schCargoFilter');
    let allSchedule = [];

    function populateSchCargoFilter() {
      if (!schCargoFilter) return;
      const cargos = [...new Set(employees.map((e) => e.profile.cargo).filter(Boolean))].sort();
      const current = schCargoFilter.value;
      schCargoFilter.innerHTML = '<option value="">Todos los cargos</option>' +
        cargos.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
      schCargoFilter.value = current;
    }

    function getFilteredSchedule() {
      const q = (schSearch ? schSearch.value : '').trim().toLowerCase();
      const branch = schBranchFilter ? schBranchFilter.value : '';
      const cargo = schCargoFilter ? schCargoFilter.value : '';
      return allSchedule.filter((s) => {
        if (q && !s.operator.toLowerCase().includes(q)) return false;
        const info = employees.find((e) => e.name === s.operator);
        if (branch && (!info || !info.branches.includes(branch))) return false;
        if (cargo && (!info || info.profile.cargo !== cargo)) return false;
        return true;
      });
    }

    function renderScheduleFiltered() {
      renderSchedule(getFilteredSchedule());
    }

    if (schSearch) schSearch.addEventListener('input', renderScheduleFiltered);
    if (schBranchFilter) schBranchFilter.addEventListener('change', renderScheduleFiltered);
    if (schCargoFilter) schCargoFilter.addEventListener('change', renderScheduleFiltered);

    // Igual que refreshCompDaysCargoUI: si los empleados cargan después que los horarios, se
    // refresca el filtro de cargo y el renderizado ya con la info de sucursal/cargo completa.
    window.refreshSchCargoUI = function () {
      populateSchCargoFilter();
      renderScheduleFiltered();
    };

    function renderSchedule(schedule) {
      if (!schedule.length) {
        scheduleList.innerHTML = allSchedule.length
          ? '<div class="empty">No hay horarios con esos filtros.</div>'
          : '<div class="empty">No hay horarios registrados todavía.</div>';
        return;
      }
      const byOperator = new Map();
      schedule.forEach((s) => {
        if (!byOperator.has(s.operator)) byOperator.set(s.operator, []);
        byOperator.get(s.operator).push(s);
      });

      scheduleList.innerHTML = [...byOperator.entries()].map(([operator, entries]) => {
        const daysCovered = new Set(entries.flatMap((e) => e.days || []));
        const freeDays = DAY_ORDER.filter((d) => !daysCovered.has(d));
        const rows = entries.map((e, i) => {
          const isLast = i === entries.length - 1;
          const cells = DAY_ORDER.map((d) => {
            if ((e.days || []).includes(d)) return '<td class="schedule-cell schedule-x">X</td>';
            if (isLast && freeDays.includes(d)) return '<td class="schedule-cell schedule-libre">libre</td>';
            return '<td class="schedule-cell"></td>';
          }).join('');
          return `
            <tr>
              <td class="schedule-hora">${escapeHtml(e.start)} a ${escapeHtml(e.end)}</td>
              ${cells}
              <td><button class="btn-small btn-delete" data-action="delete-sched" data-id="${e.id}" type="button">Eliminar</button></td>
            </tr>
          `;
        }).join('');
        return `
          <div class="list-item">
            <div class="item-top"><span class="title">${escapeHtml(operator)}</span></div>
            <div class="table-scroll">
              <table class="schedule-table">
                <thead>
                  <tr>
                    <th>Hora</th>
                    ${DAY_ORDER.map((d) => `<th>${d.slice(0, 3)}</th>`).join('')}
                    <th></th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
          </div>
        `;
      }).join('');
    }

    function loadSchedule() {
      fetch('/api/schedule')
        .then((res) => res.json())
        .then((data) => {
          if (data && Array.isArray(data.schedule)) {
            allSchedule = data.schedule;
            renderScheduleFiltered();
          } else {
            scheduleList.innerHTML = '<div class="empty">No se pudo cargar.</div>';
          }
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
  const cdCargoFilter = document.getElementById('cdCargoFilter');
  const cdBranchFilter = document.getElementById('cdBranchFilter');
  const cdCargoFilter2 = document.getElementById('cdCargoFilter2');
  if (compDaysList) {
    let allCompDaysEntries = [];

    function cargoOf(operatorName) {
      const emp = employees.find((e) => e.name === operatorName);
      return (emp && emp.profile && emp.profile.cargo) || '';
    }

    function populateCdCargoFilter() {
      const cargos = [...new Set(employees.map((e) => e.profile.cargo).filter(Boolean))].sort();
      const options = '<option value="">Todos los cargos</option>' +
        cargos.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
      if (cdCargoFilter) {
        const current = cdCargoFilter.value;
        cdCargoFilter.innerHTML = options;
        cdCargoFilter.value = current;
      }
      if (cdCargoFilter2) {
        const current2 = cdCargoFilter2.value;
        cdCargoFilter2.innerHTML = options;
        cdCargoFilter2.value = current2;
      }
    }

    function renderCompDaysTotals(totals, grantedTotals) {
      if (!compDaysTotals) return;
      const cargo = cdCargoFilter ? cdCargoFilter.value : '';
      let employeeNames = [...new Set([...Object.keys(totals), ...Object.keys(grantedTotals)])];
      if (cargo) employeeNames = employeeNames.filter((op) => cargoOf(op) === cargo);
      // De mayor a menor cantidad de pendientes, para ver primero a quien más días tiene sin asignar.
      employeeNames.sort((a, b) => (totals[b] || 0) - (totals[a] || 0) || a.localeCompare(b));
      if (!employeeNames.length) {
        compDaysTotals.innerHTML = '<div class="empty">No hay empleados que coincidan.</div>';
        return;
      }
      compDaysTotals.innerHTML = employeeNames.map((op) => `
        <div class="list-item">
          <div class="item-top">
            <span class="title">${escapeHtml(op)}</span>
            <span class="badge">${totals[op] || 0} pendiente(s)</span>
            ${grantedTotals[op] ? `<span class="badge status-indefinido">${grantedTotals[op]} ya dado(s)</span>` : ''}
          </div>
          ${totals[op] ? `
            <div class="item-actions" style="align-items:center;">
              <button class="btn-small btn-done" data-action="assign-next" data-operator="${escapeHtml(op)}" type="button">Asignar día libre</button>
            </div>
            <div class="assign-next-picker" data-operator="${escapeHtml(op)}" hidden>
              <input type="date" data-assign-next-input style="width:auto;" />
              <input type="text" data-assign-next-note placeholder="Motivo (opcional)" style="width:auto; flex:1; min-width:160px;" />
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
      const branch = cdBranchFilter ? cdBranchFilter.value : '';
      const cargo = cdCargoFilter2 ? cdCargoFilter2.value : '';
      return allCompDaysEntries.filter((e) => {
        if (employee && e.operator !== employee) return false;
        if (status === 'pendiente' && e.scheduledDate) return false;
        if (status === 'asignado' && !e.scheduledDate) return false;
        if (branch || cargo) {
          const info = employees.find((emp) => emp.name === e.operator);
          if (branch && (!info || !info.branches.includes(branch))) return false;
          if (cargo && (!info || info.profile.cargo !== cargo)) return false;
        }
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
            ${e.scheduledDate ? `
              <button class="btn-small btn-delete" data-action="cancel-schedule" data-id="${e.id}" type="button">Cancelado (regresar a pendiente)</button>
            ` : `
              <label style="color:var(--slate); font-size:12px;">Compensatorio:</label>
              <input type="date" data-schedule-input data-id="${e.id}" style="width:auto;" />
              <button class="btn-small btn-done" data-action="save-schedule" data-id="${e.id}" type="button">Guardar fecha</button>
            `}
            <button class="btn-small btn-delete" data-action="delete-cd" data-id="${e.id}">Eliminar</button>
          </div>
        </div>
      `).join('');
    }

    let latestTotals = {};
    let latestGranted = {};

    function renderCompDays(entries, totals, grantedTotals) {
      allCompDaysEntries = entries;
      latestTotals = totals;
      latestGranted = grantedTotals;
      renderCompDaysTotals(totals, grantedTotals);
      populateCdEmployeeFilter();
      renderCompDaysList();
    }

    window.refreshCompDaysCargoUI = function () {
      populateCdCargoFilter();
      renderCompDaysTotals(latestTotals, latestGranted);
      renderCompDaysList();
    };

    if (cdEmployeeFilter) cdEmployeeFilter.addEventListener('change', renderCompDaysList);
    if (cdStatusFilter) cdStatusFilter.addEventListener('change', renderCompDaysList);
    if (cdBranchFilter) cdBranchFilter.addEventListener('change', renderCompDaysList);
    if (cdCargoFilter2) cdCargoFilter2.addEventListener('change', renderCompDaysList);
    if (cdCargoFilter) cdCargoFilter.addEventListener('change', () => renderCompDaysTotals(latestTotals, latestGranted));

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
        const noteInput = picker ? picker.querySelector('[data-assign-next-note]') : null;
        const scheduledDate = input ? input.value : '';
        if (!scheduledDate) return;
        fetch('/api/comp-days', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operator, scheduledDate, assignNext: true, note: noteInput ? noteInput.value.trim() : '' }),
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
        if (!scheduledDate) return;
        fetch('/api/comp-days', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, scheduledDate }),
        })
          .then(() => loadCompDays())
          .catch(() => alert('No se pudo guardar la fecha.'));
        return;
      }
      const cancelBtn = e.target.closest('button[data-action="cancel-schedule"]');
      if (cancelBtn) {
        if (!confirm('¿Cancelar esta asignación y regresarlo a pendiente?')) return;
        const id = cancelBtn.getAttribute('data-id');
        fetch('/api/comp-days', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, scheduledDate: null }),
        })
          .then(() => loadCompDays())
          .catch(() => alert('No se pudo cancelar la asignación.'));
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
    disfrutada: 'Disfrutada',
  };

  const ctTypeFilter = document.getElementById('ctTypeFilter');
  const ctBranchFilter = document.getElementById('ctBranchFilter');
  const ctEmployeeFilter = document.getElementById('ctEmployeeFilter');
  const ctCargoFilter = document.getElementById('ctCargoFilter');

  const vbBranchFilter = document.getElementById('vbBranchFilter');
  const vbCargoFilter = document.getElementById('vbCargoFilter');

  if (contractsList) {
    let allContractEntries = [];
    let allVacationBalances = [];

    function employeeInfo(name) {
      return employees.find((e) => e.name === name);
    }

    function populateVbCargoFilter() {
      if (!vbCargoFilter) return;
      const cargos = [...new Set(employees.map((e) => e.profile.cargo).filter(Boolean))].sort();
      const current = vbCargoFilter.value;
      vbCargoFilter.innerHTML = '<option value="">Todos los cargos</option>' +
        cargos.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
      vbCargoFilter.value = current;
    }

    function getFilteredVacationBalances() {
      const branch = vbBranchFilter ? vbBranchFilter.value : '';
      const cargo = vbCargoFilter ? vbCargoFilter.value : '';
      if (!branch && !cargo) return allVacationBalances;
      return allVacationBalances.filter((b) => {
        const info = employeeInfo(b.employee);
        if (branch && (!info || !info.branches.includes(branch))) return false;
        if (cargo && (!info || info.profile.cargo !== cargo)) return false;
        return true;
      });
    }

    function renderVacationBalancesFiltered() {
      renderVacationBalances(getFilteredVacationBalances());
    }

    if (vbBranchFilter) vbBranchFilter.addEventListener('change', renderVacationBalancesFiltered);
    if (vbCargoFilter) vbCargoFilter.addEventListener('change', renderVacationBalancesFiltered);

    window.refreshVbCargoUI = function () {
      populateVbCargoFilter();
      renderVacationBalancesFiltered();
    };

    function renderVacationBalances(balances) {
      if (!vacationBalancesEl) return;
      if (!balances.length) {
        vacationBalancesEl.innerHTML = allVacationBalances.length
          ? '<div class="empty">No hay empleados que coincidan.</div>'
          : '<div class="empty">Sin datos todavía (registra al menos un contrato por empleado).</div>';
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
            · Acumulados: ${b.accruedDays} · Tomados/asignados: ${b.takenDays}${b.paidDays ? ` (${b.paidDays} pagado(s))` : ''}${b.ajusteInicial ? ` · Ajuste manual: ${b.ajusteInicial > 0 ? '+' : ''}${b.ajusteInicial}` : ''}
          </div>
        </div>
      `).join('');
    }

    function populateContractFilters() {
      if (ctEmployeeFilter) {
        const names = [...new Set(allContractEntries.map((e) => e.employee))].sort();
        const current = ctEmployeeFilter.value;
        ctEmployeeFilter.innerHTML = '<option value="">Todos los empleados</option>' +
          names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
        ctEmployeeFilter.value = current;
      }
      if (ctCargoFilter) {
        const cargos = [...new Set(employees.map((e) => e.profile.cargo).filter(Boolean))].sort();
        const current = ctCargoFilter.value;
        ctCargoFilter.innerHTML = '<option value="">Todos los cargos</option>' +
          cargos.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
        ctCargoFilter.value = current;
      }
    }

    function getFilteredContracts() {
      const type = ctTypeFilter ? ctTypeFilter.value : '';
      const branch = ctBranchFilter ? ctBranchFilter.value : '';
      const employeeName = ctEmployeeFilter ? ctEmployeeFilter.value : '';
      const cargo = ctCargoFilter ? ctCargoFilter.value : '';
      return allContractEntries.filter((e) => {
        if (type && e.type !== type) return false;
        if (employeeName && e.employee !== employeeName) return false;
        const info = employeeInfo(e.employee);
        if (branch && (!info || !info.branches.includes(branch))) return false;
        if (cargo && (!info || info.profile.cargo !== cargo)) return false;
        return true;
      });
    }

    let editingCtId = null;

    function renderContracts() {
      const entries = getFilteredContracts();
      if (!entries.length) {
        contractsList.innerHTML = '<div class="empty">No hay registros con esos filtros.</div>';
        return;
      }
      contractsList.innerHTML = entries.map((e) => {
        if (e.id === editingCtId) {
          return `
            <div class="list-item">
              <div class="item-top">
                <span class="title">${escapeHtml(e.employee)}</span>
                <span class="badge">${escapeHtml(e.type)}</span>
              </div>
              <div class="form-grid cols-4">
                <div class="field"><label>Fecha inicio</label><input type="date" data-edit-field="startDate" value="${e.startDate || ''}" /></div>
                <div class="field">
                  <label>Fecha fin</label>
                  <input type="date" data-edit-field="endDate" value="${e.endDate || ''}" ${e.indefinite ? 'disabled' : ''} />
                  ${e.type === 'Contrato' ? `<label class="day-check" style="margin-top:6px;"><input type="checkbox" data-edit-field="indefinite" ${e.indefinite ? 'checked' : ''} /> Indefinido</label>` : ''}
                </div>
                ${e.type === 'Vacaciones' ? `<div class="field"><label class="day-check"><input type="checkbox" data-edit-field="pagada" ${e.pagada ? 'checked' : ''} /> Pagada en dinero</label></div>` : ''}
                <div class="field field-note"><label>Nota</label><input type="text" data-edit-field="note" value="${escapeHtml(e.note || '')}" /></div>
              </div>
              <div class="item-actions">
                <button class="btn-small btn-done" data-action="save-edit-ct" data-id="${e.id}" type="button">Guardar</button>
                <button class="btn-small btn-ghost" data-action="cancel-edit-ct" type="button">Cancelar</button>
              </div>
            </div>
          `;
        }
        return `
        <div class="list-item">
          <div class="item-top">
            <span class="title">${escapeHtml(e.employee)}</span>
            <span class="badge">${escapeHtml(e.type)}${e.pagada ? ' (pagada)' : ''}</span>
            <span class="badge status-${e.status}">${STATUS_LABELS[e.status] || e.status}</span>
          </div>
          <div class="meta">
            ${fmtDateOnly(e.startDate)}${e.indefinite ? ' – indefinido' : e.endDate ? ' – ' + fmtDateOnly(e.endDate) : ''}
          </div>
          ${e.note ? `<p class="note">${escapeHtml(e.note)}</p>` : ''}
          <div class="item-actions">
            <button class="btn-small" data-action="edit-ct" data-id="${e.id}" type="button">Editar</button>
            <button class="btn-small btn-delete" data-action="delete-ct" data-id="${e.id}">Eliminar</button>
          </div>
        </div>
      `;
      }).join('');
    }

    [ctTypeFilter, ctBranchFilter, ctEmployeeFilter, ctCargoFilter].forEach((el) => {
      if (el) el.addEventListener('change', renderContracts);
    });

    function loadContracts() {
      fetch('/api/contracts')
        .then((res) => res.json())
        .then((data) => {
          if (data && Array.isArray(data.entries)) {
            allContractEntries = data.entries;
            allVacationBalances = data.vacationBalances || [];
            populateContractFilters();
            populateVbCargoFilter();
            renderContracts();
            renderVacationBalancesFiltered();
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
        const pagada = document.getElementById('ct-pagada').checked;
        if (!employee || !type || !startDate) return;
        if (type === 'Vacaciones' && !endDate) {
          alert('Las vacaciones necesitan fecha de fin.');
          return;
        }

        fetch('/api/contracts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ employee, type, startDate, endDate, indefinite, note, pagada }),
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
      const deleteBtn = e.target.closest('button[data-action="delete-ct"]');
      if (deleteBtn) {
        if (!confirm('¿Eliminar este registro?')) return;
        const id = deleteBtn.getAttribute('data-id');
        fetch('/api/contracts', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        }).then(loadContracts);
        return;
      }
      const editBtn = e.target.closest('button[data-action="edit-ct"]');
      if (editBtn) {
        editingCtId = editBtn.getAttribute('data-id');
        renderContracts();
        return;
      }
      const cancelBtn = e.target.closest('button[data-action="cancel-edit-ct"]');
      if (cancelBtn) {
        editingCtId = null;
        renderContracts();
        return;
      }
      const saveBtn = e.target.closest('button[data-action="save-edit-ct"]');
      if (saveBtn) {
        const id = saveBtn.getAttribute('data-id');
        const row = saveBtn.closest('.list-item');
        const fieldValue = (name) => row.querySelector(`[data-edit-field="${name}"]`);
        const startDate = fieldValue('startDate') ? fieldValue('startDate').value : '';
        const indefiniteEl = fieldValue('indefinite');
        const endDateEl = fieldValue('endDate');
        const pagadaEl = fieldValue('pagada');
        const noteEl = fieldValue('note');
        fetch('/api/contracts', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id,
            startDate,
            endDate: indefiniteEl && indefiniteEl.checked ? null : (endDateEl ? endDateEl.value : null),
            indefinite: indefiniteEl ? indefiniteEl.checked : false,
            pagada: pagadaEl ? pagadaEl.checked : false,
            note: noteEl ? noteEl.value.trim() : '',
          }),
        })
          .then(async (res) => {
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'No se pudo guardar.');
            editingCtId = null;
            loadContracts();
          })
          .catch((err) => alert(err.message || 'No se pudo guardar.'));
      }
    });

    loadContracts();
  }

  // ---------- Solicitudes de vacaciones ----------
  const vacRequestsList = document.getElementById('vacRequestsList');
  const VAC_STATUS_LABELS = { pendiente: 'Pendiente', aprobada: 'Aprobada', rechazada: 'Rechazada' };
  const VAC_STATUS_CLASS = { pendiente: 'status-proximo', aprobada: 'status-indefinido', rechazada: 'status-vencido' };

  if (vacRequestsList) {
    function renderVacRequests(entries) {
      if (!entries.length) {
        vacRequestsList.innerHTML = '<div class="empty">No hay solicitudes todavía.</div>';
        return;
      }
      vacRequestsList.innerHTML = entries.map((e) => `
        <div class="list-item" data-vac-row data-id="${e.id}">
          <div class="item-top">
            <span class="title">${escapeHtml(e.employeeName)}</span>
            <span class="badge ${VAC_STATUS_CLASS[e.status] || ''}">${VAC_STATUS_LABELS[e.status] || e.status}</span>
          </div>
          ${e.status === 'pendiente' ? `
            <div class="item-actions" style="align-items:center;">
              <label style="color:var(--slate); font-size:12px;">Fechas (editables antes de aprobar):</label>
              <input type="date" data-vac-start value="${e.startDate.slice(0, 10)}" style="width:auto;" />
              <input type="date" data-vac-end value="${e.endDate.slice(0, 10)}" style="width:auto;" />
            </div>
          ` : `<div class="meta">${fmtDateOnly(e.startDate)} – ${fmtDateOnly(e.endDate)}</div>`}
          ${e.note ? `<p class="note">${escapeHtml(e.note)}</p>` : ''}
          ${e.status === 'pendiente' ? `
            <div class="item-actions">
              <button class="btn-small btn-done" data-action="approve-vac" data-id="${e.id}">Aprobar</button>
              <button class="btn-small btn-delete" data-action="reject-vac" data-id="${e.id}">Rechazar</button>
            </div>
          ` : ''}
        </div>
      `).join('');
    }

    function loadVacRequests() {
      fetch('/api/vacation-requests')
        .then((res) => res.json())
        .then((data) => renderVacRequests((data && data.entries) || []))
        .catch(() => {
          vacRequestsList.innerHTML = '<div class="empty">No se pudo cargar.</div>';
        });
    }
    loadVacRequests();

    vacRequestsList.addEventListener('click', function (e) {
      const approveBtn = e.target.closest('button[data-action="approve-vac"]');
      const rejectBtn = e.target.closest('button[data-action="reject-vac"]');
      const btn = approveBtn || rejectBtn;
      if (!btn) return;
      const status = approveBtn ? 'aprobada' : 'rechazada';
      const id = btn.getAttribute('data-id');
      const row = vacRequestsList.querySelector(`[data-vac-row][data-id="${id}"]`);
      const startInput = row ? row.querySelector('[data-vac-start]') : null;
      const endInput = row ? row.querySelector('[data-vac-end]') : null;
      const payload = { id, status };
      if (startInput) payload.startDate = startInput.value;
      if (endInput) payload.endDate = endInput.value;
      fetch('/api/vacation-requests', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'No se pudo actualizar.');
          loadVacRequests();
        })
        .catch((err) => alert(err.message || 'No se pudo actualizar.'));
    });
  }
});
