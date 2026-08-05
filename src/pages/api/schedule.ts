import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { isAuthorized, AUTH_COOKIE } from '../../lib/internalAuth';

export const prerender = false;

const REDIS_KEY = 'internal:schedule';

export const GET: APIRoute = async ({ cookies }) => {
  if (!isAuthorized(cookies.get(AUTH_COOKIE)?.value)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const raw = (await redis.hgetall<Record<string, string>>(REDIS_KEY)) || {};
  const schedule = Object.entries(raw).map(([operator, horario]) => ({ operator, horario }));
  schedule.sort((a, b) => a.operator.localeCompare(b.operator));

  return new Response(JSON.stringify({ schedule }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!isAuthorized(cookies.get(AUTH_COOKIE)?.value)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: { operator?: string; horario?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const operator = String(body.operator || '').trim();
  const horario = String(body.horario || '').trim();
  if (!operator || !horario) {
    return new Response(JSON.stringify({ error: 'missing fields' }), { status: 400 });
  }

  await redis.hset(REDIS_KEY, { [operator]: horario });

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
