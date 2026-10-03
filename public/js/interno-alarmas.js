// Alarma de apagados y encendidos programados. Corre en TODAS las páginas del panel para
// operadores y supervisores (lo incluye InternoLayout): consulta la agenda del día cada minuto
// y, a la hora exacta, cubre la pantalla y suena hasta que alguien marque "Hecho" en cualquier
// pestaña de la central. Reemplaza las alarmas que cada operador ponía en su teléfono.
(function () {
  const POLL_MS = 60000;
  const RING_POLL_MS = 15000;
  const MUTE_MS = 5 * 60000;
  const ACTION_LABEL = { apagar: 'APAGAR', encender: 'ENCENDER' };

  let agenda = [];
  let serverOffsetMs = 0;
  let lastPoll = 0;
  let mutedUntil = 0;
  let overlay = null;
  let audioCtx = null;
  let beepTimer = null;
  let titleTimer = null;
  let ringingKeys = '';
  let ignoreBefore = '';
  const baseTitle = document.title;

  function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function colombiaNowKey() {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(Date.now() + serverOffsetMs));
    const p = {};
    parts.forEach((x) => { p[x.type] = x.value; });
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  }

  // --- Sonido ---------------------------------------------------------------------------
  function ensureAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) {
      // sin audio (navegador muy viejo) — la pantalla roja sigue funcionando
    }
  }

  function tone(freq, start, dur) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.22, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(start);
    osc.stop(start + dur + 0.05);
  }

  function beepOnce() {
    ensureAudio();
    if (!audioCtx || audioCtx.state !== 'running') return false;
    const t = audioCtx.currentTime;
    tone(1046, t, 0.18);
    tone(1318, t + 0.22, 0.18);
    tone(1046, t + 0.44, 0.18);
    tone(1568, t + 0.66, 0.3);
    if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
    return true;
  }

  function startSound() {
    if (beepTimer) return;
    beepOnce();
    beepTimer = setInterval(() => {
      const ok = beepOnce();
      const hint = overlay && overlay.querySelector('.alarm-sound-hint');
      if (hint) hint.style.display = ok ? 'none' : '';
    }, 1500);
  }

  function stopSound() {
    if (beepTimer) clearInterval(beepTimer);
    beepTimer = null;
  }

  // El navegador solo deja sonar después de que el usuario tocó la página alguna vez; el primer
  // clic o tecla en cualquier parte del panel desbloquea el audio para el resto de la sesión.
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => {
    document.addEventListener(ev, ensureAudio, { once: true, passive: true });
  });

  // --- Pantalla -------------------------------------------------------------------------
  function injectStyles() {
    if (document.getElementById('alarmStyles')) return;
    const style = document.createElement('style');
    style.id = 'alarmStyles';
    style.textContent = `
      .alarm-overlay { position: fixed; inset: 0; z-index: 9999; background: rgba(120, 10, 10, 0.96); color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px; text-align: center; animation: alarmPulse 1s infinite alternate; }
      @keyframes alarmPulse { from { background: rgba(120, 10, 10, 0.96); } to { background: rgba(190, 30, 30, 0.97); } }
      .alarm-overlay h1 { font-size: clamp(22px, 4vw, 34px); margin: 0 0 6px; letter-spacing: 1px; }
      .alarm-overlay .alarm-sub { opacity: 0.85; margin-bottom: 18px; font-size: 14px; }
      .alarm-overlay .alarm-sound-hint { background: #fff3; padding: 6px 12px; border-radius: 8px; font-size: 13px; margin-bottom: 14px; }
      .alarm-list { display: flex; flex-direction: column; gap: 10px; width: min(560px, 100%); }
      .alarm-item { background: #fff; color: #1a1a1a; border-radius: 12px; padding: 14px 16px; display: flex; align-items: center; gap: 14px; text-align: left; flex-wrap: wrap; }
      .alarm-item .alarm-time { font-size: 28px; font-weight: 800; font-variant-numeric: tabular-nums; }
      .alarm-item .alarm-what { flex: 1; min-width: 160px; }
      .alarm-item .alarm-what strong { font-size: 20px; letter-spacing: 1px; }
      .alarm-item .alarm-what .alarm-action { display: inline-block; font-weight: 800; padding: 2px 8px; border-radius: 6px; margin-right: 6px; font-size: 13px; }
      .alarm-item .alarm-action.apagar { background: #ffd6d6; color: #a40000; }
      .alarm-item .alarm-action.encender { background: #d5f5e3; color: #0b6b36; }
      .alarm-item .alarm-what .alarm-note { color: #555; font-size: 13px; margin-top: 2px; }
      .alarm-item button { background: #1f8f4a; color: #fff; border: 0; border-radius: 10px; padding: 12px 20px; font-size: 16px; font-weight: 700; cursor: pointer; }
      .alarm-item button:disabled { opacity: 0.6; cursor: wait; }
      .alarm-mute { margin-top: 20px; background: transparent; color: #fff; border: 1px solid #fff8; border-radius: 10px; padding: 8px 16px; font-size: 13px; cursor: pointer; }
    `;
    document.head.appendChild(style);
  }

  function renderOverlay(due) {
    injectStyles();
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'alarm-overlay';
      overlay.setAttribute('role', 'alertdialog');
      overlay.addEventListener('click', function (e) {
        ensureAudio();
        const btn = e.target.closest('button[data-done]');
        if (btn) {
          markDone(btn.getAttribute('data-done'), btn.getAttribute('data-slot'), btn);
          return;
        }
        if (e.target.closest('.alarm-mute')) {
          mutedUntil = Date.now() + MUTE_MS;
          evaluate();
        }
      });
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `
      <h1>⏰ ${due.length === 1 ? `${ACTION_LABEL[due[0].accion]} ${escapeHtml(due[0].placa)}` : `${due.length} apagados/encendidos pendientes`}</h1>
      <div class="alarm-sub">Suena en todas las pantallas de la central hasta que alguien lo marque hecho.</div>
      <div class="alarm-sound-hint" style="display:none;">Toca la pantalla para activar el sonido</div>
      <div class="alarm-list">
        ${due.map((e) => `
          <div class="alarm-item">
            <div class="alarm-time">${e.hora}</div>
            <div class="alarm-what">
              <span class="alarm-action ${e.accion}">${ACTION_LABEL[e.accion] || e.accion}</span>
              <strong>${escapeHtml(e.placa)}</strong>${e.cliente ? ' · ' + escapeHtml(e.cliente) : ''}
              ${e.nota ? `<div class="alarm-note">${escapeHtml(e.nota)}</div>` : ''}
            </div>
            <button type="button" data-done="${e.id}" data-slot="${e.slot}">Hecho</button>
          </div>`).join('')}
      </div>
      <button class="alarm-mute" type="button">Silenciar 5 minutos</button>
    `;
  }

  function hideOverlay() {
    if (overlay) {
      overlay.remove();
      overlay = null;
    }
  }

  function startTitleFlash(due) {
    if (titleTimer) return;
    let on = false;
    titleTimer = setInterval(() => {
      on = !on;
      document.title = on ? `⏰ ${ACTION_LABEL[due[0].accion]} ${due[0].placa}` : baseTitle;
    }, 1000);
  }

  function stopTitleFlash() {
    if (titleTimer) clearInterval(titleTimer);
    titleTimer = null;
    document.title = baseTitle;
  }

  // --- Lógica ---------------------------------------------------------------------------
  function dueNow() {
    const nowKey = colombiaNowKey();
    return agenda.filter((e) => e.status !== 'hecho' && e.slot <= nowKey && e.slot >= ignoreBefore);
  }

  function evaluate() {
    const due = dueNow();
    const muted = Date.now() < mutedUntil;
    if (due.length && !muted) {
      const keys = due.map((e) => e.id + e.slot).join('|');
      if (keys !== ringingKeys) {
        ringingKeys = keys;
        renderOverlay(due);
      }
      startSound();
      startTitleFlash(due);
      if (Date.now() - lastPoll > RING_POLL_MS) poll();
    } else {
      ringingKeys = '';
      hideOverlay();
      stopSound();
      stopTitleFlash();
    }
  }

  let agendaVersion = '';
  function poll() {
    lastPoll = Date.now();
    return fetch('/api/apagados-programados?agenda=1' + (agendaVersion ? '&v=' + encodeURIComponent(agendaVersion) : ''))
      .then((res) => (res.ok ? res.json() : null))
      .then((d) => {
        if (!d) return;
        if (d.serverNow) serverOffsetMs = Date.parse(d.serverNow) - Date.now();
        if (d.unchanged) { evaluate(); return; }
        if (!Array.isArray(d.agenda)) return;
        if (d.version) agendaVersion = d.version;
        agenda = d.agenda;
        evaluate();
      })
      .catch(() => {});
  }

  function markDone(id, slot, btn) {
    if (btn) btn.disabled = true;
    fetch('/api/apagados-programados', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'done', id, slot }),
    })
      .then(async (res) => {
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error || 'No se pudo confirmar.');
        agenda = agenda.map((e) => (e.id === id && e.slot === slot ? { ...e, status: 'hecho' } : e));
        agendaVersion = '';
        ringingKeys = '';
        evaluate();
        document.dispatchEvent(new CustomEvent('apagados:changed', { detail: { fromAlarm: true } }));
      })
      .catch((err) => {
        if (btn) btn.disabled = false;
        alert(err.message || 'No se pudo confirmar.');
      });
  }

  // Prueba manual desde la página del módulo: suena 3 segundos sin tocar la agenda.
  window.TuGpsAlarmas = {
    test() {
      ensureAudio();
      const ok = beepOnce();
      if (!ok) {
        alert('El navegador todavía no deja sonar: haz clic en cualquier parte de la página y vuelve a probar.');
        return;
      }
      setTimeout(beepOnce, 1500);
      setTimeout(beepOnce, 3000);
    },
  };

  document.addEventListener('apagados:changed', function (e) {
    if (e.detail && e.detail.fromAlarm) return;
    poll();
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) poll();
  });

  // Al abrir una pestaña no se desentierran franjas de hace horas: solo suena lo de los
  // últimos 20 minutos o lo que venza de aquí en adelante. Lo más viejo ya lo ve el supervisor
  // como "vencido" en el módulo y en su campanita.
  (function initIgnoreBefore() {
    const d = new Date(Date.now() - 20 * 60000);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(d);
    const p = {};
    parts.forEach((x) => { p[x.type] = x.value; });
    ignoreBefore = `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  })();

  poll();
  setInterval(poll, POLL_MS);
  setInterval(evaluate, 5000);
})();
