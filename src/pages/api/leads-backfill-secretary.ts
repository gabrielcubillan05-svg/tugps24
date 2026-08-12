import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, canVerifyInstalls, verifySameOrigin } from '../../lib/auth';
import { readLeads, REDIS_KEY } from './leads';

export const prerender = false;

// Herramienta de una sola vez: asigna al creador los leads que quedaron "Sin asignar"
// desde antes de que la asignación automática existiera.
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
    if (!lead.secretary && lead.createdByName) {
      lead.secretary = lead.createdByName;
      lead.updatedAt = now;
      updates[lead.id] = JSON.stringify(lead);
      updated++;
    }
  }

  if (Object.keys(updates).length) {
    await redis.hset(REDIS_KEY, updates);
  }

  await logAudit(redis, session, 'lead_backfill_secretary', `${updated} leads asignados a su creador`);

  return new Response(JSON.stringify({ updated }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
