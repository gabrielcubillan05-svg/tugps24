import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { SESSION_COOKIE, getSession, canAccessSection } from '../../lib/auth';
import { readLeads, STATUSES } from './leads';

export const prerender = false;

const REPORTS_KEY = 'internal:reports';
const REPORT_CATEGORIES = ['Notificación', 'Salida de geocerca', 'Finalizado', 'Alarma', 'Novedad', 'Monitoreo a', 'Monitoreo en', 'Monitoreo vía', 'Monitoreo retornando', 'Otro'];

interface Report {
  id: string;
  plate: string;
  branch: string;
  category: string;
  createdAt: string;
  createdByName: string;
}

function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item) || 'Sin definir';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

export const GET: APIRoute = async ({ cookies }) => {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessSection(session.role, 'estadisticas')) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const leads = await readLeads(redis);
  const byStatus: Record<string, number> = {};
  for (const s of STATUSES) byStatus[s] = 0;
  for (const l of leads) byStatus[l.status] = (byStatus[l.status] || 0) + 1;

  const byCity = countBy(leads, (l) => l.city);
  const bySecretary = countBy(leads, (l) => l.secretary);
  const installedCount = leads.filter((l) => l.installed).length;
  const verifiedInstalledCount = leads.filter((l) => l.verifiedInstalled).length;
  const now = Date.now();
  const last7DaysCount = leads.filter((l) => now - new Date(l.createdAt).getTime() <= 7 * 24 * 60 * 60 * 1000).length;
  const last30DaysCount = leads.filter((l) => now - new Date(l.createdAt).getTime() <= 30 * 24 * 60 * 60 * 1000).length;

  const rawReports = (await redis.lrange<string>(REPORTS_KEY, 0, -1)) || [];
  const reports: Report[] = rawReports
    .map((r) => {
      try {
        return typeof r === 'string' ? JSON.parse(r) : r;
      } catch {
        return null;
      }
    })
    .filter((r): r is Report => r !== null);

  const reportsByCategory: Record<string, number> = {};
  for (const c of REPORT_CATEGORIES) reportsByCategory[c] = 0;
  for (const r of reports) reportsByCategory[r.category] = (reportsByCategory[r.category] || 0) + 1;

  const reportsByBranch = countBy(reports, (r) => r.branch);
  const reportsByOperator = countBy(reports, (r) => r.createdByName);
  const reportsLast7Days = reports.filter((r) => now - new Date(r.createdAt).getTime() <= 7 * 24 * 60 * 60 * 1000).length;
  const reportsLast30Days = reports.filter((r) => now - new Date(r.createdAt).getTime() <= 30 * 24 * 60 * 60 * 1000).length;

  return new Response(
    JSON.stringify({
      crm: {
        total: leads.length,
        byStatus,
        byCity,
        bySecretary,
        installedCount,
        verifiedInstalledCount,
        last7DaysCount,
        last30DaysCount,
      },
      novedades: {
        total: reports.length,
        byCategory: reportsByCategory,
        byBranch: reportsByBranch,
        byOperator: reportsByOperator,
        last7DaysCount: reportsLast7Days,
        last30DaysCount: reportsLast30Days,
      },
    }),
    { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
  );
};
