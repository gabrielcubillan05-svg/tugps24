// Robot que aplica en el sistema de pagos (GeneXus) los comprobantes que el panel dejó en verde
// o aprobados a mano. Corre fuera de Vercel (GitHub Actions cada 15 minutos o un VPS).
//
// Variables de entorno:
//   PANEL_URL          https://www.tugps24.com (sin barra final)
//   ROBOT_PAGOS_TOKEN  el mismo valor configurado en Vercel
//   GENEXUS_URL        URL de inicio de sesión del sistema de pagos
//   GENEXUS_USER / GENEXUS_PASS  usuario exclusivo del robot
//   MAX_POR_CICLO      opcional, cuántos comprobantes aplicar por corrida (por defecto 5)
//   MODO               'verificar-acceso' solo entra y guarda capturas del menú en salida/
//                      'explorar-pagos' recorre Pagos → detalle → Modificar sin guardar y deja capturas y HTML
//
// Los pasos dentro de GeneXus (buscar al cliente, registrar el pago, confirmar) se completan en
// aplicarEnGenexus() con los selectores reales de esa pantalla. Hasta entonces el robot solo hace
// el latido y no toma comprobantes.
import { chromium } from 'playwright';

const PANEL_URL = (process.env.PANEL_URL || '').replace(/\/$/, '');
const TOKEN = process.env.ROBOT_PAGOS_TOKEN || '';
const MAX_POR_CICLO = Math.max(1, Number(process.env.MAX_POR_CICLO) || 5);
const GENEXUS_LISTO = false; // pasar a true cuando aplicarEnGenexus() tenga los selectores reales

if (!PANEL_URL || !TOKEN) {
  console.error('Faltan PANEL_URL o ROBOT_PAGOS_TOKEN');
  process.exit(1);
}

const api = (path, init = {}) =>
  fetch(`${PANEL_URL}/api/verificacion-pagos-robot${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(60_000),
  });

async function reportar(id, result, detail, screenshotBuffer) {
  const body = { id, result, detail: String(detail || '').slice(0, 400) };
  if (screenshotBuffer) body.screenshot = screenshotBuffer.toString('base64');
  const res = await api('', { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) console.error('No se pudo reportar', id, res.status, await res.text().catch(() => ''));
}

// Pantalla de acceso de GeneXus (GAM): la raíz redirige a home.aspx y esta a gamexamplelogin.aspx,
// con los campos vUSERNAME, vUSERPASSWORD y el botón BTNENTER. Verificado el 2026-10-07.
const LOGIN_PATH = 'gamexamplelogin.aspx';

const PAGOS_PATH = 'erp.paymentww.aspx';

async function iniciarSesion(page) {
  const base = (process.env.GENEXUS_URL || 'https://core.optimus.tugps24.com/').replace(/\/$/, '');
  // Se entra por home.aspx, como una persona: GAM redirige al login guardando la página de
  // vuelta. Entrando directo al login, al terminar mandaba a "notauthorized" aunque el usuario
  // sí tuviera permisos (la página por defecto del GAM no es la del rol del robot).
  await page.goto(`${base}/home.aspx`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (page.url().toLowerCase().includes(LOGIN_PATH)) {
    await page.waitForSelector('#vUSERNAME', { timeout: 30_000 });
    await page.fill('#vUSERNAME', process.env.GENEXUS_USER || '');
    await page.fill('#vUSERPASSWORD', process.env.GENEXUS_PASS || '');
    await page.click('#BTNENTER');
    try {
      await page.waitForURL((u) => !u.toString().toLowerCase().includes(LOGIN_PATH), { timeout: 20_000 });
    } catch {
      const aviso = await page.locator('.gx-warning-message, #gxErrorViewer, .ErrorViewer, [id*="ERROR"], .gx-message').allInnerTexts().catch(() => []);
      throw new Error('No se pudo iniciar sesión en el sistema de pagos' + (aviso.length ? ': ' + aviso.join(' ').trim().slice(0, 160) : ''));
    }
  }
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  console.log('Tras entrar:', page.url());
}

// Va directo a la lista de pagos y comprueba que de verdad se puede ver.
async function irAPagos(page) {
  const base = (process.env.GENEXUS_URL || 'https://core.optimus.tugps24.com/').replace(/\/$/, '');
  await page.goto(`${base}/${PAGOS_PATH}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  const url = page.url().toLowerCase();
  if (url.includes(LOGIN_PATH)) throw new Error('Optimus pidió iniciar sesión otra vez al abrir Pagos: usuario o clave del robot incorrectos');
  if (url.includes('notauthorized')) throw new Error('El usuario del robot no tiene permiso para ver Administrativa → Pagos (gamexamplenotauthorized): revisar su rol en Seguridad GAM');
  await page.waitForSelector('table', { timeout: 30_000 });
}

