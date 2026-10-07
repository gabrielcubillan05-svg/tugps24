import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { put, del, get } from '@vercel/blob';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, canAccessSimConsumos, findUserById, verifySameOrigin, type Session } from '../../lib/auth';
import { readHashValues, parseJsonValues } from '../../lib/redis-hash';
import { computeSimStats, periodOf, normalizeSimNumber, DEFAULT_PLAN_MB, DEFAULT_LIMIT_MB, KB_PER_MB, type SimLine, type SimStats } from '../../lib/sim-consumos';
import { analyzeSimLote, askSimLote } from '../../lib/sim-consumos-agent';
import { getLastAnthropicFailure } from '../../lib/anthropic-client';
import { runAfterResponse } from '../../lib/background';
import { readInventory } from './inventario';
import { checkAndIncrementRateLimit } from '../../lib/rate-limit';
import { blobTimeout } from '../../lib/blob-path';

export const prerender = false;

// Lotes de consumo de SIM: cada lote es una carga (uno o varios archivos CONSUMOS_DATOS del
// operador, uno por cuenta) ya agregada por línea en el navegador. La ficha del lote con sus
// cruces vive en Redis; las líneas completas van a Blob para comparar con el lote siguiente y
// para responder preguntas.
const REDIS_KEY = 'internal:sim-consumos';
const BLOB_PREFIX = 'sim-consumos/';
const MAX_LINES = 40000;
// Subida por bloques: el navegador manda las líneas en tandas chicas a una llave temporal y al
// final pide armar el lote. Un solo POST de más de 1 MB se cortaba a mitad de camino en
// conexiones de oficina y el navegador solo veía "Failed to fetch".
const STAGING_PREFIX = 'internal:sim-consumos-staging:';
const STAGING_TTL_SECONDS = 3600;
const MAX_CHUNKS = 60;
// Idempotencia del "armar lote": si el navegador reintenta porque no vio la respuesta, se le
// devuelve el lote ya creado en vez de crear otro; si el primer intento sigue trabajando, 202.
const COMMIT_LOCK_PREFIX = 'internal:sim-consumos-commit:';
const COMMIT_DONE_PREFIX = 'internal:sim-consumos-done:';
const MAX_QA = 20;
// Cada informe y cada pregunta son una llamada a Anthropic: topes diarios por usuario para que
// un botón atascado o una sesión robada no generen costo sin límite.
const ANALYZE_PER_DAY = 10;
const ASK_PER_DAY = 40;
// Un bloque de 5.000 líneas pesa menos de 1 MB; más que eso no viene del navegador propio.
const MAX_CHUNK_BODY = 1_500_000;

export interface SimLote {
  id: string;
  label: string;
  // Periodo declarado al subir (el que cubre el reporte del operador).
  periodStart: string;
  periodEnd: string;
  // Primera y última fecha que de verdad traen datos los archivos.
  dataStart: string;
  dataEnd: string;
  uploadedAt: string;
  uploadedByName: string;
  files: string[];
  accounts: string[];
  planMb: number;
  // Máximo tolerado por SIM (MB al mes); por encima la línea es crítica.
  limitMb?: number;
  blobPath: string;
  stats: SimStats;
  analysis: { text: string; at: string } | null;
  // Marca de informe en curso: el informe se redacta después de responder (waitUntil) y la
  // pantalla consulta el lote hasta que aparezca.
  analysisStartedAt?: string | null;
  analysisError?: string | null;
  qa: { q: string; a: string; at: string }[];
}

const ANALYSIS_PENDING_MS = 5 * 60_000;

function analysisPending(l: SimLote): boolean {
  return !l.analysis && !!l.analysisStartedAt && Date.now() - Date.parse(l.analysisStartedAt) < ANALYSIS_PENDING_MS;
}

