// Robot de pagos: conecta Optimus (GeneXus, sistema de pagos) con el panel interno.
//   1) ingesta: trae al panel los pagos PENDIENTES (amarillos) con su comprobante, para que
//      GPSITO los verifique;
//   2) aplicación: aprueba en Optimus los que el panel dejó en verde o aprobó a mano.
// Corre fuera de Vercel (GitHub Actions o un VPS).
//
// Variables de entorno:
//   PANEL_URL, ROBOT_PAGOS_TOKEN   panel y su clave para /api/verificacion-pagos-robot
//   GENEXUS_URL, GENEXUS_USER, GENEXUS_PASS   Optimus y el usuario exclusivo del robot
//   MODO   latido | verificar-acceso | explorar-pagos | ingestar (solo trae, no aprueba) | aplicar (trae y aprueba)
//   MAX_POR_CICLO   cuántos pagos aprobar por corrida (por defecto 5)
//
// Estructura de Optimus verificada el 2026-10-07 (modo explorar-pagos):
//   lista   erp.paymentww.aspx, grilla #GridContainerTbl, filas tr#GridContainerRow_NNNN con
//           span_PAYMENTID_NNNN, span_PAYMENTNUMBER_NNNN, span_PAYMENTDATE_NNNN (dd/mm/aa),
//           span_vPAYMENTTYPEWITHTAGS_NNNN (icono con data-original-title Pendiente/Aprobado/Denegado),
//           span_PAYMENTCLIENTID_NNNN, span_PAYMENTCLIENTNAME_NNNN, span_PAYMENTCLIENTFISCAL_NNNN,
//           span_PAYMENTBRANCHOFFICENAME_NNNN, span_PAYMENTMOUNT_NNNN; filtro de Tipo en la columna.
//   cuadro  erp.paymentstatusconfirm.aspx?PaymentId=…&PaymentClientId=…&PaymentNumber=…&… con
//           #vPAYMENTMOUNT, #vPAYMENTWAYREF, combos Contrato (#vNEWCONTRACTID) y Forma de pago
//           (#vPAYMENTWAYCODE), info #vCLIENTACCOUNTSTATUS #vMINPAY #vRECONNECT #vPENDINGPAY
//           #vTOTALPAY, imagen #PAYMENT_PAYMENTIMAGE, botones #BTNAPROVED #BTNDENIED.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const PANEL_URL = (process.env.PANEL_URL || '').replace(/\/$/, '');
const TOKEN = process.env.ROBOT_PAGOS_TOKEN || '';
const BASE = (process.env.GENEXUS_URL || 'https://core.optimus.tugps24.com/').replace(/\/$/, '');
const MODO = process.env.MODO || 'latido';
const MAX_POR_CICLO = Math.max(1, Number(process.env.MAX_POR_CICLO) || 5);
const LOGIN_PATH = 'gamexamplelogin.aspx';
const PAGOS_PATH = 'erp.paymentww.aspx';
const CONFIRM_PATH = 'erp.paymentstatusconfirm.aspx';

if (!PANEL_URL || !TOKEN) {
  console.error('Faltan PANEL_URL o ROBOT_PAGOS_TOKEN');
  process.exit(1);
}
mkdirSync('salida', { recursive: true });

// ---------------------------------------------------------------- panel
const api = (path, init = {}) =>
  fetch(`${PANEL_URL}/api/verificacion-pagos-robot${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(90_000),
  });

async function pendientesDelPanel(limit) {
  const res = await api(`?limit=${limit}`);
  if (!res.ok) throw new Error(`El panel respondió ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return res.json();
}