// Devuelve { detail } cuando el pago quedó aplicado, o lanza un Error con el motivo.
// Cada paso debe fallar claro (cliente no encontrado, dos clientes con el mismo nombre, campo
// que no existe) para que el panel lo muestre y una persona lo resuelva.
async function aplicarEnGenexus(page, pago) {
  const x = pago.extracted || {};
  await iniciarSesion(page);
  // 2) Buscar al cliente por nombre completo (o cédula/placa, según la pantalla)
  // 3) Registrar el pago: valor x.valor, fecha x.fecha, referencia x.referencia, banco x.banco
  // 4) Confirmar y verificar que aparezca el mensaje de éxito
  void x;
  throw new Error('aplicarEnGenexus todavía no tiene los pasos de la pantalla de pagos');
}

// Solo entra y guarda capturas del menú (salida/), para confirmar el usuario del robot y ver
// la pantalla que sigue sin aplicar nada.
async function verificarAcceso() {
  const { mkdirSync } = await import('node:fs');
  mkdirSync('salida', { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    try {
      await iniciarSesion(page);
      await page.screenshot({ path: 'salida/01-menu.png', fullPage: true });
      await irAPagos(page);
      await page.screenshot({ path: 'salida/02-pagos.png', fullPage: true });
      const links = await page.locator('a, button, [data-gx-button]').evaluateAll((els) => els.map((e) => (e.innerText || e.value || '').trim()).filter(Boolean).slice(0, 200));
      const { writeFileSync } = await import('node:fs');
      writeFileSync('salida/menu-textos.txt', links.join('\n'));
      console.log('Acceso correcto. Capturas en salida/.');
    } catch (err) {
      await page.screenshot({ path: 'salida/error.png', fullPage: true }).catch(() => {});
      console.error('Acceso fallido:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

// Recorre Administrativa → Pagos → primer pago → Modificar (sin guardar) y deja capturas y el
// HTML de cada pantalla en salida/, para escribir los selectores reales del flujo de aplicación.
async function explorarPagos() {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync('salida', { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const guardar = async (nombre) => {
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    await page.screenshot({ path: `salida/${nombre}.png`, fullPage: true }).catch(() => {});
    writeFileSync(`salida/${nombre}.html`, await page.content());
    writeFileSync(`salida/${nombre}.url.txt`, page.url());
    console.log(nombre, page.url());
  };
  try {
    await iniciarSesion(page);
    await guardar('01-menu');
    await irAPagos(page);
    await guardar('02-pagos-lista');
    // Estructura de la lista al registro. La grilla es la tabla que contiene el combo de acciones
    // de la primera fila (vGRIDACTIONS_0001); la primera <table> de la página es el logo.
    const grid = page.locator('table:has(#vGRIDACTIONS_0001)').last();
    const encabezados = await grid.locator('th').allInnerTexts().catch(() => []);
    console.log('ENCABEZADOS ' + JSON.stringify(encabezados.map((t) => t.trim())));
    const thTipo = await grid.locator('th').filter({ hasText: /Tipo/ }).first().evaluate((el) => el.outerHTML.replace(/\s+/g, ' ').slice(0, 3000)).catch(() => '');
    console.log('TH_TIPO ' + thTipo);
    const fila = page.locator('tr:has(#vGRIDACTIONS_0001)').first();
    console.log('FILA1 ' + (await fila.evaluate((el) => el.outerHTML.replace(/\s+/g, ' ').slice(0, 7000)).catch(() => '(sin fila)')));
    console.log('GRID_ID ' + (await grid.evaluate((el) => el.id + ' | ' + el.className).catch(() => '')));
    const pager = await page.locator('[id*="PAGING"], [id*="Paging"], .WWPaginationBar, [class*="Pagination"]').first().evaluate((el) => el.outerHTML.replace(/\s+/g, ' ').slice(0, 2500)).catch(() => '');
    console.log('PAGINADOR ' + pager);
    // Abrir "Confirmación" de la primera fila: es un <select> de acciones (WorkWithPlus); al
    // elegir la segunda opción se dispara el evento. El cuadro suele abrirse en un iframe.
    const combo = page.locator('#vGRIDACTIONS_0001');
    const opciones = await combo.locator('option').evaluateAll((els) => els.map((o) => ({ value: o.value, text: o.text })));
    console.log('ACCIONES ' + JSON.stringify(opciones));
    const confirmacion = opciones.find((o) => /confirmaci/i.test(o.text) || /confirmaci/i.test(o.value));
    if (confirmacion) {
      await combo.selectOption(confirmacion.value).catch(async () => {
        await combo.evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }, confirmacion.value);
      });
      await page.waitForTimeout(3000);
      await guardar('04-confirmacion');
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        console.log('FRAME ' + frame.url());
        const selects = await frame.locator('select').evaluateAll((els) => els.map((e) => ({ id: e.id, name: e.name, options: [...e.options].map((o) => o.value + ' | ' + o.text.trim()).slice(0, 40) }))).catch(() => []);
        const campos = await frame.locator('input, textarea').evaluateAll((els) => els.filter((e) => e.type !== 'hidden').map((e) => ({ id: e.id, name: e.name, type: e.type, value: e.value, readonly: e.readOnly, disabled: e.disabled }))).catch(() => []);
        const botones = await frame.locator('button, input[type="button"], input[type="submit"], a[data-gx-evt], [data-gx-button]').evaluateAll((els) => els.map((e) => ({ id: e.id, name: e.name, text: (e.innerText || e.value || e.title || '').trim() })).filter((b) => b.text || b.id)).catch(() => []);
        const spans = await frame.locator('span[id^="span_"], span[id^="TEXTBLOCK"], span[id*="TEXTBLOCK"], span[id*="DESC"]').evaluateAll((els) => els.map((e) => e.id + '=' + (e.innerText || '').trim().slice(0, 60)).filter((t) => !t.endsWith('='))).catch(() => []);
        const imgs = await frame.locator('img').evaluateAll((els) => els.map((e) => ({ id: e.id, src: (e.getAttribute('src') || '').slice(0, 200) }))).catch(() => []);
        console.log('F_LISTAS ' + JSON.stringify(selects));
        console.log('F_CAMPOS ' + JSON.stringify(campos));
        console.log('F_BOTONES ' + JSON.stringify(botones));
        console.log('F_TEXTOS ' + JSON.stringify(spans).slice(0, 4000));
        console.log('F_IMAGENES ' + JSON.stringify(imgs).slice(0, 2000));
        const html = await frame.content().catch(() => '');
        writeFileSync(`salida/04-frame-${page.frames().indexOf(frame)}.html`, html);
      }
      // Si no hubo iframe, el cuadro está en la página principal.
      if (page.frames().length === 1) {
        const selects = await page.locator('select').evaluateAll((els) => els.map((e) => ({ id: e.id, name: e.name, options: [...e.options].map((o) => o.value + ' | ' + o.text.trim()).slice(0, 40) })));
        console.log('LISTAS ' + JSON.stringify(selects).slice(0, 6000));
        const campos = await page.locator('input, textarea').evaluateAll((els) => els.filter((e) => e.type !== 'hidden' && !/^v(DYNAMIC|PAYMENT(NUMBER|CLIENTNAME|BRANCHOFFICENAME)\d|GRIDACTIONS|FILTERFULLTEXT|SEARCH)/.test(e.id)).map((e) => ({ id: e.id, name: e.name, type: e.type, value: e.value })));
        console.log('CAMPOS ' + JSON.stringify(campos).slice(0, 6000));
        const botones = await page.locator('button, input[type="button"], input[type="submit"]').evaluateAll((els) => els.map((e) => ({ id: e.id, text: (e.innerText || e.value || '').trim() })).filter((b) => b.text));
        console.log('BOTONES ' + JSON.stringify(botones).slice(0, 3000));
      }
      // Cerrar sin aprobar ni denegar.
      await page.keyboard.press('Escape').catch(() => {});
    } else {
      console.log('El combo de acciones no tiene la opción Confirmación.');
    }
  } catch (err) {
    await page.screenshot({ path: 'salida/error.png', fullPage: true }).catch(() => {});
    writeFileSync('salida/error.html', await page.content().catch(() => ''));
    console.error('Exploración fallida:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

async function main() {
  if (process.env.MODO === 'verificar-acceso') return verificarAcceso();
  if (process.env.MODO === 'explorar-pagos') return explorarPagos();
  const pendRes = await api(GENEXUS_LISTO ? `?limit=${MAX_POR_CICLO}` : '?limit=1');
  if (!pendRes.ok) {
    console.error('El panel respondió', pendRes.status, await pendRes.text().catch(() => ''));
    process.exit(1);
  }
  const data = await pendRes.json();
  if (data.paused) {
    console.log('Robot en pausa desde el panel; nada que hacer.');
    return;
  }
  if (!GENEXUS_LISTO) {
    console.log(`Latido enviado. Pendientes por aplicar: ${data.items.length}. GeneXus aún no está configurado en el robot.`);
    return;
  }
  if (!data.items.length) {
    console.log('Sin comprobantes por aplicar.');
    return;
  }
  const browser = await chromium.launch();
  try {
    for (const pago of data.items) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      try {
        const result = await aplicarEnGenexus(page, pago);
        const shot = await page.screenshot({ type: 'jpeg', quality: 70 }).catch(() => null);
        await reportar(pago.id, 'aplicado', result.detail || 'aplicado', shot);
        console.log('Aplicado', pago.clientName);
      } catch (err) {
        const shot = await page.screenshot({ type: 'jpeg', quality: 70 }).catch(() => null);
        await reportar(pago.id, 'fallo', err instanceof Error ? err.message : String(err), shot);
        console.error('Falló', pago.clientName, err instanceof Error ? err.message : err);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