// Un informe que se quedó "en curso" más allá del plazo es una invocación que murió a mitad
// (no es lo mismo que "nunca se pidió"): se deja dicho para que la pantalla lo muestre y
// permita volver a generar.
function markInterruptedAnalysis(l: SimLote): SimLote {
  if (!l.analysis && l.analysisStartedAt && !analysisPending(l) && !l.analysisError) {
    return { ...l, analysisError: 'El informe se interrumpió antes de terminar; vuelve a generarlo.' };
  }
  return l;
}

// Fecha AAAA-MM-DD real (no basta el formato: "2026-02-31" pasa la expresión regular).
function isValidDay(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
}

async function readLote(redis: any, id: string): Promise<SimLote | null> {
  const raw = await redis.hget(REDIS_KEY, id);
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : (raw as SimLote);
  } catch {
    return null;
  }
}

// Redacta el informe fuera de la petición: subir, guardar en Blob, calcular y además esperar a
// Anthropic en una sola llamada superaba el tiempo de la función y el navegador veía
// "Failed to fetch". Al terminar se relee el lote para no pisar preguntas hechas mientras tanto.
async function analyzeInBackground(redis: any, lote: SimLote): Promise<void> {
  lote.analysisStartedAt = new Date().toISOString();
  lote.analysisError = null;
  await saveLote(redis, lote);
  let text: string | null = null;
  let error = '';
  try {
    text = await analyzeSimLote(redis, lote);
    if (!text) {
      const motivo = getLastAnthropicFailure();
      error = 'GPSITO no respondió' + (motivo ? ' (' + motivo + ')' : '');
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const fresh = (await readLote(redis, lote.id)) || lote;
  fresh.analysisStartedAt = null;
  if (text) fresh.analysis = { text, at: new Date().toISOString() };
  else fresh.analysisError = error || 'sin respuesta';
  await saveLote(redis, fresh);
}

async function requireAccess(cookies: any): Promise<Session | null> {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessSimConsumos(session)) return null;
  return session;
}

async function readLotes(redis: any): Promise<SimLote[]> {
  return parseJsonValues<SimLote>(await readHashValues(redis, REDIS_KEY)).sort((a, b) => b.periodEnd.localeCompare(a.periodEnd) || b.uploadedAt.localeCompare(a.uploadedAt));
}

async function saveLote(redis: any, lote: SimLote): Promise<void> {
  await redis.hset(REDIS_KEY, { [lote.id]: JSON.stringify(lote) });
}

async function readLines(token: string, blobPath: string): Promise<SimLine[]> {
  const result = await get(blobPath, { access: 'private', token, abortSignal: blobTimeout(60_000) });
  if (!result || result.statusCode !== 200 || !result.stream) return [];
  try {
    const parsed = JSON.parse(await new Response(result.stream).text());
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Números de SIM que están en inventario físico (tabla de SIM y campo SIM de los equipos).
async function inventorySimNumbers(redis: any): Promise<Set<string>> {
  const set = new Set<string>();
  try {
    for (const item of await readInventory(redis)) {
      for (const raw of [item.numeroSim, item.sim, item.serial]) {
        const n = normalizeSimNumber(raw);
        if (n.length >= 7) set.add(n);
      }
    }
  } catch {
    // sin inventario el cruce simplemente queda vacío
  }
  return set;
}

// El navegador manda los días como arreglo alineado a `days` (más compacto); aquí se expande
// al mapa fecha → KB con el que trabajan los cálculos.
function sanitizeLines(raw: unknown, daysRaw: unknown): SimLine[] | string {
  if (!Array.isArray(raw)) return 'faltan las líneas agregadas';
  if (raw.length > MAX_LINES) return `demasiadas líneas (${raw.length}); el tope es ${MAX_LINES}`;
  const days = Array.isArray(daysRaw) ? daysRaw.map((d) => String(d)).filter((d) => /^\d{8}$/.test(d)) : [];
  const out: SimLine[] = [];
  for (const r of raw as any[]) {
    const n = String(r?.n ?? '').replace(/\D/g, '').slice(0, 20);
    if (!n) continue;
    const d: Record<string, number> = {};
    if (Array.isArray(r?.d)) {
      days.forEach((day, idx) => {
        const v = Math.max(0, Number(r.d[idx]) || 0);
        if (v > 0 || idx < r.d.length) d[day] = v;
      });
    } else {
      for (const [k, v] of Object.entries(r?.d || {})) {
        if (/^\d{8}$/.test(k)) d[k] = Math.max(0, Number(v) || 0);
      }
    }
    out.push({
      n,
      c: String(r?.c ?? '').slice(0, 30),
      i: Array.isArray(r?.i) ? r.i.map((x: unknown) => String(x).replace(/\D/g, '').slice(0, 20)).filter(Boolean).slice(0, 6) : [],
      kb: Math.max(0, Number(r?.kb) || 0),
      u: Math.max(0, Number(r?.u) || 0),
      b: Math.max(0, Number(r?.b) || 0),
      d,
    });
  }
  return out;
}

function lightLote(l: SimLote) {
  return {
    id: l.id,
    label: l.label,
    periodStart: l.periodStart,
    periodEnd: l.periodEnd,
    uploadedAt: l.uploadedAt,
    uploadedByName: l.uploadedByName,
    files: l.files,
    accounts: l.accounts,
    planMb: l.planMb,
    limitMb: l.limitMb || l.stats.limitMb || DEFAULT_LIMIT_MB,
    lineCount: l.stats.lineCount,
    criticalCount: l.stats.critical?.count || 0,
    totalMb: l.stats.totalMb,
    overCount: l.stats.over.count,
    zeroCount: l.stats.zero.count,
    hasAnalysis: !!l.analysis,
    analysisPending: analysisPending(l),
  };
}

const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

// Una fila por línea, ordenadas por consumo, con el mismo criterio de estado del informe. Excel
// en español: separador ";", coma decimal y BOM para las tildes.
function linesToCsv(lote: SimLote, lines: SimLine[]): string {
  // Misma base que las estadísticas del panel (días del periodo declarado), para que el CSV y la
  // pantalla den la misma proyección mensual.
  const dias = Math.max(1, Math.round((Date.parse(lote.periodEnd) - Date.parse(lote.periodStart)) / 86400000) + 1);
  const planMb = lote.planMb || DEFAULT_PLAN_MB;
  const limitMb = lote.limitMb || lote.stats.limitMb || DEFAULT_LIMIT_MB;
  const num = (v: number, d: number) => Number(v || 0).toFixed(d).replace('.', ',');
  const cell = (v: unknown) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const rows = lines
    .map((l) => {
      const mb = (l.kb || 0) / KB_PER_MB;
      const mesMb = (mb * 30) / dias;
      const diasUso = Object.values(l.d || {}).filter((kb) => kb > 0).length;
      const imeis = Array.isArray(l.i) ? l.i : [];
      let estado = 'Normal';
      if (mb <= 0) estado = 'Sin consumo';
      else if (mesMb > limitMb) estado = `Crítico (más de ${limitMb} MB/mes)`;
      else if (mesMb > planMb) estado = `Sobre el plan (${planMb} MB/mes)`;
      else if (imeis.length > 1) estado = 'Varios IMEI';
      return { l, mb, mesMb, diasUso, imeis, estado };
    })
    .sort((a, b) => b.mb - a.mb);
  const head = ['Línea', 'Cuenta', 'MB en el periodo', 'MB/mes proyectado', 'Días con consumo', 'Estado', 'IMEI', 'Subida MB', 'Bajada MB'];
  const meta = [
    [cell('Lote'), cell(lote.label)].join(';'),
    [cell('Periodo'), cell(`${lote.periodStart} a ${lote.periodEnd}`)].join(';'),
    [cell('Plan MB/mes'), planMb, cell('Máximo MB/mes'), limitMb].join(';'),
    '',
  ];
  const body = rows.map((r) => [cell(r.l.n), cell(r.l.c), num(r.mb, 2), num(r.mesMb, 1), r.diasUso, cell(r.estado), cell(r.imeis.join(' | ')), num((r.l.u || 0) / KB_PER_MB, 2), num((r.l.b || 0) / KB_PER_MB, 2)].join(';'));
  return '\ufeff' + [...meta, head.join(';'), ...body].join('\n') + '\n';
}

export const GET: APIRoute = async ({ cookies, url }) => {
  const session = await requireAccess(cookies);
  if (!session) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  const redis = getRedis();
  if (!redis) return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });

  const lotes = await readLotes(redis);
  const id = url.searchParams.get('id');
  if (id) {
    const found = lotes.find((l) => l.id === id);
    if (!found) return new Response(JSON.stringify({ error: 'lote no encontrado' }), { status: 404 });
    const lote = markInterruptedAnalysis(found);
    // CSV para Excel armado en el servidor: el JSON de líneas de un lote grande pasa de los 4,5 MB
    // que Vercel deja responder y el navegador lo veía como "Failed to fetch".
    if (url.searchParams.get('csv') === '1') {
      const token = import.meta.env.BLOB_READ_WRITE_TOKEN as string | undefined;
      if (!token) return new Response(JSON.stringify({ error: 'almacenamiento no configurado' }), { status: 503 });
      const lines = await readLines(token, lote.blobPath);
      const csv = linesToCsv(lote, lines);
      return new Response(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="consumo-sim_${lote.periodStart}_a_${lote.periodEnd}.csv"`,
          'Cache-Control': 'no-store',
        },
      });
    }
    return new Response(JSON.stringify({ lote, analysisPending: analysisPending(lote), blobUrl: '/api/blob-file?path=' + encodeURIComponent(lote.blobPath) }), { headers });
  }
  return new Response(JSON.stringify({ lotes: lotes.map(lightLote), defaultPlanMb: DEFAULT_PLAN_MB, defaultLimitMb: DEFAULT_LIMIT_MB, isAdmin: session.role === 'admin' }), { headers });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  // El cuerpo se lee ANTES de cualquier verificación: responder un 401 o 403 con un cuerpo
  // grande todavía en camino hace que el servidor cierre la conexión y el navegador no vea
  // la respuesta, solo "Failed to fetch".
  const rawBody = await request.text();
  if (!verifySameOrigin(request)) return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  const session = await requireAccess(cookies);
  if (!session) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  const redis = getRedis();
  if (!redis) return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  // El token de Blob solo hace falta al guardar el lote; los bloques se reciben sin él.
  const token = import.meta.env.BLOB_READ_WRITE_TOKEN as string | undefined;

  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }
  const action = String(body.action || '');
  const me = await findUserById(redis, session.userId);
  const byName = me?.name || session.username;
  // Las llaves temporales llevan el usuario: nadie puede completar o pisar la subida de otro
  // adivinando su uploadId.
  const stagingKeyFor = (uploadId: string) => `${STAGING_PREFIX}${session.userId}:${uploadId}`;
  const commitScope = (uploadId: string) => `${session.userId}:${uploadId}`;

  if (action === 'chunk') {
    if (rawBody.length > MAX_CHUNK_BODY) return new Response(JSON.stringify({ error: 'bloque demasiado grande' }), { status: 413 });
    const uploadId = String(body.uploadId || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
    const index = Number(body.index);
    if (!uploadId || !Number.isInteger(index) || index < 0 || index >= MAX_CHUNKS) {
      return new Response(JSON.stringify({ error: 'bloque inválido' }), { status: 400 });
    }
    if (!Array.isArray(body.lines) || body.lines.length > 5000) {
      return new Response(JSON.stringify({ error: 'bloque demasiado grande' }), { status: 400 });
    }
    const key = stagingKeyFor(uploadId);
    // Un bloque reintentado reemplaza al anterior con el mismo índice (hash por índice).
    await redis.hset(key, { [String(index)]: JSON.stringify(body.lines) });
    await redis.expire(key, STAGING_TTL_SECONDS);
    return new Response(JSON.stringify({ ok: true, index }), { headers });
  }

  if (action === 'upload' || action === 'commit') {
    let rawLines: unknown = body.lines;
    let stagingKey = '';
    let commitUploadId = '';
    // Cualquier salida sin lote guardado suelta el candado del commit: si se quedara puesto, el
    // usuario vería "en curso" cinco minutos al corregir el dato y reintentar.
    const bail = async (status: number, payload: unknown) => {
      if (commitUploadId) await redis.del(COMMIT_LOCK_PREFIX + commitUploadId).catch(() => {});
      return new Response(JSON.stringify(payload), { status });
    };
    if (action === 'commit') {
      const uploadId = String(body.uploadId || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
      const total = Number(body.total);
      if (!uploadId || !Number.isInteger(total) || total < 1 || total > MAX_CHUNKS) {
        return new Response(JSON.stringify({ error: 'subida inválida' }), { status: 400 });
      }
      const doneId = await redis.get(COMMIT_DONE_PREFIX + commitScope(uploadId));
      if (doneId) {
        const existing = await readLote(redis, String(doneId));
        if (existing) return new Response(JSON.stringify({ lote: existing, analysisPending: analysisPending(existing), existing: true }), { headers });
      }
      const locked = await redis.set(COMMIT_LOCK_PREFIX + commitScope(uploadId), '1', { nx: true, ex: 300 });
      if (!locked) return new Response(JSON.stringify({ inProgress: true }), { status: 202, headers });
      commitUploadId = commitScope(uploadId);
      const key = stagingKeyFor(uploadId);
      // Bloque por bloque (HGET), no el hash entero: 60 bloques de 5.000 líneas pasan los
      // 10 MB por petición de Upstash. Se corta en cuanto se supera el tope de líneas.
      const missing: number[] = [];
      const joined: unknown[] = [];
      for (let i = 0; i < total && joined.length <= MAX_LINES; i++) {
        const raw = await redis.hget(key, String(i));
        if (raw === undefined || raw === null) {
          missing.push(i);
          continue;
        }
        const part = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(part)) joined.push(...part);
      }
      if (missing.length) return bail(409, { error: `faltan bloques por subir (${missing.join(', ')})`, missing });
      // Los bloques se borran solo cuando el lote quedó guardado: si falla Blob o Redis, el
      // reintento de "armar lote" no obliga a volver a subir todo.
      stagingKey = key;
      rawLines = joined;
    }
    if (!token) return bail(503, { error: 'almacenamiento de archivos no configurado' });
    const lines = sanitizeLines(rawLines, body.days);
    if (typeof lines === 'string') return bail(400, { error: lines });
    if (!lines.length) return bail(400, { error: 'no se encontraron líneas en los archivos' });
    const dataPeriod = periodOf(lines);
    if (!dataPeriod.start) return bail(400, { error: 'los archivos no traen fechas válidas (columna FECHA)' });
    const periodStart = String(body.periodStart || '').slice(0, 10);
    const periodEnd = String(body.periodEnd || '').slice(0, 10);
    if (!isValidDay(periodStart) || !isValidDay(periodEnd) || periodStart > periodEnd) {
      return bail(400, { error: 'indica el periodo del reporte (desde y hasta) con fechas válidas' });
    }
    const period = { start: periodStart, end: periodEnd };
    const periodDays = Math.round((Date.parse(periodEnd) - Date.parse(periodStart)) / 86400000) + 1;
    if (periodDays < 1 || periodDays > 366) return bail(400, { error: 'el periodo no puede pasar de un año' });
    const planMb = Math.min(10000, Math.max(1, Number(body.planMb) || DEFAULT_PLAN_MB));
    const limitMb = Math.min(10000, Math.max(planMb, Number(body.limitMb) || DEFAULT_LIMIT_MB));
    const files = Array.isArray(body.files) ? body.files.map((f: unknown) => String(f).slice(0, 120)).slice(0, 40) : [];
    const rowCount = Math.max(0, Number(body.rowCount) || 0);
    const accounts = [...new Set(lines.map((l) => l.c).filter(Boolean))].sort();
    const label = String(body.label || '').trim().slice(0, 80) || `Consumos ${period.start} a ${period.end}`;

    let lote: SimLote;
    try {
      // Lote anterior: el más reciente cuyo periodo termina antes de que empiece este.
      const existing = await readLotes(redis);
      const previous = existing.find((l) => l.periodEnd < period.start) || null;
      const [previousLines, inventorySims] = await Promise.all([
        previous ? readLines(token, previous.blobPath).catch(() => []) : Promise.resolve([] as SimLine[]),
        inventorySimNumbers(redis),
      ]);

      const id = randomUUID();
      const blobPath = `${BLOB_PREFIX}${period.start}_a_${period.end}_${id}.json`;
      await put(blobPath, JSON.stringify(lines), { access: 'private', token, addRandomSuffix: false, contentType: 'application/json', abortSignal: AbortSignal.timeout(30_000) });

      const stats = computeSimStats(lines, rowCount, planMb, inventorySims, previousLines.length ? previousLines : null, previous ? `${previous.periodStart} a ${previous.periodEnd}` : '', periodDays, limitMb);
      lote = {
        id,
        label,
        periodStart: period.start,
        periodEnd: period.end,
        dataStart: dataPeriod.start,
        dataEnd: dataPeriod.end,
        uploadedAt: new Date().toISOString(),
        uploadedByName: byName,
        files,
        accounts,
        planMb,
        limitMb,
        blobPath,
        stats,
        analysis: null,
        qa: [],
      };
      lote.analysisStartedAt = new Date().toISOString();
      await saveLote(redis, lote);
      if (stagingKey) await redis.del(stagingKey).catch(() => {});
      if (commitUploadId) {
        await redis.set(COMMIT_DONE_PREFIX + commitUploadId, id, { ex: STAGING_TTL_SECONDS }).catch(() => {});
        await redis.del(COMMIT_LOCK_PREFIX + commitUploadId).catch(() => {});
      }
    } catch (err) {
      // Blob o Redis fallaron a mitad: se suelta el candado para que "armar lote" se pueda reintentar.
      return bail(502, { error: `no se pudo guardar el lote: ${err instanceof Error ? err.message : String(err)}` });
    }
    await logAudit(redis, session, 'sim_consumos_upload', label, `${lines.length} líneas, ${files.length} archivo(s)`);

    const work = analyzeInBackground(redis, lote).catch((err) => console.error('sim-consumos: fallo el analisis', err instanceof Error ? err.message : String(err)));
    const inline = runAfterResponse(work);
    if (inline) await inline;
    return new Response(JSON.stringify({ lote, analysisPending: true }), { headers });
  }

  if (!token) return new Response(JSON.stringify({ error: 'almacenamiento de archivos no configurado' }), { status: 503 });
  const id = String(body.id || '');
  const lotes = await readLotes(redis);
  const lote = lotes.find((l) => l.id === id);
  if (!lote) return new Response(JSON.stringify({ error: 'lote no encontrado' }), { status: 404 });

  if (action === 'analyze') {
    if (analysisPending(lote)) return new Response(JSON.stringify({ lote, analysisPending: true }), { headers });
    if (!(await checkAndIncrementRateLimit(redis, `internal:sim-consumos-rate:analyze:${session.userId}`, ANALYZE_PER_DAY, 86400))) {
      return new Response(JSON.stringify({ error: `ya se generaron ${ANALYZE_PER_DAY} informes hoy; vuelve a intentarlo mañana` }), { status: 429 });
    }
    lote.analysis = null;
    const work = analyzeInBackground(redis, lote).catch((err) => console.error('sim-consumos: fallo el analisis', err instanceof Error ? err.message : String(err)));
    const inline = runAfterResponse(work);
    if (inline) await inline;
    return new Response(JSON.stringify({ lote, analysisPending: true }), { headers });
  }

  if (action === 'ask') {
    const question = String(body.question || '').trim().slice(0, 600);
    if (!question) return new Response(JSON.stringify({ error: 'escribe la pregunta' }), { status: 400 });
    if (!(await checkAndIncrementRateLimit(redis, `internal:sim-consumos-rate:ask:${session.userId}`, ASK_PER_DAY, 86400))) {
      return new Response(JSON.stringify({ error: `ya se hicieron ${ASK_PER_DAY} preguntas hoy; vuelve a intentarlo mañana` }), { status: 429 });
    }
    const answer = await askSimLote(redis, lote, lote.qa, question);
    if (!answer) return new Response(JSON.stringify({ error: 'GPSITO no respondió; intenta de nuevo en un momento' }), { status: 502 });
    // Se relee antes de guardar: mientras GPSITO respondía pudo terminar el informe en segundo
    // plano, y guardar la copia vieja lo borraría.
    const fresh = (await readLote(redis, lote.id)) || lote;
    fresh.qa = [...(fresh.qa || []), { q: question, a: answer, at: new Date().toISOString() }].slice(-MAX_QA);
    await saveLote(redis, fresh);
    return new Response(JSON.stringify({ lote: fresh }), { headers });
  }

  if (action === 'plan') {
    const planMb = Math.min(10000, Math.max(1, Number(body.planMb) || DEFAULT_PLAN_MB));
    const limitMb = Math.min(10000, Math.max(planMb, Number(body.limitMb) || lote.limitMb || DEFAULT_LIMIT_MB));
    const lines = await readLines(token, lote.blobPath);
    const previous = lotes.find((l) => l.periodEnd < lote.periodStart) || null;
    const [previousLines, inventorySims] = await Promise.all([
      previous ? readLines(token, previous.blobPath).catch(() => []) : Promise.resolve([] as SimLine[]),
      inventorySimNumbers(redis),
    ]);
    const periodDays = Math.round((Date.parse(lote.periodEnd) - Date.parse(lote.periodStart)) / 86400000) + 1;
    const stats = computeSimStats(lines, lote.stats.rowCount, planMb, inventorySims, previousLines.length ? previousLines : null, previous ? `${previous.periodStart} a ${previous.periodEnd}` : '', periodDays, limitMb);
    // Misma razón que en "ask": no pisar las preguntas hechas mientras se leían las líneas.
    const fresh = (await readLote(redis, lote.id)) || lote;
    fresh.planMb = planMb;
    fresh.limitMb = limitMb;
    fresh.stats = stats;
    fresh.analysis = null;
    fresh.analysisStartedAt = null;
    fresh.analysisError = null;
    await saveLote(redis, fresh);
    return new Response(JSON.stringify({ lote: fresh }), { headers });
  }

  return new Response(JSON.stringify({ error: 'acción inválida' }), { status: 400 });
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  const session = await requireAccess(cookies);
  if (!session) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  const redis = getRedis();
  if (!redis) return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  let body: { id?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }
  const lote = (await readLotes(redis)).find((l) => l.id === String(body.id || ''));
  if (!lote) return new Response(JSON.stringify({ error: 'lote no encontrado' }), { status: 404 });
  await redis.hdel(REDIS_KEY, lote.id);
  const token = import.meta.env.BLOB_READ_WRITE_TOKEN as string | undefined;
  if (token) await del(lote.blobPath, { token, abortSignal: blobTimeout(20_000) }).catch(() => {});
  await logAudit(redis, session, 'sim_consumos_delete', lote.label);
  return new Response(JSON.stringify({ ok: true }), { headers });
};
