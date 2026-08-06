document.addEventListener('DOMContentLoaded', function () {
  const conversationList = document.getElementById('conversationList');
  if (!conversationList) return;

  const myUserId = document.body.dataset.userId;
  const chatHeader = document.getElementById('chatHeader');
  const messagesArea = document.getElementById('messagesArea');
  const messageForm = document.getElementById('messageForm');
  const messageInput = document.getElementById('messageInput');
  const emojiBtn = document.getElementById('emojiBtn');
  const emojiPanel = document.getElementById('emojiPanel');

  const newDmBtn = document.getElementById('newDmBtn');
  const dmModalOverlay = document.getElementById('dmModalOverlay');
  const dmUserSelect = document.getElementById('dmUserSelect');
  const dmStartBtn = document.getElementById('dmStartBtn');
  const dmCancelBtn = document.getElementById('dmCancelBtn');

  const newGroupBtn = document.getElementById('newGroupBtn');
  const groupModalOverlay = document.getElementById('groupModalOverlay');
  const groupNameInput = document.getElementById('groupNameInput');
  const groupMembersList = document.getElementById('groupMembersList');
  const groupCreateBtn = document.getElementById('groupCreateBtn');
  const groupCancelBtn = document.getElementById('groupCancelBtn');
  const groupError = document.getElementById('groupError');

  let employees = [];
  let conversations = [];
  let activeConversationId = null;
  let activeConversationName = '';

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function fmtTime(iso) {
    return new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });
  }

  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/);
    const chars = parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2);
    return chars.toUpperCase();
  }

  function loadEmployees() {
    return fetch('/api/users')
      .then((res) => res.json())
      .then((data) => {
        if (data && Array.isArray(data.users)) {
          employees = data.users.filter((u) => u.id !== myUserId);
        }
      })
      .catch(() => {});
  }

  function renderConversations() {
    if (!conversations.length) {
      conversationList.innerHTML = '<div class="empty">Sin conversaciones todavía.</div>';
      return;
    }
    conversationList.innerHTML = conversations.map((c) => `
      <div class="conv-item ${c.id === activeConversationId ? 'active' : ''}" data-id="${c.id}">
        <span class="avatar ${c.type === 'group' ? 'avatar-group' : ''}">${escapeHtml(initials(c.displayName))}</span>
        <div class="conv-info">
          <div class="conv-name">${escapeHtml(c.displayName || 'Sin nombre')}</div>
          <div class="conv-preview">${escapeHtml(c.lastMessagePreview || 'Sin mensajes')}</div>
        </div>
        ${c.unreadCount ? `<span class="nav-badge">${c.unreadCount > 99 ? '99+' : c.unreadCount}</span>` : ''}
      </div>
    `).join('');
  }

  function loadConversations() {
    return fetch('/api/conversations')
      .then((res) => res.json())
      .then((data) => {
        if (data && Array.isArray(data.conversations)) {
          conversations = data.conversations;
          renderConversations();
        }
      })
      .catch(() => {});
  }

  function checkMarkFor(message, conversation) {
    if (!conversation) return '';
    const others = conversation.memberIds.filter((id) => id !== myUserId);
    const readByAll = others.length > 0 && others.every((id) => {
      const lastRead = conversation.lastRead && conversation.lastRead[id];
      return lastRead && lastRead >= message.createdAt;
    });
    return `<span class="msg-check ${readByAll ? 'read' : ''}">${readByAll ? '✓✓' : '✓'}</span>`;
  }

  function renderMessages(messages) {
    const conversation = conversations.find((c) => c.id === activeConversationId);
    const isGroup = conversation && conversation.type === 'group';
    const wasAtBottom = messagesArea.scrollHeight - messagesArea.scrollTop - messagesArea.clientHeight < 40;
    messagesArea.innerHTML = messages.map((m) => {
      const mine = m.senderId === myUserId;
      const showAvatar = !mine && isGroup;
      return `
      <div class="msg ${mine ? 'mine' : 'theirs'}">
        ${showAvatar ? `<span class="avatar avatar-sm">${escapeHtml(initials(m.senderName))}</span>` : ''}
        <div class="msg-body">
          ${!mine && isGroup ? `<span class="msg-sender">${escapeHtml(m.senderName)}</span>` : ''}
          ${escapeHtml(m.text)}
          <span class="msg-time">${fmtTime(m.createdAt)}${mine ? ' ' + checkMarkFor(m, conversation) : ''}</span>
        </div>
      </div>
    `;
    }).join('');
    if (wasAtBottom || messages.length <= 20) {
      messagesArea.scrollTop = messagesArea.scrollHeight;
    }
  }

  function loadMessages(conversationId) {
    return fetch('/api/messages?conversationId=' + encodeURIComponent(conversationId))
      .then((res) => res.json())
      .then((data) => {
        if (data && Array.isArray(data.messages)) renderMessages(data.messages);
      })
      .catch(() => {});
  }

  function openConversation(id, name) {
    activeConversationId = id;
    activeConversationName = name;
    chatHeader.textContent = name;
    messageForm.style.display = 'flex';
    renderConversations();
    loadMessages(id);
    fetch('/api/conversations', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, markRead: true }),
    })
      .then(() => {
        const conv = conversations.find((c) => c.id === id);
        if (conv) conv.unreadCount = 0;
        renderConversations();
      })
      .catch(() => {});
  }

  conversationList.addEventListener('click', function (e) {
    const item = e.target.closest('.conv-item');
    if (!item) return;
    const id = item.getAttribute('data-id');
    const conv = conversations.find((c) => c.id === id);
    openConversation(id, conv ? conv.displayName : 'Conversación');
  });

  messageForm.addEventListener('submit', function (e) {
    e.preventDefault();
    const text = messageInput.value.trim();
    if (!text || !activeConversationId) return;
    messageInput.value = '';
    fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: activeConversationId, text }),
    })
      .then(() => {
        loadMessages(activeConversationId);
        loadConversations();
      })
      .catch(() => alert('No se pudo enviar el mensaje.'));
  });

  // ---------- Emojis ----------
  const EMOJIS = [
    '😀', '😄', '😁', '😂', '🙂', '😉', '😊', '😍', '🤔', '😐',
    '😴', '😢', '😭', '😡', '😱', '😅', '🙌', '👏', '👍', '👎',
    '🙏', '💪', '👌', '✌️', '🤝', '❤️', '🔥', '⭐', '✅', '❌',
    '⚠️', '📌', '📷', '🚗', '🏍️', '📍', '⏰', '📅', '🎉', '☕',
  ];
  if (emojiBtn && emojiPanel) {
    let emojiPanelBuilt = false;
    emojiBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!emojiPanelBuilt) {
        emojiPanel.innerHTML = EMOJIS.map((em) => `<button type="button" data-emoji="${em}">${em}</button>`).join('');
        emojiPanelBuilt = true;
      }
      emojiPanel.style.display = emojiPanel.style.display === 'none' ? 'grid' : 'none';
    });
    emojiPanel.addEventListener('click', function (e) {
      const btn = e.target.closest('button[data-emoji]');
      if (!btn) return;
      messageInput.value += btn.getAttribute('data-emoji');
      messageInput.focus();
    });
    document.addEventListener('click', function (e) {
      if (emojiPanel.style.display !== 'none' && !emojiPanel.contains(e.target) && e.target !== emojiBtn) {
        emojiPanel.style.display = 'none';
      }
    });
  }

  // ---------- Nuevo mensaje (DM) ----------
  newDmBtn.addEventListener('click', function () {
    dmUserSelect.innerHTML = employees.length
      ? employees.map((u) => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('')
      : '<option value="">No hay empleados disponibles</option>';
    dmModalOverlay.style.display = 'flex';
  });
  dmCancelBtn.addEventListener('click', function () {
    dmModalOverlay.style.display = 'none';
  });
  dmModalOverlay.addEventListener('click', function (e) {
    if (e.target === dmModalOverlay) dmModalOverlay.style.display = 'none';
  });
  dmStartBtn.addEventListener('click', function () {
    const otherUserId = dmUserSelect.value;
    if (!otherUserId) return;
    fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'dm', otherUserId }),
    })
      .then((res) => res.json())
      .then((data) => {
        dmModalOverlay.style.display = 'none';
        return loadConversations().then(() => {
          if (data && data.conversation) {
            const conv = conversations.find((c) => c.id === data.conversation.id);
            openConversation(data.conversation.id, conv ? conv.displayName : 'Conversación');
          }
        });
      })
      .catch(() => alert('No se pudo iniciar la conversación.'));
  });

  // ---------- Nuevo grupo ----------
  newGroupBtn.addEventListener('click', function () {
    groupError.style.display = 'none';
    groupNameInput.value = '';
    groupMembersList.innerHTML = employees.length
      ? employees.map((u) => `
          <label><input type="checkbox" class="group-member-check" value="${u.id}" /> ${escapeHtml(u.name)}</label>
        `).join('')
      : '<p class="empty">No hay empleados disponibles.</p>';
    groupModalOverlay.style.display = 'flex';
  });
  groupCancelBtn.addEventListener('click', function () {
    groupModalOverlay.style.display = 'none';
  });
  groupModalOverlay.addEventListener('click', function (e) {
    if (e.target === groupModalOverlay) groupModalOverlay.style.display = 'none';
  });
  groupCreateBtn.addEventListener('click', function () {
    const name = groupNameInput.value.trim();
    const memberIds = Array.from(groupMembersList.querySelectorAll('.group-member-check:checked')).map((el) => el.value);
    if (!name || !memberIds.length) {
      groupError.textContent = 'Ponle un nombre al grupo y selecciona al menos un miembro.';
      groupError.style.display = 'block';
      return;
    }
    fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'group', name, memberIds }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo crear el grupo.');
        groupModalOverlay.style.display = 'none';
        return loadConversations().then(() => {
          if (data && data.conversation) {
            const conv = conversations.find((c) => c.id === data.conversation.id);
            openConversation(data.conversation.id, conv ? conv.displayName : name);
          }
        });
      })
      .catch((err) => {
        groupError.textContent = err.message || 'No se pudo crear el grupo.';
        groupError.style.display = 'block';
      });
  });

  loadEmployees();
  loadConversations();

  setInterval(function () {
    loadConversations();
    if (activeConversationId) loadMessages(activeConversationId);
  }, 12000);
});
