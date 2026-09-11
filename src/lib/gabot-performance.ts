import type { User } from './auth';
import { KELLY_USERNAME, WILMAR_USERNAME } from './auth';
import { OPEN_STATUSES } from '../pages/api/suspensiones';
import { computeOverdue as computeTaskOverdue } from '../pages/api/tasks';
import { computeOverdue as computeLeadOverdue } from '../pages/api/leads';
import type { GabotData } from './gabot-report';

// Umbrales de rendimiento por módulo — ajustables aquí mismo si con el uso real resultan muy
// estrictos o muy laxos. "count" = cuántos pendientes acumulados disparan la alerta de volumen.
// "speedDays" = promedio máximo aceptable (en días) antes de disparar la alerta de velocidad,
// medido contra lo cerrado en los últimos RECENT_WINDOW_DAYS días (o, en CRM, contra el atraso
// actual de lo que sigue abierto, ya que ahí no hay un cierre único que medir).
const RECENT_WINDOW_DAYS = 30;
const THRESHOLDS = {
  suspensiones: { count: 3, speedDays: 3 },
  solicitudes: { count: 5, speedDays: 2 },
  pagos: { count: 3, speedDays: 2 },
  tareas: { count: 3, speedDays: 3 },
  crm: { count: 3, speedDays: 3 },
  casos: { count: 2, speedDays: 5 },
  clientesMasivos: { count: 2 },
  reportes: { count: 2 },
};

export interface PerformanceFlag {
  module: string;
  kind: 'volumen' | 'velocidad';
  detail: string;
}

function normalizeNameForMatch(raw: string): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

function matchesAssigneeName(assignedName: string, user: Pick<User, 'name'>): boolean {
  const a = normalizeNameForMatch(assignedName);
  if (!a) return false;
  const full = normalizeNameForMatch(user.name);
  return a === full || a === full.split(/\s+/)[0];
}

function daysBetween(startIso: string, endIso: string): number {
  return (new Date(endIso).getTime() - new Date(startIso).getTime()) / 86400000;
}

function avgDays(pairs: Array<{ start: string; end: string }>): number | null {
  if (!pairs.length) return null;
  const total = pairs.reduce((sum, p) => sum + daysBetween(p.start, p.end), 0);
  return total / pairs.length;
}

function isRecent(iso: string | null, windowDays: number): boolean {
  if (!iso) return false;
  return Date.now() - new Date(iso).getTime() <= windowDays * 24 * 60 * 60 * 1000;
}

function fmt1(n: number): string {
  return n.toFixed(1);
}

