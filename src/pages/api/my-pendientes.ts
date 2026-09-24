import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { findUserById, SESSION_COOKIE, getSession } from '../../lib/auth';
import { collectPendingLines, type GabotData } from '../../lib/gabot-report';
import { readSuspensiones } from './suspensiones';
import { readSolicitudes } from './solicitudes-administrativas';
import { readPagos } from './pagos-internos';
import { readTasks } from './tasks';
import { readLeads } from './leads';
import { readClientes } from './seguimiento-masivos';
import { readCasos } from './casos-importantes';
import { readScheduledReports } from './scheduled-reports';
import { readGarantias } from './garantias';

export const prerender = false;

// Mismo resumen que GaBot arma para el recordatorio de las 7:50am (gabot-reminders-cron.ts),
// pero a demanda para la propia persona — se usa en el bloque de pendientes de Inicio.
export const GET: APIRoute = async ({ cookies }) => {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const [me, suspensiones, solicitudes, pagos, tasks, leads, clientesMasivos, casos, scheduledReports, garantias] = await Promise.all([
    findUserById(redis, session.userId),
    readSuspensiones(redis),
    readSolicitudes(redis),
    readPagos(redis),
    readTasks(redis),
    readLeads(redis),
    readClientes(redis),
    readCasos(redis),
    readScheduledReports(redis),
    readGarantias(redis),
  ]);

  if (!me) {
    return new Response(JSON.stringify({ error: 'usuario no encontrado' }), { status: 404 });
  }

  const data: GabotData = { suspensiones, solicitudes, pagos, tasks, leads, clientesMasivos, casos, scheduledReports, garantias };
  const lines = collectPendingLines(me, data);

  return new Response(JSON.stringify({ lines }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};
