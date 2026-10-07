import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { isQuietHoursColombia } from '../../lib/whatsapp';
import { getUsers, branchesOf, cronSecretMatches } from '../../lib/auth';
import { sendGabotMessage } from '../../lib/gabot';
import { runCronGuarded, claimOnce, cronSlot } from '../../lib/cron-guard';
import { markCronOk } from '../../lib/incidents';
import { pushNotification } from '../../lib/notifications';
import { readLeads } from './leads';

export const prerender = false;

// Corre cada hora (ver vercel.json) — a diferencia de la minuta general de GaBot (4 veces al
// día, gabot-reminders-cron.ts), esto es solo para las ventas que Andrés concreta por WhatsApp
// y que la secretaria/gerente de la sucursal todavía no han confirmado ("Confirmar que ya sé de
// esta venta" en el CRM): se les recuerda por el chat de GaBot Y por la campanita (que ya suena
// sola cuando le llega una notificación nueva, ver interno-notifications.js) cada hora hasta que
// alguno de los dos confirme.
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

  if (isQuietHoursColombia()) {
    // El cron sí corrió (solo que no es hora de mandar): cuenta como sano para /api/health.
    await markCronOk(redis, 'gabot-venta-reminder');
    return new Response(JSON.stringify({ ok: true, sent: 0, skipped: 'quiet hours' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const guarded = await runCronGuarded(redis, 'gabot-venta-reminder', 600, async () => {
  const [leads, users] = await Promise.all([readLeads(redis), getUsers(redis)]);
  const pendientes = leads.filter((l) => l.aiStage === 'entregado' && !l.managerAckAt);
  const slot = cronSlot(true);

  let sent = 0;
  for (const lead of pendientes) {
    const servicingBranch = lead.convertedBranch || lead.city;
    if (!servicingBranch) continue;
    const branchStaff = users.filter((u) => u.active && branchesOf(u).includes(servicingBranch));
    const secretaria = branchStaff.find((u) => u.role === 'secretaria');
    const gerente = branchStaff.find((u) => u.role === 'gerente');
    const message = `🚨 Recordatorio: sigue sin confirmar la venta que concretó Andrés — ${lead.name} (${lead.city}). Entra al CRM y dale a "Confirmar que ya sé de esta venta".`;
    const notified = new Set<string>();
    for (const person of [secretaria, gerente]) {
      if (!person || notified.has(person.id)) continue;
      notified.add(person.id);
      // El chat no se actualiza "en sitio" como la campanita: una corrida repetida en la misma
      // hora mandaría el mismo recordatorio dos veces.
      if (!(await claimOnce(redis, `internal:gabot-sent:venta:${slot}:${lead.id}:${person.id}`))) continue;
      await sendGabotMessage(redis, person.id, message);
      // Misma key siempre para el mismo lead+persona: cada corrida actualiza la misma
      // notificación (vuelve a quedar sin leer y a sonar) en vez de amontonar una nueva cada hora.
      await pushNotification(redis, person.id, {
        type: 'crm-urgent',
        message: `🚨 Venta de ${lead.name} (${lead.city}) sigue sin confirmar`,
        link: '/interno/crm',
        key: `venta-sin-confirmar:${lead.id}`,
      });
      sent++;
    }
  }

  return { pendientes: pendientes.length, sent };
  });
  const body = 'skipped' in guarded ? { ok: true, sent: 0, skipped: guarded.skipped } : { ok: true, ...guarded.result };
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
};
