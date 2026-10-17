import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { SESSION_COOKIE, getSession, findUserById, verifySameOrigin } from '../../lib/auth';
import { getEstadoBloqueo } from '../../lib/bloqueos';
import { confirmarComunicado } from '../../lib/comunicados';

export const prerender = false;

// Lo consulta interno-bloqueo.js en cada página: comunicados por confirmar, ventana de tareas
// vencidas, bloqueo por lead de Andrés sin confirmar y la alarma sonora.
export const GET: APIRoute = async ({ cookies }) => {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  const redis = getRedis();
  if (!redis) return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  const estado = await getEstadoBloqueo(redis, session);
  return new Response(JSON.stringify(estado), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
};

// Confirmación de lectura de un comunicado.
export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  const redis = getRedis();
  if (!redis) return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  let body: { comunicadoId?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }
  const nombre = (await findUserById(redis, session.userId))?.name || session.username;
  const ok = await confirmarComunicado(redis, session, String(body.comunicadoId || ''), nombre);
  if (!ok) return new Response(JSON.stringify({ error: 'comunicado no encontrado' }), { status: 404 });
  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
};
