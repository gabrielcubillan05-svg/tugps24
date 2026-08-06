document.addEventListener('DOMContentLoaded', function () {
  const bellBtn = document.getElementById('notifBell');
  const bellBadge = document.getElementById('bellBadge');
  const dropdown = document.getElementById('notifDropdown');
  const notifList = document.getElementById('notifList');
  const markAllReadBtn = document.getElementById('markAllReadBtn');
  const chatNavBadge = document.getElementById('chatNavBadge');

  if (!bellBtn || !dropdown) return;

  let previousUnread = null;
  let audioCtx = null;

  function playBeep() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.16, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.35);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.35);
    } catch (e) {
      // navegador bloqueó el audio (sin interacción previa) — se ignora, no rompe nada
    }
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function fmtRelative(iso) {
    const diffMs = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'ahora mismo';
    if (mins < 60) return `hace ${mins} min`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `hace ${hours} h`;
    const days = Math.floor(hours / 24);
    return `hace ${days} d`;
  }

  function renderNotifications(notifications) {
    if (!notifications.length) {
      notifList.innerHTML = '<div class="notif-empty">No tienes notificaciones.</div>';
      return;
    }
    notifList.innerHTML = notifications.map((n) => `
      <a class="notif-item ${n.read ? '' : 'unread'}" href="${n.link || '#'}" data-id="${n.id}">
        ${escapeHtml(n.message)}
        <span class="notif-time">${fmtRelative(n.createdAt)}</span>
      </a>
    `).join('');
  }

  function loadNotifications() {
    fetch('/api/notifications')
      .then((res) => res.json())
      .then((data) => {
        if (!data || !Array.isArray(data.notifications)) return;
        renderNotifications(data.notifications);
        if (data.unreadCount > 0) {
          bellBadge.textContent = data.unreadCount > 99 ? '99+' : String(data.unreadCount);
          bellBadge.style.display = 'inline-flex';
        } else {
          bellBadge.style.display = 'none';
        }
        if (previousUnread !== null && data.unreadCount > previousUnread) {
          playBeep();
        }
        previousUnread = data.unreadCount;
      })
      .catch(() => {});
  }

  function loadChatUnread() {
    if (!chatNavBadge) return;
    fetch('/api/conversations')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data || !Array.isArray(data.conversations)) return;
        const total = data.conversations.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
        if (total > 0) {
          chatNavBadge.textContent = total > 99 ? '99+' : String(total);
          chatNavBadge.style.display = 'inline-flex';
        } else {
          chatNavBadge.style.display = 'none';
        }
      })
      .catch(() => {});
  }

  function positionDropdown() {
    const rect = bellBtn.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 32);
    let left = rect.right - width;
    left = Math.max(16, Math.min(left, window.innerWidth - width - 16));
    let top = rect.bottom + 8;
    top = Math.min(top, window.innerHeight - 100);
    dropdown.style.width = width + 'px';
    dropdown.style.left = left + 'px';
    dropdown.style.top = top + 'px';
    dropdown.style.right = 'auto';
  }

  bellBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    const willOpen = dropdown.style.display === 'none';
    if (willOpen) positionDropdown();
    dropdown.style.display = willOpen ? 'block' : 'none';
    if (willOpen) loadNotifications();
  });

  window.addEventListener('resize', function () {
    if (dropdown.style.display !== 'none') positionDropdown();
  });

  document.addEventListener('click', function (e) {
    if (dropdown.style.display !== 'none' && !dropdown.contains(e.target) && e.target !== bellBtn) {
      dropdown.style.display = 'none';
    }
  });

  notifList.addEventListener('click', function (e) {
    const item = e.target.closest('.notif-item');
    if (!item) return;
    const id = item.getAttribute('data-id');
    fetch('/api/notifications', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }).catch(() => {});
  });

  markAllReadBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    fetch('/api/notifications', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markAllRead: true }),
    })
      .then(loadNotifications)
      .catch(() => {});
  });

  loadNotifications();
  loadChatUnread();
  setInterval(loadNotifications, 15000);
  setInterval(loadChatUnread, 15000);
});
