// Robot que aplica en el sistema de pagos (GeneXus) los comprobantes que el panel dejó en verde
// o aprobados a mano. Corre fuera de Vercel (GitHub Actions cada 15 minutos o un VPS).
//
// Variables de entorno:
//   PANEL_URL          https://www.tugps24.com (sin barra final)
//   ROBOT_PAGOS_TOKEN  el mismo valor configurado en Vercel
//   GENEXUS_URL        URL de inicio de sesión del sistema de pagos
//   GENEXUS_USER / GENEXUS_PASS  usuario exclusivo del robot
//   MAX_POR_CICLO      opcional, cuántos comprobantes aplicar por corrida (por defecto 5)
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

// Devuelve { ok: true, detail } cuando el pago quedó aplicado, o lanza un Error con el motivo.
// Cada paso debe fallar claro (cliente no encontrado, dos clientes con el mismo nombre, campo
// que no existe) para que el panel lo muestre y una persona lo resuelva.
async function aplicarEnGenexus(page, pago) {
  const x = pago.extracted || {};
  // 1) Entrar
  await page.goto(process.env.GENEXUS_URL, { waitUntil: 'domcontentloaded' });
  // await page.fill('#vUSERNAME', process.env.GENEXUS_USER);
  // await page.fill('#vPASSWORD', process.env.GENEXUS_PASS);
  // await page.click('#BTNENTER');
  // 2) Buscar al cliente por nombre completo (o cédula/placa, según la pantalla)
  // 3) Registrar el pago: valor x.valor, fecha x.fecha, referencia x.referencia, banco x.banco
  // 4) Confirmar y verificar que aparezca el mensaje de éxito
  throw new Error('aplicarEnGenexus todavía no tiene los pasos de la pantalla');
}

async function main() {
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
