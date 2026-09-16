document.addEventListener('DOMContentLoaded', function () {
  const listEl = document.getElementById('importList');
  const summaryEl = document.getElementById('importSummary');
  const btnGuardar = document.getElementById('btnGuardar');
  const btnCargar = document.getElementById('btnCargar');
  const pasteArea = document.getElementById('pasteArea');
  if (!listEl) return;

  let optimusData = [];
  let employees = [];

  function normalize(str) {
    return String(str || '')
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
  }

  function bestMatch(record, employeeList) {
    const tokens = normalize(record.nombre);
    let best = null;
    let bestScore = 0;
    for (const emp of employeeList) {
      const empTokens = new Set(normalize(emp.name));
      let score = 0;
      for (const t of tokens) {
        if (t.length > 1 && empTokens.has(t)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        best = emp;
      }
    }
    return bestScore >= 2 ? best : null;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function render() {
    if (!optimusData.length) {
      listEl.innerHTML = '<div class="empty">Pega el JSON de datos arriba y presiona "Cargar datos".</div>';
      return;
    }
    listEl.innerHTML = optimusData.map((r, idx) => {
      const match = bestMatch(r, employees);
      const options = ['<option value="">-- no importar --</option>']
        .concat(employees.map((e) => `<option value="${e.id}" ${match && match.id === e.id ? 'selected' : ''}>${escapeHtml(e.name)} (${escapeHtml(e.username)})</option>`))
        .join('');
      return `
        <div class="import-row ${match ? '' : 'import-nomatch'}" data-idx="${idx}">
          <div class="import-fields">
            <label>Nombre (Optimus)<input type="text" value="${escapeHtml(r.nombre)}" disabled /></label>
            <label>Cédula<input type="text" data-field="cedula" value="${escapeHtml(r.cedula)}" /></label>
            <label>Fecha nacimiento<input type="date" data-field="fechaNacimiento" value="${escapeHtml(r.fechaNacimiento)}" /></label>
            <label>Teléfono<input type="text" data-field="telefono" value="${escapeHtml(r.telefono)}" /></label>
            <label>Dirección<input type="text" data-field="direccion" value="${escapeHtml(r.direccion)}" /></label>
            <label>Correo<input type="text" data-field="correo" value="${escapeHtml(r.correo)}" /></label>
          </div>
          <div class="import-match">
            <div class="orig-name">Sucursal Optimus: ${escapeHtml(r.sucursal || '')} · ${escapeHtml(r.puesto || '')}${!match ? ' — sin coincidencia automática' : ''}</div>
            <select data-employee-select>${options}</select>
            <div class="import-row-status"></div>
          </div>
        </div>
      `;
    }).join('');
  }

  btnCargar.addEventListener('click', function () {
    try {
      const parsed = JSON.parse(pasteArea.value);
      if (!Array.isArray(parsed)) throw new Error('no es una lista');
      optimusData = parsed;
      pasteArea.value = '';
      render();
    } catch {
      alert('El JSON pegado no es válido.');
    }
  });

  fetch('/api/employees')
    .then((res) => res.json())
    .then((data) => {
      employees = Array.isArray(data.employees) ? data.employees : [];
      render();
    })
    .catch(() => {
      listEl.innerHTML = '<div class="empty">No se pudo cargar la lista de empleados.</div>';
    });

  btnGuardar.addEventListener('click', async function () {
    const rows = Array.from(listEl.querySelectorAll('.import-row'));
    let saved = 0;
    let skipped = 0;
    let failed = 0;
    btnGuardar.disabled = true;
    for (const row of rows) {
      const select = row.querySelector('[data-employee-select]');
      const statusEl = row.querySelector('.import-row-status');
      const employeeId = select.value;
      if (!employeeId) {
        skipped++;
        continue;
      }
      const fields = {};
      row.querySelectorAll('input[data-field]').forEach((input) => {
        fields[input.getAttribute('data-field')] = input.value;
      });
      try {
        const res = await fetch('/api/employees', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: employeeId, fields }),
        });
        if (!res.ok) throw new Error();
        statusEl.textContent = 'Guardado';
        statusEl.className = 'import-row-status ok';
        saved++;
      } catch {
        statusEl.textContent = 'Error al guardar';
        statusEl.className = 'import-row-status err';
        failed++;
      }
    }
    btnGuardar.disabled = false;
    summaryEl.textContent = `Guardados: ${saved} · Sin importar: ${skipped} · Con error: ${failed}`;
  });
});
