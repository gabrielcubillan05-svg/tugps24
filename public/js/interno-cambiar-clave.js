document.addEventListener('DOMContentLoaded', function () {
  const userId = document.body.dataset.userId;
  const form = document.getElementById('changeForm');
  const errorEl = document.getElementById('msgError');
  const successEl = document.getElementById('msgSuccess');
  const submitBtn = document.getElementById('submitBtn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.style.display = 'none';
    const currentPassword = document.getElementById('current').value;
    const password = document.getElementById('fresh').value;
    submitBtn.disabled = true;
    try {
      const res = await fetch('/api/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: userId, currentPassword, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'No se pudo cambiar la contraseña.');
      successEl.style.display = 'block';
      await fetch('/api/auth/logout', { method: 'POST' });
      setTimeout(() => { window.location.href = '/interno/login'; }, 1200);
    } catch (err) {
      errorEl.textContent = err.message || 'No se pudo cambiar la contraseña.';
      errorEl.style.display = 'block';
      submitBtn.disabled = false;
    }
  });
});
