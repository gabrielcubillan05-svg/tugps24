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

async function iniciarSesion(page) {
  const base = (process.env.GENEXUS_URL || 'https://core.optimus.tugps24.com/').replace(/\/$/, '');
  await page.goto(`${base}/${LOGIN_PATH}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('#vUSERNAME', { timeout: 30_000 });
  await page.fill('#vUSERNAME', process.env.GENEXUS_USER || '');
  await page.fill('#vUSERPASSWORD', process.env.GENEXUS_PASS || '');
  await page.click('#BTNENTER');
  // GAM recarga la misma página con el aviso cuando la clave es incorrecta; si entra, navega al menú.
  try {
    await page.waitForURL((u) => !u.toString().toLowerCase().includes(LOGIN_PATH), { timeout: 20_000 });
  } catch {
    const aviso = await page.locator('.gx-warning-message, #gxErrorViewer, .ErrorViewer, [id*="ERROR"], .gx-message').allInnerTexts().catch(() => []);
    throw new Error('No se pudo iniciar sesión en el sistema de pagos' + (aviso.length ? ': ' + aviso.join(' ').trim().slice(0, 160) : ''));
  }
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
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
    await page.getByText('Administrativa', { exact: true }).first().click();
    await page.getByText('Pagos', { exact: true }).first().click();
    await guardar('02-pagos-lista');
    // Primer número de pago de la tabla (enlace con solo dígitos).
    const primero = page.locator('table a').filter({ hasText: /^\d{6,}$/ }).first();
    if (await primero.count()) {
      await primero.click();
      await guardar('03-pago-detalle');
      const modificar = page.getByRole('button', { name: /modificar/i }).or(page.locator('input[value="Modificar"], [id*="MODIFICAR"], [id*="UPDATE"]')).first();
      if (await modificar.count()) {
        await modificar.click();
        await guardar('04-pago-modificar');
      } else {
        console.log('No se encontró el botón Modificar.');
      }
    } else {
      console.log('No se encontró ningún número de pago en la tabla.');
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
