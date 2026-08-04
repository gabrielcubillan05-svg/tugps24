import type { APIRoute } from 'astro';
import { Redis } from '@upstash/redis';

export const prerender = false;

const CITIES = ['Bogota', 'Cali', 'Cucuta', 'Cartagena', 'Pereira', 'Otra'];
const REDIS_KEY = 'survey:proxima-sucursal';

function getRedis() {
  const url = import.meta.env.KV_REST_API_URL || import.meta.env.UPSTASH_REDIS_REST_URL;
  const token = import.meta.env.KV_REST_API_TOKEN || import.meta.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

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
