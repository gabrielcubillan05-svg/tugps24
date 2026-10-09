document.addEventListener('DOMContentLoaded', function () {
  const agentsList = document.getElementById('agentsList');
  if (!agentsList) return;

  const usdToCopInput = document.getElementById('usdToCop');
  const inputPriceInput = document.getElementById('inputPrice');
  const outputPriceInput = document.getElementById('outputPrice');
  const saveCostConfigBtn = document.getElementById('saveCostConfigBtn');
  const costConfigResult = document.getElementById('costConfigResult');
  const retryTodayBtn = document.getElementById('retryTodayBtn');
  const retryTodayResult = document.getElementById('retryTodayResult');

  let agents = [];

  const periodButtons = document.querySelectorAll('.period-buttons [data-period]');
  const periodCustomRange = document.getElementById('periodCustomRange');
  const periodFrom = document.getElementById('periodFrom');
  const periodTo = document.getElementById('periodTo');
  const periodCustomBtn = document.getElementById('periodCustomBtn');
  const periodResult = document.getElementById('periodResult');

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function fmtCop(n) {
    return '$' + Math.round(n || 0).toLocaleString('es-CO');
  }

  function fmtUsd(n) {
    return '$' + (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  }

  function fmtTokens(n) {
    return Number(n || 0).toLocaleString('es-CO');
  }

  function renderResults(a) {
    if (!a.results) return '';
    const r = a.results;
    if (a.key === 'andres') {
      return `
        <div class="agent-usage-row">
          <div class="agent-usage-stat"><span class="n">${fmtTokens(r.total)}</span><span class="l">Leads por WhatsApp</span></div>
          <div class="agent-usage-stat"><span class="n">${fmtTokens(r.enConversacion)}</span><span class="l">En conversación</span></div>
          <div class="agent-usage-stat"><span class="n">${fmtTokens(r.concretados)}</span><span class="l">Concretados</span></div>
          <div class="agent-usage-stat"><span class="n">${fmtTokens(r.escalados)}</span><span class="l">Escalados</span></div>
          <div class="agent-usage-stat"><span class="n">${fmtTokens(r.sinInteres)}</span><span class="l">Sin interés</span></div>
          <div class="agent-usage-stat"><span class="n">${r.total ? Math.round((r.concretados / r.total) * 100) : 0}%</span><span class="l">% concretado</span></div>
        </div>
        <div class="agent-usage-row">
          <div class="agent-usage-stat"><span class="n">${fmtTokens(r.nuevosHoy || 0)}</span><span class="l">Leads nuevos hoy</span></div>
          <div class="agent-usage-stat"><span class="n">${fmtTokens(r.concretadosHoy || 0)}</span><span class="l">Concretados hoy</span></div>
          <div class="agent-usage-stat"><span class="n">${fmtTokens(r.conMaterial || 0)}</span><span class="l">Recibieron fotos/videos</span></div>
          <div class="agent-usage-stat"><span class="n">${fmtTokens(r.conMaterialHoy || 0)}</span><span class="l">Fotos/videos hoy</span></div>
          <div class="agent-usage-stat"><span class="n">${fmtTokens(r.sinMaterial || 0)}</span><span class="l">Conversaron sin material</span></div>
        </div>
      `;
    }
    return `
      <div class="agent-usage-row">
        <div class="agent-usage-stat"><span class="n">${fmtTokens(r.total)}</span><span class="l">Cobros</span></div>
        <div class="agent-usage-stat"><span class="n">${fmtTokens(r.enConversacion)}</span><span class="l">En conversación</span></div>
        <div class="agent-usage-stat"><span class="n">${fmtTokens(r.acuerdo)}</span><span class="l">Acuerdos de pago</span></div>
        <div class="agent-usage-stat"><span class="n">${fmtTokens(r.escalado)}</span><span class="l">Escalados</span></div>
        <div class="agent-usage-stat"><span class="n">${fmtCop(r.deudaEnAcuerdo)}</span><span class="l">Deuda en acuerdo</span></div>
        <div class="agent-usage-stat"><span class="n">${r.total ? Math.round((r.acuerdo / r.total) * 100) : 0}%</span><span class="l">% con acuerdo</span></div>
      </div>
    `;
  }

  let conversationsSince = null;

  function fmtDayMonth(iso) {
    return iso ? iso.split('-').reverse().join('/') : '';
  }

  // Cada agente atiende por canales distintos: Andrés por WhatsApp y chat web, Valentina
  // solo por WhatsApp, GPSITO por el chat del panel. Se muestra lo que aplica a cada uno.
  function renderConversationStats(usage, agentKey) {
    const c = (usage && usage.conversations) || { whatsapp: 0, web: 0, panel: 0 };
    const stats = [];
    if (agentKey === 'gabot') {
      stats.push([c.panel, 'Conversaciones atendidas']);
    } else {
      stats.push([c.whatsapp, 'Conversaciones de WhatsApp']);
      if (agentKey === 'andres') stats.push([c.web, 'Conversaciones por chat web']);
    }
    return stats.map(([n, label]) => `<div class="agent-usage-stat"><span class="n">${fmtTokens(n)}</span><span class="l">${label}</span></div>`).join('');
  }

  function renderAgents() {
    agentsList.innerHTML = agents.map((a) => `
      <div class="panel-card agent-card" data-key="${a.key}">
        <h2>${escapeHtml(a.label)}</h2>
        <h3 class="agent-section-label">Resultados</h3>
        ${renderResults(a)}
        <h3 class="agent-section-label">Costo</h3>
        <div class="agent-usage-row">
          <div class="agent-usage-stat"><span class="n">${fmtTokens(a.usage.inputTokens)}</span><span class="l">Tokens de entrada</span></div>
          <div class="agent-usage-stat"><span class="n">${fmtTokens(a.usage.cacheReadTokens || 0)}</span><span class="l">Leídos de caché (10 % del precio)</span></div>
          <div class="agent-usage-stat"><span class="n">${fmtTokens(a.usage.outputTokens)}</span><span class="l">Tokens de salida</span></div>
          <div class="agent-usage-stat"><span class="n">${fmtTokens(a.usage.calls)}</span><span class="l">Respuestas generadas</span></div>
          ${renderConversationStats(a.usage, a.key)}
          <div class="agent-usage-stat"><span class="n">${fmtUsd(a.cost.usd)}</span><span class="l">Costo (USD)</span></div>
          <div class="agent-usage-stat"><span class="n">${fmtCop(a.cost.cop)}</span><span class="l">Costo (COP)</span></div>
        </div>
        ${conversationsSince ? `<p class="hint">Las conversaciones se cuentan desde el ${fmtDayMonth(conversationsSince)}; los tokens y respuestas vienen de antes.</p>` : ''}
        <div class="agent-instructions">
          <label>Instrucciones adicionales para ${escapeHtml(a.label)}</label>
          <textarea data-role="instructions" placeholder="Ej: menciona también que ahora aceptamos pago con tarjeta...">${escapeHtml(a.extraInstructions)}</textarea>
          <div class="agent-instructions-actions">
            <button class="btn-small" data-action="save-instructions" type="button">Guardar instrucciones</button>
            <button class="btn-small" data-action="reset-usage" type="button">Reiniciar contador de costo</button>
            <span class="hint agent-save-result" style="margin:0;"></span>
          </div>
        </div>
      </div>
    `).join('');
  }

  function fmtDateOnly(d) {
    return d.toISOString().slice(0, 10);
  }

  function renderPeriodResult(agentsData, trackingSince, from) {
    if (!agentsData.length || !agentsData[0].rangeUsage) {
      periodResult.innerHTML = '';
      return;
    }
    const warning = (trackingSince && from < trackingSince
      ? `<p class="hint" style="color:var(--amber);">⚠️ El desglose por día solo existe desde el ${fmtDayMonth(trackingSince)} — los días antes de esa fecha no están contados aquí, así que este total sale incompleto.</p>`
      : '') + (conversationsSince && from < conversationsSince
      ? `<p class="hint" style="color:var(--amber);">⚠️ Las conversaciones se cuentan desde el ${fmtDayMonth(conversationsSince)} — los días anteriores salen en cero en esa cifra.</p>`
      : '');
    periodResult.innerHTML = warning + agentsData.map((a) => `
      <div class="period-agent-row">
        <span class="title">${escapeHtml(a.label)}</span>
        <div class="agent-usage-row">
          <div class="agent-usage-stat"><span class="n">${fmtTokens(a.rangeUsage.inputTokens)}</span><span class="l">Tokens de entrada</span></div>
          <div class="agent-usage-stat"><span class="n">${fmtTokens(a.rangeUsage.cacheReadTokens || 0)}</span><span class="l">Leídos de caché (10 % del precio)</span></div>
          <div class="agent-usage-stat"><span class="n">${fmtTokens(a.rangeUsage.outputTokens)}</span><span class="l">Tokens de salida</span></div>
          <div class="agent-usage-stat"><span class="n">${fmtTokens(a.rangeUsage.calls)}</span><span class="l">Respuestas generadas</span></div>
          ${renderConversationStats(a.rangeUsage, a.key)}
          <div class="agent-usage-stat"><span class="n">${fmtUsd(a.rangeCost.usd)}</span><span class="l">Costo (USD)</span></div>
          <div class="agent-usage-stat"><span class="n">${fmtCop(a.rangeCost.cop)}</span><span class="l">Costo (COP)</span></div>
        </div>
      </div>
    `).join('');
  }

  function loadPeriod(from, to) {
    periodResult.innerHTML = '<div class="empty">Consultando...</div>';
    fetch(`/api/ai-agents?from=${from}&to=${to}`)
      .then((res) => res.json())
      .then((data) => {
        if (!data || !Array.isArray(data.agents)) {
          periodResult.innerHTML = '<div class="empty">No se pudo cargar.</div>';
          return;
        }
        if (data.conversationsSince) conversationsSince = data.conversationsSince;
        renderPeriodResult(data.agents, data.trackingSince, from);
      })
      .catch(() => {
        periodResult.innerHTML = '<div class="empty">No se pudo cargar (revisa la conexión).</div>';
      });
  }

  periodButtons.forEach((btn) => {
    btn.addEventListener('click', function () {
      periodButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const period = btn.getAttribute('data-period');
      if (period === 'custom') {
        periodCustomRange.hidden = false;
        return;
      }
      periodCustomRange.hidden = true;
      const today = new Date();
      let from = today;
      if (period === 'semana') {
        from = new Date(today);
        from.setDate(from.getDate() - 6);
      } else if (period === 'mes') {
        from = new Date(today.getFullYear(), today.getMonth(), 1);
      }
      loadPeriod(fmtDateOnly(from), fmtDateOnly(today));
    });
  });

  if (periodCustomBtn) periodCustomBtn.addEventListener('click', function () {
    if (!periodFrom.value || !periodTo.value) return;
    loadPeriod(periodFrom.value, periodTo.value);
  });

  function loadAll() {
    fetch('/api/ai-agents')
      .then(async (res) => ({ status: res.status, data: await res.json().catch(() => null) }))
      .then(({ status, data }) => {
        if (!data || !Array.isArray(data.agents)) {
          // Con el código HTTP a la vista se sabe si fue permiso (401), servidor (500) o red.
          agentsList.innerHTML = `<div class="empty">No se pudo cargar (HTTP ${status})${data && data.error ? ': ' + escapeHtml(data.error) : ''}.</div>`;
          return;
        }
        agents = data.agents;
        conversationsSince = data.conversationsSince || null;
        if (data.costConfig) {
          usdToCopInput.value = data.costConfig.usdToCop;
          inputPriceInput.value = data.costConfig.inputPricePerMTokUsd;
          outputPriceInput.value = data.costConfig.outputPricePerMTokUsd;
        }
        renderAgents();
      })
      .catch(() => {
        agentsList.innerHTML = '<div class="empty">No se pudo cargar (revisa la conexión).</div>';
      });
  }

  saveCostConfigBtn.addEventListener('click', function () {
    costConfigResult.textContent = 'Guardando...';
    fetch('/api/ai-agents', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'setCostConfig',
        usdToCop: Number(usdToCopInput.value),
        inputPricePerMTokUsd: Number(inputPriceInput.value),
        outputPricePerMTokUsd: Number(outputPriceInput.value),
      }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo guardar.');
        costConfigResult.textContent = 'Guardado.';
        loadAll();
      })
      .catch((err) => {
        costConfigResult.textContent = err.message || 'No se pudo guardar.';
      });
  });

  // --- Aviso de promoción por sucursal ---
  const promoNoticeSince = document.getElementById('promoNoticeSince');
  const promoNoticeSimulateBtn = document.getElementById('promoNoticeSimulateBtn');
  const promoNoticeSendBtn = document.getElementById('promoNoticeSendBtn');
  const promoNoticeResult = document.getElementById('promoNoticeResult');
  if (promoNoticeSince && !promoNoticeSince.value) {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    promoNoticeSince.value = fmtDateOnly(y);
  }

  function renderPromoNotice(d) {
    if (d.reason === 'quiet-hours') {
      promoNoticeResult.textContent = 'No se envió nada: son horas de silencio (11pm–6am Colombia). Intenta de nuevo en el día.';
      return;
    }
    const promos = (d.promos || []).map((p) => `${escapeHtml(p.label)}: ${fmtCop(p.price)} en ${p.branches.map(escapeHtml).join(' y ')} hasta el ${escapeHtml(p.until)}`).join('<br />');
    const outList = (d.outOfWindow || []).map((o) => `<li>${escapeHtml(o.name)} · ${escapeHtml(o.phone)} · ${escapeHtml(o.branch)}${o.secretary ? ' · ' + escapeHtml(o.secretary) : ''}</li>`).join('');
    promoNoticeResult.innerHTML = `
      <div>${promos}</div>
      <p style="margin:10px 0 4px;"><b>${d.dryRun ? 'Simulación' : 'Envío'}:</b>
        ${d.dryRun ? `${d.eligible} lead(s) recibirían el aviso ahora` : `${d.sent} enviado(s), ${d.failed} fallido(s)`}
        · ${d.alreadyNotified} ya avisado(s) antes
        · ${(d.outOfWindow || []).length} fuera de la ventana de 24 h.</p>
      ${d.dryRun && d.eligibleNames && d.eligibleNames.length ? `<p class="hint">Recibirían: ${d.eligibleNames.map(escapeHtml).join(', ')}</p>` : ''}
      ${d.sampleMessage ? `<p class="hint">Mensaje: “${escapeHtml(d.sampleMessage)}”</p>` : ''}
      ${d.failures && d.failures.length ? `<p class="hint" style="color:var(--danger);">Fallidos: ${d.failures.map(escapeHtml).join(' · ')}</p>` : ''}
      ${outList ? `<p style="margin:10px 0 4px;">Para contactar a mano (no escribieron en las últimas 24 h):</p><ul class="hint" style="margin:0; padding-left:18px;">${outList}</ul>` : ''}
    `;
  }

  function runPromoNotice(dryRun) {
    if (!promoNoticeSince.value) return;
    if (!dryRun && !confirm('¿Enviar el aviso de promoción por WhatsApp a todos los leads que aplican? Esto manda mensajes reales de Andrés.')) return;
    promoNoticeSimulateBtn.disabled = true;
    promoNoticeSendBtn.disabled = true;
    promoNoticeResult.textContent = dryRun ? 'Calculando...' : 'Enviando...';
    fetch('/api/whatsapp-promo-notice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dryRun, since: promoNoticeSince.value }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo ejecutar.');
        renderPromoNotice(data);
      })
      .catch((err) => {
        promoNoticeResult.textContent = err.message || 'No se pudo ejecutar.';
      })
      .finally(() => {
        promoNoticeSimulateBtn.disabled = false;
        promoNoticeSendBtn.disabled = false;
      });
  }

  if (promoNoticeSimulateBtn) promoNoticeSimulateBtn.addEventListener('click', () => runPromoNotice(true));
  if (promoNoticeSendBtn) promoNoticeSendBtn.addEventListener('click', () => runPromoNotice(false));

  if (retryTodayBtn) retryTodayBtn.addEventListener('click', function () {
    if (!confirm('¿Enviar un mensaje real de Andrés a todos los leads de hoy que siguen esperando respuesta? Esto envía WhatsApp de verdad.')) return;
    retryTodayBtn.disabled = true;
    retryTodayResult.style.display = 'block';
    retryTodayResult.textContent = 'Enviando...';
    fetch('/api/whatsapp-retry-today', { method: 'POST' })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo reintentar.');
        if (data.reason === 'quiet-hours') {
          retryTodayResult.textContent = 'No se envió nada: son horas de silencio (11pm–6am Colombia). Intenta de nuevo en el día.';
        } else {
          retryTodayResult.textContent = `${data.sent} mensaje(s) enviados, ${data.skipped} omitidos (ya tenían respuesta), ${data.failed} fallidos.` + (data.retried && data.retried.length ? ` Se les escribió a: ${data.retried.join('; ')}.` : '');
        }
      })
      .catch((err) => {
        retryTodayResult.textContent = err.message || 'No se pudo reintentar.';
      })
      .finally(() => { retryTodayBtn.disabled = false; });
  });

  // --- Calendario mensual de Andrés ---
  const calGrid = document.getElementById('calGrid');
  if (calGrid) {
    const calTotals = document.getElementById('calTotals');
    const calMonthLabel = document.getElementById('calMonthLabel');
    const DOW = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    let calMonth = null;
    const calBranch = document.getElementById('calBranch');

    function shiftMonth(month, delta) {
      const [y, m] = month.split('-').map((v) => parseInt(v, 10));
      const d = new Date(Date.UTC(y, m - 1 + delta, 1));
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    }

    function loadCalendar(month) {
      calGrid.innerHTML = '<div class="empty">Cargando...</div>';
      const params = new URLSearchParams();
      if (month) params.set('month', month);
      if (calBranch && calBranch.value) params.set('branch', calBranch.value);
      const qs = params.toString();
      fetch('/api/andres-calendario' + (qs ? '?' + qs : ''))
        .then(async (res) => ({ status: res.status, data: await res.json().catch(() => null) }))
        .then(({ status, data }) => {
          if (!data || !Array.isArray(data.days)) {
            calGrid.innerHTML = `<div class="empty">No se pudo cargar (HTTP ${status})${data && data.error ? ': ' + escapeHtml(data.error) : ''}.</div>`;
            return;
          }
          calMonth = data.month;
          // El gasto en Anthropic no se reparte por sucursal: con filtro no se muestra.
          const filtered = !!data.branch;
          const [y, m] = data.month.split('-').map((v) => parseInt(v, 10));
          calMonthLabel.textContent = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('es-CO', { month: 'long', year: 'numeric', timeZone: 'UTC' });
          // La semana empieza en lunes.
          const order = [1, 2, 3, 4, 5, 6, 0];
          let html = order.map((d) => `<div class="cal-dow">${DOW[d]}</div>`).join('');
          const lead = (data.firstWeekday + 6) % 7;
          for (let i = 0; i < lead; i++) html += '<div class="cal-day empty-day"></div>';
          html += data.days.map((d) => {
            const isToday = d.date === data.today;
            const isFuture = d.date > data.today;
            return `
              <div class="cal-day ${isToday ? 'today' : ''} ${isFuture ? 'future' : ''}" title="${d.date}">
                <div class="d">${parseInt(d.date.slice(8), 10)}</div>
                ${isFuture ? '' : `
                  <div class="v"><span>Atend.</span><span class="a">${d.atendidos}</span></div>
                  <div class="v"><span>Nuevos</span><span class="n">${d.nuevos}</span></div>
                  <div class="v"><span>Concr.</span><span class="c">${d.concretados}</span></div>
                  ${filtered ? '' : `<div class="v cost"><span>Gasto</span><span>${d.cop ? '$' + Math.round(d.cop).toLocaleString('es-CO') : '—'}</span></div>`}`}
              </div>`;
          }).join('');
          calGrid.innerHTML = html;
          const t = data.totals || {};
          const rate = t.nuevos ? Math.round((t.concretados / t.nuevos) * 100) : 0;
          calTotals.innerHTML = `
            <span>Atendidos: <b style="color:#3b82f6">${fmtTokens(t.atendidos || 0)}</b></span>
            <span>Leads nuevos: <b style="color:#f59e0b">${fmtTokens(t.nuevos || 0)}</b></span>
            <span>Concretados: <b style="color:#22c55e">${fmtTokens(t.concretados || 0)}</b></span>
            <span>Escalados: <b>${fmtTokens(t.escalados || 0)}</b></span>
            <span>% concretado sobre nuevos: <b>${rate}%</b></span>
            ${filtered ? '<span style="color:var(--slate)">El gasto solo se muestra con todas las sucursales.</span>' : `<span>Gasto del mes: <b>$${Math.round(t.cop || 0).toLocaleString('es-CO')} COP</b> · ${(t.usd || 0).toFixed(2)} USD</span>`}`;
        })
        .catch(() => { calGrid.innerHTML = '<div class="empty">No se pudo cargar (revisa la conexión).</div>'; });
    }

    if (calBranch) calBranch.addEventListener('change', () => loadCalendar(calMonth));
    document.getElementById('calPrevBtn').addEventListener('click', () => loadCalendar(shiftMonth(calMonth, -1)));
    document.getElementById('calNextBtn').addEventListener('click', () => loadCalendar(shiftMonth(calMonth, 1)));
    loadCalendar(null);
  }

  agentsList.addEventListener('click', function (e) {
    const card = e.target.closest('.agent-card');
    if (!card) return;
    const key = card.getAttribute('data-key');
    const resultEl = card.querySelector('.agent-save-result');

    const saveBtn = e.target.closest('button[data-action="save-instructions"]');
    if (saveBtn) {
      const textarea = card.querySelector('textarea[data-role="instructions"]');
      resultEl.textContent = 'Guardando...';
      fetch('/api/ai-agents', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'setInstructions', agent: key, text: textarea.value }),
      })
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'No se pudo guardar.');
          resultEl.textContent = 'Guardado — ya aplica en el próximo mensaje.';
        })
        .catch((err) => {
          resultEl.textContent = err.message || 'No se pudo guardar.';
        });
      return;
    }

    const resetBtn = e.target.closest('button[data-action="reset-usage"]');
    if (resetBtn) {
      if (!confirm('¿Reiniciar el contador de costo de este agente a cero?')) return;
      resultEl.textContent = 'Reiniciando...';
      fetch('/api/ai-agents', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resetUsage', agent: key }),
      })
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'No se pudo reiniciar.');
          resultEl.textContent = 'Reiniciado.';
          loadAll();
        })
        .catch((err) => {
          resultEl.textContent = err.message || 'No se pudo reiniciar.';
        });
    }
  });

  loadAll();
});