export function computePerformanceFlags(user: User, data: GabotData): PerformanceFlag[] {
  const flags: PerformanceFlag[] = [];

  // --- Suspensiones ---
  const misSuspensionesAbiertas = data.suspensiones.filter((c) => c.assignedToId === user.id && OPEN_STATUSES.includes(c.status));
  if (misSuspensionesAbiertas.length >= THRESHOLDS.suspensiones.count) {
    flags.push({ module: 'Suspensiones', kind: 'volumen', detail: `${misSuspensionesAbiertas.length} casos abiertos (umbral: ${THRESHOLDS.suspensiones.count})` });
  }
  const suspensionesResueltas = data.suspensiones.filter(
    (c) => c.assignedToId === user.id && c.resolvedAt && isRecent(c.resolvedAt, RECENT_WINDOW_DAYS)
  );
  const avgSuspensiones = avgDays(suspensionesResueltas.map((c) => ({ start: c.createdAt, end: c.resolvedAt as string })));
  if (avgSuspensiones !== null && avgSuspensiones > THRESHOLDS.suspensiones.speedDays) {
    flags.push({ module: 'Suspensiones', kind: 'velocidad', detail: `promedio de ${fmt1(avgSuspensiones)} días para resolver (umbral: ${THRESHOLDS.suspensiones.speedDays} días)` });
  }

  // --- Solicitudes administrativas (cola compartida de Kelly/Wilmar) ---
  const isKellyOrWilmar = [KELLY_USERNAME, WILMAR_USERNAME].includes(user.username.toLowerCase());
  if (isKellyOrWilmar) {
    const pendientes = data.solicitudes.filter((s) => s.status === 'Pendiente');
    if (pendientes.length >= THRESHOLDS.solicitudes.count) {
      flags.push({ module: 'Solicitudes administrativas', kind: 'volumen', detail: `${pendientes.length} pendientes en la cola (umbral: ${THRESHOLDS.solicitudes.count})` });
    }
  }
  const solicitudesResueltasPorMi = data.solicitudes.filter(
    (s) => s.status !== 'Pendiente' && s.resolvedAt && isRecent(s.resolvedAt, RECENT_WINDOW_DAYS) && matchesAssigneeName(s.resolvedByName, user)
  );
  const avgSolicitudes = avgDays(solicitudesResueltasPorMi.map((s) => ({ start: s.createdAt, end: s.resolvedAt as string })));
  if (avgSolicitudes !== null && avgSolicitudes > THRESHOLDS.solicitudes.speedDays) {
    flags.push({ module: 'Solicitudes administrativas', kind: 'velocidad', detail: `promedio de ${fmt1(avgSolicitudes)} días para resolver lo suyo (umbral: ${THRESHOLDS.solicitudes.speedDays} días)` });
  }

  // --- Pagos programados ---
  const today0 = new Date().setHours(0, 0, 0, 0);
  const misPagosVencidos = data.pagos.filter(
    (p) => p.assignedToId === user.id && p.status === 'Pendiente' && new Date(p.dueDate).getTime() < today0
  );
  if (misPagosVencidos.length >= THRESHOLDS.pagos.count) {
    flags.push({ module: 'Pagos programados', kind: 'volumen', detail: `${misPagosVencidos.length} vencidos sin pagar (umbral: ${THRESHOLDS.pagos.count})` });
  }
  const pagosPagados = data.pagos.filter((p) => p.assignedToId === user.id && p.paidAt && isRecent(p.paidAt, RECENT_WINDOW_DAYS));
  const diasAtrasoPago = pagosPagados
    .map((p) => daysBetween(p.dueDate, p.paidAt as string))
    .filter((d) => d > 0);
  const avgAtrasoPago = diasAtrasoPago.length ? diasAtrasoPago.reduce((a, b) => a + b, 0) / diasAtrasoPago.length : null;
  if (avgAtrasoPago !== null && avgAtrasoPago > THRESHOLDS.pagos.speedDays) {
    flags.push({ module: 'Pagos programados', kind: 'velocidad', detail: `promedio de ${fmt1(avgAtrasoPago)} días de atraso al pagar (umbral: ${THRESHOLDS.pagos.speedDays} días)` });
  }

  // --- Tareas ---
  const misTareasAtrasadas = data.tasks.filter((t) => t.assigneeId === user.id && computeTaskOverdue(t));
  if (misTareasAtrasadas.length >= THRESHOLDS.tareas.count) {
    flags.push({ module: 'Tareas', kind: 'volumen', detail: `${misTareasAtrasadas.length} atrasadas (umbral: ${THRESHOLDS.tareas.count})` });
  }
  const tareasCompletadas = data.tasks.filter((t) => t.assigneeId === user.id && t.completedAt && isRecent(t.completedAt, RECENT_WINDOW_DAYS));
  const avgTareas = avgDays(tareasCompletadas.map((t) => ({ start: t.createdAt, end: t.completedAt as string })));
  if (avgTareas !== null && avgTareas > THRESHOLDS.tareas.speedDays) {
    flags.push({ module: 'Tareas', kind: 'velocidad', detail: `promedio de ${fmt1(avgTareas)} días para completarlas (umbral: ${THRESHOLDS.tareas.speedDays} días)` });
  }

  // --- CRM ---
  const misLeadsVencidos = data.leads.filter((l) => computeLeadOverdue(l) && matchesAssigneeName(l.secretary, user));
  if (misLeadsVencidos.length >= THRESHOLDS.crm.count) {
    flags.push({ module: 'CRM', kind: 'volumen', detail: `${misLeadsVencidos.length} seguimientos vencidos (umbral: ${THRESHOLDS.crm.count})` });
  }
  const diasAtrasoLeads = misLeadsVencidos
    .filter((l) => l.nextFollowUp)
    .map((l) => (Date.now() - new Date(l.nextFollowUp as string).getTime()) / 86400000);
  const avgAtrasoLeads = diasAtrasoLeads.length ? diasAtrasoLeads.reduce((a, b) => a + b, 0) / diasAtrasoLeads.length : null;
  if (avgAtrasoLeads !== null && avgAtrasoLeads > THRESHOLDS.crm.speedDays) {
    flags.push({ module: 'CRM', kind: 'velocidad', detail: `promedio de ${fmt1(avgAtrasoLeads)} días de atraso en los seguimientos vencidos (umbral: ${THRESHOLDS.crm.speedDays} días)` });
  }

  // --- Casos importantes ---
  const misCasosAbiertos = data.casos.filter((c) => c.createdById === user.id && c.status !== 'Finalizado');
  if (misCasosAbiertos.length >= THRESHOLDS.casos.count) {
    flags.push({ module: 'Casos importantes', kind: 'volumen', detail: `${misCasosAbiertos.length} abiertos (umbral: ${THRESHOLDS.casos.count})` });
  }
  const casosFinalizados = data.casos.filter((c) => c.createdById === user.id && c.finalizedAt && isRecent(c.finalizedAt, RECENT_WINDOW_DAYS));
  const avgCasos = avgDays(casosFinalizados.map((c) => ({ start: c.createdAt, end: c.finalizedAt as string })));
  if (avgCasos !== null && avgCasos > THRESHOLDS.casos.speedDays) {
    flags.push({ module: 'Casos importantes', kind: 'velocidad', detail: `promedio de ${fmt1(avgCasos)} días para cerrarlos (umbral: ${THRESHOLDS.casos.speedDays} días)` });
  }

  // --- Seguimiento a clientes masivos (solo volumen — no hay un "cierre" que medir) ---
  const misClientesFrios = data.clientesMasivos.filter(
    (c) => c.createdById === user.id && Date.now() - new Date(c.updatedAt).getTime() >= 14 * 24 * 60 * 60 * 1000
  );
  if (misClientesFrios.length >= THRESHOLDS.clientesMasivos.count) {
    flags.push({ module: 'Seguimiento a clientes masivos', kind: 'volumen', detail: `${misClientesFrios.length} sin novedades hace 14+ días (umbral: ${THRESHOLDS.clientesMasivos.count})` });
  }

  // --- Reportes programados (solo volumen — son recurrentes, no de un solo cierre) ---
  const misReportesVencidos = data.scheduledReports.filter((r) => r.bucket === 'pendiente' && matchesAssigneeName(r.operator, user));
  if (misReportesVencidos.length >= THRESHOLDS.reportes.count) {
    flags.push({ module: 'Reportes programados', kind: 'volumen', detail: `${misReportesVencidos.length} vencidos (umbral: ${THRESHOLDS.reportes.count})` });
  }

  return flags;
}
