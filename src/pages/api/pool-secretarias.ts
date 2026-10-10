import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { SESSION_COOKIE, getSession, canAccessSection, getUsers, branchesOf, BRANCHES, type User } from '../../lib/auth';
import { todayInColombia, dateInColombia, addDaysToDateString } from '../../lib/colombia-time';
import type { AuditEntry } from '../../lib/audit';

export const prerender = false;

// Pool de secretarias: cuánto trabajo real registra cada secretaria y gerente, por día, a partir
// de la auditoría (cada acción del panel deja un rastro con usuario y hora). Pedido por Gabriel
// el 2026-10-10 para contrastar "estoy repasando el CRM" con lo que de verdad quedó registrado.
const AUDIT_KEY = 'internal:audit';
const DAY_CACHE_PREFIX = 'internal:pool-secretarias:dia:';
const DAY_CACHE_TTL = 100 * 86400;
const CHUNK = 2000;
const MAX_SCAN = 120_000;

export const METRICS: { key: string; label: string; group: string }[] = [
  { key: 'crm_leads', label: 'Leads nuevos', group: 'CRM' },
  { key: 'crm_gestiones', label: 'Gestiones (notas)', group: 'CRM' },
  { key: 'crm_agendados', label: 'Agendados', group: 'CRM' },
  { key: 'crm_instalados', label: 'Instalados', group: 'CRM' },
  { key: 'crm_estado', label: 'Cambios de estado', group: 'CRM' },
  { key: 'cobros_gestiones', label: 'Contactados', group: 'Cobranza' },
  { key: 'cobros_recordatorios', label: 'Recordatorios WhatsApp', group: 'Cobranza' },
  { key: 'suspensiones', label: 'Suspensiones', group: 'Otros' },
  { key: 'solicitudes', label: 'Solicitudes adm.', group: 'Otros' },
  { key: 'tareas', label: 'Tareas', group: 'Otros' },
  { key: 'cotizaciones', label: 'Cotizaciones', group: 'Otros' },
  { key: 'comprobantes', label: 'Comprobantes de pago', group: 'Otros' },
  { key: 'reportes', label: 'Reportes', group: 'Otros' },
];

// Qué cuenta como trabajo: una acción de auditoría puede sumar en más de una métrica (una
// edición del lead que agrega nota y lo agenda a la vez cuenta en las dos).
function metricsFor(e: AuditEntry): string[] {
  const meta = String(e.meta || '');
  switch (e.action) {
    case 'lead_create':
      return ['crm_leads'];
    case 'lead_update': {
      const keys = meta.split(',').map((k) => k.trim());
      const out: string[] = [];
      if (keys.includes('addNote')) out.push('crm_gestiones');
      if (keys.includes('scheduledInstallDate')) out.push('crm_agendados');
      if (keys.includes('installed')) out.push('crm_instalados');
      if (keys.includes('status')) out.push('crm_estado');
      return out;
    }
    case 'cobro_contactado':
      return ['cobros_gestiones'];
    case 'cobro_whatsapp_reminder':
    case 'cobros_whatsapp_reminder_bulk':
      return ['cobros_recordatorios'];
    case 'suspension_create':
    case 'suspension_update':
      return ['suspensiones'];
    case 'solicitud_administrativa_create':
    case 'solicitud_administrativa_update':
      return ['solicitudes'];
    case 'task_create':
    case 'task_update':
      return ['tareas'];
    case 'quote_generate':
      return ['cotizaciones'];
    case 'pago_comprobante_subido':
      return ['comprobantes'];
    case 'report_create':
      return ['reportes'];
    default:
      return [];
  }
}

type DayCounts = Record<string, { counts: Record<string, number>; last: string }>; // por userId
const startOfColombiaDay = (date: string) => `${date}T05:00:00.000Z`;

async function readCachedDay(redis: any, date: string): Promise<DayCounts | null> {
  const raw = await redis.get(DAY_CACHE_PREFIX + date).catch(() => null);
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : (raw as DayCounts);
  } catch {
    return null;
  }
}

