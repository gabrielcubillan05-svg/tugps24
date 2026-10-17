document.addEventListener('DOMContentLoaded', function () {
  const table = document.getElementById('poolTable');
  if (!table) return;
  const branchSel = document.getElementById('poolBranch');
  const scopeSel = document.getElementById('poolScope');
  const showEmptyChk = document.getElementById('poolShowEmpty');
  const updatedEl = document.getElementById('poolUpdated');
  const kpisEl = document.getElementById('poolKpis');
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
  let sortKey = 'total';
  let sortDir = -1;

  const AVATAR_COLORS = ['#ff7a1a', '#2f8a4f', '#3b7dd8', '#9b59b6', '#d9640f', '#16a085', '#c0392b', '#7f8c8d'];

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
  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/);
    return ((parts[0] || '')[0] || '?').toUpperCase() + ((parts[1] || '')[0] || '').toUpperCase();
  }
  function avatarColor(name) {
    let h = 0;
    for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }
  // Instalados ÷ agendados: los gerentes y secretarias que instalan sin agendar en el CRM
  // pasarían del 100 %, así que se topa ahí para no premiar el registro incompleto.
  function effOf(t) {
    const a = t.crm_agendados || 0;
    const i = t.crm_instalados || 0;
    if (!a) return null;
    return Math.min(1, i / a);
  }
  function effColor(v) {
    if (v >= 0.5) return 'var(--ok)';
    if (v >= 0.25) return 'var(--teal)';
    return 'var(--danger)';
  }
  function heat(v, max) {
    if (!v || !max) return '';
    const pct = Math.round(4 + 18 * (v / max));
    return ` style="background-color: color-mix(in srgb, var(--amber) ${pct}%, transparent)"`;
  }
  function groupClass(name) {
    return 'g-' + String(name).toLowerCase().normalize('NFD').replace(/[^a-z]/g, '');
  }

  function visibleMetrics() {
    const all = data.metrics;
    if (showEmptyChk.checked) return all;
    return all.filter((m) => data.rows.some((r) => (r.totals[m.key] || 0) > 0));
  }

  // Columnas que se dibujan: las métricas visibles + Efectividad justo después de Instalados.
  function columns() {
    const cols = [];
    visibleMetrics().forEach((m) => {
      cols.push({ key: m.key, label: m.label, group: m.group, kind: 'metric' });
      if (m.key === 'crm_instalados') cols.push({ key: 'eff', label: 'Efectividad', group: m.group, kind: 'eff' });
    });
    if (!cols.some((c) => c.key === 'eff') && data.metrics.some((m) => m.key === 'crm_instalados')) {
      const idx = cols.findIndex((c) => c.group !== 'CRM');
      cols.splice(idx === -1 ? cols.length : idx, 0, { key: 'eff', label: 'Efectividad', group: 'CRM', kind: 'eff' });
    }
    return cols;
  }

  function sortValue(r, key) {
    if (key === 'name') return r.name.toLowerCase();
    if (key === 'total') return r.total;
    if (key === 'last') return r.lastAt ? new Date(r.lastAt).getTime() : 0;
    if (key === 'eff') { const e = effOf(r.totals); return e === null ? -1 : e; }
    return r.totals[key] || 0;
  }

  function renderKpis() {
    const sum = (k) => data.rows.reduce((a, r) => a + (r.totals[k] || 0), 0);
    const inst = sum('crm_instalados');
    const agen = sum('crm_agendados');
    const gest = sum('crm_gestiones');
    const activos = data.rows.filter((r) => r.total > 0).length;
    const eff = agen ? Math.round((Math.min(inst, agen) / agen) * 100) : null;
    const top = data.rows.slice().sort((a, b) => (b.totals.crm_instalados || 0) - (a.totals.crm_instalados || 0))[0];
    const tiles = [
      { label: 'Instalados', value: inst, note: top && top.totals.crm_instalados ? `Más: ${top.name.split(' ')[0]} (${top.totals.crm_instalados})` : 'Sin instalaciones', accent: true },
      { label: 'Agendados', value: agen, note: 'Citas registradas en el CRM' },
      { label: 'Efectividad', value: eff === null ? '—' : eff + '%', note: 'Instalados ÷ agendados' },
      { label: 'Gestiones CRM', value: gest, note: 'Notas en leads' },
      { label: 'Personas activas', value: `${activos}/${data.rows.length}`, note: 'Con al menos una acción' },
    ];
    kpisEl.innerHTML = tiles.map((t) => `<div class="kpi${t.accent ? ' accent' : ''}"><div class="k-label">${escapeHtml(t.label)}</div><div class="k-value">${escapeHtml(String(t.value))}</div><div class="k-note">${escapeHtml(t.note)}</div></div>`).join('');
  }

  function render() {
    if (!data) return;
    renderKpis();
    const cols = columns();
    const maxes = {};
    cols.forEach((c) => { if (c.kind === 'metric') maxes[c.key] = Math.max(0, ...data.rows.map((r) => r.totals[c.key] || 0)); });

    const groups = [];
    cols.forEach((c) => {
      const g = groups[groups.length - 1];
      if (g && g.name === c.group) g.n++; else groups.push({ name: c.group, n: 1 });
    });
    const arrow = (k) => (sortKey === k ? (sortDir < 0 ? ' ↓' : ' ↑') : '');
    const th = (k, label, cls) => `<th class="sortable ${cls || ''}${sortKey === k ? ' sorted' : ''}" data-sort="${k}">${escapeHtml(label)}${arrow(k)}</th>`;
    const groupRow = `<tr class="groups"><th></th>${groups.map((g) => `<th class="group ${groupClass(g.name)}" colspan="${g.n}">${escapeHtml(g.name)}</th>`).join('')}<th></th><th></th></tr>`;
    const headRow = `<tr class="cols">${th('name', 'Persona')}${cols.map((c) => th(c.key, c.label, 'num')).join('')}${th('total', 'Total', 'num')}${th('last', 'Última acción')}</tr>`;

    const isToday = data.from === data.today && data.to === data.today;
    const rowsSorted = data.rows.slice().sort((a, b) => {
      const va = sortValue(a, sortKey);
      const vb = sortValue(b, sortKey);
      if (va < vb) return -1 * sortDir;
      if (va > vb) return 1 * sortDir;
      return a.name.localeCompare(b.name);
    });

    const rows = rowsSorted.map((r, i) => {
      const idleMins = r.lastAt ? (Date.now() - new Date(r.lastAt).getTime()) / 60000 : Infinity;
      const dotCls = !r.lastAt ? 'idle' : idleMins <= 30 ? 'recent' : idleMins > 180 && isToday ? 'idle' : '';
      const last = r.lastAt
        ? `<div class="last"><span class="dot ${dotCls}"></span><div>${ago(r.lastAt)}<small>${fmtTime(r.lastAt)}</small></div></div>`
        : `<div class="last"><span class="dot idle"></span><div>${isToday ? 'Sin actividad hoy' : 'Sin actividad'}</div></div>`;
      const role = r.role === 'gerente' ? 'Gerente' : r.role === 'secretaria' ? 'Secretaria' : r.role;
      const cells = cols.map((c) => {
        if (c.kind === 'eff') {
          const e = effOf(r.totals);
          if (e === null) return '<td class="num"><span class="eff-na">—</span></td>';
          const pct = Math.round(e * 100);
          return `<td class="num"><div class="eff"><div class="eff-bar"><span style="width:${pct}%;background:${effColor(e)}"></span></div><span class="eff-val" style="color:${effColor(e)}">${pct}%</span></div></td>`;
        }
        const v = r.totals[c.key] || 0;
        return `<td class="num ${v ? '' : 'zero'}"${heat(v, maxes[c.key])}>${v}</td>`;
      }).join('');
      return `<tr class="person ${selectedId === r.id ? 'selected' : ''}" data-id="${r.id}">
        <td><div class="who"><span class="rank">${i + 1}</span><span class="avatar" style="background:${avatarColor(r.name)}">${escapeHtml(initials(r.name))}</span><div><div class="who-name">${escapeHtml(r.name)}</div><div class="who-meta"><span class="chip ${r.role === 'gerente' ? 'gerente' : ''}">${escapeHtml(role)}</span>${r.branches.length ? `<span class="branch">${escapeHtml(r.branches.join(', '))}</span>` : ''}</div></div></div></td>
        ${cells}
        <td class="num total">${r.total}</td>
        <td>${last}</td>
      </tr>`;
    }).join('');

    let sumRow = '';
    if (data.rows.length > 1) {
      const sums = {};
      data.rows.forEach((r) => Object.entries(r.totals).forEach(([k, v]) => { sums[k] = (sums[k] || 0) + v; }));
      const sumCells = cols.map((c) => {
        if (c.kind === 'eff') { const e = effOf(sums); return `<td class="num">${e === null ? '—' : Math.round(e * 100) + '%'}</td>`; }
        return `<td class="num">${sums[c.key] || 0}</td>`;
      }).join('');
      sumRow = `<tr class="sum"><td>Total</td>${sumCells}<td class="num total">${data.rows.reduce((a, r) => a + r.total, 0)}</td><td></td></tr>`;
    }
    table.innerHTML = `<thead>${groupRow}${headRow}</thead><tbody>${rows || '<tr><td colspan="99" class="pool-loading">No hay personas con ese filtro.</td></tr>'}${sumRow}</tbody>`;
    updatedEl.textContent = `${fmtDate(data.from)}${data.from !== data.to ? ' – ' + fmtDate(data.to) : ''} · actualizado ${new Date(data.generatedAt).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
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
    const metrics = visibleMetrics();
    detailTitle.textContent = `${r.name} · día por día`;
    const days = data.dates.slice().reverse();
    const maxes = {};
    metrics.forEach((m) => { maxes[m.key] = Math.max(0, ...days.map((d) => (r.perDay[d] || {})[m.key] || 0)); });
    const rows = days.map((d) => {
      const c = r.perDay[d] || {};
      const total = Object.values(c).reduce((a, b) => a + b, 0);
      return `<tr><td>${fmtDate(d)}</td>${metrics.map((m) => `<td class="num ${c[m.key] ? '' : 'zero'}"${heat(c[m.key] || 0, maxes[m.key])}>${c[m.key] || 0}</td>`).join('')}<td class="num total">${total}</td></tr>`;
    }).join('');
    detailTable.innerHTML = `<thead><tr class="cols" style="--top:0"><th style="top:0">Día</th>${metrics.map((m) => `<th class="num" style="top:0">${escapeHtml(m.label)}</th>`).join('')}<th class="num" style="top:0">Total</th></tr></thead><tbody>${rows}</tbody>`;
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
          table.innerHTML = `<tbody><tr><td class="pool-loading">No se pudo cargar (HTTP ${status})${body && body.error ? ': ' + escapeHtml(body.error) : ''}.</td></tr></tbody>`;
          return;
        }
        data = body;
        render();
      })
      .catch(() => { table.innerHTML = '<tbody><tr><td class="pool-loading">No se pudo cargar (revisa la conexión).</td></tr></tbody>'; })
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
  showEmptyChk.addEventListener('change', render);
  table.addEventListener('click', (e) => {
    const head = e.target.closest('th[data-sort]');
    if (head) {
      const k = head.getAttribute('data-sort');
      if (sortKey === k) sortDir = -sortDir;
      else { sortKey = k; sortDir = k === 'name' ? 1 : -1; }
      render();
      return;
    }
    const tr = e.target.closest('tr.person');
    if (!tr) return;
    selectedId = selectedId === tr.getAttribute('data-id') ? null : tr.getAttribute('data-id');
    render();
  });

  load();
  // "En tiempo real": se refresca solo cada minuto mientras la pestaña esté visible.
  setInterval(() => { if (!document.hidden) load(); }, 60000);
});
