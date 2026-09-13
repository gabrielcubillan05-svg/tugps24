document.addEventListener('DOMContentLoaded', function () {
  const widget = document.getElementById('webChatWidget');
  if (!widget) return;

  const bubble = document.getElementById('webChatBubble');
  const minimizeBtn = document.getElementById('webChatMinimize');
  const messagesEl = document.getElementById('webChatMessages');
  const gateForm = document.getElementById('webChatGateForm');
  const gateName = document.getElementById('webChatGateName');
  const gatePhone = document.getElementById('webChatGatePhone');
  const chatForm = document.getElementById('webChatForm');
  const chatInput = document.getElementById('webChatInput');

  const SESSION_KEY = 'tugps24WebChatSession';
  const STARTED_KEY = 'tugps24WebChatStarted';
  const MIN_KEY = 'tugps24WebChatMinimized';

  function getSessionId() {
    try {
      let id = localStorage.getItem(SESSION_KEY);
      if (!id) {
        id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
        localStorage.setItem(SESSION_KEY, id);
      }
      return id;
    } catch {
      return 'anon-' + Date.now();
    }
  }

  function appendMessage(text, who) {
    const el = document.createElement('div');
    el.className = 'web-chat-msg ' + who;
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function showTyping() {
    const el = document.createElement('div');
    el.className = 'web-chat-msg bot typing';
    el.id = 'webChatTyping';
    el.textContent = 'Andrés está escribiendo…';
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function hideTyping() {
    const el = document.getElementById('webChatTyping');
    if (el) el.remove();
  }

  function setMinimized(min) {
    widget.classList.toggle('minimized', min);
    try { localStorage.setItem(MIN_KEY, min ? '1' : '0'); } catch {}
  }

  bubble.addEventListener('click', () => setMinimized(false));
  minimizeBtn.addEventListener('click', () => setMinimized(true));

  let minimized = false;
  try { minimized = localStorage.getItem(MIN_KEY) === '1'; } catch {}
  setMinimized(minimized);

  function sendToServer(text, extra) {
    const sessionId = getSessionId();
    const payload = Object.assign({ sessionId, text }, extra || {});
    showTyping();
    return fetch('/api/web-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        hideTyping();
        if (!res.ok) throw new Error(data.error || 'No se pudo enviar el mensaje.');
        appendMessage(data.reply, 'bot');
      })
      .catch((err) => {
        hideTyping();
        appendMessage(err.message || 'No se pudo enviar el mensaje, intenta de nuevo.', 'bot');
      });
  }

  let started = false;
  try { started = localStorage.getItem(STARTED_KEY) === '1'; } catch {}

  if (started) {
    gateForm.style.display = 'none';
    chatForm.style.display = 'flex';
    appendMessage('¡Hola de nuevo! ¿En qué te puedo ayudar? 😊', 'bot');
  }

  gateForm.addEventListener('submit', function (e) {
    e.preventDefault();
    const name = gateName.value.trim();
    const phone = gatePhone.value.trim();
    if (!name || !phone) return;
    const submitBtn = gateForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    sendToServer('Hola, quiero información sobre el GPS.', { name, phone })
      .then(() => {
        try { localStorage.setItem(STARTED_KEY, '1'); } catch {}
        gateForm.style.display = 'none';
        chatForm.style.display = 'flex';
      })
      .finally(() => { submitBtn.disabled = false; });
  });

  chatForm.addEventListener('submit', function (e) {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = '';
    appendMessage(text, 'mine');
    sendToServer(text);
  });
});
