document.addEventListener('DOMContentLoaded', function () {
  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function fmtDate(iso) {
    const d = new Date(iso);
    return d.toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });
  }

  const planillasList = document.getElementById('planillasList');
  if (!planillasList) return; // no autenticado o sin permiso

  const searchInput = document.getElementById('searchInput');

  function estadoClass(estado) {
    if (estado === 'Malo') return 'malo';
    if (estado === 'Regular') return 'regular';
    return '';
  }

  function renderPlanillas(planillas) {
    if (!planillas.length) {
      planillasList.innerHTML = '<div class="empty">No hay planillas registradas.</div>';
      return;
    }
    planillasList.innerHTML = planillas.map((p) => {
      const problemItems = (p.items || []).filter((it) => it.estado === 'Regular' || it.estado === 'Malo');
      return `
      <div class="planilla-item" data-id="${p.id}">
        <div class="planilla-top">
          <span class="planilla-plate">${escapeHtml(p.placa)}${p.modelo ? ' · ' + escapeHtml(p.modelo) : ''}</span>
          <span class="badge">${escapeHtml(p.fecha)} ${escapeHtml(p.hora)}</span>
        </div>
        <div class="planilla-meta">
          Técnico: ${escapeHtml(p.tecnicoNombre)}${p.branch ? ' · ' + escapeHtml(p.branch) : ''} · Cliente: ${escapeHtml(p.clienteNombre)} (CC ${escapeHtml(p.clienteCedula)}${p.clienteTelefono ? ' · Tel: ' + escapeHtml(p.clienteTelefono) : ''})
          · Combustible: ${escapeHtml(p.nivelCombustible || '—')} · Registrada ${fmtDate(p.createdAt)}
        </div>
        ${problemItems.length ? `
          <div class="planilla-checklist-summary">
            ${problemItems.map((it) => `<div><span class="${estadoClass(it.estado)}">${escapeHtml(it.label)}: ${escapeHtml(it.estado)}</span>${it.detalle ? ' — ' + escapeHtml(it.detalle) : ''}</div>`).join('')}
          </div>
        ` : '<div class="planilla-checklist-summary">Todo en buen estado según el checklist.</div>'}
        ${p.observaciones ? `<p class="caso-description">${escapeHtml(p.observaciones)}</p>` : ''}
        ${p.observacionGarantia ? `<p class="caso-description">Garantía: ${escapeHtml(p.observacionGarantia)}</p>` : ''}
        <div class="planilla-firmas">
          ${p.clienteFirma ? `<img src="/api/blob-file?path=${encodeURIComponent(p.clienteFirma)}" alt="Firma del cliente" loading="lazy" />` : ''}
          ${p.tecnicoFirma ? `<img src="/api/blob-file?path=${encodeURIComponent(p.tecnicoFirma)}" alt="Firma del técnico" loading="lazy" />` : ''}
        </div>
        <div class="planilla-salida" data-salida-for="${p.id}">
          ${p.salidaFirma ? `
            <div class="planilla-salida-done">
              <span class="${p.salidaConforme === false ? 'malo' : ''}">
                ${p.salidaConforme === false ? 'Salida NO conforme' : 'Salida conforme'} (${fmtDate(p.salidaAt)})${p.salidaObservacion ? ': ' + escapeHtml(p.salidaObservacion) : ''}
              </span>
              <img src="/api/blob-file?path=${encodeURIComponent(p.salidaFirma)}" alt="Firma de conforme de salida" loading="lazy" />
            </div>
          ` : `
            <button class="btn-small" data-action="start-salida" data-id="${p.id}" type="button">Registrar conforme de salida</button>
          `}
        </div>
      </div>
    `;
    }).join('');
  }

  function loadPlanillas() {
    const params = new URLSearchParams();
    if (searchInput.value.trim()) params.set('q', searchInput.value.trim());
    fetch('/api/planillas-vehiculo?' + params.toString())
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (data && Array.isArray(data.planillas)) renderPlanillas(data.planillas);
        else planillasList.innerHTML = `<div class="empty">No se pudo cargar${data && data.error ? ': ' + escapeHtml(data.error) : ''}.</div>`;
      })
      .catch((err) => {
        planillasList.innerHTML = `<div class="empty">No se pudo cargar: ${escapeHtml(err.message || 'error de red')}.</div>`;
      });
  }

  let debounceTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(loadPlanillas, 250);
  });

  // --- Firma en canvas (mouse + touch) ---
  function setupSignaturePad(canvas) {
    const ctx = canvas.getContext('2d');
    let drawing = false;
    let hasContent = false;

    function resize() {
      const ratio = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * ratio;
      canvas.height = rect.height * ratio;
      ctx.scale(ratio, ratio);
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#111';
    }
    resize();

    function posFromEvent(e) {
      const rect = canvas.getBoundingClientRect();
      const point = e.touches && e.touches[0] ? e.touches[0] : e;
      return { x: point.clientX - rect.left, y: point.clientY - rect.top };
    }

    function start(e) {
      e.preventDefault();
      drawing = true;
      const { x, y } = posFromEvent(e);
      ctx.beginPath();
      ctx.moveTo(x, y);
    }
    function move(e) {
      if (!drawing) return;
      e.preventDefault();
      const { x, y } = posFromEvent(e);
      ctx.lineTo(x, y);
      ctx.stroke();
      hasContent = true;
    }
    function end() { drawing = false; }

    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end);

    return {
      clear() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        hasContent = false;
      },
      isEmpty() { return !hasContent; },
      toBlob() {
        return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      },
    };
  }

  // --- Conforme de salida (se agrega después, sobre una planilla ya creada — aplica tanto
  // para el técnico como para gerente/admin, así que va antes del "solo lectura" de abajo) ---
  const salidaPads = {};

  function startSalida(id, container) {
    container.innerHTML = `
      <p class="planilla-salida-note">Al firmar, el cliente confirma que el vehículo queda conforme (en orden) al momento de la entrega.</p>
      <label class="checkbox planilla-salida-noconforme">
        <input type="checkbox" data-role="no-conforme" data-id="${id}" />
        El vehículo NO queda conforme
      </label>
      <textarea data-role="salida-observacion" data-id="${id}" placeholder="Describe la observación (obligatorio si no queda conforme)" style="display:none;"></textarea>
      <canvas class="firma-canvas" id="salidaCanvas-${id}" width="500" height="180"></canvas>
      <div class="planilla-salida-actions">
        <button class="btn-small" data-action="save-salida" data-id="${id}" type="button">Guardar firma de salida</button>
        <button class="btn-ghost" data-action="clear-salida" data-id="${id}" type="button">Borrar</button>
        <button class="btn-ghost" data-action="cancel-salida" data-id="${id}" type="button">Cancelar</button>
      </div>
    `;
    salidaPads[id] = setupSignaturePad(document.getElementById(`salidaCanvas-${id}`));
  }

  planillasList.addEventListener('change', function (e) {
    const checkbox = e.target.closest('input[data-role="no-conforme"]');
    if (!checkbox) return;
    const id = checkbox.getAttribute('data-id');
    const textarea = planillasList.querySelector(`textarea[data-role="salida-observacion"][data-id="${id}"]`);
    if (textarea) textarea.style.display = checkbox.checked ? 'block' : 'none';
  });

  planillasList.addEventListener('click', async function (e) {
    const startBtn = e.target.closest('button[data-action="start-salida"]');
    if (startBtn) {
      const id = startBtn.getAttribute('data-id');
      startSalida(id, planillasList.querySelector(`[data-salida-for="${id}"]`));
      return;
    }

    const clearBtn = e.target.closest('button[data-action="clear-salida"]');
    if (clearBtn) {
      const id = clearBtn.getAttribute('data-id');
      if (salidaPads[id]) salidaPads[id].clear();
      return;
    }

    const cancelBtn = e.target.closest('button[data-action="cancel-salida"]');
    if (cancelBtn) {
      delete salidaPads[cancelBtn.getAttribute('data-id')];
      loadPlanillas();
      return;
    }

    const saveBtn = e.target.closest('button[data-action="save-salida"]');
    if (saveBtn) {
      const id = saveBtn.getAttribute('data-id');
      const pad = salidaPads[id];
      if (!pad || pad.isEmpty()) {
        alert('Falta la firma del cliente para el conforme de salida.');
        return;
      }
      const container = planillasList.querySelector(`[data-salida-for="${id}"]`);
      const noConforme = container.querySelector('input[data-role="no-conforme"]').checked;
      const observacion = container.querySelector('textarea[data-role="salida-observacion"]').value.trim();
      if (noConforme && !observacion) {
        alert('Describe la observación de por qué el vehículo no queda conforme.');
        return;
      }
      saveBtn.disabled = true;
      try {
        const blob = await pad.toBlob();
        const formData = new FormData();
        formData.set('id', id);
        formData.set('salidaFirma', blob, 'firma-salida.png');
        formData.set('salidaConforme', noConforme ? 'false' : 'true');
        formData.set('salidaObservacion', observacion);
        const res = await fetch('/api/planillas-vehiculo', { method: 'PATCH', body: formData });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `error ${res.status}`);
        }
        delete salidaPads[id];
        loadPlanillas();
      } catch (err) {
        alert('No se pudo guardar la firma de salida: ' + (err.message || 'intenta de nuevo.'));
        saveBtn.disabled = false;
      }
    }
  });

  const planillaForm = document.getElementById('planillaForm');
  if (!planillaForm) {
    loadPlanillas();
    return; // vista de solo lectura (gerente/admin)
  }

  const firmaClienteCanvas = document.getElementById('firmaCliente');
  const firmaTecnicoCanvas = document.getElementById('firmaTecnico');
  const firmaCliente = setupSignaturePad(firmaClienteCanvas);
  const firmaTecnico = setupSignaturePad(firmaTecnicoCanvas);

  document.querySelectorAll('[data-clear-firma]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-clear-firma');
      if (target === 'firmaCliente') firmaCliente.clear();
      if (target === 'firmaTecnico') firmaTecnico.clear();
    });
  });

  const formError = document.getElementById('planillaFormError');

  planillaForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    formError.style.display = 'none';

    const placa = document.getElementById('placa').value.trim();
    const modelo = document.getElementById('modelo').value.trim();
    const fecha = document.getElementById('fecha').value;
    // La hora no la elige el técnico — se toma la hora actual de Colombia justo al enviar,
    // no la que se veía al cargar la página (pudo haberse demorado llenando el formulario).
    const hora = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
    document.getElementById('hora').value = hora;
    const nivelCombustible = document.getElementById('nivelCombustible').value;
    const observaciones = document.getElementById('observaciones').value.trim();
    const observacionGarantia = document.getElementById('observacionGarantia').value.trim();
    const clienteNombre = document.getElementById('clienteNombre').value.trim();
    const clienteCedula = document.getElementById('clienteCedula').value.trim();
    const clienteTelefono = document.getElementById('clienteTelefono').value.trim();

    if (!placa || !fecha || !hora || !clienteNombre || !clienteCedula || !clienteTelefono) {
      formError.textContent = 'Completa los campos obligatorios.';
      formError.style.display = 'block';
      return;
    }
    if (firmaCliente.isEmpty()) {
      formError.textContent = 'Falta la firma del cliente.';
      formError.style.display = 'block';
      return;
    }

    const items = Array.from(document.querySelectorAll('.checklist-row')).map((row) => {
      const checked = row.querySelector('input[type="radio"]:checked');
      return {
        label: row.querySelector('.checklist-label').textContent.trim(),
        estado: checked ? checked.value : '',
        detalle: row.querySelector('.checklist-detalle').value.trim(),
      };
    });

    const submitBtn = planillaForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    const originalLabel = submitBtn.textContent;

    try {
      submitBtn.textContent = 'Guardando...';
      const formData = new FormData();
      formData.set('placa', placa);
      formData.set('modelo', modelo);
      formData.set('fecha', fecha);
      formData.set('hora', hora);
      formData.set('nivelCombustible', nivelCombustible);
      formData.set('observaciones', observaciones);
      formData.set('observacionGarantia', observacionGarantia);
      formData.set('clienteNombre', clienteNombre);
      formData.set('clienteCedula', clienteCedula);
      formData.set('clienteTelefono', clienteTelefono);
      formData.set('items', JSON.stringify(items));

      const clienteBlob = await firmaCliente.toBlob();
      formData.set('clienteFirma', clienteBlob, 'firma-cliente.png');
      if (!firmaTecnico.isEmpty()) {
        const tecnicoBlob = await firmaTecnico.toBlob();
        formData.set('tecnicoFirma', tecnicoBlob, 'firma-tecnico.png');
      }

      const res = await fetch('/api/planillas-vehiculo', { method: 'POST', body: formData });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error([data.error, data.detail].filter(Boolean).join(' — ') || `error ${res.status}`);
      }
      planillaForm.reset();
      firmaCliente.clear();
      firmaTecnico.clear();
      document.querySelectorAll('.checklist-detalle').forEach((el) => { el.value = ''; });
      loadPlanillas();
    } catch (err) {
      formError.textContent = 'No se pudo guardar: ' + (err.message || 'intenta de nuevo.');
      formError.style.display = 'block';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  });

  loadPlanillas();
});
