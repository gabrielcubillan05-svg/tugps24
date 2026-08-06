import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, canManageCompDays, verifySameOrigin } from '../../lib/auth';

export const prerender = false;

const REDIS_KEY = 'internal:comp-days';

interface CompDay {
  id: string;
  operator: string;
  days: number;
  note: string;
  scheduledDate: string | null;
  createdAt: string;
}

async function requireCompDays(cookies: any) {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canManageCompDays(session.role)) return null;
  return session;
}

export const GET: APIRoute = async ({ cookies }) => {
  if (!(await requireCompDays(cookies))) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const raw = (await redis.hgetall<Record<string, string>>(REDIS_KEY)) || {};
  const entries = Object.values(raw)
    .map((v) => {
      try {
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    })
    .filter((e): e is CompDay => e !== null)
    .map((e) => ({ scheduledDate: null, ...e }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const totals: Record<string, number> = {};
  entries.forEach((e) => {
    totals[e.operator] = (totals[e.operator] || 0) + e.days;
  });

  return new Response(JSON.stringify({ entries, totals }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requireCompDays(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: { operator?: string; days?: number; note?: string; scheduledDate?: string | null };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const operator = String(body.operator || '').trim();
  const days = Number(body.days);
  const note = String(body.note || '').trim();
  const scheduledDate = body.scheduledDate ? String(body.scheduledDate) : null;

  if (!operator || !Number.isFinite(days) || days === 0) {
    return new Response(JSON.stringify({ error: 'missing or invalid fields' }), { status: 400 });
  }

  const entry: CompDay = {
    id: randomUUID(),
    operator,
    days,
    note,
    scheduledDate,
    createdAt: new Date().toISOString(),
  };

  await redis.hset(REDIS_KEY, { [entry.id]: JSON.stringify(entry) });
  await logAudit(redis, session, 'comp_day_create', operator, `${days} día(s)`);

  return new Response(JSON.stringify({ entry }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const PATCH: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requireCompDays(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: { id?: string; scheduledDate?: string | null };
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
  const entry: CompDay = { scheduledDate: null, ...(typeof raw === 'string' ? JSON.parse(raw) : raw) };

  if (body.scheduledDate !== undefined) {
    entry.scheduledDate = body.scheduledDate || null;
  }

  await redis.hset(REDIS_KEY, { [id]: JSON.stringify(entry) });
  await logAudit(redis, session, 'comp_day_schedule', entry.operator, entry.scheduledDate || 'sin fecha');

  return new Response(JSON.stringify({ entry }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requireCompDays(cookies);
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
  await logAudit(redis, session, 'comp_day_delete', String(body.id || ''));
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
