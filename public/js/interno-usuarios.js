document.addEventListener('DOMContentLoaded', function () {
  const usersList = document.getElementById('usersList');
  if (!usersList) return;

  const userForm = document.getElementById('userForm');
  const userFormError = document.getElementById('userFormError');
  const seedBtn = document.getElementById('seedBtn');
  const seedResult = document.getElementById('seedResult');
  const searchInput = document.getElementById('searchInput');
  const roleFilter = document.getElementById('roleFilter');

  let allUsers = [];
  let roles = [];

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function getFiltered() {
    const q = searchInput.value.trim().toLowerCase();
    const role = roleFilter.value;
    return allUsers.filter((u) => {
      if (q && !(u.name.toLowerCase().includes(q) || u.username.toLowerCase().includes(q))) return false;
      if (role && u.role !== role) return false;
      return true;
    });
  }

  function renderUsers() {
    const users = getFiltered();
    if (!users.length) {
      usersList.innerHTML = '<div class="empty">No hay usuarios con esos filtros.</div>';
      return;
    }
    usersList.innerHTML = users.map((u) => `
      <div class="user-item ${u.active ? '' : 'inactive'}" data-id="${u.id}">
        <div class="user-top">
          <span class="user-name">${escapeHtml(u.name)}</span>
          <span class="badge">${u.active ? 'Activo' : 'Inactivo'}</span>
        </div>
        <div class="user-meta">Usuario: ${escapeHtml(u.username)}</div>
        <div class="user-controls">
          <select data-action="role" data-id="${u.id}">
            ${roles.map((r) => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}
          </select>
          <button class="btn-small" data-action="reset-password" data-id="${u.id}" type="button">Restablecer clave</button>
          <button class="btn-small ${u.active ? 'btn-delete' : 'btn-done'}" data-action="toggle-active" data-id="${u.id}" type="button">
            ${u.active ? 'Desactivar' : 'Activar'}
          </button>
        </div>
      </div>
    `).join('');
  }

  function loadUsers() {
    fetch('/api/users')
      .then((res) => res.json())
      .then((data) => {
        if (!data || !Array.isArray(data.users)) {
          usersList.innerHTML = '<div class="empty">No se pudo cargar.</div>';
          return;
        }
        allUsers = data.users;
        roles = data.roles || [];
        renderUsers();
      })
      .catch(() => {
        usersList.innerHTML = '<div class="empty">No se pudo cargar.</div>';
      });
  }

  searchInput.addEventListener('input', renderUsers);
  roleFilter.addEventListener('change', renderUsers);

  userForm.addEventListener('submit', function (e) {
    e.preventDefault();
    userFormError.style.display = 'none';
    const username = document.getElementById('u-username').value.trim();
    const name = document.getElementById('u-name').value.trim();
    const role = document.getElementById('u-role').value;
    const password = document.getElementById('u-password').value;
    if (!username || !name || !role || !password) return;

    const submitBtn = userForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, name, role, password }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo crear el usuario.');
        userForm.reset();
        loadUsers();
      })
      .catch((err) => {
        userFormError.textContent = err.message || 'No se pudo crear el usuario.';
        userFormError.style.display = 'block';
      })
      .finally(() => { submitBtn.disabled = false; });
  });

  seedBtn.addEventListener('click', function () {
    if (!confirm('¿Cargar los empleados del archivo? Se crearán los que falten con clave 1234.')) return;
    seedBtn.disabled = true;
    fetch('/api/seed-users', { method: 'POST' })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo cargar la lista.');
        seedResult.textContent = `${data.created} usuario(s) creados, ${data.skipped} ya existían u omitidos.`;
        seedResult.style.display = 'block';
        loadUsers();
      })
      .catch((err) => {
        seedResult.textContent = err.message || 'No se pudo cargar la lista.';
        seedResult.style.display = 'block';
      })
      .finally(() => { seedBtn.disabled = false; });
  });

  usersList.addEventListener('change', function (e) {
    const el = e.target;
    if (el.getAttribute('data-action') !== 'role') return;
    const id = el.getAttribute('data-id');
    fetch('/api/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, role: el.value }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'No se pudo actualizar.');
        }
        loadUsers();
      })
      .catch((err) => { alert(err.message || 'No se pudo actualizar.'); loadUsers(); });
  });

  usersList.addEventListener('click', function (e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    const action = btn.getAttribute('data-action');

    if (action === 'toggle-active') {
      const user = allUsers.find((u) => u.id === id);
      if (!user) return;
      const nextActive = !user.active;
      if (!nextActive && !confirm('¿Desactivar este usuario? No podrá iniciar sesión.')) return;
      fetch('/api/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, active: nextActive }),
      })
        .then(async (res) => {
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'No se pudo actualizar.');
          }
          loadUsers();
        })
        .catch((err) => alert(err.message || 'No se pudo actualizar.'));
    } else if (action === 'reset-password') {
      const password = prompt('Nueva contraseña para este usuario (mín. 8 caracteres):');
      if (!password) return;
      fetch('/api/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, password }),
      })
        .then(async (res) => {
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'No se pudo cambiar la clave.');
          }
          alert('Contraseña actualizada.');
        })
        .catch((err) => alert(err.message || 'No se pudo cambiar la clave.'));
    }
  });

  loadUsers();
});
