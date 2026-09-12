import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { pushNotification } from '../../lib/notifications';
import {
  SESSION_COOKIE,
  getSession,
  canAssignTasks,
  canManageUsers,
  findUserById,
  verifySameOrigin,
} from '../../lib/auth';

export const prerender = false;

const REDIS_KEY = 'internal:tasks';
export const STATUSES = ['Pendiente', 'En progreso', 'Completada', 'Cancelada'];

interface Note {
  text: string;
  date: string;
  by: string;
}

interface Proof {
  pathname: string;
  contentType: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  assigneeId: string;
  assigneeName: string;
  assignedById: string;
  assignedByName: string;
  dueDate: string | null;
  status: string;
  proof: Proof | null;
  notes: Note[];
  createdAt: string;
  updatedAt: string;
  // Fecha exacta en que se marcó como Completada — separada de updatedAt porque esta última
  // cambia con cualquier edición posterior (una nota agregada después, por ejemplo).
  completedAt: string | null;
  // Si tiene recurrencia, al marcarla Completada se crea automáticamente la siguiente
  // ocurrencia (misma serie, vía recurrenceSeriesId) con la próxima fecha de vencimiento —
  // cada ocurrencia queda como su propia tarea, con su propia evidencia/notas.
  recurrence: 'diaria' | 'semanal' | 'mensual' | null;
  recurrenceSeriesId: string | null;
}

const RECURRENCES = ['diaria', 'semanal', 'mensual'];

function nextDueDateFor(dueDate: string | null, recurrence: string): string | null {
  const base = dueDate ? new Date(dueDate + 'T00:00:00') : new Date();
  if (recurrence === 'diaria') base.setDate(base.getDate() + 1);
  else if (recurrence === 'semanal') base.setDate(base.getDate() + 7);
  else if (recurrence === 'mensual') base.setMonth(base.getMonth() + 1);
  return base.toISOString().slice(0, 10);
}

export function computeOverdue(task: Task): boolean {
  if (!task.dueDate) return false;
  if (task.status === 'Completada' || task.status === 'Cancelada') return false;
  return new Date(task.dueDate).getTime() < new Date().setHours(0, 0, 0, 0);
}

