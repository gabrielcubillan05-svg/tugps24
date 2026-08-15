document.addEventListener('DOMContentLoaded', function () {
  const receiptGallery = document.getElementById('receiptGallery');
  if (!receiptGallery) return; // no autenticado o sin permiso

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function fmtMoney(n) {
    return '$' + Number(n || 0).toLocaleString('es-CO');
  }

  function fmtDateOnly(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
  }

  const STATUS_LABELS = { pendiente: 'Pendiente', verificado: 'Verificado', 'no-encontrado': 'Sin encontrar' };

  const rpFile = document.getElementById('rp-file');
  const pendingQueue = document.getElementById('pendingReceiptsQueue');
  const saveAllBtn = document.getElementById('saveAllReceiptsBtn');

  const MAX_PENDING = 20;
  let pendingReceipts = [];
  let pendingCounter = 0;

  function renderPendingQueue() {
    pendingQueue.innerHTML = pendingReceipts.map((item) => `
      <div class="pending-item ${item.status === 'error' ? 'has-error' : ''} ${item.warning ? 'has-warning' : ''}" data-local-id="${item.localId}">
        <div class="pending-thumb"><img src="${item.previewUrl}" alt="Comprobante" /></div>
        <div class="pending-fields">
          <input type="number" min="1" step="1" placeholder="Monto" data-field="amount" data-local-id="${item.localId}" value="${item.amount || ''}" />
          <input type="date" data-field="paymentDate" data-local-id="${item.localId}" value="${item.paymentDate || ''}" />
          <input type="text" placeholder="Nombre de quien paga" data-field="payerName" data-local-id="${item.localId}" value="${escapeHtml(item.payerName || '')}" />
          <input type="text" placeholder="Nº aprobación (opcional)" data-field="reference" data-local-id="${item.localId}" value="${escapeHtml(item.reference || '')}" />
          <input type="text" placeholder="Nota (opcional)" data-field="note" data-local-id="${item.localId}" value="${escapeHtml(item.note || '')}" />
        </div>
        <div class="pending-status ${item.status === 'error' ? 'error' : ''} ${item.warning ? 'warning' : ''} ${item.status === 'listo' && !item.warning ? 'ok' : ''}">${escapeHtml(item.statusText || '')}</div>
        <button class="btn-tiny btn-delete" data-action="remove-pending" data-local-id="${item.localId}" type="button">Quitar</button>
      </div>
    `).join('');
    saveAllBtn.disabled = pendingReceipts.length === 0 || pendingReceipts.some((i) => i.status === 'guardando');
    saveAllBtn.textContent = pendingReceipts.length
      ? `Guardar ${pendingReceipts.length} comprobante(s)`
      : 'Guardar comprobantes';
  }

  function extractPendingItem(item) {
    const formData = new FormData();
    formData.append('file', item.file);
    fetch('/api/payment-receipts-extract', { method: 'POST', body: formData })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'no se pudo leer');
        if (data.amount) item.amount = data.amount;
        if (data.paymentDate) item.paymentDate = data.paymentDate;
        if (data.payerName) item.payerName = data.payerName;
        if (data.reference) item.reference = data.reference;
        if (data.mismatch) {
          item.warning = true;
          item.statusText = `⚠ Optimus registra ${fmtMoney(data.optimusAmount)} pero el comprobante dice ${fmtMoney(data.amount)}. Revisa antes de guardar.`;
        } else {
          item.warning = false;
          item.statusText = data.amount || data.paymentDate ? 'Leído — revisa que esté bien.' : 'No se pudo leer, complétalo a mano.';
        }
        item.status = 'listo';
      })
      .catch(() => {
        item.status = 'listo';
        item.statusText = 'No se pudo leer, complétalo a mano.';
      })
      .finally(renderPendingQueue);
  }

  function addFiles(files) {
    const imageFiles = Array.from(files || []).filter((f) => f.type && f.type.startsWith('image/'));
    if (!imageFiles.length) return;
    const room = MAX_PENDING - pendingReceipts.length;
    if (room <= 0) {
      alert(`Ya tienes ${MAX_PENDING} comprobantes en la cola. Guarda o quita alguno antes de agregar más.`);
      return;
    }
    const toAdd = imageFiles.slice(0, room);
    if (imageFiles.length > toAdd.length) {
      alert(`Solo se agregaron ${toAdd.length} de ${imageFiles.length} fotos — el máximo es ${MAX_PENDING} a la vez.`);
    }
    toAdd.forEach((file) => {
      const item = {
        localId: 'p' + (++pendingCounter),
        file,
        previewUrl: URL.createObjectURL(file),
        amount: '',
        paymentDate: new Date().toISOString().slice(0, 10),
        payerName: '',
        reference: '',
        note: '',
        status: 'leyendo',
        statusText: 'Leyendo el comprobante...',
      };
      pendingReceipts.push(item);
      extractPendingItem(item);
    });
    renderPendingQueue();
  }

  rpFile.addEventListener('change', function () {
    addFiles(rpFile.files);
    rpFile.value = '';
  });

  document.addEventListener('paste', function (e) {
    const items = Array.from(e.clipboardData?.items || []);
    const imageFiles = items
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (!imageFiles.length) return;
    e.preventDefault();
    addFiles(imageFiles);
  });

  pendingQueue.addEventListener('input', function (e) {
    const el = e.target;
    const field = el.getAttribute('data-field');
    const localId = el.getAttribute('data-local-id');
    if (!field || !localId) return;
    const item = pendingReceipts.find((i) => i.localId === localId);
    if (item) item[field] = el.value;
  });

  pendingQueue.addEventListener('click', function (e) {
    const btn = e.target.closest('button[data-action="remove-pending"]');
    if (!btn) return;
    const localId = btn.getAttribute('data-local-id');
    const item = pendingReceipts.find((i) => i.localId === localId);
    if (item) URL.revokeObjectURL(item.previewUrl);
    pendingReceipts = pendingReceipts.filter((i) => i.localId !== localId);
    renderPendingQueue();
  });

  saveAllBtn.addEventListener('click', async function () {
    const toSave = pendingReceipts.filter((i) => i.status !== 'guardando');
    for (const item of toSave) {
      if (!item.amount || !item.paymentDate) {
        item.status = 'error';
        item.statusText = 'Falta el monto o la fecha.';
        continue;
      }
      item.status = 'guardando';
      item.statusText = 'Guardando...';
      renderPendingQueue();

      const formData = new FormData();
      formData.append('amount', item.amount);
      formData.append('paymentDate', item.paymentDate);
      formData.append('payerName', item.payerName || '');
      formData.append('reference', item.reference || '');
      formData.append('note', item.note || '');
      formData.append('file', item.file);

      try {
        const res = await fetch('/api/payment-receipts', { method: 'POST', body: formData });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error([data.error, data.detail].filter(Boolean).join(' — ') || 'No se pudo guardar.');
        URL.revokeObjectURL(item.previewUrl);
        pendingReceipts = pendingReceipts.filter((i) => i.localId !== item.localId);
      } catch (err) {
        item.status = 'error';
        item.statusText = err.message || 'No se pudo guardar.';
      }
      renderPendingQueue();
    }
    loadReceipts();
  });

  const verifyReceiptsForm = document.getElementById('verifyReceiptsForm');
  const verifyReceiptsFile = document.getElementById('verifyReceiptsFile');
  const verifyReceiptsResult = document.getElementById('verifyReceiptsResult');

  const tabButtons = document.querySelectorAll('.tab-btn[data-status]');
  let currentStatus = '';
  let allReceipts = [];

  function renderGallery() {
    const receipts = currentStatus ? allReceipts.filter((r) => r.status === currentStatus) : allReceipts;
    if (!receipts.length) {
      receiptGallery.innerHTML = '<div class="empty">No hay comprobantes en esta vista.</div>';
      return;
    }
    receiptGallery.innerHTML = receipts.map((r) => `
      <div class="receipt-item" data-id="${r.id}">
        <div class="receipt-thumb"><img src="${r.imageUrl}" alt="Comprobante" loading="lazy" /></div>
        <div class="receipt-amount">${fmtMoney(r.amount)} <span class="badge ${r.status}">${STATUS_LABELS[r.status] || r.status}</span></div>
        <div class="receipt-meta">${fmtDateOnly(r.paymentDate)}${r.payerName ? ' · ' + escapeHtml(r.payerName) : ''}</div>
        ${r.reference ? `<div class="receipt-meta">Aprobación: ${escapeHtml(r.reference)}</div>` : ''}
        ${r.note ? `<div class="receipt-note">${escapeHtml(r.note)}</div>` : ''}
        ${r.matchedDetail ? `<div class="receipt-mismatch">${escapeHtml(r.matchedDetail)}</div>` : ''}
        <div class="receipt-meta">Subido por ${escapeHtml(r.uploadedByName)}</div>
        <div class="receipt-actions">
          ${r.status !== 'verificado' ? `<button class="btn-small btn-done" data-action="mark-verified" data-id="${r.id}" type="button">Verificar manual</button>` : ''}
          ${r.status !== 'pendiente' ? `<button class="btn-small" data-action="mark-pending" data-id="${r.id}" type="button">Marcar pendiente</button>` : ''}
          <button class="btn-small btn-delete" data-action="delete" data-id="${r.id}" type="button">Eliminar</button>
        </div>
      </div>
    `).join('');
  }

  function loadReceipts() {
    fetch('/api/payment-receipts')
      .then((res) => res.json())
      .then((data) => {
        if (data && Array.isArray(data.receipts)) {
          allReceipts = data.receipts;
          renderGallery();
        } else {
          receiptGallery.innerHTML = '<div class="empty">No se pudo cargar (revisa la conexión).</div>';
        }
      })
      .catch(() => {
        receiptGallery.innerHTML = '<div class="empty">No se pudo cargar (revisa la conexión).</div>';
      });
  }

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', function () {
      tabButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentStatus = btn.getAttribute('data-status') || '';
      renderGallery();
    });
  });

  verifyReceiptsForm.addEventListener('submit', function (e) {
    e.preventDefault();
    const file = verifyReceiptsFile.files && verifyReceiptsFile.files[0];
    if (!file) return;
    verifyReceiptsResult.innerHTML = 'Comparando...';
    const submitBtn = verifyReceiptsForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    const formData = new FormData();
    formData.append('file', file);

    fetch('/api/payment-receipts-verify', { method: 'POST', body: formData })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo procesar el archivo.');
        verifyReceiptsResult.innerHTML = `<p class="result-ok">${data.movementsRead} movimientos leídos · ${data.verified} comprobantes verificados · ${data.ambiguous} con varias coincidencias (revisar a mano) · ${data.notFound} sin encontrar${data.duplicateBlocked ? ` (${data.duplicateBlocked} posibles duplicados)` : ''}.</p>`;
        verifyReceiptsForm.reset();
        loadReceipts();
      })
      .catch((err) => {
        verifyReceiptsResult.innerHTML = `<p class="result-error">${escapeHtml(err.message || 'No se pudo procesar el archivo.')}</p>`;
      })
      .finally(() => {
        submitBtn.disabled = false;
      });
  });

  const compareOptimusForm = document.getElementById('compareOptimusForm');
  const compareOptimusFile = document.getElementById('compareOptimusFile');
  const compareOptimusResult = document.getElementById('compareOptimusResult');

  function renderOptimusReport(data) {
    const s = data.stats;
    const statsHtml = `
      <div class="optimus-stats-row">
        <div class="stat-box"><span class="n">${s.optimusCount}</span><span class="l">Pagos en Optimus</span></div>
        <div class="stat-box"><span class="n">${s.receiptsUploadedCount}</span><span class="l">Comprobantes subidos</span></div>
        <div class="stat-box"><span class="n">${s.receiptsVerifiedCount}</span><span class="l">Comprobantes verificados</span></div>
        <div class="stat-box"><span class="n">${s.matchedCount}</span><span class="l">Coinciden bien</span></div>
        <div class="stat-box overdue"><span class="n">${s.amountMismatchCount}</span><span class="l">Monto distinto</span></div>
        <div class="stat-box overdue"><span class="n">${s.optimusOnlyCount}</span><span class="l">Optimus sin comprobante</span></div>
        <div class="stat-box overdue"><span class="n">${s.receiptOnlyCount}</span><span class="l">Comprobante sin Optimus</span></div>
      </div>
    `;

    const mismatchRows = data.amountMismatch.map((m) => `
      <tr>
        <td>${escapeHtml(m.cliente)}</td>
        <td class="amount-bad">${fmtMoney(m.montoOptimus)}</td>
        <td class="amount-bad">${fmtMoney(m.montoComprobante)}</td>
        <td>${escapeHtml(m.payerName)}</td>
      </tr>
    `).join('');

    const optimusOnlyRows = data.optimusOnly.map((o) => `
      <tr>
        <td>${escapeHtml(o.cliente)}</td>
        <td>${fmtMoney(o.monto)}</td>
        <td>${o.fecha ? fmtDateOnly(o.fecha) : ''}</td>
        <td>${escapeHtml(o.numero)}</td>
      </tr>
    `).join('');

    const receiptOnlyRows = data.receiptOnly.map((r) => `
      <tr>
        <td>${escapeHtml(r.payerName) || '<span class="hint" style="margin:0;">Sin nombre</span>'}</td>
        <td>${fmtMoney(r.amount)}</td>
        <td>${fmtDateOnly(r.paymentDate)}</td>
      </tr>
    `).join('');

    compareOptimusResult.innerHTML = `
      ${statsHtml}
      <div class="optimus-tables">
        <div>
          <h3>Monto distinto (${data.amountMismatch.length})</h3>
          <table class="optimus-table">
            <thead><tr><th>Cliente</th><th>Monto Optimus</th><th>Monto comprobante</th><th>Comprobante de</th></tr></thead>
            <tbody>${mismatchRows || '<tr><td colspan="4">Ninguno</td></tr>'}</tbody>
          </table>
        </div>
        <div>
          <h3>En Optimus sin comprobante (${data.optimusOnly.length})</h3>
          <table class="optimus-table">
            <thead><tr><th>Cliente</th><th>Monto</th><th>Fecha</th><th>Número</th></tr></thead>
            <tbody>${optimusOnlyRows || '<tr><td colspan="4">Ninguno</td></tr>'}</tbody>
          </table>
        </div>
        <div>
          <h3>Comprobante verificado sin registrar en Optimus (${data.receiptOnly.length})</h3>
          <table class="optimus-table">
            <thead><tr><th>Nombre</th><th>Monto</th><th>Fecha</th></tr></thead>
            <tbody>${receiptOnlyRows || '<tr><td colspan="3">Ninguno</td></tr>'}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  compareOptimusForm.addEventListener('submit', function (e) {
    e.preventDefault();
    const file = compareOptimusFile.files && compareOptimusFile.files[0];
    if (!file) return;
    compareOptimusResult.innerHTML = 'Comparando...';
    const submitBtn = compareOptimusForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    const formData = new FormData();
    formData.append('file', file);

    fetch('/api/payment-receipts-compare-optimus', { method: 'POST', body: formData })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo procesar el archivo.');
        renderOptimusReport(data);
      })
      .catch((err) => {
        compareOptimusResult.innerHTML = `<p class="result-error">${escapeHtml(err.message || 'No se pudo procesar el archivo.')}</p>`;
      })
      .finally(() => {
        submitBtn.disabled = false;
      });
  });

  receiptGallery.addEventListener('click', function (e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    const action = btn.getAttribute('data-action');

    if (action === 'delete') {
      if (!confirm('¿Eliminar este comprobante?')) return;
      fetch('/api/payment-receipts', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      }).then(loadReceipts);
    } else if (action === 'mark-verified') {
      fetch('/api/payment-receipts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status: 'verificado' }),
      }).then(loadReceipts);
    } else if (action === 'mark-pending') {
      fetch('/api/payment-receipts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status: 'pendiente' }),
      }).then(loadReceipts);
    }
  });

  const deleteAllReceiptsBtn = document.getElementById('deleteAllReceiptsBtn');
  if (deleteAllReceiptsBtn) {
    deleteAllReceiptsBtn.addEventListener('click', function () {
      if (!confirm(`¿Borrar TODOS los comprobantes (${allReceipts.length})? Esto no se puede deshacer.`)) return;
      deleteAllReceiptsBtn.disabled = true;
      fetch('/api/payment-receipts', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteAll: true }),
      })
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'No se pudo borrar.');
          loadReceipts();
        })
        .catch((err) => alert(err.message || 'No se pudo borrar.'))
        .finally(() => { deleteAllReceiptsBtn.disabled = false; });
    });
  }

  loadReceipts();
});
