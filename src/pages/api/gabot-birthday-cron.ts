import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { getUsers, canAccessRRHH } from '../../lib/auth';
import { readProfiles } from './employees';
import { sendGabotMessage } from '../../lib/gabot';
import { pushNotification } from '../../lib/notifications';
import { todayInColombia } from '../../lib/colombia-time';

export const prerender = false;

// Corre una vez al día, 7:00am Colombia (ver vercel.json). Si algún empleado activo cumple
// años hoy (mes/día, sin importar el año de nacimiento), le avisa a quien tenga acceso a
// RR.HH. (admin, Josué, Wilmar) por el chat de GaBot + campanita.
export const GET: APIRoute = async ({ request }) => {
  const secret = import.meta.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return new Response('unauthorized', { status: 401 });
  }

  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const [users, profiles] = await Promise.all([getUsers(redis), readProfiles(redis)]);
  const todayMD = todayInColombia().slice(5); // "MM-DD"

  const birthdays = users
    .filter((u) => u.active && profiles[u.id]?.fechaNacimiento)
    .filter((u) => profiles[u.id].fechaNacimiento.slice(5, 10) === todayMD)
    .map((u) => u.name);

  if (!birthdays.length) {
    return new Response(JSON.stringify({ ok: true, birthdays: 0 }), { headers: { 'Content-Type': 'application/json' } });
  }

  const message = birthdays.length === 1
    ? `🎉 Hoy es el cumpleaños de ${birthdays[0]}.`
    : `🎉 Hoy cumplen años: ${birthdays.join(', ')}.`;

  const recipients = users.filter((u) => u.active && canAccessRRHH(u));
  let sent = 0;
  for (const person of recipients) {
    try {
      await sendGabotMessage(redis, person.id, message);
      await pushNotification(redis, person.id, { type: 'cumpleanos', message, link: '/interno/rrhh' });
      sent++;
    } catch {
      // no debe tumbar el resto de avisos si uno falla
    }
  }

  return new Response(JSON.stringify({ ok: true, birthdays: birthdays.length, sent }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