export async function readTasks(redis: any): Promise<Task[]> {
  const raw = (await redis.hgetall<Record<string, string>>(REDIS_KEY)) || {};
  return Object.values(raw)
    .map((v) => {
      try {
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    })
    .filter((t): t is Task => t !== null)
    .map((t) => ({ notes: [], proof: null, completedAt: null, recurrence: null, recurrenceSeriesId: null, ...t }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function spawnNextRecurrence(redis: any, completed: Task): Promise<void> {
  if (!completed.recurrence) return;
  const now = new Date().toISOString();
  const next: Task = {
    id: randomUUID(),
    title: completed.title,
    description: completed.description,
    assigneeId: completed.assigneeId,
    assigneeName: completed.assigneeName,
    assignedById: completed.assignedById,
    assignedByName: completed.assignedByName,
    dueDate: nextDueDateFor(completed.dueDate, completed.recurrence),
    status: 'Pendiente',
    proof: null,
    notes: [],
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    recurrence: completed.recurrence,
    recurrenceSeriesId: completed.recurrenceSeriesId,
  };
  await redis.hset(REDIS_KEY, { [next.id]: JSON.stringify(next) });
  try {
    await pushNotification(redis, next.assigneeId, {
      type: 'task_assigned',
      message: `Nueva tarea recurrente: ${next.title}${next.dueDate ? ` (vence ${next.dueDate})` : ''}`,
      link: '/interno/tareas',
    });
  } catch {
    // no debe tumbar el flujo si falla la notificación
  }
}

export const GET: APIRoute = async ({ cookies, url }) => {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let tasks = await readTasks(redis);
  const isManager = canAssignTasks(session.role);

  if (!isManager) {
    tasks = tasks.filter((t) => t.assigneeId === session.userId);
  } else {
    const assigneeFilter = url.searchParams.get('assigneeId');
    if (assigneeFilter) tasks = tasks.filter((t) => t.assigneeId === assigneeFilter);
  }

  const withOverdue = tasks.map((t) => ({ ...t, overdue: computeOverdue(t) }));

  return new Response(
    JSON.stringify({ tasks: withOverdue, statuses: STATUSES, canAssign: isManager }),
    { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
  );
};

// Compartido entre el POST de abajo (desde el panel) y la herramienta crear_tarea de GPSITO
// (messages.ts) — mismo efecto en ambos casos: crea la tarea y notifica al asignado.
export async function createTask(
  redis: any,
  params: {
    title: string;
    description: string;
    assigneeId: string;
    dueDate: string | null;
    assignedById: string;
    assignedByName: string;
    recurrence?: string | null;
  }
): Promise<{ task: Task } | { error: string }> {
  const title = params.title.trim();
  if (!title || !params.assigneeId) {
    return { error: 'título y empleado asignado son obligatorios' };
  }
  const assignee = await findUserById(redis, params.assigneeId);
  if (!assignee || !assignee.active) {
    return { error: 'empleado no encontrado o inactivo' };
  }
  const recurrence = params.recurrence && RECURRENCES.includes(params.recurrence) ? (params.recurrence as Task['recurrence']) : null;

  const now = new Date().toISOString();
  const task: Task = {
    id: randomUUID(),
    title,
    description: params.description.trim(),
    assigneeId: assignee.id,
    assigneeName: assignee.name,
    assignedById: params.assignedById,
    assignedByName: params.assignedByName,
    dueDate: params.dueDate,
    status: 'Pendiente',
    proof: null,
    notes: [],
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    recurrence,
    recurrenceSeriesId: recurrence ? randomUUID() : null,
  };

  await redis.hset(REDIS_KEY, { [task.id]: JSON.stringify(task) });
  await pushNotification(redis, assignee.id, {
    type: 'task_assigned',
    message: `Se te asignó la tarea: ${task.title}`,
    link: '/interno/tareas',
  });

  return { task };
}

// Usadas por la herramienta de GPSITO (messages.ts) para que un trabajador pueda marcar SU
// PROPIA tarea como completada o agregarle una nota, sin pasar por el panel. La foto de
// evidencia es opcional (se puede adjuntar en cualquier momento), no obligatoria para completar.
export async function markTaskStatus(redis: any, taskId: string, status: string): Promise<{ task: Task } | { error: string }> {
  const raw = await redis.hget<string>(REDIS_KEY, taskId);
  if (!raw) return { error: 'tarea no encontrada' };
  const task: Task = { notes: [], proof: null, completedAt: null, recurrence: null, recurrenceSeriesId: null, ...(typeof raw === 'string' ? JSON.parse(raw) : raw) };
  if (!STATUSES.includes(status)) return { error: 'estado inválido' };
  if (status === 'Completada') task.completedAt = new Date().toISOString();
  else if (task.status === 'Completada') task.completedAt = null;
  task.status = status;
  task.updatedAt = new Date().toISOString();
  await redis.hset(REDIS_KEY, { [taskId]: JSON.stringify(task) });
  if (status === 'Completada') await spawnNextRecurrence(redis, task);
  return { task };
}

export async function addTaskNote(redis: any, taskId: string, noteText: string, byName: string): Promise<{ task: Task } | { error: string }> {
  const raw = await redis.hget<string>(REDIS_KEY, taskId);
  if (!raw) return { error: 'tarea no encontrada' };
  const task: Task = { notes: [], proof: null, completedAt: null, recurrence: null, recurrenceSeriesId: null, ...(typeof raw === 'string' ? JSON.parse(raw) : raw) };
  task.notes = [{ text: noteText, date: new Date().toISOString(), by: byName }, ...task.notes];
  task.updatedAt = new Date().toISOString();
  await redis.hset(REDIS_KEY, { [taskId]: JSON.stringify(task) });
  return { task };
}

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: { title?: string; description?: string; assigneeId?: string; dueDate?: string | null; recurrence?: string | null };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  // Cualquiera puede crearse una tarea a sí mismo; solo quien puede asignar tareas
  // (supervisor/gerente/admin) puede dársela a alguien más.
  const assigneeId = String(body.assigneeId || '').trim() || session.userId;
  if (assigneeId !== session.userId && !canAssignTasks(session.role)) {
    return new Response(JSON.stringify({ error: 'solo puedes crear tareas para ti mismo' }), { status: 401 });
  }

  const result = await createTask(redis, {
    title: String(body.title || ''),
    description: String(body.description || ''),
    assigneeId,
    dueDate: body.dueDate ? String(body.dueDate) : null,
    assignedById: session.userId,
    assignedByName: session.username,
    recurrence: body.recurrence || null,
  });
  if ('error' in result) {
    return new Response(JSON.stringify({ error: result.error }), { status: 400 });
  }
  const { task } = result;

  await logAudit(redis, session, 'task_create', task.title, `asignada a ${task.assigneeName}`);

  return new Response(JSON.stringify({ task: { ...task, overdue: computeOverdue(task) } }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const PATCH: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: { id?: string; status?: string; addNote?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const id = String(body.id || '');
  const raw = await redis.hget<string>(REDIS_KEY, id);
  if (!raw) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }
  const task: Task = { notes: [], proof: null, completedAt: null, recurrence: null, recurrenceSeriesId: null, ...(typeof raw === 'string' ? JSON.parse(raw) : raw) };

  const isManager = canAssignTasks(session.role);
  const isOwner = task.assigneeId === session.userId;
  if (!isManager && !isOwner) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  let justCompleted = false;
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) {
      return new Response(JSON.stringify({ error: 'estado inválido' }), { status: 400 });
    }
    if (body.status === 'Completada') {
      task.completedAt = new Date().toISOString();
      justCompleted = true;
    } else if (task.status === 'Completada') {
      // Se está sacando de Completada (reabierta) — limpia la fecha para que no quede una
      // marca de "completada" vieja en una tarea que ya no lo está.
      task.completedAt = null;
    }
    task.status = body.status;
  }
  if (body.addNote) {
    task.notes = [{ text: String(body.addNote).trim(), date: new Date().toISOString(), by: session.username }, ...task.notes];
  }
  task.updatedAt = new Date().toISOString();

  await redis.hset(REDIS_KEY, { [id]: JSON.stringify(task) });
  await logAudit(redis, session, 'task_update', task.title, JSON.stringify(body));
  if (justCompleted) await spawnNextRecurrence(redis, task);

  return new Response(JSON.stringify({ task: { ...task, overdue: computeOverdue(task) } }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canManageUsers(session.role)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: { id?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  await redis.hdel(REDIS_KEY, String(body.id || ''));
  await logAudit(redis, session, 'task_delete', String(body.id || ''));
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
