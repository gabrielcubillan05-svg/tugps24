import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { getUsers, cronSecretMatches } from '../../lib/auth';
import { logAudit } from '../../lib/audit';
import { pushNotification } from '../../lib/notifications';
import { runCleanup, describeCleanup } from '../../lib/storage-maintenance';
import { markCronOk, reportIncident } from '../../lib/incidents';

export const prerender = false;

// Limpieza diaria de almacenamiento (programada en vercel.json, 3 a. m. Colombia). Cada corrida
// está acotada, por eso conviene diaria: lotes pequeños en vez de uno enorme al mes. Las reglas de retención
// están en lib/storage-maintenance.ts; desde la sección Almacenamiento se puede simular o
// correr a mano con las mismas reglas.
export const GET: APIRoute = async ({ request }) => {
  const secret = import.meta.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');
  if (!secret || !cronSecretMatches(authHeader, secret)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const summary = await runCleanup(redis, { dryRun: false });
  const text = describeCleanup(summary);

  await logAudit(redis, { userId: 'sistema', username: 'limpieza-automatica' }, 'storage_cleanup', text, summary.errors.join(' | ') || undefined);
  if (summary.errors.length) await reportIncident(redis, 'cleanup_errors', summary.errors.slice(0, 3).join(' | '));
  else await markCronOk(redis, 'cleanup');

  // Los administradores se enteran por la campanita de qué se archivó y si algo falló.
  try {
    const admins = (await getUsers(redis)).filter((u) => u.active && u.role === 'admin');
    for (const admin of admins) {
      await pushNotification(redis, admin.id, {
        type: 'sistema',
        message: `🧹 ${text}`,
        link: '/interno/almacenamiento',
      });
    }
  } catch {
    // avisar no debe tumbar el resultado de la limpieza
  }

  return new Response(JSON.stringify({ ok: true, summary }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
