import type { APIRoute } from 'astro';
import { createHash, randomUUID } from 'node:crypto';
import { put, get, del } from '@vercel/blob';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { pushNotification } from '../../lib/notifications';
import { sendGabotMessage } from '../../lib/gabot';
import { readHashValues, parseJsonValues } from '../../lib/redis-hash';
import { pageOf } from '../../lib/list-page';
import { blobTimeout } from '../../lib/blob-path';
import { detectImageType } from '../../lib/uploads';
import { dHashFromImage } from '../../lib/image-hash';
import { runAfterResponse } from '../../lib/background';
import { getLastAnthropicFailure } from '../../lib/anthropic-client';
import { checkAndIncrementRateLimit } from '../../lib/rate-limit';
import { reportIncident } from '../../lib/incidents';
import {
  SESSION_COOKIE,
  getSession,
  verifySameOrigin,
  findUserById,
  getUsers,
  branchesOf,
  canAccessVerificacionPagos,
  canResolveVerificacionPagos,
  KELLY_USERNAME,
  WILMAR_USERNAME,
  type Session,
} from '../../lib/auth';
import {
  CONFIG_KEY,
  PHASH_KEY,
  REF_KEY_PREFIX,
  SHA_KEY_PREFIX,
  INDEX_TTL_SECONDS,
  PHASH_MAX_DISTANCE,
  DEFAULT_DESTINOS,
  evaluate,
  hammingHex,
  normalizeBank,
  normalizeRef,
  readReceipt,
  isApplyPending,
  APPLY_MAX_ATTEMPTS,
  ANALYSIS_NO_RESPONSE,
  ANALYSIS_AUTO_RETRIES,
  type PagoCliente,
  type PriorMatch,
} from '../../lib/pagos-verificacion';

export const prerender = false;

export const REDIS_KEY = 'internal:pagos-clientes';
const BLOB_PREFIX = 'pagos-clientes/';
const MAX_FILE_BYTES = 8 * 1024 * 1024;
// Anthropic acepta imágenes de hasta 5 MB; el navegador ya las reduce a 1600 px, esto es el tope duro.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const UPLOADS_PER_DAY = 60;
const ANALYSIS_PENDING_MS = 4 * 60_000;
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

async function requireAccess(cookies: any): Promise<Session | null> {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessVerificacionPagos(session)) return null;
  return session;
}

