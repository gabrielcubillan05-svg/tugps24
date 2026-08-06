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
  workedDate: string;
  scheduledDate: string | null;
  note: string;
  createdAt: string;
}

async function requireCompDays(cookies: any) {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canManageCompDays(session.role)) return null;
  return session;
}

async function readEntries(redis: any): Promise<CompDay[]> {
  const raw = (await redis.hgetall<Record<string, string>>(REDIS_KEY)) || {};
  return Object.values(raw)
    .map((v) => {
      try {
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    })
    .filter((e): e is any => e !== null)
    .map((e) => ({
      id: e.id,
      operator: e.operator,
      // Compatibilidad con registros antiguos (antes solo tenían "days" +/- y no fecha trabajada).
      workedDate: e.workedDate || e.createdAt,
      scheduledDate: e.scheduledDate || null,
      note: e.note || '',
      createdAt: e.createdAt,
    }))
    .sort((a, b) => b.workedDate.localeCompare(a.workedDate));
}

export const GET: APIRoute = async ({ cookies }) => {
  if (!(await requireCompDays(cookies))) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const entries = await readEntries(redis);

  // "totals" = días pendientes por asignar; "grantedTotals" = días ya asignados/dados.
  const totals: Record<string, number> = {};
  const grantedTotals: Record<string, number> = {};
  entries.forEach((e) => {
    if (e.scheduledDate) {
      grantedTotals[e.operator] = (grantedTotals[e.operator] || 0) + 1;
    } else {
      totals[e.operator] = (totals[e.operator] || 0) + 1;
    }
  });

  return new Response(JSON.stringify({ entries, totals, grantedTotals }), {
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

  let body: { operator?: string; workedDate?: string; scheduledDate?: string | null; note?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const operator = String(body.operator || '').trim();
  const workedDate = String(body.workedDate || '').trim();
  const scheduledDate = body.scheduledDate ? String(body.scheduledDate) : null;
  const note = String(body.note || '').trim();

  if (!operator || !workedDate) {
    return new Response(JSON.stringify({ error: 'empleado y fecha trabajada son obligatorios' }), { status: 400 });
  }

  const entry: CompDay = {
    id: randomUUID(),
    operator,
    workedDate,
    scheduledDate,
    note,
    createdAt: new Date().toISOString(),
  };

  await redis.hset(REDIS_KEY, { [entry.id]: JSON.stringify(entry) });
  await logAudit(redis, session, 'comp_day_create', operator, `trabajó ${workedDate}${scheduledDate ? ' · libre ' + scheduledDate : ''}`);

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

  let body: { id?: string; operator?: string; scheduledDate?: string | null; assignNext?: boolean };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  if (body.assignNext) {
    // Asigna la fecha al día pendiente más antiguo de ese empleado (sin tener que elegir cuál).
    const operator = String(body.operator || '').trim();
    const scheduledDate = body.scheduledDate ? String(body.scheduledDate) : null;
    if (!operator || !scheduledDate) {
      return new Response(JSON.stringify({ error: 'falta el empleado o la fecha' }), { status: 400 });
    }
    const entries = await readEntries(redis);
    const pending = entries
      .filter((e) => e.operator === operator && !e.scheduledDate)
      .sort((a, b) => a.workedDate.localeCompare(b.workedDate));
    if (!pending.length) {
      return new Response(JSON.stringify({ error: 'no hay días pendientes disponibles para ese empleado' }), { status: 400 });
    }
    const target = pending[0];
    target.scheduledDate = scheduledDate;
    await redis.hset(REDIS_KEY, { [target.id]: JSON.stringify(target) });
    await logAudit(redis, session, 'comp_day_schedule', operator, scheduledDate);
    return new Response(JSON.stringify({ entry: target }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const id = String(body.id || '');
  const raw = await redis.hget<string>(REDIS_KEY, id);
  if (!raw) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }
  const existing: any = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const entry: CompDay = {
    id: existing.id,
    operator: existing.operator,
    workedDate: existing.workedDate || existing.createdAt,
    scheduledDate: existing.scheduledDate || null,
    note: existing.note || '',
    createdAt: existing.createdAt,
  };

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
