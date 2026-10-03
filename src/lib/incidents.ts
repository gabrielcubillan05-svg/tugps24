import { logAudit } from './audit';
import { getUsers, JOSUE_USERNAME } from './auth';
import { pushNotification } from './notifications';

// Antes, cuando Anthropic se quedaba sin créditos, Meta rechazaba envíos o un cron fallaba,
// el error quedaba solo en la consola de Vercel y nadie se enteraba. Aquí cada incidente queda
// en auditoría, se cuenta, y avisa por campanita y push a los administradores y a Josué, con
// un límite de un aviso por tipo cada 15 minutos para no inundar.
const NOTIFY_EVERY_SECONDS = 15 * 60;
const INCIDENT_ACTOR = { userId: 'sistema', username: 'monitor' };

export async function reportIncident(redis: any, code: string, detail: string): Promise<void> {
  const safeDetail = String(detail || '').slice(0, 300);
  console.error(`incidente ${code}:`, safeDetail);
  try {
    await logAudit(redis, INCIDENT_ACTOR, 'incident', code, safeDetail);
    const countKey = `internal:incident:${code}`;
    const count = Number(await redis.incr(countKey)) || 1;
    if (count === 1) await redis.expire(countKey, 3600);
    const first = await redis.set(`internal:incident-notified:${code}`, '1', { nx: true, ex: NOTIFY_EVERY_SECONDS });
    if (!first) return;
    const users = await getUsers(redis);
    const targets = users.filter((u) => u.active && (u.role === 'admin' || u.username.toLowerCase() === JOSUE_USERNAME));
    await Promise.allSettled(
      targets.map((u) =>
        pushNotification(redis, u.id, {
          type: 'incidente',
          message: `⚠️ Incidente del sistema (${code}): ${safeDetail}${count > 1 ? ` · ${count} veces en la última hora` : ''}`,
          link: '/interno/auditoria',
          key: `incident:${code}`,
        })
      )
    );
  } catch (err) {
    console.error('reportIncident: no se pudo registrar', err instanceof Error ? err.message : String(err));
  }
}

// Marca "este cron terminó bien" con fecha, para que /api/health detecte crons que dejaron
// de correr (p. ej. por un CRON_SECRET cambiado) aunque nadie mire los logs.
export async function markCronOk(redis: any, name: string): Promise<void> {
  try {
    await redis.set(`internal:cron-ok:${name}`, new Date().toISOString(), { ex: 3 * 24 * 3600 });
  } catch {
    // no debe tumbar el cron
  }
}
