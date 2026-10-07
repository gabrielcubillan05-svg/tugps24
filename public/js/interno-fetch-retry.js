// Reintento automático de peticiones del panel que mueren por un corte de red ("Failed to fetch").
// Solo para GET (volver a pedir una lectura no duplica nada); los POST/PATCH se dejan tal cual
// para no repetir una acción. Se carga antes que el resto de scripts del panel.
(function () {
  if (typeof window === 'undefined' || !window.fetch || window.__tugpsFetchRetry) return;
  window.__tugpsFetchRetry = true;
  const original = window.fetch.bind(window);
  const DELAYS_MS = [700, 1800];
  const esCorteDeRed = (err) => err && err.name !== 'AbortError' && /failed to fetch|networkerror|load failed|network request failed/i.test(String(err.message || err));
  const esGetPropio = (input, init) => {
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return false;
    const url = typeof input === 'string' ? input : input && input.url;
    return typeof url === 'string' && (url.startsWith('/') || url.startsWith(location.origin));
  };
  window.fetch = async function (input, init) {
    if (!esGetPropio(input, init)) return original(input, init);
    for (let intento = 0; ; intento++) {
      try {
        return await original(input, init);
      } catch (err) {
        const abortado = init && init.signal && init.signal.aborted;
        if (abortado || !esCorteDeRed(err) || intento >= DELAYS_MS.length) throw err;
        await new Promise((r) => setTimeout(r, DELAYS_MS[intento]));
      }
    }
  };
})();
