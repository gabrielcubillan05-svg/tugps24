import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, canVerifyInstalls, verifySameOrigin } from '../../lib/auth';
import { readLeads, REDIS_KEY } from './leads';

export const prerender = false;

// Herramienta de una sola vez: corrige los leads que quedaron en "Nuevo" a pesar de ya
// tener una nota (creados antes de que el estado se subiera automáticamente en ese caso).
export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canVerifyInstalls(session.role)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const leads = await readLeads(redis);
  const now = new Date().toISOString();
  const updates: Record<string, string> = {};
  let updated = 0;

  for (const lead of leads) {
    if (lead.status === 'Nuevo' && lead.notes.length > 0) {
      lead.status = 'Contactado';
      lead.updatedAt = now;
      updates[lead.id] = JSON.stringify(lead);
      updated++;
    }
  }

  if (Object.keys(updates).length) {
    await redis.hset(REDIS_KEY, updates);
  }

  await logAudit(redis, session, 'lead_backfill_contacted', `${updated} leads movidos a Contactado`);

  return new Response(JSON.stringify({ updated }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
