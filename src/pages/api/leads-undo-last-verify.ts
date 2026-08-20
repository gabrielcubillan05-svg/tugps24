import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, canVerifyInstalls, verifySameOrigin } from '../../lib/auth';
import { readLeads, REDIS_KEY } from './leads';

export const prerender = false;

// Herramienta de una sola vez: si una subida de "Verificar instalaciones" marcó leads
// por error (ej. el archivo no traía teléfonos reales), esto revierte solo ese lote —
// todos los leads que quedaron verificados en esa subida comparten el mismo
// verifiedInstalledAt exacto (se calcula una sola vez por request), así que no afecta
// instalaciones marcadas antes a mano por los trabajadores.
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
  const verifiedAtTimestamps = leads
    .filter((l) => l.verifiedInstalled && l.verifiedInstalledAt)
    .map((l) => l.verifiedInstalledAt as string);

  if (!verifiedAtTimestamps.length) {
    return new Response(JSON.stringify({ reverted: 0, message: 'No hay leads verificados para deshacer.' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const lastTimestamp = verifiedAtTimestamps.reduce((max, t) => (t > max ? t : max));
  const now = new Date().toISOString();
  const updates: Record<string, string> = {};
  let reverted = 0;

  for (const lead of leads) {
    if (lead.verifiedInstalled && lead.verifiedInstalledAt === lastTimestamp) {
      lead.verifiedInstalled = false;
      lead.verifiedInstalledAt = null;
      lead.installed = false;
      lead.installedAt = null;
      if (lead.status === 'Instalado') lead.status = 'Contactado';
      lead.updatedAt = now;
      updates[lead.id] = JSON.stringify(lead);
      reverted++;
    }
  }

  if (Object.keys(updates).length) {
    await redis.hset(REDIS_KEY, updates);
  }

  await logAudit(redis, session, 'lead_undo_last_verify', `${reverted} leads`, lastTimestamp);

  return new Response(JSON.stringify({ reverted, timestamp: lastTimestamp }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
