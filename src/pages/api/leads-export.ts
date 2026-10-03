import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, canVerifyInstalls, verifySameOrigin } from '../../lib/auth';

export const prerender = false;

// La exportación a CSV se arma en el navegador; este endpoint solo deja constancia en
// auditoría de quién exportó cuántos leads y con qué filtros, y confirma que el rol puede.
export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canVerifyInstalls(session.role)) {
    return new Response(JSON.stringify({ error: 'solo supervisor, gerente o administrador pueden exportar' }), { status: 403 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }
  let body: { count?: number; filters?: string };
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  await logAudit(redis, session, 'leads_export', `${Number(body.count) || 0} leads`, String(body.filters || '').slice(0, 200));
  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
};
