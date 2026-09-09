document.addEventListener('DOMContentLoaded', function () {
  const conversationsList = document.getElementById('conversationsList');
  if (!conversationsList) return;

  const conversationThread = document.getElementById('conversationThread');
  const searchInput = document.getElementById('searchInput');
  const stageFilter = document.getElementById('stageFilter');

  let allLeads = [];
  let selectedId = null;
  let pollTimer = null;

  const STAGE_LABELS = {
    sin_iniciar: 'Sin iniciar',
    en_conversacion: 'En conversación',
    entregado: 'Entregado',
    escalado: 'Escalado',
  };

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

  function renderList() {
    if (!allLeads.length) {
      conversationsList.innerHTML = '<div class="empty">No hay conversaciones con esos filtros.</div>';
      return;
    }
    conversationsList.innerHTML = allLeads.map((l) => `
      <div class="conversation-row ${l.id === selectedId ? 'active' : ''}" data-id="${l.id}">
        <div class="name">${escapeHtml(l.name)}</div>
        <div class="meta">
          ${escapeHtml(l.phone)}${l.city ? ' · ' + escapeHtml(l.city) : ''}<br />
          ${STAGE_LABELS[l.aiStage] || l.aiStage} · ${fmtDate(l.lastInboundAt || l.createdAt)}
        </div>
      </div>
    `).join('');
  }

  function loadList() {
    const params = new URLSearchParams();
    if (searchInput.value.trim()) params.set('q', searchInput.value.trim());
    if (stageFilter.value) params.set('aiStage', stageFilter.value);

    fetch('/api/whatsapp-conversations?' + params.toString())
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!Array.isArray(data.leads)) {
          conversationsList.innerHTML = `<div class="empty">No se pudo cargar${data && data.error ? ': ' + escapeHtml(data.error) : ''}.</div>`;
          return;
        }
        allLeads = data.leads;
        renderList();
      })
      .catch(() => {
        conversationsList.innerHTML = '<div class="empty">No se pudo cargar (revisa la conexión).</div>';
      });
  }

  function loadThread(id, silent) {
    const lead = allLeads.find((l) => l.id === id);
    fetch('/api/whatsapp-conversations?id=' + encodeURIComponent(id))
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!Array.isArray(data.history)) {
          if (!silent) conversationThread.innerHTML = '<div class="empty">No se pudo cargar la conversación.</div>';
          return;
        }
        const header = lead ? `
          <div class="thread-header">
            <div class="name">${escapeHtml(lead.name)}</div>
            <div class="meta">
              ${escapeHtml(lead.phone)}${lead.city ? ' · ' + escapeHtml(lead.city) : ''}${lead.vehicleType ? ' · ' + escapeHtml(lead.vehicleType) : ''}
              · ${STAGE_LABELS[lead.aiStage] || lead.aiStage}
              ${lead.secretary ? ' · Asignado a: ' + escapeHtml(lead.secretary) : ''}
            </div>
          </div>
        ` : '';
        const wasAtBottom = conversationThread.scrollTop + conversationThread.clientHeight >= conversationThread.scrollHeight - 20;
        conversationThread.innerHTML = header + data.history.map((m) => `
          <div class="msg-bubble ${m.role === 'user' ? 'user' : 'assistant'}">
            <span class="who">${m.role === 'user' ? escapeHtml(lead ? lead.name : 'Cliente') : 'Andrés (IA)'}</span>
            ${escapeHtml(m.content)}
          </div>
        `).join('') || header + '<div class="empty">Todavía no hay mensajes.</div>';
        if (!silent || wasAtBottom) {
          conversationThread.scrollTop = conversationThread.scrollHeight;
        }
      })
      .catch(() => {
        if (!silent) conversationThread.innerHTML = '<div class="empty">No se pudo cargar la conversación.</div>';
      });
  }

  function selectConversation(id) {
    selectedId = id;
    renderList();
    loadThread(id, false);
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => loadThread(id, true), 8000);
  }

  conversationsList.addEventListener('click', function (e) {
    const row = e.target.closest('.conversation-row');
    if (!row) return;
    selectConversation(row.getAttribute('data-id'));
  });

  let debounceTimer;
  searchInput.addEventListener('input', function () {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(loadList, 250);
  });
  stageFilter.addEventListener('change', loadList);

  loadList();
  setInterval(loadList, 20000);
});
