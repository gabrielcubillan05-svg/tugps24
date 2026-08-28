import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { SESSION_COOKIE, getSession, canAccessSection } from '../../lib/auth';
import { readLeads, STATUSES } from './leads';

export const prerender = false;

const REPORTS_KEY = 'internal:reports';
const REPORTS_CHUNK_SIZE = 1000;
const REPORTS_MAX_SCAN = 10000;
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

const AGE_DAY_THRESHOLDS = [1, 3, 5, 7, 10, 14, 21, 30];
const DAY_MS = 24 * 60 * 60 * 1000;

// Cuándo se instaló un lead, en el sentido más preciso disponible: la fecha exacta si
// existe (installedAt, guardada desde que se agregó este campo), o la última edición
// como aproximación para instalaciones marcadas antes de eso.
function effectiveInstalledAt(lead: { installed: boolean; installedAt: string | null; updatedAt: string }) {
  if (!lead.installed) return null;
  return lead.installedAt || lead.updatedAt;
}

function conversionByAge(leads: { createdAt: string; installed: boolean; installedAt: string | null; updatedAt: string }[]) {
  const nowMs = Date.now();
  return AGE_DAY_THRESHOLDS.map((days) => {
    const cutoffMs = days * DAY_MS;
    let eligible = 0;
    let converted = 0;
    for (const l of leads) {
      const ageMs = nowMs - new Date(l.createdAt).getTime();
      if (ageMs < cutoffMs) continue; // aún no cumple esa edad, no cuenta en este punto de la curva
      eligible++;
      const installedAt = effectiveInstalledAt(l);
      if (installedAt) {
        const daysToInstall = (new Date(installedAt).getTime() - new Date(l.createdAt).getTime()) / DAY_MS;
        if (daysToInstall <= days) converted++;
      }
    }
    return { day: days, eligible, converted, rate: eligible ? Math.round((converted / eligible) * 1000) / 10 : 0 };
  });
}

function conversionRanking<T>(items: T[], keyFn: (item: T) => string, installedFn: (item: T) => boolean) {
  const groups: Record<string, { total: number; installed: number }> = {};
  for (const item of items) {
    const key = keyFn(item) || 'Sin definir';
    const g = groups[key] || (groups[key] = { total: 0, installed: 0 });
    g.total++;
    if (installedFn(item)) g.installed++;
  }
  return Object.entries(groups)
    .map(([name, g]) => ({
      name,
      total: g.total,
      installed: g.installed,
      rate: g.total ? Math.round((g.installed / g.total) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.rate - a.rate || b.total - a.total);
}

export const GET: APIRoute = async ({ cookies, url }) => {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessSection(session.role, 'estadisticas')) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const cityFilter = url.searchParams.get('city') || '';
  const secretaryFilter = url.searchParams.get('secretary') || '';

  const allLeads = await readLeads(redis);
  const cities = [...new Set(allLeads.map((l) => l.city).filter(Boolean))].sort();
  const secretaries = [...new Set(allLeads.map((l) => l.secretary).filter(Boolean))].sort();

  const leads = allLeads.filter((l) => {
    if (cityFilter && l.city !== cityFilter) return false;
    if (secretaryFilter && l.secretary !== secretaryFilter) return false;
    return true;
  });

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

  // Pedir el historial completo de novedades (~30.000) de un solo golpe rompía la
  // respuesta contra Upstash por tamaño (límite de 10MB por pedido). Se trae en
  // bloques hasta un tope de las más recientes en vez de todo de una vez.
  const reportsTotal = await redis.llen(REPORTS_KEY);
  let rawReports: string[] = [];
  {
    let offset = 0;
    while (offset < REPORTS_MAX_SCAN) {
      const chunk = (await redis.lrange<string>(REPORTS_KEY, offset, offset + REPORTS_CHUNK_SIZE - 1)) || [];
      if (!chunk.length) break;
      rawReports = rawReports.concat(chunk);
      offset += chunk.length;
      if (chunk.length < REPORTS_CHUNK_SIZE) break;
    }
  }
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

  const conversionRate = leads.length ? Math.round((installedCount / leads.length) * 1000) / 10 : 0;
  const verifiedConversionRate = leads.length ? Math.round((verifiedInstalledCount / leads.length) * 1000) / 10 : 0;

  const cityRanking = conversionRanking(leads, (l) => l.city, (l) => l.installed);
  const secretaryRanking = conversionRanking(leads, (l) => l.secretary, (l) => l.installed);

  const ageCurve = conversionByAge(leads);
  const approxInstallDatesCount = leads.filter((l) => l.installed && !l.installedAt).length;
  const matureStep = ageCurve[ageCurve.length - 1];
  const openLeadsCount = leads.filter((l) => !l.installed && l.status !== 'Perdido').length;
  const projectedAdditionalInstalls = matureStep.eligible ? Math.round(openLeadsCount * (matureStep.rate / 100)) : null;
  const projectedTotalInstalls = projectedAdditionalInstalls !== null ? installedCount + projectedAdditionalInstalls : null;

  return new Response(
    JSON.stringify({
      crm: {
        total: leads.length,
        byStatus,
        byCity,
        bySecretary,
        installedCount,
        verifiedInstalledCount,
        conversionRate,
        verifiedConversionRate,
        last7DaysCount,
        last30DaysCount,
        cities,
        secretaries,
        cityRanking,
        secretaryRanking,
        ageCurve,
        approxInstallDatesCount,
        openLeadsCount,
        projectedAdditionalInstalls,
        projectedTotalInstalls,
        filters: { city: cityFilter, secretary: secretaryFilter },
      },
      novedades: {
        total: reportsTotal,
        scannedCount: reports.length,
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
