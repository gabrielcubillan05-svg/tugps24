import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, canVerifyInstalls, verifySameOrigin } from '../../lib/auth';
import { todayInColombia } from '../../lib/colombia-time';
import { buildLeadsWorkbook, xlsxResponse } from '../../lib/leads-excel';
import { readLeads } from './leads';

export const prerender = false;

// Exportación del CRM a Excel. El navegador manda los ids de los leads que tiene filtrados en
// pantalla (el filtro vive allá) y aquí se arma el .xlsx; queda en auditoría quién exportó
// cuántos y con qué filtros.
export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canVerifyInstalls(session.role)) {
    return new Response(JSON.stringify({ error: 'solo supervisor, gerente o administrador pueden exportar' }), { status: 403 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }
  let body: { ids?: unknown; filters?: string };
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const ids = Array.isArray(body.ids) ? new Set(body.ids.map((x) => String(x))) : null;
  const all = await readLeads(redis);
  const leads = ids ? all.filter((l) => ids.has(l.id)) : all;
  await logAudit(redis, session, 'leads_export', `${leads.length} leads`, String(body.filters || '').slice(0, 200));
  return xlsxResponse(await buildLeadsWorkbook(leads, 'Leads'), `leads-tugps24_${todayInColombia()}.xlsx`);
};
