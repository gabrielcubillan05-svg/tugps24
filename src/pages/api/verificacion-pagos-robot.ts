import type { APIRoute } from 'astro';
import { put, get } from '@vercel/blob';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { pushNotification } from '../../lib/notifications';
import { markCronOk } from '../../lib/incidents';
import { blobTimeout } from '../../lib/blob-path';
import { cronSecretMatches, getUsers, KELLY_USERNAME, WILMAR_USERNAME } from '../../lib/auth';
import { CONFIG_KEY, APPLY_CLAIM_MS, APPLY_MAX_ATTEMPTS, isApplyPending, type PagoCliente } from '../../lib/pagos-verificacion';
import { readPagos, REDIS_KEY, readRobotState } from './verificacion-pagos';

export const prerender = false;

// Puerta para el robot que aplica los pagos en el sistema externo (GeneXus). El robot corre
// fuera de Vercel, se identifica con ROBOT_PAGOS_TOKEN y solo ve lo que aquí quedó en verde o
// aprobado a mano. Nunca recibe rojos ni puede cambiar el semáforo: solo reporta si aplicó.
const ACTOR = { userId: 'robot-pagos', username: 'Robot de pagos' };
const MAX_BATCH = 10;
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function authorized(request: Request): boolean {
  const token = import.meta.env.ROBOT_PAGOS_TOKEN as string | undefined;
  return cronSecretMatches(request.headers.get('authorization'), token);
}

async function readPago(redis: any, id: string): Promise<PagoCliente | null> {
  const raw = await redis.hget(REDIS_KEY, id);
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : (raw as PagoCliente);
  } catch {
    return null;
  }
}

async function notifyResolvers(redis: any, message: string, key: string): Promise<void> {
  const users = await getUsers(redis);
  const targets = users.filter((u) => u.active && (u.role === 'admin' || [KELLY_USERNAME, WILMAR_USERNAME].includes(u.username.toLowerCase())));
  await Promise.allSettled(targets.map((u) => pushNotification(redis, u.id, { type: 'pago-robot', message, link: '/interno/verificacion-pagos', key, pushBody: 'Robot de pagos: revisar un comprobante' })));
}

// Lo que el robot necesita para aplicar: sin archivo (lo pide aparte si lo requiere).
function forRobot(p: PagoCliente) {
  return {
    id: p.id,
    clientName: p.clientName,
    plate: p.plate,
    branch: p.branch,
    status: p.status,
    createdAt: p.createdAt,
    createdByName: p.createdByName,
    extracted: p.extracted,
    applyAttempts: p.applyAttempts || 0,
    fileType: p.fileType,
  };
}

export const GET: APIRoute = async ({ request, url }) => {
  if (!authorized(request)) return json(401, { error: 'unauthorized' });
  const redis = getRedis();
  if (!redis) return json(503, { error: 'not configured' });

  // El archivo del comprobante, por si el robot debe adjuntarlo en el otro sistema.
  const fileId = url.searchParams.get('file');
  if (fileId) {
    const pago = await readPago(redis, fileId);
    if (!pago || !isApplyPending(pago)) return json(404, { error: 'no encontrado o no aplicable' });
    const token = import.meta.env.BLOB_READ_WRITE_TOKEN as string | undefined;
    if (!token) return json(503, { error: 'almacenamiento no configurado' });
    const result = await get(pago.filePath, { access: 'private', token, abortSignal: blobTimeout(30_000) });
    if (!result || result.statusCode !== 200 || !result.stream) return json(404, { error: 'archivo no disponible' });
    return new Response(result.stream, { headers: { 'Content-Type': result.blob.contentType || 'application/octet-stream', 'Cache-Control': 'no-store' } });
  }

  // Latido: aunque esté en pausa, el robot sigue consultando y /api/health sabe que vive.
  await markCronOk(redis, 'robot-pagos');
  const state = await readRobotState(redis);
  if (state.paused) return json(200, { paused: true, items: [] });

  const limit = Math.min(MAX_BATCH, Math.max(1, parseInt(url.searchParams.get('limit') || '5', 10) || 5));
  const now = Date.now();
  const pending = (await readPagos(redis))
    .filter(isApplyPending)
    // Un comprobante tomado por un ciclo anterior que no reportó se suelta pasado el plazo.
    .filter((p) => !p.applyClaimedAt || now - Date.parse(p.applyClaimedAt) > APPLY_CLAIM_MS)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, limit);
  const nowIso = new Date(now).toISOString();
  for (const p of pending) {
    p.applyClaimedAt = nowIso;
    p.applyStatus = p.applyStatus || 'pendiente';
    await redis.hset(REDIS_KEY, { [p.id]: JSON.stringify(p) });
  }
  return json(200, { paused: false, items: pending.map(forRobot) });
};