export async function readPagos(redis: any): Promise<PagoCliente[]> {
  return parseJsonValues<PagoCliente>(await readHashValues(redis, REDIS_KEY))
    .map((p) => ({ reasons: [], notes: [], duplicateOf: null, extracted: null, analysisStartedAt: null, analysisError: null, resolvedAt: null, resolvedByName: '', resolutionNote: '', plate: '', ...p }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function readPago(redis: any, id: string): Promise<PagoCliente | null> {
  const raw = await redis.hget(REDIS_KEY, id);
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : (raw as PagoCliente);
  } catch {
    return null;
  }
}

export async function savePago(redis: any, pago: PagoCliente): Promise<void> {
  await redis.hset(REDIS_KEY, { [pago.id]: JSON.stringify(pago) });
}

// Los destinos fijos de la empresa siempre valen; lo guardado desde la pantalla se suma.
async function readDestinos(redis: any): Promise<string[]> {
  const raw = await redis.hget(CONFIG_KEY, 'destinos').catch(() => null);
  let extra: string[] = [];
  try {
    const list = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
    extra = Array.isArray(list) ? list.map((d: unknown) => String(d).slice(0, 80)) : [];
  } catch {
    extra = [];
  }
  return [...new Set([...DEFAULT_DESTINOS, ...extra])];
}

// Un comprobante "analizando" cuya invocación murió no debe quedarse así para siempre.
function withTimeouts(p: PagoCliente): PagoCliente {
  if (p.status === 'analizando' && p.analysisStartedAt && Date.now() - Date.parse(p.analysisStartedAt) > ANALYSIS_PENDING_MS) {
    return { ...p, status: 'rojo', reasons: ['La lectura se interrumpió antes de terminar; pide "Volver a leer".'], analysisError: p.analysisError || 'interrumpido' };
  }
  return p;
}

function toClient(p: PagoCliente) {
  const t = withTimeouts(p);
  return {
    ...t,
    // Un rechazado de Optimus también queda pendiente allá: el robot lo deniega en la siguiente ronda.
    applyStatus: t.applyStatus || (isApplyPending(t) || (t.status === 'rechazado' && t.source === 'optimus') ? 'pendiente' : t.status === 'verde' || t.status === 'aprobado' ? 'fallo' : undefined),
    fileUrl: p.filePath ? '/api/blob-file?path=' + encodeURIComponent(p.filePath) : null,
    applyScreenshotUrl: t.applyScreenshotPath ? '/api/blob-file?path=' + encodeURIComponent(t.applyScreenshotPath) : null,
  };
}

// Relectura automática de los comprobantes que quedaron en "GPSITO no respondió": uno detrás de
// otro, nunca en ráfaga. La llama el robot en cada ronda (cada 20 min).
const sinRespuesta = (p: PagoCliente) => (p.analysisError || '').startsWith(ANALYSIS_NO_RESPONSE) || p.analysisError === 'interrumpido' || (p.analysisError || '').startsWith('Falló la lectura');

// Rojos sin respuesta de GPSITO, y aprobados a mano cuyo valor GPSITO aún no leyó (el robot no
// los aplica sin esa lectura y la comparación con el monto de la secretaria).
export function failedAnalysisCandidates(pagos: PagoCliente[], ignoreRetryCap = false): PagoCliente[] {
  return pagos
    .filter((p) => p.filePath && p.fileType !== 'none')
    .filter((p) => (p.status === 'rojo' && sinRespuesta(p)) || (p.status === 'aprobado' && isApplyPending(p) && !p.extracted?.valor))
    .filter((p) => ignoreRetryCap || (p.analysisRetries || 0) < ANALYSIS_AUTO_RETRIES)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function retryFailedAnalyses(redis: any, max = 6, ignoreRetryCap = false, budgetMs = 240_000): Promise<number> {
  const token = import.meta.env.BLOB_READ_WRITE_TOKEN as string | undefined;
  if (!token) return 0;
  const started = Date.now();
  const candidates = failedAnalysisCandidates(await readPagos(redis), ignoreRetryCap).slice(0, max);
  let done = 0;
  for (const pago of candidates) {
    // Una invocación de Vercel dura como mucho 300 s: lo que no quepa lo toma la siguiente ronda.
    if (Date.now() - started > budgetMs) break;
    const stored = await fetchStoredFile(token, pago.filePath).catch(() => null);
    if (!stored) continue;
    // Un aprobado a mano conserva su estado mientras se relee (si no, se perdería la decisión).
    if (pago.status !== 'aprobado') {
      pago.status = 'analizando';
      pago.reasons = [];
      pago.notes = [];
      pago.duplicateOf = null;
    }
    pago.analysisStartedAt = new Date().toISOString();
    pago.analysisError = null;
    pago.analysisRetries = ignoreRetryCap ? 1 : (pago.analysisRetries || 0) + 1;
    await savePago(redis, pago);
    await analyzePago(redis, pago, stored.bytes, stored.mediaType);
    done++;
  }
  return done;
}

export async function readRobotState(redis: any): Promise<{ paused: boolean; lastSeenAt: string | null; lastResult: string }> {
  const [paused, lastSeen, lastResult] = await Promise.all([
    redis.hget(CONFIG_KEY, 'robotPaused').catch(() => null),
    redis.get('internal:cron-ok:robot-pagos').catch(() => null),
    redis.hget(CONFIG_KEY, 'robotLastResult').catch(() => null),
  ]);
  return { paused: String(paused || '') === '1', lastSeenAt: lastSeen ? String(lastSeen) : null, lastResult: lastResult ? String(lastResult) : '' };
}

function priorFrom(p: PagoCliente | null, kind: PriorMatch['kind']): PriorMatch | null {
  if (!p) return null;
  return { id: p.id, createdAt: p.createdAt, clientName: p.clientName, createdByName: p.createdByName, kind };
}

async function notifyRed(redis: any, pago: PagoCliente): Promise<void> {
  const users = await getUsers(redis);
  const targets = users.filter(
    (u) => u.active && (u.role === 'admin' || [KELLY_USERNAME, WILMAR_USERNAME].includes(u.username.toLowerCase()) || (u.role === 'gerente' && branchesOf(u).includes(pago.branch)))
  );
  const message = `🔴 Comprobante en rojo (${pago.branch}): ${pago.clientName} — ${pago.reasons[0] || 'revisar'}`;
  await Promise.allSettled(
    targets.map(async (u) => {
      await pushNotification(redis, u.id, { type: 'pago-rojo', message, link: '/interno/verificacion-pagos', key: `pago-rojo:${pago.id}`, pushBody: `Comprobante en rojo en ${pago.branch}` });
      if (u.role === 'admin' || [KELLY_USERNAME, WILMAR_USERNAME].includes(u.username.toLowerCase())) {
        await sendGabotMessage(redis, u.id, `${message}\nSubido por ${pago.createdByName}. Revísalo en Verificación de pagos.`);
      }
    })
  );
}

// Lee el comprobante con GPSITO y aplica las reglas. Corre después de responder.
export async function analyzePago(redis: any, pago: PagoCliente, bytes: ArrayBuffer, mediaType: string): Promise<void> {
  try {
    let result = await readReceipt(redis, pago.id, bytes, mediaType, pago.clientName);
    // Sin respuesta (límite por minuto o sobrecarga): se espera con un desfase aleatorio para no
    // volver a chocar con las demás lecturas de la misma ráfaga, y se intenta dos veces más.
    for (let i = 0; !result && i < 2; i++) {
      await new Promise((r) => setTimeout(r, 15_000 + i * 20_000 + Math.random() * 15_000));
      result = await readReceipt(redis, pago.id, bytes, mediaType, pago.clientName);
    }
    const fresh = (await readPago(redis, pago.id)) || pago;
    // Relectura de un comprobante que una persona ya aprobó a mano: la aprobación se respeta
    // salvo que el valor leído no coincida con el que digitó la secretaria (vuelve a rojo).
    const aprobadoAMano = fresh.status === 'aprobado';
    if (!result) {
      const motivo = getLastAnthropicFailure();
      fresh.analysisStartedAt = null;
      fresh.analysisError = ANALYSIS_NO_RESPONSE + (motivo ? ` (${motivo})` : '');
      if (aprobadoAMano) {
        fresh.notes = [...fresh.notes.filter((n) => !n.startsWith('GPSITO no pudo leer')), 'GPSITO no pudo leer el valor del comprobante; el robot no lo aplica hasta leerlo.'];
      } else {
        fresh.status = 'rojo';
        fresh.reasons = [`GPSITO no pudo leer el comprobante en este momento${motivo ? ' (' + motivo + ')' : ''}; se reintentará solo en la próxima ronda del robot.`];
      }
      await savePago(redis, fresh);
      await reportIncident(redis, 'pagos_lectura_fallida', `comprobante ${pago.id.slice(0, 8)} de ${pago.branch}${motivo ? ' · ' + motivo : ''}`);
      return;
    }
    const extracted = result.extracted;
    // Si el JSON no se pudo interpretar, la respuesta cruda queda visible en la tarjeta para
    // entender qué pasó, en vez de un "no pudo leer" a secas.
    if (!extracted && result.rawText) fresh.analysisError = ('respuesta: ' + result.rawText.replace(/\s+/g, ' ')).slice(0, 300);
    const prior: PriorMatch[] = [];
    if (fresh.duplicateOf) {
      const dup = priorFrom(await readPago(redis, fresh.duplicateOf), 'archivo');
      if (dup) prior.push(dup);
    }
    // La referencia se reserva en el mismo instante: dos secretarías subiendo el mismo
    // comprobante a la vez no pueden salir ambas en verde.
    const ref = extracted ? normalizeRef(extracted.referencia) : '';
    if (ref) {
      const refKey = `${REF_KEY_PREFIX}${normalizeBank(extracted!.banco)}:${ref}`;
      const reserved = await redis.set(refKey, fresh.id, { nx: true, ex: INDEX_TTL_SECONDS });
      if (!reserved) {
        const ownerId = String((await redis.get(refKey)) || '');
        if (ownerId && ownerId !== fresh.id) {
          const owner = await readPago(redis, ownerId);
          prior.push(priorFrom(owner, 'referencia') || { id: ownerId, createdAt: '', clientName: 'desconocido', createdByName: 'desconocido', kind: 'referencia' });
          if (!fresh.duplicateOf) fresh.duplicateOf = ownerId;
        }
      }
    }
    if (fresh.phash) {
      const all = (await redis.hgetall(PHASH_KEY)) || {};
      let best: { id: string; dist: number } | null = null;
      for (const [id, hash] of Object.entries(all as Record<string, string>)) {
        if (id === fresh.id) continue;
        const dist = hammingHex(fresh.phash, String(hash));
        if (dist <= PHASH_MAX_DISTANCE && (!best || dist < best.dist)) best = { id, dist };
      }
      if (best && !prior.some((p) => p.id === best!.id)) {
        // Los comprobantes de una misma app (Nequi, Bre-B) comparten plantilla y quedan a pocos
        // bits aunque sean pagos distintos. Si los dos traen referencia legible y distinta, no es
        // el mismo comprobante y la parecido visual no cuenta; solo cuenta cuando alguna
        // referencia no se pudo leer o cuando coinciden.
        const otherPago = await readPago(redis, best.id);
        const otherRef = normalizeRef(otherPago?.extracted?.referencia || '');
        const distinguibles = ref && otherRef && ref !== otherRef;
        const other = distinguibles ? null : priorFrom(otherPago, 'imagen');
        if (other) {
          prior.push(other);
          if (!fresh.duplicateOf) fresh.duplicateOf = other.id;
        }
      }
    }
    const destinos = await readDestinos(redis);
    const verdict = evaluate(extracted, fresh.clientName, destinos, prior, undefined, fresh.optimus);
    fresh.extracted = extracted;
    fresh.analysisStartedAt = null;
    if (aprobadoAMano) {
      const descuadre = verdict.reasons.filter((r) => r.startsWith('El monto registrado en Optimus'));
      if (descuadre.length) {
        fresh.status = 'rojo';
        fresh.reasons = [...descuadre, `Lo había aprobado a mano ${fresh.resolvedByName || 'alguien'}; revisar antes de aplicar.`];
        fresh.notes = verdict.notes;
      } else {
        fresh.notes = [...verdict.notes, ...(extracted ? [] : ['GPSITO no pudo interpretar el comprobante; el robot no lo aplica hasta leerlo.'])];
      }
    } else {
      fresh.reasons = verdict.reasons;
      fresh.notes = verdict.notes;
      fresh.status = verdict.reasons.length ? 'rojo' : 'verde';
    }
    if (extracted) fresh.analysisError = null;
    else fresh.notes = [...fresh.notes, fresh.analysisError || 'sin respuesta interpretable'];
    await savePago(redis, fresh);
    await logAudit(redis, { userId: 'gpsito', username: 'GPSITO' }, 'pago_verificado', fresh.clientName, `${fresh.status}${fresh.reasons.length ? ': ' + fresh.reasons.join(' ') : ''}`.slice(0, 300));
    if (fresh.status === 'rojo') await notifyRed(redis, fresh);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('verificacion-pagos: fallo el analisis', message);
    const fresh = (await readPago(redis, pago.id).catch(() => null)) || pago;
    fresh.analysisStartedAt = null;
    fresh.analysisError = message.slice(0, 200);
    if (fresh.status !== 'aprobado') {
      fresh.status = 'rojo';
      fresh.reasons = ['Falló la lectura del comprobante; pide "Volver a leer".'];
    }
    await savePago(redis, fresh).catch(() => {});
  }
}

export async function fetchStoredFile(token: string, path: string): Promise<{ bytes: ArrayBuffer; mediaType: string } | null> {
  const result = await get(path, { access: 'private', token, abortSignal: blobTimeout(30_000) });
  if (!result || result.statusCode !== 200 || !result.stream) return null;
  const bytes = await new Response(result.stream).arrayBuffer();
  return { bytes, mediaType: result.blob.contentType || (path.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg') };
}

export const GET: APIRoute = async ({ cookies, url }) => {
  const session = await requireAccess(cookies);
  if (!session) return json(401, { error: 'unauthorized' });
  const redis = getRedis();
  if (!redis) return json(503, { error: 'not configured' });
  const canResolve = canResolveVerificacionPagos(session);
  const me = await findUserById(redis, session.userId);
  const myBranches = branchesOf(me);

  const id = url.searchParams.get('id');
  if (id) {
    const pago = await readPago(redis, id);
    if (!pago) return json(404, { error: 'no encontrado' });
    return json(200, { pago: toClient(pago) });
  }

  // Quien entra a esta pantalla ve todas las sucursales (Kelly, Wilmar, Cristian, admin).
  const all = await readPagos(redis);
  let items = all;
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const status = url.searchParams.get('status') || '';
  const branch = url.searchParams.get('branch') || '';
  const month = url.searchParams.get('month') || '';
  if (q) items = items.filter((p) => p.clientName.toLowerCase().includes(q) || p.plate.toLowerCase().includes(q) || (p.extracted?.referencia || '').toLowerCase().includes(q) || (p.extracted?.pagador || '').toLowerCase().includes(q));
  if (branch) items = items.filter((p) => p.branch === branch);
  if (month) items = items.filter((p) => p.createdAt.slice(0, 7) === month);
  const withStatus = items.map(withTimeouts);
  const stats = { total: withStatus.length, verde: 0, rojo: 0, aprobado: 0, rechazado: 0, analizando: 0, porAplicar: 0, aplicados: 0, fallosAplicar: 0 } as Record<string, number>;
  for (const p of withStatus) {
    stats[p.status] = (stats[p.status] || 0) + 1;
    if (isApplyPending(p)) stats.porAplicar++;
    if (p.applyStatus === 'aplicado' || p.applyStatus === 'manual') stats.aplicados++;
    if (p.applyStatus === 'fallo' && !isApplyPending(p)) stats.fallosAplicar++;
  }
  const filtered = status ? withStatus.filter((p) => p.status === status) : withStatus;
  const months = [...new Set(items.map((p) => p.createdAt.slice(0, 7)))].sort().reverse();
  const branches = [...new Set(items.map((p) => p.branch))].sort();
  const paged = pageOf(url, filtered);
  return json(200, {
    pagos: paged.page.map(toClient),
    ...paged.meta,
    stats,
    months,
    branches,
    canResolve,
    myBranches,
    destinos: canResolve ? await readDestinos(redis) : undefined,
    robot: canResolve ? { ...(await readRobotState(redis)), isAdmin: session.role === 'admin', sinLeer: failedAnalysisCandidates(all, true).length } : undefined,
    currentUserId: session.userId,
  });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) return json(403, { error: 'invalid origin' });
  const session = await requireAccess(cookies);
  if (!session) return json(401, { error: 'unauthorized' });
  const redis = getRedis();
  if (!redis) return json(503, { error: 'not configured' });
  const token = import.meta.env.BLOB_READ_WRITE_TOKEN as string | undefined;
  if (!token) return json(503, { error: 'almacenamiento de archivos no configurado' });
  if (!request.headers.get('content-type')?.includes('multipart/form-data')) return json(400, { error: 'invalid content-type' });

  const form = await request.formData();
  const clientName = String(form.get('clientName') || '').trim().slice(0, 120);
  const plate = String(form.get('plate') || '').trim().toUpperCase().slice(0, 12);
  const phashRaw = String(form.get('phash') || '').trim().toLowerCase();
  const phash = /^[0-9a-f]{16}$/.test(phashRaw) ? phashRaw : null;
  const file = form.get('file');
  if (!clientName) return json(400, { error: 'escribe el nombre completo del cliente' });
  if (!(file instanceof File) || file.size < 100) return json(400, { error: 'adjunta el comprobante (captura o PDF)' });
  if (file.size > MAX_FILE_BYTES) return json(400, { error: 'el comprobante debe pesar menos de 8 MB' });

  const me = await findUserById(redis, session.userId);
  const myBranches = branchesOf(me);
  const requestedBranch = String(form.get('branch') || '').trim();
  const branch = canResolveVerificacionPagos(session) && requestedBranch ? requestedBranch : myBranches.includes(requestedBranch) ? requestedBranch : myBranches[0] || '';
  if (!branch) return json(400, { error: 'tu usuario no tiene sucursal asignada; pídele al administrador que la configure' });

  const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  const isPdf = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46;
  const imageType = isPdf ? null : await detectImageType(file);
  if (!isPdf && !imageType) return json(400, { error: 'el comprobante debe ser una imagen (JPG, PNG, WebP) o un PDF' });
  if (imageType === 'image/gif') return json(400, { error: 'formato no admitido para comprobantes (GIF)' });
  if (!isPdf && file.size > MAX_IMAGE_BYTES) return json(400, { error: 'la imagen debe pesar menos de 5 MB' });

  if (!(await checkAndIncrementRateLimit(redis, `internal:pagos-clientes-rate:${session.userId}`, UPLOADS_PER_DAY, 86400))) {
    return json(429, { error: `ya se subieron ${UPLOADS_PER_DAY} comprobantes hoy con tu usuario; vuelve a intentarlo mañana` });
  }

  const bytes = await file.arrayBuffer();
  const sha256 = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
  // Si el navegador no mandó huella (o la mandó mal), se calcula aquí.
  const serverHash = phash || (imageType ? dHashFromImage(Buffer.from(bytes), imageType) : null);
  const id = randomUUID();
  const mediaType = isPdf ? 'application/pdf' : imageType!;
  const ext = isPdf ? 'pdf' : imageType === 'image/png' ? 'png' : imageType === 'image/webp' ? 'webp' : 'jpg';
  const filePath = `${BLOB_PREFIX}${id}.${ext}`;

  // Mismo archivo byte a byte: se sabe antes de leerlo. La marca se reserva atómicamente.
  const shaOwner = await redis.set(`${SHA_KEY_PREFIX}${sha256}`, id, { nx: true, ex: INDEX_TTL_SECONDS });
  const duplicateOf = shaOwner ? null : String((await redis.get(`${SHA_KEY_PREFIX}${sha256}`)) || '') || null;

  try {
    await put(filePath, Buffer.from(bytes), { access: 'private', token, addRandomSuffix: false, contentType: mediaType, abortSignal: blobTimeout() });
  } catch (err) {
    if (shaOwner) await redis.del(`${SHA_KEY_PREFIX}${sha256}`).catch(() => {});
    return json(502, { error: 'no se pudo guardar el comprobante: ' + (err instanceof Error ? err.message : String(err)) });
  }

  const now = new Date().toISOString();
  const pago: PagoCliente = {
    id,
    clientName,
    plate,
    branch,
    filePath,
    fileType: isPdf ? 'pdf' : 'image',
    sha256,
    phash: serverHash,
    status: 'analizando',
    source: 'manual',
    optimus: null,
    reasons: [],
    notes: [],
    duplicateOf: duplicateOf && duplicateOf !== id ? duplicateOf : null,
    extracted: null,
    analysisStartedAt: now,
    analysisError: null,
    createdAt: now,
    createdById: session.userId,
    createdByName: me?.name || session.username,
    resolvedAt: null,
    resolvedByName: '',
    resolutionNote: '',
  };
  await savePago(redis, pago);
  if (serverHash) await redis.hset(PHASH_KEY, { [id]: serverHash });
  await logAudit(redis, session, 'pago_comprobante_subido', clientName, `${branch} · ${isPdf ? 'PDF' : 'imagen'}`);

  const work = analyzePago(redis, pago, bytes, mediaType);
  const inline = runAfterResponse(work);
  if (inline) await inline;
  return json(200, { pago: toClient(pago) });
};

export const PATCH: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) return json(403, { error: 'invalid origin' });
  const session = await requireAccess(cookies);
  if (!session) return json(401, { error: 'unauthorized' });
  const redis = getRedis();
  if (!redis) return json(503, { error: 'not configured' });
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'invalid body' });
  }
  const action = String(body.action || '');
  const canResolve = canResolveVerificacionPagos(session);

  if (action === 'robot') {
    if (!canResolve) return json(403, { error: 'solo Kelly, Wilmar o el administrador pausan el robot' });
    const paused = body.paused === true;
    await redis.hset(CONFIG_KEY, { robotPaused: paused ? '1' : '0' });
    await logAudit(redis, session, paused ? 'pagos_robot_pausado' : 'pagos_robot_reanudado', 'robot de pagos', '');
    return json(200, { robot: await readRobotState(redis) });
  }

  // Relee de una vez todos los comprobantes que GPSITO no pudo leer (p. ej. tras una caída de la
  // API): en orden, uno detrás de otro, dentro del tiempo de una invocación; lo que no quepa lo
  // sigue tomando el robot en cada ronda. Botón del panel para Kelly, Wilmar y admin.
  if (action === 'releer-fallidas') {
    if (!canResolve) return json(403, { error: 'solo Kelly, Wilmar o el administrador pueden relanzar las lecturas' });
    if (!(await checkAndIncrementRateLimit(redis, `internal:pagos-clientes-rate:releer-fallidas:${session.userId}`, 6, 3600))) {
      return json(429, { error: 'ya se relanzó varias veces en la última hora; espera a que terminen' });
    }
    const pendientes = failedAnalysisCandidates(await readPagos(redis), true).length;
    await logAudit(redis, session, 'pagos_relectura_masiva', 'verificación de pagos', `${pendientes} comprobantes`);
    const inline = runAfterResponse(retryFailedAnalyses(redis, 40, true).catch((err) => console.error('verificacion-pagos: relectura masiva', err instanceof Error ? err.message : String(err))));
    if (inline) await inline;
    return json(200, { pendientes });
  }

  // Reinicio de pruebas: borra todo lo traído de Optimus (registros, índices y archivos) para que
  // el robot lo vuelva a traer con las reglas nuevas. Solo admin.
  if (action === 'borrar-optimus') {
    if (session.role !== 'admin') return json(403, { error: 'solo el administrador puede reiniciar lo traído de Optimus' });
    const token = import.meta.env.BLOB_READ_WRITE_TOKEN as string | undefined;
    const todos = (await readPagos(redis)).filter((p) => p.source === 'optimus');
    const keys: string[] = [];
    const blobs: string[] = [];
    for (const p of todos) {
      keys.push(`${SHA_KEY_PREFIX}${p.sha256}`);
      if (p.optimus?.numero) keys.push(`internal:pagos-clientes-optimus:${p.optimus.numero}`);
      if (p.extracted?.referencia) keys.push(`${REF_KEY_PREFIX}${normalizeBank(p.extracted.banco)}:${normalizeRef(p.extracted.referencia)}`);
      blobs.push(p.filePath);
      if (p.applyScreenshotPath) blobs.push(p.applyScreenshotPath);
    }
    if (todos.length) {
      await redis.hdel(REDIS_KEY, ...todos.map((p) => p.id));
      await redis.hdel(PHASH_KEY, ...todos.map((p) => p.id)).catch(() => {});
      for (let i = 0; i < keys.length; i += 100) await redis.del(...keys.slice(i, i + 100)).catch(() => {});
      if (token && blobs.length) await del(blobs, { token, abortSignal: blobTimeout(30_000) }).catch(() => {});
    }
    await logAudit(redis, session, 'pagos_optimus_reinicio', `${todos.length} comprobantes`, 'borrados para que el robot los vuelva a traer');
    return json(200, { borrados: todos.length });
  }

  if (action === 'config') {
    if (!canResolve) return json(403, { error: 'solo Kelly, Wilmar o el administrador cambian las cuentas' });
    const destinos = Array.isArray(body.destinos) ? body.destinos.map((d: unknown) => String(d).trim().slice(0, 80)).filter(Boolean).slice(0, 30) : [];
    if (!destinos.length) return json(400, { error: 'deja al menos una cuenta o llave' });
    await redis.hset(CONFIG_KEY, { destinos: JSON.stringify(destinos) });
    await logAudit(redis, session, 'pagos_destinos_update', `${destinos.length} cuentas`, destinos.join(' | ').slice(0, 300));
    return json(200, { destinos });
  }

  const pago = await readPago(redis, String(body.id || ''));
  if (!pago) return json(404, { error: 'no encontrado' });
  const me = await findUserById(redis, session.userId);
  if (!canResolve && !branchesOf(me).includes(pago.branch)) return json(403, { error: 'forbidden' });
  const byName = me?.name || session.username;
  const now = new Date().toISOString();

  if (action === 'aprobar' || action === 'rechazar') {
    if (!canResolve) return json(403, { error: 'solo Kelly, Wilmar o el administrador aprueban o rechazan' });
    const note = String(body.note || '').trim().slice(0, 300);
    if (!note) return json(400, { error: 'escribe el motivo' });
    if (pago.status === 'analizando' && !withTimeouts(pago).reasons.length) return json(409, { error: 'GPSITO todavía está leyendo este comprobante' });
    pago.status = action === 'aprobar' ? 'aprobado' : 'rechazado';
    pago.resolvedAt = now;
    pago.resolvedByName = byName;
    pago.resolutionNote = note;
    // La decisión de una persona abre de nuevo el turno del robot (aprobar o denegar en Optimus),
    // aunque intentos anteriores con la decisión contraria hayan fallado.
    if (pago.applyStatus !== 'aplicado' && pago.applyStatus !== 'manual') {
      pago.applyStatus = 'pendiente';
      pago.applyAttempts = 0;
      pago.applyClaimedAt = null;
      pago.applyDetail = '';
    }
    await savePago(redis, pago);
    await logAudit(redis, session, action === 'aprobar' ? 'pago_aprobado_manual' : 'pago_rechazado', pago.clientName, note);
    if (pago.createdById !== session.userId) {
      await pushNotification(redis, pago.createdById, {
        type: 'pago-resuelto',
        message: `${action === 'aprobar' ? '✅ Aprobado' : '❌ Rechazado'} el comprobante de ${pago.clientName}: ${note}`,
        link: '/interno/verificacion-pagos',
        key: `pago-resuelto:${pago.id}`,
      }).catch(() => {});
    }
    return json(200, { pago: toClient(pago) });
  }

  // Alguien aplicó el pago en el sistema de pagos por su cuenta: el robot no debe repetirlo.
  if (action === 'aplicado-manual') {
    if (!canResolve) return json(403, { error: 'solo Kelly, Wilmar o el administrador marcan aplicado a mano' });
    if (pago.status !== 'verde' && pago.status !== 'aprobado') return json(409, { error: 'solo se aplica un comprobante en verde o aprobado' });
    pago.applyStatus = 'manual';
    pago.applyAt = now;
    pago.applyBy = byName;
    pago.applyDetail = String(body.note || '').trim().slice(0, 300);
    await savePago(redis, pago);
    await logAudit(redis, session, 'pago_aplicado_manual', pago.clientName, pago.applyDetail);
    return json(200, { pago: toClient(pago) });
  }

  // Tras corregir algo en el sistema de pagos, se le da otra oportunidad al robot.
  if (action === 'reintentar-aplicar') {
    if (!canResolve) return json(403, { error: 'solo Kelly, Wilmar o el administrador reintentan la aplicación' });
    if (pago.status !== 'verde' && pago.status !== 'aprobado') return json(409, { error: 'solo se aplica un comprobante en verde o aprobado' });
    pago.applyStatus = 'pendiente';
    pago.applyAttempts = 0;
    pago.applyClaimedAt = null;
    pago.applyDetail = '';
    await savePago(redis, pago);
    await logAudit(redis, session, 'pago_aplicacion_reintento', pago.clientName, `antes: ${APPLY_MAX_ATTEMPTS} intentos agotados`);
    return json(200, { pago: toClient(pago) });
  }

  if (action === 'reanalizar') {
    const current = withTimeouts(pago);
    if (current.status === 'analizando') return json(409, { error: 'ya se está leyendo' });
    if (current.status === 'aprobado' || current.status === 'rechazado') return json(409, { error: 'ya fue resuelto a mano' });
    if (current.applyStatus === 'aplicado' || current.applyStatus === 'manual') return json(409, { error: 'ya se resolvió en Optimus' });
    const token = import.meta.env.BLOB_READ_WRITE_TOKEN as string | undefined;
    if (!token) return json(503, { error: 'almacenamiento de archivos no configurado' });
    if (!(await checkAndIncrementRateLimit(redis, `internal:pagos-clientes-rate:reanalizar:${session.userId}`, 30, 86400))) {
      return json(429, { error: 'demasiadas relecturas hoy' });
    }
    const stored = await fetchStoredFile(token, pago.filePath).catch(() => null);
    if (!stored) return json(502, { error: 'no se pudo recuperar el archivo del comprobante' });
    pago.status = 'analizando';
    pago.analysisStartedAt = now;
    pago.analysisError = null;
    pago.reasons = [];
    pago.notes = [];
    pago.duplicateOf = null;
    await savePago(redis, pago);
    const inline = runAfterResponse(analyzePago(redis, pago, stored.bytes, stored.mediaType));
    if (inline) await inline;
    return json(200, { pago: toClient(pago) });
  }

  return json(400, { error: 'acción inválida' });
};
