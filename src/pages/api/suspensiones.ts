import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { pushNotification } from '../../lib/notifications';
import {
  SESSION_COOKIE,
  getSession,
  canAccessSuspensiones,
  findUserById,
  findUserByUsername,
  getUsers,
  JOSUE_USERNAME,
  WILMAR_USERNAME,
  verifySameOrigin,
} from '../../lib/auth';

export const prerender = false;

const REDIS_KEY = 'internal:suspensiones';
export const BRANCHES = ['Riohacha', 'Valledupar', 'Santa Marta', 'Maicao', 'Atlántico', 'Bucaramanga', 'Medellín', 'Montería'];
export const STATUSES = ['Nuevo', 'En revisión', 'Escalado a Josué', 'En tesorería', 'Resuelto', 'Suspendido'];
const OPEN_STATUSES = ['Nuevo', 'En revisión', 'Escalado a Josué', 'En tesorería'];

interface TimelineEvent {
  id: string;
  type: string;
  message: string;
  authorName: string;
  date: string;
}

interface Suspension {
  id: string;
  clientName: string;
  clientPhone: string;
  branch: string;
  reason: string;
  status: string;
  assignedToId: string;
  assignedToName: string;
  branchAssigneeId: string;
  branchAssigneeName: string;
  timeline: TimelineEvent[];
  createdAt: string;
  updatedAt: string;
  createdById: string;
  createdByName: string;
}

async function requireSuspensiones(cookies: any) {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessSuspensiones(session)) return null;
  return session;
}

