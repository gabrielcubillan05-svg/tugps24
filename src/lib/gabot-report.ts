import type { User } from './auth';
import { KELLY_USERNAME, WILMAR_USERNAME } from './auth';
import { OPEN_STATUSES, type Suspension } from '../pages/api/suspensiones';
import type { Solicitud } from '../pages/api/solicitudes-administrativas';
import type { PagoInterno } from '../pages/api/pagos-internos';
import type { Task } from '../pages/api/tasks';
import { computeOverdue as computeTaskOverdue } from '../pages/api/tasks';
import type { Lead } from '../pages/api/leads';
import { computeOverdue as computeLeadOverdue } from '../pages/api/leads';
import type { ClienteMasivo } from '../pages/api/seguimiento-masivos';
import type { Caso } from '../pages/api/casos-importantes';

// Forma que deja withStatus() en scheduled-reports.ts (ScheduledReport + bucket calculado) —
// se referencia como "any" ahí, así que aquí solo pedimos los campos que realmente usamos.
interface ScheduledReportWithStatus {
  client: string;
  reportType: string;
  operator: string;
  bucket: 'pendiente' | 'por-realizar' | 'al-dia';
}

export interface GabotData {
  suspensiones: Suspension[];
  solicitudes: Solicitud[];
  pagos: PagoInterno[];
  tasks: Task[];
  leads: Lead[];
  clientesMasivos: ClienteMasivo[];
  casos: Caso[];
  scheduledReports: ScheduledReportWithStatus[];
}

// Un cliente masivo sin ninguna nota de seguimiento en 14+ días se considera "se está enfriando".
const STALE_MASIVOS_DAYS = 14;

function normalizeNameForMatch(raw: string): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

// El CRM y los Reportes programados guardan el responsable como texto libre (nombre o solo
// el primer nombre, ej. "Yelitza"), no como un id — igual que ya se hace en cobros.ts para el
// reparto manual. Aquí se compara contra el nombre completo del usuario y contra su primer nombre.
function matchesAssigneeName(assignedName: string, user: Pick<User, 'name'>): boolean {
  const a = normalizeNameForMatch(assignedName);
  if (!a) return false;
  const full = normalizeNameForMatch(user.name);
  const first = full.split(/\s+/)[0];
  return a === full || a === first;
}

function fmtDateOnly(value: string | null): string {
  if (!value) return 'sin fecha';
  const iso = value.length <= 10 ? value + 'T00:00:00' : value;
  return new Date(iso).toLocaleDateString('es-CO', { dateStyle: 'medium' });
}

function fmtMoney(n: number): string {
  return '$' + Math.round(n || 0).toLocaleString('es-CO');
}

// Junta, para UN trabajador, todo lo que GaBot debe recordarle en este momento — vacío si no
// tiene nada pendiente en ningún módulo (en ese caso no se le manda nada).
export function collectPendingLines(user: User, data: GabotData): string[] {
  const lines: string[] = [];

  const misSuspensiones = data.suspensiones.filter((c) => c.assignedToId === user.id && OPEN_STATUSES.includes(c.status));
  if (misSuspensiones.length) {
    lines.push(`🚩 Suspensiones abiertas (${misSuspensiones.length}):`);
    for (const c of misSuspensiones) lines.push(`  · ${c.clientName || 'Sin nombre'} (${c.plate}) — ${c.status}`);
  }

  const isKellyOrWilmar = [KELLY_USERNAME, WILMAR_USERNAME].includes(user.username.toLowerCase());
  if (isKellyOrWilmar) {
    const solicitudesPendientes = data.solicitudes.filter((s) => s.status === 'Pendiente');
    if (solicitudesPendientes.length) {
      lines.push(`📋 Solicitudes administrativas pendientes (${solicitudesPendientes.length}):`);
      for (const s of solicitudesPendientes) lines.push(`  · ${s.clientName} — ${s.requestType}`);
    }
  }

  const misPagos = data.pagos.filter((p) => p.assignedToId === user.id && p.status === 'Pendiente');
  if (misPagos.length) {
    lines.push(`💰 Pagos programados pendientes (${misPagos.length}):`);
    for (const p of misPagos) lines.push(`  · ${p.concepto} (${p.proveedor}) — ${fmtMoney(p.monto)} — vence ${fmtDateOnly(p.dueDate)}`);
  }

  const misTareas = data.tasks.filter((t) => t.assigneeId === user.id && t.status !== 'Completada' && t.status !== 'Cancelada');
  if (misTareas.length) {
    lines.push(`✅ Tareas pendientes (${misTareas.length}):`);
    for (const t of misTareas) lines.push(`  · ${t.title}${computeTaskOverdue(t) ? ' — ⚠️ atrasada' : ''}`);
  }

  const misLeads = data.leads.filter((l) => computeLeadOverdue(l) && matchesAssigneeName(l.secretary, user));
  if (misLeads.length) {
    lines.push(`📇 CRM — seguimientos vencidos (${misLeads.length}):`);
    for (const l of misLeads) lines.push(`  · ${l.name} (${l.city}) — seguimiento: ${fmtDateOnly(l.nextFollowUp)}`);
  }

  const misClientes = data.clientesMasivos.filter((c) => {
    if (c.createdById !== user.id) return false;
    return Date.now() - new Date(c.updatedAt).getTime() >= STALE_MASIVOS_DAYS * 24 * 60 * 60 * 1000;
  });
  if (misClientes.length) {
    lines.push(`📦 Seguimiento a clientes masivos sin novedades hace 14+ días (${misClientes.length}):`);
    for (const c of misClientes) lines.push(`  · ${c.clientName} (${c.branch})`);
  }

  const misCasos = data.casos.filter((c) => c.createdById === user.id && c.status !== 'Finalizado');
  if (misCasos.length) {
    lines.push(`⚠️ Casos importantes abiertos (${misCasos.length}):`);
    for (const c of misCasos) lines.push(`  · ${c.plate} (${c.branch}) — ${c.category} — ${c.status}`);
  }

  const misReportes = data.scheduledReports.filter((r) => r.bucket === 'pendiente' && matchesAssigneeName(r.operator, user));
  if (misReportes.length) {
    lines.push(`🗓️ Reportes programados vencidos (${misReportes.length}):`);
    for (const r of misReportes) lines.push(`  · ${r.client} — ${r.reportType}`);
  }

  return lines;
}