export const POST: APIRoute = async ({ request }) => {
  if (!authorized(request)) return json(401, { error: 'unauthorized' });
  const redis = getRedis();
  if (!redis) return json(503, { error: 'not configured' });
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'invalid body' });
  }
  const id = String(body.id || '');
  const result = String(body.result || '');
  const detail = String(body.detail || '').trim().slice(0, 400);
  if (!id || (result !== 'aplicado' && result !== 'fallo')) return json(400, { error: 'id y result (aplicado | fallo) son obligatorios' });
  const pago = await readPago(redis, id);
  if (!pago) return json(404, { error: 'no encontrado' });
  if (pago.status !== 'verde' && pago.status !== 'aprobado') return json(409, { error: 'el comprobante ya no está en verde ni aprobado' });
  if (pago.applyStatus === 'aplicado' || pago.applyStatus === 'manual') return json(409, { error: 'ya estaba aplicado' });

  const now = new Date().toISOString();
  // Captura de la confirmación (o del error) en el otro sistema, para auditoría visual.
  let screenshotPath: string | null = pago.applyScreenshotPath || null;
  const shot = typeof body.screenshot === 'string' ? body.screenshot.replace(/^data:image\/\w+;base64,/, '') : '';
  const token = import.meta.env.BLOB_READ_WRITE_TOKEN as string | undefined;
  if (shot && token) {
    try {
      const bytes = Buffer.from(shot, 'base64');
      const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
      const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
      if ((isPng || isJpg) && bytes.length <= MAX_SCREENSHOT_BYTES) {
        screenshotPath = `pagos-clientes/${id}-aplicacion-${Date.now()}.${isPng ? 'png' : 'jpg'}`;
        await put(screenshotPath, bytes, { access: 'private', token, addRandomSuffix: false, contentType: isPng ? 'image/png' : 'image/jpeg', abortSignal: blobTimeout() });
      }
    } catch (err) {
      console.error('robot-pagos: no se guardó la captura', err instanceof Error ? err.message : String(err));
    }
  }

  pago.applyAttempts = (pago.applyAttempts || 0) + 1;
  pago.applyClaimedAt = null;
  pago.applyAt = now;
  pago.applyBy = 'Robot de pagos';
  pago.applyDetail = detail;
  pago.applyScreenshotPath = screenshotPath;
  pago.applyStatus = result === 'aplicado' ? 'aplicado' : 'fallo';
  await redis.hset(REDIS_KEY, { [pago.id]: JSON.stringify(pago) });
  await redis.hset(CONFIG_KEY, { robotLastResult: `${now} · ${pago.clientName}: ${result}${detail ? ' — ' + detail : ''}`.slice(0, 200) }).catch(() => {});
  await logAudit(redis, ACTOR, result === 'aplicado' ? 'pago_aplicado_robot' : 'pago_aplicacion_fallida', pago.clientName, detail || (result === 'aplicado' ? 'aplicado en el sistema de pagos' : 'sin detalle'));

  if (result === 'fallo') {
    const exhausted = pago.applyAttempts >= APPLY_MAX_ATTEMPTS;
    await notifyResolvers(
      redis,
      `🤖 ${exhausted ? 'El robot no pudo aplicar' : 'El robot falló al aplicar'} el pago de ${pago.clientName} (${pago.branch})${detail ? ': ' + detail : ''}${exhausted ? '. Hay que aplicarlo a mano.' : `. Reintenta (${pago.applyAttempts}/${APPLY_MAX_ATTEMPTS}).`}`,
      `pago-robot:${pago.id}`
    );
  }
  return json(200, { ok: true, applyStatus: pago.applyStatus, attempts: pago.applyAttempts });
};