async function readSuspensiones(redis: any): Promise<Suspension[]> {
  const raw = (await redis.hgetall<Record<string, string>>(REDIS_KEY)) || {};
  return Object.values(raw)
    .map((v) => {
      try {
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    })
    .filter((s): s is Suspension => s !== null)
    .map((s) => ({ timeline: [], clientPhone: '', ...s }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function addEvent(caso: Suspension, type: string, message: string, authorName: string, now: string) {
  caso.timeline.push({ id: randomUUID(), type, message, authorName, date: now });
}

function computeStats(casos: Suspension[]) {
  const total = casos.length;
  const byStatus: Record<string, number> = {};
  for (const s of STATUSES) byStatus[s] = 0;
  for (const c of casos) byStatus[c.status] = (byStatus[c.status] || 0) + 1;

  const closed = casos.filter((c) => c.status === 'Resuelto' || c.status === 'Suspendido');
  const resolvedCount = byStatus['Resuelto'] || 0;
  const suspendedCount = byStatus['Suspendido'] || 0;
  const resolutionRate = closed.length ? Math.round((resolvedCount / closed.length) * 1000) / 10 : null;

  let totalHours = 0;
  let withTime = 0;
  for (const c of closed) {
    const hours = (new Date(c.updatedAt).getTime() - new Date(c.createdAt).getTime()) / 3600000;
    if (hours >= 0) {
      totalHours += hours;
      withTime++;
    }
  }
  const avgResolutionHours = withTime ? Math.round((totalHours / withTime) * 10) / 10 : null;

  const byBranch: Record<string, number> = {};
  for (const c of casos) byBranch[c.branch] = (byBranch[c.branch] || 0) + 1;

  return {
    total,
    byStatus,
    openCount: casos.filter((c) => OPEN_STATUSES.includes(c.status)).length,
    resolvedCount,
    suspendedCount,
    resolutionRate,
    avgResolutionHours,
    byBranch,
  };
}

export const GET: APIRoute = async ({ cookies, url }) => {
  const session = await requireSuspensiones(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const branch = url.searchParams.get('branch') || '';
  const status = url.searchParams.get('status') || '';

  const all = await readSuspensiones(redis);
  const stats = computeStats(all);

  let casos = all;
  if (q) {
    casos = casos.filter((c) =>
      c.clientName.toLowerCase().includes(q) ||
      c.reason.toLowerCase().includes(q) ||
      c.branch.toLowerCase().includes(q)
    );
  }
  if (branch) casos = casos.filter((c) => c.branch === branch);
  if (status === 'abierto') casos = casos.filter((c) => OPEN_STATUSES.includes(c.status));
  else if (status) casos = casos.filter((c) => c.status === status);

  return new Response(
    JSON.stringify({ casos, branches: BRANCHES, statuses: STATUSES, stats, currentUserId: session.userId }),
    { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
  );
};

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requireSuspensiones(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: { clientName?: string; clientPhone?: string; branch?: string; reason?: string; assignToId?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const clientName = String(body.clientName || '').trim();
  const clientPhone = String(body.clientPhone || '').trim();
  const branch = String(body.branch || '').trim();
  const reason = String(body.reason || '').trim();
  const assignToId = String(body.assignToId || '').trim();

  if (!clientName || !branch || !reason || !assignToId) {
    return new Response(JSON.stringify({ error: 'faltan campos obligatorios' }), { status: 400 });
  }
  if (!BRANCHES.includes(branch)) {
    return new Response(JSON.stringify({ error: 'sucursal inválida' }), { status: 400 });
  }

  const assignee = await findUserById(redis, assignToId);
  if (!assignee || !assignee.active || (assignee.role !== 'gerente' && assignee.role !== 'secretaria')) {
    return new Response(JSON.stringify({ error: 'selecciona un gerente o secretaria válido' }), { status: 400 });
  }

  const creator = await findUserById(redis, session.userId);
  const now = new Date().toISOString();

  const caso: Suspension = {
    id: randomUUID(),
    clientName,
    clientPhone,
    branch,
    reason,
    status: 'Nuevo',
    assignedToId: assignee.id,
    assignedToName: assignee.name,
    branchAssigneeId: assignee.id,
    branchAssigneeName: assignee.name,
    timeline: [],
    createdAt: now,
    updatedAt: now,
    createdById: session.userId,
    createdByName: creator?.name || session.username,
  };
  addEvent(caso, 'created', `Caso creado por ${caso.createdByName}`, caso.createdByName, now);
  addEvent(caso, 'assigned', `Asignado a ${assignee.name}`, caso.createdByName, now);

  await redis.hset(REDIS_KEY, { [caso.id]: JSON.stringify(caso) });
  await logAudit(redis, session, 'suspension_create', `${caso.clientName} · ${caso.branch}`, `asignado a ${assignee.name}`);

  try {
    await pushNotification(redis, assignee.id, {
      type: 'suspension',
      message: `Nuevo caso de suspensión: ${caso.clientName} (${caso.branch})`,
      link: '/interno/suspensiones',
    });
  } catch {
    // no debe tumbar el guardado del caso
  }

  return new Response(JSON.stringify({ caso }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const PATCH: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requireSuspensiones(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: { id?: string; action?: string; note?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const id = String(body.id || '');
  const action = String(body.action || '');
  const note = String(body.note || '').trim();
  const raw = await redis.hget<string>(REDIS_KEY, id);
  if (!raw) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }
  const caso: Suspension = { timeline: [], clientPhone: '', ...(typeof raw === 'string' ? JSON.parse(raw) : raw) };

  const actor = await findUserById(redis, session.userId);
  const actorName = actor?.name || session.username;
  const now = new Date().toISOString();
  const isOverride = session.role === 'admin' || session.role === 'supervisor';
  const isCurrentAssignee = session.userId === caso.assignedToId;
  const isCreator = session.userId === caso.createdById;

  async function notify(userId: string, message: string) {
    try {
      await pushNotification(redis, userId, { type: 'suspension', message, link: '/interno/suspensiones' });
    } catch {
      // no debe tumbar la actualización
    }
  }

  if (action === 'addNote') {
    if (!isCurrentAssignee && !isCreator && !isOverride) {
      return new Response(JSON.stringify({ error: 'no tienes permiso sobre este caso' }), { status: 403 });
    }
    if (!note) {
      return new Response(JSON.stringify({ error: 'la nota no puede estar vacía' }), { status: 400 });
    }
    addEvent(caso, 'note', note, actorName, now);
  } else if (action === 'escalate') {
    if (!isCurrentAssignee && !isOverride) {
      return new Response(JSON.stringify({ error: 'solo quien tiene el caso asignado puede escalarlo' }), { status: 403 });
    }
    if (caso.status !== 'Nuevo' && caso.status !== 'En revisión') {
      return new Response(JSON.stringify({ error: 'este caso ya no está en revisión de sucursal' }), { status: 400 });
    }
    const josue = await findUserByUsername(redis, JOSUE_USERNAME);
    if (!josue) {
      const allUsers = await getUsers(redis);
      return new Response(JSON.stringify({
        error: 'no se encontró el usuario de Josué en el sistema',
        detail: `Buscando el username "${JOSUE_USERNAME}" entre ${allUsers.length} usuario(s): ${allUsers.map((u) => u.username).join(', ') || '(ninguno)'}`,
      }), { status: 500 });
    }
    caso.assignedToId = josue.id;
    caso.assignedToName = josue.name;
    caso.status = 'Escalado a Josué';
    addEvent(caso, 'escalated', `${actorName} escaló el caso a ${josue.name}${note ? ': ' + note : ''}`, actorName, now);
    await notify(josue.id, `Caso de suspensión escalado: ${caso.clientName} (${caso.branch})`);
  } else if (action === 'sendToTesoreria') {
    if (!isCurrentAssignee && !isOverride) {
      return new Response(JSON.stringify({ error: 'solo Josué puede pasar este caso a tesorería' }), { status: 403 });
    }
    if (caso.status !== 'Escalado a Josué') {
      return new Response(JSON.stringify({ error: 'este caso no está con Josué' }), { status: 400 });
    }
    const wilmar = await findUserByUsername(redis, WILMAR_USERNAME);
    if (!wilmar) {
      const allUsers = await getUsers(redis);
      return new Response(JSON.stringify({
        error: 'no se encontró el usuario de tesorería en el sistema',
        detail: `Buscando el username "${WILMAR_USERNAME}" entre ${allUsers.length} usuario(s): ${allUsers.map((u) => u.username).join(', ') || '(ninguno)'}`,
      }), { status: 500 });
    }
    caso.assignedToId = wilmar.id;
    caso.assignedToName = wilmar.name;
    caso.status = 'En tesorería';
    addEvent(caso, 'sent-tesoreria', `${actorName} pasó el caso a tesorería (${wilmar.name})${note ? ': ' + note : ''}`, actorName, now);
    await notify(wilmar.id, `Caso de suspensión en tesorería: ${caso.clientName} (${caso.branch})`);
  } else if (action === 'returnToBranch') {
    if (!isCurrentAssignee && !isOverride) {
      return new Response(JSON.stringify({ error: 'no tienes permiso sobre este caso' }), { status: 403 });
    }
    if (caso.status !== 'Escalado a Josué' && caso.status !== 'En tesorería') {
      return new Response(JSON.stringify({ error: 'este caso no se puede devolver desde su estado actual' }), { status: 400 });
    }
    caso.assignedToId = caso.branchAssigneeId;
    caso.assignedToName = caso.branchAssigneeName;
    caso.status = 'En revisión';
    addEvent(caso, 'returned', `${actorName} devolvió el caso a ${caso.branchAssigneeName}${note ? ': ' + note : ''}`, actorName, now);
    await notify(caso.branchAssigneeId, `Caso de suspensión devuelto: ${caso.clientName} (${caso.branch})`);
  } else if (action === 'resolve' || action === 'suspend') {
    if (!isCurrentAssignee && !isOverride) {
      return new Response(JSON.stringify({ error: 'solo quien tiene el caso asignado puede cerrarlo' }), { status: 403 });
    }
    if (!OPEN_STATUSES.includes(caso.status)) {
      return new Response(JSON.stringify({ error: 'este caso ya está cerrado' }), { status: 400 });
    }
    caso.status = action === 'resolve' ? 'Resuelto' : 'Suspendido';
    const label = action === 'resolve' ? 'Resuelto — el cliente se queda' : 'Suspendido — no se encontró solución';
    addEvent(caso, action, `${actorName} cerró el caso: ${label}${note ? '. ' + note : ''}`, actorName, now);
    if (caso.createdById !== session.userId) {
      await notify(caso.createdById, `Caso de suspensión ${action === 'resolve' ? 'resuelto' : 'cerrado sin solución'}: ${caso.clientName}`);
    }
  } else {
    return new Response(JSON.stringify({ error: 'acción inválida' }), { status: 400 });
  }

  caso.updatedAt = now;
  await redis.hset(REDIS_KEY, { [id]: JSON.stringify(caso) });
  await logAudit(redis, session, 'suspension_update', `${caso.clientName} · ${caso.branch}`, action);

  return new Response(JSON.stringify({ caso }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
