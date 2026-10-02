import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { getUsers } from '../../lib/auth';
import { sendPushToUser } from '../../lib/push';
import { pushNotification } from '../../lib/notifications';
import { isOnShiftNow } from '../../lib/shift';
import { todayInColombia, timeInColombia } from '../../lib/colombia-time';
import { readSchedule } from './schedule';
import { readShutdownSchedules, buildAgenda, toMinutes, LATE_AFTER_MINUTES, type AgendaEntry } from './apagados-programados';

export const prerender = false;

// Corre cada minuto (ver vercel.json). La alarma principal es la pantalla del panel; esto es
// el respaldo al celular: un minuto antes de cada apagado/encendido manda la notificación push
// a los operadores que están en turno, y si pasados LATE_AFTER_MINUTES nadie lo confirmó,
// avisa a los supervisores. Cada aviso se manda una sola vez por franja.
const ACTION_LABEL = { apagar: 'APAGAR', encender: 'ENCENDER' } as const;

function describe(e: AgendaEntry): string {
  return `${ACTION_LABEL[e.accion]} ${e.placa}${e.cliente ? ` · ${e.cliente}` : ''} a las ${e.hora}`;
}

export const GET: APIRoute = async ({ request }) => {
  const secret = import.meta.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return new Response('unauthorized', { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const date = todayInColombia();
  const now = timeInColombia();
  const nowMin = toMinutes(now);
  const agenda = buildAgenda(await readShutdownSchedules(redis), date, now);

  const upcoming = agenda.filter((e) => e.status !== 'hecho' && toMinutes(e.hora) - nowMin === 1);
  // Ventana de 3 minutos por si una corrida del cron se salta o llega tarde.
  const late = agenda.filter((e) => {
    const delay = nowMin - toMinutes(e.hora);
    return e.status === 'vencido' && delay >= LATE_AFTER_MINUTES && delay < LATE_AFTER_MINUTES + 3;
  });
  if (!upcoming.length && !late.length) {
    return new Response(JSON.stringify({ ok: true, pushed: 0, escalated: 0 }), { headers: { 'Content-Type': 'application/json' } });
  }

  const [users, schedule] = await Promise.all([getUsers(redis), readSchedule(redis)]);
  const active = users.filter((u) => u.active);
  const operatorsOnShift = active.filter((u) => u.role === 'operador' && isOnShiftNow(schedule, u.name));
  const supervisors = active.filter((u) => u.role === 'supervisor');

  let pushed = 0;
  for (const e of upcoming) {
    const first = await redis.set(`internal:shutdown-push:${e.id}:${e.slot}`, '1', { nx: true, ex: 600 });
    if (!first) continue;
    await Promise.allSettled(
      operatorsOnShift.map((u) =>
        sendPushToUser(redis, u.id, {
          title: `⏰ En 1 minuto: ${ACTION_LABEL[e.accion]} ${e.placa}`,
          body: `${e.cliente ? e.cliente + ' · ' : ''}${e.hora}${e.nota ? ' · ' + e.nota : ''}`,
          link: '/interno/apagados-programados',
        })
      )
    );
    pushed++;
  }

  let escalated = 0;
  for (const e of late) {
    const first = await redis.set(`internal:shutdown-late:${e.id}:${e.slot}`, '1', { nx: true, ex: 7200 });
    if (!first) continue;
    const message = `Sin confirmar: ${describe(e)} lleva ${LATE_AFTER_MINUTES} minutos sin que ningún operador lo marque hecho.`;
    await Promise.allSettled(
      supervisors.map(async (u) => {
        await pushNotification(redis, u.id, { type: 'apagado-programado', message, link: '/interno/apagados-programados', key: `shutdown-late:${e.id}:${e.slot}` });
        await sendPushToUser(redis, u.id, { title: `⚠️ ${ACTION_LABEL[e.accion]} ${e.placa} sin confirmar`, body: message, link: '/interno/apagados-programados' });
      })
    );
    escalated++;
  }

  return new Response(JSON.stringify({ ok: true, pushed, escalated, upcoming: upcoming.map(describe), late: late.map(describe) }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
