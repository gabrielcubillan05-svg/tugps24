document.addEventListener('DOMContentLoaded', function () {
  const widget = document.getElementById('gabotWidget');
  const bubble = document.getElementById('gabotBubble');
  const badge = document.getElementById('gabotBadge');
  const panel = document.getElementById('gabotPanel');
  const closeBtn = document.getElementById('gabotClose');
  const messagesEl = document.getElementById('gabotMessages');
  const form = document.getElementById('gabotForm');
  const input = document.getElementById('gabotInput');
  const micBtn = document.getElementById('gabotMic');
  if (!widget || !bubble) return;

  const myUserId = document.body.dataset.userId;
  const OPEN_PREF_KEY = 'gpsitoPanelOpen';
  let conversationId = null;
  let panelOpen = false;
  let lastMessageCount = 0;

  function getOpenPreference() {
    try {
      const stored = localStorage.getItem(OPEN_PREF_KEY);
      return stored === null ? true : stored === '1'; // por defecto abierto para todos
    } catch {
      return true;
    }
  }

  function setOpenPreference(open) {
    try {
      localStorage.setItem(OPEN_PREF_KEY, open ? '1' : '0');
    } catch {
      // localStorage no disponible (modo privado, etc.) — no rompe nada, solo no se recuerda
    }
  }

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
      messagesEl.innerHTML = '<div class="empty">GPSITO todavía no te ha escrito.</div>';
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

  function ensureGabotConversation() {
    return fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'gabot' }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => (data && data.conversation ? data.conversation.id : null))
      .catch(() => null);
  }

  function checkGabotConversation() {
    fetch('/api/conversations')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        widget.style.display = 'flex';
        const gabotConv = data && Array.isArray(data.conversations) ? data.conversations.find((c) => c.isGabot) : null;
        if (!gabotConv) return; // todavía no existe — se crea cuando el usuario abra el panel o le escriba
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

  async function openPanel() {
    panelOpen = true;
    panel.style.display = 'flex';
    setOpenPreference(true);
    bubble.classList.remove('pulse');
    if (!conversationId) conversationId = await ensureGabotConversation();
    loadMessages();
    markRead();
    setTimeout(() => input.focus(), 50);
  }

  function closePanel() {
    panelOpen = false;
    panel.style.display = 'none';
    setOpenPreference(false);
  }

  bubble.addEventListener('click', function () {
    if (panelOpen) closePanel();
    else openPanel();
  });

  if (closeBtn) {
    closeBtn.addEventListener('click', closePanel);
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

  // ---------- Micrófono: graba, transcribe y deja el texto listo para revisar/enviar ----------
  let mediaRecorder = null;
  let recordedChunks = [];
  let isRecording = false;

  async function startRecording() {
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      alert('Este navegador no soporta grabar audio.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordedChunks = [];
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recordedChunks.push(e.data);
      };
      mediaRecorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        transcribeAndFill(blob);
      };
      mediaRecorder.start();
      isRecording = true;
      micBtn.classList.add('recording');
      micBtn.textContent = '⏹️';
    } catch (err) {
      const name = err && err.name;
      let msg = 'No se pudo acceder al micrófono';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        msg = 'El navegador bloqueó el micrófono. Revisa: 1) que le hayas dado permiso al sitio (icono de candado en la barra de direcciones), y 2) en Android, que la app Chrome tenga permiso de Micrófono en Ajustes del teléfono > Apps > Chrome > Permisos.';
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        msg = 'No se encontró ningún micrófono en este dispositivo.';
      } else if (name === 'NotReadableError') {
        msg = 'El micrófono está siendo usado por otra app — ciérrala e intenta de nuevo.';
      } else if (name) {
        msg = `No se pudo acceder al micrófono (${name}).`;
      }
      alert(msg);
    }
  }

  function stopRecording() {
    if (mediaRecorder && isRecording) mediaRecorder.stop();
    isRecording = false;
    micBtn.classList.remove('recording');
    micBtn.textContent = '🎤';
  }

  async function transcribeAndFill(blob) {
    micBtn.disabled = true;
    const originalPlaceholder = input.placeholder;
    input.placeholder = 'Transcribiendo audio...';
    try {
      const formData = new FormData();
      formData.append('audio', blob, 'audio.webm');
      const res = await fetch('/api/gabot-transcribe', { method: 'POST', body: formData });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'No se pudo transcribir el audio.');
      input.value = data.text || '';
      input.focus();
    } catch (err) {
      alert(err.message || 'No se pudo transcribir el audio.');
    } finally {
      input.placeholder = originalPlaceholder;
      micBtn.disabled = false;
    }
  }

  if (micBtn) {
    micBtn.addEventListener('click', function () {
      if (isRecording) stopRecording();
      else startRecording();
    });
  }

  checkGabotConversation();
  setInterval(checkGabotConversation, 45000);
  if (getOpenPreference()) openPanel();
});
