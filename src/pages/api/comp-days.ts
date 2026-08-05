import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { getRedis } from '../../lib/redis';
import { isAuthorized, isSupervisor, AUTH_COOKIE, SUPERVISOR_COOKIE } from '../../lib/internalAuth';

export const prerender = false;

const REDIS_KEY = 'internal:comp-days';

interface CompDay {
  id: string;
  operator: string;
  days: number;
  note: string;
  createdAt: string;
}

function authorized(cookies: any) {
  return isAuthorized(cookies.get(AUTH_COOKIE)?.value) && isSupervisor(cookies.get(SUPERVISOR_COOKIE)?.value);
}

export const GET: APIRoute = async ({ cookies }) => {
  if (!authorized(cookies)) {
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
  if (!authorized(cookies)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: { operator?: string; days?: number; note?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const operator = String(body.operator || '').trim();
  const days = Number(body.days);
  const note = String(body.note || '').trim();

  if (!operator || !Number.isFinite(days) || days === 0) {
    return new Response(JSON.stringify({ error: 'missing or invalid fields' }), { status: 400 });
  }

  const entry: CompDay = {
    id: randomUUID(),
    operator,
    days,
    note,
    createdAt: new Date().toISOString(),
  };

  await redis.hset(REDIS_KEY, { [entry.id]: JSON.stringify(entry) });

  return new Response(JSON.stringify({ entry }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
  if (!authorized(cookies)) {
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
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
