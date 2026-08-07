function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

document.addEventListener('DOMContentLoaded', function () {
  const quoteForm = document.getElementById('quoteForm');
  if (!quoteForm) return;

  const submitBtn = document.getElementById('submitBtn');
  const errorEl = document.getElementById('quoteError');
  const summaryEl = document.getElementById('summary');

  quoteForm.addEventListener('submit', function (e) {
    e.preventDefault();
    errorEl.style.display = 'none';
    summaryEl.style.display = 'none';

    const client = document.getElementById('client').value.trim();
    const document_ = document.getElementById('document').value.trim();
    const email = document.getElementById('email').value.trim();
    const branch = document.getElementById('branch').value;
    const motos = parseInt(document.getElementById('motos').value, 10) || 0;
    const carros = parseInt(document.getElementById('carros').value, 10) || 0;

    if (motos + carros <= 0) {
      errorEl.textContent = 'Indica al menos un vehículo (moto o carro).';
      errorEl.style.display = 'block';
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Generando PDF...';

    fetch('/api/generate-quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client, document: document_, email, branch, motos, carros }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'No se pudo generar la cotización.');
        }
        return res.blob();
      })
      .then((blob) => {
        const safeName = (client || 'cliente').replace(/[^a-zA-Z0-9]/g, '_');
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Cotizacion-TuGPS24-${safeName}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);

        const total = motos + carros;
        const flota = total > 5;
        summaryEl.innerHTML = `Cotización generada${client ? ' para <b>' + escapeHtml(client) + '</b>' : ''}: ${motos} moto(s) + ${carros} carro(s)` +
          (flota ? ' · tarifa de flota aplicada ($39.000/mes c/u)' : '') + '.';
        summaryEl.style.display = 'block';
      })
      .catch((err) => {
        errorEl.textContent = err.message || 'No se pudo generar la cotización.';
        errorEl.style.display = 'block';
      })
      .finally(() => {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Generar cotización PDF';
      });
  });
});
