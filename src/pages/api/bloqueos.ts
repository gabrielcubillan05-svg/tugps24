import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { SESSION_COOKIE, getSession } from '../../lib/auth';
import { getEstadoBloqueo } from '../../lib/bloqueos';

export const prerender = false;

// Lo consulta interno-bloqueo.js en cada página: ventana de tareas vencidas, bloqueo por lead
// de Andrés sin confirmar y la alarma sonora.
export const GET: APIRoute = async ({ cookies }) => {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  const redis = getRedis();
  if (!redis) return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  const estado = await getEstadoBloqueo(redis, session);
  return new Response(JSON.stringify(estado), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
};
