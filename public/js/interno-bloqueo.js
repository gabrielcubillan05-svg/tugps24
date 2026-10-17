// Ventana obligatoria de tareas vencidas, bloqueo por leads de Andrés sin confirmar y alarma
// sonora de lead concretado. El bloqueo de páginas lo hace el servidor (middleware); esto es la
// parte visible para resolverlo sin salir de donde se está.
document.addEventListener('DOMContentLoaded', function () {
  const root = document.getElementById('bloqueoRoot');
  if (!root) return;
  const role = root.dataset.role;
  const recibeLeads = role === 'secretaria' || role === 'gerente';
  const POLL_MS = recibeLeads ? 15000 : 300000;

  let estado = null;
  let overlay = null;
  let banner = null;
  let audioCtx = null;
  let alarmaTimer = null;
  const abiertos = {};

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function hora(iso) {
    try { return new Date(iso).toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit' }); } catch { return ''; }
  }

  // ---------- Alarma ----------
  function ctx() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    }
    return audioCtx;
  }

  function pitido() {
    const c = ctx();
    if (!c || c.state !== 'running') return;
    [0, 0.25].forEach((delay) => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = 'square';
      osc.frequency.value = 988;
      gain.gain.setValueAtTime(0.18, c.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + delay + 0.2);
      osc.connect(gain).connect(c.destination);
      osc.start(c.currentTime + delay);
      osc.stop(c.currentTime + delay + 0.2);
    });
  }

  function sonidoActivo() {
    const c = ctx();
    return !!c && c.state === 'running';
  }

  // El navegador no deja sonar nada hasta que la persona toque la página una vez.
  function activarSonido() {
    const c = ctx();
    // Solo se repinta si hay un aviso de lead: repintar la ventana de tareas borraría lo escrito.
    if (c && c.state !== 'running') c.resume().then(() => { if (estado && estado.leads && estado.leads.length) render(); }).catch(() => {});
  }
  document.addEventListener('pointerdown', activarSonido, true);
  document.addEventListener('keydown', activarSonido, true);

  function actualizarAlarma() {
    const hayLeads = estado && estado.leads && estado.leads.length > 0;
    if (hayLeads && !alarmaTimer) {
      pitido();
      alarmaTimer = setInterval(pitido, 2000);
    } else if (!hayLeads && alarmaTimer) {
      clearInterval(alarmaTimer);
      alarmaTimer = null;
    }
  }

  // ---------- Acciones ----------
  async function patch(url, body) {
    const res = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'No se pudo guardar.');
    }
  }

  async function confirmarLead(id, btn) {
    btn.disabled = true;
    try {
      await patch('/api/leads', { id, confirmVenta: true });
      await cargar();
    } catch (err) {
      alert(err.message);
      btn.disabled = false;
    }
  }

  async function accionTarea(id, accion, item) {
    const boton = item.querySelector('[data-guardar]');
    try {
      if (accion === 'completar') {
        await patch('/api/tasks', { id, status: 'Completada' });
      } else if (accion === 'nota') {
        const texto = item.querySelector('textarea').value.trim();
        if (!texto) return alert('Escribe qué avance llevas.');
        await patch('/api/tasks', { id, addNote: `[Avance] ${texto}` });
      } else if (accion === 'prorroga') {
        const fecha = item.querySelector('input[type="date"]').value;
        const motivo = item.querySelector('textarea').value.trim();
        if (!fecha || !motivo) return alert('Indica la nueva fecha y el motivo.');
        await patch('/api/tasks', { id, requestExtension: { date: fecha, reason: motivo } });
      }
      delete abiertos[id];
      await cargar();
    } catch (err) {
      alert(err.message);
      if (boton) boton.disabled = false;
    }
  }

  // ---------- Pintar ----------
  function quitarOverlay() {
    if (overlay) { overlay.remove(); overlay = null; }
  }

  function mostrarOverlay(html) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'modal-overlay bloqueo-overlay';
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `<div class="modal-box bloqueo-box">${html}</div>`;
  }

  function htmlLeads(leads) {
    return `
      <h2>🚨 Lead concretado por Andrés sin confirmar</h2>
      <p class="intro">Pasó más de 1 hora y nadie confirmó. El panel queda bloqueado hasta que confirmes que ya sabes de esta venta y la vas a atender.</p>
      ${leads.map((l) => `
        <div class="bloqueo-item ${l.bloquea ? 'urgente' : ''}">
          <h3>${esc(l.name)}${l.city ? ` · ${esc(l.city)}` : ''}</h3>
          <div class="meta">${l.phone ? `📞 ${esc(l.phone)} · ` : ''}Concretado a las ${esc(hora(l.handoffAt))}</div>
          ${l.resumen ? `<p class="meta">${esc(l.resumen)}</p>` : ''}
          <div class="acciones"><button class="btn" type="button" data-lead="${esc(l.id)}">Confirmar que ya sé de esta venta</button></div>
        </div>`).join('')}
      ${sonidoActivo() ? '' : '<p class="intro">🔇 Toca cualquier parte de la página para activar la alarma.</p>'}`;
  }

  function htmlTareas(tareas, fuerte) {
    return `
      <h2>⏰ Tienes tareas vencidas</h2>
      <p class="intro">Antes de seguir, responde cada una: complétala, cuenta qué avance llevas o pide prórroga a quien te la asignó.${fuerte ? ' Las vencidas hace más de 2 días limitan el panel a Tareas, Chat y Novedades hasta que se completen o te cambien la fecha.' : ''}</p>
      ${tareas.map((t) => {
        const modo = abiertos[t.id];
        return `
        <div class="bloqueo-item ${t.bloqueaFuerte ? 'urgente' : ''}" data-tarea="${esc(t.id)}">
          <h3>${esc(t.title)}</h3>
          <div class="meta">Venció el ${esc(t.dueDate)} (hace ${t.diasVencida} día${t.diasVencida === 1 ? '' : 's'}) · Asignada por ${esc(t.assignedByName)}</div>
          ${modo === 'nota' ? `
            <textarea rows="2" placeholder="¿Qué avance llevas y qué falta?"></textarea>
            <div class="acciones"><button class="btn" type="button" data-guardar="nota">Guardar avance</button><button class="btn-ghost" type="button" data-modo="">Volver</button></div>`
          : modo === 'prorroga' ? `
            <label class="meta">Nueva fecha que propones</label>
            <input type="date" />
            <textarea rows="2" placeholder="Motivo de la prórroga"></textarea>
            <div class="acciones"><button class="btn" type="button" data-guardar="prorroga">Pedir prórroga</button><button class="btn-ghost" type="button" data-modo="">Volver</button></div>`
          : `
            <div class="acciones">
              <button class="btn" type="button" data-guardar="completar">Ya la completé</button>
              <button class="btn-ghost" type="button" data-modo="nota">Dejar nota de avance</button>
              <button class="btn-ghost" type="button" data-modo="prorroga">Pedir prórroga</button>
            </div>`}
        </div>`;
      }).join('')}`;
  }

  function mostrarBanner(html) {
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'bloqueo-banner';
      document.body.appendChild(banner);
    }
    banner.innerHTML = html;
  }

  function quitarBanner() {
    if (banner) { banner.remove(); banner = null; }
  }

  function render() {
    if (!estado) return;
    const leads = estado.leads || [];
    const tareasPendientes = (estado.tareas || []).filter((t) => !t.respondidaHoy);

    if (estado.bloqueoLead) {
      mostrarOverlay(htmlLeads(leads));
    } else if (tareasPendientes.length) {
      mostrarOverlay(htmlTareas(tareasPendientes, estado.bloqueoTareas));
    } else {
      quitarOverlay();
    }

    if (!estado.bloqueoLead && leads.length) {
      const l = leads[0];
      mostrarBanner(`🚨 Andrés concretó una venta: <strong>${esc(l.name)}</strong>${leads.length > 1 ? ` y ${leads.length - 1} más` : ''}. Confírmala antes de 1 hora o se bloquea el panel.
        <button type="button" data-lead="${esc(l.id)}">Confirmar</button>${sonidoActivo() ? '' : ' <button type="button" data-sonido>🔇 Activar alarma</button>'}`);
    } else if (!overlay && estado.bloqueoTareas) {
      mostrarBanner('⛔ Tienes tareas vencidas hace más de 2 días: el panel queda limitado a Tareas, Chat y Novedades hasta que se completen o te cambien la fecha.');
    } else {
      quitarBanner();
    }
    actualizarAlarma();
  }

  document.addEventListener('click', function (e) {
    const el = e.target.closest('[data-lead],[data-guardar],[data-modo],[data-sonido]');
    if (!el || !(overlay && overlay.contains(el)) && !(banner && banner.contains(el))) return;
    if (el.hasAttribute('data-lead')) return confirmarLead(el.getAttribute('data-lead'), el);
    if (el.hasAttribute('data-sonido')) return activarSonido();
    const item = el.closest('[data-tarea]');
    if (!item) return;
    const id = item.getAttribute('data-tarea');
    if (el.hasAttribute('data-modo')) {
      abiertos[id] = el.getAttribute('data-modo') || undefined;
      render();
      return;
    }
    el.disabled = true;
    accionTarea(id, el.getAttribute('data-guardar'), item);
  });

  async function cargar() {
    try {
      const res = await fetch('/api/bloqueos', { cache: 'no-store' });
      if (!res.ok) return;
      const antes = estado;
      estado = await res.json();
      // No repintar si no cambió nada: se perdería lo que la persona esté escribiendo.
      if (antes && JSON.stringify(antes) === JSON.stringify(estado)) return actualizarAlarma();
      render();
    } catch {
      // sin conexión: se reintenta en la siguiente vuelta
    }
  }

  cargar();
  setInterval(cargar, POLL_MS);
});
