import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { getUsers, canAccessRRHH, branchesOf } from '../../lib/auth';
import { readProfiles } from './employees';
import { readSchedule } from './schedule';
import { shiftBucketFor, SHIFT_SUPERVISORS } from '../../lib/shift';
import { sendGabotMessage } from '../../lib/gabot';
import { pushNotification } from '../../lib/notifications';
import { todayInColombia } from '../../lib/colombia-time';

export const prerender = false;

// Corre una vez al día, 7:00am Colombia (ver vercel.json). Si algún empleado activo cumple años
// hoy (mes/día, sin importar el año de nacimiento), avisa por chat de GaBot + campanita a:
// - Quien tenga acceso a RR.HH. (admin, Josué, Wilmar) — ve todos los cumpleaños del día.
// - El/los gerente(s) de la(s) sucursal(es) del cumpleañero.
// - Si es operador, también su supervisor de turno (mismo criterio que gabot-reminders-cron).
// Cada destinatario recibe un solo mensaje con los cumpleaños que de verdad le tocan a él (un
// gerente de Riohacha no necesita enterarse del cumpleaños de alguien en Medellín).
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

  const [users, profiles, schedule] = await Promise.all([getUsers(redis), readProfiles(redis), readSchedule(redis)]);
  const todayMD = todayInColombia().slice(5); // "MM-DD"

  const birthdayPeople = users.filter(
    (u) => u.active && profiles[u.id]?.fechaNacimiento && profiles[u.id].fechaNacimiento.slice(5, 10) === todayMD
  );

  if (!birthdayPeople.length) {
    return new Response(JSON.stringify({ ok: true, birthdays: 0 }), { headers: { 'Content-Type': 'application/json' } });
  }

  // recipientId -> nombres de cumpleañeros que le tocan
  const namesByRecipient = new Map<string, Set<string>>();
  function addToRecipient(recipientId: string, name: string) {
    if (!namesByRecipient.has(recipientId)) namesByRecipient.set(recipientId, new Set());
    namesByRecipient.get(recipientId)!.add(name);
  }

  const rrhhRecipients = users.filter((u) => u.active && canAccessRRHH(u));
  const gerentes = users.filter((u) => u.active && u.role === 'gerente');

  for (const person of birthdayPeople) {
    for (const rrhh of rrhhRecipients) {
      if (rrhh.id === person.id) continue;
      addToRecipient(rrhh.id, person.name);
    }

    const personBranches = branchesOf(person);
    for (const gerente of gerentes) {
      if (gerente.id === person.id) continue;
      if (branchesOf(gerente).some((b) => personBranches.includes(b))) addToRecipient(gerente.id, person.name);
    }

    if (person.role === 'operador') {
      const bucket = shiftBucketFor(schedule, person.name);
      if (bucket) {
        const supervisorDef = SHIFT_SUPERVISORS.find((s) => s.buckets.includes(bucket));
        const supervisorUser = supervisorDef && users.find((u) => u.active && u.username.toLowerCase() === supervisorDef.username);
        if (supervisorUser) addToRecipient(supervisorUser.id, person.name);
      }
    }
  }

  let sent = 0;
  for (const [recipientId, names] of namesByRecipient.entries()) {
    const list = [...names];
    const message = list.length === 1
      ? `🎉 Hoy es el cumpleaños de ${list[0]}.`
      : `🎉 Hoy cumplen años: ${list.join(', ')}.`;
    try {
      await sendGabotMessage(redis, recipientId, message);
      await pushNotification(redis, recipientId, { type: 'cumpleanos', message, link: '/interno/rrhh' });
      sent++;
    } catch {
      // no debe tumbar el resto de avisos si uno falla
    }
  }

  return new Response(JSON.stringify({ ok: true, birthdays: birthdayPeople.length, sent }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
