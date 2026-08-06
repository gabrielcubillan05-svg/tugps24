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
