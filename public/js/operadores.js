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

  function fmtDateOnly(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString('es-CO', { dateStyle: 'medium' });
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

  // ---------- Tabs ----------
  const tabButtons = document.querySelectorAll('.tab-btn');
  if (tabButtons.length) {
    tabButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        tabButtons.forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        const panel = document.getElementById('tab-' + btn.getAttribute('data-tab'));
        if (panel) panel.classList.add('active');
      });
    });
  }

  // ---------- Novedades (reportes) ----------
  const reportForm = document.getElementById('reportForm');
  const reportsList = document.getElementById('reportsList');
  if (reportsList) {
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
                const src = '/api/report-image?path=' + encodeURIComponent(path);
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

    reportForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      const plate = document.getElementById('plate').value.trim();
      const branch = document.getElementById('branch').value;
      const category = document.getElementById('category').value;
      const note = document.getElementById('note').value.trim();
      const imagesInput = document.getElementById('images');
      const files = imagesInput ? Array.from(imagesInput.files || []).slice(0, 4) : [];
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

        if (files.length) {
          submitBtn.textContent = 'Procesando fotos...';
          for (const file of files) {
            const compressed = await compressImage(file, 1600, 0.75);
            formData.append('images', compressed, 'foto.jpg');
          }
        }

        submitBtn.textContent = 'Guardando...';
        const res = await fetch('/api/reports', { method: 'POST', body: formData });
        if (!res.ok) throw new Error('save failed');
        reportForm.reset();
        loadReports();
      } catch (err) {
        alert('No se pudo guardar el reporte, intenta de nuevo.');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = originalLabel;
      }
    });

    loadReports();
  }

  // ---------- Reportes programados ----------
  const scheduledForm = document.getElementById('scheduledForm');
  const scheduledList = document.getElementById('scheduledList');
  if (scheduledList) {
    function renderScheduled(reports) {
      if (!reports.length) {
        scheduledList.innerHTML = '<div class="empty">No hay reportes programados todavía.</div>';
        return;
      }
      scheduledList.innerHTML = reports.map((r) => `
        <div class="list-item ${r.pending ? 'pending' : ''}" data-id="${r.id}">
          <div class="item-top">
            <span class="title">${escapeHtml(r.client)} — ${escapeHtml(r.reportType)}</span>
            <span class="badge status ${r.pending ? '' : 'ok'}">${r.pending ? 'Pendiente' : 'Al día'}</span>
          </div>
          <div class="meta">
            Operador: ${escapeHtml(r.operator)} · Frecuencia: ${escapeHtml(r.frequency)} ·
            ${r.pending ? 'Debía hacerse el ' : 'Próximo: '}${fmtDateOnly(r.nextDue)}
          </div>
          <div class="item-actions">
            <button class="btn-small btn-done" data-action="done" data-id="${r.id}">Marcar hecho</button>
            <button class="btn-small btn-delete" data-action="delete-sr" data-id="${r.id}">Eliminar</button>
          </div>
        </div>
      `).join('');
    }

    function loadScheduled() {
      fetch('/api/scheduled-reports')
        .then((res) => res.json())
        .then((data) => {
          if (data && Array.isArray(data.reports)) renderScheduled(data.reports);
          else scheduledList.innerHTML = '<div class="empty">No se pudo cargar.</div>';
        })
        .catch(() => {
          scheduledList.innerHTML = '<div class="empty">No se pudo cargar.</div>';
        });
    }

    scheduledForm.addEventListener('submit', function (e) {
      e.preventDefault();
      const client = document.getElementById('sr-client').value.trim();
      const reportType = document.getElementById('sr-type').value.trim();
      const frequency = document.getElementById('sr-frequency').value;
      const operator = document.getElementById('sr-operator').value.trim();
      if (!client || !reportType || !frequency || !operator) return;

      fetch('/api/scheduled-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client, reportType, frequency, operator }),
      })
        .then((res) => res.json())
        .then(() => {
          scheduledForm.reset();
          loadScheduled();
        })
        .catch(() => alert('No se pudo guardar.'));
    });

    scheduledList.addEventListener('click', function (e) {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const id = btn.getAttribute('data-id');
      const action = btn.getAttribute('data-action');

      if (action === 'done') {
        fetch('/api/scheduled-reports', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        }).then(loadScheduled);
      } else if (action === 'delete-sr') {
        if (!confirm('¿Eliminar este reporte programado?')) return;
        fetch('/api/scheduled-reports', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        }).then(loadScheduled);
      }
    });

    loadScheduled();
  }

  // ---------- Horario ----------
  const scheduleForm = document.getElementById('scheduleForm');
  const scheduleList = document.getElementById('scheduleList');
  if (scheduleList) {
    function renderSchedule(schedule) {
      if (!schedule.length) {
        scheduleList.innerHTML = '<div class="empty">No hay horarios registrados todavía.</div>';
        return;
      }
      scheduleList.innerHTML = schedule.map((s) => `
        <div class="list-item">
          <div class="item-top"><span class="title">${escapeHtml(s.operator)}</span></div>
          <p class="note">${escapeHtml(s.horario)}</p>
        </div>
      `).join('');
    }

    function loadSchedule() {
      fetch('/api/schedule')
        .then((res) => res.json())
        .then((data) => {
          if (data && Array.isArray(data.schedule)) renderSchedule(data.schedule);
          else scheduleList.innerHTML = '<div class="empty">No se pudo cargar.</div>';
        })
        .catch(() => {
          scheduleList.innerHTML = '<div class="empty">No se pudo cargar.</div>';
        });
    }

    scheduleForm.addEventListener('submit', function (e) {
      e.preventDefault();
      const operator = document.getElementById('sc-operator').value.trim();
      const horario = document.getElementById('sc-horario').value.trim();
      if (!operator || !horario) return;

      fetch('/api/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operator, horario }),
      })
        .then((res) => res.json())
        .then(() => {
          scheduleForm.reset();
          loadSchedule();
        })
        .catch(() => alert('No se pudo guardar.'));
    });

    loadSchedule();
  }

  // ---------- Supervisor unlock ----------
  const supervisorForm = document.getElementById('supervisorForm');
  if (supervisorForm) {
    supervisorForm.addEventListener('submit', function (e) {
      e.preventDefault();
      const password = document.getElementById('sup-password').value;
      fetch('/api/supervisor-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
        .then((res) => res.json())
        .then((data) => {
          if (data && data.ok) {
            window.location.href = '/operadores#horario';
            window.location.reload();
          } else {
            window.location.href = '/operadores?sup_error=1#horario';
          }
        })
        .catch(() => alert('No se pudo verificar la clave.'));
    });
  }

  // ---------- Días compensatorios ----------
  const compDaysForm = document.getElementById('compDaysForm');
  const compDaysList = document.getElementById('compDaysList');
  if (compDaysList) {
    function renderCompDays(entries, totals) {
      const totalsHtml = Object.keys(totals).length
        ? '<div class="meta" style="margin-bottom:14px;">' +
          Object.entries(totals).map(([op, d]) => `${escapeHtml(op)}: <b>${d}</b> día(s)`).join(' · ') +
          '</div>'
        : '';
      if (!entries.length) {
        compDaysList.innerHTML = totalsHtml + '<div class="empty">No hay registros todavía.</div>';
        return;
      }
      compDaysList.innerHTML = totalsHtml + entries.map((e) => `
        <div class="list-item">
          <div class="item-top">
            <span class="title">${escapeHtml(e.operator)}</span>
            <span class="badge">${e.days > 0 ? '+' : ''}${e.days} día(s)</span>
          </div>
          ${e.note ? `<p class="note">${escapeHtml(e.note)}</p>` : ''}
          <div class="meta">${fmtDate(e.createdAt)}</div>
          <div class="item-actions">
            <button class="btn-small btn-delete" data-action="delete-cd" data-id="${e.id}">Eliminar</button>
          </div>
        </div>
      `).join('');
    }

    function loadCompDays() {
      fetch('/api/comp-days')
        .then((res) => res.json())
        .then((data) => {
          if (data && Array.isArray(data.entries)) renderCompDays(data.entries, data.totals || {});
          else compDaysList.innerHTML = '<div class="empty">No se pudo cargar.</div>';
        })
        .catch(() => {
          compDaysList.innerHTML = '<div class="empty">No se pudo cargar.</div>';
        });
    }

    if (compDaysForm) {
      compDaysForm.addEventListener('submit', function (e) {
        e.preventDefault();
        const operator = document.getElementById('cd-operator').value.trim();
        const days = Number(document.getElementById('cd-days').value);
        const note = document.getElementById('cd-note').value.trim();
        if (!operator || !days) return;

        fetch('/api/comp-days', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operator, days, note }),
        })
          .then((res) => res.json())
          .then(() => {
            compDaysForm.reset();
            loadCompDays();
          })
          .catch(() => alert('No se pudo guardar.'));
      });
    }

    compDaysList.addEventListener('click', function (e) {
      const btn = e.target.closest('button[data-action="delete-cd"]');
      if (!btn) return;
      if (!confirm('¿Eliminar este registro?')) return;
      const id = btn.getAttribute('data-id');
      fetch('/api/comp-days', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      }).then(loadCompDays);
    });

    loadCompDays();
  }
});
