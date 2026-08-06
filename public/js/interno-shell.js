document.addEventListener('DOMContentLoaded', function () {
  const userId = document.body.dataset.userId;
  const openBtn = document.getElementById('changePasswordBtn');
  const overlay = document.getElementById('pwModalOverlay');
  const cancelBtn = document.getElementById('pwCancel');
  const submitBtn = document.getElementById('pwSubmit');
  const currentInput = document.getElementById('pwCurrent');
  const newInput = document.getElementById('pwNew');
  const errorEl = document.getElementById('pwError');
  const successEl = document.getElementById('pwSuccess');

  if (!openBtn || !overlay) return;

  function closeModal() {
    overlay.style.display = 'none';
    currentInput.value = '';
    newInput.value = '';
    errorEl.style.display = 'none';
    successEl.style.display = 'none';
  }

  openBtn.addEventListener('click', function () {
    overlay.style.display = 'flex';
  });
  cancelBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) closeModal();
  });

  submitBtn.addEventListener('click', function () {
    errorEl.style.display = 'none';
    successEl.style.display = 'none';
    const currentPassword = currentInput.value;
    const password = newInput.value;

    if (!currentPassword || !password) {
      errorEl.textContent = 'Completa ambos campos.';
      errorEl.style.display = 'block';
      return;
    }
    if (password.length < 8) {
      errorEl.textContent = 'La nueva contraseña debe tener al menos 8 caracteres.';
      errorEl.style.display = 'block';
      return;
    }

    submitBtn.disabled = true;
    fetch('/api/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: userId, currentPassword, password }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo cambiar la contraseña.');
        successEl.style.display = 'block';
        currentInput.value = '';
        newInput.value = '';
        setTimeout(closeModal, 1500);
      })
      .catch((err) => {
        errorEl.textContent = err.message || 'No se pudo cambiar la contraseña.';
        errorEl.style.display = 'block';
      })
      .finally(() => {
        submitBtn.disabled = false;
      });
  });
});
