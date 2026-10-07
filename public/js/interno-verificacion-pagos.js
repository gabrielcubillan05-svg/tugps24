document.addEventListener('DOMContentLoaded', function () {
  const timeoutSignal = (ms) => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : ((c) => (setTimeout(() => c.abort(), ms), c.signal))(new AbortController()));
  const list = document.getElementById('pagosList');
  if (!list) return;
  const form = document.getElementById('pagoForm');
  const fileInput = document.getElementById('pagoFile');
  const drop = document.getElementById('pagoDrop');
  const preview = document.getElementById('pagoPreview');
  const msg = document.getElementById('pagoMsg');
  const submitBtn = document.getElementById('pagoSubmit');
  const statsEl = document.getElementById('pagoStats');
  const searchInput = document.getElementById('pagoSearch');
  const branchFilter = document.getElementById('pagoBranchFilter');
  const monthFilter = document.getElementById('pagoMonth');
  const destinosInput = document.getElementById('destinosInput');

  let pendingFile = null;
  let currentTab = '';
  // La lista crece 40 o 50 comprobantes al día: se pagina en el navegador para no hacer una
  // página kilométrica (pedido de Gabriel, 2026-10-07).
  const PAGE_SIZE = 20;
  let currentPage = 1;
  let listLimit = 0;
  let canResolve = false;
  let pagos = [];
  const pollTimers = {};

  const APPLY_LABEL = { pendiente: 'Pendiente de resolver en Optimus', aplicado: 'Resuelto en Optimus por el robot', manual: 'Resuelto en Optimus a mano', fallo: 'El robot no pudo resolverlo en Optimus' };
  const STATUS_LABEL = { verde: 'Verde: nuevo y consistente', rojo: 'Rojo: revisar', aprobado: 'Aprobado a mano', rechazado: 'Rechazado', analizando: 'GPSITO está leyendo…' };

  function escapeHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function fmtDate(iso) { return iso ? new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' }) : ''; }
  function fmtMoney(n) { return n == null ? '—' : '$' + Number(n).toLocaleString('es-CO'); }
  const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  function monthLabel(ym) { const [y, m] = ym.split('-'); const n = MONTHS[parseInt(m, 10) - 1] || ym; return n.charAt(0).toUpperCase() + n.slice(1) + ' ' + y; }

  // Imagen reducida a 1600 px (una captura de celular pesa 2-4 MB; así baja a unos 300 KB) y
  // huella visual dHash de 64 bits: 9x8 en gris, cada bit dice si un píxel es más claro que el
  // de su derecha. Sobrevive a recortes leves, recompresión y reenvíos.
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo leer la imagen')); };
      img.src = url;
    });
  }
  function dHash(img) {
    const c = document.createElement('canvas');
    c.width = 9; c.height = 8;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, 9, 8);
    const d = ctx.getImageData(0, 0, 9, 8).data;
    const gray = [];
    for (let i = 0; i < d.length; i += 4) gray.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    let hex = '';
    let nibble = 0; let bits = 0;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      nibble = (nibble << 1) | (gray[y * 9 + x] > gray[y * 9 + x + 1] ? 1 : 0);
      bits++;
      if (bits === 4) { hex += nibble.toString(16); nibble = 0; bits = 0; }
    }
    return hex;
  }
  function compress(img, maxDim, quality) {
    return new Promise((resolve, reject) => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) { const s = maxDim / Math.max(width, height); width = Math.round(width * s); height = Math.round(height * s); }
      const c = document.createElement('canvas');
      c.width = width; c.height = height;
      c.getContext('2d').drawImage(img, 0, 0, width, height);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('No se pudo comprimir la imagen'))), 'image/jpeg', quality);
    });
  }

  function setPendingFile(file) {
    if (!file) return;
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
    if (!isPdf && !file.type.startsWith('image/')) { msg.textContent = 'Solo se aceptan imágenes o PDF.'; return; }
    pendingFile = file;
    preview.innerHTML = '';
    if (isPdf) {
      preview.innerHTML = `<div class="hint">PDF listo: ${escapeHtml(file.name || 'comprobante.pdf')} (${Math.round(file.size / 1024)} KB)</div>`;
    } else {
      const img = document.createElement('img');
      img.style.maxWidth = '220px'; img.style.maxHeight = '220px'; img.style.borderRadius = '8px';
      img.src = URL.createObjectURL(file);
      preview.appendChild(img);
    }
    drop.textContent = 'Comprobante listo. Puedes pegar otro para reemplazarlo.';
    msg.textContent = '';
  }

  if (form) form.addEventListener('paste', (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const item = items.find((i) => i.kind === 'file' && (i.type.startsWith('image/') || i.type === 'application/pdf'));
    if (!item) return;
    e.preventDefault();
    setPendingFile(item.getAsFile());
  });
  fileInput.addEventListener('change', () => setPendingFile(fileInput.files && fileInput.files[0]));
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => setPendingFile(e.dataTransfer?.files && e.dataTransfer.files[0]));
  drop.addEventListener('click', () => fileInput.click());

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const clientName = document.getElementById('pagoClient').value.trim();
    if (!clientName) { msg.textContent = 'Escribe el nombre completo del cliente.'; return; }
    if (!pendingFile) { msg.textContent = 'Pega o adjunta el comprobante.'; return; }
    submitBtn.disabled = true;
    msg.textContent = 'Preparando el comprobante…';
    try {
      const fd = new FormData();
      fd.append('clientName', clientName);
      fd.append('plate', document.getElementById('pagoPlate').value.trim());
      const branchSel = document.getElementById('pagoBranch');
      if (branchSel) fd.append('branch', branchSel.value);
      const isPdf = pendingFile.type === 'application/pdf' || /\.pdf$/i.test(pendingFile.name || '');
      if (isPdf) {
        fd.append('file', pendingFile, 'comprobante.pdf');
      } else {
        const img = await loadImage(pendingFile);
        fd.append('phash', dHash(img));
        const blob = await compress(img, 1600, 0.85);
        fd.append('file', blob, 'comprobante.jpg');
      }
      msg.textContent = 'Subiendo…';
      const res = await fetch('/api/verificacion-pagos', { method: 'POST', body: fd, signal: timeoutSignal(90000) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Error ' + res.status);
      msg.textContent = 'Comprobante guardado. GPSITO lo está leyendo; el resultado aparece abajo en unos segundos.';
      form.reset();
      pendingFile = null;
      preview.innerHTML = '';
      drop.textContent = 'Suelta aquí la captura o pégala con Ctrl+V';
      await loadPagos();
      pollPago(data.pago.id);
    } catch (err) {
      msg.textContent = 'No se pudo verificar: ' + (err && err.name === 'AbortError' ? 'la conexión tardó demasiado' : (err && err.message) || err);
    } finally {
      submitBtn.disabled = false;
    }
  });

  function pollPago(id) {
    clearTimeout(pollTimers[id]);
    const startedAt = Date.now();
    const tick = async () => {
      try {
        const res = await fetch('/api/verificacion-pagos?id=' + encodeURIComponent(id), { signal: timeoutSignal(15000) });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.pago) {
          const idx = pagos.findIndex((p) => p.id === id);
          if (idx >= 0) pagos[idx] = data.pago; else pagos.unshift(data.pago);
          render();
          if (data.pago.status !== 'analizando') { loadPagos(); return; }
        }
      } catch { /* se reintenta */ }
      if (Date.now() - startedAt < 4 * 60000) pollTimers[id] = setTimeout(tick, 4000);
    };
    pollTimers[id] = setTimeout(tick, 3000);
  }

  function renderStats(stats) {
    if (!statsEl || !stats) return;
    const item = (n, l, color) => `<div class="stat-box"><span class="n" style="${color ? 'color:' + color : ''}">${n}</span><span class="l">${l}</span></div>`;
    statsEl.innerHTML = item(stats.total || 0, 'Total') + item(stats.verde || 0, 'Verdes', '#3ddc84') + item(stats.rojo || 0, 'Rojos', '#ef4444') + item(stats.aprobado || 0, 'Aprobados a mano', '#7ab8ec') + item(stats.porAplicar || 0, 'Por aplicar', '#f59e0b') + item(stats.aplicados || 0, 'Aplicados', '#3ddc84');
  }

  function renderRobot(robot) {
    const panel = document.getElementById('robotPanel');
    if (!panel || !robot) return;
    const seen = robot.lastSeenAt ? new Date(robot.lastSeenAt) : null;
    const minutes = seen ? Math.round((Date.now() - seen.getTime()) / 60000) : null;
    const alive = minutes !== null && minutes <= 60;
    const color = robot.paused ? '#f59e0b' : alive ? '#3ddc84' : '#ef4444';
    const state = robot.paused ? 'En pausa' : alive ? 'Activo' : seen ? 'Sin señal hace ' + minutes + ' min' : 'Todavía no se ha conectado';
    panel.innerHTML = `<span><span class="dot" style="background:${color}"></span><b>${state}</b></span>
      <span class="hint">${seen ? 'Último ciclo: ' + fmtDate(robot.lastSeenAt) : 'El robot se conecta cada 15 minutos cuando esté configurado.'}</span>
      ${robot.lastResult ? `<span class="hint">Último resultado: ${escapeHtml(robot.lastResult)}</span>` : ''}
      <button class="btn-small ${robot.paused ? '' : 'btn-delete'}" type="button" id="robotToggle">${robot.paused ? 'Reanudar robot' : 'Pausar robot'}</button>
      ${robot.sinLeer ? `<button class="btn-small" type="button" id="robotReleer" title="Vuelve a pasar por GPSITO, uno a uno, todos los comprobantes que quedaron sin leer">Releer ${robot.sinLeer} sin leer</button>` : ''}
      ${robot.isAdmin ? '<button class="btn-small btn-delete" type="button" id="robotReset" title="Borra lo traído de Optimus para que el robot lo vuelva a traer">Reiniciar lo traído de Optimus</button>' : ''}`;
    const releer = document.getElementById('robotReleer');
    if (releer) releer.addEventListener('click', async () => {
      releer.disabled = true;
      try {
        const res = await fetch('/api/verificacion-pagos', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'releer-fallidas' }), signal: timeoutSignal(30000) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Error ' + res.status);
        alert('GPSITO está releyendo ' + data.pendientes + ' comprobantes, uno a uno. Van apareciendo en verde o rojo en los próximos minutos; si queda alguno, el robot lo retoma en su siguiente ronda.');
        loadPagos();
      } catch (err) { releer.disabled = false; alert('No se pudo: ' + ((err && err.message) || err)); }
    });
    const reset = document.getElementById('robotReset');
    if (reset) reset.addEventListener('click', async () => {
      if (!confirm('Se borran del panel TODOS los comprobantes traídos de Optimus (con sus lecturas y archivos). El robot los vuelve a traer en su próximo ciclo. ¿Continuar?')) return;
      try {
        const res = await fetch('/api/verificacion-pagos', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'borrar-optimus' }), signal: timeoutSignal(60000) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Error ' + res.status);
        alert('Borrados: ' + data.borrados);
        loadPagos();
      } catch (err) { alert('No se pudo: ' + ((err && err.message) || err)); }
    });
    document.getElementById('robotToggle').addEventListener('click', async () => {
      try {
        const res = await fetch('/api/verificacion-pagos', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'robot', paused: !robot.paused }), signal: timeoutSignal(20000) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Error ' + res.status);
        renderRobot(data.robot);
      } catch (err) { alert('No se pudo: ' + ((err && err.message) || err)); }
    });
  }

  function fieldsHtml(p) {
    const x = p.extracted;
    if (!x) return '';
    const f = (k, v) => `<div><span class="k">${k}</span>${escapeHtml(v || '—')}</div>`;
    return `<div class="pago-fields">${f('Banco / app', x.banco)}${f('Referencia', x.referencia)}${f('Fecha', x.fecha ? x.fecha + (x.hora ? ' ' + x.hora : '') : '')}${f('Valor', fmtMoney(x.valor))}${f('Pagador', x.pagador)}${f('Cuenta destino', x.cuentaDestino ? x.cuentaDestino + (x.tipoDestino ? ' (' + x.tipoDestino + ')' : '') : '')}</div>`;
  }

  function render() {
    const items = !currentTab
      ? pagos
      : currentTab === 'por-aplicar'
      ? pagos.filter((p) => p.applyStatus === 'pendiente' && (p.status === 'verde' || p.status === 'aprobado' || p.status === 'rechazado'))
      : currentTab === 'aplicados'
      ? pagos.filter((p) => p.applyStatus === 'aplicado' || p.applyStatus === 'manual')
      : pagos.filter((p) => p.status === currentTab && !(currentTab === 'rojo' && (p.applyStatus === 'aplicado' || p.applyStatus === 'manual')));
    if (!items.length) { list.innerHTML = '<div class="empty">No hay comprobantes en esta vista.</div>'; return; }
    const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;
    const from = (currentPage - 1) * PAGE_SIZE;
    const pageItems = items.slice(from, from + PAGE_SIZE);
    const pager = totalPages > 1
      ? `<div class="pago-pager"><span class="hint">Mostrando ${from + 1}–${from + pageItems.length} de ${items.length}</span>
          <button class="btn-small" type="button" data-page="${currentPage - 1}" ${currentPage <= 1 ? 'disabled' : ''}>‹ Anterior</button>
          <span>Página ${currentPage} de ${totalPages}</span>
          <button class="btn-small" type="button" data-page="${currentPage + 1}" ${currentPage >= totalPages ? 'disabled' : ''}>Siguiente ›</button></div>`
      : '';
    list.innerHTML = pager + pageItems.map((p) => {
      const dup = p.duplicateOf ? pagos.find((o) => o.id === p.duplicateOf) : null;
      const thumb = !p.fileUrl
        ? '<div class="pago-sin-imagen">Sin comprobante</div>'
        : p.fileType === 'pdf'
        ? `<a class="pdf" href="${p.fileUrl}" target="_blank" rel="noopener">📄 Abrir PDF</a>`
        : `<a href="${p.fileUrl}" target="_blank" rel="noopener"><img src="${p.fileUrl}" alt="Comprobante" loading="lazy" /></a>`;
      const reasons = p.reasons && p.reasons.length ? `<ul class="pago-reasons">${p.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : '';
      const notes = p.notes && p.notes.length ? `<ul class="pago-notes">${p.notes.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : '';
      const dupHtml = p.duplicateOf ? `<div class="pago-meta">Coincide con: ${dup ? `<a href="#pago-${dup.id}">${escapeHtml(dup.clientName)} · ${fmtDate(dup.createdAt)} · ${escapeHtml(dup.createdByName)}</a>` : 'un comprobante anterior (' + escapeHtml(p.duplicateOf.slice(0, 8)) + ')'}</div>` : '';
      const resolved = p.resolvedAt ? `<div class="pago-meta">${p.status === 'aprobado' ? 'Aprobado' : 'Rechazado'} por ${escapeHtml(p.resolvedByName)} el ${fmtDate(p.resolvedAt)}: ${escapeHtml(p.resolutionNote)}</div>` : '';
      const o = p.optimus;
      const optimusHtml = o ? `<div class="pago-meta">Optimus N.º ${escapeHtml(o.numero)}${o.fecha ? ' · ' + escapeHtml(o.fecha) : ''}${o.creadoPor ? ' · cargado por ' + escapeHtml(o.creadoPor) : ''}${o.contratos && o.contratos.length ? ' · contrato' + (o.contratos.length > 1 ? 's' : '') + ': ' + escapeHtml(o.contratos.join(', ')) : ''}${o.monto ? ' · monto en Optimus ' + fmtMoney(o.monto) : ' · monto en Optimus sin digitar'}${o.pendiente != null ? ' · saldo pendiente ' + fmtMoney(o.pendiente) : ''}${o.pagoMinimo != null ? ' · pago mínimo ' + fmtMoney(o.pagoMinimo) : ''}</div>` : '';
      const applyHtml = p.applyStatus ? `<div class="pago-meta"><span class="badge ap-${p.applyStatus}">${APPLY_LABEL[p.applyStatus] || p.applyStatus}</span>${p.applyAt ? ' ' + fmtDate(p.applyAt) : ''}${p.applyBy && p.applyStatus !== 'pendiente' ? ' · ' + escapeHtml(p.applyBy) : ''}${p.applyDetail ? ': ' + escapeHtml(p.applyDetail) : ''}${p.applyStatus === 'fallo' && p.applyAttempts ? ` (${p.applyAttempts} intento${p.applyAttempts === 1 ? '' : 's'})` : ''}${p.applyScreenshotUrl ? ` · <a href="${p.applyScreenshotUrl}" target="_blank" rel="noopener">ver captura</a>` : ''}</div>` : '';
      let actions = '';
      if (canResolve && (p.status === 'rojo' || p.status === 'verde')) {
        actions += `<input type="text" placeholder="Motivo (obligatorio)" data-note="${p.id}" maxlength="300" /><button class="btn-small" type="button" data-action="aprobar" data-id="${p.id}">Aprobar a mano</button><button class="btn-small btn-delete" type="button" data-action="rechazar" data-id="${p.id}">Rechazar</button>`;
      }
      if (p.status === 'rojo' && (p.analysisError || canResolve)) actions += `<button class="btn-small" type="button" data-action="reanalizar" data-id="${p.id}">Volver a leer</button>`;
      if (canResolve && (p.status === 'verde' || p.status === 'aprobado' || (p.status === 'rechazado' && p.source === 'optimus')) && p.applyStatus !== 'aplicado' && p.applyStatus !== 'manual') {
        actions += `<button class="btn-small" type="button" data-action="aplicado-manual" data-id="${p.id}">Ya lo apliqué a mano</button>`;
        if (p.applyStatus === 'fallo') actions += `<button class="btn-small" type="button" data-action="reintentar-aplicar" data-id="${p.id}">Que el robot reintente</button>`;
      }
      return `<div class="pago-item ${p.status}" id="pago-${p.id}">
        <div class="pago-top">
          <div><span class="pago-client">${escapeHtml(p.clientName)}</span>${p.plate ? ` <span class="sim-tag">${escapeHtml(p.plate)}</span>` : ''} <span class="hint">· ${escapeHtml(p.branch)}</span></div>
          <span class="badge st-${p.status}">${STATUS_LABEL[p.status] || p.status}</span>
        </div>
        <div class="pago-body">
          <div class="pago-thumb">${thumb}</div>
          <div>${optimusHtml}${fieldsHtml(p)}${reasons}${notes}${dupHtml}${resolved}${applyHtml}
            <div class="pago-meta">Subido ${fmtDate(p.createdAt)} por ${escapeHtml(p.createdByName)}</div>
            ${actions ? `<div class="pago-actions">${actions}</div>` : ''}
          </div>
        </div>
      </div>`;
    }).join('') + pager;
    list.querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', () => {
      currentPage = Number(b.getAttribute('data-page')) || 1;
      render();
      list.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
  }

  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    const action = btn.getAttribute('data-action');
    const noteInput = list.querySelector(`input[data-note="${id}"]`);
    const note = noteInput ? noteInput.value.trim() : '';
    if ((action === 'aprobar' || action === 'rechazar') && !note) { alert('Escribe el motivo.'); return; }
    btn.disabled = true;
    try {
      const res = await fetch('/api/verificacion-pagos', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action, note }), signal: timeoutSignal(30000) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Error ' + res.status);
      await loadPagos();
      if (action === 'reanalizar') pollPago(id);
    } catch (err) {
      alert('No se pudo: ' + ((err && err.message) || err));
      btn.disabled = false;
    }
  });

  async function loadPagos() {
    const params = new URLSearchParams();
    if (searchInput.value.trim()) params.set('q', searchInput.value.trim());
    if (branchFilter.value) params.set('branch', branchFilter.value);
    if (monthFilter.value) params.set('month', monthFilter.value);
    if (listLimit) params.set('limit', String(listLimit));
    try {
      const res = await fetch('/api/verificacion-pagos?' + params.toString(), { signal: timeoutSignal(30000) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Error ' + res.status);
      pagos = data.pagos || [];
      canResolve = !!data.canResolve;
      renderStats(data.stats);
      const curB = branchFilter.value;
      branchFilter.innerHTML = '<option value="">Todas las sucursales</option>' + (data.branches || []).map((b) => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');
      branchFilter.value = curB;
      const curM = monthFilter.value;
      monthFilter.innerHTML = '<option value="">Todos los meses</option>' + (data.months || []).map((m) => `<option value="${m}">${monthLabel(m)}</option>`).join('');
      monthFilter.value = curM;
      if (destinosInput && data.destinos && !destinosInput.dataset.loaded) { destinosInput.value = data.destinos.join('\n'); destinosInput.dataset.loaded = '1'; }
      renderRobot(data.robot);
      render();
      if (window.TuGpsListMore) TuGpsListMore.apply(list, { truncated: data.truncated, total: data.total, limit: data.limit, items: pagos }, (next) => { listLimit = next; loadPagos(); });
      pagos.filter((p) => p.status === 'analizando').forEach((p) => { if (!pollTimers[p.id]) pollPago(p.id); });
    } catch (err) {
      list.innerHTML = `<div class="empty">No se pudo cargar: ${escapeHtml((err && err.message) || err)}</div>`;
    }
  }

  document.querySelectorAll('.tab-btn').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    currentTab = b.getAttribute('data-status') || '';
    currentPage = 1;
    render();
  }));
  let searchTimer;
  searchInput.addEventListener('input', () => { clearTimeout(searchTimer); currentPage = 1; searchTimer = setTimeout(loadPagos, 350); });
  branchFilter.addEventListener('change', () => { currentPage = 1; loadPagos(); });
  monthFilter.addEventListener('change', () => { currentPage = 1; loadPagos(); });

  const destinosSave = document.getElementById('destinosSave');
  if (destinosSave) destinosSave.addEventListener('click', async () => {
    const destinos = destinosInput.value.split('\n').map((s) => s.trim()).filter(Boolean);
    const m = document.getElementById('destinosMsg');
    try {
      const res = await fetch('/api/verificacion-pagos', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'config', destinos }), signal: timeoutSignal(20000) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Error ' + res.status);
      m.textContent = 'Guardado.';
    } catch (err) { m.textContent = 'No se pudo guardar: ' + ((err && err.message) || err); }
  });

  loadPagos();
});
