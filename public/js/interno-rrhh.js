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
});