async function reportar(id, result, detail, screenshotBuffer) {
  const body = { id, result, detail: String(detail || '').slice(0, 400) };
  if (screenshotBuffer) body.screenshot = screenshotBuffer.toString('base64');
  const res = await api('', { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) console.error('No se pudo reportar', id, res.status, await res.text().catch(() => ''));
}

async function ingestarEnPanel(pago, imagenBase64) {
  const res = await api('', { method: 'POST', body: JSON.stringify({ action: 'ingest', ...pago, file: imagenBase64 }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`ingesta rechazada (${res.status}): ${data.error || ''}`);
  return data;
}

// ---------------------------------------------------------------- Optimus
async function iniciarSesion(page) {
  // Por home.aspx, como una persona: GAM guarda la página de vuelta. Entrando directo al login,
  // al terminar mandaba a "notauthorized" aunque el usuario tuviera permisos.
  await page.goto(`${BASE}/home.aspx`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (page.url().toLowerCase().includes(LOGIN_PATH)) {
    await page.waitForSelector('#vUSERNAME', { timeout: 30_000 });
    await page.fill('#vUSERNAME', process.env.GENEXUS_USER || '');
    await page.fill('#vUSERPASSWORD', process.env.GENEXUS_PASS || '');
    await page.click('#BTNENTER');
    try {
      await page.waitForURL((u) => !u.toString().toLowerCase().includes(LOGIN_PATH), { timeout: 20_000 });
    } catch {
      const aviso = await page.locator('.gx-warning-message, #gxErrorViewer, .ErrorViewer, [id*="ERROR"], .gx-message').allInnerTexts().catch(() => []);
      throw new Error('No se pudo iniciar sesión en Optimus' + (aviso.length ? ': ' + aviso.join(' ').trim().slice(0, 160) : ''));
    }
  }
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  console.log('Tras entrar:', page.url());
}

async function irAPagos(page) {
  await page.goto(`${BASE}/${PAGOS_PATH}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  const url = page.url().toLowerCase();
  if (url.includes(LOGIN_PATH)) throw new Error('Optimus pidió iniciar sesión otra vez al abrir Pagos: usuario o clave del robot incorrectos');
  if (url.includes('notauthorized')) throw new Error('El usuario del robot no tiene permiso para ver Administrativa → Pagos: revisar su rol en Seguridad GAM');
  await page.waitForSelector('#GridContainerTbl', { timeout: 30_000 });
}

// Deja el filtro de la columna Tipo en "Pendiente" (WorkWithPlus recuerda el filtro por usuario;
// se comprueba y solo se toca si hace falta).
async function filtrarPendientes(page) {
  const th = page.locator('#GridContainerTbl th').filter({ hasText: /Tipo/ }).first();
  const yaFiltrado = await th.locator('.FilterOptions a[sel="T"] span[dsc="Pendiente"]').count().catch(() => 0);
  if (yaFiltrado) return;
  await th.locator('button.dropdown-toggle').first().click();
  await page.waitForTimeout(500);
  await th.locator('.FilterOptions a:has(span[dsc="Pendiente"])').first().click();
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(800);
}

function textoDe(tr, sufijo, n) {
  return tr.locator(`#span_${sufijo}_${n}`).innerText().then((t) => t.trim()).catch(() => '');
}

// Lee las filas visibles de la grilla.
async function leerFilas(page) {
  const filas = page.locator('tr[id^="GridContainerRow_"]');
  const total = await filas.count();
  const out = [];
  for (let i = 0; i < total; i++) {
    const tr = filas.nth(i);
    const n = (await tr.getAttribute('data-gxrow')) || String(i + 1).padStart(4, '0');
    // Cada pago lleva uno o dos puntos: el estado (Pendiente/Aprobado/Denegado) y, si lo subió el
    // propio cliente, un segundo punto azul "Cargado por el cliente".
    const etiquetas = await tr.locator(`#span_vPAYMENTTYPEWITHTAGS_${n} i`).evaluateAll((els) => els.map((e) => e.getAttribute('data-original-title') || e.getAttribute('title') || '').filter(Boolean)).catch(() => []);
    const estado = etiquetas.find((t) => /pendiente|aprobado|denegado|reconexi/i.test(t)) || etiquetas[0] || '';
    const celdas = await tr.locator('td').allInnerTexts().catch(() => []);
    out.push({
      cargadoPorCliente: etiquetas.some((t) => /cargado por el cliente/i.test(t)),
      paymentId: await textoDe(tr, 'PAYMENTID', n),
      numero: await textoDe(tr, 'PAYMENTNUMBER', n),
      fecha: await textoDe(tr, 'PAYMENTDATE', n),
      estado: estado.trim(),
      clientId: await textoDe(tr, 'PAYMENTCLIENTID', n),
      cliente: await textoDe(tr, 'PAYMENTCLIENTNAME', n),
      cedula: await textoDe(tr, 'PAYMENTCLIENTFISCAL', n),
      sucursal: await textoDe(tr, 'PAYMENTBRANCHOFFICENAME', n),
      monto: await textoDe(tr, 'PAYMENTMOUNT', n),
      creadoPor: (celdas.map((c) => c.trim()).filter(Boolean).pop() || '').slice(0, 60),
    });
  }
  return out;
}

// Recorre las páginas de la grilla (10 filas por página) con el botón "Sig" del paginador.
async function leerTodasLasFilas(page, maxPaginas = 6) {
  const todas = [];
  for (let p = 0; p < maxPaginas; p++) {
    const filas = await leerFilas(page);
    todas.push(...filas);
    const sig = page.locator('a, button, span').filter({ hasText: /^Sig$/ }).first();
    const texto = await page.locator('text=/Página \\d+ de \\d+/').first().innerText().catch(() => '');
    const m = texto.match(/Página (\d+) de (\d+)/);
    if (m && Number(m[1]) >= Number(m[2])) break;
    if (!(await sig.count()) || filas.length < 10) break;
    const antes = filas[0]?.paymentId;
    await sig.click().catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(600);
    const despues = (await leerFilas(page))[0]?.paymentId;
    if (!despues || despues === antes) break;
  }
  const vistos = new Set();
  return todas.filter((f) => f.paymentId && !vistos.has(f.paymentId) && vistos.add(f.paymentId));
}

// Estado de la pantalla que GeneXus manda en un campo oculto: trae las listas de los combos
// (contratos del cliente y formas de pago) aunque los combos estén ocultos para este usuario.
async function estadoGx(page) {
  const raw = await page.locator('#GXState').inputValue().catch(() => '');
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

function contratosDe(estado) {
  const data = Array.isArray(estado.vNEWCONTRACTID_DATA) ? estado.vNEWCONTRACTID_DATA : [];
  return data.map((d) => {
    let partes = [];
    try {
      partes = JSON.parse(d.T);
    } catch {
      partes = [String(d.T || '')];
    }
    return { id: String(d.ID || ''), numero: String(partes[0] || '').trim(), estado: String(partes[1] || '').trim() };
  });
}

function formasPagoDe(estado) {
  const data = Array.isArray(estado.vPAYMENTWAYCODE_DATA) ? estado.vPAYMENTWAYCODE_DATA : [];
  return data.map((d) => ({ id: String(d.ID || ''), texto: String(d.T || '').trim() }));
}

function fechaParaUrl(ddmmaa) {
  const m = String(ddmmaa).match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
  return m ? `20${m[3]}${m[2]}${m[1]}` : '';
}

function urlConfirmacion(fila) {
  const q = new URLSearchParams({
    PaymentId: fila.paymentId,
    PaymentClientId: fila.clientId,
    PaymentNumber: String(Number(fila.numero) || fila.numero),
    PaymentBranchOfficeName: fila.sucursal,
    PaymentClientName: fila.cliente,
    PaymentDate: fechaParaUrl(fila.fecha),
    PaymentIsUser: 'false',
  });
  return `${BASE}/${CONFIRM_PATH}?${q.toString()}&gxPopupLevel%3D0%3B`;
}

const valor = async (page, id) => (await page.locator(`#${id}`).inputValue().catch(() => '')) || (await page.locator(`#span_${id}`).innerText().catch(() => '')) || '';

// Abre el cuadro de confirmación de un pago y lee sus datos (sin tocar nada).
async function leerConfirmacion(page, fila) {
  await page.goto(urlConfirmacion(fila), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  if (page.url().toLowerCase().includes(LOGIN_PATH)) throw new Error('la sesión de Optimus se cerró');
  await page.waitForSelector('#BTNAPROVED', { timeout: 30_000 });
  const info = {
    estadoCuenta: await valor(page, 'vCLIENTACCOUNTSTATUS'),
    pagoMinimo: await valor(page, 'vMINPAY'),
    reconectar: await valor(page, 'vRECONNECT'),
    pendiente: await valor(page, 'vPENDINGPAY'),
    totalPagar: await valor(page, 'vTOTALPAY'),
    montoActual: await valor(page, 'vPAYMENTMOUNT'),
  };
  const imagenSrc = await page.locator('#PAYMENT_PAYMENTIMAGE').getAttribute('src').catch(() => null);
  const estado = await estadoGx(page);
  const visibles = Object.fromEntries(Object.entries(estado).filter(([k]) => /_Visible$|_CELL_Class$/.test(k)));
  return { info, imagenSrc, contratos: contratosDe(estado), formasPago: formasPagoDe(estado), visibles };
}

// Descarga la imagen dentro del navegador (misma sesión) y la reduce a 1600 px en JPEG.
async function imagenBase64(page, src) {
  if (!src) return null;
  const url = new URL(src, BASE).toString();
  return page.evaluate(async (u) => {
    const res = await fetch(u, { credentials: 'include' });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.type === 'application/pdf') {
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
      return btoa(bin);
    }
    const bmp = await createImageBitmap(blob);
    const max = 1600;
    const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s);
    c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85).split(',')[1];
  }, url);
}

// Opciones de un combo especial de Optimus (Contrato, Forma de pago): no es un <select>, es un
// control con un input oculto (#vNEWCONTRACTID, #vPAYMENTWAYCODE) y una lista que se despliega.
async function volcarCombo(page, nombre) {
  const partes = await page.locator(`[id*="${nombre}"]`).evaluateAll((els) => els.map((e) => e.tagName + '#' + e.id + ' ' + (e.className || '') + ' :: ' + e.outerHTML.replace(/\s+/g, ' ').slice(0, 1200))).catch(() => []);
  console.log(`COMBO_${nombre} ` + JSON.stringify(partes).slice(0, 9000));
}

// ---------------------------------------------------------------- modos
async function verificarAcceso() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    try {
      await iniciarSesion(page);
      await page.screenshot({ path: 'salida/01-menu.png', fullPage: true });
      await irAPagos(page);
      await page.screenshot({ path: 'salida/02-pagos.png', fullPage: true });
      console.log('Acceso correcto.');
    } catch (err) {
      await page.screenshot({ path: 'salida/error.png', fullPage: true }).catch(() => {});
      console.error('Acceso fallido:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

async function explorarPagos() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  try {
    await iniciarSesion(page);
    await irAPagos(page);
    await filtrarPendientes(page);
    const paginador = await page.locator('text=/Página \\d+ de \\d+/').first().evaluate((el) => el.closest('div, td, tr')?.outerHTML.replace(/\s+/g, ' ').slice(0, 3000) || '').catch(() => '');
    console.log('PAGINADOR ' + paginador);
    const filas = await leerTodasLasFilas(page);
    console.log('FILAS ' + JSON.stringify(filas.map((f) => ({ numero: f.numero, estado: f.estado, cliente: f.cargadoPorCliente, monto: f.monto, sucursal: f.sucursal, creadoPor: f.creadoPor }))));
    // Preferir un pago cargado por el propio cliente (punto azul): ahí es donde Optimus pide
    // contrato, monto y forma de pago. Los que crea una secretaria ya traen esos datos.
    const pendiente = filas.find((f) => /pendiente/i.test(f.estado) && f.cargadoPorCliente) || filas.find((f) => /pendiente/i.test(f.estado) && /^0([,.]00)?$/.test(f.monto)) || filas.find((f) => /pendiente/i.test(f.estado));
    if (!pendiente) {
      console.log('No hay pagos pendientes visibles.');
      return;
    }
    const { info, imagenSrc, contratos, formasPago, visibles } = await leerConfirmacion(page, pendiente);
    console.log('CONFIRMACION_URL ok · info ' + JSON.stringify(info) + ' · imagen ' + (imagenSrc ? 'sí' : 'no'));
    console.log('PAGO_EXPLORADO ' + JSON.stringify({ numero: pendiente.numero, monto: pendiente.monto, creadoPor: pendiente.creadoPor, cargadoPorCliente: pendiente.cargadoPorCliente }));
    console.log('CONTRATOS ' + JSON.stringify(contratos));
    console.log('FORMAS_PAGO ' + JSON.stringify(formasPago));
    console.log('VISIBILIDAD ' + JSON.stringify(visibles));
    await page.screenshot({ path: 'salida/03-confirmacion.png', fullPage: true });
    // Los contenedores de los combos pueden llenarse por JS después de cargar: se les da tiempo.
    await page.waitForTimeout(4000);
    await volcarCombo(page, 'NEWCONTRACTID');
    await volcarCombo(page, 'PAYMENTWAYCODE');
    const html = await page.content();
    const recortes = [];
    for (const clave of ['COMBO_NEWCONTRACTID', 'COMBO_PAYMENTWAYCODE', 'Consignacion', 'NEWCONTRACTID_CELL', 'PAYMENTWAYCODE_CELL']) {
      let idx = -1;
      let n = 0;
      while ((idx = html.indexOf(clave, idx + 1)) >= 0 && n < 4) {
        recortes.push(clave + ' @' + idx + ' :: ' + html.slice(Math.max(0, idx - 300), idx + 500).replace(/\s+/g, ' '));
        n++;
      }
    }
    console.log('RECORTES ' + JSON.stringify(recortes).slice(0, 12000));
    const celdasInvisibles = await page.locator('.Invisible[id]').evaluateAll((els) => els.map((e) => e.id)).catch(() => []);
    console.log('CELDAS_INVISIBLES ' + JSON.stringify(celdasInvisibles));
    const montoAttrs = await page.locator('#vPAYMENTMOUNT').evaluate((e) => e.outerHTML.replace(/\s+/g, ' ')).catch(() => '');
    console.log('CAMPO_MONTO ' + montoAttrs);
    const scripts = await page.locator('script[src]').evaluateAll((els) => els.map((e) => e.getAttribute('src'))).catch(() => []);
    console.log('SCRIPTS ' + JSON.stringify(scripts).slice(0, 3000));
    // Intentar abrir el combo de forma de pago para ver sus opciones desplegadas.
    const disparador = page.locator('[id*="PAYMENTWAYCODE"]').filter({ hasNot: page.locator('input') }).first();
    await disparador.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(800);
    const abiertas = await page.locator('li, .dropdown-menu a, [role="option"], .option, .item').evaluateAll((els) => els.map((e) => (e.innerText || '').trim()).filter((t) => t && t.length < 60)).catch(() => []);
    console.log('OPCIONES_VISIBLES ' + JSON.stringify([...new Set(abiertas)]).slice(0, 3000));
    await page.screenshot({ path: 'salida/04-combo-abierto.png', fullPage: true });
    const b64 = await imagenBase64(page, imagenSrc);
    console.log('IMAGEN_BASE64_KB ' + (b64 ? Math.round(b64.length / 1366) : 0));
    writeFileSync('salida/confirmacion.html', await page.content());
  } catch (err) {
    await page.screenshot({ path: 'salida/error.png', fullPage: true }).catch(() => {});
    console.error('Exploración fallida:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

// Trae al panel los pendientes que todavía no estén allá.
async function ingestar(page, known) {
  await irAPagos(page);
  await filtrarPendientes(page);
  const filas = (await leerTodasLasFilas(page)).filter((f) => /pendiente/i.test(f.estado) && f.paymentId && f.numero);
  const conocidos = new Set((known || []).map((k) => String(Number(k) || k)));
  let nuevos = 0;
  for (const fila of filas) {
    if (conocidos.has(String(Number(fila.numero)))) continue;
    try {
      const { info, imagenSrc, contratos, formasPago } = await leerConfirmacion(page, fila);
      const b64 = await imagenBase64(page, imagenSrc);
      if (!b64) {
        console.log('Sin imagen en Optimus:', fila.numero, '→ no se trae (lo revisa una persona allá)');
        continue;
      }
      const data = await ingestarEnPanel(
        {
          numero: fila.numero,
          cliente: fila.cliente,
          sucursal: fila.sucursal,
          fecha: fila.fecha,
          creadoPor: fila.creadoPor,
          cedula: fila.cedula,
          paymentId: fila.paymentId,
          clientId: fila.clientId,
          cargadoPorCliente: fila.cargadoPorCliente,
          contratos: contratos.map((c) => `${c.numero} ${c.estado}`.trim()),
          contratosIds: contratos.map((c) => c.id),
          formasPago: formasPago.map((f) => f.texto),
          montoOptimus: fila.monto,
          estadoCuenta: info.estadoCuenta,
          pagoMinimo: info.pagoMinimo,
          pendiente: info.pendiente,
          reconectar: info.reconectar,
        },
        b64
      );
      if (!data.existing) nuevos++;
      console.log('Traído', fila.numero, fila.sucursal, data.existing ? '(ya estaba)' : '(nuevo)');
    } catch (err) {
      console.error('No se pudo traer', fila.numero, err instanceof Error ? err.message : err);
    }
  }
  console.log(`Pendientes en Optimus: ${filas.length} · nuevos en el panel: ${nuevos}`);
}

// Aprueba en Optimus un comprobante que el panel dejó en verde. Lanza Error con el motivo si algo no cuadra.
async function aprobarEnOptimus(page, item) {
  const o = item.optimus || {};
  const fill = item.fill || {};
  if (!o.paymentId) throw new Error('el pago no trae el identificador de Optimus (vino de la subida manual); aplicar a mano');
  if (!fill.monto) throw new Error('GPSITO no leyó el valor del comprobante');
  if (!fill.formaPago) throw new Error('forma de pago no reconocida desde el banco leído');
  const fila = { paymentId: o.paymentId, clientId: o.clientId, numero: o.numero, sucursal: item.branch, cliente: item.clientName, fecha: o.fecha };
  await page.goto(urlConfirmacion(fila), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  await page.waitForSelector('#BTNAPROVED', { timeout: 30_000 });
  // Los combos de Contrato y Forma de pago son controles especiales: hasta que se verifique su
  // estructura (modo explorar-pagos), no se aprueba nada.
  throw new Error('la selección de Contrato y Forma de pago en Optimus todavía no está verificada; aplicar a mano');
}

async function aplicar(page, items) {
  for (const item of items) {
    try {
      const detail = await aprobarEnOptimus(page, item);
      const shot = await page.screenshot({ type: 'jpeg', quality: 70 }).catch(() => null);
      await reportar(item.id, 'aplicado', detail || 'aprobado en Optimus', shot);
      console.log('Aprobado', item.clientName);
    } catch (err) {
      const shot = await page.screenshot({ type: 'jpeg', quality: 70 }).catch(() => null);
      await reportar(item.id, 'fallo', err instanceof Error ? err.message : String(err), shot);
      console.error('No se aprobó', item.clientName, '→', err instanceof Error ? err.message : err);
    }
  }
}

async function main() {
  if (MODO === 'verificar-acceso') return verificarAcceso();
  if (MODO === 'explorar-pagos') return explorarPagos();
  const data = await pendientesDelPanel(MODO === 'aplicar' ? MAX_POR_CICLO : 1);
  if (data.paused) {
    console.log('Robot en pausa desde el panel; nada que hacer.');
    return;
  }
  if (MODO === 'latido') {
    console.log(`Latido enviado. Por aprobar en el panel: ${data.items.length}.`);
    return;
  }
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  try {
    await iniciarSesion(page);
    await ingestar(page, data.known);
    if (MODO === 'aplicar') {
      const porAprobar = data.items.filter((i) => i.action === 'aprobar');
      if (porAprobar.length) await aplicar(page, porAprobar);
      else console.log('Nada por aprobar en Optimus.');
    }
  } catch (err) {
    await page.screenshot({ path: 'salida/error.png', fullPage: true }).catch(() => {});
    console.error('Ciclo fallido:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
