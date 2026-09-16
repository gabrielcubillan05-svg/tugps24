import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, canAccessRRHH, verifySameOrigin } from '../../lib/auth';
import { createVacationEntry } from './contracts';

export const prerender = false;

const REDIS_KEY = 'internal:vacation-requests';

type Status = 'pendiente' | 'aprobada' | 'rechazada';

interface VacationRequest {
  id: string;
  employeeId: string;
  employeeName: string;
  startDate: string;
  endDate: string;
  note: string;
  status: Status;
  requestedAt: string;
  resolvedAt: string | null;
  resolvedByName: string | null;
  resolutionNote: string;
}

export async function readEntries(redis: any): Promise<VacationRequest[]> {
  const raw = (await redis.hgetall<Record<string, string>>(REDIS_KEY)) || {};
  return Object.values(raw)
    .map((v) => {
      try {
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    })
    .filter((e): e is VacationRequest => e !== null)
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}

export const GET: APIRoute = async ({ cookies }) => {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let entries = await readEntries(redis);
  if (!canAccessRRHH(session)) {
    entries = entries.filter((e) => e.employeeId === session.userId);
  }

  return new Response(JSON.stringify({ entries }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const body = await request.json().catch(() => null);
  const startDate = String(body?.startDate || '').trim();
  const endDate = String(body?.endDate || '').trim();
  if (!startDate || !endDate) {
    return new Response(JSON.stringify({ error: 'faltan las fechas' }), { status: 400 });
  }

  // employeeId/employeeName siempre salen de la sesión — nadie puede solicitar a nombre de otro.
  const entry: VacationRequest = {
    id: randomUUID(),
    employeeId: session.userId,
    employeeName: session.name,
    startDate,
    endDate,
    note: String(body?.note || '').trim(),
    status: 'pendiente',
    requestedAt: new Date().toISOString(),
    resolvedAt: null,
    resolvedByName: null,
    resolutionNote: '',
  };

  await redis.hset(REDIS_KEY, { [entry.id]: JSON.stringify(entry) });
  await logAudit(redis, session, 'vacation_request_create', session.name, `${startDate} – ${endDate}`);

  return new Response(JSON.stringify({ entry }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const PATCH: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessRRHH(session)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const body = await request.json().catch(() => null);
  const id = String(body?.id || '');
  const status = body?.status as Status;
  if (!id || (status !== 'aprobada' && status !== 'rechazada')) {
    return new Response(JSON.stringify({ error: 'faltan datos' }), { status: 400 });
  }

  const raw = await redis.hget<string>(REDIS_KEY, id);
  if (!raw) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }
  const entry: VacationRequest = typeof raw === 'string' ? JSON.parse(raw) : raw;
  entry.status = status;
  entry.resolvedAt = new Date().toISOString();
  entry.resolvedByName = session.name;
  entry.resolutionNote = String(body?.resolutionNote || '').trim();

  await redis.hset(REDIS_KEY, { [id]: JSON.stringify(entry) });

  if (status === 'aprobada') {
    await createVacationEntry(redis, entry.employeeName, entry.startDate, entry.endDate, entry.note);
  }

  await logAudit(redis, session, 'vacation_request_resolve', entry.employeeName, status);

  return new Response(JSON.stringify({ entry }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const body = await request.json().catch(() => null);
  const id = String(body?.id || '');
  const raw = await redis.hget<string>(REDIS_KEY, id);
  if (!raw) {
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }
  const entry: VacationRequest = typeof raw === 'string' ? JSON.parse(raw) : raw;

  const isOwner = entry.employeeId === session.userId;
  if (!canAccessRRHH(session) && !(isOwner && entry.status === 'pendiente')) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  await redis.hdel(REDIS_KEY, id);
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
