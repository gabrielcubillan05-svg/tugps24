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

  // Campos que este importador sabe llenar en la ficha (EmployeeProfile). Cada registro pegado
  // solo genera un input por el campo que de verdad trae — así un import parcial (ej. solo
  // fecha de ingreso) no borra sin querer los demás campos ya cargados antes.
  const KNOWN_FIELDS = {
    cedula: { label: 'Cédula', type: 'text' },
    fechaNacimiento: { label: 'Fecha nacimiento', type: 'date' },
    telefono: { label: 'Teléfono', type: 'text' },
    direccion: { label: 'Dirección', type: 'text' },
    correo: { label: 'Correo', type: 'text' },
    hireDate: { label: 'Fecha de ingreso', type: 'date' },
  };

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
      const fieldInputs = Object.keys(KNOWN_FIELDS)
        .filter((f) => Object.prototype.hasOwnProperty.call(r, f))
        .map((f) => `<label>${KNOWN_FIELDS[f].label}<input type="${KNOWN_FIELDS[f].type}" data-field="${f}" value="${escapeHtml(r[f])}" /></label>`)
        .join('');
      return `
        <div class="import-row ${match ? '' : 'import-nomatch'}" data-idx="${idx}">
          <div class="import-fields">
            <label>Nombre (origen)<input type="text" value="${escapeHtml(r.nombre)}" disabled /></label>
            ${fieldInputs}
          </div>
          <div class="import-match">
            <div class="orig-name">${escapeHtml(r.sucursal || '')}${r.sucursal && r.puesto ? ' · ' : ''}${escapeHtml(r.puesto || '')}${!match ? ' — sin coincidencia automática' : ''}</div>
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
