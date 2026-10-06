import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { put, del, get } from '@vercel/blob';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, canAccessSimConsumos, findUserById, verifySameOrigin, type Session } from '../../lib/auth';
import { readHashValues, parseJsonValues } from '../../lib/redis-hash';
import { computeSimStats, periodOf, normalizeSimNumber, type SimLine, type SimStats } from '../../lib/sim-consumos';
import { analyzeSimLote, askSimLote } from '../../lib/sim-consumos-agent';
import { readInventory } from './inventario';

export const prerender = false;

// Lotes de consumo de SIM: cada lote es una carga (uno o varios archivos CONSUMOS_DATOS del
// operador, uno por cuenta) ya agregada por línea en el navegador. La ficha del lote con sus
// cruces vive en Redis; las líneas completas van a Blob para comparar con el lote siguiente y
// para responder preguntas.
const REDIS_KEY = 'internal:sim-consumos';
const BLOB_PREFIX = 'sim-consumos/';
const MAX_LINES = 40000;
const MAX_QA = 20;
const DEFAULT_PLAN_MB = 20;

export interface SimLote {
  id: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  uploadedAt: string;
  uploadedByName: string;
  files: string[];
  accounts: string[];
  planMb: number;
  blobPath: string;
  stats: SimStats;
  analysis: { text: string; at: string } | null;
  qa: { q: string; a: string; at: string }[];
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
  const result = await get(blobPath, { access: 'private', token });
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
    lineCount: l.stats.lineCount,
    totalMb: l.stats.totalMb,
    overCount: l.stats.over.count,
    zeroCount: l.stats.zero.count,
    hasAnalysis: !!l.analysis,
  };
}

const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

export const GET: APIRoute = async ({ cookies, url }) => {
  const session = await requireAccess(cookies);
  if (!session) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  const redis = getRedis();
  if (!redis) return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });

  const lotes = await readLotes(redis);
  const id = url.searchParams.get('id');
  if (id) {
    const lote = lotes.find((l) => l.id === id);
    if (!lote) return new Response(JSON.stringify({ error: 'lote no encontrado' }), { status: 404 });
    return new Response(JSON.stringify({ lote, blobUrl: '/api/blob-file?path=' + encodeURIComponent(lote.blobPath) }), { headers });
  }
  return new Response(JSON.stringify({ lotes: lotes.map(lightLote), defaultPlanMb: DEFAULT_PLAN_MB, isAdmin: session.role === 'admin' }), { headers });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  const session = await requireAccess(cookies);
  if (!session) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  const redis = getRedis();
  if (!redis) return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  const token = import.meta.env.BLOB_READ_WRITE_TOKEN as string | undefined;
  if (!token) return new Response(JSON.stringify({ error: 'almacenamiento de archivos no configurado' }), { status: 503 });

  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }
  const action = String(body.action || '');
  const me = await findUserById(redis, session.userId);
  const byName = me?.name || session.username;

  if (action === 'upload') {
    const lines = sanitizeLines(body.lines, body.days);
    if (typeof lines === 'string') return new Response(JSON.stringify({ error: lines }), { status: 400 });
    if (!lines.length) return new Response(JSON.stringify({ error: 'no se encontraron líneas en los archivos' }), { status: 400 });
    const period = periodOf(lines);
    if (!period.start) return new Response(JSON.stringify({ error: 'los archivos no traen fechas válidas (columna FECHA)' }), { status: 400 });
    const planMb = Math.min(10000, Math.max(1, Number(body.planMb) || DEFAULT_PLAN_MB));
    const files = Array.isArray(body.files) ? body.files.map((f: unknown) => String(f).slice(0, 120)).slice(0, 40) : [];
    const rowCount = Math.max(0, Number(body.rowCount) || 0);
    const accounts = [...new Set(lines.map((l) => l.c).filter(Boolean))].sort();
    const label = String(body.label || '').trim().slice(0, 80) || `Consumos ${period.start} a ${period.end}`;

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

    const stats = computeSimStats(lines, rowCount, planMb, inventorySims, previousLines.length ? previousLines : null, previous ? `${previous.periodStart} a ${previous.periodEnd}` : '');
    const lote: SimLote = {
      id,
      label,
      periodStart: period.start,
      periodEnd: period.end,
      uploadedAt: new Date().toISOString(),
      uploadedByName: byName,
      files,
      accounts,
      planMb,
      blobPath,
      stats,
      analysis: null,
      qa: [],
    };
    await saveLote(redis, lote);
    await logAudit(redis, session, 'sim_consumos_upload', label, `${lines.length} líneas, ${files.length} archivo(s)`);

    // El informe de GPSITO se intenta de una vez; si Anthropic no responde, la ficha queda
    // guardada y la pantalla ofrece "Generar informe" para reintentar.
    try {
      const text = await analyzeSimLote(redis, lote);
      if (text) {
        lote.analysis = { text, at: new Date().toISOString() };
        await saveLote(redis, lote);
      }
    } catch (err) {
      console.error('sim-consumos: fallo el analisis', err instanceof Error ? err.message : String(err));
    }
    return new Response(JSON.stringify({ lote }), { headers });
  }

  const id = String(body.id || '');
  const lotes = await readLotes(redis);
  const lote = lotes.find((l) => l.id === id);
  if (!lote) return new Response(JSON.stringify({ error: 'lote no encontrado' }), { status: 404 });

  if (action === 'analyze') {
    const text = await analyzeSimLote(redis, lote);
    if (!text) return new Response(JSON.stringify({ error: 'GPSITO no respondió; intenta de nuevo en un momento' }), { status: 502 });
    lote.analysis = { text, at: new Date().toISOString() };
    await saveLote(redis, lote);
    return new Response(JSON.stringify({ lote }), { headers });
  }

  if (action === 'ask') {
    const question = String(body.question || '').trim().slice(0, 600);
    if (!question) return new Response(JSON.stringify({ error: 'escribe la pregunta' }), { status: 400 });
    const answer = await askSimLote(redis, lote, lote.qa, question);
    if (!answer) return new Response(JSON.stringify({ error: 'GPSITO no respondió; intenta de nuevo en un momento' }), { status: 502 });
    lote.qa = [...lote.qa, { q: question, a: answer, at: new Date().toISOString() }].slice(-MAX_QA);
    await saveLote(redis, lote);
    return new Response(JSON.stringify({ lote }), { headers });
  }

  if (action === 'plan') {
    const planMb = Math.min(10000, Math.max(1, Number(body.planMb) || DEFAULT_PLAN_MB));
    const lines = await readLines(token, lote.blobPath);
    const previous = lotes.find((l) => l.periodEnd < lote.periodStart) || null;
    const [previousLines, inventorySims] = await Promise.all([
      previous ? readLines(token, previous.blobPath).catch(() => []) : Promise.resolve([] as SimLine[]),
      inventorySimNumbers(redis),
    ]);
    lote.planMb = planMb;
    lote.stats = computeSimStats(lines, lote.stats.rowCount, planMb, inventorySims, previousLines.length ? previousLines : null, previous ? `${previous.periodStart} a ${previous.periodEnd}` : '');
    lote.analysis = null;
    await saveLote(redis, lote);
    return new Response(JSON.stringify({ lote }), { headers });
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
  if (token) await del(lote.blobPath, { token }).catch(() => {});
  await logAudit(redis, session, 'sim_consumos_delete', lote.label);
  return new Response(JSON.stringify({ ok: true }), { headers });
};
