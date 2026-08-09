document.addEventListener('DOMContentLoaded', function () {
  const tasksList = document.getElementById('tasksList');
  if (!tasksList) return;

  const tareasData = document.getElementById('tareasData');
  const canAssign = tareasData && tareasData.dataset.canAssign === 'true';
  const isAdmin = tareasData && tareasData.dataset.isAdmin === 'true';
  const userId = document.body.dataset.userId;

  const taskForm = document.getElementById('taskForm');
  const assigneeSelect = document.getElementById('t-assignee');
  const assigneeFilter = document.getElementById('assigneeFilter');
  const statusFilter = document.getElementById('statusFilter');
  const overdueFilter = document.getElementById('overdueFilter');
  const tasksBoard = document.getElementById('tasksBoard');
  const BOARD_STATUSES = ['Pendiente', 'En progreso', 'Completada', 'Cancelada'];

  let allTasks = [];
  let users = [];

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

  function fmtDateOnly(iso) {
    if (!iso) return 'Sin fecha';
    return new Date(iso).toLocaleDateString('es-CO', { dateStyle: 'medium' });
  }

  function statusClass(status) {
    return String(status).replace(/\s+/g, '-');
  }

  function compressImage(file, maxDim, quality) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const reader = new FileReader();
      reader.onload = () => { img.src = reader.result; };
      reader.onerror = reject;
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error('No se pudo comprimir la imagen'));
        }, 'image/jpeg', quality);
      };
      img.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function loadUsers() {
    if (!canAssign) return Promise.resolve();
    return fetch('/api/users')
      .then((res) => res.json())
      .then((data) => {
        if (!data || !Array.isArray(data.users)) return;
        users = data.users.filter((u) => u.active);
        assigneeSelect.innerHTML = users.map((u) => `<option value="${u.id}">${escapeHtml(u.name)} (${escapeHtml(u.role)})</option>`).join('');
        assigneeFilter.innerHTML = '<option value="">Todos los empleados</option>' +
          users.map((u) => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('');
      });
  }

  function getFilteredTasks() {
    const status = statusFilter.value;
    const assigneeId = canAssign ? assigneeFilter.value : '';
    const onlyOverdue = overdueFilter.checked;
    return allTasks.filter((t) => {
      if (status && t.status !== status) return false;
      if (assigneeId && t.assigneeId !== assigneeId) return false;
      if (onlyOverdue && !t.overdue) return false;
      return true;
    });
  }

  function renderTasks() {
    const tasks = getFilteredTasks();
    if (!tasks.length) {
      tasksList.innerHTML = '<div class="empty">No hay tareas con esos filtros.</div>';
      return;
    }
    tasksList.innerHTML = tasks.map((t) => {
      const canAct = canAssign || t.assigneeId === userId;
      const proofImg = t.proof
        ? `<a href="/api/blob-file?path=${encodeURIComponent(t.proof.pathname)}" target="_blank" rel="noopener"><img class="proof-thumb" src="/api/blob-file?path=${encodeURIComponent(t.proof.pathname)}" alt="Evidencia" loading="lazy" /></a>`
        : '';
      return `
      <div class="task-item ${t.overdue ? 'overdue' : ''}" data-id="${t.id}">
        <div class="task-top">
          <span class="task-title">${escapeHtml(t.title)}</span>
          <span class="badge ${statusClass(t.status)}">${escapeHtml(t.status)}</span>
          ${t.overdue ? '<span class="badge overdue-badge">Atrasada</span>' : ''}
        </div>
        <div class="task-meta">
          Asignada a: ${escapeHtml(t.assigneeName)} · Por: ${escapeHtml(t.assignedByName)} · Vence: ${fmtDateOnly(t.dueDate)}
        </div>
        ${t.description ? `<p class="task-desc">${escapeHtml(t.description)}</p>` : ''}
        ${proofImg}
        ${canAct && t.status !== 'Cancelada' ? `
          <div class="task-controls">
            <select data-action="status" data-id="${t.id}">
              <option value="Pendiente" ${t.status === 'Pendiente' ? 'selected' : ''}>Pendiente</option>
              <option value="En progreso" ${t.status === 'En progreso' ? 'selected' : ''}>En progreso</option>
              <option value="Cancelada" ${t.status === 'Cancelada' ? 'selected' : ''}>Cancelada</option>
            </select>
            <button class="btn-small btn-done" data-action="attach" data-id="${t.id}" type="button" title="También puedes cancelar el explorador y pegar una captura con Ctrl+V">Adjuntar foto</button>
            ${t.status !== 'Completada' ? `<button class="btn-small btn-done" data-action="complete" data-id="${t.id}" type="button">Marcar completada</button>` : ''}
          </div>
        ` : ''}
        ${isAdmin ? `<div class="task-controls"><button class="btn-small btn-delete" data-action="delete" data-id="${t.id}">Eliminar</button></div>` : ''}
        <div class="followup-section">
          <h4>Seguimiento</h4>
          <div class="add-note-row">
            <input type="text" placeholder="Agregar nota de seguimiento... (o pega una captura con Ctrl+V)" data-note-input data-id="${t.id}" />
            <button class="btn-small" data-action="addnote" data-id="${t.id}" type="button">Agregar</button>
          </div>
          ${t.notes && t.notes.length ? `
            <div class="notes-list">
              ${t.notes.map((n) => `<div class="note-item"><span class="note-date">${fmtDate(n.date)} · ${escapeHtml(n.by)}</span>${escapeHtml(n.text)}</div>`).join('')}
            </div>
          ` : ''}
        </div>
      </div>
    `;
    }).join('');
  }

  function renderBoardCard(t) {
    const canAct = canAssign || t.assigneeId === userId;
    const proofImg = t.proof
      ? `<img class="proof-thumb" src="/api/blob-file?path=${encodeURIComponent(t.proof.pathname)}" alt="Evidencia" loading="lazy" />`
      : '';
    return `
      <div class="board-card ${t.overdue ? 'overdue' : ''}" draggable="${canAct && t.status !== 'Cancelada'}" data-id="${t.id}">
        <div class="board-card-title">${escapeHtml(t.title)}</div>
        <div class="board-card-meta">${escapeHtml(t.assigneeName)} · Vence: ${fmtDateOnly(t.dueDate)}</div>
        <div class="board-card-badges">
          ${t.overdue ? '<span class="badge overdue-badge">Atrasada</span>' : ''}
        </div>
        ${proofImg}
      </div>
    `;
  }

  function renderBoard() {
    if (!tasksBoard) return;
    const tasks = getFilteredTasks();
    tasksBoard.innerHTML = `<div class="board-columns">${BOARD_STATUSES.map((s) => {
      const items = tasks.filter((t) => t.status === s);
      return `
        <div class="board-col">
          <div class="board-col-head"><span>${escapeHtml(s)}</span><span class="board-count">${items.length}</span></div>
          <div class="board-col-body" data-dropzone="${escapeHtml(s)}">
            ${items.map(renderBoardCard).join('') || '<div class="board-empty">Sin tareas</div>'}
          </div>
        </div>
      `;
    }).join('')}</div>`;
  }

  function renderCurrentView() {
    renderTasks();
    renderBoard();
  }

  if (tasksBoard) {
    tasksBoard.addEventListener('dragstart', function (e) {
      const card = e.target.closest('.board-card');
      if (!card || card.getAttribute('draggable') !== 'true') return;
      e.dataTransfer.setData('text/plain', card.getAttribute('data-id'));
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    tasksBoard.addEventListener('dragend', function (e) {
      const card = e.target.closest('.board-card');
      if (card) card.classList.remove('dragging');
    });
    tasksBoard.addEventListener('dragover', function (e) {
      const zone = e.target.closest('[data-dropzone]');
      if (!zone) return;
      e.preventDefault();
      zone.classList.add('drag-over');
    });
    tasksBoard.addEventListener('dragleave', function (e) {
      const zone = e.target.closest('[data-dropzone]');
      if (zone) zone.classList.remove('drag-over');
    });
    tasksBoard.addEventListener('drop', function (e) {
      const zone = e.target.closest('[data-dropzone]');
      if (!zone) return;
      e.preventDefault();
      zone.classList.remove('drag-over');
      const id = e.dataTransfer.getData('text/plain');
      const newStatus = zone.getAttribute('data-dropzone');
      const task = allTasks.find((t) => t.id === id);
      if (!task || task.status === newStatus) return;
      fetch('/api/tasks', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status: newStatus }),
      })
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'No se pudo actualizar la tarea.');
          loadTasks();
        })
        .catch((err) => alert(err.message || 'No se pudo actualizar la tarea.'));
    });
  }

  function loadTasks() {
    fetch('/api/tasks')
      .then((res) => res.json())
      .then((data) => {
        if (!data || !Array.isArray(data.tasks)) {
          tasksList.innerHTML = '<div class="empty">No se pudo cargar (revisa la conexión).</div>';
          return;
        }
        allTasks = data.tasks;
        renderCurrentView();
      })
      .catch(() => {
        tasksList.innerHTML = '<div class="empty">No se pudo cargar (revisa la conexión).</div>';
      });
  }

  statusFilter.addEventListener('change', renderCurrentView);
  overdueFilter.addEventListener('change', renderCurrentView);
  if (assigneeFilter) assigneeFilter.addEventListener('change', renderCurrentView);

  if (taskForm) {
    taskForm.addEventListener('submit', function (e) {
      e.preventDefault();
      const title = document.getElementById('t-title').value.trim();
      const description = document.getElementById('t-description').value.trim();
      const assigneeId = assigneeSelect.value;
      const dueDate = document.getElementById('t-duedate').value || null;
      if (!title || !assigneeId) return;

      const submitBtn = taskForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description, assigneeId, dueDate }),
      })
        .then(async (res) => {
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'No se pudo crear la tarea.');
          }
          taskForm.reset();
          loadTasks();
        })
        .catch((err) => alert(err.message || 'No se pudo crear la tarea.'))
        .finally(() => { submitBtn.disabled = false; });
    });
  }

  // ---------- Adjuntar foto (input oculto compartido) ----------
  const hiddenFileInput = document.createElement('input');
  hiddenFileInput.type = 'file';
  hiddenFileInput.accept = 'image/*';
  hiddenFileInput.style.display = 'none';
  document.body.appendChild(hiddenFileInput);
  let pendingTaskId = null;
  let pendingCompleteAfter = false;

  async function uploadProof(taskId, file) {
    const compressed = await compressImage(file, 1600, 0.75);
    const formData = new FormData();
    formData.set('id', taskId);
    formData.append('photo', compressed, 'evidencia.jpg');
    const res = await fetch('/api/task-proof', { method: 'POST', body: formData });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'No se pudo subir la foto.');
    }
    return res.json();
  }

  async function handlePendingFile(file) {
    if (!file || !pendingTaskId) return;
    const taskId = pendingTaskId;
    const completeAfter = pendingCompleteAfter;
    pendingTaskId = null;
    pendingCompleteAfter = false;

    try {
      await uploadProof(taskId, file);
      if (completeAfter) {
        const res = await fetch('/api/tasks', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: taskId, status: 'Completada' }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'No se pudo marcar como completada.');
        }
      }
      loadTasks();
    } catch (err) {
      alert(err.message || 'Ocurrió un error.');
    }
  }

  hiddenFileInput.addEventListener('change', function () {
    const file = hiddenFileInput.files && hiddenFileInput.files[0];
    hiddenFileInput.value = '';
    handlePendingFile(file);
  });

  document.addEventListener('paste', function (e) {
    const noteInput = e.target.closest && e.target.closest('[data-note-input]');
    if (noteInput) {
      pendingTaskId = noteInput.getAttribute('data-id');
      pendingCompleteAfter = false;
    }
    if (!pendingTaskId) return;
    const items = Array.from(e.clipboardData?.items || []);
    const imageItem = items.find((item) => item.kind === 'file' && item.type.startsWith('image/'));
    if (!imageItem) return;
    const file = imageItem.getAsFile();
    if (file) handlePendingFile(file);
  });

  tasksList.addEventListener('change', function (e) {
    const el = e.target;
    if (el.getAttribute('data-action') !== 'status') return;
    const id = el.getAttribute('data-id');
    fetch('/api/tasks', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status: el.value }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'No se pudo actualizar.');
        }
        loadTasks();
      })
      .catch((err) => { alert(err.message || 'No se pudo actualizar.'); loadTasks(); });
  });

  tasksList.addEventListener('click', function (e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    const action = btn.getAttribute('data-action');

    if (action === 'attach') {
      pendingTaskId = id;
      pendingCompleteAfter = false;
      hiddenFileInput.click();
    } else if (action === 'complete') {
      const task = allTasks.find((t) => t.id === id);
      if (task && task.proof) {
        fetch('/api/tasks', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, status: 'Completada' }),
        })
          .then(async (res) => {
            if (!res.ok) {
              const data = await res.json().catch(() => ({}));
              throw new Error(data.error || 'No se pudo completar.');
            }
            loadTasks();
          })
          .catch((err) => alert(err.message || 'No se pudo completar.'));
      } else {
        alert('Primero adjunta la foto de evidencia.');
        pendingTaskId = id;
        pendingCompleteAfter = true;
        hiddenFileInput.click();
      }
    } else if (action === 'delete') {
      if (!confirm('¿Eliminar esta tarea de forma permanente?')) return;
      fetch('/api/tasks', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      }).then(loadTasks);
    } else if (action === 'addnote') {
      const input = tasksList.querySelector(`input[data-note-input][data-id="${id}"]`);
      const text = input ? input.value.trim() : '';
      if (!text) return;
      fetch('/api/tasks', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, addNote: text }),
      }).then(loadTasks);
    }
  });

  loadUsers().then(loadTasks);
});