// Recorre la auditoría desde lo más nuevo hasta el inicio del día más viejo que haga falta y
// agrupa por día y usuario. Los días ya cerrados se guardan en caché para no volver a leerlos.
async function aggregateDays(redis: any, dates: string[], today: string): Promise<Record<string, DayCounts>> {
  const result: Record<string, DayCounts> = {};
  const missing: string[] = [];
  for (const d of dates) {
    const cached = d < today ? await readCachedDay(redis, d) : null;
    if (cached) result[d] = cached;
    else missing.push(d);
  }
  if (!missing.length) return result;
  for (const d of missing) result[d] = {};
  const oldestStart = startOfColombiaDay(missing.reduce((a, b) => (a < b ? a : b)));
  const wanted = new Set(missing);
  let offset = 0;
  let done = false;
  while (!done && offset < MAX_SCAN) {
    const raw: unknown[] = (await redis.lrange(AUDIT_KEY, offset, offset + CHUNK - 1)) || [];
    if (!raw.length) break;
    for (const r of raw) {
      let e: AuditEntry | null = null;
      try {
        e = typeof r === 'string' ? JSON.parse(r) : (r as AuditEntry);
      } catch {
        continue;
      }
      if (!e || typeof e.at !== 'string') continue;
      if (e.at < oldestStart) {
        done = true;
        break;
      }
      const day = dateInColombia(e.at);
      if (!wanted.has(day) || !e.userId) continue;
      const bucket = result[day];
      const u = bucket[e.userId] || (bucket[e.userId] = { counts: {}, last: '' });
      if (e.at > u.last) u.last = e.at;
      for (const m of metricsFor(e)) u.counts[m] = (u.counts[m] || 0) + 1;
    }
    offset += CHUNK;
    if (raw.length < CHUNK) break;
  }
  for (const d of missing) {
    if (d < today) await redis.set(DAY_CACHE_PREFIX + d, JSON.stringify(result[d]), { ex: DAY_CACHE_TTL }).catch(() => {});
  }
  return result;
}

export const GET: APIRoute = async ({ cookies, url }) => {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessSection(session.role, 'pool-secretarias')) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });

  const today = todayInColombia();
  const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
  let from = url.searchParams.get('from') || today;
  let to = url.searchParams.get('to') || today;
  if (!isDate(from)) from = today;
  if (!isDate(to) || to > today) to = today;
  if (from > to) from = to;
  // Tope de 62 días por consulta: suficiente para "este mes" y un rango a mano razonable.
  if (addDaysToDateString(from, 62) < to) from = addDaysToDateString(to, -62);
  const branch = url.searchParams.get('branch') || '';
  const scope = url.searchParams.get('scope') === 'todos' ? 'todos' : 'secretarias';

  const dates: string[] = [];
  for (let d = from; d <= to; d = addDaysToDateString(d, 1)) dates.push(d);

  const users = (await getUsers(redis)).filter((u) => u.active && u.role !== 'admin' || (scope === 'todos' && u.active));
  const people = users.filter((u: User) => {
    if (scope === 'secretarias' && u.role !== 'secretaria' && u.role !== 'gerente') return false;
    if (branch && !branchesOf(u).includes(branch)) return false;
    return true;
  });

  const byDay = await aggregateDays(redis, dates, today);

  const rows = people.map((u) => {
    const totals: Record<string, number> = {};
    const perDay: Record<string, Record<string, number>> = {};
    let lastAt = '';
    for (const d of dates) {
      const entry = byDay[d]?.[u.id];
      if (!entry) continue;
      perDay[d] = entry.counts;
      for (const [k, v] of Object.entries(entry.counts)) totals[k] = (totals[k] || 0) + v;
      if (entry.last > lastAt) lastAt = entry.last;
    }
    const total = Object.values(totals).reduce((a, b) => a + b, 0);
    return { id: u.id, name: u.name, username: u.username, role: u.role, branches: branchesOf(u), totals, total, lastAt: lastAt || null, perDay };
  });
  rows.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  return new Response(
    JSON.stringify({ from, to, today, dates, metrics: METRICS, rows, branches: BRANCHES.filter((b) => b !== 'Central de Monitoreo'), generatedAt: new Date().toISOString() }),
    { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
  );
};
