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

  function statusClass(status) {
    return 'status-' + String(status || '').replace(/\s+/g, '-');
  }

  function compressImage(file, maxDim, quality) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const reader = new FileReader();
      reader.onload = () => { img.src = reader.result; };
      reader.onerror = reject;
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error('No se pudo comprimir la imagen'));
        }, 'image/jpeg', quality);
      };
      img.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  const casoForm = document.getElementById('casoForm');
  const casosList = document.getElementById('casosList');
  if (!casosList) return; // no autenticado o sin permiso

  const searchInput = document.getElementById('searchInput');
  const branchFilter = document.getElementById('branchFilter');
  const categoryFilter = document.getElementById('categoryFilter');
  const tabButtons = document.querySelectorAll('.tab-btn[data-status]');
  let currentStatus = '';
  let editingNoteId = null;

  function renderCasos(casos) {
    if (!casos.length) {
      casosList.innerHTML = '<div class="empty">No hay casos con esos filtros.</div>';
      return;
    }
    casosList.innerHTML = casos.map((c) => `
      <div class="caso-item ${statusClass(c.status)}" data-id="${c.id}">
        <div class="caso-top">
          <span class="caso-plate">${escapeHtml(c.plate)} · ${escapeHtml(c.branch)}</span>
          <span class="badge ${statusClass(c.status)}">${escapeHtml(c.status)}</span>
          <span class="badge">${escapeHtml(c.category)}</span>
        </div>
        <p class="caso-description">${escapeHtml(c.description)}</p>
        ${Array.isArray(c.images) && c.images.length ? `
          <div class="caso-images">
            ${c.images.map((path) => {
              const src = '/api/blob-file?path=' + encodeURIComponent(path);
              return `<a href="${src}" target="_blank" rel="noopener"><img src="${src}" alt="Foto del caso" loading="lazy" /></a>`;
            }).join('')}
          </div>
        ` : ''}
        <div class="caso-meta">
          Abierto por ${escapeHtml(c.createdByName)} el ${fmtDate(c.createdAt)}
          ${c.finalizedAt ? ` · Finalizado por ${escapeHtml(c.finalizedByName)} el ${fmtDate(c.finalizedAt)}` : ''}
        </div>
        <div class="caso-actions">
          ${c.status !== 'Abierto' ? `<button class="btn-small" data-action="set-status" data-status="Abierto" data-id="${c.id}" type="button">Marcar abierto</button>` : ''}
          ${c.status !== 'En seguimiento' ? `<button class="btn-small" data-action="set-status" data-status="En seguimiento" data-id="${c.id}" type="button">Marcar en seguimiento</button>` : ''}
          ${c.status !== 'Finalizado' ? `<button class="btn-small btn-done" data-action="set-status" data-status="Finalizado" data-id="${c.id}" type="button">Finalizar caso</button>` : ''}
        </div>
        <div class="caso-add-note-row">
          <input type="text" placeholder="Agregar nota de seguimiento..." data-note-input data-id="${c.id}" />
          <button class="btn-small" data-action="addnote" data-id="${c.id}" type="button">Agregar</button>
        </div>
        ${c.notes && c.notes.length ? `
          <div class="caso-notes-list">
            ${c.notes.map((n) => `<div class="caso-note-item"><span class="caso-note-date">${fmtDate(n.date)} · ${escapeHtml(n.authorName)}</span>${escapeHtml(n.text)}</div>`).join('')}
          </div>
        ` : ''}
      </div>
    `).join('');
  }

  function loadCasos() {
    const params = new URLSearchParams();
    if (searchInput.value.trim()) params.set('q', searchInput.value.trim());
    if (branchFilter.value) params.set('branch', branchFilter.value);
    if (categoryFilter.value) params.set('category', categoryFilter.value);
    if (currentStatus) params.set('status', currentStatus);

    fetch('/api/casos-importantes?' + params.toString())
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (data && Array.isArray(data.casos)) renderCasos(data.casos);
        else casosList.innerHTML = `<div class="empty">No se pudo cargar${data && data.error ? ': ' + escapeHtml(data.error) : ' (revisa la conexión)'}.</div>`;
      })
      .catch((err) => {
        casosList.innerHTML = `<div class="empty">No se pudo cargar: ${escapeHtml(err.message || 'error de red')}.</div>`;
      });
  }

  let debounceTimer;
  function debouncedLoad() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(loadCasos, 250);
  }

  searchInput.addEventListener('input', debouncedLoad);
  branchFilter.addEventListener('change', loadCasos);
  categoryFilter.addEventListener('change', loadCasos);
  tabButtons.forEach((btn) => {
    btn.addEventListener('click', function () {
      tabButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentStatus = btn.getAttribute('data-status') || '';
      loadCasos();
    });
  });

  casosList.addEventListener('click', function (e) {
    const statusBtn = e.target.closest('button[data-action="set-status"]');
    if (statusBtn) {
      const id = statusBtn.getAttribute('data-id');
      const status = statusBtn.getAttribute('data-status');
      fetch('/api/casos-importantes', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status }),
      }).then(loadCasos);
      return;
    }
    const noteBtn = e.target.closest('button[data-action="addnote"]');
    if (noteBtn) {
      const id = noteBtn.getAttribute('data-id');
      const input = casosList.querySelector(`input[data-note-input][data-id="${id}"]`);
      const text = input ? input.value.trim() : '';
      if (!text) return;
      fetch('/api/casos-importantes', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, addNote: text }),
      }).then(loadCasos);
    }
  });

  // --- Formulario de creación (fotos con paste/compresión, igual que Novedades) ---
  const imagesInput = document.getElementById('images');
  const imagePreview = document.getElementById('imagePreview');
  const MAX_IMAGES = 4;
  let pendingImages = [];

  function renderImagePreview() {
    imagePreview.innerHTML = pendingImages.map((_, i) => `
      <div class="thumb" data-index="${i}">
        <img src="${pendingImages[i].url}" alt="Previsualización" />
        <button type="button" data-remove="${i}" aria-label="Quitar imagen">×</button>
      </div>
    `).join('');
  }

  function addPendingImage(file) {
    if (pendingImages.length >= MAX_IMAGES) return;
    pendingImages.push({ file, url: URL.createObjectURL(file) });
    renderImagePreview();
  }

  if (imagesInput) {
    imagesInput.addEventListener('change', () => {
      Array.from(imagesInput.files || []).forEach(addPendingImage);
      imagesInput.value = '';
    });
  }

  if (imagePreview) {
    imagePreview.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-remove]');
      if (!btn) return;
      const i = Number(btn.getAttribute('data-remove'));
      URL.revokeObjectURL(pendingImages[i].url);
      pendingImages.splice(i, 1);
      renderImagePreview();
    });
  }

  casoForm.addEventListener('paste', (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const imageItems = items.filter((item) => item.kind === 'file' && item.type.startsWith('image/'));
    if (!imageItems.length) return;
    imageItems.forEach((item) => {
      const file = item.getAsFile();
      if (file) addPendingImage(file);
    });
  });

  casoForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    const plate = document.getElementById('plate').value.trim();
    const branch = document.getElementById('branch').value;
    const category = document.getElementById('category').value;
    const description = document.getElementById('description').value.trim();
    if (!plate || !branch || !category || !description) return;

    const submitBtn = casoForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    const originalLabel = submitBtn.textContent;

    try {
      const formData = new FormData();
      formData.set('plate', plate);
      formData.set('branch', branch);
      formData.set('category', category);
      formData.set('description', description);

      if (pendingImages.length) {
        submitBtn.textContent = 'Procesando fotos...';
        for (const { file } of pendingImages) {
          const compressed = await compressImage(file, 1600, 0.75);
          formData.append('images', compressed, 'foto.jpg');
        }
      }

      submitBtn.textContent = 'Guardando...';
      const res = await fetch('/api/casos-importantes', { method: 'POST', body: formData });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error([data.error, data.detail].filter(Boolean).join(' — ') || `error ${res.status}`);
      }
      casoForm.reset();
      pendingImages.forEach((p) => URL.revokeObjectURL(p.url));
      pendingImages = [];
      renderImagePreview();
      loadCasos();
    } catch (err) {
      alert('No se pudo guardar el caso: ' + (err.message || 'intenta de nuevo.'));
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  });

  loadCasos();
});
