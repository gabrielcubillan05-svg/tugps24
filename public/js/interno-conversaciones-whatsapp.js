document.addEventListener('DOMContentLoaded', function () {
  const conversationsList = document.getElementById('conversationsList');
  if (!conversationsList) return;

  const conversationThread = document.getElementById('conversationThread');
  const searchInput = document.getElementById('searchInput');
  const agentFilter = document.getElementById('agentFilter');
  const stageFilter = document.getElementById('stageFilter');

  let allConversations = [];
  let selectedKey = null;
  let pollTimer = null;

  const STAGE_LABELS = {
    sin_iniciar: 'Sin iniciar',
    en_conversacion: 'En conversación',
    entregado: 'Entregado',
    acuerdo: 'Acuerdo de pago',
    escalado: 'Escalado',
  };

  const AGENT_LABELS = { andres: 'Andrés (ventas)', valentina: 'Valentina (cobranza)' };

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function fmtDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });
  }

  function fmtTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit' });
  }

  function fmtMoney(n) {
    return '$' + Number(n || 0).toLocaleString('es-CO');
  }

  function renderList() {
    if (!allConversations.length) {
      conversationsList.innerHTML = '<div class="empty">No hay conversaciones con esos filtros.</div>';
      return;
    }
    conversationsList.innerHTML = allConversations.map((c) => `
      <div class="conversation-row ${c.key === selectedKey ? 'active' : ''}" data-key="${c.key}">
        <div class="name">${escapeHtml(c.name)} <span class="agent-tag agent-${c.agent}">${c.agent === 'andres' ? 'Andrés' : 'Valentina'}</span></div>
        <div class="meta">
          ${escapeHtml(c.phone)}${c.city ? ' · ' + escapeHtml(c.city) : ''}${c.deuda ? ' · ' + fmtMoney(c.deuda) : ''}<br />
          ${STAGE_LABELS[c.aiStage] || c.aiStage} · ${fmtDate(c.lastInboundAt || c.createdAt)}
        </div>
      </div>
    `).join('');
  }

  function loadList() {
    const params = new URLSearchParams();
    if (searchInput.value.trim()) params.set('q', searchInput.value.trim());
    if (agentFilter.value) params.set('agent', agentFilter.value);
    if (stageFilter.value) params.set('aiStage', stageFilter.value);

    fetch('/api/whatsapp-conversations?' + params.toString())
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!Array.isArray(data.conversations)) {
          conversationsList.innerHTML = `<div class="empty">No se pudo cargar${data && data.error ? ': ' + escapeHtml(data.error) : ''}.</div>`;
          return;
        }
        allConversations = data.conversations;
        renderList();
      })
      .catch(() => {
        conversationsList.innerHTML = '<div class="empty">No se pudo cargar (revisa la conexión).</div>';
      });
  }

  function loadThread(key, silent) {
    const conv = allConversations.find((c) => c.key === key);
    if (!conv) return;
    fetch('/api/whatsapp-conversations?id=' + encodeURIComponent(conv.id) + '&agent=' + encodeURIComponent(conv.agent))
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!Array.isArray(data.history)) {
          if (!silent) conversationThread.innerHTML = '<div class="empty">No se pudo cargar la conversación.</div>';
          return;
        }
        const header = `
          <div class="thread-header">
            <div class="name">${escapeHtml(conv.name)} <span class="agent-tag agent-${conv.agent}">${AGENT_LABELS[conv.agent]}</span></div>
            <div class="meta">
              ${escapeHtml(conv.phone)}${conv.city ? ' · ' + escapeHtml(conv.city) : ''}${conv.vehicleType ? ' · ' + escapeHtml(conv.vehicleType) : ''}${conv.deuda ? ' · ' + fmtMoney(conv.deuda) : ''}
              · ${STAGE_LABELS[conv.aiStage] || conv.aiStage}
              ${conv.secretary ? ' · Asignado a: ' + escapeHtml(conv.secretary) : ''}
            </div>
          </div>
        `;
        const agentName = conv.agent === 'valentina' ? 'Valentina (IA)' : 'Andrés (IA)';
        const wasAtBottom = conversationThread.scrollTop + conversationThread.clientHeight >= conversationThread.scrollHeight - 20;
        const body = data.history.length
          ? data.history.map((m) => `
            <div class="msg-bubble ${m.role === 'user' ? 'user' : 'assistant'}">
              <span class="who">${m.role === 'user' ? escapeHtml(conv.name || 'Cliente') : agentName}${m.at ? ' · ' + fmtTime(m.at) : ''}</span>
              ${escapeHtml(m.content)}
            </div>
          `).join('')
          : '<div class="empty">Todavía no hay mensajes.</div>';
        conversationThread.innerHTML = header + body;
        if (!silent || wasAtBottom) {
          conversationThread.scrollTop = conversationThread.scrollHeight;
        }
      })
      .catch(() => {
        if (!silent) conversationThread.innerHTML = '<div class="empty">No se pudo cargar la conversación.</div>';
      });
  }

  function selectConversation(key) {
    selectedKey = key;
    renderList();
    loadThread(key, false);
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => loadThread(key, true), 8000);
  }

  conversationsList.addEventListener('click', function (e) {
    const row = e.target.closest('.conversation-row');
    if (!row) return;
    selectConversation(row.getAttribute('data-key'));
  });

  let debounceTimer;
  searchInput.addEventListener('input', function () {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(loadList, 250);
  });
  agentFilter.addEventListener('change', loadList);
  stageFilter.addEventListener('change', loadList);

  loadList();
  setInterval(loadList, 20000);
});
