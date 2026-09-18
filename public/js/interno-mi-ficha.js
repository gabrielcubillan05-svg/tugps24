document.addEventListener('DOMContentLoaded', function () {
  const vacForm = document.getElementById('vacForm');
  if (!vacForm) return;

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function fmtDateOnly(iso) {
    if (!iso) return '';
    const [y, m, d] = String(iso).slice(0, 10).split('-');
    if (!y || !m || !d) return '';
    return `${d}/${m}/${y}`;
  }

  const STATUS_LABELS = { pendiente: 'Pendiente', aprobada: 'Aprobada', rechazada: 'Rechazada' };
  const STATUS_CLASS = { pendiente: 'status-proximo', aprobada: 'status-indefinido', rechazada: 'status-vencido' };

  function loadProfile() {
    fetch('/api/my-profile')
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok || !data) throw new Error((data && data.error) || 'No se pudo cargar tu ficha.');
        return data;
      })
      .then((data) => {
        document.getElementById('miFichaNombre').textContent = `Mi ficha — ${data.name}`;
        const p = data.profile || {};
        document.getElementById('mf-cedula').textContent = p.cedula || 'Sin registrar';
        document.getElementById('mf-area').textContent = p.area || 'Sin registrar';
        document.getElementById('mf-cargo').textContent = p.cargo || 'Sin registrar';
        document.getElementById('mf-sucursales').textContent = (data.branches || []).join(', ') || 'Sin sucursal';
        document.getElementById('mf-hireDate').textContent = p.hireDate ? fmtDateOnly(p.hireDate) : 'Sin registrar';
        document.getElementById('mf-telefono').value = p.telefono || '';
        document.getElementById('mf-direccion').value = p.direccion || '';
        document.getElementById('mf-correo').value = p.correo || '';

        const b = data.balance;
        document.getElementById('mf-antiguedad').textContent = b ? `${b.yearsOfService} año(s)` : 'Sin fecha de ingreso registrada';
        document.getElementById('mf-vacaciones').textContent = b
          ? `${b.remainingDays} día(s) disponibles · Acumulados: ${b.accruedDays} · Tomados/asignados: ${b.takenDays}${b.paidDays ? ` (${b.paidDays} pagado(s))` : ''}`
          : 'Sin datos todavía (aún no se registra tu fecha de ingreso).';
      })
      .catch((err) => {
        document.getElementById('miFichaNombre').textContent = 'Mi ficha';
        document.getElementById('mf-vacaciones').textContent = err.message || 'No se pudo cargar tu ficha.';
      });
  }
  loadProfile();

  document.getElementById('mfGuardar').addEventListener('click', function () {
    const msg = document.getElementById('mfMsg');
    msg.textContent = '';
    msg.classList.remove('error');
    fetch('/api/my-profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          telefono: document.getElementById('mf-telefono').value.trim(),
          direccion: document.getElementById('mf-direccion').value.trim(),
          correo: document.getElementById('mf-correo').value.trim(),
        },
      }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo guardar.');
        msg.textContent = 'Guardado.';
        loadProfile();
      })
      .catch((err) => {
        msg.textContent = err.message || 'No se pudo guardar.';
        msg.classList.add('error');
      });
  });

  function renderVacList(entries) {
    const el = document.getElementById('vacList');
    if (!entries.length) {
      el.innerHTML = '<div class="empty">Todavía no has solicitado vacaciones.</div>';
      return;
    }
    el.innerHTML = entries.map((e) => `
      <div class="list-item">
        <div class="item-top">
          <span class="title">${fmtDateOnly(e.startDate)} – ${fmtDateOnly(e.endDate)}</span>
          <span class="badge ${STATUS_CLASS[e.status] || ''}">${STATUS_LABELS[e.status] || e.status}</span>
        </div>
        ${e.note ? `<p class="note">${escapeHtml(e.note)}</p>` : ''}
        ${e.status === 'pendiente' ? `<div class="item-actions"><button class="btn-small btn-delete" data-action="cancel-vac" data-id="${e.id}">Cancelar</button></div>` : ''}
        ${e.resolutionNote ? `<p class="note">Respuesta: ${escapeHtml(e.resolutionNote)}</p>` : ''}
      </div>
    `).join('');
  }

  function loadVacRequests() {
    fetch('/api/vacation-requests')
      .then((res) => res.json())
      .then((data) => renderVacList((data && data.entries) || []))
      .catch(() => renderVacList([]));
  }
  loadVacRequests();

  vacForm.addEventListener('submit', function (e) {
    e.preventDefault();
    const startDate = document.getElementById('vac-start').value;
    const endDate = document.getElementById('vac-end').value;
    const note = document.getElementById('vac-note').value.trim();
    fetch('/api/vacation-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startDate, endDate, note }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo enviar la solicitud.');
        vacForm.reset();
        loadVacRequests();
      })
      .catch((err) => alert(err.message || 'No se pudo enviar la solicitud.'));
  });

  document.getElementById('vacList').addEventListener('click', function (e) {
    const btn = e.target.closest('button[data-action="cancel-vac"]');
    if (!btn) return;
    if (!confirm('¿Cancelar esta solicitud?')) return;
    fetch('/api/vacation-requests', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: btn.getAttribute('data-id') }),
    }).then(loadVacRequests);
  });
});
