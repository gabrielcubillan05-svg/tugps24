import type { APIRoute } from 'astro';
import { todayInColombia, dateInColombia, addDaysToDateString, daysBetweenDateStrings } from '../../lib/colombia-time';
import { randomUUID } from 'node:crypto';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, canAccessSection, verifySameOrigin } from '../../lib/auth';

export const prerender = false;

async function requireReportes(cookies: any) {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessSection(session.role, 'reportes')) return null;
  return session;
}

const REDIS_KEY = 'internal:scheduled-reports';
const FREQUENCIES: Record<string, number> = {
  Diario: 1,
  Semanal: 7,
  Quincenal: 15,
  Mensual: 30,
};

export interface ScheduledReport {
  id: string;
  client: string;
  reportType: string;
  frequency: string;
  operator: string;
  lastDoneAt: string | null;
  dueDateOverride: string | null;
  createdAt: string;
  // Pausa temporal (cliente suspendido/cortado): mientras esté pausado no vence ni genera
  // avisos; al reanudar el ciclo cuenta desde resumedAt para no aparecer vencido por el
  // tiempo que estuvo pausado.
  paused?: boolean;
  pausedReason?: string;
  resumedAt?: string | null;
}

const SOON_WINDOW_DAYS = 2; // "por realizar": vence en los próximos 2 días

// Fecha (YYYY-MM-DD, Colombia) en la que vuelve a vencer el reporte. Se calcula con días
// calendario de Colombia: antes se truncaba con la medianoche del servidor (UTC), y un Diario
// hecho a las 6 pm volvía a aparecer vencido a las 7 pm.
export function nextDueDateFor(r: Pick<ScheduledReport, 'dueDateOverride' | 'frequency' | 'lastDoneAt' | 'resumedAt' | 'createdAt'>): string {
  if (r.dueDateOverride) return r.dueDateOverride.slice(0, 10);
  const intervalDays = FREQUENCIES[r.frequency] || 7;
  const baseIso = [r.lastDoneAt, r.resumedAt].filter((d): d is string => !!d).sort().pop() || r.createdAt;
  return addDaysToDateString(dateInColombia(baseIso), intervalDays);
}

export function withStatus(r: ScheduledReport) {
  if (r.paused) {
    return { ...r, nextDue: r.createdAt, pending: false, bucket: 'pausado' as const };
  }
  const nextDueDate = nextDueDateFor(r);
  const today = todayInColombia();
  const pending = nextDueDate <= today;
  const daysUntil = daysBetweenDateStrings(today, nextDueDate);
  const bucket: 'pendiente' | 'por-realizar' | 'al-dia' = pending ? 'pendiente' : daysUntil <= SOON_WINDOW_DAYS ? 'por-realizar' : 'al-dia';
  // Medianoche de Colombia en ISO, para que las pantallas que formatean la fecha la muestren bien.
  return { ...r, nextDue: `${nextDueDate}T05:00:00.000Z`, pending, bucket };
}

export async function readScheduledReports(redis: any) {
  const raw = (await redis.hgetall<Record<string, string>>(REDIS_KEY)) || {};
  return Object.values(raw)
    .map((v) => {
      try {
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    })
    .filter((r): r is ScheduledReport => r !== null)
    .map(withStatus)
    .sort((a, b) => {
      const order = { pendiente: 0, 'por-realizar': 1, 'al-dia': 2, pausado: 3 };
      return order[a.bucket] - order[b.bucket];
    });
}

export const GET: APIRoute = async ({ cookies }) => {
  if (!(await requireReportes(cookies))) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const reports = await readScheduledReports(redis);

  return new Response(JSON.stringify({ reports, frequencies: Object.keys(FREQUENCIES) }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requireReportes(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: Partial<ScheduledReport>;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const client = String(body.client || '').trim();
  const reportType = String(body.reportType || '').trim();
  const frequency = String(body.frequency || '').trim();
  const operator = String(body.operator || '').trim();

  if (!client || !reportType || !frequency || !operator || !FREQUENCIES[frequency]) {
    return new Response(JSON.stringify({ error: 'missing or invalid fields' }), { status: 400 });
  }

  const report: ScheduledReport = {
    id: randomUUID(),
    client,
    reportType,
    frequency,
    operator,
    lastDoneAt: null,
    dueDateOverride: (body as any).dueDate ? String((body as any).dueDate) : null,
    createdAt: new Date().toISOString(),
  };

  await redis.hset(REDIS_KEY, { [report.id]: JSON.stringify(report) });
  await logAudit(redis, session, 'scheduled_report_create', `${report.client} · ${report.reportType}`, report.frequency);

  return new Response(JSON.stringify({ report: withStatus(report) }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const PATCH: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requireReportes(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: { id?: string; dueDate?: string | null; paused?: boolean; reason?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const id = String(body.id || '');
  const raw = await redis.hget<string>(REDIS_KEY, id);
  if (!raw) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }
  const existing: ScheduledReport = { dueDateOverride: null, ...(typeof raw === 'string' ? JSON.parse(raw) : raw) };

  if (body.paused !== undefined) {
    if (body.paused) {
      existing.paused = true;
      existing.pausedReason = String(body.reason || '').trim().slice(0, 200);
      await redis.hset(REDIS_KEY, { [id]: JSON.stringify(existing) });
      await logAudit(redis, session, 'scheduled_report_pause', `${existing.client} · ${existing.reportType}`, existing.pausedReason);
    } else {
      existing.paused = false;
      existing.pausedReason = '';
      existing.resumedAt = new Date().toISOString();
      existing.dueDateOverride = null;
      await redis.hset(REDIS_KEY, { [id]: JSON.stringify(existing) });
      await logAudit(redis, session, 'scheduled_report_resume', `${existing.client} · ${existing.reportType}`);
    }
  } else if (body.dueDate !== undefined) {
    if (body.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.dueDate))) {
      return new Response(JSON.stringify({ error: 'fecha inválida' }), { status: 400 });
    }
    existing.dueDateOverride = body.dueDate || null;
    await redis.hset(REDIS_KEY, { [id]: JSON.stringify(existing) });
    await logAudit(redis, session, 'scheduled_report_due_date_set', `${existing.client} · ${existing.reportType}`, String(body.dueDate));
  } else {
    existing.lastDoneAt = new Date().toISOString();
    existing.dueDateOverride = null;
    await redis.hset(REDIS_KEY, { [id]: JSON.stringify(existing) });
    await logAudit(redis, session, 'scheduled_report_done', `${existing.client} · ${existing.reportType}`);
  }

  return new Response(JSON.stringify({ report: withStatus(existing) }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requireReportes(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: { id?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  await redis.hdel(REDIS_KEY, String(body.id || ''));
  await logAudit(redis, session, 'scheduled_report_delete', String(body.id || ''));
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
