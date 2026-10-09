import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { SESSION_COOKIE, getSession, canManageAiAgents } from '../../lib/auth';
import { todayInColombia, dateInColombia } from '../../lib/colombia-time';
import { readLeads, type Lead } from './leads';
import { branchForCityName } from '../../lib/pricing';
import { BRANCHES } from '../../lib/auth';
import { getCostConfig, computeCost } from '../../lib/agent-usage';

export const prerender = false;

const DAILY_CONVERSATIONS_KEY_PREFIX = 'internal:agent-conversations-daily:andres:';
const DAILY_USAGE_KEY_PREFIX = 'internal:agent-usage-daily:andres:';

export interface CalendarDay {
  date: string;
  atendidos: number; // conversaciones distintas con respuesta de Andrés ese día
  nuevos: number; // leads de WhatsApp/chat web creados ese día
  concretados: number; // entregados a sucursal ese día
  instalados: number; // leads de Andrés marcados como instalados ese día (la conversión real)
  escalados: number;
  usd: number; // gasto en Anthropic ese día, con los precios configurados en el menú de IA
  cop: number;
}

export const NO_BRANCH = 'sin-sucursal';

// Sucursal que atiende al lead: la que confirmó Andrés, o la que se deduce de la ciudad.
export function leadBranch(l: Lead): string | null {
  return l.convertedBranch || branchForCityName(l.city) || null;
}

// Calendario mensual de Andrés: por día, cuántas conversaciones atendió, cuántos leads nuevos
// entraron y cuántos concretó (entregó a sucursal). Todo en fecha de Colombia. Con ?branch=
// se filtra por sucursal (o "sin-sucursal" para leads que aún no dijeron ciudad); el gasto en
// Anthropic no se reparte por sucursal, así que con filtro no se muestra.
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

  const branchParam = url.searchParams.get('branch') || '';
  const branch = branchParam === NO_BRANCH || BRANCHES.includes(branchParam) ? branchParam : '';
  const matchesBranch = (l: Lead) => !branch || (branch === NO_BRANCH ? !leadBranch(l) : leadBranch(l) === branch);

  const [allLeads, attendedRaw, usageRaw, costConfig] = await Promise.all([
    readLeads(redis),
    // Sin filtro basta el tamaño del conjunto; con filtro hay que ver qué leads son.
    Promise.all(dates.map((d) => (branch ? redis.smembers(DAILY_CONVERSATIONS_KEY_PREFIX + d) : redis.scard(DAILY_CONVERSATIONS_KEY_PREFIX + d)))),
    Promise.all(dates.map((d) => redis.hgetall<Record<string, string | number>>(DAILY_USAGE_KEY_PREFIX + d))),
    getCostConfig(redis),
  ]);

  const leadById = new Map(allLeads.map((l) => [l.id, l]));
  const leads = allLeads.filter(matchesBranch);
  // Cada miembro del conjunto diario es "canal:idLead".
  const attended = attendedRaw.map((v) => {
    if (!branch) return Number(v) || 0;
    const members = Array.isArray(v) ? v : [];
    return members.filter((m) => {
      const id = String(m).slice(String(m).indexOf(':') + 1);
      const l = leadById.get(id);
      return !!l && matchesBranch(l);
    }).length;
  });

  const byDate = new Map<string, CalendarDay>();
  dates.forEach((date, i) => {
    const u = branch ? {} : usageRaw[i] || {};
    const cost = computeCost(
      {
        inputTokens: Number(u.inputTokens) || 0,
        outputTokens: Number(u.outputTokens) || 0,
        cacheReadTokens: Number(u.cacheReadTokens) || 0,
        cacheCreationTokens: Number(u.cacheCreationTokens) || 0,
        calls: Number(u.calls) || 0,
        conversations: { whatsapp: 0, web: 0, panel: 0 },
      },
      costConfig
    );
    byDate.set(date, { date, atendidos: Number(attended[i]) || 0, nuevos: 0, concretados: 0, instalados: 0, escalados: 0, usd: cost.usd, cop: cost.cop });
  });

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
    // La fecha es la de la marca "Instalado" que pone la secretaria en el CRM; los leads
    // marcados antes de que existiera installedAt caen a su última actualización, como en el CRM.
    const installedAt = l.installedAt || l.verifiedInstalledAt || (l.installed ? l.updatedAt : null);
    if (installedAt && (l.installed || l.verifiedInstalled)) {
      const inst = byDate.get(dateInColombia(installedAt));
      if (inst) inst.instalados++;
    }
  }

  const days = dates.map((d) => byDate.get(d)!);
  const totals = days.reduce(
    (acc, d) => {
      acc.atendidos += d.atendidos;
      acc.nuevos += d.nuevos;
      acc.concretados += d.concretados;
      acc.instalados += d.instalados;
      acc.escalados += d.escalados;
      acc.usd += d.usd;
      acc.cop += d.cop;
      return acc;
    },
    { atendidos: 0, nuevos: 0, concretados: 0, instalados: 0, escalados: 0, usd: 0, cop: 0 }
  );
  // Día de la semana del 1.º (0 = domingo) para alinear la cuadrícula.
  const firstWeekday = new Date(`${month}-01T12:00:00Z`).getUTCDay();

  return new Response(JSON.stringify({ month, today, firstWeekday, days, totals, branch, branches: BRANCHES.filter((b) => b !== 'Central de Monitoreo') }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};
