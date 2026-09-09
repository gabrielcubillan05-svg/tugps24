document.addEventListener('DOMContentLoaded', function () {
  const list = document.getElementById('mediaConfigList');
  if (!list) return;

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function render(items, urls) {
    list.innerHTML = items.map((item) => {
      const current = urls[item.key] || '';
      return `
        <div class="media-config-row" data-key="${item.key}">
          <div class="label">${escapeHtml(item.label)}<span class="type-tag">(${item.type})</span></div>
          <input type="text" placeholder="Pega aquí la URL pública..." value="${escapeHtml(current)}" data-url-input data-key="${item.key}" />
          <button class="btn-small" type="button" data-action="save" data-key="${item.key}">Guardar</button>
          <span class="${current ? 'status-ok' : 'status-missing'}" data-status data-key="${item.key}">${current ? '✓ Configurado' : 'Sin configurar'}</span>
        </div>
      `;
    }).join('');
  }

  function load() {
    fetch('/api/whatsapp-agent-media')
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !Array.isArray(data.items)) {
          list.innerHTML = `<div class="empty">No se pudo cargar${data && data.error ? ': ' + escapeHtml(data.error) : ''}.</div>`;
          return;
        }
        render(data.items, data.urls || {});
      })
      .catch(() => {
        list.innerHTML = '<div class="empty">No se pudo cargar (revisa la conexión).</div>';
      });
  }

  list.addEventListener('click', function (e) {
    const btn = e.target.closest('button[data-action="save"]');
    if (!btn) return;
    const key = btn.getAttribute('data-key');
    const input = list.querySelector(`input[data-url-input][data-key="${key}"]`);
    const url = input ? input.value.trim() : '';

    btn.disabled = true;
    fetch('/api/whatsapp-agent-media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, url }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo guardar.');
        const status = list.querySelector(`[data-status][data-key="${key}"]`);
        if (status) {
          status.textContent = url ? '✓ Configurado' : 'Sin configurar';
          status.className = url ? 'status-ok' : 'status-missing';
        }
      })
      .catch((err) => alert(err.message || 'No se pudo guardar.'))
      .finally(() => { btn.disabled = false; });
  });

  load();
});
