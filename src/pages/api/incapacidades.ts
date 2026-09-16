import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, canManageRRHH, verifySameOrigin } from '../../lib/auth';

export const prerender = false;

const REDIS_KEY = 'internal:incapacidades';

interface Incapacidad {
  id: string;
  employeeId: string;
  employeeName: string;
  startDate: string;
  endDate: string;
  note: string;
  createdAt: string;
}

async function requireRRHH(cookies: any) {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canManageRRHH(session.role)) return null;
  return session;
}

async function readEntries(redis: any): Promise<Incapacidad[]> {
  const raw = (await redis.hgetall<Record<string, string>>(REDIS_KEY)) || {};
  return Object.values(raw)
    .map((v) => {
      try {
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    })
    .filter((e): e is Incapacidad => e !== null)
    .sort((a, b) => b.startDate.localeCompare(a.startDate));
}

export const GET: APIRoute = async ({ cookies, url }) => {
  const session = await requireRRHH(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }
  let entries = await readEntries(redis);
  const employeeId = url.searchParams.get('employeeId');
  if (employeeId) entries = entries.filter((e) => e.employeeId === employeeId);

  return new Response(JSON.stringify({ entries }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requireRRHH(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const body = await request.json().catch(() => null);
  const employeeId = String(body?.employeeId || '').trim();
  const employeeName = String(body?.employeeName || '').trim();
  const startDate = String(body?.startDate || '').trim();
  const endDate = String(body?.endDate || '').trim();
  if (!employeeId || !employeeName || !startDate || !endDate) {
    return new Response(JSON.stringify({ error: 'faltan campos obligatorios' }), { status: 400 });
  }

  const entry: Incapacidad = {
    id: randomUUID(),
    employeeId,
    employeeName,
    startDate,
    endDate,
    note: String(body?.note || '').trim(),
    createdAt: new Date().toISOString(),
  };

  await redis.hset(REDIS_KEY, { [entry.id]: JSON.stringify(entry) });
  await logAudit(redis, session, 'incapacidad_create', employeeName, `${startDate} – ${endDate}`);

  return new Response(JSON.stringify({ entry }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requireRRHH(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }
  const body = await request.json().catch(() => null);
  await redis.hdel(REDIS_KEY, String(body?.id || ''));
  await logAudit(redis, session, 'incapacidad_delete', String(body?.id || ''));
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
