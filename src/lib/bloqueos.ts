import { findUserById, branchesOf, type Session } from './auth';
import { todayInColombia, dateInColombia, addDaysToDateString } from './colombia-time';
import { readTasks, computeOverdue } from '../pages/api/tasks';
import { REDIS_KEY as LEADS_KEY } from '../pages/api/leads';

// Leads que Andrés concretó y nadie ha confirmado: un set pequeño para no leer todos los leads
// en cada página vista. Se limpia solo al consultarlo (lead confirmado, devuelto a la IA o borrado).
export const LEADS_POR_CONFIRMAR_KEY = 'internal:leads-por-confirmar';
const LEAD_BLOQUEO_MS = 60 * 60_000;
// Días que una tarea puede estar vencida antes del bloqueo fuerte (pedido de Gabriel, 2026-10-17).
const DIAS_GRACIA = 2;
// Con tareas vencidas hace más de DIAS_GRACIA días solo se puede entrar aquí: Tareas para
// resolverlas, Chat para hablar con GPSITO y Novedades porque los operadores no pueden dejar de
// reportar en turno.
export const RUTAS_PERMITIDAS_TAREAS = ['/interno/tareas', '/interno/chat', '/interno/novedades', '/interno/novedades-archivadas'];

export interface LeadPorConfirmar {
  id: string;
  name: string;
  phone: string;
  city: string;
  resumen: string;
  handoffAt: string;
  bloquea: boolean;
}

export interface TareaVencida {
  id: string;
  title: string;
  dueDate: string;
  assignedByName: string;
  diasVencida: number;
  respondidaHoy: boolean;
  bloqueaFuerte: boolean;
}

export interface EstadoBloqueo {
  leads: LeadPorConfirmar[];
  bloqueoLead: boolean;
  tareas: TareaVencida[];
  bloqueoTareas: boolean;
  tareasSinResponder: number;
}

const VACIO: EstadoBloqueo = { leads: [], bloqueoLead: false, tareas: [], bloqueoTareas: false, tareasSinResponder: 0 };

export async function marcarLeadPorConfirmar(redis: any, leadId: string): Promise<void> {
  await redis.sadd(LEADS_POR_CONFIRMAR_KEY, leadId);
}

export async function quitarLeadPorConfirmar(redis: any, leadId: string): Promise<void> {
  await redis.srem(LEADS_POR_CONFIRMAR_KEY, leadId);
}

function diasEntre(desde: string, hasta: string): number {
  const a = Date.UTC(+desde.slice(0, 4), +desde.slice(5, 7) - 1, +desde.slice(8, 10));
  const b = Date.UTC(+hasta.slice(0, 4), +hasta.slice(5, 7) - 1, +hasta.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

async function leadsDeSucursal(redis: any, branches: string[]): Promise<LeadPorConfirmar[]> {
  const ids = ((await redis.smembers(LEADS_POR_CONFIRMAR_KEY)) || []) as string[];
  if (!ids.length) return [];
  const raws = await redis.hmget(LEADS_KEY, ...ids);
  const valores: unknown[] = Array.isArray(raws) ? raws : ids.map((id) => (raws ? (raws as Record<string, unknown>)[id] : null));
  const out: LeadPorConfirmar[] = [];
  const viejos: string[] = [];
  ids.forEach((id, i) => {
    const raw = valores[i];
    let lead: any = null;
    try {
      lead = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
    } catch {
      lead = null;
    }
    if (!lead || lead.aiStage !== 'entregado' || lead.managerAckAt || !lead.aiHandoffAt) {
      viejos.push(id);
      return;
    }
    const branch = lead.convertedBranch || lead.city;
    if (!branch || !branches.includes(branch)) return;
    const nota = (lead.notes || []).find((n: any) => typeof n?.text === 'string' && n.text.startsWith('[Agente IA'));
    out.push({
      id,
      name: String(lead.name || 'Sin nombre'),
      phone: String(lead.phone || ''),
      city: String(lead.city || ''),
      resumen: nota ? String(nota.text).replace(/^\[Agente IA[^\]]*\]\s*/, '') : '',
      handoffAt: lead.aiHandoffAt,
      bloquea: Date.now() - Date.parse(lead.aiHandoffAt) >= LEAD_BLOQUEO_MS,
    });
  });
  if (viejos.length) await redis.srem(LEADS_POR_CONFIRMAR_KEY, ...viejos).catch(() => {});
  return out.sort((a, b) => a.handoffAt.localeCompare(b.handoffAt));
}

export async function getEstadoBloqueo(redis: any, session: Session): Promise<EstadoBloqueo> {
  if (session.role === 'admin') return VACIO;
  const user = await findUserById(redis, session.userId);
  if (!user) return VACIO;

  const leads = session.role === 'secretaria' || session.role === 'gerente' ? await leadsDeSucursal(redis, branchesOf(user)) : [];

  const hoy = todayInColombia();
  const tareas: TareaVencida[] = (await readTasks(redis))
    .filter((t) => t.assigneeId === session.userId && computeOverdue(t))
    .map((t) => {
      const due = String(t.dueDate).slice(0, 10);
      return {
        id: t.id,
        title: t.title,
        dueDate: due,
        assignedByName: t.assignedByName,
        diasVencida: diasEntre(due, hoy),
        respondidaHoy: (t.notes || []).some((n) => (n.by === session.username || n.by === user.name) && dateInColombia(n.date) === hoy),
        bloqueaFuerte: addDaysToDateString(due, DIAS_GRACIA) < hoy,
      };
    })
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  return {
    leads,
    bloqueoLead: leads.some((l) => l.bloquea),
    tareas,
    bloqueoTareas: tareas.some((t) => t.bloqueaFuerte),
    tareasSinResponder: tareas.filter((t) => !t.respondidaHoy).length,
  };
}

// Adónde mandar una página del panel según el bloqueo; null si puede verla.
export function redireccionPorBloqueo(estado: EstadoBloqueo, path: string): string | null {
  const ruta = path.replace(/\/+$/, '') || '/';
  if (estado.bloqueoLead) return ruta === '/interno/crm' ? null : '/interno/crm';
  if (estado.bloqueoTareas && !RUTAS_PERMITIDAS_TAREAS.includes(ruta)) return '/interno/tareas';
  return null;
}
