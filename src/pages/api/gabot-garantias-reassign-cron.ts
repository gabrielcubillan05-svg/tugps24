import type { APIRoute } from 'astro';
import { cronSecretMatches } from '../../lib/auth';
import { getRedis } from '../../lib/redis';
import { reassignForToday } from './garantias';
import { runCronGuarded } from '../../lib/cron-guard';

export const prerender = false;

// Corre una vez al día, temprano (5am Colombia, ver vercel.json) — antes de que arranque el día
// de llamadas, mueve las garantías pendientes entre el titular y quien las cubre según el día
// libre de hoy (ver reassignForToday en garantias.ts).
export const GET: APIRoute = async ({ request }) => {
  const secret = import.meta.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');
  if (!secret || !cronSecretMatches(authHeader, secret)) {
    return new Response('unauthorized', { status: 401 });
  }

  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const guarded = await runCronGuarded(redis, 'gabot-garantias-reassign', 600, () => reassignForToday(redis));
  const body = 'skipped' in guarded ? { ok: true, moved: 0, skipped: guarded.skipped } : { ok: true, moved: guarded.result.moved };
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
};
