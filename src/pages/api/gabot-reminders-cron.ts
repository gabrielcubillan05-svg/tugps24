import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { isQuietHoursColombia } from '../../lib/whatsapp';
import { getUsers } from '../../lib/auth';
import { sendGabotMessage } from '../../lib/gabot';
import { collectPendingLines, type GabotData } from '../../lib/gabot-report';
import { isOnShiftNow } from '../../lib/shift';
import { readSuspensiones } from './suspensiones';
import { readSolicitudes } from './solicitudes-administrativas';
import { readPagos } from './pagos-internos';
import { readTasks } from './tasks';
import { readLeads } from './leads';
import { readClientes } from './seguimiento-masivos';
import { readCasos } from './casos-importantes';
import { readScheduledReports } from './scheduled-reports';
import { readSchedule } from './schedule';

export const prerender = false;

// Vercel llama esto a las 7:50, 10:50, 13:50 y 16:50 hora Colombia (ver vercel.json) — desde
// la apertura hasta el cierre de oficinas (6pm), cada 3 horas. GaBot, el asistente interno,
// revisa los pendientes de cada trabajador en TODOS los módulos (Suspensiones, Solicitudes
// administrativas, Pagos programados, Tareas, CRM, Seguimiento a clientes masivos, Casos
// importantes y Reportes programados) y le manda UN solo mensaje consolidado por el chat
// interno — solo si le queda algo pendiente. La corrida de las 7:50am es la "minuta del día".
export const GET: APIRoute = async ({ request }) => {
  const secret = import.meta.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');
  if (secret && authHeader !== `Bearer ${secret}`) {
    return new Response('unauthorized', { status: 401 });
  }

  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  // Salvaguarda: aunque el horario del cron ya solo dispara en horario de oficina, nunca
  // molestamos de madrugada si algo llama a este endpoint fuera de lo programado.
  if (isQuietHoursColombia()) {
    return new Response(JSON.stringify({ ok: true, sent: 0, skipped: 'quiet hours' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const colombiaHour = (new Date().getUTCHours() - 5 + 24) % 24;
  const isMorningBriefing = colombiaHour === 7;

  const [users, suspensiones, solicitudes, pagos, tasks, leads, clientesMasivos, casos, scheduledReports, schedule] = await Promise.all([
    getUsers(redis),
    readSuspensiones(redis),
    readSolicitudes(redis),
    readPagos(redis),
    readTasks(redis),
    readLeads(redis),
    readClientes(redis),
    readCasos(redis),
    readScheduledReports(redis),
    readSchedule(redis),
  ]);

  const data: GabotData = { suspensiones, solicitudes, pagos, tasks, leads, clientesMasivos, casos, scheduledReports };

  let sent = 0;
  for (const user of users) {
    if (!user.active) continue;
    // A los operadores solo se les molesta si su horario configurado dice que están de
    // turno ahora mismo (si no tienen horario cargado, se les recuerda igual que a los demás).
    if (user.role === 'operador' && !isOnShiftNow(schedule, user.name)) continue;

    const lines = collectPendingLines(user, data);
    if (!lines.length) continue;

    const firstName = user.name.trim().split(/\s+/)[0] || user.name;
    const text = isMorningBriefing
      ? `Buenos días ${firstName} ☀️ Esta es tu minuta de pendientes para hoy:\n\n${lines.join('\n')}`
      : `Hola ${firstName}, este es tu recordatorio de pendientes:\n\n${lines.join('\n')}`;
    await sendGabotMessage(redis, user.id, text);
    sent++;
  }

  return new Response(JSON.stringify({ ok: true, sent, totalUsers: users.length, isMorningBriefing }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
