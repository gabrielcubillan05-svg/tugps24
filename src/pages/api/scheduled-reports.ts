import type { APIRoute } from 'astro';
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

interface ScheduledReport {
  id: string;
  client: string;
  reportType: string;
  frequency: string;
  operator: string;
  lastDoneAt: string | null;
  createdAt: string;
}

function withStatus(r: ScheduledReport) {
  const intervalDays = FREQUENCIES[r.frequency] || 7;
  const base = new Date(r.lastDoneAt || r.createdAt);
  const nextDue = new Date(base.getTime() + intervalDays * 24 * 60 * 60 * 1000);
  const pending = nextDue.getTime() <= Date.now();
  return { ...r, nextDue: nextDue.toISOString(), pending };
}

export const GET: APIRoute = async ({ cookies }) => {
  if (!(await requireReportes(cookies))) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const raw = (await redis.hgetall<Record<string, string>>(REDIS_KEY)) || {};
  const reports = Object.values(raw)
    .map((v) => {
      try {
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    })
    .filter((r): r is ScheduledReport => r !== null)
    .map(withStatus)
    .sort((a, b) => (a.pending === b.pending ? 0 : a.pending ? -1 : 1));

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

  let body: { id?: string };
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
  const existing: ScheduledReport = typeof raw === 'string' ? JSON.parse(raw) : (raw as any);
  existing.lastDoneAt = new Date().toISOString();
  await redis.hset(REDIS_KEY, { [id]: JSON.stringify(existing) });
  await logAudit(redis, session, 'scheduled_report_done', `${existing.client} · ${existing.reportType}`);

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
