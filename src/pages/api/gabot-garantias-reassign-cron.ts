import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { reassignForToday } from './garantias';

export const prerender = false;

// Corre una vez al día, temprano (5am Colombia, ver vercel.json) — antes de que arranque el día
// de llamadas, mueve las garantías pendientes entre el titular y quien las cubre según el día
// libre de hoy (ver reassignForToday en garantias.ts).
export const GET: APIRoute = async ({ request }) => {
  const secret = import.meta.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return new Response('unauthorized', { status: 401 });
  }

  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const { moved } = await reassignForToday(redis);

  return new Response(JSON.stringify({ ok: true, moved }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
