import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
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

interface Task {
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
}

function computeOverdue(task: Task): boolean {
  if (!task.dueDate) return false;
  if (task.status === 'Completada' || task.status === 'Cancelada') return false;
  return new Date(task.dueDate).getTime() < new Date().setHours(0, 0, 0, 0);
}

async function readTasks(redis: any): Promise<Task[]> {
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
    .map((t) => ({ notes: [], proof: null, ...t }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAssignTasks(session.role)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: { title?: string; description?: string; assigneeId?: string; dueDate?: string | null };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const title = String(body.title || '').trim();
  const description = String(body.description || '').trim();
  const assigneeId = String(body.assigneeId || '').trim();
  if (!title || !assigneeId) {
    return new Response(JSON.stringify({ error: 'título y empleado asignado son obligatorios' }), { status: 400 });
  }

  const assignee = await findUserById(redis, assigneeId);
  if (!assignee || !assignee.active) {
    return new Response(JSON.stringify({ error: 'empleado no encontrado o inactivo' }), { status: 400 });
  }

  const now = new Date().toISOString();
  const task: Task = {
    id: randomUUID(),
    title,
    description,
    assigneeId: assignee.id,
    assigneeName: assignee.name,
    assignedById: session.userId,
    assignedByName: session.username,
    dueDate: body.dueDate ? String(body.dueDate) : null,
    status: 'Pendiente',
    proof: null,
    notes: [],
    createdAt: now,
    updatedAt: now,
  };

  await redis.hset(REDIS_KEY, { [task.id]: JSON.stringify(task) });
  await logAudit(redis, session, 'task_create', task.title, `asignada a ${assignee.username}`);

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
  const task: Task = { notes: [], proof: null, ...(typeof raw === 'string' ? JSON.parse(raw) : raw) };

  const isManager = canAssignTasks(session.role);
  const isOwner = task.assigneeId === session.userId;
  if (!isManager && !isOwner) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) {
      return new Response(JSON.stringify({ error: 'estado inválido' }), { status: 400 });
    }
    if (body.status === 'Completada' && !task.proof) {
      return new Response(
        JSON.stringify({ error: 'adjunta la foto de evidencia antes de marcar la tarea como completada' }),
        { status: 400 }
      );
    }
    task.status = body.status;
  }
  if (body.addNote) {
    task.notes = [{ text: String(body.addNote).trim(), date: new Date().toISOString(), by: session.username }, ...task.notes];
  }
  task.updatedAt = new Date().toISOString();

  await redis.hset(REDIS_KEY, { [id]: JSON.stringify(task) });
  await logAudit(redis, session, 'task_update', task.title, JSON.stringify(body));

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
