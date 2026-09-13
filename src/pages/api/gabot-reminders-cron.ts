import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { isQuietHoursColombia } from '../../lib/whatsapp';
import { getUsers, JOSUE_USERNAME, WILMAR_USERNAME, ROLE_LABELS, branchesOf } from '../../lib/auth';
import { sendGabotMessage } from '../../lib/gabot';
import { collectPendingLines, type GabotData } from '../../lib/gabot-report';
import { computePerformanceFlags, type PerformanceFlag } from '../../lib/gabot-performance';
import { isOnShiftNow, shiftBucketFor, type ShiftBucket } from '../../lib/shift';
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

// Supervisores de turno de los operadores — cada uno ve el rendimiento de los operadores de
// su franja, sin importar su rol formal en el sistema (no depende de sucursal, como gerente).
// Por username, no por nombre (más estable — el nombre completo registrado no siempre coincide
// con el nombre corto por el que se les conoce).
const SHIFT_SUPERVISORS: Array<{ username: string; buckets: ShiftBucket[] }> = [
  { username: 'josemiguel', buckets: ['temprano'] }, // Jose Miguel Reales Durango
  { username: 'juniorcardenas', buckets: ['tarde', 'noche'] }, // Hisnaldis Junior Cardenas Almanza
];

// Vercel llama esto a las 7:50, 10:50, 13:50 y 16:50 hora Colombia (ver vercel.json) — desde
// la apertura hasta el cierre de oficinas (6pm), cada 3 horas. GaBot, el asistente interno,
// revisa los pendientes de cada trabajador en TODOS los módulos (Suspensiones, Solicitudes
// administrativas, Pagos programados, Tareas, CRM, Seguimiento a clientes masivos, Casos
// importantes y Reportes programados) y le manda UN solo mensaje consolidado por el chat
// interno — solo si le queda algo pendiente. La corrida de las 7:50am es la "minuta del día",
// y además revisa rendimiento (volumen acumulado y velocidad de resolución vs. umbrales por
// módulo, ver lib/gabot-performance.ts): si alguien los dispara, le manda una alerta aparte a
// esa persona y un resumen consolidado a admin, Josué y Wilmar.
export const GET: APIRoute = async ({ request }) => {
  const secret = import.meta.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');
  // Antes, si CRON_SECRET no estaba configurado, la condición se saltaba entera y el endpoint
  // quedaba abierto a cualquiera en internet — "falla abierto" en vez de "falla cerrado".
  if (!secret || authHeader !== `Bearer ${secret}`) {
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

  // Solo se revisa rendimiento una vez al día, junto con la minuta — para no repetir la
  // misma alerta cuatro veces en el mismo día.
  const flaggedWorkers: Array<{ user: typeof users[number]; flags: PerformanceFlag[] }> = [];

  let sent = 0;
  for (const user of users) {
    if (!user.active) continue;
    // A los operadores solo se les molesta si su horario configurado dice que están de
    // turno ahora mismo (si no tienen horario cargado, se les recuerda igual que a los demás).
    if (user.role === 'operador' && !isOnShiftNow(schedule, user.name)) continue;

    const lines = collectPendingLines(user, data);
    if (lines.length) {
      const firstName = user.name.trim().split(/\s+/)[0] || user.name;
      const text = isMorningBriefing
        ? `Buenos días ${firstName} ☀️ Esta es tu minuta de pendientes para hoy:\n\n${lines.join('\n')}`
        : `Hola ${firstName}, este es tu recordatorio de pendientes:\n\n${lines.join('\n')}`;
      await sendGabotMessage(redis, user.id, text);
      sent++;
    }

    if (isMorningBriefing) {
      const flags = computePerformanceFlags(user, data);
      if (flags.length) {
        flaggedWorkers.push({ user, flags });
        const firstName = user.name.trim().split(/\s+/)[0] || user.name;
        const flagLines = flags.map((f) => `  · ${f.module} (${f.kind}): ${f.detail}`).join('\n');
        await sendGabotMessage(
          redis,
          user.id,
          `⚠️ ${firstName}, noté que llevas unos días con demoras en algunos módulos — ¿necesitas ayuda con algo?\n\n${flagLines}`
        );
      }
    }
  }

  // Resumen para admin, Josué y Wilmar — quienes ya ven todo, sin importar su rol del día a día.
  if (isMorningBriefing && flaggedWorkers.length) {
    const overseers = users.filter(
      (u) => u.active && (u.role === 'admin' || [JOSUE_USERNAME, WILMAR_USERNAME].includes(u.username.toLowerCase()))
    );
    const summaryLines = flaggedWorkers
      .map(({ user, flags }) => {
        const flagLines = flags.map((f) => `    · ${f.module} (${f.kind}): ${f.detail}`).join('\n');
        return `  ${user.name} (${ROLE_LABELS[user.role]}):\n${flagLines}`;
      })
      .join('\n');
    const summaryText = `📊 Resumen de rendimiento de hoy — ${flaggedWorkers.length} trabajador(es) con demoras:\n\n${summaryLines}`;
    for (const overseer of overseers) {
      await sendGabotMessage(redis, overseer.id, summaryText);
    }

    // A cada gerente le llega también el resumen, pero solo de su(s) propia(s) sucursal(es) —
    // no el de toda la empresa como a admin/Josué/Wilmar.
    const gerentes = users.filter((u) => u.active && u.role === 'gerente');
    for (const gerente of gerentes) {
      const misSucursales = branchesOf(gerente);
      if (!misSucursales.length) continue;
      const misFlagged = flaggedWorkers.filter(
        (fw) => fw.user.id !== gerente.id && branchesOf(fw.user).some((b) => misSucursales.includes(b))
      );
      if (!misFlagged.length) continue;
      const misSummaryLines = misFlagged
        .map(({ user, flags }) => {
          const flagLines = flags.map((f) => `    · ${f.module} (${f.kind}): ${f.detail}`).join('\n');
          return `  ${user.name} (${ROLE_LABELS[user.role]}):\n${flagLines}`;
        })
        .join('\n');
      const misSummaryText = `📊 Resumen de rendimiento de hoy en tu sucursal — ${misFlagged.length} trabajador(es) con demoras:\n\n${misSummaryLines}`;
      await sendGabotMessage(redis, gerente.id, misSummaryText);
    }

    // Cada supervisor de turno recibe el resumen de los operadores de su franja horaria.
    for (const supervisor of SHIFT_SUPERVISORS) {
      const supervisorUser = users.find((u) => u.active && u.username.toLowerCase() === supervisor.username);
      if (!supervisorUser) continue;
      const misOperadores = flaggedWorkers.filter(({ user }) => {
        if (user.role !== 'operador') return false;
        const bucket = shiftBucketFor(schedule, user.name);
        return bucket !== null && supervisor.buckets.includes(bucket);
      });
      if (!misOperadores.length) continue;
      const opSummaryLines = misOperadores
        .map(({ user, flags }) => {
          const flagLines = flags.map((f) => `    · ${f.module} (${f.kind}): ${f.detail}`).join('\n');
          return `  ${user.name}:\n${flagLines}`;
        })
        .join('\n');
      const opSummaryText = `📊 Resumen de rendimiento de hoy de tus operadores — ${misOperadores.length} con demoras:\n\n${opSummaryLines}`;
      await sendGabotMessage(redis, supervisorUser.id, opSummaryText);
    }
  }

  return new Response(
    JSON.stringify({ ok: true, sent, totalUsers: users.length, isMorningBriefing, flaggedWorkers: flaggedWorkers.length }),
    { headers: { 'Content-Type': 'application/json' } }
  );
};
