import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';

export const prerender = false;

const REDIS_KEY = 'visits:total';

export const GET: APIRoute = async () => {
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }
  const count = await redis.incr(REDIS_KEY);
  return new Response(JSON.stringify({ count }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};
