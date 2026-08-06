document.addEventListener('DOMContentLoaded', function () {
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function fmtDate(iso) {
    const d = new Date(iso);
    return d.toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });
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

  const reportForm = document.getElementById('reportForm');
  const reportsList = document.getElementById('reportsList');
  if (!reportsList) return;

  const searchInput = document.getElementById('searchInput');
  const branchFilter = document.getElementById('branchFilter');
  const categoryFilter = document.getElementById('categoryFilter');

  function renderReports(reports) {
    if (!reports.length) {
      reportsList.innerHTML = '<div class="empty">No hay reportes con esos filtros.</div>';
      return;
    }
    reportsList.innerHTML = reports.map((r) => `
      <div class="report-item">
        <div class="report-top">
          <span class="plate">${escapeHtml(r.plate)} · ${escapeHtml(r.branch)}</span>
          <span class="badge">${escapeHtml(r.category)}</span>
        </div>
        <p class="note">${escapeHtml(r.note)}</p>
        ${Array.isArray(r.images) && r.images.length ? `
          <div class="report-images">
            ${r.images.map((path) => {
              const src = '/api/blob-file?path=' + encodeURIComponent(path);
              return `<a href="${src}" target="_blank" rel="noopener"><img src="${src}" alt="Foto del reporte" loading="lazy" /></a>`;
            }).join('')}
          </div>
        ` : ''}
        <div class="meta">${fmtDate(r.createdAt)}</div>
      </div>
    `).join('');
  }

  let debounceTimer;
  function loadReports() {
    const params = new URLSearchParams();
    if (searchInput.value.trim()) params.set('q', searchInput.value.trim());
    if (branchFilter.value) params.set('branch', branchFilter.value);
    if (categoryFilter.value) params.set('category', categoryFilter.value);

    fetch('/api/reports?' + params.toString())
      .then((res) => res.json())
      .then((data) => {
        if (data && Array.isArray(data.reports)) renderReports(data.reports);
        else reportsList.innerHTML = '<div class="empty">No se pudo cargar (revisa la conexión).</div>';
      })
      .catch(() => {
        reportsList.innerHTML = '<div class="empty">No se pudo cargar (revisa la conexión).</div>';
      });
  }

  function debouncedLoad() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(loadReports, 250);
  }

  searchInput.addEventListener('input', debouncedLoad);
  branchFilter.addEventListener('change', loadReports);
  categoryFilter.addEventListener('change', loadReports);

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

  imagePreview.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-remove]');
    if (!btn) return;
    const i = Number(btn.getAttribute('data-remove'));
    URL.revokeObjectURL(pendingImages[i].url);
    pendingImages.splice(i, 1);
    renderImagePreview();
  });

  reportForm.addEventListener('paste', (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const imageItems = items.filter((item) => item.kind === 'file' && item.type.startsWith('image/'));
    if (!imageItems.length) return;
    imageItems.forEach((item) => {
      const file = item.getAsFile();
      if (file) addPendingImage(file);
    });
  });

  reportForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    const plate = document.getElementById('plate').value.trim();
    const branch = document.getElementById('branch').value;
    const category = document.getElementById('category').value;
    const note = document.getElementById('note').value.trim();
    if (!plate || !branch || !category || !note) return;

    const submitBtn = reportForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    const originalLabel = submitBtn.textContent;

    try {
      const formData = new FormData();
      formData.set('plate', plate);
      formData.set('branch', branch);
      formData.set('category', category);
      formData.set('note', note);

      if (pendingImages.length) {
        submitBtn.textContent = 'Procesando fotos...';
        for (const { file } of pendingImages) {
          const compressed = await compressImage(file, 1600, 0.75);
          formData.append('images', compressed, 'foto.jpg');
        }
      }

      submitBtn.textContent = 'Guardando...';
      const res = await fetch('/api/reports', { method: 'POST', body: formData });
      if (!res.ok) throw new Error('save failed');
      reportForm.reset();
      pendingImages.forEach((p) => URL.revokeObjectURL(p.url));
      pendingImages = [];
      renderImagePreview();
      loadReports();
    } catch (err) {
      alert('No se pudo guardar el reporte, intenta de nuevo.');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  });

  loadReports();
});
