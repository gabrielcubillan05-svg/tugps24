import type { APIRoute } from 'astro';
import { put, get } from '@vercel/blob';
import { createHash, randomUUID } from 'node:crypto';
import { runAfterResponse } from '../../lib/background';
import { dHashFromImage } from '../../lib/image-hash';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { pushNotification } from '../../lib/notifications';
import { markCronOk } from '../../lib/incidents';
import { blobTimeout } from '../../lib/blob-path';
import { cronSecretMatches, getUsers, findUserByUsername, KELLY_USERNAME, WILMAR_USERNAME } from '../../lib/auth';
import { CONFIG_KEY, PHASH_KEY, SHA_KEY_PREFIX, INDEX_TTL_SECONDS, APPLY_CLAIM_MS, APPLY_MAX_ATTEMPTS, PAYU_RAZON, isApplyPending, applyActionFor, esPagoPayU, formaPagoDesdeBanco, type PagoCliente, type OptimusInfo } from '../../lib/pagos-verificacion';
import { readPagos, readPago, savePago, analyzePago, REDIS_KEY, readRobotState, retryFailedAnalyses } from './verificacion-pagos';

// Un pago de Optimus entra al panel una sola vez, por su número.
const OPTIMUS_KEY_PREFIX = 'internal:pagos-clientes-optimus:';
const MAX_INGEST_BYTES = 8 * 1024 * 1024;

export const prerender = false;

// Puerta para el robot que aplica los pagos en el sistema externo (GeneXus). El robot corre
// fuera de Vercel, se identifica con ROBOT_PAGOS_TOKEN y solo ve lo que aquí quedó en verde o
// aprobado a mano. Nunca recibe rojos ni puede cambiar el semáforo: solo reporta si aplicó.
const ACTOR = { userId: 'robot-pagos', username: 'Robot de pagos' };
// 25 por ronda (Gabriel, 2026-10-07): cada aprobación tarda unos 5 s en Optimus, caben de sobra en una corrida.
const MAX_BATCH = 50;
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function authorized(request: Request): boolean {
  const token = import.meta.env.ROBOT_PAGOS_TOKEN as string | undefined;
  return cronSecretMatches(request.headers.get('authorization'), token);
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
    action: applyActionFor(p),
    // Lo que el robot debe escribir en el cuadro de confirmación de Optimus.
    fill: p.extracted
      ? { monto: p.extracted.valor, referencia: p.extracted.referencia, formaPago: formaPagoDesdeBanco(p.extracted.banco, p.extracted.tipoDestino, p.extracted.observaciones), fecha: p.extracted.fecha }
      : null,
    source: p.source || 'manual',
    optimus: p.optimus || null,
    resolutionNote: p.resolutionNote || '',
    resolvedByName: p.resolvedByName || '',
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
  if (state.paused) return json(200, { paused: true, items: [], known: [] });

  const limit = Math.min(MAX_BATCH, Math.max(1, parseInt(url.searchParams.get('limit') || '5', 10) || 5));
  // only=manual: solo lo aprobado a mano en el panel (modo aplicar-manuales). Lo aprobado a mano
  // va siempre primero: una persona ya decidió y está esperando.
  const soloManual = url.searchParams.get('only') === 'manual';
  const now = Date.now();
  const todos = await readPagos(redis);
  await devolverPayUARojo(redis, todos);
  const pending = todos
    .filter(isApplyPending)
    .filter((p) => !soloManual || p.status === 'aprobado')
    // Sin valor leído por GPSITO no se manda a aprobar (gastaría intentos): primero se relee.
    .filter((p) => applyActionFor(p) !== 'aprobar' || !!p.extracted?.valor)
    // Un comprobante tomado por un ciclo anterior que no reportó se suelta pasado el plazo.
    .filter((p) => !p.applyClaimedAt || now - Date.parse(p.applyClaimedAt) > APPLY_CLAIM_MS)
    .sort((a, b) => (a.status === 'aprobado' ? 0 : 1) - (b.status === 'aprobado' ? 0 : 1) || a.createdAt.localeCompare(b.createdAt))
    .slice(0, limit);
  const nowIso = new Date(now).toISOString();
  for (const p of pending) {
    p.applyClaimedAt = nowIso;
    p.applyStatus = p.applyStatus || 'pendiente';
    await redis.hset(REDIS_KEY, { [p.id]: JSON.stringify(p) });
  }
  // Números de Optimus que ya están en el panel (abiertos o resueltos), para que el robot no los
  // vuelva a traer. Solo los de los últimos 60 días: los demás ya no están amarillos allá.
  const cutoff = new Date(now - 60 * 86400000).toISOString();
  const known = todos.filter((p) => p.optimus?.numero && p.createdAt >= cutoff).map((p) => p.optimus!.numero);
  // Las lecturas que fallaron por falta de respuesta de GPSITO se reintentan aquí, de a pocas,
  // después de responder al robot.
  const inline = runAfterResponse(retryFailedAnalyses(redis).catch((err) => console.error('robot-pagos: relectura automática', err instanceof Error ? err.message : String(err))));
  if (inline) await inline;
  return json(200, { paused: false, items: pending.map(forRobot), known });
};

