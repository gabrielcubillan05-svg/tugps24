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
  // La lista se trae por partes: primero una página corta para que aparezca de inmediato y el
  // resto en segundo plano. Un token descarta respuestas viejas si el usuario cambió filtros.
  const FIRST_PAGE_SIZE = 150;
  const PAGE_SIZE = 500;
  let loadingRest = false;
  let loadToken = 0;

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

  // Los acuses de entrega/lectura de Meta quedan en el historial para diagnóstico, pero no
  // son mensajes de Andrés ni de Valentina: se muestran como una línea discreta.
  function isStatusNote(m) {
    return m.role === 'assistant' && typeof m.content === 'string' && m.content.startsWith('[Estado WhatsApp]');
  }

  function fmtMoney(n) {
    return '$' + Number(n || 0).toLocaleString('es-CO');
  }

  function renderList() {
    if (!allConversations.length) {
      conversationsList.innerHTML = loadingRest
        ? '<div class="empty">Cargando...</div>'
        : '<div class="empty">No hay conversaciones con esos filtros.</div>';
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
    `).join('') + (loadingRest ? '<div class="empty">Cargando más conversaciones...</div>' : '');
  }

  function listParams() {
    const params = new URLSearchParams();
    if (searchInput.value.trim()) params.set('q', searchInput.value.trim());
    if (agentFilter.value) params.set('agent', agentFilter.value);
    if (stageFilter.value) params.set('aiStage', stageFilter.value);
    return params;
  }

  async function fetchPage(params, offset, limit) {
    params.set('offset', String(offset));
    params.set('limit', String(limit));
    const res = await fetch('/api/whatsapp-conversations?' + params.toString());
    const data = await res.json().catch(() => ({}));
    if (!Array.isArray(data.conversations)) {
      throw new Error((data && data.error) || `respuesta ${res.status} del servidor`);
    }
    return data;
  }

  function loadList() {
    const token = ++loadToken;
    const silent = allConversations.length > 0;
    fetchPage(listParams(), 0, FIRST_PAGE_SIZE)
      .then((data) => {
        if (token !== loadToken) return;
        const total = Number(data.total) || data.conversations.length;
        allConversations = data.conversations;
        loadingRest = allConversations.length < total;
        renderList();
        if (loadingRest) loadRemaining(allConversations.length, token);
      })
      .catch((err) => {
        if (token !== loadToken || silent) return;
        conversationsList.innerHTML = `<div class="empty">No se pudo cargar: ${escapeHtml(err.message || 'revisa la conexión')}.</div>`;
      });
  }

  function loadRemaining(offset, token) {
    fetchPage(listParams(), offset, PAGE_SIZE)
      .then((data) => {
        if (token !== loadToken) return;
        const total = Number(data.total) || 0;
        allConversations = allConversations.concat(data.conversations);
        const next = offset + data.conversations.length;
        loadingRest = data.conversations.length > 0 && next < total;
        renderList();
        if (loadingRest) loadRemaining(next, token);
      })
      .catch(() => {
        if (token !== loadToken) return;
        loadingRest = false;
        renderList();
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
          ? data.history.map((m) => isStatusNote(m) ? `
            <div class="msg-status">${escapeHtml(String(m.content).replace('[Estado WhatsApp] ', 'WhatsApp: '))}${m.at ? ' · ' + fmtTime(m.at) : ''}</div>
          ` : `
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
