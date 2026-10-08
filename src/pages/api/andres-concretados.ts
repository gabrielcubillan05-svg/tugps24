import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { SESSION_COOKIE, getSession, canManageAiAgents } from '../../lib/auth';
import { todayInColombia } from '../../lib/colombia-time';
import { buildLeadsWorkbook, esConcretadoPorAndres, xlsxResponse } from '../../lib/leads-excel';
import { readLeads } from './leads';

export const prerender = false;

// Excel con todos los leads que Andrés concretó (entregó a sucursal). Mismo criterio que el
// contador "Concretados" del panel de agentes. Pedido por Gabriel el 2026-10-08.
export const GET: APIRoute = async ({ cookies }) => {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canManageAiAgents(session)) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  const redis = getRedis();
  if (!redis) return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  const leads = (await readLeads(redis)).filter(esConcretadoPorAndres).sort((a, b) => String(b.aiHandoffAt || b.createdAt).localeCompare(String(a.aiHandoffAt || a.createdAt)));
  return xlsxResponse(await buildLeadsWorkbook(leads, 'Concretados por Andrés'), `concretados-andres_${todayInColombia()}.xlsx`);
};
