document.addEventListener('DOMContentLoaded', function () {
  const table = document.getElementById('poolTable');
  if (!table) return;
  const branchSel = document.getElementById('poolBranch');
  const scopeSel = document.getElementById('poolScope');
  const updatedEl = document.getElementById('poolUpdated');
  const customRange = document.getElementById('poolCustomRange');
  const fromInput = document.getElementById('poolFrom');
  const toInput = document.getElementById('poolTo');
  const detailCard = document.getElementById('poolDetailCard');
  const detailTitle = document.getElementById('poolDetailTitle');
  const detailTable = document.getElementById('poolDetailTable');

  let period = 'hoy';
  let data = null;
  let selectedId = null;
  let branchesLoaded = false;

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function colombiaToday() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
  }
  function addDays(date, days) {
    const d = new Date(date + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
  function rangeFor(p) {
    const today = colombiaToday();
    if (p === 'hoy') return [today, today];
    if (p === 'ayer') { const y = addDays(today, -1); return [y, y]; }
    if (p === 'semana') {
      const dow = new Date(today + 'T12:00:00Z').getUTCDay(); // 0 = domingo
      const back = dow === 0 ? 6 : dow - 1;
      return [addDays(today, -back), today];
    }
    if (p === 'mes') return [today.slice(0, 8) + '01', today];
    return [fromInput.value || today, toInput.value || today];
  }
  function fmtDate(d) {
    const [y, m, day] = d.split('-');
    return `${day}/${m}/${y.slice(2)}`;
  }
  function ago(iso) {
    if (!iso) return '';
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'ahora mismo';
    if (mins < 60) return `hace ${mins} min`;
    const h = Math.floor(mins / 60);
    if (h < 24) return `hace ${h} h ${mins % 60} min`;
    return `hace ${Math.floor(h / 24)} día(s)`;
  }
  function fmtTime(iso) {
    return new Date(iso).toLocaleString('es-CO', { timeZone: 'America/Bogota', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function render() {
    if (!data) return;
    const metrics = data.metrics;
    const groups = [];
    metrics.forEach((m) => {
      const g = groups.find((x) => x.name === m.group);
      if (g) g.n++; else groups.push({ name: m.group, n: 1 });
    });
    const groupRow = `<tr><th></th>${groups.map((g) => `<th class="group" colspan="${g.n}">${escapeHtml(g.name)}</th>`).join('')}<th></th><th></th></tr>`;
    const headRow = `<tr><th>Persona</th>${metrics.map((m) => `<th class="num">${escapeHtml(m.label)}</th>`).join('')}<th class="num">Total</th><th>Última acción</th></tr>`;
    const sums = {};
    const rows = data.rows.map((r) => {
      metrics.forEach((m) => { sums[m.key] = (sums[m.key] || 0) + (r.totals[m.key] || 0); });
      const idleMins = r.lastAt ? (Date.now() - new Date(r.lastAt).getTime()) / 60000 : Infinity;
      const isToday = data.from === data.today && data.to === data.today;
      const lastCls = !r.lastAt ? 'idle' : idleMins <= 30 ? 'recent' : idleMins > 180 && isToday ? 'idle' : '';
      const last = r.lastAt ? `${ago(r.lastAt)}<br /><small>${fmtTime(r.lastAt)}</small>` : (isToday ? 'Sin actividad hoy' : 'Sin actividad en el período');
      return `<tr class="person ${selectedId === r.id ? 'selected' : ''}" data-id="${r.id}">
        <td class="who">${escapeHtml(r.name)}<small>${escapeHtml(r.role === 'gerente' ? 'Gerente' : r.role === 'secretaria' ? 'Secretaria' : r.role)}${r.branches.length ? ' · ' + escapeHtml(r.branches.join(', ')) : ''}</small></td>
        ${metrics.map((m) => { const v = r.totals[m.key] || 0; return `<td class="num ${v ? '' : 'zero'}">${v}</td>`; }).join('')}
        <td class="num total">${r.total}</td>
        <td class="${lastCls}">${last}</td>
      </tr>`;
    }).join('');
    const sumRow = data.rows.length > 1 ? `<tr class="sum"><td>Total</td>${metrics.map((m) => `<td class="num">${sums[m.key] || 0}</td>`).join('')}<td class="num total">${data.rows.reduce((a, r) => a + r.total, 0)}</td><td></td></tr>` : '';
    table.innerHTML = `<thead>${groupRow}${headRow}</thead><tbody>${rows || '<tr><td colspan="99">No hay personas con ese filtro.</td></tr>'}${sumRow}</tbody>`;
    updatedEl.textContent = `${fmtDate(data.from)}${data.from !== data.to ? ' a ' + fmtDate(data.to) : ''} · actualizado ${new Date(data.generatedAt).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
    if (!branchesLoaded && Array.isArray(data.branches)) {
      const cur = branchSel.value;
      branchSel.innerHTML = '<option value="">Todas las sucursales</option>' + data.branches.map((b) => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');
      branchSel.value = cur;
      branchesLoaded = true;
    }
    renderDetail();
  }

  function renderDetail() {
    const r = data && data.rows.find((x) => x.id === selectedId);
    if (!r) { detailCard.hidden = true; return; }
    detailCard.hidden = false;
    const metrics = data.metrics;
    detailTitle.textContent = `${r.name} · día por día`;
    const days = data.dates.slice().reverse();
    const rows = days.map((d) => {
      const c = r.perDay[d] || {};
      const total = Object.values(c).reduce((a, b) => a + b, 0);
      return `<tr><td>${fmtDate(d)}</td>${metrics.map((m) => `<td class="num ${c[m.key] ? '' : 'zero'}">${c[m.key] || 0}</td>`).join('')}<td class="num total">${total}</td></tr>`;
    }).join('');
    detailTable.innerHTML = `<thead><tr><th>Día</th>${metrics.map((m) => `<th class="num">${escapeHtml(m.label)}</th>`).join('')}<th class="num">Total</th></tr></thead><tbody>${rows}</tbody>`;
  }

  let loading = false;
  function load() {
    if (loading) return;
    loading = true;
    const [from, to] = rangeFor(period);
    const params = new URLSearchParams({ from, to });
    if (branchSel.value) params.set('branch', branchSel.value);
    if (scopeSel.value) params.set('scope', scopeSel.value);
    fetch('/api/pool-secretarias?' + params.toString())
      .then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }))
      .then(({ status, body }) => {
        if (!body || !Array.isArray(body.rows)) {
          table.innerHTML = `<tbody><tr><td>No se pudo cargar (HTTP ${status})${body && body.error ? ': ' + escapeHtml(body.error) : ''}.</td></tr></tbody>`;
          return;
        }
        data = body;
        render();
      })
      .catch(() => { table.innerHTML = '<tbody><tr><td>No se pudo cargar (revisa la conexión).</td></tr></tbody>'; })
      .finally(() => { loading = false; });
  }

  document.querySelectorAll('.period-buttons [data-period]').forEach((btn) => {
    btn.addEventListener('click', () => {
      period = btn.getAttribute('data-period');
      document.querySelectorAll('.period-buttons [data-period]').forEach((b) => b.classList.toggle('active', b === btn));
      customRange.hidden = period !== 'custom';
      if (period === 'custom') {
        if (!fromInput.value) fromInput.value = addDays(colombiaToday(), -7);
        if (!toInput.value) toInput.value = colombiaToday();
      }
      load();
    });
  });
  document.getElementById('poolCustomBtn').addEventListener('click', load);
  branchSel.addEventListener('change', load);
  scopeSel.addEventListener('change', load);
  table.addEventListener('click', (e) => {
    const tr = e.target.closest('tr.person');
    if (!tr) return;
    selectedId = selectedId === tr.getAttribute('data-id') ? null : tr.getAttribute('data-id');
    render();
  });

  load();
  // "En tiempo real": se refresca solo cada minuto mientras la pestaña esté visible.
  setInterval(() => { if (!document.hidden) load(); }, 60000);
});
