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

  const receiptForm = document.getElementById('receiptForm');
  const rpDate = document.getElementById('rp-date');
  const rpAmount = document.getElementById('rp-amount');
  const rpPayer = document.getElementById('rp-payer');
  const rpFile = document.getElementById('rp-file');
  const rpExtractStatus = document.getElementById('rp-extract-status');
  rpDate.value = new Date().toISOString().slice(0, 10);

  rpFile.addEventListener('change', function () {
    const file = rpFile.files && rpFile.files[0];
    if (!file) return;
    rpExtractStatus.textContent = 'Leyendo el comprobante...';
    const formData = new FormData();
    formData.append('file', file);
    fetch('/api/payment-receipts-extract', { method: 'POST', body: formData })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'no se pudo leer');
        const filled = [];
        if (data.amount) { rpAmount.value = data.amount; filled.push('monto'); }
        if (data.paymentDate) { rpDate.value = data.paymentDate; filled.push('fecha'); }
        if (data.payerName) { rpPayer.value = data.payerName; filled.push('nombre'); }
        rpExtractStatus.textContent = filled.length
          ? `Se completó solo: ${filled.join(', ')}. Revisa que esté bien.`
          : 'No se pudo leer nada de la imagen, complétalo a mano.';
      })
      .catch(() => {
        rpExtractStatus.textContent = 'No se pudo leer la imagen automáticamente, complétalo a mano.';
      });
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

  receiptForm.addEventListener('submit', function (e) {
    e.preventDefault();
    const amount = document.getElementById('rp-amount').value;
    const paymentDate = document.getElementById('rp-date').value;
    const payerName = document.getElementById('rp-payer').value.trim();
    const reference = document.getElementById('rp-reference').value.trim();
    const note = document.getElementById('rp-note').value.trim();
    const file = document.getElementById('rp-file').files[0];
    if (!amount || !paymentDate || !file) return;

    const submitBtn = receiptForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    const formData = new FormData();
    formData.append('amount', amount);
    formData.append('paymentDate', paymentDate);
    formData.append('payerName', payerName);
    formData.append('reference', reference);
    formData.append('note', note);
    formData.append('file', file);

    fetch('/api/payment-receipts', { method: 'POST', body: formData })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error([data.error, data.detail].filter(Boolean).join(' — ') || 'No se pudo guardar el comprobante.');
        receiptForm.reset();
        rpDate.value = new Date().toISOString().slice(0, 10);
        loadReceipts();
      })
      .catch((err) => alert(err.message || 'No se pudo guardar el comprobante.'))
      .finally(() => { submitBtn.disabled = false; });
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

  loadReceipts();
});