// Un pago en línea (PayU) que alguien aprobó a mano en el panel vuelve a rojo para Kelly: el robot
// no lo aplica (ver applyActionFor) y, si se quedara en "aprobado", nadie lo vería pendiente.
async function devolverPayUARojo(redis: any, pagos: PagoCliente[]): Promise<void> {
  const afectados = pagos.filter((p) => p.status === 'aprobado' && esPagoPayU(p) && p.applyStatus !== 'aplicado' && p.applyStatus !== 'manual');
  for (const p of afectados) {
    p.status = 'rojo';
    p.reasons = [PAYU_RAZON, `Lo había aprobado a mano ${p.resolvedByName || 'alguien'}.`];
    p.applyStatus = 'pendiente';
    p.applyClaimedAt = null;
    p.applyDetail = '';
    await redis.hset(REDIS_KEY, { [p.id]: JSON.stringify(p) });
    await logAudit(redis, ACTOR, 'pago_payu_a_rojo', p.clientName, 'pago en línea aprobado a mano: vuelve a rojo para aplicarlo en Optimus');
    await notifyResolvers(redis, `🤖 El pago de ${p.clientName} (${p.branch}) es por PayU / TuGPS24.com: el robot no lo aprueba. Pasó a rojo para aplicarlo a mano en Optimus.`, `pago-robot-payu:${p.id}`);
  }
}

