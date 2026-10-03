import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { SESSION_COOKIE, getSession, canManageAiAgents } from '../../lib/auth';
import { todayInColombia, dateInColombia } from '../../lib/colombia-time';
import { readLeads } from './leads';

export const prerender = false;

const DAILY_CONVERSATIONS_KEY_PREFIX = 'internal:agent-conversations-daily:andres:';

export interface CalendarDay {
  date: string;
  atendidos: number; // conversaciones distintas con respuesta de Andrés ese día
  nuevos: number; // leads de WhatsApp/chat web creados ese día
  concretados: number; // entregados a sucursal ese día
  escalados: number;
}

// Calendario mensual de Andrés: por día, cuántas conversaciones atendió, cuántos leads nuevos
// entraron y cuántos concretó (entregó a sucursal). Todo en fecha de Colombia.
export const GET: APIRoute = async ({ cookies, url }) => {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canManageAiAgents(session)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const today = todayInColombia();
  const monthParam = url.searchParams.get('month') || '';
  const month = /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : today.slice(0, 7);
  const [y, m] = month.split('-').map((v) => parseInt(v, 10));
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const dates: string[] = [];
  for (let d = 1; d <= daysInMonth; d++) dates.push(`${month}-${String(d).padStart(2, '0')}`);

  const [leads, attended] = await Promise.all([
    readLeads(redis),
    Promise.all(dates.map((d) => redis.scard(DAILY_CONVERSATIONS_KEY_PREFIX + d))),
  ]);

  const byDate = new Map<string, CalendarDay>();
  dates.forEach((date, i) => byDate.set(date, { date, atendidos: Number(attended[i]) || 0, nuevos: 0, concretados: 0, escalados: 0 }));

  for (const l of leads) {
    if (l.source !== 'whatsapp-ads' && l.source !== 'web-chat') continue;
    const created = byDate.get(dateInColombia(l.createdAt));
    if (created) created.nuevos++;
    if (l.aiHandoffAt) {
      const handed = byDate.get(dateInColombia(l.aiHandoffAt));
      if (handed) {
        if (l.aiStage === 'entregado') handed.concretados++;
        else if (l.aiStage === 'escalado') handed.escalados++;
      }
    }
  }

  const days = dates.map((d) => byDate.get(d)!);
  const totals = days.reduce(
    (acc, d) => {
      acc.atendidos += d.atendidos;
      acc.nuevos += d.nuevos;
      acc.concretados += d.concretados;
      acc.escalados += d.escalados;
      return acc;
    },
    { atendidos: 0, nuevos: 0, concretados: 0, escalados: 0 }
  );
  // Día de la semana del 1.º (0 = domingo) para alinear la cuadrícula.
  const firstWeekday = new Date(`${month}-01T12:00:00Z`).getUTCDay();

  return new Response(JSON.stringify({ month, today, firstWeekday, days, totals }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};
