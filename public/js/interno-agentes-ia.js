document.addEventListener('DOMContentLoaded', function () {
  const agentsList = document.getElementById('agentsList');
  if (!agentsList) return;

  const usdToCopInput = document.getElementById('usdToCop');
  const inputPriceInput = document.getElementById('inputPrice');
  const outputPriceInput = document.getElementById('outputPrice');
  const saveCostConfigBtn = document.getElementById('saveCostConfigBtn');
  const costConfigResult = document.getElementById('costConfigResult');

  let agents = [];

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

  function renderAgents() {
    agentsList.innerHTML = agents.map((a) => `
      <div class="panel-card agent-card" data-key="${a.key}">
        <h2>${escapeHtml(a.label)}</h2>
        <div class="agent-usage-row">
          <div class="agent-usage-stat"><span class="n">${fmtTokens(a.usage.inputTokens)}</span><span class="l">Tokens de entrada</span></div>
          <div class="agent-usage-stat"><span class="n">${fmtTokens(a.usage.outputTokens)}</span><span class="l">Tokens de salida</span></div>
          <div class="agent-usage-stat"><span class="n">${fmtTokens(a.usage.calls)}</span><span class="l">Respuestas generadas</span></div>
          <div class="agent-usage-stat"><span class="n">${fmtUsd(a.cost.usd)}</span><span class="l">Costo (USD)</span></div>
          <div class="agent-usage-stat"><span class="n">${fmtCop(a.cost.cop)}</span><span class="l">Costo (COP)</span></div>
        </div>
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

  function loadAll() {
    fetch('/api/ai-agents')
      .then((res) => res.json())
      .then((data) => {
        if (!data || !Array.isArray(data.agents)) {
          agentsList.innerHTML = `<div class="empty">No se pudo cargar${data && data.error ? ': ' + escapeHtml(data.error) : ''}.</div>`;
          return;
        }
        agents = data.agents;
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