function num(v: unknown): number | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  // Formato de Optimus: "98.000,00" → 98000
  const n = Number(s.replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function list(v: unknown): string[] {
  try {
    const arr = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(arr) ? arr.map((x) => String(x).trim().slice(0, 120)).filter(Boolean).slice(0, 50) : [];
  } catch {
    return [];
  }
}

function optimusInfoDe(get: (k: string) => unknown, numero: string): OptimusInfo {
  const guid = (v: unknown) => (/^[0-9a-f-]{36}$/i.test(String(v || '')) ? String(v) : undefined);
  return {
    numero,
    paymentId: guid(get('paymentId')),
    clientId: guid(get('clientId')),
    cedula: String(get('cedula') || '').replace(/\D/g, '').slice(0, 20) || undefined,
    monto: num(get('montoOptimus')),
    fecha: String(get('fecha') || '').trim().slice(0, 20),
    creadoPor: String(get('creadoPor') || '').trim().slice(0, 60),
    contratos: list(get('contratos')),
    contratosIds: list(get('contratosIds')),
    cargadoPorCliente: get('cargadoPorCliente') === true,
    formasPago: list(get('formasPago')),
    estadoCuenta: num(get('estadoCuenta')),
    pagoMinimo: num(get('pagoMinimo')),
    pendiente: num(get('pendiente')),
    reconectar: num(get('reconectar')),
  };
}

async function ingestSinImagen(redis: any, get: (k: string) => unknown, numero: string, clientName: string, branch: string): Promise<Response> {
  const existingId = await redis.get(OPTIMUS_KEY_PREFIX + numero);
  if (existingId) {
    const existing = await readPago(redis, String(existingId));
    if (existing) return json(200, { pago: forRobot(existing), existing: true });
  }
  const id = randomUUID();
  const claimed = await redis.set(OPTIMUS_KEY_PREFIX + numero, id, { nx: true, ex: INDEX_TTL_SECONDS });
  if (!claimed) {
    const other = await readPago(redis, String((await redis.get(OPTIMUS_KEY_PREFIX + numero)) || ''));
    if (other) return json(200, { pago: forRobot(other), existing: true });
  }
  const optimus = optimusInfoDe(get, numero);
  const uploader = optimus.creadoPor ? await findUserByUsername(redis, optimus.creadoPor.toLowerCase()).catch(() => null) : null;
  const now = new Date().toISOString();
  const pago: PagoCliente = {
    id,
    clientName,
    plate: '',
    branch,
    filePath: '',
    fileType: 'none',
    sha256: `sin-imagen-${id}`,
    phash: null,
    status: 'rojo',
    reasons: [optimus.cargadoPorCliente ? 'El cliente registró el pago en Optimus sin adjuntar el comprobante.' : 'El pago se registró en Optimus sin comprobante adjunto.'],
    notes: ['Sin imagen no hay nada que verificar: rechazar aquí y denegar en Optimus, o pedirle al cliente el comprobante.'],
    duplicateOf: null,
    extracted: null,
    analysisStartedAt: null,
    analysisError: null,
    createdAt: now,
    createdById: uploader?.id || ACTOR.userId,
    createdByName: uploader ? `${uploader.name} (en Optimus)` : `el cliente en Optimus (${optimus.creadoPor || 'sin usuario'})`,
    resolvedAt: null,
    resolvedByName: '',
    resolutionNote: '',
    source: 'optimus',
    optimus,
  };
  await savePago(redis, pago);
  await logAudit(redis, ACTOR, 'pago_sin_comprobante', clientName, `Optimus ${numero} · ${branch}`);
  await notifyResolvers(redis, `🔴 Pago sin comprobante en Optimus (${branch}): ${clientName}, N.º ${numero}. Rechazar y denegar.`, `pago-rojo:${id}`);
  return json(200, { pago: forRobot(pago), existing: false });
}

// El robot manda en cada ronda la lista completa de pagos pendientes (amarillos) en Optimus. Lo
// que el panel tenga abierto de Optimus y ya no esté pendiente allá lo resolvió una persona
// directo en Optimus (Kelly aprueba o deniega a mano mientras GPSITO lee): se cierra aquí como
// "resuelto en Optimus a mano" para que no quede en rojo para siempre. Solo pagos con más de
// 10 minutos en el panel, por si la lista se leyó a medias mientras uno entraba.
async function sincronizar(redis: any, body: any): Promise<Response> {
  const pendientes = new Set(list(body?.pendientes).map((n) => String(Number(n.replace(/\D/g, '')) || n)));
  if (body?.completo !== true) return json(400, { error: 'lista incompleta' });
  const cutoff = Date.now() - 10 * 60_000;
  const abiertos = (await readPagos(redis)).filter(
    (p) => p.source === 'optimus' && p.optimus?.numero && p.applyStatus !== 'aplicado' && p.applyStatus !== 'manual' && Date.parse(p.createdAt) < cutoff && !pendientes.has(String(Number(p.optimus.numero)))
  );
  const now = new Date().toISOString();
  for (const p of abiertos) {
    p.applyStatus = 'manual';
    p.applyAt = now;
    p.applyBy = 'Optimus';
    p.applyDetail = 'ya no estaba pendiente en Optimus: lo resolvió una persona allá';
    p.applyClaimedAt = null;
    await redis.hset(REDIS_KEY, { [p.id]: JSON.stringify(p) });
  }
  if (abiertos.length) await logAudit(redis, ACTOR, 'pagos_cerrados_optimus', 'robot de pagos', `${abiertos.length} resueltos a mano en Optimus`);
  return json(200, { cerrados: abiertos.length });
}

// El robot trae un pago amarillo de Optimus con la imagen del comprobante (JSON con la imagen en
// base64: un cuerpo multipart sin cabecera Origin lo rechaza la protección CSRF de Astro). El
// panel lo verifica como cualquier otro; el resultado vuelve al robot por GET como "aprobar".
async function ingest(redis: any, body: any): Promise<Response> {
  const get = (k: string) => body?.[k];
  const numero = String(get('numero') || '').replace(/\D/g, '').slice(0, 20);
  const clientName = String(get('cliente') || '').trim().slice(0, 120);
  const branch = String(get('sucursal') || '').trim().slice(0, 40);
  if (!numero || !clientName || !branch) return json(400, { error: 'numero, cliente y sucursal son obligatorios' });
  const b64 = String(get('file') || '').replace(/^data:[^;]+;base64,/, '');
  // Pago sin comprobante adjunto en Optimus (regla de Gabriel, 2026-10-07): entra en rojo de una
  // vez, sin lectura, para que Kelly o Wilmar lo rechacen y lo denieguen allá.
  if (get('sinImagen') === true) return ingestSinImagen(redis, get, numero, clientName, branch);
  if (b64.length < 200) return json(400, { error: 'falta la imagen del comprobante' });
  if (b64.length > MAX_INGEST_BYTES * 1.4) return json(400, { error: 'imagen demasiado grande' });
  const token = import.meta.env.BLOB_READ_WRITE_TOKEN as string | undefined;
  if (!token) return json(503, { error: 'almacenamiento no configurado' });
  const form = { get };

  const existingId = await redis.get(OPTIMUS_KEY_PREFIX + numero);
  if (existingId) {
    const existing = await readPago(redis, String(existingId));
    if (existing) return json(200, { pago: forRobot(existing), existing: true });
  }

  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length < 100) return json(400, { error: 'imagen vacía o mal codificada' });
  const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const isWebp = bytes.length > 12 && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!isPdf && !isPng && !isJpg && !isWebp) return json(400, { error: 'la imagen debe ser JPG, PNG, WebP o PDF' });
  const mediaType = isPdf ? 'application/pdf' : isPng ? 'image/png' : isWebp ? 'image/webp' : 'image/jpeg';
  const ext = isPdf ? 'pdf' : isPng ? 'png' : isWebp ? 'webp' : 'jpg';

  const id = randomUUID();
  const claimed = await redis.set(OPTIMUS_KEY_PREFIX + numero, id, { nx: true, ex: INDEX_TTL_SECONDS });
  if (!claimed) {
    const other = await readPago(redis, String((await redis.get(OPTIMUS_KEY_PREFIX + numero)) || ''));
    if (other) return json(200, { pago: forRobot(other), existing: true });
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const shaOwner = await redis.set(`${SHA_KEY_PREFIX}${sha256}`, id, { nx: true, ex: INDEX_TTL_SECONDS });
  const duplicateOf = shaOwner ? null : String((await redis.get(`${SHA_KEY_PREFIX}${sha256}`)) || '') || null;
  const phash = isPng || isJpg ? dHashFromImage(bytes, mediaType) : null;
  const filePath = `pagos-clientes/${id}.${ext}`;
  try {
    await put(filePath, bytes, { access: 'private', token, addRandomSuffix: false, contentType: mediaType, abortSignal: blobTimeout() });
  } catch (err) {
    await redis.del(OPTIMUS_KEY_PREFIX + numero).catch(() => {});
    if (shaOwner) await redis.del(`${SHA_KEY_PREFIX}${sha256}`).catch(() => {});
    return json(502, { error: 'no se pudo guardar la imagen: ' + (err instanceof Error ? err.message : String(err)) });
  }

  const guid = (v: unknown) => (/^[0-9a-f-]{36}$/i.test(String(v || '')) ? String(v) : undefined);
  const optimus: OptimusInfo = {
    numero,
    paymentId: guid(get('paymentId')),
    clientId: guid(get('clientId')),
    cedula: String(get('cedula') || '').replace(/\D/g, '').slice(0, 20) || undefined,
    monto: num(get('montoOptimus')),
    fecha: String(form.get('fecha') || '').trim().slice(0, 20),
    creadoPor: String(form.get('creadoPor') || '').trim().slice(0, 60),
    contratos: list(form.get('contratos')),
    contratosIds: list(form.get('contratosIds')),
    cargadoPorCliente: form.get('cargadoPorCliente') === true,
    formasPago: list(form.get('formasPago')),
    estadoCuenta: num(form.get('estadoCuenta')),
    pagoMinimo: num(form.get('pagoMinimo')),
    pendiente: num(form.get('pendiente')),
    reconectar: num(form.get('reconectar')),
  };
  // Las secretarías usan en Optimus el mismo usuario que en el panel: si "creado por" es una
  // de ellas, el comprobante queda a su nombre y recibe el aviso cuando se resuelva. Si no,
  // lo cargó el propio cliente (punto azul en Optimus).
  const uploader = optimus.creadoPor ? await findUserByUsername(redis, optimus.creadoPor.toLowerCase()).catch(() => null) : null;
  const now = new Date().toISOString();
  const pago: PagoCliente = {
    id,
    clientName,
    plate: '',
    branch,
    filePath,
    fileType: isPdf ? 'pdf' : 'image',
    sha256,
    phash,
    status: 'analizando',
    reasons: [],
    notes: [],
    duplicateOf: duplicateOf && duplicateOf !== id ? duplicateOf : null,
    extracted: null,
    analysisStartedAt: now,
    analysisError: null,
    createdAt: now,
    createdById: uploader?.id || ACTOR.userId,
    createdByName: uploader ? `${uploader.name} (en Optimus)` : `el cliente en Optimus (${optimus.creadoPor || 'sin usuario'})`,
    resolvedAt: null,
    resolvedByName: '',
    resolutionNote: '',
    source: 'optimus',
    optimus,
  };
  await savePago(redis, pago);
  if (phash) await redis.hset(PHASH_KEY, { [id]: phash });
  await logAudit(redis, ACTOR, 'pago_comprobante_optimus', clientName, `Optimus ${numero} · ${branch}`);
  const inline = runAfterResponse(analyzePago(redis, pago, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, mediaType));
  if (inline) await inline;
  return json(200, { pago: forRobot(pago), existing: false });
}

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
  if (body?.action === 'ingest') return ingest(redis, body);
  if (body?.action === 'sincronizar') return sincronizar(redis, body);
  const id = String(body.id || '');
  const result = String(body.result || '');
  const detail = String(body.detail || '').trim().slice(0, 400);
  if (!id || (result !== 'aplicado' && result !== 'fallo')) return json(400, { error: 'id y result (aplicado | fallo) son obligatorios' });
  const pago = await readPago(redis, id);
  if (!pago) return json(404, { error: 'no encontrado' });
  const action = applyActionFor(pago);
  if (!action) return json(409, { error: 'el comprobante ya no está para aprobar ni denegar' });
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
  pago.applyDetail = detail || (result === 'aplicado' ? (action === 'denegar' ? 'denegado en Optimus' : 'aprobado en Optimus') : '');
  pago.applyScreenshotPath = screenshotPath;
  pago.applyStatus = result === 'aplicado' ? 'aplicado' : 'fallo';
  await redis.hset(REDIS_KEY, { [pago.id]: JSON.stringify(pago) });
  await redis.hset(CONFIG_KEY, { robotLastResult: `${now} · ${pago.clientName}: ${result}${detail ? ' — ' + detail : ''}`.slice(0, 200) }).catch(() => {});
  await logAudit(redis, ACTOR, result === 'aplicado' ? (action === 'denegar' ? 'pago_denegado_robot' : 'pago_aplicado_robot') : 'pago_aplicacion_fallida', pago.clientName, pago.applyDetail || 'sin detalle');

  if (result === 'fallo') {
    const exhausted = pago.applyAttempts >= APPLY_MAX_ATTEMPTS;
    await notifyResolvers(
      redis,
      `🤖 ${exhausted ? 'El robot no pudo' : 'El robot falló al'} ${action === 'denegar' ? 'denegar' : 'aprobar'} el pago de ${pago.clientName} (${pago.branch})${detail ? ': ' + detail : ''}${exhausted ? '. Hay que aplicarlo a mano.' : `. Reintenta (${pago.applyAttempts}/${APPLY_MAX_ATTEMPTS}).`}`,
      `pago-robot:${pago.id}`
    );
  }
  return json(200, { ok: true, applyStatus: pago.applyStatus, attempts: pago.applyAttempts });
};
