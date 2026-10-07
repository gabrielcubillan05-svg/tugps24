document.addEventListener('DOMContentLoaded', function () {
  // AbortSignal.timeout no existe en navegadores de antes de mediados de 2022: con un AbortController se logra lo mismo.
  const timeoutSignal = (ms) => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : ((c) => (setTimeout(() => c.abort(), ms), c.signal))(new AbortController()));
  const form = document.getElementById('simUploadForm');
  if (!form) return;
  const filesInput = document.getElementById('simFiles');
  const planInput = document.getElementById('simPlanMb');
  const limitInput = document.getElementById('simLimitMb');
  const periodStartInput = document.getElementById('simPeriodStart');
  const periodEndInput = document.getElementById('simPeriodEnd');
  const labelInput = document.getElementById('simLabel');
  const preview = document.getElementById('simPreview');
  const uploadBtn = document.getElementById('simUploadBtn');
  const uploadStatus = document.getElementById('simUploadStatus');
  const lotesEl = document.getElementById('simLotes');
  const detailEl = document.getElementById('simDetail');

  let parsed = null; // { lines: [], files: [{name, rows, lines}], rowCount, period }
  let isAdmin = false;
  let currentLote = null;

  function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtNum(n, d) {
    return Number(n || 0).toLocaleString('es-CO', { maximumFractionDigits: d === undefined ? 0 : d, minimumFractionDigits: d === undefined ? 0 : d });
  }
  function fmtMb(mb) {
    return mb >= 1024 ? fmtNum(mb / 1024, 2) + ' GB' : fmtNum(mb, 1) + ' MB';
  }
  function fmtDateTime(iso) {
    return iso ? new Date(iso).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' }) : '';
  }
  function fmtDay(ymd) {
    if (!ymd) return '';
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function periodLabel(a, b) {
    return `${fmtDay(a)} al ${fmtDay(b)}`;
  }
  function clean(v) {
    return String(v || '').trim().replace(/^['"]+|['"]+$/g, '').replace(/^'/, '').trim();
  }

  // FECHA llega como 20261005; si alguien la reescribió como 05/10/2026 también se entiende.
  function parseDay(v) {
    const s = clean(v);
    let m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
    if (m) return m[1] + m[2] + m[3];
    m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (m) return m[3] + m[2] + m[1];
    return '';
  }

  // El operador escribe los KB con coma de miles y punto decimal ("1,612.12" = 1612,12 KB).
  // Si solo trae coma, se toma como decimal; si trae las dos, la coma es de miles.
  function num(v) {
    const s = clean(v);
    if (!s) return 0;
    const t = s.includes(',') && s.includes('.') ? s.replace(/,/g, '') : s.replace(',', '.');
    const n = parseFloat(t);
    return Number.isFinite(n) ? n : 0;
  }

  // --- Lectura y agregado de los CSV del operador, en el navegador ---
  function parseCsvText(text, fileName, acc) {
    const rows = text.split(/\r?\n/);
    let headerIdx = -1;
    let delim = ';';
    for (let i = 0; i < Math.min(rows.length, 20); i++) {
      const up = rows[i].toUpperCase();
      if (up.includes('NUMERO') && up.includes('TOTAL_KB')) {
        headerIdx = i;
        delim = rows[i].includes(';') ? ';' : rows[i].includes('\t') ? '\t' : ',';
        break;
      }
    }
    if (headerIdx < 0) throw new Error(`${fileName}: no se encontró la cabecera (FECHA;NUMERO;...;TOTAL_KB)`);
    const header = rows[headerIdx].split(delim).map((h) => clean(h).toUpperCase());
    const col = (name) => header.indexOf(name);
    const iFecha = col('FECHA'), iNum = col('NUMERO'), iCta = col('CUSTCODE_MTR'), iImei = col('IMEI_IDENTIFICADOR_MOVIL'), iTot = col('TOTAL_KB');
    if (iFecha < 0 || iNum < 0 || iTot < 0) throw new Error(`${fileName}: faltan columnas FECHA, NUMERO o TOTAL_KB`);
    let count = 0;
    const seen = new Set();
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row.trim()) continue;
      const cells = row.split(delim);
      const numero = clean(cells[iNum]).replace(/\D/g, '');
      if (!numero) continue;
      const fecha = parseDay(cells[iFecha]);
      const total = num(cells[iTot]);
      const cuenta = iCta >= 0 ? clean(cells[iCta]) : '';
      const imei = iImei >= 0 ? clean(cells[iImei]).replace(/\D/g, '') : '';
      let line = acc.get(numero);
      if (!line) {
        line = { n: numero, c: cuenta, i: new Set(), kb: 0, d: {} };
        acc.set(numero, line);
      }
      if (!line.c && cuenta) line.c = cuenta;
      if (imei) line.i.add(imei);
      line.kb += total;
      if (fecha.length === 8) line.d[fecha] = (line.d[fecha] || 0) + total;
      seen.add(numero);
      count++;
    }
    return { rows: count, lines: seen.size };
  }

  function readFileText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error(`No se pudo leer ${file.name}`));
      reader.readAsText(file, 'utf-8');
    });
  }

  async function parseFiles(fileList) {
    const acc = new Map();
    const files = [];
    let rowCount = 0;
    for (const file of fileList) {
      if (/\.xlsx?$/i.test(file.name)) throw new Error(`${file.name} es un Excel: guárdalo como CSV (separado por punto y coma) y vuelve a subirlo.`);
      const text = await readFileText(file);
      const r = parseCsvText(text, file.name, acc);
      files.push({ name: file.name, rows: r.rows, lines: r.lines });
      rowCount += r.rows;
    }
    // Compacto para que nueve o más archivos quepan en una sola subida: los días van como
    // arreglo alineado a la lista de fechas, no como objeto por línea.
    const days = [...new Set([...acc.values()].flatMap((l) => Object.keys(l.d)))].sort();
    const lines = [...acc.values()].map((l) => ({
      n: l.n,
      c: l.c,
      i: [...l.i],
      kb: Math.round(l.kb * 10) / 10,
      d: days.map((day) => Math.round((l.d[day] || 0) * 10) / 10),
    }));
    const fmt = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    return { lines, days, files, rowCount, period: days.length ? { start: fmt(days[0]), end: fmt(days[days.length - 1]), days: days.length } : null };
  }

  filesInput.addEventListener('change', async function () {
    parsed = null;
    uploadBtn.disabled = true;
    preview.hidden = false;
    preview.innerHTML = '<span class="hint">Leyendo archivos...</span>';
    try {
      const result = await parseFiles(Array.from(filesInput.files || []));
      if (!result.lines.length) throw new Error('Los archivos no traen líneas con número.');
      parsed = result;
      // Periodo: primero el del nombre del archivo (CONSUMOS_DATOS_0232_2026-09-29_2026-10-06),
      // si no, las fechas con datos. Siempre editable.
      const names = result.files.map((f) => f.name).join(' ');
      const fromName = names.match(/(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})/);
      if (!periodStartInput.value) periodStartInput.value = fromName ? fromName[1] : result.period ? result.period.start : '';
      if (!periodEndInput.value) periodEndInput.value = fromName ? fromName[2] : result.period ? result.period.end : '';
      const totalMb = result.lines.reduce((s, l) => s + l.kb, 0) / 1024;
      const sizeKb = Math.round(JSON.stringify(result.lines).length / 1024);
      preview.innerHTML = `
        <table>${result.files.map((f) => `<tr><td>${escapeHtml(f.name)}</td><td>${fmtNum(f.rows)} registros · ${fmtNum(f.lines)} líneas</td></tr>`).join('')}</table>
        <p style="margin:8px 0 0;"><b>${fmtNum(result.lines.length)}</b> líneas distintas en ${result.files.length} archivo(s) · ${fmtNum(result.rowCount)} registros · ${fmtMb(totalMb)} en total.
        ${result.period ? `Fechas con datos: <b>${periodLabel(result.period.start, result.period.end)}</b> (${result.period.days} día(s)). Revisa arriba el periodo declarado del reporte.` : '<b style="color:#ef4444">Sin fechas válidas.</b>'}</p>
        <p class="hint" style="margin:4px 0 0;">Se subirá un resumen de ${fmtNum(sizeKb)} KB, no los archivos completos.</p>`;
      uploadBtn.disabled = !result.period || sizeKb > 4000;
      if (sizeKb > 4000) preview.insertAdjacentHTML('beforeend', '<p style="color:#ef4444">El resumen pasa de 4 MB: sube los archivos en dos lotes.</p>');
    } catch (err) {
      preview.innerHTML = `<span style="color:#ef4444">${escapeHtml(err.message || 'No se pudieron leer los archivos')}</span>`;
    }
  });

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    if (!parsed) return;
    const periodStart = periodStartInput.value;
    const periodEnd = periodEndInput.value;
    if (!periodStart || !periodEnd || periodStart > periodEnd) {
      uploadStatus.textContent = 'Indica el periodo del reporte: de tal fecha a tal fecha, en ese orden.';
      return;
    }
    if (parsed.period && (parsed.period.start < periodStart || parsed.period.end > periodEnd)) {
      if (!confirm(`Los archivos traen datos del ${periodLabel(parsed.period.start, parsed.period.end)}, fuera del periodo declarado (${periodLabel(periodStart, periodEnd)}). ¿Subir igual?`)) return;
    }
    uploadBtn.disabled = true;
    try {
      // Por bloques de 1.000 líneas (unos 120 KB cada uno) con reintento: un solo envío grande
      // se cortaba en conexiones de oficina.
      const CHUNK = 1000;
      const uploadId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
      const total = Math.ceil(parsed.lines.length / CHUNK);
      for (let i = 0; i < total; i++) {
        uploadStatus.textContent = `Subiendo bloque ${i + 1} de ${total}...`;
        const chunk = parsed.lines.slice(i * CHUNK, (i + 1) * CHUNK);
        await postWithRetry({ action: 'chunk', uploadId, index: i, lines: chunk }, 3);
      }
      uploadStatus.textContent = 'Armando el lote y calculando los cruces...';
      const data = await postWithRetry({ action: 'commit', uploadId, total, periodStart, periodEnd, planMb: Number(planInput.value) || 10, limitMb: Number(limitInput.value) || 15, label: labelInput.value.trim(), files: parsed.files.map((f) => f.name), rowCount: parsed.rowCount, days: parsed.days }, 2, 120000);
      uploadStatus.textContent = data.existing ? 'Este lote ya se había creado; se muestra el existente.' : 'Lote guardado. GPSITO está redactando el informe; aparecerá abajo en un momento.';
      form.reset();
      planInput.value = String(data.lote.planMb || 10);
      limitInput.value = String(data.lote.limitMb || 15);
      preview.hidden = true;
      parsed = null;
      renderDetail(data.lote, '/api/blob-file?path=' + encodeURIComponent(data.lote.blobPath), !!data.analysisPending);
      if (data.analysisPending) pollAnalysis(data.lote.id);
      loadLotes();
    } catch (err) {
      const cut = err && (err.name === 'TypeError' || err.name === 'TimeoutError' || err.name === 'AbortError' || /fetch|timed out/i.test(err.message || ''));
      uploadStatus.textContent = cut
        ? 'La conexión se cortó antes de recibir respuesta. Revisa en la lista de abajo si el lote quedó creado antes de volver a subirlo.'
        : 'No se pudo subir: ' + (err.message || 'intenta de nuevo');
      uploadBtn.disabled = false;
      loadLotes();
    }
  });

  async function postWithRetry(payload, attempts, timeoutMs) {
    let lastErr = null;
    postWithRetry.startedAt = Date.now();
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await fetch('/api/sim-consumos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: timeoutSignal(timeoutMs || 45000),
          body: JSON.stringify(payload),
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 202 && data.inProgress) {
          // El servidor sigue armando el lote de un intento anterior: se espera y se vuelve a preguntar.
          await new Promise((r) => setTimeout(r, 5000));
          attempt--;
          if (Date.now() - (postWithRetry.startedAt || Date.now()) > 240000) throw new Error('el servidor sigue armando el lote; revisa la lista en un momento');
          continue;
        }
        if (!res.ok) {
          // Un 4xx distinto de 409 no mejora reintentando.
          if (res.status >= 400 && res.status < 500 && res.status !== 409 && res.status !== 408) throw Object.assign(new Error(data.error || `error ${res.status}`), { final: true });
          throw new Error(data.error || `error ${res.status}`);
        }
        return data;
      } catch (err) {
        lastErr = err;
        if (err && err.final) throw err;
        if (attempt < attempts) await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    throw lastErr || new Error('sin respuesta');
  }

  // --- Lotes ---
  async function loadLotes() {
    let res;
    let data;
    try {
      res = await fetch('/api/sim-consumos', { signal: timeoutSignal(30000) });
      data = await res.json().catch(() => ({}));
    } catch (err) {
      lotesEl.innerHTML = `<div class="empty">No se pudo cargar la lista: ${escapeHtml(err.message || 'sin conexión')}.</div>`;
      return;
    }
    if (!res.ok || !Array.isArray(data.lotes)) {
      lotesEl.innerHTML = `<div class="empty">No se pudo cargar (HTTP ${res.status})${data.error ? ': ' + escapeHtml(data.error) : ''}.</div>`;
      return;
    }
    isAdmin = !!data.isAdmin;
    if (data.defaultPlanMb && !planInput.value) planInput.value = data.defaultPlanMb;
    if (data.defaultLimitMb && !limitInput.value) limitInput.value = data.defaultLimitMb;
    if (!data.lotes.length) {
      lotesEl.innerHTML = '<div class="empty">Todavía no hay lotes. Sube los archivos del operador arriba.</div>';
      return;
    }
    lotesEl.innerHTML = data.lotes.map((l) => `
      <div class="sim-lote" data-id="${l.id}">
        <div>
          <div><b>${escapeHtml(l.label)}</b> <span class="sim-tag">del ${periodLabel(l.periodStart, l.periodEnd)}</span></div>
          <div class="meta">${l.files.length} archivo(s) · ${l.accounts.length} cuenta(s) · subido ${fmtDateTime(l.uploadedAt)} por ${escapeHtml(l.uploadedByName)}${l.hasAnalysis ? ' · con informe' : l.analysisPending ? ' · informe en curso' : ' · sin informe'}</div>
        </div>
        <div class="nums"><b>${fmtNum(l.lineCount)}</b> líneas · <b>${fmtMb(l.totalMb)}</b><br />${l.criticalCount ? `<span style="color:#ef4444">${fmtNum(l.criticalCount)} críticas (más de ${l.limitMb} MB)</span> · ` : ''}${l.overCount ? `<span style="color:#f59e0b">${fmtNum(l.overCount)} sobre el plan de ${l.planMb} MB</span>` : 'ninguna sobre el plan'} · ${l.zeroCount} sin consumo</div>
      </div>`).join('');
    lotesEl.querySelectorAll('.sim-lote').forEach((el) => el.addEventListener('click', () => openLote(el.getAttribute('data-id'))));
  }

  async function openLote(id) {
    detailEl.hidden = false;
    detailEl.innerHTML = '<div class="panel-card"><div class="empty">Cargando lote...</div></div>';
    detailEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    let res;
    let data;
    try {
      res = await fetch('/api/sim-consumos?id=' + encodeURIComponent(id), { signal: timeoutSignal(30000) });
      data = await res.json().catch(() => ({}));
    } catch (err) {
      detailEl.innerHTML = `<div class="panel-card"><div class="empty">No se pudo cargar: ${escapeHtml(err.message || 'sin conexión')}.</div></div>`;
      return;
    }
    if (!res.ok || !data.lote) {
      detailEl.innerHTML = `<div class="panel-card"><div class="empty">No se pudo cargar (HTTP ${res.status}).</div></div>`;
      return;
    }
    renderDetail(data.lote, data.blobUrl, data.analysisPending);
    if (data.analysisPending) pollAnalysis(data.lote.id);
  }

  // Mientras GPSITO redacta (en el servidor, después de responder), se consulta el lote cada 5 s.
  const pollTimers = {};
  function pollAnalysis(id) {
    clearTimeout(pollTimers[id]);
    const startedAt = Date.now();
    const tick = async () => {
      if (!currentLote || currentLote.id !== id) return;
      try {
        const res = await fetch('/api/sim-consumos?id=' + encodeURIComponent(id), { signal: timeoutSignal(20000) });
        const data = await res.json().catch(() => ({}));
        // Si mientras respondía la persona abrió otro lote, no se pinta encima.
        if (!currentLote || currentLote.id !== id) return;
        if (res.ok && data.lote) {
          if (data.lote.analysis || !data.analysisPending) {
            renderDetail(data.lote, data.blobUrl, false);
            loadLotes();
            return;
          }
        }
      } catch { /* se reintenta */ }
      if (Date.now() - startedAt < 4 * 60000) pollTimers[id] = setTimeout(tick, 5000);
      else {
        const report = document.getElementById('simReport');
        if (report) report.innerHTML = '<p class="hint" style="margin:0;">GPSITO no terminó el informe en cuatro minutos. Pulsa "Generar informe" para intentarlo de nuevo.</p>';
      }
    };
    pollTimers[id] = setTimeout(tick, 4000);
  }

  // Render mínimo del informe de GPSITO (títulos, negritas, listas, párrafos).
  function renderReport(text) {
    const lines = String(text || '').split(/\r?\n/);
    let html = '';
    let list = null;
    const flush = () => { if (list) { html += `</${list}>`; list = null; } };
    const inline = (s) => escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
    for (const raw of lines) {
      const l = raw.trim();
      if (!l) { flush(); continue; }
      const h = l.match(/^#{1,4}\s+(.*)$/);
      if (h) { flush(); html += `<h5>${inline(h[1])}</h5>`; continue; }
      const ul = l.match(/^[-*•]\s+(.*)$/);
      if (ul) { if (list !== 'ul') { flush(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(ul[1])}</li>`; continue; }
      const ol = l.match(/^\d+[.)]\s+(.*)$/);
      if (ol) { if (list !== 'ol') { flush(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(ol[1])}</li>`; continue; }
      flush();
      html += `<p>${inline(l)}</p>`;
    }
    flush();
    return html;
  }

  function table(headers, rows, emptyText) {
    if (!rows.length) return `<p class="hint" style="margin:0;">${escapeHtml(emptyText)}</p>`;
    return `<div class="table-scroll"><table class="sim-table"><thead><tr>${headers.map((h) => `<th class="${h.left ? 'l' : ''}">${escapeHtml(h.label)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  }

  // Excel en español: separador ";", coma decimal y BOM para que abra con tildes. Una fila por
  // línea, con el mismo criterio de estado que el informe (plan y máximo del lote).
  async function descargarCsv(lote, blobUrl, btn) {
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Preparando...';
    try {
      const res = await fetch(blobUrl, { signal: timeoutSignal ? timeoutSignal(60000) : undefined });
      if (!res.ok) throw new Error('No se pudo leer el archivo de líneas (' + res.status + ')');
      const lines = await res.json();
      const s = lote.stats;
      const dias = (s.days && s.days.length) || Math.max(1, Math.round((Date.parse(lote.periodEnd) - Date.parse(lote.periodStart)) / 86400000) + 1);
      const planMb = lote.planMb || 10;
      const limitMb = lote.limitMb || s.limitMb || 15;
      const num = (v, d) => Number(v || 0).toFixed(d).replace('.', ',');
      const cell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
      const rows = lines.map((l) => {
        const mb = (l.kb || 0) / 1024;
        const mesMb = (mb * 30) / dias;
        const diasUso = Object.values(l.d || {}).filter((kb) => kb > 0).length;
        const imeis = Array.isArray(l.i) ? l.i : [];
        let estado = 'Normal';
        if (mb <= 0) estado = 'Sin consumo';
        else if (mesMb > limitMb) estado = 'Crítico (más de ' + limitMb + ' MB/mes)';
        else if (mesMb > planMb) estado = 'Sobre el plan (' + planMb + ' MB/mes)';
        else if (imeis.length > 1) estado = 'Varios IMEI';
        return { l, mb, mesMb, diasUso, imeis, estado };
      });
      rows.sort((a, b) => b.mb - a.mb);
      const head = ['Línea', 'Cuenta', 'MB en el periodo', 'MB/mes proyectado', 'Días con consumo', 'Estado', 'IMEI', 'Subida MB', 'Bajada MB'];
      const body = rows.map((r) => [cell(r.l.n), cell(r.l.c), num(r.mb, 2), num(r.mesMb, 1), r.diasUso, cell(r.estado), cell(r.imeis.join(' | ')), num((r.l.u || 0) / 1024, 2), num((r.l.b || 0) / 1024, 2)].join(';'));
      const meta = [
        cell('Lote'), cell(lote.label),
      ].join(';') + '\n' + [cell('Periodo'), cell(periodLabel(lote.periodStart, lote.periodEnd))].join(';') + '\n' + [cell('Plan MB/mes'), planMb, cell('Máximo MB/mes'), limitMb].join(';') + '\n\n';
      const csv = '\ufeff' + meta + head.join(';') + '\n' + body.join('\n') + '\n';
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `consumo-sim_${lote.periodStart}_a_${lote.periodEnd}.csv`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    } catch (err) {
      alert('No se pudo descargar: ' + ((err && err.message) || err));
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  function renderDetail(lote, blobUrl, pending) {
    currentLote = lote;
    const s = lote.stats;
    const dayKeys = Object.keys(s.perDayMb);
    const maxDay = Math.max(1, ...dayKeys.map((k) => s.perDayMb[k]));
    const accRows = Object.entries(s.perAccount).sort((a, b) => b[1].mb - a[1].mb).map(([c, a]) => `<tr><td class="l mono">${escapeHtml(c)}</td><td>${fmtNum(a.lines)}</td><td>${fmtMb(a.mb)}</td><td>${fmtNum(a.medianMb, 2)} MB</td><td>${a.over ? `<span style="color:#f59e0b">${a.over}</span>` : 0}</td><td>${a.critical ? `<span style="color:#ef4444">${a.critical}</span>` : 0}</td><td>${a.zero}</td><td>${a.multiImei}</td></tr>`);
    const limitMb = lote.limitMb || s.limitMb || 15;
    const overRows = s.over.top.map((l) => `<tr><td class="l mono">${escapeHtml(l.n)}</td><td class="l mono">${escapeHtml(l.c)}</td><td>${fmtNum(l.mb, 1)}</td><td><b style="${l.mesMb > limitMb ? 'color:#ef4444' : ''}">${fmtNum(l.mesMb, 0)}</b>${l.mesMb > limitMb ? ' <span class="sim-tag" style="color:#ef4444">crítica</span>' : ''}</td><td>${l.dias}</td><td>${fmtNum(l.picoMb, 1)} (${fmtDay(l.picoDia)})</td><td class="l mono">${escapeHtml(l.imeis.join(', '))}</td></tr>`);
    const zeroRows = s.zero.lines.map((z) => `<tr><td class="l mono">${escapeHtml(z.n)}</td><td class="l mono">${escapeHtml(z.c)}</td><td class="l mono">${escapeHtml(z.imeis.join(', '))}</td><td class="l">${z.inInventory ? '<span class="sim-tag ok">En inventario</span>' : '<span class="sim-tag bad">No está en inventario</span>'}</td></tr>`);
    const lowRows = s.lowActivity.top.map((l) => `<tr><td class="l mono">${escapeHtml(l.n)}</td><td class="l mono">${escapeHtml(l.c)}</td><td>${l.dias}</td><td>${fmtNum(l.mb, 2)}</td><td class="l mono">${escapeHtml(l.imeis.join(', '))}</td></tr>`);
    const multiRows = s.multiImei.lines.map((l) => `<tr><td class="l mono">${escapeHtml(l.n)}</td><td class="l mono">${escapeHtml(l.c)}</td><td class="l mono">${escapeHtml(l.imeis.join(' → '))}</td><td>${fmtNum(l.mb, 1)}</td></tr>`);
    const imeiRows = s.imeiMultiLine.items.map((it) => `<tr><td class="l mono">${escapeHtml(it.imei)}</td><td class="l mono">${escapeHtml(it.lines.join(', '))}</td></tr>`);
    const thr = s.thresholds.map((t) => `<tr><td class="l">Más de ${t.weekMb} MB en el periodo (≈ ${t.monthMb} MB/mes)</td><td>${fmtNum(t.count)}</td></tr>`);
    const prev = s.vsPrevious;

    detailEl.innerHTML = `
      <div class="panel-card">
        <div class="sim-detail-head">
          <div>
            <h3 style="margin:0;">${escapeHtml(lote.label)}</h3>
            <p class="hint" style="margin:4px 0 0;">Periodo del reporte: <b>del ${periodLabel(lote.periodStart, lote.periodEnd)}</b>${lote.dataStart ? ` · datos del ${periodLabel(lote.dataStart, lote.dataEnd)} (${s.days.length} día(s))` : ''} · ${lote.files.length} archivo(s): ${escapeHtml(lote.files.join(', '))} · cuentas ${escapeHtml(lote.accounts.join(', '))} · subido ${fmtDateTime(lote.uploadedAt)} por ${escapeHtml(lote.uploadedByName)}</p>
          </div>
          <div class="actions">
            <label class="hint" style="margin:0;">Plan <input type="number" min="1" id="simDetailPlan" value="${lote.planMb}" /> MB/mes</label>
            <label class="hint" style="margin:0;">Máximo <input type="number" min="1" id="simDetailLimit" value="${lote.limitMb || s.limitMb || 15}" /> MB/mes</label>
            <button class="btn-small" type="button" id="simRecalc">Recalcular</button>
            <button class="btn-small" type="button" id="simReanalyze">${lote.analysis ? 'Rehacer informe' : 'Generar informe'}</button>
            ${blobUrl ? `<button class="btn-small" type="button" id="simCsv" title="Todas las líneas con consumo, proyección mensual, estado e IMEI, para abrir en Excel">Descargar Excel (CSV)</button>` : ''}
            ${isAdmin ? '<button class="btn-small btn-delete" type="button" id="simDelete">Eliminar lote</button>' : ''}
          </div>
        </div>

        <div class="sim-kpis">
          <div class="sim-kpi"><div class="n">${fmtNum(s.lineCount)}</div><div class="l">Líneas (${fmtNum(s.rowCount)} registros)</div></div>
          <div class="sim-kpi"><div class="n">${fmtMb(s.totalMb)}</div><div class="l">Consumo total del periodo</div></div>
          <div class="sim-kpi"><div class="n">${fmtNum(s.medianMb, 2)} MB</div><div class="l">Mediana por línea · p90 ${fmtNum(s.p90Mb, 1)} · máx ${fmtNum(s.maxMb, 1)}</div></div>
          <div class="sim-kpi ${s.over.count ? 'warn' : ''}"><div class="n">${fmtNum(s.over.count)}</div><div class="l">Sobre el plan de ${lote.planMb} MB/mes (proyección a 30 días)</div></div>
          <div class="sim-kpi ${s.critical && s.critical.count ? 'bad' : ''}"><div class="n">${fmtNum(s.critical ? s.critical.count : 0)}</div><div class="l">Críticas: más de ${lote.limitMb || s.limitMb || 15} MB/mes</div></div>
          <div class="sim-kpi ${s.zero.count - s.zero.inInventoryCount ? 'bad' : ''}"><div class="n">${fmtNum(s.zero.count)}</div><div class="l">Sin consumo · ${s.zero.inInventoryCount} en inventario</div></div>
          <div class="sim-kpi ${s.multiImei.count ? 'warn' : ''}"><div class="n">${fmtNum(s.multiImei.count)}</div><div class="l">SIM cambiadas de equipo · ${s.imeiMultiLine.count} equipos con varias SIM</div></div>
        </div>

        <div class="sim-section">
          <h4>Consumo por día <span class="count">MB</span></h4>
          <div class="sim-days">${dayKeys.map((k) => `<div class="bar" style="height:${Math.max(2, Math.round((s.perDayMb[k] / maxDay) * 100))}%"><span>${fmtNum(s.perDayMb[k] / 1024, 2)} GB</span></div>`).join('')}</div>
          <div class="sim-days-labels">${dayKeys.map((k) => `<div>${fmtDay(k)}</div>`).join('')}</div>
        </div>

        <div class="sim-section">
          <h4>Informe de GPSITO <span class="count">${lote.analysis ? 'generado ' + fmtDateTime(lote.analysis.at) : 'sin generar'}</span></h4>
          <div class="sim-report" id="simReport">${lote.analysis ? renderReport(lote.analysis.text) : pending ? '<p class="hint" style="margin:0;">GPSITO está redactando el informe... suele tardar entre 30 segundos y 2 minutos. Esta página se actualiza sola.</p>' : lote.analysisError ? `<p class="hint" style="margin:0;color:#ef4444">El informe no se pudo generar (${escapeHtml(lote.analysisError)}). Pulsa "Generar informe" para reintentar.</p>` : '<p class="hint" style="margin:0;">Pulsa "Generar informe" para que GPSITO analice este lote.</p>'}</div>
          <div class="sim-ask">
            <input type="text" id="simQuestion" maxlength="600" placeholder="Pregúntale a GPSITO sobre este lote (ej. ¿qué pasa con la cuenta 0232?)" />
            <button class="btn-small" type="button" id="simAskBtn">Preguntar</button>
          </div>
          <div id="simQa">${(lote.qa || []).map((x) => `<div class="sim-qa"><div class="q">${escapeHtml(x.q)}</div><div>${renderReport(x.a)}</div></div>`).join('')}</div>
        </div>

        <div class="sim-section">
          <h4>Por cuenta</h4>
          ${table([{ label: 'Cuenta', left: true }, { label: 'Líneas' }, { label: 'Consumo' }, { label: 'Mediana/línea' }, { label: 'Sobre plan' }, { label: 'Críticas' }, { label: 'Sin consumo' }, { label: 'SIM cambiadas' }], accRows, 'Sin cuentas.')}
        </div>

        <div class="sim-section">
          <h4>Sobreconsumo <span class="count">${fmtNum(s.over.count)} líneas superan ${lote.planMb} MB/mes proyectando el periodo a 30 días · ${fmtNum(s.critical ? s.critical.count : 0)} críticas por encima de ${limitMb} MB · se muestran ${s.over.top.length}</span></h4>
          ${table([{ label: 'Línea', left: true }, { label: 'Cuenta', left: true }, { label: 'MB periodo' }, { label: 'MB/mes proy.' }, { label: 'Días activos' }, { label: 'Pico día' }, { label: 'IMEI', left: true }], overRows, 'Ninguna línea supera el plan.')}
          <div style="margin-top:8px;">${table([{ label: 'Umbral', left: true }, { label: 'Líneas' }], thr, '')}</div>
        </div>

        <div class="sim-section">
          <h4>Sin consumo en todo el periodo <span class="count">${fmtNum(s.zero.count)} · ${s.zero.inInventoryCount} están en inventario de sucursal</span></h4>
          ${table([{ label: 'Línea', left: true }, { label: 'Cuenta', left: true }, { label: 'IMEI', left: true }, { label: 'Inventario', left: true }], zeroRows, 'Todas las líneas consumieron algo.')}
        </div>

        <div class="sim-section">
          <h4>Actividad baja <span class="count">${fmtNum(s.lowActivity.count)} líneas con consumo solo 1 o 2 días · se muestran ${s.lowActivity.top.length}</span></h4>
          ${table([{ label: 'Línea', left: true }, { label: 'Cuenta', left: true }, { label: 'Días activos' }, { label: 'MB periodo' }, { label: 'IMEI', left: true }], lowRows, 'Ninguna.')}
        </div>

        <div class="sim-section">
          <h4>SIM cambiadas de equipo <span class="count">${fmtNum(s.multiImei.count)}</span></h4>
          ${table([{ label: 'Línea', left: true }, { label: 'Cuenta', left: true }, { label: 'IMEI en el periodo', left: true }, { label: 'MB' }], multiRows, 'Ninguna SIM cambió de equipo.')}
        </div>

        <div class="sim-section">
          <h4>Equipos con más de una SIM <span class="count">${fmtNum(s.imeiMultiLine.count)}</span></h4>
          ${table([{ label: 'IMEI', left: true }, { label: 'Líneas', left: true }], imeiRows, 'Ninguno.')}
        </div>

        <div class="sim-section">
          <h4>Comparación con el lote anterior <span class="count">${prev ? escapeHtml(prev.previousPeriod) : 'no hay lote anterior'}</span></h4>
          ${prev ? `
            <p style="margin:0 0 8px;">Consumo total ${prev.totalDeltaPct >= 0 ? '+' : ''}${prev.totalDeltaPct}% · ${fmtNum(prev.newLines)} líneas nuevas · ${fmtNum(prev.missingLines)} líneas que ya no aparecen.</p>
            ${table([{ label: 'Línea', left: true }, { label: 'Cuenta', left: true }, { label: 'Antes MB' }, { label: 'Ahora MB' }], prev.jumped.map((j) => `<tr><td class="l mono">${escapeHtml(j.n)}</td><td class="l mono">${escapeHtml(j.c)}</td><td>${fmtNum(j.antesMb, 1)}</td><td><b>${fmtNum(j.ahoraMb, 1)}</b></td></tr>`), 'Ninguna línea triplicó su consumo.')}
            <div style="margin-top:8px;">${table([{ label: 'Línea que pasó a cero', left: true }, { label: 'Cuenta', left: true }, { label: 'Antes MB' }], prev.droppedToZero.map((j) => `<tr><td class="l mono">${escapeHtml(j.n)}</td><td class="l mono">${escapeHtml(j.c)}</td><td>${fmtNum(j.antesMb, 1)}</td></tr>`), 'Ninguna línea con consumo pasó a cero.')}</div>`
          : '<p class="hint" style="margin:0;">Cuando subas el siguiente periodo, aquí verás qué líneas subieron, cuáles dejaron de consumir y cuáles son nuevas.</p>'}
        </div>
      </div>`;

    document.getElementById('simReanalyze').addEventListener('click', () => action('analyze', {}, 'GPSITO está analizando el lote...'));
    const csvBtn = document.getElementById('simCsv');
    if (csvBtn) csvBtn.addEventListener('click', () => descargarCsv(lote, blobUrl, csvBtn));
    document.getElementById('simRecalc').addEventListener('click', () => action('plan', { planMb: Number(document.getElementById('simDetailPlan').value) || 10, limitMb: Number(document.getElementById('simDetailLimit').value) || 15 }, 'Recalculando...'));
    document.getElementById('simAskBtn').addEventListener('click', ask);
    document.getElementById('simQuestion').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ask(); } });
    const del = document.getElementById('simDelete');
    if (del) del.addEventListener('click', async () => {
      if (!confirm(`¿Eliminar el lote "${lote.label}"? Se borra la ficha y el archivo de líneas.`)) return;
      const res = await fetch('/api/sim-consumos', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: lote.id }) });
      if (!res.ok) { alert('No se pudo eliminar.'); return; }
      detailEl.hidden = true;
      detailEl.innerHTML = '';
      loadLotes();
    });
  }

  async function action(name, extra, statusText) {
    if (!currentLote) return;
    const report = document.getElementById('simReport');
    if (report && statusText) report.innerHTML = `<p class="hint" style="margin:0;">${escapeHtml(statusText)}</p>`;
    try {
      const res = await fetch('/api/sim-consumos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: timeoutSignal(120000),
        body: JSON.stringify({ action: name, id: currentLote.id, ...extra }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `error ${res.status}`);
      renderDetail(data.lote, '/api/blob-file?path=' + encodeURIComponent(data.lote.blobPath), !!data.analysisPending);
      if (data.analysisPending) pollAnalysis(data.lote.id);
      loadLotes();
      return true;
    } catch (err) {
      alert(err.message || 'No se pudo completar.');
      if (currentLote) renderDetail(currentLote, '/api/blob-file?path=' + encodeURIComponent(currentLote.blobPath));
      return false;
    }
  }

  async function ask() {
    const input = document.getElementById('simQuestion');
    const q = input.value.trim();
    if (!q || !currentLote) return;
    const qa = document.getElementById('simQa');
    qa.insertAdjacentHTML('afterbegin', `<div class="sim-qa"><div class="q">${escapeHtml(q)}</div><div class="hint">GPSITO está respondiendo...</div></div>`);
    input.value = '';
    const ok = await action('ask', { question: q }, null);
    if (!ok) {
      const again = document.getElementById('simQuestion');
      if (again) again.value = q;
    }
  }

  loadLotes();
});
