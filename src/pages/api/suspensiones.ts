import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { put } from '@vercel/blob';
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
export const STATUSES = ['Nuevo', 'En revisión', 'Escalado a Josué', 'Resuelto', 'Suspendido'];
const OPEN_STATUSES = ['Nuevo', 'En revisión', 'Escalado a Josué'];
const CLOSED_STATUSES = ['Resuelto', 'Suspendido'];
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function isJosueSession(session: { username: string }): boolean {
  return session.username.toLowerCase() === JOSUE_USERNAME.toLowerCase();
}
function isTesoreriaSession(session: { username: string }): boolean {
  return session.username.toLowerCase() === WILMAR_USERNAME.toLowerCase();
}

async function uploadRequestPhoto(photoFile: File): Promise<{ path?: string; error?: string; status?: number }> {
  if (!photoFile.type.startsWith('image/')) {
    return { error: 'la foto de la solicitud debe ser una imagen', status: 400 };
  }
  if (photoFile.size > MAX_IMAGE_BYTES) {
    return { error: 'la foto debe pesar menos de 8MB', status: 400 };
  }
  const token = import.meta.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    return { error: 'almacenamiento de imágenes no configurado', status: 503 };
  }
  try {
    const id = randomUUID();
    const blob = await put(`suspensiones/${id}`, photoFile, { access: 'private', token, addRandomSuffix: false });
    return { path: blob.pathname };
  } catch (err) {
    return { error: 'fallo al subir la foto: ' + (err instanceof Error ? err.message : String(err)), status: 500 };
  }
}

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
  plate: string;
  branch: string;
  reason: string;
  requestPhotoPath: string | null;
  status: string;
  assignedToId: string;
  assignedToName: string;
  finalized: boolean;
  finalizedAt: string | null;
  finalizedByName: string;
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
    .map((s) => ({
      timeline: [],
      clientPhone: '',
      plate: '',
      requestPhotoPath: null,
      finalized: false,
      finalizedAt: null,
      finalizedByName: '',
      ...s,
    }))
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

  const closed = casos.filter((c) => CLOSED_STATUSES.includes(c.status));
  const resolvedCount = byStatus['Resuelto'] || 0;
  const suspendedCount = byStatus['Suspendido'] || 0;
  const resolutionRate = closed.length ? Math.round((resolvedCount / closed.length) * 1000) / 10 : null;
  const pendingFinalizacion = closed.filter((c) => !c.finalized).length;
  const finalizedCount = closed.filter((c) => c.finalized).length;

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
    pendingFinalizacion,
    finalizedCount,
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
  const dateFrom = url.searchParams.get('dateFrom') || '';
  const dateTo = url.searchParams.get('dateTo') || '';

  const all = await readSuspensiones(redis);

  let casos = all;
  if (q) {
    casos = casos.filter((c) =>
      c.clientName.toLowerCase().includes(q) ||
      c.plate.toLowerCase().includes(q) ||
      c.reason.toLowerCase().includes(q) ||
      c.branch.toLowerCase().includes(q)
    );
  }
  if (branch) casos = casos.filter((c) => c.branch === branch);
  if (status === 'abierto') casos = casos.filter((c) => OPEN_STATUSES.includes(c.status));
  else if (status === 'porFinalizar') casos = casos.filter((c) => CLOSED_STATUSES.includes(c.status) && !c.finalized);
  else if (status) casos = casos.filter((c) => c.status === status);
  if (dateFrom) casos = casos.filter((c) => c.createdAt >= dateFrom);
  if (dateTo) casos = casos.filter((c) => c.createdAt <= dateTo + 'T23:59:59.999Z');

  const stats = computeStats(casos);

  const casosWithUrl = casos.map((c) => ({
    ...c,
    requestPhotoUrl: c.requestPhotoPath ? '/api/blob-file?path=' + encodeURIComponent(c.requestPhotoPath) : null,
  }));

  return new Response(
    JSON.stringify({
      casos: casosWithUrl,
      branches: BRANCHES,
      statuses: STATUSES,
      stats,
      currentUserId: session.userId,
      isTesoreria: isTesoreriaSession(session),
      isJosue: isJosueSession(session),
    }),
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

  const form = await request.formData();
  const clientName = String(form.get('clientName') || '').trim();
  const clientPhone = String(form.get('clientPhone') || '').trim();
  const plate = String(form.get('plate') || '').trim();
  const branch = String(form.get('branch') || '').trim();
  const reason = String(form.get('reason') || '').trim();
  const assignToId = String(form.get('assignToId') || '').trim();
  const photoFile = form.get('photo');

  if (!plate || !branch || !reason || !assignToId) {
    return new Response(JSON.stringify({ error: 'faltan campos obligatorios' }), { status: 400 });
  }
  if (!BRANCHES.includes(branch)) {
    return new Response(JSON.stringify({ error: 'sucursal inválida' }), { status: 400 });
  }

  const assignee = await findUserById(redis, assignToId);
  if (!assignee || !assignee.active || (assignee.role !== 'gerente' && assignee.role !== 'secretaria')) {
    return new Response(JSON.stringify({ error: 'selecciona un gerente o secretaria válido' }), { status: 400 });
  }

  let requestPhotoPath: string | null = null;
  if (photoFile instanceof File && photoFile.size > 0) {
    const uploaded = await uploadRequestPhoto(photoFile);
    if (uploaded.error) {
      return new Response(JSON.stringify({ error: uploaded.error }), { status: uploaded.status || 500 });
    }
    requestPhotoPath = uploaded.path || null;
  }

  const creator = await findUserById(redis, session.userId);
  const now = new Date().toISOString();

  const caso: Suspension = {
    id: randomUUID(),
    clientName,
    clientPhone,
    plate,
    branch,
    reason,
    requestPhotoPath,
    status: 'Nuevo',
    assignedToId: assignee.id,
    assignedToName: assignee.name,
    finalized: false,
    finalizedAt: null,
    finalizedByName: '',
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

  let body: { id?: string; action?: string; note?: string; targetUserId?: string; clientName?: string };
  let photoFile: File | null = null;
  const contentType = request.headers.get('content-type') || '';
  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    body = {
      id: String(form.get('id') || ''),
      action: String(form.get('action') || ''),
      note: String(form.get('note') || ''),
      clientName: String(form.get('clientName') || ''),
    };
    const maybePhoto = form.get('photo');
    if (maybePhoto instanceof File && maybePhoto.size > 0) photoFile = maybePhoto;
  } else {
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
    }
  }

  const id = String(body.id || '');
  const action = String(body.action || '');
  const note = String(body.note || '').trim();
  const raw = await redis.hget<string>(REDIS_KEY, id);
  if (!raw) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }
  const caso: Suspension = {
    timeline: [],
    clientPhone: '',
    plate: '',
    requestPhotoPath: null,
    finalized: false,
    finalizedAt: null,
    finalizedByName: '',
    ...(typeof raw === 'string' ? JSON.parse(raw) : raw),
  };

  const actor = await findUserById(redis, session.userId);
  const actorName = actor?.name || session.username;
  const now = new Date().toISOString();
  const isOverride = session.role === 'admin' || session.role === 'supervisor';
  const isCurrentAssignee = session.userId === caso.assignedToId;
  const isCreator = session.userId === caso.createdById;
  const isJosue = isJosueSession(session);
  const isTesoreria = isTesoreriaSession(session);

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
  } else if (action === 'updateInfo') {
    if (!isCurrentAssignee && !isOverride) {
      return new Response(JSON.stringify({ error: 'solo quien tiene el caso asignado puede completar esta información' }), { status: 403 });
    }
    if (caso.finalized) {
      return new Response(JSON.stringify({ error: 'este caso ya fue finalizado' }), { status: 400 });
    }
    const newClientName = String(body.clientName || '').trim();
    if (photoFile) {
      const uploaded = await uploadRequestPhoto(photoFile);
      if (uploaded.error) {
        return new Response(JSON.stringify({ error: uploaded.error }), { status: uploaded.status || 500 });
      }
      caso.requestPhotoPath = uploaded.path || caso.requestPhotoPath;
    }
    if (newClientName) caso.clientName = newClientName;
    addEvent(caso, 'info-updated', `${actorName} completó la información del caso`, actorName, now);
  } else if (action === 'escalate') {
    if (!isCurrentAssignee && !isOverride && !isJosue) {
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
  } else if (action === 'reassign') {
    if (!isJosue && !isOverride) {
      return new Response(JSON.stringify({ error: 'solo Josué puede hacer una asignación especial de este caso' }), { status: 403 });
    }
    if (!OPEN_STATUSES.includes(caso.status)) {
      return new Response(JSON.stringify({ error: 'este caso ya está cerrado' }), { status: 400 });
    }
    const targetUserId = String(body.targetUserId || '').trim();
    if (!targetUserId) {
      return new Response(JSON.stringify({ error: 'selecciona a quién se le asigna el caso' }), { status: 400 });
    }
    const target = await findUserById(redis, targetUserId);
    if (!target || !target.active) {
      return new Response(JSON.stringify({ error: 'selecciona un usuario activo válido' }), { status: 400 });
    }
    caso.assignedToId = target.id;
    caso.assignedToName = target.name;
    if (caso.status === 'Escalado a Josué') caso.status = 'En revisión';
    addEvent(caso, 'reassigned', `${actorName} asignó el caso a ${target.name}${note ? ': ' + note : ''}`, actorName, now);
    await notify(target.id, `Caso de suspensión asignado: ${caso.clientName} (${caso.branch})`);
  } else if (action === 'resolve' || action === 'suspend') {
    if (!OPEN_STATUSES.includes(caso.status)) {
      return new Response(JSON.stringify({ error: 'este caso ya está cerrado' }), { status: 400 });
    }
    if (!isCurrentAssignee && !isOverride) {
      return new Response(JSON.stringify({ error: 'solo quien tiene el caso asignado puede cerrarlo' }), { status: 403 });
    }
    caso.status = action === 'resolve' ? 'Resuelto' : 'Suspendido';
    const label = action === 'resolve' ? 'Resuelto — el cliente se queda' : 'Suspendido — no se encontró solución';
    addEvent(caso, action, `${actorName} marcó el caso: ${label}${note ? '. ' + note : ''}`, actorName, now);
    if (caso.createdById !== session.userId) {
      await notify(caso.createdById, `Caso de suspensión ${action === 'resolve' ? 'resuelto' : 'cerrado sin solución'}: ${caso.clientName}`);
    }
    try {
      const wilmar = await findUserByUsername(redis, WILMAR_USERNAME);
      if (wilmar) await notify(wilmar.id, `Caso pendiente de finalizar en tesorería: ${caso.clientName} (${caso.branch})`);
    } catch {
      // no debe tumbar la actualización si no se encuentra a tesorería
    }
  } else if (action === 'finalize') {
    if (!isTesoreria && !isOverride) {
      return new Response(JSON.stringify({ error: 'solo tesorería puede finalizar el caso' }), { status: 403 });
    }
    if (!CLOSED_STATUSES.includes(caso.status)) {
      return new Response(JSON.stringify({ error: 'el caso debe estar resuelto o suspendido antes de finalizarlo' }), { status: 400 });
    }
    if (caso.finalized) {
      return new Response(JSON.stringify({ error: 'este caso ya fue finalizado' }), { status: 400 });
    }
    caso.finalized = true;
    caso.finalizedAt = now;
    caso.finalizedByName = actorName;
    addEvent(caso, 'finalized', `${actorName} marcó el caso como finalizado${note ? ': ' + note : ''}`, actorName, now);
    if (caso.createdById !== session.userId) {
      await notify(caso.createdById, `Caso de suspensión finalizado por tesorería: ${caso.clientName}`);
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
