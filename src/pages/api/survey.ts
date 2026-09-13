import type { APIRoute } from 'astro';
import type { Redis } from '@upstash/redis';
import { getRedis } from '../../lib/redis';
import { getClientIp, checkAndIncrementRateLimit } from '../../lib/rate-limit';

export const prerender = false;

const CITIES = ['Bogota', 'Cali', 'Cucuta', 'Cartagena', 'Pereira', 'Otra'];
const REDIS_KEY = 'survey:proxima-sucursal';
// Un solo voto por IP cada pocos segundos — suficiente para frenar un script que intente
// inflar la encuesta, sin bloquear a alguien que de verdad quiera votar.
const MAX_VOTES_PER_IP_PER_WINDOW = 5;
const VOTE_WINDOW_SECONDS = 60;

async function readCounts(redis: Redis) {
  const raw = (await redis.hgetall<Record<string, number>>(REDIS_KEY)) || {};
  const counts: Record<string, number> = {};
  for (const city of CITIES) {
    counts[city] = Number(raw[city]) || 0;
  }
  return counts;
}

export const GET: APIRoute = async () => {
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }
  const counts = await readCounts(redis);
  return new Response(JSON.stringify(counts), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};

export const POST: APIRoute = async ({ request }) => {
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const ip = getClientIp(request);
  const okRate = await checkAndIncrementRateLimit(redis, `internal:survey-rate:${ip}`, MAX_VOTES_PER_IP_PER_WINDOW, VOTE_WINDOW_SECONDS);
  if (!okRate) {
    return new Response(JSON.stringify({ error: 'demasiados votos, intenta en un momento' }), { status: 429 });
  }

  let city: unknown;
  try {
    const body = await request.json();
    city = body?.city;
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  if (typeof city !== 'string' || !CITIES.includes(city)) {
    return new Response(JSON.stringify({ error: 'invalid city' }), { status: 400 });
  }

  await redis.hincrby(REDIS_KEY, city, 1);
  const counts = await readCounts(redis);
  return new Response(JSON.stringify(counts), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};
