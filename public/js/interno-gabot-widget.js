document.addEventListener('DOMContentLoaded', function () {
  const widget = document.getElementById('gabotWidget');
  const bubble = document.getElementById('gabotBubble');
  const badge = document.getElementById('gabotBadge');
  const panel = document.getElementById('gabotPanel');
  const closeBtn = document.getElementById('gabotClose');
  const messagesEl = document.getElementById('gabotMessages');
  const form = document.getElementById('gabotForm');
  const input = document.getElementById('gabotInput');
  if (!widget || !bubble) return;

  const myUserId = document.body.dataset.userId;
  let conversationId = null;
  let panelOpen = false;
  let lastMessageCount = 0;

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function fmtTime(iso) {
    return new Date(iso).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
  }

  function renderMessages(messages) {
    if (!messages.length) {
      messagesEl.innerHTML = '<div class="empty">GaBot todavía no te ha escrito.</div>';
      return;
    }
    const wasAtBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
    messagesEl.innerHTML = messages.map((m) => {
      const mine = m.senderId === myUserId;
      return `
        <div class="gabot-msg ${mine ? 'mine' : 'bot'}">
          ${escapeHtml(m.text)}
          <span class="gabot-msg-time">${fmtTime(m.createdAt)}</span>
        </div>
      `;
    }).join('');
    if (wasAtBottom || messages.length !== lastMessageCount) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    lastMessageCount = messages.length;
  }

  function loadMessages() {
    if (!conversationId) return;
    fetch('/api/messages?conversationId=' + encodeURIComponent(conversationId))
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data || !Array.isArray(data.messages)) return;
        renderMessages(data.messages);
      })
      .catch(() => {});
  }

  function markRead() {
    if (!conversationId) return;
    fetch('/api/conversations', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: conversationId, markRead: true }),
    })
      .then(() => {
        badge.style.display = 'none';
        bubble.classList.remove('pulse');
      })
      .catch(() => {});
  }

  function checkGabotConversation() {
    fetch('/api/conversations')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data || !Array.isArray(data.conversations)) return;
        const gabotConv = data.conversations.find((c) => c.isGabot);
        if (!gabotConv) {
          widget.style.display = 'none';
          return;
        }
        widget.style.display = 'flex';
        const isNewConversation = conversationId !== gabotConv.id;
        conversationId = gabotConv.id;
        if (gabotConv.unreadCount > 0) {
          badge.textContent = gabotConv.unreadCount > 99 ? '99+' : String(gabotConv.unreadCount);
          badge.style.display = 'flex';
          if (!panelOpen) bubble.classList.add('pulse');
        } else if (!panelOpen) {
          badge.style.display = 'none';
        }
        if (panelOpen && (isNewConversation || gabotConv.unreadCount > 0)) {
          loadMessages();
          if (panelOpen) markRead();
        }
      })
      .catch(() => {});
  }

  bubble.addEventListener('click', function () {
    panelOpen = !panelOpen;
    panel.style.display = panelOpen ? 'flex' : 'none';
    if (panelOpen) {
      bubble.classList.remove('pulse');
      loadMessages();
      markRead();
      setTimeout(() => input.focus(), 50);
    }
  });

  if (closeBtn) {
    closeBtn.addEventListener('click', function () {
      panelOpen = false;
      panel.style.display = 'none';
    });
  }

  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      const text = input.value.trim();
      if (!text || !conversationId) return;
      input.value = '';
      fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, text }),
      })
        .then(() => loadMessages())
        .catch(() => {});
    });
  }

  checkGabotConversation();
  setInterval(checkGabotConversation, 45000);
});
